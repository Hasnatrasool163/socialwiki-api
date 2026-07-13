const express = require('express');
const path    = require('path');   
const fs      = require('fs');     
const router  = express.Router();
const { RMAddressAiController } = require('../controllers/RMAddressAi.controller');
const { verifyToken }    = require('../middlewares/authmiddleware');
const { authorizeRoles } = require('../middlewares/rolemiddleware');
const multer = require('multer');

router.use(verifyToken, authorizeRoles('admin'));

const pendingUploadStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '../imports/address_master_pending/');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `pending_${Date.now()}${ext}`);
    }
});

const pendingUpload = multer({
    storage: pendingUploadStorage,
    fileFilter: (req, file, cb) => {
        const ok = (file.originalname || '').toLowerCase().endsWith('.csv');
        ok ? cb(null, true) : cb(new Error('CSV only'));
    },
    limits: { fileSize: 100 * 1024 * 1024 }
});

router.post(
    '/pending/upload',
    (req, res, next) => {
        pendingUpload.single('file')(req, res, (err) => {
            if (err) return res.status(400).json({ success: false, message: err.message });
            return next();
        });
    },
    RMAddressAiController.uploadToPending
);

router.get('/jobs', RMAddressAiController.listJobs);
router.post('/job/create', RMAddressAiController.createJob);
router.get('/job/:jobId', RMAddressAiController.getJobStatus);
router.post('/job/:jobId/pause', RMAddressAiController.pauseJob);
router.post('/job/:jobId/resume', RMAddressAiController.resumeJob);
router.post('/job/:jobId/reset', RMAddressAiController.resetJob);

router.get('/job/:jobId/next-batch', RMAddressAiController.getNextBatch);
router.post('/job/:jobId/submit-results', RMAddressAiController.submitBatchResults);

router.get('/corrections', RMAddressAiController.getCorrections);
router.post('/corrections/:id/approve', RMAddressAiController.approveCorrection);
router.post('/corrections/:id/reject', RMAddressAiController.rejectCorrection);
router.post('/corrections/bulk-approve', RMAddressAiController.bulkApproveCorrections);
router.post('/corrections/bulk-reject', RMAddressAiController.bulkRejectCorrections);

router.get('/manual-review', RMAddressAiController.getManualReviewItems);
router.post('/manual-review/:id/resolve', RMAddressAiController.resolveManualReview);

router.post('/job/:jobId/stop', RMAddressAiController.stopJob);

router.post('/corrections/:id/manual-edit', RMAddressAiController.applyManualEdit);
router.post('/corrections/:id/delete-address', RMAddressAiController.deleteOriginalAddress);

router.post('/tools/fix-bracket-caps', RMAddressAiController.fixBracketCapitalization);

module.exports = router;