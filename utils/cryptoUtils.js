/**
 * cryptoUtils.js
 *
 * Password hashing with argon2id (with bcrypt backward compatibility)
 * Single-use secure token generation and SHA-256 hashing
 */

const argon2 = require('argon2');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

/**
 * Hash a password using argon2id
 */
async function hashPassword(plainPassword) {
    return argon2.hash(plainPassword, {
        type: argon2.argon2id,
        memoryCost: 2 ** 16, // 64 MB
        timeCost: 3,         // 3 iterations
        parallelism: 1
    });
}

/**
 * Verify password against hash. Supports automatic legacy bcrypt migration.
 */
async function verifyPassword(plainPassword, storedHash) {
    if (!plainPassword || !storedHash) return { isValid: false, needsRehash: false };

    // Check for legacy bcrypt hash
    if (storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$') || storedHash.startsWith('$2y$')) {
        const isBcryptMatch = await bcrypt.compare(plainPassword, storedHash);
        return { isValid: isBcryptMatch, needsRehash: isBcryptMatch };
    }

    try {
        const isArgonMatch = await argon2.verify(storedHash, plainPassword);
        return { isValid: isArgonMatch, needsRehash: false };
    } catch (_) {
        return { isValid: false, needsRehash: false };
    }
}

/**
 * Generates a cryptographically strong random token
 */
function generateSecureToken() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * Generates a SHA-256 hash of a token for secure database storage
 */
function hashToken(rawToken) {
    if (!rawToken) return null;
    return crypto.createHash('sha256').update(rawToken).digest('hex');
}

module.exports = {
    hashPassword,
    verifyPassword,
    generateSecureToken,
    hashToken
};
