const AdminAuditLog = require('../../models/AdminAuditLog');
const logger = require('../../config/logger');

/**
 * Append-only audit logger helper used by every administrative write operation.
 */
async function logAdminAction({ adminId, adminEmail, action, targetId, targetType = 'User', details = {}, ip = null }) {
    try {
        if (!adminId || !action) {
            logger.warn('[AuditLog] Missing required fields for admin audit log entry');
            return null;
        }

        const logEntry = await AdminAuditLog.create({
            adminId,
            adminEmail: adminEmail || 'unknown',
            action,
            targetId,
            targetType,
            details,
            ip
        });

        logger.info(`[AdminAudit] ${adminEmail} performed ${action} on ${targetType}:${targetId || 'N/A'}`);
        return logEntry;
    } catch (err) {
        logger.error(`[AuditLog Error] Failed to write audit log: ${err.message}`);
        return null;
    }
}

module.exports = {
    logAdminAction
};
