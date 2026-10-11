/**
 * turnstileMiddleware.js
 *
 * Cloudflare Turnstile CAPTCHA validation middleware
 * Enforces bot protection on signup, login, and password reset endpoints.
 */

const axios = require('axios');
const logger = require('../config/logger');

const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || process.env.RECAPTCHA_SECRET_KEY || '';

const verifyTurnstile = async (req, res, next) => {
    // Graceful bypass in development or testing if secret is not set
    if (!TURNSTILE_SECRET_KEY) {
        if (process.env.NODE_ENV === 'production') {
            logger.warn('[Turnstile] WARNING: TURNSTILE_SECRET_KEY is not configured in production!');
        }
        return next();
    }

    const token = req.body?.turnstileToken || req.body?.token || req.headers['cf-turnstile-response'];
    const ip = req.realIp || req.ip;

    if (!token) {
        return res.status(400).json({
            success: false,
            message: 'Bot verification token is required. Please complete the security check.'
        });
    }

    // Bypass mock token for testing
    if (token === 'mock-turnstile-token' && process.env.NODE_ENV !== 'production') {
        return next();
    }

    try {
        const formData = new URLSearchParams();
        formData.append('secret', TURNSTILE_SECRET_KEY);
        formData.append('response', token);
        if (ip) formData.append('remoteip', ip);

        const verifyUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
        const response = await axios.post(verifyUrl, formData, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 4000
        });

        if (response.data && response.data.success) {
            return next();
        }

        logger.warn(`[Turnstile] Challenge verification failed for IP ${ip}: ${JSON.stringify(response.data?.['error-codes'] || [])}`);
        return res.status(403).json({
            success: false,
            message: 'Security verification failed. Please refresh and try again.'
        });
    } catch (err) {
        logger.error(`[Turnstile] Verification error: ${err.message}`);
        // If Cloudflare is experiencing an outage, fail-open with logging or fail-closed based on environment
        if (process.env.NODE_ENV === 'production') {
            return res.status(503).json({
                success: false,
                message: 'Security challenge service temporarily unavailable. Please try again shortly.'
            });
        }
        next();
    }
};

module.exports = verifyTurnstile;
module.exports.verifyTurnstile = verifyTurnstile;
