const mongoose = require('mongoose');

const RMAddressEditJobSchema = new mongoose.Schema({
    jobType: {
        type: String,
        enum: ['export', 'reimport'],
        required: true
    },
    linkedJobId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'RMAddressEditJob',
        default: null
    },
    status: {
        type: String,
        enum: ['pending', 'running', 'completed', 'failed', 'aborted'],
        default: 'pending'
    },
    searchPostcode: { type: String, default: '' },
    searchDistrict: { type: String, default: '' },
    searchAddress: { type: String, default: '' },
    searchDate: { type: String, default: '' },  
    exportedCount: { type: Number, default: 0 },
    deletedCount: { type: Number, default: 0 },
    reimportedCount: { type: Number, default: 0 },
    reimportSkippedCount: { type: Number, default: 0 },
    fileName: { type: String, default: '' },
    filePath: { type: String, default: '' },
    error: { type: String, default: '' },
    completedAt: { type: Date, default: null }
}, {
    collection: 'rm_address_edit_jobs',
    timestamps: true
});

module.exports = mongoose.model('RMAddressEditJob', RMAddressEditJobSchema);