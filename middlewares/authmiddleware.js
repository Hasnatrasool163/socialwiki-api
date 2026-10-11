const jwt = require('jsonwebtoken');
const { getRedisClient, isRedisReady } = require('../config/redis');

exports.verifyToken = (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) return res.status(401).json({ message: 'No token provided' });

        jwt.verify(token, process.env.JWT_SECRET || 'secret_key_change_in_production', async (err, user) => {
            if (err) return res.status(403).json({ message: 'Invalid token' });

            try {
                // Instant Redis kill-switch check
                const redis = getRedisClient();
                if (isRedisReady() && redis && user?.id) {
                    const isRevoked = await redis.get(`revoked_user:${user.id}`);
                    if (isRevoked === '1') {
                        return res.status(401).json({ message: 'Session has been revoked. Please log in again.' });
                    }
                }
            } catch (_) {}

            req.user = user;
            next();
        });
    } catch (error) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
};
