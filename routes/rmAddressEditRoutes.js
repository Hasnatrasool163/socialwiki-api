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
    limits: { fileSize: 550 * 1024 * 1024 }
});

const memoryUpload = multer({
    storage: multer.memoryStorage(),
    fileFilter: (req, file, cb) => {
        const name = (file.originalname || '').toLowerCase();
        if (name.endsWith('.csv') || name.endsWith('.txt')) return cb(null, true);
        cb(new Error('Only .csv or .txt files are allowed.'));
    },
    limits: { fileSize: 10 * 1024 * 1024 } 
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

router.post(
    '/parse-postcodes',
    (req, res, next) => {
        memoryUpload.single('file')(req, res, (error) => {
            if (error) return res.status(400).json({ success: false, message: error.message });
            return next();
        });
    },
    RMAddressEditController.parsePostcodeFile
);

module.exports = router;