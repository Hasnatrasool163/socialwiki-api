/**
 * usageController.js
 * Returns remaining and used search quota for the authenticated user.
 */

const User = require('../../models/User');

const getUsage = async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('plan searchCount searchResetDate').lean();
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        const FREE_DAILY_LIMIT = parseInt(process.env.FREE_DAILY_LIMIT || '50', 10);
        const limit = user.plan === 'paid' || user.plan === 'admin' ? null : FREE_DAILY_LIMIT;

        const midnight = new Date();
        midnight.setUTCHours(24, 0, 0, 0);

        return res.json({
            success: true,
            plan: user.plan,
            used: user.searchCount || 0,
            limit,
            remaining: limit === null ? null : Math.max(0, limit - (user.searchCount || 0)),
            resetAt: midnight.toISOString(),
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
};

module.exports = {
    getUsage,
};
