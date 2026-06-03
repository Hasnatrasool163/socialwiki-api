const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { registerSchema, loginSchema } = require('../validations/authValidation');
const { ROLES } = require('../utils/constants');



exports.register = async (req, res) => {
    try {
        const validated = registerSchema.parse(req.body);
        const existingUser = await User.findOne({ username: validated.username });
        if (existingUser) return res.status(400).json({ message: 'Username already exists' });

        const hashedPassword = await bcrypt.hash(validated.password, 10);
        const user = new User({
            username: validated.username,
            password: hashedPassword,
            role: ROLES.USER,
        });
        await user.save();
        res.status(201).json({ message: 'User registered successfully' });
    } catch (err) {
        if (err.name === 'ZodError') {
            return res.status(400).json({ errors: err.errors });
        }
        res.status(500).json({ message: err.message });
    }
};

exports.login = async (req, res) => {
    try {

        const validated = loginSchema.parse(req.body);
        
        const user = await User.findOne({ username: validated.username });
        if (!user) return res.status(400).json({ message: 'Invalid credentials' });

        const isMatch = await bcrypt.compare(validated.password, user.password);
        
        if (!isMatch) return res.status(400).json({ message: 'Invalid credentials' });

        const token = jwt.sign(
            { id: user?._id, role: user?.role },
            process.env.JWT_SECRET,
            { expiresIn: '1d' }
        );
        res.json({
            token, user: {
                id: user._id,
                username: user.username,
                role: user.role,
                email: user.username,
            }
        });
    } catch (err) {
        if (err.name === 'ZodError') {
            return res.status(400).json({ errors: err.errors });
        }
        res.status(500).json({ message: err.message });
    }
};


exports.me = async (req, res) => {
    //   get user from database
    try {
        const user = await User.findById(req.user.id).select('-password');
        res.json({
            status: 1,
            message: 'Current user info retrieved successfully',
            user: {
                id: user._id,
                username: user.username,
                role: user.role,
                email: user.username,
            },
        });
    } catch (error) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
};

