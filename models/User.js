const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, trim: true },
    password: { type: String, required: true },
    role:     { type: String, enum: ['user', 'admin'], default: 'user' },

    // --- search plan / rate-limit fields ---
    plan:            { type: String, enum: ['free', 'paid', 'admin'], default: 'free' },
    searchCount:     { type: Number, default: 0 },
    searchResetDate: { type: Date,   default: () => new Date() },
}, {
    timestamps: true,
    collection: 'users',       // web_postalwiki.users
});

module.exports = mongoose.model('User', userSchema);