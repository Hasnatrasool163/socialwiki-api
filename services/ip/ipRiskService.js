/**
 * ipRiskService.js
 *
 * Shared IP-Risk & Threat Intelligence Service
 * - Enforces CF-Connecting-IP & trust proxy
 * - Normalizes IPv6 addresses by /64 prefix to prevent rotation abuse
 * - 30-day verdict cache in MongoDB (UserIP in web_postalwiki_auth)
 * - Safe failure handling: Outages are marked UNKNOWN (5-min retry), never permanently whitelisted
 * - Evaluates risk policies:
 *    * Auth (Signup/Login): Strict block for VPN/Proxy/Tor/Abuser
 *    * Logged-in Search: Paid accounts bypass (logged only); Free accounts blocked or challenged
 */

const axios = require('axios');
const UserIP = require('../../models/UserIP');
const logger = require('../../config/logger');

const IP_API_KEY = process.env.IP_API_KEY || process.env.IPAPI_KEY || process.env.IP_KEY || '';
const CACHE_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const OUTAGE_RETRY_MS = 5 * 60 * 1000;              // 5 minutes

// In-memory short-lived cache for recent lookups and failed API calls
const memoryIpCache = new Map();

/**
 * Normalizes an IP address. Subnets IPv6 to /64.
 */
function normalizeIp(ipStr) {
    if (!ipStr || typeof ipStr !== 'string') return { ip: '127.0.0.1', version: 4, subnet: '127.0.0.1' };
    const clean = ipStr.trim().replace(/^::ffff:/, ''); // Strip IPv4-mapped IPv6 prefix

    if (clean.includes(':')) {
        // IPv6 address: Extract the first 4 hex blocks (/64 prefix)
        const parts = clean.split(':');
        const subnet = parts.slice(0, 4).join(':') + '::/64';
        return { ip: clean, version: 6, subnet };
    }

    return { ip: clean, version: 4, subnet: clean };
}

/**
 * Extracts the real visitor IP safely behind Cloudflare
 */
function getRealVisitorIp(req) {
    const cfIp = req.headers['cf-connecting-ip'];
    const xff = req.headers['x-forwarded-for'];
    const candidate = cfIp || (xff ? xff.split(',')[0].trim() : req.socket.remoteAddress);
    return normalizeIp(candidate);
}

/**
 * Calls ipapi.is with timeout
 */
async function fetchIpIntelligence(ip) {
    if (!IP_API_KEY) {
        logger.debug('[ipRiskService] No IP_API_KEY configured; skipping external intelligence check');
        return null;
    }

    try {
        const url = `https://api.ipapi.is/?q=${encodeURIComponent(ip)}&key=${IP_API_KEY}`;
        const response = await axios.get(url, { timeout: 2500 });
        return response.data;
    } catch (err) {
        logger.warn(`[ipRiskService] External API lookup failed for ${ip}: ${err.message}`);
        return null; // Return null so outage is treated as UNKNOWN
    }
}

/**
 * Validates and retrieves the risk profile for an IP
 */
async function checkIpRisk(rawIp) {
    const { ip, version, subnet } = normalizeIp(rawIp);

    // 1. Check in-memory short cache
    const memHit = memoryIpCache.get(ip);
    const now = Date.now();
    if (memHit && (now - memHit.cachedAt < memHit.ttlMs)) {
        return memHit.verdict;
    }

    // 2. Check MongoDB UserIP collection in auth DB
    let record = null;
    try {
        record = await UserIP.findOne({ ipAddress: ip });
    } catch (dbErr) {
        logger.error(`[ipRiskService] MongoDB read failed: ${dbErr.message}`);
    }

    // Check 30-day freshness
    const isFresh = record && record.checkedAt && (now - new Date(record.checkedAt).getTime() < CACHE_FRESHNESS_MS);

    if (record && (isFresh || record.isManualOverride)) {
        const verdict = {
            ip,
            status: record.status,
            isVpn: !!record.isVpn,
            isProxy: !!record.isProxy,
            isTor: !!record.isTor,
            isAbuser: !!record.isAbuser,
            isDatacenter: !!record.isDatacenter,
            reasons: record.reasons || []
        };
        memoryIpCache.set(ip, { verdict, cachedAt: now, ttlMs: 60 * 60 * 1000 });
        return verdict;
    }

    // 3. Query external API if needed
    const apiData = await fetchIpIntelligence(ip);

    if (!apiData) {
        // API failed or no key: DO NOT whitelist permanently!
        const unknownVerdict = {
            ip,
            status: 'UNKNOWN',
            isVpn: false,
            isProxy: false,
            isTor: false,
            isAbuser: false,
            isDatacenter: false,
            reasons: ['Lookup failed / unavailable']
        };
        // Cache temporarily for 5 minutes
        memoryIpCache.set(ip, { verdict: unknownVerdict, cachedAt: now, ttlMs: OUTAGE_RETRY_MS });
        return unknownVerdict;
    }

    // Evaluate risk flags from response
    const isVpn = !!apiData.is_vpn;
    const isProxy = !!apiData.is_proxy;
    const isTor = !!apiData.is_tor;
    const isAbuser = !!apiData.is_abuser;
    const isDatacenter = !!apiData.is_datacenter;

    const isSuspicious = isVpn || isProxy || isTor || isAbuser || isDatacenter;
    const reasons = [];
    if (isTor) reasons.push('Tor');
    if (isProxy) reasons.push('Proxy');
    if (isVpn) reasons.push('VPN');
    if (isAbuser) reasons.push('Abuser');
    if (isDatacenter) reasons.push('Datacenter');

    const status = isSuspicious ? 'BLACKLIST' : 'WHITELIST';

    // 4. Save verdict in MongoDB with 30-day freshness
    try {
        await UserIP.findOneAndUpdate(
            { ipAddress: ip },
            {
                $set: {
                    ipVersion: version,
                    normalizedSubnet: subnet,
                    status,
                    reasons,
                    isVpn,
                    isProxy,
                    isTor,
                    isAbuser,
                    isDatacenter,
                    checkedAt: new Date(),
                    rawDetails: {
                        asn: apiData.asn?.asn,
                        org: apiData.asn?.org,
                        country: apiData.location?.country
                    }
                }
            },
            { upsert: true, new: true }
        );
    } catch (saveErr) {
        logger.error(`[ipRiskService] Failed to persist UserIP: ${saveErr.message}`);
    }

    const verdict = { ip, status, isVpn, isProxy, isTor, isAbuser, isDatacenter, reasons };
    memoryIpCache.set(ip, { verdict, cachedAt: now, ttlMs: 60 * 60 * 1000 });
    return verdict;
}

/**
 * Evaluates IP risk for Auth actions (Signup, Login, Request Access)
 * Enforces strict block against Tor, Proxy, VPN, Abusers
 */
async function evaluateAuthRisk(rawIp) {
    const verdict = await checkIpRisk(rawIp);
    if (verdict.status === 'BLACKLIST') {
        return {
            allow: false,
            reason: `Access blocked: Suspicious network connection detected (${verdict.reasons.join(', ')}). Please disable VPN or proxy to continue.`,
            verdict
        };
    }
    return { allow: true, verdict };
}

/**
 * Evaluates IP risk for Logged-In Searches
 * Policy:
 *  - Paid / Level 1 / Level 2 / Admin: ALLOW (never lock out paying customers on corporate VPNs; log only)
 *  - Free / Trial: Enforce VPN / Proxy block if configured
 */
async function evaluateSearchRisk(user, rawIp) {
    const verdict = await checkIpRisk(rawIp);
    const plan = user?.plan || 'free';
    const isPaidOrAdmin = user?.role === 'admin' || ['level1', 'level2', 'level2_high', 'paid'].includes(plan);

    if (isPaidOrAdmin) {
        // Paid accounts stay allowed, signal logged to search_events
        return {
            allow: true,
            loggedRiskSignal: verdict.status === 'BLACKLIST' ? verdict.reasons : null,
            verdict
        };
    }

    // Free / Trial accounts
    if (verdict.status === 'BLACKLIST') {
        const blockFreeVpn = process.env.BLOCK_FREE_TIER_VPN !== 'false'; // Default true
        if (blockFreeVpn) {
            return {
                allow: false,
                reason: `Free search access is restricted while connected to a VPN or proxy (${verdict.reasons.join(', ')}). Please disconnect your VPN or upgrade to a paid plan.`,
                verdict
            };
        }
    }

    return { allow: true, verdict };
}

module.exports = {
    normalizeIp,
    getRealVisitorIp,
    checkIpRisk,
    evaluateAuthRisk,
    evaluateSearchRisk
};
