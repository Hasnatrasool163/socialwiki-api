const { createLogger, format, transports } = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

// Ensure logs directory exists
const logsDir = path.join(process.cwd(), 'logs/company_house');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

const companyHouseLogger = createLogger({
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
                format.printf(({ timestamp, level, message }) => `[COMPANY_HOUSE] ${timestamp} ${level}: ${message}`)
            )
        }),
        new DailyRotateFile({
            filename: 'company_house-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxSize: '20m',
            maxFiles: '30d', // Keep logs for 30 days
            dirname: 'logs/company_house',
            auditFile: 'logs/company_house/audit.json',
            level: 'debug'
        }),
        new DailyRotateFile({
            filename: 'company_house-error-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxSize: '20m',
            maxFiles: '30d',
            dirname: 'logs/company_house',
            auditFile: 'logs/company_house/error-audit.json',
            level: 'error'
        })
    ],
});

module.exports = companyHouseLogger;