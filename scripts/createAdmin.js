#!/usr/bin/env node

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { ROLES } = require('../utils/constants');
const { registerSchema } = require('../validations/authValidation');

// Admin credentials - get from environment variables or use defaults
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

async function createAdmin() {
    try {
        console.log('🚀 Starting admin user creation...');
        
        // Connect to MongoDB
        const mongoUri = process.env.MONGODB_URI;
        if (!mongoUri) {
            throw new Error('MONGODB_URI environment variable is not set');
        }
        
        console.log('📊 Connecting to MongoDB...');
        await mongoose.connect(mongoUri);
        console.log('✅ Connected to MongoDB successfully');

        // Validate admin data using the same schema as registration
        const adminData = {
            username: ADMIN_USERNAME,
            password: ADMIN_PASSWORD,
            role: ROLES.ADMIN
        };

        console.log('🔍 Validating admin data...');
        const validated = registerSchema.parse(adminData);
        
        // Check if admin user already exists
        console.log(`🔎 Checking if user '${validated.username}' already exists...`);
        const existingUser = await User.findOne({ username: validated.username });
        
        if (existingUser) {
            console.log(`⚠️  User '${validated.username}' already exists`);
            if (existingUser.role === ROLES.ADMIN) {
                console.log('✅ User is already an admin');
            } else {
                console.log('🔄 Updating existing user to admin role...');
                existingUser.role = ROLES.ADMIN;
                await existingUser.save();
                console.log('✅ User role updated to admin successfully');
            }
        } else {
            // Hash the password
            console.log('🔒 Hashing password...');
            const hashedPassword = await bcrypt.hash(validated.password, 10);
            
            // Create new admin user
            console.log('👤 Creating new admin user...');
            const adminUser = new User({
                username: validated.username,
                password: hashedPassword,
                role: ROLES.ADMIN,
            });
            
            await adminUser.save();
            console.log(`✅ Admin user '${validated.username}' created successfully!`);
        }
        
        console.log('\n📋 Admin User Details:');
        console.log(`   Username: ${ADMIN_USERNAME}`);
        console.log(`   Password: ${ADMIN_PASSWORD}`);
        console.log(`   Role: ${ROLES.ADMIN}`);
        console.log('\n🎉 Admin user setup completed!');
        
    } catch (err) {
        console.error('❌ Error creating admin user:');
        
        if (err.name === 'ZodError') {
            console.error('Validation errors:', err.errors);
        } else if (err.code === 11000) {
            console.error('Username already exists');
        } else {
            console.error('Error details:', err.message);
        }
        
        process.exit(1);
    } finally {
        // Close MongoDB connection
        await mongoose.connection.close();
        console.log('🔌 MongoDB connection closed');
        process.exit(0);
    }
}

// Run the script
if (require.main === module) {
    createAdmin();
}

module.exports = createAdmin;
