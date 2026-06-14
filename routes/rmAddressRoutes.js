const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { RMAddressController } = require('../controllers/RMAddress.controller');
const { IMPORT_DIR } = require('../services/RMAddress.service');

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
		const isCsvMime =
			(file.mimetype || '').toLowerCase().includes('csv') ||
			(file.mimetype || '') === 'text/plain';

		if (isCsvName || isCsvMime) return cb(null, true);

		cb(new Error('Only CSV files are allowed.'));
	},
	limits: {
		files: 50,
		fileSize: 100 * 1024 * 1024
	}
});

// BASE: /api/rm-address

router.get('/import-progress', RMAddressController.getImportProgress);
router.get('/stats', RMAddressController.getStats);
router.get('/paginated', RMAddressController.getPaginatedAddresses);
router.get('/import-files', RMAddressController.listImportFiles);

router.get('/export/preview', RMAddressController.exportPreview);
router.get('/export/status/:jobId', RMAddressController.getExportStatus);
router.get('/export/download/:jobId', RMAddressController.downloadExport);

router.post(
	'/upload-files',
	(req, res, next) => {
		upload.array('files', 50)(req, res, (error) => {
			if (error) {
				return res.status(400).json({
					success: false,
					message: error.message || 'Invalid upload request'
				});
			}
			return next();
		});
	},
	RMAddressController.uploadImportFiles
);

router.post('/export/start', RMAddressController.startExport);
router.post('/import', RMAddressController.startImport);
router.post('/stop-import', RMAddressController.stopImport);

router.post(
	'/import-csv',
	(req, res, next) => {
		upload.single('file')(req, res, (err) => {
			if (err)
				return res.status(400).json({
					success: false,
					message: err.message
				});
			return next();
		});
	},
	RMAddressController.importCsv
);

router.put('/:id', RMAddressController.editRecord);
router.post('/bulk-edit', RMAddressController.bulkEdit);

module.exports = router;