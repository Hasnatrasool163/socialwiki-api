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
const searchSessionLimiter = require('../middlewares/searchSessionLimiter');
const suggestLimiter  = require('../middlewares/suggestLimiter');
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

const guard = [verifyToken, botProtect, searchSessionLimiter];

// Deprecated customer routes (Phase 3 Section 6.1: return 410 Gone)
router.get('/rm-address', (req, res) => res.status(410).json({
    error: 'Endpoint retired. RM address data is validation only. Use /api/rm/validate.'
}));
router.get('/rm-address/suggest', (req, res) => res.status(410).json({
    error: 'Endpoint retired. Use /api/rm/postcodes.'
}));
router.get('/rm-address/street', (req, res) => res.status(410).json({
    error: 'Endpoint retired. Use /api/rm/streets and /api/rm/validate.'
}));

router.get('/prop-price',         ...guard, searchPropPrice);
router.get('/company',            ...guard, searchCompany);
router.get('/screenshot',         ...guard, searchScreenshot);
router.get('/social',             ...guard, searchSocialScrape);
router.get('/business',           ...guard, searchBusiness);
router.get('/businesses',         ...guard, searchBusiness);
router.get('/located-business',   ...guard, searchBusiness);
router.get('/websites',           ...guard, searchWebsites);
router.get('/website',            ...guard, searchWebsites);

// Usage stats — no rate-limit hit, just needs auth
router.get('/usage', verifyToken, getUsage);

module.exports = router;
