const express = require('express');

const router = express.Router();
const missingPostcodeController = require('../controllers/missingPostcodeController');

router.get('/missing-postcodes', missingPostcodeController.downloadMissingPostcodesReport);

module.exports = router;