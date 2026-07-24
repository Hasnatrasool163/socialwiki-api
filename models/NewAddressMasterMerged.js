const mongoose = require('mongoose');

const newAddressMasterMergedSchema = new mongoose.Schema({
  postcode: { type: String, required: true, trim: true, index: true },
  district: { type: String, required: true, trim: true, index: true },
  address: { type: String, required: true, trim: true },
  dateCreated: { type: String, required: true },
  correctionVersion: { type: String, default: 'v1' },
  exceptionVersion: { type: String }
}, {
  timestamps: false,
  collection: 'new_address_master_merged', 
  strict: false,
  versionKey: false
});

newAddressMasterMergedSchema.index({ postcode: 1, district: 1, address: 1 }, { unique: true, background: true });

newAddressMasterMergedSchema.index({ postcode: 1, address: 1 }, { background: true });

newAddressMasterMergedSchema.index({ district: 1, background: true });
newAddressMasterMergedSchema.index({ postcode: 1, background: true });
newAddressMasterMergedSchema.index({ postcode: 1, _id: 1 }, { background: true });
newAddressMasterMergedSchema.index({ district: 1, _id: 1 }, { background: true });

module.exports = mongoose.model('NewAddressMasterMerged', newAddressMasterMergedSchema);