const mongoose = require('mongoose');
const crypto = require('crypto');
const User = require('../models/User');
const UsageDaily = require('../models/UsageDaily');
const SearchEvent = require('../models/SearchEvent');
const NotFoundQueue = require('../models/NotFoundQueue');
const { logAdminAction } = require('../services/audit/auditService');
const { TIER_CONSTANTS, LEVEL_PLAN_MAPPING } = require('../services/limiter/tierConstants');
const { hashPassword, generateSecureToken } = require('../utils/cryptoUtils');
const { getRedisClient, isRedisReady } = require('../config/redis');
const {
    toUserSummaryDTO,
    toUserDetailDTO,
    toSearchEventDTO,
    toUsageDailyDTO,
    toNotFoundDTO
} = require('../utils/adminDto');

function sanitizeText(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
        .slice(0, 500);
}

/**
 * 1. GET /api/admin/users
 * Paged list with prefix email search, status filters, last-active date, and searches-this-month.
 */
exports.listUsers = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page || '1', 10));
        const limitParam = parseInt(req.query.limit || '25', 10);
        const limit = Math.min(100, Math.max(1, isNaN(limitParam) ? 25 : limitParam));
        const skip = (page - 1) * limit;

        const filter = {};

        if (req.query.search && req.query.search.trim()) {
            const cleanSearch = req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            filter.$or = [
                { email: new RegExp(`^${cleanSearch}`, 'i') },
                { username: new RegExp(`^${cleanSearch}`, 'i') }
            ];
        }

        if (req.query.level && req.query.level !== 'all') {
            filter.level = req.query.level;
        }

        if (req.query.plan && req.query.plan !== 'all') {
            filter.plan = req.query.plan;
        }

        if (req.query.isApproved !== undefined && req.query.isApproved !== 'all') {
            filter.isApproved = req.query.isApproved === 'true';
        }

        if (req.query.isVerified !== undefined && req.query.isVerified !== 'all') {
            filter.isVerified = req.query.isVerified === 'true';
        }

        if (req.query.isBlocked !== undefined && req.query.isBlocked !== 'all') {
            filter.isBlocked = req.query.isBlocked === 'true';
        }

        if (req.query.role && req.query.role !== 'all') {
            filter.role = req.query.role;
        }

        const [users, total] = await Promise.all([
            User.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            User.countDocuments(filter)
        ]);

        const currentMonthPrefix = new Date().toISOString().slice(0, 7); // YYYY-MM
        const userIds = users.map(u => u._id);

        // Fetch searches this month and latest activity for displayed users
        const [monthlyAgg, lastSearches] = await Promise.all([
            UsageDaily.aggregate([
                { $match: { userId: { $in: userIds }, date: { $regex: `^${currentMonthPrefix}` } } },
                { $group: { _id: '$userId', totalSearches: { $sum: '$searchCount' } } }
            ]),
            SearchEvent.aggregate([
                { $match: { userId: { $in: userIds } } },
                { $sort: { time: -1 } },
                { $group: { _id: '$userId', lastTime: { $first: '$time' } } }
            ])
        ]);

        const monthlyMap = new Map(monthlyAgg.map(m => [String(m._id), m.totalSearches]));
        const lastActiveMap = new Map(lastSearches.map(s => [String(s._id), s.lastTime]));

        const dtos = users.map(u => {
            const uid = String(u._id);
            return toUserSummaryDTO(u, {
                searchesThisMonth: monthlyMap.get(uid) || 0,
                lastActive: lastActiveMap.get(uid) || u.updatedAt || u.createdAt
            });
        });

        res.json({
            success: true,
            data: dtos,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit) || 1
            }
        });
    } catch (err) {
        console.error('[AdminUsers listUsers error]:', err.message);
        res.status(400).json({ success: false, message: err.message });
    }
};

/**
 * 2. GET /api/admin/users/:id
 * Account detail, allowance usage meter, 30-day daily chart, last 50 searches, recent IP, audit logging.
 */
exports.getUserDetail = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid user ID format' });
        }

        const user = await User.findById(id).lean();
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Audit log view_user (IP is personal data)
        await logAdminAction({
            adminId: req.user.id,
            adminEmail: req.user.username || 'admin',
            action: 'view_user',
            targetId: user._id,
            targetType: 'User',
            details: { targetEmail: user.email || user.username },
            ip: req.realIp
        });

        // 1. Fetch latest IP
        const recentSearch = await SearchEvent.findOne({ userId: user._id })
            .select('ip time')
            .sort({ time: -1 })
            .lean();

        // 2. Fetch last 50 searches (allow-list sanitized)
        const rawSearches = await SearchEvent.find({ userId: user._id })
            .sort({ time: -1 })
            .limit(50)
            .lean();
        const last50Searches = rawSearches.map(toSearchEventDTO);

        // 3. Monthly usage history from usage_daily
        const monthlyStats = await UsageDaily.aggregate([
            { $match: { userId: new mongoose.Types.ObjectId(id) } },
            {
                $group: {
                    _id: { $substr: ['$date', 0, 7] },
                    totalSearches: { $sum: '$searchCount' },
                    totalSessions: { $sum: '$sessionCount' },
                    totalRows: { $sum: '$rowCount' }
                }
            },
            { $sort: { _id: -1 } },
            { $limit: 12 }
        ]);

        // 4. 30-day daily usage chart data
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const startDateStr = thirtyDaysAgo.toISOString().slice(0, 10);

        const dailyStats = await UsageDaily.find({
            userId: user._id,
            date: { $gte: startDateStr }
        })
            .sort({ date: 1 })
            .select('date searchCount sessionCount rowCount')
            .lean();

        // 5. Usage against allowance
        const currentMonthPrefix = new Date().toISOString().slice(0, 7);
        const currentMonthData = monthlyStats.find(m => m._id === currentMonthPrefix);
        const searchesThisMonth = currentMonthData ? currentMonthData.totalSearches : 0;

        const tierInfo = TIER_CONSTANTS[user.level] || TIER_CONSTANTS.free;
        const allowance = {
            level: user.level,
            plan: user.plan,
            label: tierInfo.label,
            monthlyLimit: tierInfo.monthlySearchLimit,
            dailyLimit: tierInfo.dailySearchLimit,
            usedThisMonth: searchesThisMonth,
            percentUsed: tierInfo.monthlySearchLimit > 0 ? Math.min(100, Math.round((searchesThisMonth / tierInfo.monthlySearchLimit) * 100)) : 0
        };

        res.json({
            success: true,
            data: toUserDetailDTO(user, {
                recentIp: recentSearch?.ip || null,
                allowance,
                monthlyUsage: monthlyStats.map(m => ({
                    month: m._id,
                    searches: m.totalSearches,
                    sessions: m.totalSessions,
                    rows: m.totalRows
                })),
                last30DaysDaily: dailyStats.map(d => ({
                    date: d.date,
                    searches: d.searchCount,
                    sessions: d.sessionCount,
                    rows: d.rowCount
                })),
                last50Searches
            })
        });
    } catch (err) {
        console.error('[AdminUsers getUserDetail error]:', err.message);
        res.status(400).json({ success: false, message: err.message });
    }
};

/**
 * 3. GET /api/admin/users/usage
 * Global summary cards (searches today, active users, signups, pending, blocked) and top-users tables.
 */
exports.getUsage = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page || '1', 10));
        const limitParam = parseInt(req.query.limit || '25', 10);
        const limit = Math.min(100, Math.max(1, isNaN(limitParam) ? 25 : limitParam));
        const skip = (page - 1) * limit;

        const today = new Date().toISOString().slice(0, 10);
        const currentMonthPrefix = today.slice(0, 7);

        // Summary Metric Cards
        const [
            todayUsage,
            totalSignups,
            pendingApprovals,
            blockedAccounts,
            topUsersTodayRaw,
            topUsersMonthRaw
        ] = await Promise.all([
            UsageDaily.aggregate([
                { $match: { date: today } },
                {
                    $group: {
                        _id: null,
                        totalSearchesToday: { $sum: '$searchCount' },
                        activeUsersToday: { $addToSet: '$userId' }
                    }
                }
            ]),
            User.countDocuments(),
            User.countDocuments({ isApproved: false, isBlocked: false }),
            User.countDocuments({ isBlocked: true }),
            // Top users today
            UsageDaily.find({ date: today })
                .sort({ searchCount: -1 })
                .limit(5)
                .populate({ path: 'userId', select: 'email username level plan' })
                .lean(),
            // Top users this month
            UsageDaily.aggregate([
                { $match: { date: { $regex: `^${currentMonthPrefix}` } } },
                { $group: { _id: '$userId', totalSearches: { $sum: '$searchCount' }, plan: { $first: '$plan' } } },
                { $sort: { totalSearches: -1 } },
                { $limit: 5 }
            ])
        ]);

        // Populate top users this month
        const monthUserIds = topUsersMonthRaw.map(m => m._id).filter(Boolean);
        const monthUsers = await User.find({ _id: { $in: monthUserIds } }).select('email username level').lean();
        const monthUserMap = new Map(monthUsers.map(u => [String(u._id), u]));

        const topUsersThisMonth = topUsersMonthRaw.map(m => {
            const u = monthUserMap.get(String(m._id));
            return {
                userId: m._id,
                email: u?.email || u?.username || 'Unknown',
                level: u?.level || 'free',
                totalSearches: m.totalSearches
            };
        });

        const topUsersToday = topUsersTodayRaw.map(r => ({
            userId: r.userId?._id || r.userId,
            email: r.userId?.email || r.userId?.username || 'Unknown',
            level: r.userId?.level || r.plan,
            searchCount: r.searchCount
        }));

        const cards = {
            searchesToday: todayUsage[0]?.totalSearchesToday || 0,
            activeUsersToday: (todayUsage[0]?.activeUsersToday || []).filter(Boolean).length,
            totalSignups,
            pendingApprovals,
            blockedAccounts
        };

        // Table filters
        const filter = {};
        if (req.query.date) filter.date = req.query.date;
        if (req.query.plan && req.query.plan !== 'all') filter.plan = req.query.plan;

        const [dailyRecords, total] = await Promise.all([
            UsageDaily.find(filter)
                .sort({ date: -1, searchCount: -1 })
                .skip(skip)
                .limit(limit)
                .populate({ path: 'userId', select: 'email username' })
                .lean(),
            UsageDaily.countDocuments(filter)
        ]);

        const mappedRecords = dailyRecords.map(item => {
            const dto = toUsageDailyDTO(item);
            if (item.userId && typeof item.userId === 'object') {
                dto.userEmail = item.userId.email || item.userId.username;
            }
            return dto;
        });

        res.json({
            success: true,
            cards,
            topUsersToday,
            topUsersThisMonth,
            data: mappedRecords,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit) || 1
            }
        });
    } catch (err) {
        console.error('[AdminUsers getUsage error]:', err.message);
        res.status(400).json({ success: false, message: err.message });
    }
};

/**
 * 4. GET /api/admin/users/not-found
 */
exports.getNotFoundQueue = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page || '1', 10));
        const limitParam = parseInt(req.query.limit || '25', 10);
        const limit = Math.min(100, Math.max(1, isNaN(limitParam) ? 25 : limitParam));
        const skip = (page - 1) * limit;

        const filter = {};
        if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
        if (req.query.queryType && req.query.queryType !== 'all') filter.queryType = req.query.queryType;

        if (req.query.search && req.query.search.trim()) {
            const clean = req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            filter.normalizedQuery = new RegExp(clean, 'i');
        }

        const sortField = req.query.sortBy === 'lastSeen' ? 'lastSeen' : 'count';
        const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;

        const [items, total] = await Promise.all([
            NotFoundQueue.find(filter)
                .sort({ [sortField]: sortOrder })
                .skip(skip)
                .limit(limit)
                .lean(),
            NotFoundQueue.countDocuments(filter)
        ]);

        res.json({
            success: true,
            data: items.map(toNotFoundDTO),
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit) || 1
            }
        });
    } catch (err) {
        console.error('[AdminUsers getNotFoundQueue error]:', err.message);
        res.status(400).json({ success: false, message: err.message });
    }
};

/**
 * 5. GET /api/admin/users/not-found/:id
 * Drill-down with individual raw search events.
 */
exports.getNotFoundDetail = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid ID format' });
        }

        const item = await NotFoundQueue.findById(id).lean();
        if (!item) {
            return res.status(404).json({ success: false, message: 'Record not found' });
        }

        // Fetch sample users and individual raw searches (last 20, allow-listed)
        const [sampleUsers, rawSearches] = await Promise.all([
            item.sampleUserIds && item.sampleUserIds.length > 0
                ? User.find({ _id: { $in: item.sampleUserIds } }).select('_id email username level plan').lean()
                : [],
            SearchEvent.find({
                normalizedQuery: item.normalizedQuery.toLowerCase(),
                found: false
            })
                .sort({ time: -1 })
                .limit(20)
                .lean()
        ]);

        res.json({
            success: true,
            data: {
                ...toNotFoundDTO(item),
                sampleUsers: sampleUsers.map(u => ({
                    _id: u._id,
                    email: u.email || u.username,
                    level: u.level,
                    plan: u.plan
                })),
                individualSearches: rawSearches.map(toSearchEventDTO)
            }
        });
    } catch (err) {
        console.error('[AdminUsers getNotFoundDetail error]:', err.message);
        res.status(400).json({ success: false, message: err.message });
    }
};

/**
 * 6. GET /api/admin/users/tiers
 * Exposes single source of truth tier constants & level mappings to frontend.
 */
exports.getTiers = (req, res) => {
    res.json({
        success: true,
        tiers: TIER_CONSTANTS,
        mappings: LEVEL_PLAN_MAPPING
    });
};

// ============================================================================
// STAGE 2: ACTIONS THAT MODIFY DATA
// ============================================================================

/**
 * 7. POST /api/admin/users/:id/approve
 */
exports.approveUser = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, message: 'Invalid user ID' });

        const user = await User.findById(id);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        if (user.role === 'admin') return res.status(400).json({ success: false, message: 'Cannot modify admin status' });

        const before = { isApproved: user.isApproved, plan: user.plan, level: user.level };

        user.isApproved = true;
        user.approvedAt = new Date();
        user.approvedBy = req.user.id;

        if (user.plan === 'pending') {
            user.plan = 'free';
            user.level = 'free';
        }

        await user.save();

        await logAdminAction({
            adminId: req.user.id,
            adminEmail: req.user.username || 'admin',
            action: 'user_approve',
            targetId: user._id,
            targetType: 'User',
            details: { before, after: { isApproved: true, plan: user.plan, level: user.level } },
            ip: req.realIp
        });

        res.json({ success: true, message: 'User approved successfully' });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
};

/**
 * 8. POST /api/admin/users/:id/reject
 */
exports.rejectUser = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, message: 'Invalid user ID' });

        const user = await User.findById(id);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        if (user.role === 'admin' || String(user._id) === String(req.user.id)) {
            return res.status(400).json({ success: false, message: 'Cannot reject admin accounts' });
        }

        const before = { isBlocked: user.isBlocked, blockReason: user.blockReason };

        user.isBlocked = true;
        user.blockReason = 'rejected';
        user.blockedAt = new Date();
        user.blockedBy = req.user.id;
        user.tokenRevokedBefore = new Date();
        user.refreshTokenFamily = generateSecureToken();
        await user.save();

        // Revoke session in Redis
        const redis = getRedisClient();
        if (isRedisReady() && redis) {
            await redis.set(`revoked_user:${user._id}`, '1', 'EX', 86400).catch(() => {});
        }

        await logAdminAction({
            adminId: req.user.id,
            adminEmail: req.user.username || 'admin',
            action: 'user_reject',
            targetId: user._id,
            targetType: 'User',
            details: { before, after: { isBlocked: true, blockReason: 'rejected' } },
            ip: req.realIp
        });

        res.json({ success: true, message: 'User registration rejected' });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
};

/**
 * 9. POST /api/admin/users/:id/block
 */
exports.blockUser = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, message: 'Invalid user ID' });

        // Protections: Cannot block self
        if (String(id) === String(req.user.id)) {
            return res.status(400).json({ success: false, message: 'Self-block is prohibited. Administrators cannot block their own account.' });
        }

        const user = await User.findById(id);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        // Protections: Cannot block other admins, and last admin cannot be removed
        if (user.role === 'admin') {
            return res.status(400).json({ success: false, message: 'Administrators cannot be blocked.' });
        }

        const before = { isBlocked: user.isBlocked, blockReason: user.blockReason };
        const reason = sanitizeText(req.body.reason || 'administrative_block');

        user.isBlocked = true;
        user.blockedAt = new Date();
        user.blockedBy = req.user.id;
        user.blockReason = reason;
        user.tokenRevokedBefore = new Date();
        user.refreshTokenFamily = generateSecureToken();
        await user.save();

        // Immediate Redis kill-switch and cache eviction
        const redis = getRedisClient();
        if (isRedisReady() && redis) {
            await Promise.all([
                redis.set(`revoked_user:${user._id}`, '1', 'EX', 86400),
                redis.del(`admin_active:${user._id}`)
            ]).catch(() => {});
        }

        await logAdminAction({
            adminId: req.user.id,
            adminEmail: req.user.username || 'admin',
            action: 'user_block',
            targetId: user._id,
            targetType: 'User',
            details: { before, after: { isBlocked: true, blockReason: reason } },
            ip: req.realIp
        });

        res.json({ success: true, message: 'Account blocked and sessions revoked' });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
};

/**
 * 10. POST /api/admin/users/:id/unblock
 */
exports.unblockUser = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, message: 'Invalid user ID' });

        const user = await User.findById(id);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        const before = { isBlocked: user.isBlocked, blockReason: user.blockReason };

        user.isBlocked = false;
        user.blockedAt = null;
        user.blockedBy = null;
        user.blockReason = null;
        await user.save();

        // Clear revocation flag so user can log in fresh
        const redis = getRedisClient();
        if (isRedisReady() && redis) {
            await Promise.all([
                redis.del(`revoked_user:${user._id}`),
                redis.del(`admin_active:${user._id}`)
            ]).catch(() => {});
        }

        await logAdminAction({
            adminId: req.user.id,
            adminEmail: req.user.username || 'admin',
            action: 'user_unblock',
            targetId: user._id,
            targetType: 'User',
            details: { before, after: { isBlocked: false } },
            ip: req.realIp
        });

        res.json({ success: true, message: 'User account unblocked successfully' });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
};

/**
 * 11. POST /api/admin/users/:id/level
 */
exports.changeUserLevel = async (req, res) => {
    try {
        const { id } = req.params;
        const { newLevel } = req.body;
        if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, message: 'Invalid user ID' });

        if (String(id) === String(req.user.id)) {
            return res.status(400).json({ success: false, message: 'Administrators cannot change their own level.' });
        }

        const user = await User.findById(id);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        if (user.role === 'admin') {
            return res.status(400).json({ success: false, message: 'Administrator accounts cannot be modified.' });
        }

        const mapped = LEVEL_PLAN_MAPPING[newLevel];
        if (!mapped) {
            return res.status(400).json({ success: false, message: 'Invalid level selection. Admin tier cannot be assigned.' });
        }

        const before = { level: user.level, plan: user.plan };

        user.level = mapped.level;
        user.plan = mapped.plan;
        await user.save();

        await logAdminAction({
            adminId: req.user.id,
            adminEmail: req.user.username || 'admin',
            action: 'user_level_change',
            targetId: user._id,
            targetType: 'User',
            details: { before, after: { level: mapped.level, plan: mapped.plan } },
            ip: req.realIp
        });

        res.json({ success: true, message: `User updated to ${TIER_CONSTANTS[mapped.level]?.label || mapped.level}` });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
};

/**
 * 12. POST /api/admin/users/:id/reset-password
 * Direct password reset by admin displaying the new temporary password immediately.
 */
exports.resetUserPassword = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, message: 'Invalid user ID' });

        const user = await User.findById(id);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        if (user.role === 'admin' && String(user._id) !== String(req.user.id)) {
            return res.status(400).json({ success: false, message: 'Cannot reset another administrator password.' });
        }

        // Generate a 14-character alphanumeric temporary password
        const temporaryPassword = crypto.randomBytes(7).toString('hex') + '!9A';
        user.password = await hashPassword(temporaryPassword);
        user.tokenRevokedBefore = new Date();
        user.refreshTokenFamily = generateSecureToken();
        await user.save();

        // Revoke active sessions in Redis
        const redis = getRedisClient();
        if (isRedisReady() && redis) {
            await redis.set(`revoked_user:${user._id}`, '1', 'EX', 300).catch(() => {});
        }

        await logAdminAction({
            adminId: req.user.id,
            adminEmail: req.user.username || 'admin',
            action: 'user_password_reset',
            targetId: user._id,
            targetType: 'User',
            details: { reason: 'Admin direct password reset' },
            ip: req.realIp
        });

        res.json({
            success: true,
            temporaryPassword,
            message: 'Password reset successfully. Provide this temporary password to the user.'
        });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
};

/**
 * 13. POST /api/admin/users/:id/logout-sessions
 */
exports.logoutAllSessions = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, message: 'Invalid user ID' });

        const user = await User.findById(id);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        user.tokenRevokedBefore = new Date();
        user.refreshTokenFamily = generateSecureToken();
        await user.save();

        const redis = getRedisClient();
        if (isRedisReady() && redis) {
            await redis.set(`revoked_user:${user._id}`, '1', 'EX', 300).catch(() => {});
        }

        await logAdminAction({
            adminId: req.user.id,
            adminEmail: req.user.username || 'admin',
            action: 'user_logout_sessions',
            targetId: user._id,
            targetType: 'User',
            details: { reason: 'Admin terminated all sessions' },
            ip: req.realIp
        });

        res.json({ success: true, message: 'All sessions revoked successfully' });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
};

/**
 * 14. PATCH /api/admin/users/not-found/:id
 */
exports.updateNotFoundItem = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, message: 'Invalid ID format' });

        const { status, notes } = req.body;
        const validStatuses = ['new', 'checked', 'added', 'ignored'];

        const update = {};
        if (status) {
            if (!validStatuses.includes(status)) {
                return res.status(400).json({ success: false, message: 'Invalid status enum value' });
            }
            update.status = status;
        }

        if (notes !== undefined) {
            update.notes = sanitizeText(notes);
        }

        const item = await NotFoundQueue.findByIdAndUpdate(id, { $set: update }, { new: true });
        if (!item) return res.status(404).json({ success: false, message: 'Record not found' });

        await logAdminAction({
            adminId: req.user.id,
            adminEmail: req.user.username || 'admin',
            action: 'not_found_update',
            targetId: item._id,
            targetType: 'NotFoundQueue',
            details: { status: update.status, notesLength: update.notes?.length || 0 },
            ip: req.realIp
        });

        res.json({ success: true, data: toNotFoundDTO(item), message: 'Record updated' });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
};
