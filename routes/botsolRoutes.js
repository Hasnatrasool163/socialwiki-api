const express = require('express');
const { BotsolController } = require('../controllers/botsolController');
const router = express.Router();

// BASE URL: /api/botsol

// Public routes (no auth required)
router.get('/import-progress', BotsolController.getImportProgress);

// Protected routes (auth required)
router.post('/import', BotsolController.startImport);
router.post('/stop-import', BotsolController.stopImport);

router.get('/stats', BotsolController.getStats);
router.get('/paginated', BotsolController.getPaginatedBotsols);

module.exports = router;