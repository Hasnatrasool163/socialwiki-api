const mongoose = require('mongoose');

const RMAddressAiJobSchema = new mongoose.Schema({
    jobName: { type: String, required: true },
    status: {
        type: String,
        enum: ['running', 'paused', 'completed'],
        default: 'running'
    },
    lastProcessedId: { type: mongoose.Schema.Types.ObjectId, default: null },
    lastPostcode: { type: String, default: '' },
    totalFetched: { type: Number, default: 0 },
    totalBatchesComplete: { type: Number, default: 0 },
    totalCorrections: { type: Number, default: 0 },
    totalManualReview: { type: Number, default: 0 },
    totalClean: { type: Number, default: 0 }
}, {
    collection: 'rm_address_ai_jobs',
    timestamps: true
});

module.exports = mongoose.model('RMAddressAiJob', RMAddressAiJobSchema);