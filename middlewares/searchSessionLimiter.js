/**
 * searchSessionLimiter.js
 *
 * Phase 1 Search Quota & Session-Aware Limiter
 * - Employs rate-limiter-flexible with Redis + Memory Insurance Limiter
 * - Implements 30s prefix-match session deduplication (sameSession)
 * - Enforces Level 1, Level 2, Level 2 High, and Free/Trial rules
 * - Asynchronously logs SearchEvent and UsageDaily without blocking DB
 */

const User = require('../models/User');
const {
    freeBasicDailyLimiter,
    freeAdvancedDailyLimiter,
    level1DailyLimiter,
    level1WeeklyLimiter,
    level2DailyLimiter,
    level2MonthlyLimiter,
    level2HighDailyLimiter,
    level2HighMonthlyLimiter,
    paidDailyLimiter,
    evaluateSession,
    isKillSwitchActive,
    logSearchAsync
} = require('../services/limiter/rateLimiterService');
const { getRealVisitorIp, evaluateSearchRisk } = require('../services/ip/ipRiskService');

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const EIGHT_WEEKS_MS = 8 * ONE_WEEK_MS;

const getDatasetFromPath = (path) => {
    if (path.includes('/rm-address')) return 'rm';
    if (path.includes('/prop-price')) return 'prop';
    if (path.includes('/company')) return 'company';
    if (path.includes('/screenshot')) return 'screenshot';
    if (path.includes('/social')) return 'social';
    if (path.includes('/business')) return 'business';
    if (path.includes('/website')) return 'website';
    return 'other';
};

const searchSessionLimiter = async (req, res, next) => {
    try {
        // 1. Admin bypasses all quotas
        if (req.user?.role === 'admin') return next();

        const user = await User.findById(req.user.id);
        if (!user) return res.status(401).json({ success: false, message: 'User not found' });

        // 2. Pending account check
        if (user.plan === 'pending') {
            return res.status(403).json({
                success: false,
                pending: true,
                message: 'Your account is pending approval. We will be in touch soon.'
            });
        }

        const dataset = getDatasetFromPath(req.baseUrl + req.path);

        // 3. Kill switch check
        if (await isKillSwitchActive(dataset)) {
            return res.status(503).json({
                success: false,
                message: 'This search dataset is temporarily unavailable due to scheduled maintenance. Please try again shortly.'
            });
        }

        const now = Date.now();
        const trialStart = new Date(user.trialStartedAt || user.createdAt || now).getTime();
        const plan = user.plan || 'free';
        const isBasicDataset = dataset === 'rm';

        // 4. Tier entitlement checks
        if (plan === 'free' || plan === 'trial') {
            // Free basic (RM addresses) valid for 8 weeks
            if (isBasicDataset && (now - trialStart > EIGHT_WEEKS_MS)) {
                return res.status(403).json({
                    success: false,
                    reactivationRequired: true,
                    message: 'Your 8-week free trial has concluded. Please reactivate your account to continue basic searches.'
                });
            }

            // Free advanced (multi-DB) valid for 1 week
            if (!isBasicDataset && (now - trialStart > ONE_WEEK_MS)) {
                return res.status(403).json({
                    success: false,
                    upgradeRequired: true,
                    message: 'Your 1-week preview for advanced multi-database searches has ended. Please upgrade to Level 2 to search companies, social footprints, and businesses.'
                });
            }
        } else if (plan === 'level1') {
            // Level 1: Royal Mail address lookups only
            if (!isBasicDataset) {
                return res.status(403).json({
                    success: false,
                    upgradeRequired: true,
                    message: 'Level 1 plans cover Royal Mail address lookup only. Please upgrade to Level 2 for multi-database search access.'
                });
            }
        }

        // 5. IP Risk & Threat Intelligence check
        const visitorIp = getRealVisitorIp(req);
        const riskEval = await evaluateSearchRisk(user, visitorIp.ip);
        if (!riskEval.allow) {
            return res.status(403).json({
                success: false,
                vpnBlocked: true,
                message: riskEval.reason
            });
        }
        req.ipRisk = riskEval.verdict;

        // 6. Lookup session evaluation (sameSession prefix match within 30s)
        const rawQuery = (req.query.q || req.query.term || req.query.postcode || req.query.query || '').trim();
        const { isNewSession, sessionId } = await evaluateSession(user._id.toString(), rawQuery);

        req.searchSessionId = sessionId;

        let remainingSearches = null;
        let resetSeconds = null;

        // 6. Quota consumption (only if this query starts a new session)
        if (isNewSession) {
            const userKey = user._id.toString();

            try {
                if (plan === 'free' || plan === 'trial') {
                    if (isBasicDataset) {
                        const r = await freeBasicDailyLimiter.consume(userKey, 1);
                        remainingSearches = r.remainingPoints;
                        resetSeconds = Math.ceil(r.msBeforeNext / 1000);
                    } else {
                        const r = await freeAdvancedDailyLimiter.consume(userKey, 1);
                        remainingSearches = r.remainingPoints;
                        resetSeconds = Math.ceil(r.msBeforeNext / 1000);
                    }
                } else if (plan === 'level1') {
                    const [rDay, rWeek] = await Promise.all([
                        level1DailyLimiter.consume(userKey, 1),
                        level1WeeklyLimiter.consume(userKey, 1)
                    ]);
                    remainingSearches = Math.min(rDay.remainingPoints, rWeek.remainingPoints);
                    resetSeconds = Math.ceil(rDay.msBeforeNext / 1000);
                } else if (plan === 'level2') {
                    const [rDay, rMonth] = await Promise.all([
                        level2DailyLimiter.consume(userKey, 1),
                        level2MonthlyLimiter.consume(userKey, 1)
                    ]);
                    remainingSearches = Math.min(rDay.remainingPoints, rMonth.remainingPoints);
                    resetSeconds = Math.ceil(rDay.msBeforeNext / 1000);
                } else if (plan === 'level2_high') {
                    const [rDay, rMonth] = await Promise.all([
                        level2HighDailyLimiter.consume(userKey, 1),
                        level2HighMonthlyLimiter.consume(userKey, 1)
                    ]);
                    remainingSearches = Math.min(rDay.remainingPoints, rMonth.remainingPoints);
                    resetSeconds = Math.ceil(rDay.msBeforeNext / 1000);
                } else if (plan === 'paid') {
                    const r = await paidDailyLimiter.consume(userKey, 1);
                    remainingSearches = r.remainingPoints;
                    resetSeconds = Math.ceil(r.msBeforeNext / 1000);
                }
            } catch (rlRejected) {
                const retryAfter = Math.ceil((rlRejected.msBeforeNext || 86400000) / 1000);
                res.setHeader('Retry-After', String(retryAfter));
                return res.status(429).json({
                    success: false,
                    message: `Search quota limit reached for your plan (${plan}). Quota resets in ${Math.round(retryAfter / 60)} minutes.`,
                    plan,
                    retryAfter
                });
            }
        }

        // 7. Attach headers & searchUsage metadata
        if (remainingSearches !== null) {
            res.setHeader('X-Search-Remaining', String(remainingSearches));
            if (resetSeconds) res.setHeader('X-Search-Reset', String(resetSeconds));
        }
        res.setHeader('X-Search-Session-Id', sessionId);

        req.searchUsage = {
            plan,
            sessionDeduplicated: !isNewSession,
            sessionId,
            remaining: remainingSearches
        };

        // 8. Hook into response finish for async SearchEvent & UsageDaily logging
        const originalJson = res.json.bind(res);
        res.json = function (body) {
            try {
                const results = body?.data || (Array.isArray(body) ? body : []);
                const count = Array.isArray(results) ? results.length : (body?.count || (body?.success ? 1 : 0));
                const found = count > 0;

                const postcodes = [];
                if (Array.isArray(results)) {
                    for (const item of results) {
                        if (item.postcode) postcodes.push(item.postcode);
                    }
                }

                logSearchAsync({
                    userId: user._id,
                    query: rawQuery,
                    queryType: req.query.postcode ? 'postcode' : (req.query.address ? 'address' : (dataset === 'business' ? 'business' : 'other')),
                    datasetsSearched: [dataset],
                    resultCountPerDataset: { [dataset]: count },
                    totalResults: count,
                    found,
                    sessionId,
                    ip: visitorIp.ip,
                    ipRisk: req.ipRisk,
                    userAgent: req.headers['user-agent'],
                    plan,
                    postcodes
                });
            } catch (_) {}

            return originalJson(body);
        };

        next();
    } catch (err) {
        console.error('[searchSessionLimiter] error:', err.message);
        // Fail closed on insurance error if security requires, or proceed with safety
        next();
    }
};

module.exports = searchSessionLimiter;
