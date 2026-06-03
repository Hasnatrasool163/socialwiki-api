// config/loggers/adultKeywordsLogger.js
const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Ensure logs directory exists
const logsDir = path.join(__dirname, '../../logs/adult-keywords');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Create custom format for adult keywords logs
const adultKeywordsFormat = winston.format.combine(
    winston.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, url, keyword, matchType, action, ...meta }) => {
        let logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
        
        // Add URL if present
        if (url) {
            logMessage += ` | URL: ${url}`;
        }
        
        // Add keyword if present
        if (keyword) {
            logMessage += ` | Keyword: ${keyword}`;
        }
        
        // Add match type if present
        if (matchType) {
            logMessage += ` | Match Type: ${matchType}`;
        }
        
        // Add action if present
        if (action) {
            logMessage += ` | Action: ${action}`;
        }
        
        // Add any additional metadata
        if (Object.keys(meta).length > 0) {
            logMessage += ` | Meta: ${JSON.stringify(meta)}`;
        }
        
        return logMessage;
    })
);

// Create the adult keywords logger
const adultKeywordsLogger = winston.createLogger({
    level: process.env.ADULT_KEYWORDS_LOG_LEVEL || 'info',
    format: adultKeywordsFormat,
    transports: [
        // Console transport
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                adultKeywordsFormat
            )
        }),
        
        // Main log file (all levels except error)
        new winston.transports.File({
            filename: path.join(logsDir, 'adult-keywords.log'),
            level: 'info',
            maxsize: 50 * 1024 * 1024, // 50MB
            maxFiles: 10, // Keep 10 files
            tailable: true,
            // Auto-delete files older than 10 days
            options: {
                flags: 'a'
            }
        }),
        
        // Main log file (all levels except error)
        new winston.transports.File({
            filename: path.join(logsDir, 'adult-keywords-debug.log'),
            level: 'debug',
            maxsize: 50 * 1024 * 1024, // 50MB
            maxFiles: 10, // Keep 10 files
            tailable: true,
            // Auto-delete files older than 10 days
            options: {
                flags: 'a'
            }
        }),
        
        // Error log file (only errors)
        new winston.transports.File({
            filename: path.join(logsDir, 'error-adult-keywords.log'),
            level: 'error',
            maxsize: 50 * 1024 * 1024, // 50MB
            maxFiles: 10, // Keep 10 files
            tailable: true,
            // Auto-delete files older than 10 days
            options: {
                flags: 'a'
            }
        })
    ]
});

// Add stream for Morgan HTTP logging if needed
adultKeywordsLogger.stream = {
    write: (message) => {
        adultKeywordsLogger.info(message.trim());
    }
};

// Clean up old log files (older than 10 days)
const cleanupOldLogs = () => {
    try {
        const files = fs.readdirSync(logsDir);
        const now = new Date();
        const tenDaysAgo = new Date(now.getTime() - (10 * 24 * 60 * 60 * 1000));
        
        files.forEach(file => {
            if (file.startsWith('adult-keywords') || file.startsWith('error-adult-keywords')) {
                const filePath = path.join(logsDir, file);
                const stats = fs.statSync(filePath);
                
                if (stats.mtime < tenDaysAgo) {
                    fs.unlinkSync(filePath);
                    console.log(`Deleted old log file: ${file}`);
                }
            }
        });
    } catch (error) {
        console.error('Error cleaning up old log files:', error);
    }
};

// Run cleanup every day
setInterval(cleanupOldLogs, 24 * 60 * 60 * 1000);

// Run initial cleanup
cleanupOldLogs();

module.exports = adultKeywordsLogger; 