/**
 * rmValidationRoutes.js
 * BASE: /api/rm
 *
 * Implements Phase 3: Address Validation & Business Find routes.
 * Guarded with JWT verification and bot protection.
 */

const express = require('express');
const { verifyToken } = require('../middlewares/authmiddleware');
const botProtect = require('../middlewares/botProtect');
const suggestLimiter = require('../middlewares/suggestLimiter');
const {
    getPostcodes,
    getStreets,
    validateAddress,
    locateAddress,
    findBusiness,
    getAreas,
    nominatimSearch,
    nominatimReverse
} = require('../controllers/rmValidationController');

const router = express.Router();

const guard = [verifyToken, botProtect];

// Residential validation flow: Validate Post Code & Street Name
router.get('/postcodes', ...guard, suggestLimiter, getPostcodes);
router.get('/streets',   ...guard, getStreets);
router.post('/validate', ...guard, validateAddress);
router.post('/locate',   ...guard, locateAddress);

// Business find flow: Find a business address
router.get('/business',  ...guard, findBusiness);
router.get('/areas',     ...guard, suggestLimiter, getAreas);

// Self-hosted UK Nominatim direct search & reverse lookup
router.get('/nominatim-search',  ...guard, nominatimSearch);
router.get('/nominatim-reverse', ...guard, nominatimReverse);

module.exports = router;
