// models/CompanyHouse.js
const mongoose = require('mongoose');

const companyHouseSchema = new mongoose.Schema({
  CompanyName: { 
    type: String, 
    required: true,
    trim: true
  },
  CompanyNumber: { 
    type: String, 
    required: true,
    unique: true,
    trim: true
  },
  RegAddress: {
    AddressLine1: String,
    AddressLine2: String,
    PostTown: String,
    PostCode: String,
    County: String
  },
  CompanyStatus: String,
  IncorporationDate: String // Stored as string in d/m/Y format to match PHP implementation
}, { 
  timestamps: true, 
  collection: 'company_house', 
  strict: false 
});

// Indexes for efficient queries
// Note: CompanyNumber unique index is already defined in schema field definition

// Index on CompanyName for search functionality
companyHouseSchema.index({ CompanyName: 'text' }, { background: true });

// Index on CompanyStatus for filtering
companyHouseSchema.index({ CompanyStatus: 1 }, { background: true });

// Index on PostCode for location-based queries
companyHouseSchema.index({ 'RegAddress.PostCode': 1 }, { background: true });

// Index on timestamps for tracking
companyHouseSchema.index({ createdAt: -1 }, { background: true });

// Compound index for efficient company search with postcode
companyHouseSchema.index({ 
  CompanyName: 1, 
  'RegAddress.PostCode': 1 
}, { background: true });

// Error handling for duplicate key errors
companyHouseSchema.post('save', function (error, doc, next) {
  if (error.name === 'MongoError' && error.code === 11000) {
    next(new Error('Duplicate company number: Company already exists'));
  } else {
    next(error);
  }
});

// Pre-save middleware to clean company name
companyHouseSchema.pre('save', function(next) {
  if (this.CompanyName) {
    this.CompanyName = this.CompanyName.trim();
  }
  if (this.CompanyNumber) {
    this.CompanyNumber = this.CompanyNumber.trim();
  }
  next();
});

// Virtual for full address
companyHouseSchema.virtual('fullAddress').get(function() {
  const addressParts = [];
  if (this.RegAddress) {
    if (this.RegAddress.AddressLine1) addressParts.push(this.RegAddress.AddressLine1);
    if (this.RegAddress.AddressLine2) addressParts.push(this.RegAddress.AddressLine2);
    if (this.RegAddress.PostTown) addressParts.push(this.RegAddress.PostTown);
    if (this.RegAddress.PostCode) addressParts.push(this.RegAddress.PostCode);
  }
  return addressParts.join(', ');
});

// Ensure virtual fields are serialized
companyHouseSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('CompanyHouse', companyHouseSchema);