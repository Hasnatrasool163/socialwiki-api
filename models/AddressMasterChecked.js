const mongoose = require('mongoose');

const schema = new mongoose.Schema({
    postcode:          { type: String, required: true, trim: true, index: true },
    district:          { type: String, required: true, trim: true, index: true },
    address:           { type: String, required: true, trim: true },
    dateCreated:       { type: String, required: true },
    correctionVersion: { type: String, default: 'v1' },
    exceptionVersion:  { type: String },
    sourceType: {
        type: String,
        enum: ['simple_extracted', 'precheck_ok', 'precheck_swapped', 'ai_approved'],
        default: 'simple_extracted',
        index: true
    }
}, {
    timestamps: false,
    collection: 'address_master_checked',
    strict: false,
    versionKey: false
});

schema.index({ postcode: 1, address: 1 }, { unique: true, background: true });
schema.index({ postcode: 1, _id: 1 }, { background: true });

module.exports = mongoose.model('AddressMasterChecked', schema);