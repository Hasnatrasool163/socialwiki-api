const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { RMAddressEditController } = require('../controllers/RMAddressEdit.controller');
const { EDIT_IMPORT_DIR } = require('../services/RMAddressEdit.service');

const router = express.Router();

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        fs.mkdirSync(EDIT_IMPORT_DIR, { recursive: true });
        cb(null, EDIT_IMPORT_DIR);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        const baseName = path.basename(file.originalname || 'reimport.csv', ext)
            .replace(/[^a-zA-Z0-9-_]/g, '_')
            .slice(0, 100);
        cb(null, `${baseName || 'reimport'}_${Date.now()}${ext || '.csv'}`);
    }
});

const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        const isCsvName = (file.originalname || '').toLowerCase().endsWith('.csv');
        const isCsvMime = (file.mimetype || '').toLowerCase().includes('csv') || (file.mimetype || '') === 'text/plain';
        if (isCsvName || isCsvMime) return cb(null, true);
        cb(new Error('Only CSV files are allowed.'));
    },
    limits: { fileSize: 200 * 1024 * 1024 }
});


router.post('/preview', RMAddressEditController.previewSearch);
router.post('/export', RMAddressEditController.confirmExport);
router.get('/status/:jobId', RMAddressEditController.getJobStatus);
router.get('/download/:jobId', RMAddressEditController.downloadExportCsv);

router.post(
    '/reimport',
    (req, res, next) => {
        upload.single('file')(req, res, (error) => {
            if (error) {
                return res.status(400).json({ success: false, message: error.message || 'Invalid upload request' });
            }
            return next();
        });
    },
    RMAddressEditController.reimportCsv
);

module.exports = router;