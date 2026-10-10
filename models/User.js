const mongoose = require('mongoose');
const authConnection = require('../config/authDb');

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, trim: true },
    password: { type: String, required: true },
    role:     { type: String, enum: ['user', 'admin'], default: 'user' },

    // --- search plan / tier fields ---
    plan:                { type: String, enum: ['pending', 'free', 'trial', 'level1', 'level2', 'level2_high', 'paid', 'admin'], default: 'pending' },
    trialStartedAt:      { type: Date, default: () => new Date() },
    trialReactivatedAt:  { type: Date },
    reactivationCount:   { type: Number, default: 0 },
    searchCount:         { type: Number, default: 0 },
    searchResetDate:     { type: Date,   default: () => new Date() },
}, {
    timestamps: true,
    collection: 'users',
});

module.exports = authConnection.model('User', userSchema);