const express = require('express');
const router = express.Router();
const { RMAddressAiController } = require('../controllers/RMAddressAi.controller');
const { verifyToken } = require('../middlewares/authmiddleware');
const { authorizeRoles } = require('../middlewares/rolemiddleware');

router.use(verifyToken, authorizeRoles('admin'));

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

module.exports = router;