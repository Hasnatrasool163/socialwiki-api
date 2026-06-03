const mongoose = require('mongoose');

const PostcodeImportJobSchema = new mongoose.Schema({
    jobType: {
        type: String,
        enum: ['import', 'check'],
        default: 'import'
    },
    status: {
        type: String,
        enum: ['pending', 'processing', 'completed', 'stopped', 'failed'],
        default: 'pending'
    },
    stage: {
        type: String,
        default: 'queued'
    },
    inputFileName: {
        type: String,
        default: ''
    },
    totalProcessed: {
        type: Number,
        default: 0
    },
    inputCount: {
        type: Number,
        default: 0
    },
    uniqueCount: {
        type: Number,
        default: 0
    },
    foundCount: {
        type: Number,
        default: 0
    },
    missingCount: {
        type: Number,
        default: 0
    },
    insertedCount: {
        type: Number,
        default: 0
    },
    errorCount: {
        type: Number,
        default: 0
    },
    stopRequested: {
        type: Boolean,
        default: false
    },
    resultFileName: {
        type: String,
        default: ''
    },
    resultFilePath: {
        type: String,
        default: ''
    },
    sampleMissingPostcodes: [{
        type: String
    }],
    errorLogs: [{
        type: String
    }],
    completedAt: {
        type: Date,
        default: null
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 86400 // Auto-delete after 24 hours
    }
}, {
    collection: 'postcode_import_jobs',
    timestamps: true
});

const PostcodeImportJob = mongoose.model('PostcodeImportJob', PostcodeImportJobSchema);

module.exports = PostcodeImportJob;
