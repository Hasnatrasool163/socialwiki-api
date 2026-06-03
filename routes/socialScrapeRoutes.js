const express = require('express');
const { SocialScrapeController } = require('../controllers/SocialScrape.controller');
const router = express.Router();

// BASE URL: /api/social-scrape

// Public routes (no auth required)
router.get('/import-progress', SocialScrapeController.getImportProgress);
router.get('/blacklist-progress', SocialScrapeController.getBlacklistProgress);
router.get('/phone-progress', SocialScrapeController.getPhoneProgress);
router.get('/blacklisted/count', SocialScrapeController.getBlacklistedCount);

// Protected routes (auth required)
router.post('/import', SocialScrapeController.startImport);
router.post('/stop-import', SocialScrapeController.stopImport);

router.post('/update-blacklist', SocialScrapeController.updateBlacklist);

router.post('/update-phone-number', SocialScrapeController.updatePhoneNumber);
router.post('/stop-phone-processing', SocialScrapeController.stopPhoneProcessing);

router.get('/stats', SocialScrapeController.getStats);
router.get('/paginated', SocialScrapeController.getPaginatedSocialScrapes);

module.exports = router;