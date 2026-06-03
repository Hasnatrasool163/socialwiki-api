const express = require('express');
const router = express.Router();
const ssUrlController = require('../controllers/ssUrlController');

// BASE URL: /api/ss-url

router.post('/import', ssUrlController.importSSUrl);
router.post('/search', ssUrlController.searchSSUrls);
router.get('/count', ssUrlController.totalCount);
router.get('/drop-all', ssUrlController.dropAll);


module.exports = router;
