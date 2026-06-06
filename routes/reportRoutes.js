const express = require('express');

const router = express.Router();
const missingPostcodeController = require('../controllers/missingPostcodeController');

router.get('/missing-postcodes', missingPostcodeController.startMissingPostcodesReport);
router.get('/missing-postcodes/status/:jobId', missingPostcodeController.getMissingPostcodesReportStatus);
router.get('/missing-postcodes/download/:jobId', missingPostcodeController.downloadMissingPostcodesReport);

module.exports = router;