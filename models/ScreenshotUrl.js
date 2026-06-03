const mongoose = require('mongoose');



// Define the schema for the ScreenshotUrl collection
const screenshotUrlSchema = new mongoose.Schema({
    url: { type: String, required: true },
    image: { type: String, required: true }
}, {
    versionKey: false
});

screenshotUrlSchema.index({ url: 1, image: 1 }, { unique: true, background: true, name: 'url_1_image_1' });

module.exports = mongoose.model('screenshot_url', screenshotUrlSchema);