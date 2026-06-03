const { createLogger, format, transports } = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

const logsDir = path.join(process.cwd(), 'logs/rm_address');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

const rmAddressLogger = createLogger({
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
                format.printf(({ timestamp, level, message }) => `[RM_ADDRESS] ${timestamp} ${level}: ${message}`)
            )
        }),
        new DailyRotateFile({
            filename: 'rm_address-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxSize: '20m',
            maxFiles: '30d',
            dirname: 'logs/rm_address',
            auditFile: 'logs/rm_address/audit.json',
            level: 'debug'
        }),
        new DailyRotateFile({
            filename: 'rm_address-error-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxSize: '20m',
            maxFiles: '30d',
            dirname: 'logs/rm_address',
            auditFile: 'logs/rm_address/error-audit.json',
            level: 'error'
        })
    ],
});

module.exports = rmAddressLogger;
