const express = require('express');
const router  = express.Router();
const { RMAddressCheckedController } = require('../controllers/RMAddressChecked.controller');
const { verifyToken }    = require('../middlewares/authmiddleware');
const { authorizeRoles } = require('../middlewares/rolemiddleware');

router.use(verifyToken, authorizeRoles('admin'));

router.get('/search',            RMAddressCheckedController.searchBlock);
router.delete('/record/:id',     RMAddressCheckedController.deleteRecordAndRecycle);

module.exports = router;