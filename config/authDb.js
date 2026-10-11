const mongoose = require('mongoose');
const logger = require('./logger');

// Dedicated connection for Authentication Database (web_postalwiki_auth)
// Keeps user credentials and password hashes strictly isolated from search/data collections.
let authConnection;

if (process.env.MONGODB_AUTH_URI) {
    authConnection = mongoose.createConnection(process.env.MONGODB_AUTH_URI, {
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
        maxPoolSize: 10,
        retryWrites: true,
        w: 'majority',
    });

    authConnection.on('connected', () => {
        logger.info(`Auth DB connected successfully to: ${authConnection.name || 'web_postalwiki_auth'}`);
    });

    authConnection.on('error', (err) => {
        logger.error(`Auth DB connection error: ${err.message}`);
    });
} else {
    logger.info('[authDb] MONGODB_AUTH_URI not provided; falling back to primary Mongoose connection.');
    authConnection = mongoose;
}

module.exports = authConnection;
