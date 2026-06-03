require('dotenv').config();
const app = require('./app');
const connectDB = require('./config/db');
const logger = require('./config/logger');

const PORT = process.env.PORT || 5000;

// Security headers
app.disable('x-powered-by');

const startServer = async () => {
    try {
        logger.info('Starting server initialization...');
        logger.info(`Environment: ${process.env.NODE_ENV}`);
        logger.info(`MongoDB URI configured: ${process.env.MONGODB_URI ? 'Yes' : 'No'}`);
        
        await connectDB();

        const server = app.listen(PORT, () => {
            logger.info(`Server running on port ${PORT}`);
        });

        // Handle server errors
        server.on('error', (error) => {
            logger.error(`Server error: ${error}`);
            process.exit(1);
        });

        // Graceful shutdown
        process.on('SIGTERM', () => {
            logger.info('SIGTERM received. Shutting down gracefully');
            server.close(() => {
                logger.info('Process terminated');
                process.exit(0);
            });
        });

        // Global error handlers
        process.on('unhandledRejection', (reason, promise) => {
            logger.error(`Unhandled Rejection: ${reason}`);
            logger.error('Promise:', promise);
            // Don't exit the process, just log the error
        });

        process.on('uncaughtException', (error) => {
            logger.error(`Uncaught Exception: ${error}`);
            logger.error('Stack:', error.stack);
            // Don't exit the process, just log the error
        });

    } catch (error) {
        logger.error(`Failed to start server: ${error.message}`);
        logger.error('Error details:', error);
        process.exit(1);
    }
};

startServer();
