/**
 * searchRoutes.js
 * BASE: /api/search
 *
 * All routes require:  verifyToken → botProtect → searchRateLimit → handler
 * (botProtect first so rapid hammer doesn't touch the DB at all)
 */

const express         = require('express');
const { verifyToken } = require('../middlewares/authmiddleware');
const botProtect      = require('../middlewares/botProtect');
const searchRateLimit = require('../middlewares/searchRateLimit');
const {
    searchRmAddress,
    searchPropPrice,
    searchCompany,
    searchScreenshot,
    searchSocialScrape,
    searchBusiness,
    searchWebsites,
    searchThompson,
    getUsage,
} = require('../controllers/SearchController');

const router = express.Router();

const guard = [verifyToken, botProtect, searchRateLimit];

router.get('/rm-address',         ...guard, searchRmAddress);
router.get('/prop-price',         ...guard, searchPropPrice);
router.get('/company',            ...guard, searchCompany);
router.get('/screenshot',         ...guard, searchScreenshot);
router.get('/social',             ...guard, searchSocialScrape);
router.get('/business',           ...guard, searchBusiness);
router.get('/websites',           ...guard, searchWebsites);
router.get('/website',            ...guard, searchWebsites);
router.get('/thompson',           ...guard, searchThompson);
router.get('/thompson-directory', ...guard, searchThompson);

// Usage stats — no rate-limit hit, just needs auth
router.get('/usage', verifyToken, getUsage);

module.exports = router;
