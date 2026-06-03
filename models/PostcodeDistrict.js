const mongoose = require('mongoose');

const PostcodeDistrictSchema = new mongoose.Schema({
    postcode: {
        type: String,
        required: true,
        unique: true, // Matches existing unique index 'postcode_1'
        trim: true
    },
    district: {
        type: String,
        required: true,
        trim: true,
        index: true // Matches existing index 'district_1'
    }
}, {
    collection: 'postcode_district', // FORCE existing collection name
    strict: true, // Only allow defined fields
    timestamps: false, // Use true if you want to start adding createdAt/updatedAt
    versionKey: false // Disable __v field to match existing data
});

// Create model
const PostcodeDistrict = mongoose.model('PostcodeDistrict', PostcodeDistrictSchema);

module.exports = PostcodeDistrict;
