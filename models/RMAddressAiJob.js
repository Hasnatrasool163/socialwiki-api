const mongoose = require('mongoose');

const RMAddressAiJobSchema = new mongoose.Schema({
    jobName: { type: String, required: true },
    status: {
    type: String,
    enum: ['running', 'paused', 'stopped', 'completed'],
    default: 'running'
    },
    lastProcessedId: { type: mongoose.Schema.Types.ObjectId, default: null },
    lastPostcode: { type: String, default: '' },
    totalFetched: { type: Number, default: 0 },
    totalBatchesComplete: { type: Number, default: 0 },
    totalCorrections: { type: Number, default: 0 },
    totalManualReview: { type: Number, default: 0 },
    totalClean: { type: Number, default: 0 },
    stopRequested: { type: Boolean, default: false },
    sourceCollection: {
        type: String,
         enum: [
        'address_master_merged',
        'address_master_pending',
        'address_master_precheck',
        'address_master_ai_queue'
    ],
    default: 'address_master_ai_queue'
},
}, {
    collection: 'rm_address_ai_jobs',
    timestamps: true
});

module.exports = mongoose.model('RMAddressAiJob', RMAddressAiJobSchema);