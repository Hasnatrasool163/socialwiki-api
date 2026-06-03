const mongoose = require('mongoose');
const logger = require('./logger.js');

const connectDB = async () => {
    try {
        // Check if MONGO_URI is defined
        const uri = process.env.MONGODB_URI;
        if (!uri) {
            throw new Error('MONGODB_URI environment variable is not set. Please check your .env file.');
        }

        // Log connection details (without sensitive info)
        const dbName = uri.split('/').pop().split('?')[0];
        const authSource = uri.includes('authSource=') 
            ? uri.split('authSource=')[1].split('&')[0] 
            : 'admin';
        
        logger.info(`Connecting to MongoDB database: ${dbName}`);
        logger.info(`Authentication database: ${authSource}`);

        // Add connection options for better error handling
        const options = {
            serverSelectionTimeoutMS: 10000, // 10 second timeout
            socketTimeoutMS: 45000, // 45 second socket timeout
            bufferCommands: false,
            maxPoolSize: 10,
            retryWrites: true,
            w: 'majority',
        };

        // Connect with timeout
        await mongoose.connect(process.env.MONGODB_URI, options);
        
        // Log successful connection details
        logger.info('MongoDB connected successfully');
        logger.info(`Connected to database: ${mongoose.connection.db.databaseName}`);
        logger.info(`Connection host: ${mongoose.connection.host}`);
        
    } catch (err) {
        logger.error(`MongoDB connection error: ${err.message}`);
        logger.error('Connection error details:', JSON.stringify(err));
        logger.error('Stack trace:', err.stack);
        
        // Don't exit immediately, let PM2 handle restart
        throw err;
    }
};

module.exports = connectDB;
