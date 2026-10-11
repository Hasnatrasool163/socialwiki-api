const { z } = require('zod');

const registerSchema = z.object({
    email: z.string().email('Please enter a valid email address'),
    username: z.string().min(3).optional(),
    password: z.string().min(8, 'Password must be at least 8 characters long'),
    turnstileToken: z.string().optional()
});

const loginSchema = z.object({
    username: z.string().min(1, 'Email or username is required'),
    password: z.string().min(1, 'Password is required'),
    turnstileToken: z.string().optional()
});

const verifyEmailSchema = z.object({
    token: z.string().min(32, 'Invalid verification token format')
});

const resendVerificationSchema = z.object({
    email: z.string().email('Please enter a valid email address'),
    turnstileToken: z.string().optional()
});

const requestPasswordResetSchema = z.object({
    email: z.string().email('Please enter a valid email address'),
    turnstileToken: z.string().optional()
});

const confirmPasswordResetSchema = z.object({
    token: z.string().min(32, 'Invalid reset token format'),
    newPassword: z.string().min(8, 'Password must be at least 8 characters long')
});

const requestChangeEmailSchema = z.object({
    newEmail: z.string().email('Please enter a valid new email address'),
    currentPassword: z.string().min(1, 'Current password is required')
});

const confirmChangeEmailSchema = z.object({
    token: z.string().min(32, 'Invalid verification token format')
});

const updatePreferencesSchema = z.object({
    savedDatabases: z.array(z.string()).optional(),
    historyMode: z.enum(['all', 'latest']).optional()
});

module.exports = {
    registerSchema,
    loginSchema,
    verifyEmailSchema,
    resendVerificationSchema,
    requestPasswordResetSchema,
    confirmPasswordResetSchema,
    requestChangeEmailSchema,
    confirmChangeEmailSchema,
    updatePreferencesSchema
};
