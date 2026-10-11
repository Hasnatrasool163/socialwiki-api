const mongoose = require('mongoose');
const authConnection = require('../config/authDb');

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, trim: true, lowercase: true },
    email:    { type: String, required: true, unique: true, trim: true, lowercase: true, index: true },
    password: { type: String, required: true },
    role:     { type: String, enum: ['user', 'admin'], default: 'user' },

    // --- Subscription & Entitlement Tiers ---
    level:    { type: String, enum: ['free', 'level1', 'level2', 'level2_high', 'business', 'admin'], default: 'free' },
    plan:     { type: String, enum: ['pending', 'free', 'trial', 'level1', 'level2', 'level2_high', 'paid', 'admin'], default: 'pending' },

    // --- Verification & Security Flags ---
    isVerified: { type: Boolean, default: false },
    isApproved: { type: Boolean, default: false }, // Admin approval for free accounts ('Request Access')
    isBlocked:  { type: Boolean, default: false },

    // --- Single-Use Hashed Tokens ---
    verificationTokenHash:    { type: String, index: true },
    verificationTokenExpires: { type: Date },
    resetPasswordTokenHash:   { type: String, index: true },
    resetPasswordTokenExpires:{ type: Date },
    pendingEmail:             { type: String, trim: true, lowercase: true },
    pendingEmailTokenHash:    { type: String, index: true },
    pendingEmailTokenExpires: { type: Date },

    // --- Preferences (Saved in Auth DB) ---
    savedDatabases: [{ type: String }],
    historyMode:    { type: String, enum: ['all', 'latest'], default: 'latest' },

    // --- Session & Rotation Tracking ---
    refreshTokenFamily: { type: String, index: true },

    // --- Anti-Abuse & Probation (First-week probation = 25% quota) ---
    probationUntil:     { type: Date },
    trialStartedAt:     { type: Date, default: () => new Date() },
    trialReactivatedAt: { type: Date },
    reactivationCount:  { type: Number, default: 0 },

    searchCount:     { type: Number, default: 0 },
    searchResetDate: { type: Date, default: () => new Date() },
}, {
    timestamps: true,
    collection: 'users',
});

module.exports = authConnection.model('User', userSchema);