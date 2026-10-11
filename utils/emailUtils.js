/**
 * emailUtils.js
 *
 * Email normalization and disposable email blocklist
 */

const DISPOSABLE_DOMAINS = new Set([
    'mailinator.com', 'tempmail.com', 'temp-mail.org', '10minutemail.com',
    'guerrillamail.com', 'throwawaymail.com', 'sharklasers.com', 'getairmail.com',
    'yopmail.com', 'dispostable.com', 'trashmail.com', 'fakeinbox.com',
    'maildrop.cc', 'inboxkitten.com', 'crazymailing.com', 'burnermail.io',
    'mohmal.com', 'mytemp.email', 'tempail.com', 'generator.email'
]);

/**
 * Normalizes email address
 * - Lowercases and trims
 * - For Gmail/Googlemail: normalizes domain to gmail.com, strips dots, strips plus tags
 */
function normalizeEmail(rawEmail) {
    if (!rawEmail || typeof rawEmail !== 'string') return '';
    const clean = rawEmail.trim().toLowerCase();
    const atIndex = clean.lastIndexOf('@');
    if (atIndex === -1) return clean;

    let localPart = clean.slice(0, atIndex);
    let domainPart = clean.slice(atIndex + 1);

    // Normalize googlemail.com to gmail.com
    if (domainPart === 'googlemail.com') domainPart = 'gmail.com';

    // Gmail-specific rules: ignore dots and plus tags
    if (domainPart === 'gmail.com') {
        localPart = localPart.replace(/\./g, '');
        const plusIndex = localPart.indexOf('+');
        if (plusIndex !== -1) {
            localPart = localPart.slice(0, plusIndex);
        }
    } else {
        // Generic plus addressing
        const plusIndex = localPart.indexOf('+');
        if (plusIndex !== -1) {
            localPart = localPart.slice(0, plusIndex);
        }
    }

    return `${localPart}@${domainPart}`;
}

/**
 * Checks whether the domain is a known disposable/burner service
 */
function isDisposableEmail(email) {
    if (!email || typeof email !== 'string') return true;
    const parts = email.toLowerCase().split('@');
    if (parts.length !== 2) return true;
    const domain = parts[1].trim();
    return DISPOSABLE_DOMAINS.has(domain);
}

module.exports = {
    normalizeEmail,
    isDisposableEmail
};
