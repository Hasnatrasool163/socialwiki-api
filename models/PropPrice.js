const mongoose = require('mongoose');

const propPriceSchema = new mongoose.Schema({
  unique_id: { type: String, required: true, unique: true, trim: true, index: true },
  price_paid: { type: Number, required: true, index: true },
  deed_date: { type: Date, required: true, index: true },
  postcode: { type: String, required: true, trim: true, index: true },
  property_type: { type: String, trim: true },
  new_build: { type: String, trim: true },
  estate_type: { type: String, trim: true },
  saon: { type: String, trim: true },
  paon: { type: String, trim: true },
  street: { type: String, trim: true },
  locality: { type: String, trim: true },
  town: { type: String, trim: true },
  district: { type: String, trim: true, index: true },
  county: { type: String, trim: true },
  transaction_category: { type: String, trim: true },
  linked_data_uri: { type: String, trim: true },
  address_display: { type: String, trim: true, index: true }
}, {
  timestamps: false,
  collection: 'prop_price',
  strict: false,
  versionKey: false
});

propPriceSchema.index({ postcode: 1, address_display: 1, deed_date: -1, _id: 1 }, { background: true });
propPriceSchema.index({ postcode: 1, deed_date: -1 }, { background: true });

module.exports = mongoose.model('PropPrice', propPriceSchema);
