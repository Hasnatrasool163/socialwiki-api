const mongoose = require('mongoose');

const PostcodeCentroidSchema = new mongoose.Schema({
    postcode: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        uppercase: true,
        index: true
    },
    lat: {
        type: Number,
        required: true
    },
    lon: {
        type: Number,
        required: true
    },
    eastings: {
        type: Number,
        default: null
    },
    northings: {
        type: Number,
        default: null
    },
    source: {
        type: String,
        default: 'os_codepoint_open'
    }
}, {
    collection: 'postcode_centroids',
    strict: true,
    timestamps: true,
    versionKey: false
});

const PostcodeCentroid = mongoose.model('PostcodeCentroid', PostcodeCentroidSchema);

module.exports = PostcodeCentroid;
