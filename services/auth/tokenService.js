/**
 * tokenService.js
 *
 * Authentication token service:
 * - 15-minute access token (stored in frontend memory)
 * - 7-day httpOnly secure cookie refresh token
 * - Strict refresh token rotation on every use
 * - Automatic reuse detection (revokes entire session family if compromised)
 * - Instant Redis user kill-switch revocation
 */

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getRedisClient, isRedisReady } = require('../../config/redis');
const logger = require('../../config/logger');

const JWT_SECRET = process.env.JWT_SECRET || 'secret_key_change_in_production';
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY = '7d';

// In-memory fallback if Redis is down
const memorySessionFamilies = new Map();

/**
 * Creates an access token (15m validity)
 */
function createAccessToken(user) {
    return jwt.sign(
        {
            id: user._id.toString(),
            role: user.role,
            level: user.level || 'free',
            plan: user.plan || 'pending',
            isVerified: !!user.isVerified,
            isApproved: !!user.isApproved
        },
        JWT_SECRET,
        { expiresIn: ACCESS_TOKEN_EXPIRY }
    );
}

/**
 * Creates a new refresh token family for a login session
 */
async function createRefreshTokenSession(user) {
    const familyId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    const version = 1;
    const redis = getRedisClient();

    const sessionData = {
        userId: user._id.toString(),
        version,
        createdAt: Date.now()
    };

    try {
        if (isRedisReady() && redis) {
            // Store session family in Redis with 7-day TTL
            await redis.set(`session:family:${familyId}`, JSON.stringify(sessionData), 'EX', 7 * 86400);
        } else {
            memorySessionFamilies.set(familyId, sessionData);
        }
    } catch (redisErr) {
        logger.warn(`[tokenService] Redis save failed: ${redisErr.message}, falling back to memory store`);
        memorySessionFamilies.set(familyId, sessionData);
    }

    const refreshToken = jwt.sign(
        { id: user._id.toString(), familyId, version },
        JWT_SECRET,
        { expiresIn: REFRESH_TOKEN_EXPIRY }
    );

    return { familyId, refreshToken };
}

/**
 * Rotates a refresh token with reuse detection
 */
async function rotateRefreshToken(oldRefreshToken) {
    let decoded;
    try {
        decoded = jwt.verify(oldRefreshToken, JWT_SECRET);
    } catch (err) {
        throw new Error('Invalid or expired refresh token');
    }

    const { id: userId, familyId, version } = decoded;
    const redis = getRedisClient();
    const redisKey = `session:family:${familyId}`;

    // Check if user is globally revoked in Redis
    if (isRedisReady() && redis) {
        const isUserRevoked = await redis.get(`revoked_user:${userId}`);
        if (isUserRevoked === '1') {
            throw new Error('User session has been revoked.');
        }
    }

    let session = null;
    if (isRedisReady() && redis) {
        const raw = await redis.get(redisKey);
        if (raw) session = JSON.parse(raw);
    } else {
        session = memorySessionFamilies.get(familyId);
    }

    if (!session) {
        throw new Error('Session has expired or was revoked.');
    }

    // Reuse detection: If incoming version does not match active version, token was reused!
    if (session.version !== version) {
        logger.warn(`[SECURITY ALERT] Refresh token reuse detected for user ${userId}, family ${familyId}! Revoking entire family.`);
        if (isRedisReady() && redis) {
            await redis.del(redisKey);
        }
        memorySessionFamilies.delete(familyId);
        throw new Error('Token reuse detected. All active sessions for this device have been revoked for your security.');
    }

    // Increment version for rotation
    const newVersion = session.version + 1;
    session.version = newVersion;

    if (isRedisReady() && redis) {
        await redis.set(redisKey, JSON.stringify(session), 'EX', 7 * 86400);
    } else {
        memorySessionFamilies.set(familyId, session);
    }

    const newRefreshToken = jwt.sign(
        { id: userId, familyId, version: newVersion },
        JWT_SECRET,
        { expiresIn: REFRESH_TOKEN_EXPIRY }
    );

    return { userId, familyId, newRefreshToken };
}

/**
 * Revokes an individual session family (e.g. on logout)
 */
async function revokeSessionFamily(familyId) {
    if (!familyId) return;
    const redis = getRedisClient();
    if (isRedisReady() && redis) {
        await redis.del(`session:family:${familyId}`);
    }
    memorySessionFamilies.delete(familyId);
}

/**
 * Instantly revokes ALL sessions for a user across all devices
 */
async function revokeAllUserSessions(userId) {
    const redis = getRedisClient();
    if (isRedisReady() && redis) {
        // Set user revocation flag for 7 days
        await redis.set(`revoked_user:${userId}`, '1', 'EX', 7 * 86400);
    }
    for (const [fId, data] of memorySessionFamilies.entries()) {
        if (data.userId === userId) memorySessionFamilies.delete(fId);
    }
}

/**
 * Standard cookie configuration for refresh token
 */
const REFRESH_COOKIE_OPTIONS = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/auth',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
};

module.exports = {
    createAccessToken,
    createRefreshTokenSession,
    rotateRefreshToken,
    revokeSessionFamily,
    revokeAllUserSessions,
    REFRESH_COOKIE_OPTIONS
};
