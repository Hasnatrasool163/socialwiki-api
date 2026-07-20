const mongoose = require('mongoose');

const schema = new mongoose.Schema({
    jobId:        { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    batchNumber:  { type: Number, required: true },
    originalId:   { type: mongoose.Schema.Types.ObjectId, required: true },
    postcode:     { type: String, required: true, trim: true, index: true },
    district:     { type: String, required: true, trim: true },
    address:      { type: String, required: true, trim: true },
    dateCreated:  { type: String },
    correctionVersion: { type: String, default: 'v1' },
    recordStatus: {
        type: String,
        enum: ['clean', 'pending_correction', 'pending_manual_review', 'resolved'],
        default: 'clean',
        index: true
    }
}, {
    timestamps: false,
    collection: 'address_master_ai_temp',
    strict: false,
    versionKey: false
});

schema.index({ jobId: 1, batchNumber: 1 });
schema.index({ originalId: 1 }, { unique: true });

module.exports = mongoose.model('AddressMasterAiTemp', schema);