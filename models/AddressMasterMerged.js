const mongoose = require('mongoose');

const addressMasterMergedSchema = new mongoose.Schema({
  postcode: { type: String, required: true, trim: true, index: true },
  district: { type: String, required: true, trim: true, index: true },
  address: { type: String, required: true, trim: true },
  dateCreated: { type: String, required: true },
  correctionVersion: { type: String, default: 'v1' },
  exceptionVersion: { type: String }
}, {
  timestamps: false,
  collection: 'address_master_merged',
  strict: false,
  versionKey: false
});

addressMasterMergedSchema.index({ postcode: 1, address: 1 }, { background: true });
addressMasterMergedSchema.index({ postcode: 1, _id: 1 }, { background: true });
addressMasterMergedSchema.index({ district: 1, _id: 1 }, { background: true });

module.exports = mongoose.model('AddressMasterMerged', addressMasterMergedSchema);
