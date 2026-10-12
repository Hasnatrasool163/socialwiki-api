const mongoose = require('mongoose');
const authConnection = require('../config/authDb');

const adminAuditLogSchema = new mongoose.Schema({
    adminId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    adminEmail: {
        type: String,
        required: true,
        trim: true,
        lowercase: true,
        index: true
    },
    action: {
        type: String,
        required: true,
        index: true
    },
    targetId: {
        type: mongoose.Schema.Types.ObjectId,
        index: true
    },
    targetType: {
        type: String,
        enum: ['User', 'NotFoundQueue', 'System'],
        default: 'User',
        index: true
    },
    details: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    ip: {
        type: String
    }
}, {
    timestamps: { createdAt: true, updatedAt: false }, // append-only
    collection: 'admin_audit_log'
});

adminAuditLogSchema.index({ createdAt: -1 });
adminAuditLogSchema.index({ action: 1, createdAt: -1 });
adminAuditLogSchema.index({ targetId: 1, createdAt: -1 });
adminAuditLogSchema.index({ adminId: 1, createdAt: -1 });

module.exports = authConnection.model('AdminAuditLog', adminAuditLogSchema);
