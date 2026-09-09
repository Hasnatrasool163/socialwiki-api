/**
 * searchRateLimit.js
 *
 * Per-user daily search cap middleware.
 * - Free  plan : FREE_DAILY_LIMIT searches/day  (default 50)
 * - Paid  plan : PAID_DAILY_LIMIT  searches/day  (default unlimited = 0 means skip)
 * - Admin role : always passes through
 *
 * Resets at midnight UTC.
 * Must run AFTER verifyToken (req.user must be set).
 */

const User = require('../models/User');

const FREE_DAILY_LIMIT  = parseInt(process.env.FREE_DAILY_LIMIT  || '50',  10);
const PAID_DAILY_LIMIT  = parseInt(process.env.PAID_DAILY_LIMIT  || '0',   10); // 0 = unlimited
const ADMIN_ROLE        = 'admin';

function isSameUTCDay(dateA, dateB) {
    return (
        dateA.getUTCFullYear() === dateB.getUTCFullYear() &&
        dateA.getUTCMonth()    === dateB.getUTCMonth()    &&
        dateA.getUTCDate()     === dateB.getUTCDate()
    );
}

function midnightUTC() {
    const d = new Date();
    d.setUTCHours(24, 0, 0, 0);
    return d;
}

const searchRateLimit = async (req, res, next) => {
    try {
        // Admin role bypasses all limits
        if (req.user?.role === ADMIN_ROLE) return next();

        const user = await User.findById(req.user.id);
        if (!user) return res.status(401).json({ message: 'User not found' });

        // Pending accounts are blocked until manually approved
        if (user.plan === 'pending') {
            return res.status(403).json({
                success:  false,
                pending:  true,
                message:  'Your account is pending approval. We will be in touch soon.',
            });
        }

        const now = new Date();

        // Reset counter if last reset was on a previous UTC day
        const lastReset = user.searchResetDate || now;
        if (!isSameUTCDay(lastReset, now)) {
            user.searchCount     = 0;
            user.searchResetDate = now;
        }

        // Determine limit for this plan
        const limit =
            user.plan === 'paid'  ? PAID_DAILY_LIMIT  :
            user.plan === 'admin' ? 0                  :
            FREE_DAILY_LIMIT;

        const unlimited = limit === 0;

        if (!unlimited && user.searchCount >= limit) {
            return res.status(429).json({
                success:  false,
                message:  `Daily search limit reached (${limit}/day). Upgrade for unlimited access.`,
                plan:     user.plan,
                limit,
                used:     user.searchCount,
                remaining: 0,
                resetAt:  midnightUTC().toISOString(),
            });
        }

        // Increment and save
        user.searchCount += 1;
        await user.save();

        // Attach usage info to request so the controller can forward it
        req.searchUsage = {
            plan:      user.plan,
            limit:     unlimited ? null : limit,
            used:      user.searchCount,
            remaining: unlimited ? null : Math.max(0, limit - user.searchCount),
            resetAt:   midnightUTC().toISOString(),
        };

        next();
    } catch (err) {
        console.error('[searchRateLimit] error:', err.message);
        next(); // fail open — don't block searches on internal error
    }
};

module.exports = searchRateLimit;
