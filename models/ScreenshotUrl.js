const mongoose = require('mongoose');



// Define the schema for the ScreenshotUrl collection
const screenshotUrlSchema = new mongoose.Schema({
    url: { type: String, required: true },
    image: { type: String, required: true },
    is_blacklisted: { type: Boolean, default: false },
    is_adult_content: { type: Boolean, default: false }
}, {
    versionKey: false,
    strict: false,
    autoIndex: false
});

screenshotUrlSchema.index({ url: 1, image: 1 }, { unique: true, background: true, name: 'url_1_image_1' });
screenshotUrlSchema.index({ is_blacklisted: 1 }, { background: true });

module.exports = mongoose.model('screenshot_url', screenshotUrlSchema);