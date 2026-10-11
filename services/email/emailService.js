/**
 * emailService.js
 *
 * Transactional email service backed by Resend API and BullMQ retry queue.
 * - Rate limits resends (1 per 60s per address)
 * - BullMQ queue on Redis with automatic exponential backoff retries (3 attempts)
 * - Graceful fallback to immediate direct send if Redis is offline
 */

const { Queue, Worker } = require('bullmq');
const { Resend } = require('resend');
const { getRedisClient, isRedisReady } = require('../../config/redis');
const logger = require('../../config/logger');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'SocialWiki <noreply@socialwiki.co.uk>';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://socialwiki.co.uk';

let resendClient = null;
if (RESEND_API_KEY) {
    resendClient = new Resend(RESEND_API_KEY);
}

// Resend rate limit tracking (1 email per 60s per recipient)
const recentSends = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [email, ts] of recentSends.entries()) {
        if (now - ts > 60000) recentSends.delete(email);
    }
}, 60000);

/**
 * Core send execution
 */
async function sendEmailDirect({ to, subject, html, text }) {
    if (!resendClient) {
        logger.info(`[Email - DEV LOG] To: ${to} | Subject: ${subject}`);
        logger.debug(`[Email - DEV BODY] ${text || html}`);
        return { success: true, mocked: true };
    }

    try {
        const result = await resendClient.emails.send({
            from: EMAIL_FROM,
            to: [to],
            subject,
            html,
            text
        });
        logger.info(`[Email] Successfully sent email to ${to} (id: ${result.data?.id})`);
        return { success: true, id: result.data?.id };
    } catch (err) {
        logger.error(`[Email] Failed to send email to ${to}: ${err.message}`);
        throw err;
    }
}

// Setup BullMQ Queue if Redis is available
let emailQueue = null;
let emailWorker = null;

try {
    const redis = getRedisClient();
    if (redis) {
        emailQueue = new Queue('email-delivery', {
            connection: redis,
            defaultJobOptions: {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 5000 // 5s, 10s, 20s
                },
                removeOnComplete: true,
                removeOnFail: 100
            }
        });

        emailWorker = new Worker('email-delivery', async (job) => {
            await sendEmailDirect(job.data);
        }, { connection: redis });

        emailWorker.on('failed', (job, err) => {
            logger.error(`[Email Queue] Job ${job.id} to ${job.data?.to} failed: ${err.message}`);
        });
    }
} catch (queueErr) {
    logger.warn(`[Email Queue] Redis queue init failed (${queueErr.message}); falling back to direct sending.`);
}

/**
 * Dispatches an email job
 */
async function queueEmail({ to, subject, html, text }) {
    const now = Date.now();
    const lastSent = recentSends.get(to);
    if (lastSent && (now - lastSent < 60000)) {
        const waitSecs = Math.ceil((60000 - (now - lastSent)) / 1000);
        throw new Error(`Please wait ${waitSecs} seconds before requesting another email.`);
    }

    recentSends.set(to, now);

    if (emailQueue && isRedisReady()) {
        await emailQueue.add('send', { to, subject, html, text });
        return { queued: true };
    }

    // Direct fallback if queue is not available
    return sendEmailDirect({ to, subject, html, text });
}

/**
 * Sends account verification email
 */
async function sendVerificationEmail(email, rawToken) {
    const verifyLink = `${FRONTEND_URL}/verify-email?token=${rawToken}`;
    const subject = 'Verify your SocialWiki account';
    const html = `
        <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; rounded: 8px;">
            <h2 style="color: #0f172a;">Welcome to SocialWiki</h2>
            <p style="color: #334155; line-height: 1.6;">Thank you for registering. Please click the button below to verify your email address. This link is valid for 24 hours.</p>
            <div style="margin: 24px 0;">
                <a href="${verifyLink}" style="background-color: #0284c7; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Verify Email Address</a>
            </div>
            <p style="color: #64748b; font-size: 13px;">If the button does not work, copy and paste this link into your browser:<br/><a href="${verifyLink}">${verifyLink}</a></p>
            <p style="color: #94a3b8; font-size: 12px; margin-top: 24px;">If you did not request this, you can safely ignore this email.</p>
        </div>
    `;
    const text = `Welcome to SocialWiki! Please verify your email by opening: ${verifyLink} (valid 24 hours).`;
    return queueEmail({ to: email, subject, html, text });
}

/**
 * Sends password reset email
 */
async function sendPasswordResetEmail(email, rawToken) {
    const resetLink = `${FRONTEND_URL}/reset-password?token=${rawToken}`;
    const subject = 'Reset your SocialWiki password';
    const html = `
        <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; rounded: 8px;">
            <h2 style="color: #0f172a;">Password Reset Request</h2>
            <p style="color: #334155; line-height: 1.6;">We received a request to reset your password. Click the button below to set a new password. This link is single-use and expires in 1 hour.</p>
            <div style="margin: 24px 0;">
                <a href="${resetLink}" style="background-color: #0f172a; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Reset Password</a>
            </div>
            <p style="color: #64748b; font-size: 13px;">If the button does not work, copy and paste this link into your browser:<br/><a href="${resetLink}">${resetLink}</a></p>
            <p style="color: #94a3b8; font-size: 12px; margin-top: 24px;">If you did not make this request, your account is safe and you can ignore this email.</p>
        </div>
    `;
    const text = `Password reset requested for SocialWiki. Reset your password at: ${resetLink} (valid 1 hour).`;
    return queueEmail({ to: email, subject, html, text });
}

/**
 * Sends change email verification link to new email address
 */
async function sendChangeEmailVerification(email, rawToken) {
    const verifyLink = `${FRONTEND_URL}/verify-email?token=${rawToken}&type=change-email`;
    const subject = 'Confirm your new email address for SocialWiki';
    const html = `
        <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; rounded: 8px;">
            <h2 style="color: #0f172a;">Confirm Email Address Update</h2>
            <p style="color: #334155; line-height: 1.6;">A request was made to update your SocialWiki email address to this address. Click below to confirm. This link is single-use and expires in 24 hours.</p>
            <div style="margin: 24px 0;">
                <a href="${verifyLink}" style="background-color: #0284c7; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Confirm Email Change</a>
            </div>
            <p style="color: #64748b; font-size: 13px;">If the button does not work, copy and paste this link into your browser:<br/><a href="${verifyLink}">${verifyLink}</a></p>
            <p style="color: #94a3b8; font-size: 12px; margin-top: 24px;">If you did not request this change, please contact support immediately.</p>
        </div>
    `;
    const text = `Confirm your new email for SocialWiki: ${verifyLink} (valid 24 hours).`;
    return queueEmail({ to: email, subject, html, text });
}

module.exports = {
    queueEmail,
    sendVerificationEmail,
    sendPasswordResetEmail,
    sendChangeEmailVerification
};
