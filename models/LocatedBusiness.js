// models/LocatedBusiness.js
const mongoose = require('mongoose');

const locatedBusinessSchema = new mongoose.Schema({
  company_name: { type: String, required: true, trim: true },
  postcode:     { type: String, trim: true, uppercase: true },
  address:      { type: String, trim: true },
  address_lines: [{ type: String }],

  date_recorded: { type: Date },
  raw_date_text: { type: String },

  phone: [{
    number: { type: String },
    areaName: String
  }],

  url: { type: String, trim: true, lowercase: true },

  email: String,
  twitter: String,
  facebook: String,
  instagram: String,
  linkedin: String,
  pinterest: String,
  youtube: String,

  statusCode: String,
  redirect_url: String,
  meta_description: String,
  is_blacklisted: { type: Boolean, default: false },
  is_adult_content: { type: Boolean },

  source_types: [{ type: String }],
  merged_from_ids: [{ type: mongoose.Schema.Types.Mixed }],

}, { timestamps: true, collection: 'located_businesses', strict: false, autoIndex: false });

// NOT unique yet — stays a plain index until post-merge validation confirms the data is actually clean.
// Convert to unique only as the final hardening step below.
locatedBusinessSchema.index({ company_name: 1, postcode: 1 }, { background: true });

locatedBusinessSchema.index({ postcode: 1 }, { background: true, sparse: true });
locatedBusinessSchema.index({ url: 1 }, { background: true, sparse: true });
locatedBusinessSchema.index({ 'phone.number': 1 }, { background: true, sparse: true });
locatedBusinessSchema.index({ email: 1 }, { background: true, sparse: true });
locatedBusinessSchema.index({ is_blacklisted: 1 }, { background: true });

locatedBusinessSchema.index(
  { company_name: 'text', address: 'text', url: 'text', postcode: 'text' },
  { name: 'idx_located_search_text', background: true }
);

locatedBusinessSchema.index({ company_name: 1, postcode: 1 }, { background: true, unique: true });

const LocatedBusiness = mongoose.models.LocatedBusiness || mongoose.model('LocatedBusiness', locatedBusinessSchema);
module.exports = LocatedBusiness;
