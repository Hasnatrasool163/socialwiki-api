const mongoose = require('mongoose');

const RMAddressAiCorrectionSchema = new mongoose.Schema({
    jobId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    originalId: { type: mongoose.Schema.Types.ObjectId, required: true },
    postcode: { type: String, index: true },
    originalAddress: { type: String },   
    correctedAddress: { type: String },  
    correctionType: { type: String, index: true },
    confidence: {
        type: String,
        enum: ['high', 'medium', 'low'],
        default: 'high'
    },
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected', 'manually_edited', 'deleted'],
        default: 'pending',
        index: true
    },
    batchNumber: { type: Number }
}, {
    collection: 'rm_address_ai_corrections',
    timestamps: true
});

module.exports = mongoose.model('RMAddressAiCorrection', RMAddressAiCorrectionSchema);