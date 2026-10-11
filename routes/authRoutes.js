const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { verifyToken } = require('../middlewares/authmiddleware');
const verifyTurnstile = require('../middlewares/turnstileMiddleware');

// 1. Signup / Registration (Protected by Turnstile)
router.post('/signup', verifyTurnstile, authController.register);
router.post('/register', verifyTurnstile, authController.register); // backwards-compatible alias

// 2. Email Verification & Resend
router.post('/verify-email', authController.verifyEmail);
router.post('/resend-verification', verifyTurnstile, authController.resendVerification);

// 3. Login (Protected by Turnstile, sets httpOnly rotating refresh cookie)
router.post('/login', verifyTurnstile, authController.login);

// 4. Session Refresh & Logout
router.post('/refresh', authController.refreshToken);
router.post('/logout', authController.logout);

// 5. Password Reset (Single-use hashed token, 1h expiry)
router.post('/password-reset/request', verifyTurnstile, authController.requestPasswordReset);
router.post('/password-reset/confirm', authController.confirmPasswordReset);
router.post('/forgot-password', verifyTurnstile, authController.requestPasswordReset); // alias
router.post('/reset-password', authController.confirmPasswordReset); // alias

// 6. Email Change (Authenticated, single-use hashed token)
router.post('/change-email', verifyToken, authController.requestChangeEmail);
router.post('/change-email/confirm', authController.confirmChangeEmail);

// 7. User Preferences (Ticked DBs, history mode)
router.get('/preferences', verifyToken, authController.getPreferences);
router.put('/preferences', verifyToken, authController.updatePreferences);

// 8. User Profile Info
router.get('/me', verifyToken, authController.me);

module.exports = router;
