const mongoose = require('mongoose');
const authConnection = require('../config/authDb');

const userIpSchema = new mongoose.Schema({
    ipAddress: { type: String, required: true, unique: true, index: true },
    ipVersion: { type: Number, enum: [4, 6], default: 4 },
    normalizedSubnet: { type: String, index: true },
    status: {
        type: String,
        enum: ['WHITELIST', 'BLACKLIST', 'UNKNOWN'],
        default: 'WHITELIST',
        index: true
    },
    reasons: [{ type: String }],
    isVpn: { type: Boolean, default: false },
    isProxy: { type: Boolean, default: false },
    isTor: { type: Boolean, default: false },
    isAbuser: { type: Boolean, default: false },
    isDatacenter: { type: Boolean, default: false },
    isManualOverride: { type: Boolean, default: false },
    checkedAt: { type: Date, default: () => new Date(), index: true },
    rawDetails: {
        asn: Number,
        org: String,
        country: String
    }
}, {
    timestamps: true,
    collection: 'user_ips'
});

// Retention TTL index: Purge records after 180 days unless refreshed
userIpSchema.index({ checkedAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

module.exports = authConnection.model('UserIP', userIpSchema);
