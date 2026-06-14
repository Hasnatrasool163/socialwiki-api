const mongoose = require('mongoose');

const schema = new mongoose.Schema({}, { strict: false, collection: 'address_master_merged_test' });
module.exports = mongoose.models.AddressMasterMergedTest || 
                 mongoose.model('AddressMasterMergedTest', schema);
