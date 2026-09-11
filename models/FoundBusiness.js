// models/FoundBusiness.js
const mongoose = require('mongoose');

const foundBusinessSchema = new mongoose.Schema({
  title:    { type: String, trim: true },
  postcode: { type: String, trim: true, uppercase: true },
  address:  { type: String, trim: true },
  phone:    { type: String, trim: true },
  url:      { type: String, trim: true, lowercase: true },
  date:     { type: String, trim: true }
}, {
  collection: 'found_business_corrected',
  strict: false,
  versionKey: false,
  autoIndex: false
});

// Sparse B-Tree indexes for lightning-fast prefix & exact lookups
foundBusinessSchema.index({ postcode: 1 }, { background: true });
foundBusinessSchema.index({ title: 1 }, { background: true });
foundBusinessSchema.index({ phone: 1 }, { background: true });
foundBusinessSchema.index({ url: 1 }, { background: true });

// Unified multi-field text search index for free-text fallback
foundBusinessSchema.index(
  { title: 'text', address: 'text', url: 'text', postcode: 'text' },
  { name: 'idx_business_search_text', background: true }
);

module.exports = mongoose.models.FoundBusiness || mongoose.model('FoundBusiness', foundBusinessSchema);
