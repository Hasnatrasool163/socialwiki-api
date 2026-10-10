const mongoose = require('mongoose');
const logger = require('./logger');

// Dedicated connection for Authentication Database (web_postalwiki_auth)
// Keeps user credentials and password hashes strictly isolated from search/data collections.
const authUri = process.env.MONGODB_AUTH_URI || process.env.MONGODB_URI?.replace(/\/([^/?]+)(\?.*)?$/, '/web_postalwiki_auth$2') || 'mongodb://127.0.0.1:27017/web_postalwiki_auth';

const authConnection = mongoose.createConnection(authUri, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    bufferCommands: false,
    maxPoolSize: 10,
    retryWrites: true,
    w: 'majority',
    autoIndex: false,
});

authConnection.on('connected', () => {
    logger.info(`Auth DB connected successfully to: ${authConnection.name || 'web_postalwiki_auth'}`);
});

authConnection.on('error', (err) => {
    logger.error(`Auth DB connection error: ${err.message}`);
});

module.exports = authConnection;
