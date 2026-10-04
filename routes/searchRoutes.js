/**
 * searchRoutes.js
 * BASE: /api/search
 *
 * All routes require:  verifyToken → botProtect → searchRateLimit → handler
 * (botProtect first so rapid hammer doesn't touch the DB at all)
 */

const express         = require('express');
const { LRUCache } = require('lru-cache');
const { ObjectId } = require('mongoose').Types;

const { verifyToken } = require('../middlewares/authmiddleware');
const botProtect      = require('../middlewares/botProtect');
const searchRateLimit = require('../middlewares/searchRateLimit');
const {
    searchRmAddress,
    suggestRmAddress,  
    cascadeRmAddress,
    searchPropPrice,
    searchCompany,
    searchScreenshot,
    searchSocialScrape,
    searchBusiness,
    searchWebsites,
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
router.get('/businesses',         ...guard, searchBusiness);
router.get('/located-business',   ...guard, searchBusiness);
router.get('/websites',           ...guard, searchWebsites);
router.get('/website',            ...guard, searchWebsites);

router.get('/rm-address/suggest', verifyToken, botProtect, suggestRmAddress);
router.get('/rm-address/street',  ...guard, cascadeRmAddress);

// Usage stats — no rate-limit hit, just needs auth
router.get('/usage', verifyToken, getUsage);

module.exports = router;
