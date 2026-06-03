const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { verifyToken } = require('../middlewares/authmiddleware');
const { authorizeRoles } = require('../middlewares/rolemiddleware');

router.post('/register', authController.register);
router.post('/login', authController.login);

// Get current user info
router.get('/me', verifyToken, authController.me);

// ✅ protected route example
router.get('/profile', verifyToken, (req, res) => {
    res.json({ message: 'Welcome to your profile', user: req.user });
});


module.exports = router;
