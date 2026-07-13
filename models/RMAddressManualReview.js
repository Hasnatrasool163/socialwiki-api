const mongoose = require('mongoose');

const RMAddressManualReviewSchema = new mongoose.Schema({
    jobId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    originalId: { type: mongoose.Schema.Types.ObjectId, required: true },
    postcode: { type: String },
    district: { type: String },
    address: { type: String },        
    dateCreated: { type: String },
    correctionVersion: { type: String },
    exceptionVersion: { type: String },
    aiOriginalFormatted: { type: String },   
    aiSuggestedAddress: { type: String },    
    reason: { type: String },
    status: {
        type: String,
        enum: ['pending', 'restored', 'applied', 'deleted_permanently'],
        default: 'pending',
        index: true
    },
    sourceCollection: {
    type: String,
        enum: ['address_master_merged', 'address_master_pending'],
        default: 'address_master_merged'
    },
    removedFromMain: { type: Boolean, default: false },
    batchNumber: { type: Number }
}, {
    collection: 'rm_address_manual_review',
    timestamps: true
});

module.exports = mongoose.model('RMAddressManualReview', RMAddressManualReviewSchema);