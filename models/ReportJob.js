const mongoose = require('mongoose');

const ReportJobSchema = new mongoose.Schema({
    jobId: { type: String, required: true, unique: true, index: true },
    status: { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' },
    stage: { type: String, default: 'queued' },
    progress: { type: Number, default: 0 },
    totalRows: { type: Number, default: 0 },
    processedRows: { type: Number, default: 0 },
    missingCount: { type: Number, default: 0 },
    fileName: String,
    filePath: String,
    downloadUrl: String,
    startedAt: { type: String },
    completedAt: { type: String, default: null },
    error: { type: String, default: null }
}, {
    collection: 'report_jobs',
    timestamps: true
});

// Auto-expire job records 24h after creation so this collection doesn't grow forever
ReportJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 });

module.exports = mongoose.model('ReportJob', ReportJobSchema);
