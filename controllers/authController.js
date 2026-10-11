/**
 * authController.js
 *
 * Phase 2 User Account Controller
 * - argon2id password hashing with legacy migration
 * - Single-use hashed verification & reset tokens
 * - 15-min access tokens & rotating refresh tokens in httpOnly cookies
 * - Reuse detection and instant session family revocation
 * - Disposable email blocking and normalization
 * - Admin approval ('Request Access') retention
 * - User preferences management (Level 2 ticked DBs, history mode)
 */

const User = require('../models/User');
const {
    registerSchema,
    loginSchema,
    verifyEmailSchema,
    resendVerificationSchema,
    requestPasswordResetSchema,
    confirmPasswordResetSchema,
    requestChangeEmailSchema,
    confirmChangeEmailSchema,
    updatePreferencesSchema
} = require('../validations/authValidation');

const { normalizeEmail, isDisposableEmail } = require('../utils/emailUtils');
const { hashPassword, verifyPassword, generateSecureToken, hashToken } = require('../utils/cryptoUtils');
const {
    createAccessToken,
    createRefreshTokenSession,
    rotateRefreshToken,
    revokeSessionFamily,
    revokeAllUserSessions,
    REFRESH_COOKIE_OPTIONS
} = require('../services/auth/tokenService');
const { sendVerificationEmail, sendPasswordResetEmail, sendChangeEmailVerification } = require('../services/email/emailService');
const { getRealVisitorIp, evaluateAuthRisk } = require('../services/ip/ipRiskService');
const { signupIpLimiter, signupSubnetLimiter } = require('../services/limiter/rateLimiterService');
const logger = require('../config/logger');

/**
 * 1. Sign Up (Request Access)
 */
exports.register = async (req, res) => {
    try {
        const validated = registerSchema.parse(req.body);
        const normalized = normalizeEmail(validated.email);

        // A. Disposable email check
        if (isDisposableEmail(normalized)) {
            return res.status(400).json({
                success: false,
                message: 'Disposable and temporary email addresses are not permitted. Please use a permanent email address.'
            });
        }

        // B. IP Risk threat check (VPN, Tor, Proxy, Abusers)
        const clientIp = getRealVisitorIp(req);
        const risk = await evaluateAuthRisk(clientIp.ip);
        if (!risk.allow) {
            return res.status(403).json({
                success: false,
                vpnBlocked: true,
                message: risk.reason
            });
        }

        // C. Signup rate limits (5 per IP/day, 15 per /24 subnet/day)
        try {
            await Promise.all([
                signupIpLimiter.consume(clientIp.ip, 1),
                signupSubnetLimiter.consume(clientIp.subnet, 1)
            ]);
        } catch (rlError) {
            return res.status(429).json({
                success: false,
                message: 'Too many account creation requests from your network today. Please try again tomorrow.'
            });
        }

        // D. Check for existing user
        const existing = await User.findOne({ $or: [{ email: normalized }, { username: normalized }] });
        if (existing) {
            return res.status(400).json({
                success: false,
                message: 'An account with this email address already exists.'
            });
        }

        // E. Hash password with argon2id
        const hashedPassword = await hashPassword(validated.password);

        // F. Generate single-use verification token (24-hour expiry)
        const rawToken = generateSecureToken();
        const tokenHash = hashToken(rawToken);
        const tokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

        const newUser = new User({
            username: validated.username?.trim().toLowerCase() || normalized,
            email: normalized,
            password: hashedPassword,
            role: 'user',
            level: 'free',
            plan: 'pending',        // Requires admin approval ('Request Access')
            isVerified: false,
            isApproved: false,
            isBlocked: false,
            verificationTokenHash: tokenHash,
            verificationTokenExpires: tokenExpires,
            savedDatabases: ['rm'],
            historyMode: 'latest',
            probationUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 1-week probation
            trialStartedAt: new Date()
        });

        await newUser.save();

        // G. Send verification email via queue
        sendVerificationEmail(normalized, rawToken).catch(err => {
            logger.error(`[Signup] Failed to queue verification email: ${err.message}`);
        });

        // H. No tokens issued until email verified
        res.status(201).json({
            success: true,
            pending: true,
            message: 'Account created! Please check your inbox to verify your email address. Once verified, access will be granted by our team.'
        });
    } catch (err) {
        if (err.name === 'ZodError') {
            return res.status(400).json({ success: false, errors: err.errors });
        }
        logger.error(`[Signup error] ${err.message}`);
        res.status(500).json({ success: false, message: 'Failed to create account. Please try again later.' });
    }
};

/**
 * 2. Verify Email (Single-use token)
 */
exports.verifyEmail = async (req, res) => {
    try {
        const validated = verifyEmailSchema.parse(req.body);
        const hashed = hashToken(validated.token);

        const user = await User.findOne({
            verificationTokenHash: hashed,
            verificationTokenExpires: { $gt: new Date() }
        });

        if (!user) {
            return res.status(400).json({
                success: false,
                message: 'Invalid or expired verification link. Please request a new verification link.'
            });
        }

        user.isVerified = true;
        user.verificationTokenHash = undefined;
        user.verificationTokenExpires = undefined;
        await user.save();

        res.json({
            success: true,
            message: 'Your email has been successfully verified! Your account is currently queued for access approval.'
        });
    } catch (err) {
        if (err.name === 'ZodError') {
            return res.status(400).json({ success: false, errors: err.errors });
        }
        res.status(500).json({ success: false, message: 'Verification failed.' });
    }
};

/**
 * 3. Resend Verification Link (Rate limited, never reveals registered status)
 */
exports.resendVerification = async (req, res) => {
    try {
        const validated = resendVerificationSchema.parse(req.body);
        const normalized = normalizeEmail(validated.email);

        const user = await User.findOne({ email: normalized });
        if (user && !user.isVerified && !user.isBlocked) {
            const rawToken = generateSecureToken();
            user.verificationTokenHash = hashToken(rawToken);
            user.verificationTokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
            await user.save();

            sendVerificationEmail(normalized, rawToken).catch(err => {
                logger.error(`[Resend Verification] Error: ${err.message}`);
            });
        }

        // Generic safe response
        res.json({
            success: true,
            message: 'If an unverified account with that email exists, a verification link has been sent.'
        });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
};

/**
 * 4. Login (Issues 15m access token & rotating httpOnly refresh token cookie)
 */
exports.login = async (req, res) => {
    try {
        const validated = loginSchema.parse(req.body);
        const normalized = normalizeEmail(validated.username);

        // Threat intelligence gate
        const clientIp = getRealVisitorIp(req);
        const risk = await evaluateAuthRisk(clientIp.ip);

        // Find user by email or username
        const user = await User.findOne({ $or: [{ email: normalized }, { username: normalized }] });
        if (!user) return res.status(400).json({ success: false, message: 'Invalid email or password.' });

        // Non-admin accounts blocked if connecting from abusive / Tor networks
        if (user.role !== 'admin' && !risk.allow) {
            return res.status(403).json({
                success: false,
                vpnBlocked: true,
                message: risk.reason
            });
        }

        // Verify password (argon2id with legacy bcrypt check)
        const { isValid, needsRehash } = await verifyPassword(validated.password, user.password);
        if (!isValid) return res.status(400).json({ success: false, message: 'Invalid email or password.' });

        // Automatic upgrade from legacy bcrypt to argon2id on successful login
        if (needsRehash) {
            user.password = await hashPassword(validated.password);
            await user.save();
        }

        // Account status checks
        if (user.isBlocked) {
            return res.status(403).json({ success: false, message: 'Your account has been deactivated. Please contact support.' });
        }

        if (!user.isVerified && user.role !== 'admin') {
            return res.status(403).json({
                success: false,
                unverified: true,
                message: 'Please verify your email address before logging in.'
            });
        }

        if ((user.plan === 'pending' || !user.isApproved) && user.role !== 'admin') {
            return res.status(403).json({
                success: false,
                pending: true,
                message: 'Your account is pending approval. We will notify you by email as soon as access is granted.'
            });
        }

        // Generate 15-minute access token
        const accessToken = createAccessToken(user);

        // Generate rotating refresh token session
        const { refreshToken } = await createRefreshTokenSession(user);

        // Set httpOnly secure cookie
        res.cookie('refreshToken', refreshToken, REFRESH_COOKIE_OPTIONS);

        res.json({
            success: true,
            accessToken,
            user: {
                id: user._id,
                email: user.email,
                username: user.username,
                role: user.role,
                level: user.level || 'free',
                plan: user.plan || 'free',
                isVerified: user.isVerified,
                savedDatabases: user.savedDatabases || ['rm'],
                historyMode: user.historyMode || 'latest'
            }
        });
    } catch (err) {
        if (err.name === 'ZodError') {
            return res.status(400).json({ success: false, errors: err.errors });
        }
        logger.error(`[Login error] ${err.message}`);
        res.status(500).json({ success: false, message: 'Login failed. Please try again later.' });
    }
};

/**
 * 5. Refresh Access Token (Rotates refresh token cookie with reuse detection)
 */
exports.refreshToken = async (req, res) => {
    try {
        const oldRefreshToken = req.cookies?.refreshToken;
        if (!oldRefreshToken) {
            return res.status(401).json({ success: false, message: 'No refresh token provided.' });
        }

        const { userId, newRefreshToken } = await rotateRefreshToken(oldRefreshToken);

        const user = await User.findById(userId);
        if (!user || user.isBlocked) {
            return res.status(401).json({ success: false, message: 'User session invalid.' });
        }

        // Issue new 15-minute access token
        const accessToken = createAccessToken(user);

        // Set newly rotated refresh token cookie
        res.cookie('refreshToken', newRefreshToken, REFRESH_COOKIE_OPTIONS);

        res.json({
            success: true,
            accessToken
        });
    } catch (err) {
        // Clear cookie if token is compromised or expired
        res.clearCookie('refreshToken', REFRESH_COOKIE_OPTIONS);
        res.status(401).json({ success: false, message: err.message });
    }
};

/**
 * 6. Logout
 */
exports.logout = async (req, res) => {
    try {
        const token = req.cookies?.refreshToken;
        if (token) {
            try {
                const jwt = require('jsonwebtoken');
                const decoded = jwt.decode(token);
                if (decoded?.familyId) {
                    await revokeSessionFamily(decoded.familyId);
                }
            } catch (_) {}
        }

        res.clearCookie('refreshToken', REFRESH_COOKIE_OPTIONS);
        res.json({ success: true, message: 'Logged out successfully.' });
    } catch (err) {
        res.clearCookie('refreshToken', REFRESH_COOKIE_OPTIONS);
        res.json({ success: true, message: 'Logged out.' });
    }
};

/**
 * 7. Request Password Reset (Single-use token, 1-hour expiry, never reveals registration)
 */
exports.requestPasswordReset = async (req, res) => {
    try {
        const validated = requestPasswordResetSchema.parse(req.body);
        const normalized = normalizeEmail(validated.email);

        const user = await User.findOne({ email: normalized });
        if (user && !user.isBlocked) {
            const rawToken = generateSecureToken();
            user.resetPasswordTokenHash = hashToken(rawToken);
            user.resetPasswordTokenExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
            await user.save();

            sendPasswordResetEmail(normalized, rawToken).catch(err => {
                logger.error(`[Password Reset] Queue error: ${err.message}`);
            });
        }

        // Safe generic response
        res.json({
            success: true,
            message: 'If an account with that email exists, password reset instructions have been sent to your inbox.'
        });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
};

/**
 * 8. Confirm Password Reset (Single-use, revokes all active sessions)
 */
exports.confirmPasswordReset = async (req, res) => {
    try {
        const validated = confirmPasswordResetSchema.parse(req.body);
        const hashed = hashToken(validated.token);

        const user = await User.findOne({
            resetPasswordTokenHash: hashed,
            resetPasswordTokenExpires: { $gt: new Date() }
        });

        if (!user) {
            return res.status(400).json({
                success: false,
                message: 'Invalid or expired password reset link. Please request a new one.'
            });
        }

        user.password = await hashPassword(validated.newPassword);
        user.resetPasswordTokenHash = undefined;
        user.resetPasswordTokenExpires = undefined;
        await user.save();

        // Security: Revoke all existing sessions across all devices
        await revokeAllUserSessions(user._id.toString());
        res.clearCookie('refreshToken', REFRESH_COOKIE_OPTIONS);

        res.json({
            success: true,
            message: 'Your password has been successfully reset. Please log in with your new password.'
        });
    } catch (err) {
        if (err.name === 'ZodError') {
            return res.status(400).json({ success: false, errors: err.errors });
        }
        res.status(500).json({ success: false, message: 'Password reset failed.' });
    }
};

/**
 * 9. Get User Saved Preferences
 */
exports.getPreferences = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        res.json({
            success: true,
            level: user.level || 'free',
            savedDatabases: user.savedDatabases || ['rm'],
            historyMode: user.historyMode || 'latest'
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * 10. Update User Saved Preferences
 * Level changes ONLY through billing/admin, never by user input
 */
exports.updatePreferences = async (req, res) => {
    try {
        const validated = updatePreferencesSchema.parse(req.body);
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        if (validated.savedDatabases) user.savedDatabases = validated.savedDatabases;
        if (validated.historyMode) user.historyMode = validated.historyMode;

        await user.save();

        res.json({
            success: true,
            message: 'Preferences saved successfully.',
            savedDatabases: user.savedDatabases,
            historyMode: user.historyMode
        });
    } catch (err) {
        if (err.name === 'ZodError') {
            return res.status(400).json({ success: false, errors: err.errors });
        }
        res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * 11. Current User Info (/api/me)
 */
exports.me = async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-password');
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        res.json({
            success: true,
            user: {
                id: user._id,
                email: user.email,
                username: user.username,
                role: user.role,
                level: user.level || 'free',
                plan: user.plan || 'free',
                isVerified: user.isVerified,
                savedDatabases: user.savedDatabases || ['rm'],
                historyMode: user.historyMode || 'latest'
            }
        });
    } catch (err) {
        res.status(401).json({ success: false, message: 'Unauthorized' });
    }
};

/**
 * 12. Request Email Change (Requires password authentication, sends verification to new address)
 */
exports.requestChangeEmail = async (req, res) => {
    try {
        const validated = requestChangeEmailSchema.parse(req.body);
        const normalizedNewEmail = normalizeEmail(validated.newEmail);

        if (isDisposableEmail(normalizedNewEmail)) {
            return res.status(400).json({
                success: false,
                message: 'Disposable and temporary email addresses are not permitted.'
            });
        }

        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        if (user.email === normalizedNewEmail) {
            return res.status(400).json({
                success: false,
                message: 'The new email address cannot be the same as your current email address.'
            });
        }

        // Verify current password
        const { isValid } = await verifyPassword(validated.currentPassword, user.password);
        if (!isValid) {
            return res.status(400).json({ success: false, message: 'Incorrect password.' });
        }

        // Check if new email is already in use by another user
        const existing = await User.findOne({ email: normalizedNewEmail });
        if (existing) {
            return res.status(400).json({
                success: false,
                message: 'This email address is already registered to another account.'
            });
        }

        // Generate single-use verification token (24-hour expiry)
        const rawToken = generateSecureToken();
        user.pendingEmail = normalizedNewEmail;
        user.pendingEmailTokenHash = hashToken(rawToken);
        user.pendingEmailTokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await user.save();

        sendChangeEmailVerification(normalizedNewEmail, rawToken).catch(err => {
            logger.error(`[Change Email] Email delivery error: ${err.message}`);
        });

        res.json({
            success: true,
            message: 'A confirmation link has been sent to your new email address. Please click it to confirm the change.'
        });
    } catch (err) {
        if (err.name === 'ZodError') {
            return res.status(400).json({ success: false, errors: err.errors });
        }
        res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * 13. Confirm Email Change (Single-use token, updates email and revokes existing sessions)
 */
exports.confirmChangeEmail = async (req, res) => {
    try {
        const validated = confirmChangeEmailSchema.parse(req.body);
        const hashed = hashToken(validated.token);

        const user = await User.findOne({
            pendingEmailTokenHash: hashed,
            pendingEmailTokenExpires: { $gt: new Date() }
        });

        if (!user || !user.pendingEmail) {
            return res.status(400).json({
                success: false,
                message: 'Invalid or expired email change token. Please request the change again.'
            });
        }

        const newEmail = user.pendingEmail;
        user.email = newEmail;
        user.pendingEmail = undefined;
        user.pendingEmailTokenHash = undefined;
        user.pendingEmailTokenExpires = undefined;
        await user.save();

        // Revoke all existing sessions across devices for safety on email change
        await revokeAllUserSessions(user._id.toString());
        res.clearCookie('refreshToken', REFRESH_COOKIE_OPTIONS);

        res.json({
            success: true,
            message: 'Your email address has been successfully updated. Please log in with your new email.'
        });
    } catch (err) {
        if (err.name === 'ZodError') {
            return res.status(400).json({ success: false, errors: err.errors });
        }
        res.status(500).json({ success: false, message: 'Email change confirmation failed.' });
    }
};
