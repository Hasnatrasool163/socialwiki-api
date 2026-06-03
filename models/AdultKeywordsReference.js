// models/AdultKeywordsReference.js
const mongoose = require('mongoose');

const adultKeywordsReferenceSchema = new mongoose.Schema({
  url: { type: String, required: true },
  title: String,
  meta_description: String,
  keywords: String,
  matched_keywords: [String], // Array of keywords that matched
  match_type: {
    type: String,
    enum: ['exact', 'contains'],
    required: true
  },
  csv_source: String, // Source CSV file name
  processed: { type: Boolean, default: false },
  processed_at: Date,
  created_at: { type: Date, default: Date.now }
}, { timestamps: true, collection: 'adultkeywordsreferences' });

// Add indexes for better performance
adultKeywordsReferenceSchema.index({ url: 1 }, { background: true });
adultKeywordsReferenceSchema.index({ match_type: 1 }, { background: true });
adultKeywordsReferenceSchema.index({ processed: 1 }, { background: true });
adultKeywordsReferenceSchema.index({ created_at: -1 }, { background: true });

const AdultKeywordsReference = mongoose.model('AdultKeywordsReference', adultKeywordsReferenceSchema);

module.exports = AdultKeywordsReference; 