const mongoose = require('mongoose');
const SocialScrape = require('../models/SocialScrape');
const connectDB = require('../config/db');
const logger = require('../config/logger');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
require('dotenv').config();

const MAX_CHAR_LIMIT = 400;
const BATCH_SIZE = 5000; // Increased batch size for better performance
const LOG_BATCH_SIZE = 100; // Log every 100 batches to reduce I/O

// Create a dedicated logger for this script
const scriptLogger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`)
    ),
    transports: [
        new winston.transports.Console(),
        new DailyRotateFile({
            filename: 'logs/trim-fields-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxSize: '20m',
            maxFiles: '14d',
            dirname: 'logs'
        })
    ],
});

function trimField(fieldValue, maxLength) {
    if (!fieldValue || typeof fieldValue !== 'string') {
        return fieldValue;
    }
    
    if (fieldValue.length <= maxLength) {
        return fieldValue;
    }
    
    return fieldValue.substring(0, maxLength);
}

function processBatch(batch) {
    const updates = [];
    const updatedUrls = [];
    
    for (const record of batch) {
        const originalTitle = record.title;
        const originalKeywords = record.keywords;
        const originalMetaDescription = record.meta_description;
        
        const trimmedTitle = trimField(originalTitle, MAX_CHAR_LIMIT);
        const trimmedKeywords = trimField(originalKeywords, MAX_CHAR_LIMIT);
        const trimmedMetaDescription = trimField(originalMetaDescription, MAX_CHAR_LIMIT);
        
        // Check if any field needs trimming
        if (trimmedTitle !== originalTitle || 
            trimmedKeywords !== originalKeywords || 
            trimmedMetaDescription !== originalMetaDescription) {
            
            updates.push({
                updateOne: {
                    filter: { _id: record._id },
                    update: {
                        $set: {
                            title: trimmedTitle,
                            keywords: trimmedKeywords,
                            meta_description: trimmedMetaDescription
                        }
                    }
                }
            });
            
            updatedUrls.push(record.url);
        }
    }
    
    return { updates, updatedUrls };
}

function formatTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours}h ${minutes}m ${secs}s`;
}

function formatNumber(num) {
    return num.toLocaleString();
}

async function trimFields() {
    const startTime = Date.now();
    
    try {
        scriptLogger.info('=== OPTIMIZED FIELD TRIMMING SCRIPT STARTED ===');
        scriptLogger.info(`Target fields: title, keywords, meta_description`);
        scriptLogger.info(`Maximum character limit: ${MAX_CHAR_LIMIT}`);
        scriptLogger.info(`Batch size: ${BATCH_SIZE.toLocaleString()}`);
        scriptLogger.info(`Server specs: 2-core CPU, 4GB RAM`);
        
        // Connect to database
        await connectDB();
        scriptLogger.info('Connected to MongoDB successfully');
        
        // Get total count
        const totalCount = await SocialScrape.countDocuments();
        scriptLogger.info(`Total records in collection: ${formatNumber(totalCount)}`);
        
        const totalBatches = Math.ceil(totalCount / BATCH_SIZE);
        scriptLogger.info(`Total batches to process: ${formatNumber(totalBatches)}`);
        
        let processedCount = 0;
        let updatedCount = 0;
        let batchNumber = 0;
        let lastLogTime = Date.now();
        
        // Process in batches
        while (processedCount < totalCount) {
            batchNumber++;
            const batchStartTime = Date.now();
            
            // Fetch batch with optimized query
            const batch = await SocialScrape.find({})
                .select('_id url title keywords meta_description')
                .skip(processedCount)
                .limit(BATCH_SIZE)
                .lean()
                .maxTimeMS(30000); // 30 second timeout
            
            if (batch.length === 0) {
                break;
            }
            
            // Process batch
            const { updates, updatedUrls } = processBatch(batch);
            
            // Update database if needed
            if (updates.length > 0) {
                await SocialScrape.bulkWrite(updates, { ordered: false });
                updatedCount += updates.length;
                
                // Log URLs in chunks to reduce I/O
                if (batchNumber % LOG_BATCH_SIZE === 0) {
                    for (const url of updatedUrls) {
                        scriptLogger.info(`Updated record with URL: ${url}`);
                    }
                }
            }
            
            processedCount += batch.length;
            const batchEndTime = Date.now();
            const batchDuration = batchEndTime - batchStartTime;
            
            // Calculate progress and ETA
            const progress = (processedCount / totalCount) * 100;
            const elapsedTime = (Date.now() - startTime) / 1000;
            const avgTimePerBatch = elapsedTime / batchNumber;
            const remainingBatches = totalBatches - batchNumber;
            const estimatedTimeRemaining = remainingBatches * avgTimePerBatch;
            
            // Log progress every 10 batches or every 30 seconds
            if (batchNumber % 10 === 0 || (Date.now() - lastLogTime) > 30000) {
                scriptLogger.info(`Batch ${formatNumber(batchNumber)}/${formatNumber(totalBatches)} completed`);
                scriptLogger.info(`Progress: ${progress.toFixed(2)}% (${formatNumber(processedCount)}/${formatNumber(totalCount)})`);
                scriptLogger.info(`Batch duration: ${batchDuration}ms, Records updated: ${updates.length}`);
                scriptLogger.info(`Total updated so far: ${formatNumber(updatedCount)}`);
                scriptLogger.info(`Avg time per batch: ${avgTimePerBatch.toFixed(2)}s`);
                scriptLogger.info(`ETA: ${formatTime(estimatedTimeRemaining)}`);
                scriptLogger.info(`Elapsed time: ${formatTime(elapsedTime)}`);
                scriptLogger.info('---');
                
                lastLogTime = Date.now();
            }
        }
        
        const totalTime = (Date.now() - startTime) / 1000;
        
        scriptLogger.info('=== SCRIPT COMPLETED ===');
        scriptLogger.info(`Total records processed: ${formatNumber(processedCount)}`);
        scriptLogger.info(`Total records updated: ${formatNumber(updatedCount)}`);
        scriptLogger.info(`Percentage updated: ${((updatedCount/processedCount)*100).toFixed(2)}%`);
        scriptLogger.info(`Total execution time: ${formatTime(totalTime)}`);
        scriptLogger.info(`Average processing speed: ${(processedCount/totalTime).toFixed(0)} records/second`);
        
    } catch (error) {
        scriptLogger.error(`Script failed: ${error.message}`);
        scriptLogger.error(error.stack);
        process.exit(1);
    } finally {
        // Close database connection
        if (mongoose.connection.readyState === 1) {
            await mongoose.connection.close();
            scriptLogger.info('Database connection closed');
        }
        process.exit(0);
    }
}

// Run the script
trimFields(); 