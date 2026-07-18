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
        enum: ['address_master_merged', 'address_master_pending', 'address_master_precheck', 'address_master_ai_queue'],
        default: 'address_master_ai_queue'
    },
    removedFromMain: { type: Boolean, default: false },
    batchNumber: { type: Number }
}, {
    collection: 'rm_address_manual_review',
    timestamps: true
});
RMAddressManualReviewSchema.index({ jobId: 1, originalId: 1 }, { unique: true })


module.exports = mongoose.model('RMAddressManualReview', RMAddressManualReviewSchema);