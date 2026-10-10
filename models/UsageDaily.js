const mongoose = require('mongoose');
const authConnection = require('../config/authDb');

const usageDailySchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    date: { type: String, required: true, index: true }, // Format: YYYY-MM-DD
    plan: { type: String, required: true },
    searchCount: { type: Number, default: 0 },
    sessionCount: { type: Number, default: 0 },
    rowCount: { type: Number, default: 0 },
    distinctPostcodes: [{ type: String }],
    distinctRecords: [{ type: String }],
}, {
    timestamps: true,
    collection: 'usage_daily'
});

usageDailySchema.index({ userId: 1, date: 1 }, { unique: true });

module.exports = authConnection.model('UsageDaily', usageDailySchema);
