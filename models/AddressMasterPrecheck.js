const mongoose = require('mongoose');

const schema = new mongoose.Schema({
    postcode:          { type: String, required: true, trim: true, index: true },
    district:          { type: String, required: true, trim: true, index: true },
    address:           { type: String, required: true, trim: true },
    dateCreated:       { type: String, required: true },
    correctionVersion: { type: String, default: 'v1' },
    exceptionVersion:  { type: String },
    sourceFile:        { type: String }
}, {
    timestamps: false,
    collection: 'address_master_precheck',
    strict: false,
    versionKey: false
});

schema.index({ postcode: 1, address: 1 }, { unique: true, background: true });
schema.index({ postcode: 1, _id: 1 }, { background: true });

module.exports = mongoose.model('AddressMasterPrecheck', schema);