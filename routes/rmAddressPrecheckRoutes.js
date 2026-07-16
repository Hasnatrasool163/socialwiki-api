const express = require('express');
const router  = express.Router();
const { RMAddressPrecheckController } = require('../controllers/RMAddressPrecheck.controller');
const { verifyToken }    = require('../middlewares/authmiddleware');
const { authorizeRoles } = require('../middlewares/rolemiddleware');

router.use(verifyToken, authorizeRoles('admin'));

router.get('/stats',                            RMAddressPrecheckController.getStats);
router.get('/next-block',                       RMAddressPrecheckController.getNextBlock);
router.post('/block/:postcode/approve',         RMAddressPrecheckController.approveBlock);
router.post('/block/:postcode/move-to-ai',      RMAddressPrecheckController.moveBlockToAi);
router.post('/block/:postcode/swap',            RMAddressPrecheckController.swapColumns);

module.exports = router;