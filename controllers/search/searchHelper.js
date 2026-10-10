/**
 * searchHelper.js
 * Shared utility functions, cursor encryption/HMAC signing,
 * normalization routines, and natural sorting for search controllers.
 */

const crypto = require('crypto');

const SEARCH_LIMIT = 50;
const MAX_TIME_MS = 10000; // 10s timeout guard

const CURSOR_SECRET = process.env.CURSOR_SECRET || process.env.JWT_SECRET || 'postalwiki_secure_cursor_secret';

function naturalCompare(a, b) {
    return String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' });
}

function normalizeSearchPostcode(value) {
    if (!value) return '';
    let clean = value.toString().trim().toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ');
    if (!clean) return '';
    const continuousText = clean.replace(/\s/g, '');
    const fullPostcodeNoSpaceRegex = /^([A-Z]{1,2}[0-9][A-Z0-9]?)([0-9][A-Z]{2})$/;
    if (fullPostcodeNoSpaceRegex.test(continuousText)) {
        return continuousText.replace(fullPostcodeNoSpaceRegex, '$1 $2');
    }
    return clean;
}

function signCursor(payloadStr) {
    return crypto.createHmac('sha256', CURSOR_SECRET).update(payloadStr).digest('hex').substring(0, 16);
}

function encodeCursorToken(payload) {
    const raw = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
    const sig = signCursor(raw);
    const wrapper = JSON.stringify({ d: payload, s: sig });
    return Buffer.from(wrapper, 'utf8').toString('base64url');
}

function decodeCursorToken(cursor) {
    if (!cursor) return null;
    try {
        const decodedStr = Buffer.from(String(cursor), 'base64url').toString('utf8');
        const parsed = JSON.parse(decodedStr);
        if (parsed && parsed.d && parsed.s) {
            const raw = typeof parsed.d === 'object' ? JSON.stringify(parsed.d) : String(parsed.d);
            const expectedSig = signCursor(raw);
            if (crypto.timingSafeEqual(Buffer.from(parsed.s), Buffer.from(expectedSig))) {
                return parsed.d;
            }
            return null; // signature mismatch
        }
        // Backward-compatibility: if client sent legacy unsigned base64 token
        const legacy = JSON.parse(Buffer.from(String(cursor), 'base64').toString('utf8'));
        if (legacy && typeof legacy === 'object') return legacy;
        return null;
    } catch {
        // If it was a raw ObjectId string from old cursor pagination
        if (typeof cursor === 'string' && /^[0-9a-fA-F]{24}$/.test(cursor)) {
            return cursor;
        }
        return null;
    }
}

function usageBlock(req) {
    return req.searchUsage || null;
}

const norm = s => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’'`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nextPrefix = p => p.slice(0, -1) + String.fromCharCode(p.charCodeAt(p.length - 1) + 1);
const isPostcode = q => /^[a-z]{1,2}\d[a-z\d]?( ?\d[a-z]{0,2})?$/.test(q);

const UNIT = 'flat|unit|room|apartment|apt|suite';
const UNIT_ID = '(\\d+[a-z]?|[a-z]\\d*)'; // matches 2, 7r, a, e16

function parseQuery(q) {
    let rest = q, unit = null, num = null, m;
    if ((m = rest.match(new RegExp(`^(?:${UNIT})\\s+${UNIT_ID}\\s+(.+)$`)))) { 
        unit = m[1]; rest = m[2]; 
    }
    if ((m = rest.match(/^(\d+[a-z]?)(?:\s+\d+[a-z]?)?\s+(.+)$/))) { 
        num = m[1]; rest = m[2]; 
    }
    return { unit, num, rest }; 
}

module.exports = {
    SEARCH_LIMIT,
    MAX_TIME_MS,
    naturalCompare,
    normalizeSearchPostcode,
    encodeCursorToken,
    decodeCursorToken,
    usageBlock,
    norm,
    esc,
    nextPrefix,
    isPostcode,
    UNIT,
    UNIT_ID,
    parseQuery,
};
