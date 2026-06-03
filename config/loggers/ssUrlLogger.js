const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

// Ensure logs directory exists
const logsDir = path.join(__dirname, '../../logs/ssUrlLogs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Create custom format for ssUrl logs
const ssUrlFormat = winston.format.combine(
    winston.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, url, image, reason }) => {
        let logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

        if (url) logMessage += ` | URL: ${url}`;
        if (image) logMessage += ` | Image: ${image}`;
        if (reason) logMessage += ` | Reason: ${reason}`;

        return logMessage;
    })
);

const ssUrlLogger = winston.createLogger({
    level: 'info',
    format: ssUrlFormat,
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                ssUrlFormat
            )
        }),
        // Error log file (only errors)
        new winston.transports.DailyRotateFile({
            filename: path.join(logsDir, 'error-import-%DATE%.log'),
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '14d',
            level: 'error'
        })
    ]
});

module.exports = ssUrlLogger;
