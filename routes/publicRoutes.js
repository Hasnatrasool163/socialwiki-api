const express = require('express');
const { SocialScrapeController } = require('../controllers/SocialScrape.controller');
const router = express.Router();

// Public routes that don't require authentication
router.get('/progress', (req, res) => {
    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    // Call the controller
    SocialScrapeController.getImportProgress(req, res);
});

module.exports = router; 