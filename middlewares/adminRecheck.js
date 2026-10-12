const User = require('../models/User');
const { getRedisClient, isRedisReady } = require('../config/redis');

// In-memory fallback cache if Redis is unavailable
const memoryAdminCache = new Map();

/**
 * Re-checks in the database (cached for 60 seconds) that the acting admin
 * is still an admin and not blocked.
 */
const adminRecheck = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const cacheKey = `admin_active:${userId}`;
        const redis = getRedisClient();

        // 1. Check Redis cache
        if (isRedisReady() && redis) {
            try {
                const cached = await redis.get(cacheKey);
                if (cached === '1') {
                    return next();
                }
                if (cached === '0') {
                    return res.status(403).json({ success: false, message: 'Access denied: admin privileges revoked or account blocked.' });
                }
            } catch (_) {}
        } else {
            // Check memory cache fallback
            const mem = memoryAdminCache.get(cacheKey);
            if (mem && (Date.now() - mem.ts < 60000)) {
                if (mem.valid) return next();
                return res.status(403).json({ success: false, message: 'Access denied: admin privileges revoked or account blocked.' });
            }
        }

        // 2. Query auth database
        const adminUser = await User.findById(userId).select('role isBlocked');
        if (!adminUser || adminUser.role !== 'admin' || adminUser.isBlocked) {
            if (isRedisReady() && redis) {
                try { await redis.set(cacheKey, '0', 'EX', 60); } catch (_) {}
            }
            memoryAdminCache.set(cacheKey, { valid: false, ts: Date.now() });
            return res.status(403).json({ success: false, message: 'Access denied: admin privileges revoked or account blocked.' });
        }

        // 3. Cache valid status for 60 seconds
        if (isRedisReady() && redis) {
            try { await redis.set(cacheKey, '1', 'EX', 60); } catch (_) {}
        }
        memoryAdminCache.set(cacheKey, { valid: true, ts: Date.now() });

        next();
    } catch (err) {
        console.error('[adminRecheck] error:', err.message);
        return res.status(500).json({ success: false, message: 'Internal authorization error' });
    }
};

module.exports = adminRecheck;
