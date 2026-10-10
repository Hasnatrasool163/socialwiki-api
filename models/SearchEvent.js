const mongoose = require('mongoose');
const authConnection = require('../config/authDb');

const searchEventSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    time: { type: Date, default: () => new Date(), index: true },
    normalizedQuery: { type: String, required: true, index: true },
    queryType: {
        type: String,
        enum: ['postcode', 'address', 'business', 'domain', 'email', 'company', 'other'],
        default: 'other'
    },
    datasetsSearched: [{ type: String }],
    resultCountPerDataset: { type: Map, of: Number, default: {} },
    totalResults: { type: Number, default: 0 },
    found: { type: Boolean, default: false },
    searchSessionId: { type: String, index: true },
    ip: { type: String },
    userAgent: { type: String },
}, {
    timestamps: true,
    collection: 'search_events'
});

// TTL index to automatically purge raw search events after 90 days (adjustable)
searchEventSchema.index({ time: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = authConnection.model('SearchEvent', searchEventSchema);
