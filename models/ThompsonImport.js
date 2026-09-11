// models/ThompsonImport.js
const mongoose = require('mongoose');

const thompsonImportSchema = new mongoose.Schema({
  company_name: { type: String, required: true }, // F2
  postcode: { type: String },                       // F1
  address_lines: [{ type: String }],                 // F3, F4, F5 — variable count, stored in order, empty strings filtered out at import time
  raw_date_text: { type: String },                    // F6 as-is
  date: { type: Date },                               // populate only once the year ambiguity from raw_date_text is resolved
  phone: [{
    number: { type: String },
    areaName: String
  }],                                                  // F7
  url: { type: String },                               // trailing unlabeled column — present on roughly half the rows, per sample
  source_type: { type: String, default: 'thompson_import_2026' },
  is_blacklisted: { type: Boolean, default: false },

}, { timestamps: true, collection: 'thompson_import', strict: false, autoIndex: false });

// Non-unique indexes only, for now — no unique constraint until dedup strategy is decided,
thompsonImportSchema.index({ postcode: 1 }, { background: true, sparse: true });
thompsonImportSchema.index({ company_name: 1 }, { background: true });
thompsonImportSchema.index({ company_name: 1, postcode: 1 }, { background: true });
thompsonImportSchema.index({ url: 1 }, { background: true, sparse: true });
thompsonImportSchema.index({ 'phone.number': 1 }, { background: true, sparse: true });
thompsonImportSchema.index({ is_blacklisted: 1 }, { background: true });

const ThompsonImport = mongoose.models.ThompsonImport || mongoose.model('ThompsonImport', thompsonImportSchema);

module.exports = ThompsonImport;