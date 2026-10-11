const { RateLimiterRedis, RateLimiterMemory } = require('rate-limiter-flexible');
const { getRedisClient, isRedisReady } = require('../../config/redis');
const logger = require('../../config/logger');
const SearchEvent = require('../../models/SearchEvent');
const NotFoundQueue = require('../../models/NotFoundQueue');
const UsageDaily = require('../../models/UsageDaily');

const PM2_WORKERS = parseInt(process.env.PM2_INSTANCES || process.env.WEB_CONCURRENCY || '1', 10);

// In-memory fallback session cache if Redis is unavailable
const memorySessions = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of memorySessions.entries()) {
        if (now - v.ts > 30000) memorySessions.delete(k);
    }
}, 30000);

/**
 * Factory helper: Creates a RateLimiterRedis backed by a RateLimiterMemory insurance limiter
 */
function createLimiterPair(keyPrefix, points, durationSecs, blockDurationSecs = 0) {
    const memoryPoints = Math.max(1, Math.floor(points / PM2_WORKERS));
    const memoryLimiter = new RateLimiterMemory({
        keyPrefix: `${keyPrefix}_mem`,
        points: memoryPoints,
        duration: durationSecs,
        blockDuration: blockDurationSecs
    });

    const redis = getRedisClient();
    if (!redis) {
        return memoryLimiter;
    }

    return new RateLimiterRedis({
        storeClient: redis,
        keyPrefix: `${keyPrefix}_redis`,
        points,
        duration: durationSecs,
        blockDuration: blockDurationSecs,
        insuranceLimiter: memoryLimiter
    });
}

// ---------------------------------------------------------------------------
// 1. Suggest Limiters (30 per 10s, 600 per hour)
// ---------------------------------------------------------------------------
const suggest10sLimiter = createLimiterPair('rl_sug_10s', 30, 10, 10);
const suggestHourLimiter = createLimiterPair('rl_sug_1h', 600, 3600, 3600);

// ---------------------------------------------------------------------------
// 2. Tier Search Limiters
// ---------------------------------------------------------------------------
// Free Basic: 5/day (8 weeks validity)
const freeBasicDailyLimiter = createLimiterPair('rl_free_basic_day', 5, 86400);

// Free Advanced: 5/day (1 week validity)
const freeAdvancedDailyLimiter = createLimiterPair('rl_free_adv_day', 5, 86400);

// Level 1: RM address only (20/day, 60/week)
const level1DailyLimiter = createLimiterPair('rl_l1_day', 20, 86400);
const level1WeeklyLimiter = createLimiterPair('rl_l1_week', 60, 7 * 86400);

// Level 2: 1000/month, fair-use 100/day
const level2DailyLimiter = createLimiterPair('rl_l2_day', 100, 86400);
const level2MonthlyLimiter = createLimiterPair('rl_l2_month', 1000, 30 * 86400);

// Level 2 High: 3000/month, fair-use 300/day
const level2HighDailyLimiter = createLimiterPair('rl_l2h_day', 300, 86400);
const level2HighMonthlyLimiter = createLimiterPair('rl_l2h_month', 3000, 30 * 86400);

// Paid / Legacy default: 500/day
const paidDailyLimiter = createLimiterPair('rl_paid_day', parseInt(process.env.PAID_DAILY_LIMIT || '500', 10), 86400);

// ---------------------------------------------------------------------------
// 3. Signup & Auth Abuse Limiters (Max 5/day per IP, 15/day per /24 subnet)
// ---------------------------------------------------------------------------
const signupIpLimiter = createLimiterPair('rl_sign_ip', 5, 86400);
const signupSubnetLimiter = createLimiterPair('rl_sign_sub', 15, 86400);

// ---------------------------------------------------------------------------
// 3. Lookup Session Matcher
// ---------------------------------------------------------------------------
const sameSession = (prev, q, now) => {
    if (!prev || !prev.q || !q) return false;
    const isWithin30s = now - prev.ts < 30000;
    const queryNormalized = q.trim().toLowerCase();
    const prevNormalized = prev.q.trim().toLowerCase();
    const isPrefixExtensionOrReduction =
        queryNormalized.startsWith(prevNormalized) || prevNormalized.startsWith(queryNormalized);
    return isWithin30s && isPrefixExtensionOrReduction;
};

/**
 * Track session state. Returns whether this query consumes 1 search quota.
 */
async function evaluateSession(userId, rawQuery) {
    const now = Date.now();
    const redis = getRedisClient();
    const sessionKey = `sess:${userId}`;

    let prev = null;
    if (isRedisReady() && redis) {
        try {
            const raw = await redis.get(sessionKey);
            if (raw) prev = JSON.parse(raw);
        } catch (e) {
            prev = memorySessions.get(userId) || null;
        }
    } else {
        prev = memorySessions.get(userId) || null;
    }

    if (sameSession(prev, rawQuery, now)) {
        // Same session: refresh timestamp and keep session ID, 0 quota consumed
        const updated = { id: prev.id, q: rawQuery, ts: now };
        if (isRedisReady() && redis) {
            try {
                await redis.set(sessionKey, JSON.stringify(updated), 'EX', 30);
            } catch (_) {}
        }
        memorySessions.set(userId, updated);
        return { isNewSession: false, sessionId: prev.id };
    }

    // New session: generate ID and consume 1 quota
    const newSessionId = `s_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const newSession = { id: newSessionId, q: rawQuery, ts: now };

    if (isRedisReady() && redis) {
        try {
            await redis.set(sessionKey, JSON.stringify(newSession), 'EX', 30);
        } catch (_) {}
    }
    memorySessions.set(userId, newSession);
    return { isNewSession: true, sessionId: newSessionId };
}

/**
 * Check kill switch status
 */
async function isKillSwitchActive(dataset = null) {
    if (process.env.KILL_SWITCH_ACTIVE === 'true') return true;
    const redis = getRedisClient();
    if (!isRedisReady() || !redis) return false;
    try {
        const globalSwitch = await redis.get('kill_switch:all');
        if (globalSwitch === '1') return true;
        if (dataset) {
            const datasetSwitch = await redis.get(`kill_switch:${dataset}`);
            if (datasetSwitch === '1') return true;
        }
    } catch (_) {}
    return false;
}

/**
 * Asynchronous logger to SearchEvent and UsageDaily (Never blocks request response)
 */
function logSearchAsync(payload) {
    setImmediate(async () => {
        try {
            const {
                userId,
                query,
                queryType,
                datasetsSearched,
                resultCountPerDataset,
                totalResults,
                found,
                sessionId,
                ip,
                userAgent,
                plan,
                postcodes = []
            } = payload;

            // 1. Record raw event with 90-day TTL in auth DB
            await SearchEvent.create({
                userId,
                time: new Date(),
                normalizedQuery: (query || '').trim().toLowerCase(),
                queryType: queryType || 'other',
                datasetsSearched: datasetsSearched || [],
                resultCountPerDataset: resultCountPerDataset || {},
                totalResults: totalResults || 0,
                found: !!found,
                searchSessionId: sessionId,
                ip,
                ipRisk: payload.ipRisk,
                userAgent
            }).catch(err => logger.error(`[SearchEvent] write failed: ${err.message}`));

            // 2. Queue not-found searches for review
            if (!found && query && (queryType === 'postcode' || queryType === 'address' || queryType === 'business')) {
                const normalized = query.trim().toUpperCase();
                await NotFoundQueue.findOneAndUpdate(
                    { normalizedQuery: normalized },
                    {
                        $inc: { count: 1 },
                        $set: { lastSeen: new Date(), queryType },
                        $setOnInsert: { firstSeen: new Date(), status: 'new' },
                        $addToSet: { sampleUserIds: userId }
                    },
                    { upsert: true }
                ).catch(err => logger.error(`[NotFoundQueue] write failed: ${err.message}`));
            }

            // 3. Roll up into UsageDaily in auth DB
            if (userId) {
                const dateKey = new Date().toISOString().slice(0, 10);
                await UsageDaily.findOneAndUpdate(
                    { userId, date: dateKey },
                    {
                        $inc: { searchCount: 1, rowCount: totalResults || 0 },
                        $setOnInsert: { plan: plan || 'free' },
                        $addToSet: { distinctPostcodes: { $each: postcodes.slice(0, 50) } }
                    },
                    { upsert: true }
                ).catch(err => logger.error(`[UsageDaily] rollup failed: ${err.message}`));
            }
        } catch (err) {
            logger.error(`[RateLimiterService] logSearchAsync error: ${err.message}`);
        }
    });
}

module.exports = {
    suggest10sLimiter,
    suggestHourLimiter,
    freeBasicDailyLimiter,
    freeAdvancedDailyLimiter,
    level1DailyLimiter,
    level1WeeklyLimiter,
    level2DailyLimiter,
    level2MonthlyLimiter,
    level2HighDailyLimiter,
    level2HighMonthlyLimiter,
    paidDailyLimiter,
    signupIpLimiter,
    signupSubnetLimiter,
    evaluateSession,
    isKillSwitchActive,
    logSearchAsync
};
