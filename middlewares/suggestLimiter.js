/**
 * suggestLimiter.js
 *
 * Anti-scraping rate limiter for address suggestions.
 * Caps:
 *  - 30 requests per 10 seconds
 *  - 600 requests per 1 hour
 */

const { suggest10sLimiter, suggestHourLimiter } = require('../services/limiter/rateLimiterService');

const suggestLimiter = async (req, res, next) => {
    // Admin bypasses suggest limits
    if (req.user?.role === 'admin') return next();

    const key = String(req.user?.id || req.realIp || req.ip);

    try {
        const [res10s, resHour] = await Promise.all([
            suggest10sLimiter.consume(key, 1),
            suggestHourLimiter.consume(key, 1)
        ]);

        const remaining = Math.min(res10s.remainingPoints, resHour.remainingPoints);
        res.setHeader('X-Suggest-Limit-Remaining', remaining);
        next();
    } catch (rlRejected) {
        const retryAfter = Math.ceil((rlRejected.msBeforeNext || 10000) / 1000);
        res.setHeader('Retry-After', String(retryAfter));
        return res.status(429).json({
            success: false,
            message: `Autocomplete rate limit exceeded. Please wait ${retryAfter} seconds.`,
            retryAfter
        });
    }
};

module.exports = suggestLimiter;
