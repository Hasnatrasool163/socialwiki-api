const mongoose = require('mongoose');

const addressMainSchema = new mongoose.Schema({
  postcode: { type: String, required: true, trim: true, index: true },
  district: { type: String, required: true, trim: true, index: true },
  address: { type: String, required: true, trim: true },
  dateCreated: { type: String, required: true },
  correctionVersion: { type: String, default: 'v1' },
  exceptionVersion: { type: String }
}, {
  timestamps: false,
  collection: 'address_main',
  strict: false,
  versionKey: false
});

addressMainSchema.index({ postcode: 1, address: 1 }, { background: true });
addressMainSchema.index({ address: 'text' }, { background: true });

module.exports = mongoose.model('AddressMain', addressMainSchema);
