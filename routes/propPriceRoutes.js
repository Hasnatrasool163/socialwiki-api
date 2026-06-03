const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { PropPriceController } = require('../controllers/PropPrice.controller');
const { IMPORT_DIR } = require('../services/PropPrice.service');

const router = express.Router();

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        fs.mkdirSync(IMPORT_DIR, { recursive: true });
        cb(null, IMPORT_DIR);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        const baseName = path
            .basename(file.originalname || 'upload.csv', ext)
            .replace(/[^a-zA-Z0-9-_]/g, '_')
            .slice(0, 100);
        const timestamp = Date.now();
        cb(null, `${baseName || 'upload'}_${timestamp}${ext || '.csv'}`);
    }
});

const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        const isCsvName = (file.originalname || '').toLowerCase().endsWith('.csv');
        const isCsvMime = (file.mimetype || '').toLowerCase().includes('csv') || (file.mimetype || '') === 'text/plain';

        if (isCsvName || isCsvMime) {
            cb(null, true);
            return;
        }

        cb(new Error('Only CSV files are allowed.'));
    },
    limits: {
        files: 50,
        fileSize: 100 * 1024 * 1024
    }
});

router.get('/import-progress', PropPriceController.getImportProgress);
router.get('/stats', PropPriceController.getStats);
router.get('/import-files', PropPriceController.listImportFiles);
router.get('/paginated', PropPriceController.getPaginatedRecords);

router.post('/upload-files', (req, res, next) => {
    upload.array('files', 50)(req, res, (error) => {
        if (error) {
            return res.status(400).json({ success: false, message: error.message || 'Invalid upload request' });
        }
        return next();
    });
}, PropPriceController.uploadImportFiles);
router.post('/import', PropPriceController.startImport);
router.post('/stop-import', PropPriceController.stopImport);

module.exports = router;
