/**
 * botProtect.js
 *
 * Per-user sliding-window rate limiter — stops rapid scraping.
 * Default: 10 requests per 60 seconds per authenticated user.
 *
 * Uses an in-memory Map (fine for single PM2 process).
 * If you scale to multiple processes, replace with a Redis-backed store.
 *
 * Must run AFTER verifyToken (req.user.id must exist).
 */

const WINDOW_MS  = parseInt(process.env.BOT_WINDOW_MS  || String(60 * 1000), 10); // 60 s
const MAX_HITS   = parseInt(process.env.BOT_MAX_HITS   || '10', 10);              // 10 req
const ADMIN_ROLE = 'admin';

// Map<userId, number[]>  — timestamps of requests within the window
const windows = new Map();

// Clean up stale entries every 5 minutes to prevent memory growth
setInterval(() => {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [uid, hits] of windows.entries()) {
        const fresh = hits.filter(t => t > cutoff);
        if (fresh.length === 0) windows.delete(uid);
        else windows.set(uid, fresh);
    }
}, 5 * 60 * 1000);

const botProtect = (req, res, next) => {
    // Admin always passes
    if (req.user?.role === ADMIN_ROLE) return next();

    const uid  = String(req.user?.id || req.ip);
    const now  = Date.now();
    const cutoff = now - WINDOW_MS;

    const hits = (windows.get(uid) || []).filter(t => t > cutoff);
    hits.push(now);
    windows.set(uid, hits);

    if (hits.length > MAX_HITS) {
        const retryAfter = Math.ceil(WINDOW_MS / 1000);
        console.warn(`[botProtect] rate-limited uid=${uid} hits=${hits.length}`);
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({
            success:     false,
            message:    `Too many requests. Max ${MAX_HITS} searches per ${retryAfter}s.`,
            retryAfter,
        });
    }

    next();
};

module.exports = botProtect;
