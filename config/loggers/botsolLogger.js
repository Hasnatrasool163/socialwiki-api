const { createLogger, format, transports } = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

// Ensure logs directory exists
const logsDir = path.join(process.cwd(), 'logs/botsol');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

const botsolLogger = createLogger({
    level: 'debug',
    format: format.combine(
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`)
    ),
    transports: [
        new transports.Console({
            level: 'debug',
            format: format.combine(
                format.colorize(),
                format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                format.printf(({ timestamp, level, message }) => `[BOTSOL] ${timestamp} ${level}: ${message}`)
            )
        }),
        new DailyRotateFile({
            filename: 'botsol-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxSize: '20m',
            maxFiles: '30d', // Keep logs for 30 days
            dirname: 'logs/botsol',
            auditFile: 'logs/botsol/audit.json',
            level: 'debug'
        }),
        new DailyRotateFile({
            filename: 'botsol-error-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxSize: '20m',
            maxFiles: '30d',
            dirname: 'logs/botsol',
            auditFile: 'logs/botsol/error-audit.json',
            level: 'error'
        })
    ],
});

module.exports = botsolLogger; 