const { z } = require('zod');

const registerSchema = z.object({
    username: z.string().min(3),
    password: z.string().min(6),
    role: z.enum(['user', 'admin']).optional(),
});

const loginSchema = z.object({
    username: z.string(),
    password: z.string(),
});

module.exports = { registerSchema, loginSchema };
