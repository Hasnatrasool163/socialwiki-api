const mongoose = require('mongoose');
const authConnection = require('../config/authDb');

const notFoundQueueSchema = new mongoose.Schema({
    normalizedQuery: { type: String, required: true, unique: true, index: true },
    queryType: {
        type: String,
        enum: ['postcode', 'address', 'business', 'domain', 'email', 'company', 'other'],
        default: 'other',
        index: true
    },
    count: { type: Number, default: 1 },
    firstSeen: { type: Date, default: () => new Date() },
    lastSeen: { type: Date, default: () => new Date(), index: true },
    status: {
        type: String,
        enum: ['new', 'checked', 'added', 'ignored'],
        default: 'new',
        index: true
    },
    sampleUserIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    notes: { type: String }
}, {
    timestamps: true,
    collection: 'not_found_queue'
});

notFoundQueueSchema.index({ count: -1, status: 1 });

module.exports = authConnection.model('NotFoundQueue', notFoundQueueSchema);
