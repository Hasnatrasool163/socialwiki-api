const { createLogger, format, transports } = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

const logger = createLogger({
    level: 'debug', // Changed to debug to capture all log levels
    format: format.combine(
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`)
    ),
    transports: [
        new transports.Console({
            level: 'debug' // Ensure console shows all levels
        }),
        new DailyRotateFile({
            filename: 'logs/app/app-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxSize: '20m',
            maxFiles: '14d',
            dirname: 'logs/app',
            auditFile: 'logs/app/audit.json',
            level: 'debug' // Ensure file logger shows all levels
        }),
        new DailyRotateFile({ // Add separate transport for errors
            filename: 'logs/app/error-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxSize: '20m',
            maxFiles: '14d',
            dirname: 'logs/app',
            auditFile: 'logs/app/error-audit.json',
            level: 'error' // Only log errors in this file
        })
    ],
});

module.exports = logger;




// OLD CODE
// const { createLogger, format, transports } = require('winston');
// const DailyRotateFile = require('winston-daily-rotate-file');

// const logger = createLogger({
//     level: 'debug', // Changed to debug to capture all log levels
//     format: format.combine(
//         format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
//         format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`)
//     ),
//     transports: [
//         new transports.Console({
//             level: 'debug' // Ensure console shows all levels
//         }),
//         new DailyRotateFile({
//             filename: 'logs/app-%DATE%.log',
//             datePattern: 'YYYY-MM-DD',
//             maxSize: '20m', 
//             maxFiles: '14d',
//             dirname: 'logs',
//             level: 'debug' // Ensure file logger shows all levels
//         }),
//         new DailyRotateFile({ // Add separate transport for errors
//             filename: 'logs/error-%DATE%.log',
//             datePattern: 'YYYY-MM-DD',
//             maxSize: '20m',
//             maxFiles: '14d',
//             dirname: 'logs',
//             level: 'error' // Only log errors in this file
//         })
//     ],
// });

// module.exports = logger;
