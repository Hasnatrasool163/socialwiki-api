const { createLogger, format, transports } = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

const logsDir = path.join(process.cwd(), 'logs/prop_price');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

const propPriceLogger = createLogger({
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
                format.printf(({ timestamp, level, message }) => `[PROP_PRICE] ${timestamp} ${level}: ${message}`)
            )
        }),
        new DailyRotateFile({
            filename: 'prop_price-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxSize: '20m',
            maxFiles: '30d',
            dirname: 'logs/prop_price',
            auditFile: 'logs/prop_price/audit.json',
            level: 'debug'
        }),
        new DailyRotateFile({
            filename: 'prop_price-error-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxSize: '20m',
            maxFiles: '30d',
            dirname: 'logs/prop_price',
            auditFile: 'logs/prop_price/error-audit.json',
            level: 'error'
        })
    ],
});

module.exports = propPriceLogger;
