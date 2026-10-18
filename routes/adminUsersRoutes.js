const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/authmiddleware');
const { authorizeRoles } = require('../middlewares/rolemiddleware');
const adminRecheck = require('../middlewares/adminRecheck');
const adminUsersController = require('../controllers/adminUsersController');

// All /api/admin/users/* endpoints enforce JWT verification, admin role, and 60-second database re-check
router.use(verifyToken, authorizeRoles('admin'), adminRecheck);

// 1. Tiers reference
router.get('/tiers', adminUsersController.getTiers);

// 2. Global / Per-user Usage aggregation
router.get('/usage', adminUsersController.getUsage);

// 3. Not Found Queue list, drill-down, and update
router.get('/not-found', adminUsersController.getNotFoundQueue);
router.get('/not-found/:id', adminUsersController.getNotFoundDetail);
router.patch('/not-found/:id', adminUsersController.updateNotFoundItem);

// 4. Accounts list
router.get('/', adminUsersController.listUsers);

// 5. Account detail
router.get('/:id', adminUsersController.getUserDetail);

// 6. Write Actions
router.post('/:id/approve', adminUsersController.approveUser);
router.post('/:id/reject', adminUsersController.rejectUser);
router.post('/:id/block', adminUsersController.blockUser);
router.post('/:id/unblock', adminUsersController.unblockUser);
router.post('/:id/level', adminUsersController.changeUserLevel);
router.post('/:id/reset-password', adminUsersController.resetUserPassword);
router.post('/:id/logout-sessions', adminUsersController.logoutAllSessions);

module.exports = router;
