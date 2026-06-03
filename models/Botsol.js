// models/Botsol.js
const mongoose = require('mongoose');

const botsolSchema = new mongoose.Schema({
  company_name: { type: String },
  url: { type: String}, // Remove unique constraint
  date: { type: Date, required: true },
  title: String,
  twitter: String,
  postcode: String,
  email: String,
  phone: [{
    number: { type: String, required: true },
    areaName: String
  }],
  address: String,
  facebook: String,
  youtube: String,
  instagram: String,
  linkedin: String,
  pinterest: String,
  statusCode: String,
  redirect_url: String,
  meta_description: String,
  is_blacklisted: { type: Boolean, default: false },

}, { timestamps: true, collection: 'botsol', strict: false });

// Add compound index on company_name + postcode for fast lookups
botsolSchema.index({ company_name: 1, postcode: 1 }, { background: true });

// Add index on date for sorting
botsolSchema.index({ date: -1 }, { background: true });

// Add index on phone.number for fast search
botsolSchema.index({ 'phone.number': 1 }, { background: true });

// Add text index for fast URL search
botsolSchema.index({ url: 'text' }, { background: true });

// Add index on company_name for search
botsolSchema.index({ company_name: 'text' }, { background: true });

// Add error handling for duplicate key errors
botsolSchema.post('save', function (error, doc, next) {
  if (error.name === 'MongoError' && error.code === 11000) {
    next(new Error('Duplicate key error'));
  } else {
    next(error);
  }
});

const Botsol = mongoose.model('Botsol', botsolSchema);

module.exports = Botsol;