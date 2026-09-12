// models/WebsitePostcode.js
const mongoose = require('mongoose');

const websitePostcodeSchema = new mongoose.Schema({
  url:      { type: String, trim: true, lowercase: true },
  postcode: { type: String, trim: true, uppercase: true },
  date:     { type: String, trim: true }
}, {
  collection: 'website_postcode',
  strict: false,
  versionKey: false,
  autoIndex: false
});

// Sparse / Compound B-Tree indexes matching existing collection indexes
websitePostcodeSchema.index({ postcode: 1 }, { background: true });
websitePostcodeSchema.index({ url: 1, postcode: 1, date: 1 }, { unique: true, background: true });

module.exports = mongoose.models.WebsitePostcode || mongoose.model('WebsitePostcode', websitePostcodeSchema);
