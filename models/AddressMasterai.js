const mongoose = require('mongoose');

const addressMasterAiSchema = new mongoose.Schema({
    postcode:          { type: String, required: true, trim: true, index: true },
    district:          { type: String, required: true, trim: true, index: true },
    address:           { type: String, required: true, trim: true },
    dateCreated:       { type: String, required: true },
    correctionVersion: { type: String, default: 'v1' },
    exceptionVersion:  { type: String },
    sourceType: {
        type: String,
        enum: ['simple_extracted', 'ai_approved', 'manual_approved'],
        default: 'simple_extracted',
        index: true
    }
}, {
    timestamps: false,
    collection: 'address_master_ai',
    strict: false,
    versionKey: false
});

addressMasterAiSchema.index({ postcode: 1, address: 1 }, { unique: true, background: true });
addressMasterAiSchema.index({ postcode: 1, _id: 1 }, { background: true });
addressMasterAiSchema.index({ district: 1, _id: 1 }, { background: true });

module.exports = mongoose.model('AddressMasterAi', addressMasterAiSchema);