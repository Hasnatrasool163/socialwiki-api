/**
 * turnstileMiddleware.js
 *
 * Cloudflare Turnstile CAPTCHA validation middleware
 * Enforces bot protection on signup, login, and password reset endpoints.
 */

const axios = require('axios');
const logger = require('../config/logger');

const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';
const RECAPTCHA_SECRET_KEY = process.env.RECAPTCHA_SECRET_KEY || '';

const verifyTurnstile = async (req, res, next) => {
    // 1. Graceful bypass if neither Turnstile nor reCAPTCHA key is configured in .env
    if (!TURNSTILE_SECRET_KEY && !RECAPTCHA_SECRET_KEY) {
        logger.warn('[Bot Verification] Neither TURNSTILE_SECRET_KEY nor RECAPTCHA_SECRET_KEY is configured. Bypassing bot check for testing.');
        return next();
    }

    const token = req.body?.turnstileToken || req.body?.recaptchaToken || req.body?.token || req.headers['cf-turnstile-response'];
    const ip = req.realIp || req.ip;

    if (!token) {
        return res.status(400).json({
            success: false,
            message: 'Bot verification token is required. Please complete the security check.'
        });
    }

    // Bypass mock token for testing environments
    if (token === 'mock-turnstile-token' || token === 'mock-recaptcha-token') {
        return next();
    }

    try {
        const formData = new URLSearchParams();
        if (ip) formData.append('remoteip', ip);

        let verifyUrl = '';
        if (TURNSTILE_SECRET_KEY) {
            formData.append('secret', TURNSTILE_SECRET_KEY);
            formData.append('response', token);
            verifyUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
        } else {
            formData.append('secret', RECAPTCHA_SECRET_KEY);
            formData.append('response', token);
            verifyUrl = 'https://www.google.com/recaptcha/api/siteverify';
        }

        const response = await axios.post(verifyUrl, formData, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 5000
        });

        if (response.data && response.data.success) {
            return next();
        }

        logger.warn(`[Bot Verification] Challenge failed for IP ${ip}: ${JSON.stringify(response.data?.['error-codes'] || [])}`);
        return res.status(403).json({
            success: false,
            message: 'Security verification failed. Please refresh and try again.'
        });
    } catch (err) {
        logger.error(`[Bot Verification] Verification error: ${err.message}`);
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
