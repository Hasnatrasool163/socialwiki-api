// services/SocialScrapeService.js
const csv = require('csv-parse');
const fs = require('fs');
const path = require('path');
// const { EventEmitter } = require('events');
const SocialScrape = require('../models/SocialScrape');
const socialScrapeLogger = require('../config/socialScrapeLogger');
const { isValidDomain } = require('../utils/helpers');
const { archiveFile } = require('../utils/fileUtils');
const areaCodes = require('../utils/areaCodes');

// Reduced batch size and parallel processing for 4GB RAM, 2-core VPS
const BATCH_SIZE = 2000; // Reduced from 50000 to 1000 for better reliability
const PARALLEL_BATCHES = 2; // Reduced to match CPU cores
const IMPORT_DIR = path.join(__dirname, '../imports/social_scrape/');
const BLACKLIST_DIR = path.join(__dirname, '../imports/social_scrape_blacklisted/');
const PHONE_DIR = path.join(__dirname, '../imports/social_scrape_phone/');

// // Create separate event emitters for each process
// const importEventEmitter = new EventEmitter();
// const blacklistEventEmitter = new EventEmitter();
// const phoneEventEmitter = new EventEmitter();

// Separate progress trackers for each process
const importProgressTracker = {
    currentFile: null,
    processed: 0,
    total: 0,
    upserted: 0,
    modified: 0,
    errors: [],
    isComplete: false,
    isRunning: false
};

// Store for blacklist progress trackers
const blacklistProgressStore = new Map();

// Store for phone progress trackers
const phoneProgressStore = new Map();

// Utility Functions
const ensureImportDirectory = async () => {
    try {
        await fs.promises.mkdir(IMPORT_DIR, { recursive: true });
    } catch (error) {
        socialScrapeLogger.error('Error creating import directory:', error);
        throw new Error('Failed to create import directory');
    }
};

const resetImportProgress = () => {
    importProgressTracker.currentFile = null;
    importProgressTracker.processed = 0;
    importProgressTracker.total = 0;
    importProgressTracker.upserted = 0;
    importProgressTracker.modified = 0;
    importProgressTracker.errors = [];
    importProgressTracker.isComplete = false;
    importProgressTracker.isRunning = false;
    socialScrapeLogger.info('Reset import progress tracker');
};

const setImportRunning = (running) => {
    importProgressTracker.isRunning = running;
    socialScrapeLogger.info(`Set import running status to: ${running}`);
};

const moveCompletedFile = async (filePath) => {
    try {
        const filename = path.basename(filePath);
        const today = new Date().toISOString().split('T')[0];
        const completedDir = path.join(IMPORT_DIR, `completed_${today}`);

        // Create completed directory if it doesn't exist
        await fs.promises.mkdir(completedDir, { recursive: true });

        // Move the file with retry logic for EBUSY errors
        const newPath = path.join(completedDir, filename);
        await fs.promises.rename(filePath, newPath);

        socialScrapeLogger.info(`Moved file ${filename} to completed directory`);
    } catch (error) {
        socialScrapeLogger.error(`Failed to move file: ${error.message}`);
        throw error;
    }
};

// Ensure indexes exist for better performance
const ensureIndexes = async () => {
    try {
        // Create compound unique index on URL + date
        await SocialScrape.collection.createIndex({ url: 1, date: 1 }, { unique: true, background: true });

        socialScrapeLogger.info('Indexes created successfully');
    } catch (error) {
        socialScrapeLogger.error('Error creating indexes:', error);
    }
};

// Process batches in parallel with memory management
const processBatchesInParallel = async (batches, filename, processed) => {
    try {
        // Process batches sequentially to avoid memory pressure
        let results = { upserted: 0, modified: 0 };

        for (const batch of batches) {
            const result = await insertBatch(batch, filename, processed, null);
            results.upserted += result.upserted;
            results.modified += result.modified;

            // Add a small delay between batches to allow memory cleanup
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        return results;
    } catch (error) {
        socialScrapeLogger.error('Error processing batches:', error);
        throw error;
    }
};

const insertBatch = async (batch, filename, processed, total) => {
    try {
        // Group records by URL + date combination to handle duplicates properly
        const urlDateGroups = new Map();

        for (const doc of batch) {
            const key = `${doc.url}_${doc.date.toISOString().split('T')[0]}`; // Use date without time for grouping
            if (!urlDateGroups.has(key)) {
                urlDateGroups.set(key, []);
            }
            urlDateGroups.get(key).push(doc);
        }

        // Create operations for each unique URL + date combination
        const operations = [];
        for (const [key, docs] of urlDateGroups) {
            // Merge all records for the same URL + date combination
            const mergedDoc = mergeRecordsForSameUrlDate(docs);

            operations.push({
                updateOne: {
                    filter: { url: mergedDoc.url, date: mergedDoc.date },
                    update: { $set: mergedDoc },
                    upsert: true
                }
            });
        }

        // socialScrapeLogger.info(`Attempting to insert batch of ${operations.length} unique URL+date combinations (from ${batch.length} total records)`);

        // Modified MongoDB settings for better reliability
        const result = await SocialScrape.bulkWrite(operations, {
            ordered: false, // Changed to false to continue on individual errors
            writeConcern: { w: 1 }, // Changed to 1 to ensure write acknowledgment
            bypassDocumentValidation: true
        });

        // socialScrapeLogger.info(`Batch insert result - Upserted: ${result.upsertedCount}, Modified: ${result.modifiedCount}`);

        importProgressTracker.upserted += result.upsertedCount;
        importProgressTracker.modified += result.modifiedCount;
        importProgressTracker.processed = processed;

        return {
            success: true,
            upserted: result.upsertedCount,
            modified: result.modifiedCount
        };
    } catch (error) {
        // Handle duplicate key errors gracefully
        if (error.code === 11000) {
            socialScrapeLogger.warn(`Duplicate key error in batch (continuing): ${error.message}`);

            // Try to insert records one by one to handle duplicates
            let upserted = 0;
            let modified = 0;

            for (const [key, docs] of urlDateGroups) {
                try {
                    const mergedDoc = mergeRecordsForSameUrlDate(docs);

                    const result = await SocialScrape.updateOne(
                        { url: mergedDoc.url, date: mergedDoc.date },
                        { $set: mergedDoc },
                        { upsert: true }
                    );

                    if (result.upsertedCount > 0) upserted++;
                    if (result.modifiedCount > 0) modified++;

                } catch (individualError) {
                    socialScrapeLogger.warn(`Failed to insert URL+date combination ${key}: ${individualError.message}`);
                    importProgressTracker.errors.push({
                        filename,
                        error: `Failed to insert URL+date combination ${key}: ${individualError.message}`
                    });
                }
            }

            importProgressTracker.upserted += upserted;
            importProgressTracker.modified += modified;
            importProgressTracker.processed = processed;

            return {
                success: true,
                upserted: upserted,
                modified: modified
            };
        }

        socialScrapeLogger.error(`Error in insertBatch: ${error.message}`);
        socialScrapeLogger.error(`Error details: ${JSON.stringify(error)}`);
        importProgressTracker.errors.push({
            filename,
            error: error.message
        });
        throw error;
    }
};

// Helper function to merge multiple records for the same URL + date combination
const mergeRecordsForSameUrlDate = (docs) => {
    if (docs.length === 1) {
        return docs[0];
    }

    // Merge multiple records for the same URL + date
    const mergedDoc = {
        url: docs[0].url,
        date: docs[0].date,
        title: '',
        twitter: '',
        facebook: '',
        instagram: '',
        linkedin: '',
        youtube: '',
        pinterest: '',
        email: '',
        phone: [],
        postcode: '',
        statusCode: '',
        redirect_url: '',
        meta_description: ''
    };

    // Merge all fields from all records, taking the first non-empty value
    for (const doc of docs) {
        if (doc.title && !mergedDoc.title) mergedDoc.title = doc.title;
        if (doc.twitter && !mergedDoc.twitter) mergedDoc.twitter = doc.twitter;
        if (doc.facebook && !mergedDoc.facebook) mergedDoc.facebook = doc.facebook;
        if (doc.instagram && !mergedDoc.instagram) mergedDoc.instagram = doc.instagram;
        if (doc.linkedin && !mergedDoc.linkedin) mergedDoc.linkedin = doc.linkedin;
        if (doc.youtube && !mergedDoc.youtube) mergedDoc.youtube = doc.youtube;
        if (doc.pinterest && !mergedDoc.pinterest) mergedDoc.pinterest = doc.pinterest;
        if (doc.email && !mergedDoc.email) mergedDoc.email = doc.email;
        if (doc.postcode && !mergedDoc.postcode) mergedDoc.postcode = doc.postcode;
        if (doc.statusCode && !mergedDoc.statusCode) mergedDoc.statusCode = doc.statusCode;
        if (doc.redirect_url && !mergedDoc.redirect_url) mergedDoc.redirect_url = doc.redirect_url;
        if (doc.meta_description && !mergedDoc.meta_description) mergedDoc.meta_description = doc.meta_description;

        // Merge phone arrays
        if (doc.phone && Array.isArray(doc.phone)) {
            mergedDoc.phone = [...new Set([...mergedDoc.phone, ...doc.phone])];
        }
    }

    return mergedDoc;
};

const processRecord = (record) => {
    try {
        const trimUrl = (url) => {
            if (!url) return '';
            return url
                .replace(/^(https?:\/\/)/i, '')
                .replace(/^www\./i, '')
                .replace(/^([^/]+).*?$/, '$1');
        };



        const cleanSocialUrl = (url) => {
            if (!url) return '';
            // Remove everything after ? in URLs
            return url.replace(/^(https?:\/\/)/i, '')
                .replace(/^www\./i, '').split('?')[0];
        };

        const cleanText = (text) => {
            if (!text) return '';
            // Remove control characters and extra spaces
            return text.replace(/[\x00-\x1F\x7F-\x9F]/g, '')
                .replace(/\s+/g, ' ')
                .trim()
                .substring(0, 400);
        };

        // Get the URL from the first column
        const url = Object.values(record)[0];

        // Skip if URL is not a valid domain
        if (!isValidDomain(url)) {
            socialScrapeLogger.debug(`Skipping invalid domain: ${url}`);
            return null;
        }

        // Skip records with error or no data
        if (record.RESULT === 'Fetch error or no data found' || record.RESULT === 'not required') {
            // If we only have URL and no other data, skip this record
            const hasOtherData = Object.entries(record).some(([key, value]) =>
                key !== 'RESULT' && value && value.trim() !== ''
            );
            if (!hasOtherData) {
                socialScrapeLogger.debug(`Skipping record with no data for URL: ${url}`);
                return null;
            }
        }

        // Process the record based on CODE
        const processedRecord = {
            url: trimUrl(url),
            date: new Date(record.DATE?.split('/').reverse().join('-')),
        };

        switch (record.CODE) {
            case '[TI]':
                processedRecord.title = cleanText(record.RESULT);
                break;
            case '[SC]':
            case '[ER]':
                processedRecord.statusCode = record.RESULT;
                break;
            case '[PC]':
                processedRecord.postcode = cleanText(record.RESULT);
                break;
            case '[EM]':
                processedRecord.email = cleanText(record.RESULT);
                break;
            case '[TW]':
                processedRecord.twitter = cleanSocialUrl(record.RESULT);
                break;
            case '[FB]':
                processedRecord.facebook = cleanSocialUrl(record.RESULT);
                break;
            case '[LK]':
                processedRecord.linkedin = cleanSocialUrl(record.RESULT);
                break;
            case '[PT]':
                processedRecord.pinterest = cleanSocialUrl(record.RESULT);
                break;
            case '[YT]':
                processedRecord.youtube = cleanSocialUrl(record.RESULT);
                break;
            case '[IS]':
                processedRecord.instagram = cleanSocialUrl(record.RESULT);
                break;
            case '[RD]':
                processedRecord.redirect_url = cleanSocialUrl(record.RESULT);
                break;
            case '[MD]':
                processedRecord.meta_description = cleanText(record.RESULT);
                break;
        }

        // socialScrapeLogger.debug(`Processed record for URL: ${processedRecord.url}`);
        return processedRecord;
    } catch (error) {
        socialScrapeLogger.error(`Error processing record: ${error.message}`);
        socialScrapeLogger.error(`Record data: ${JSON.stringify(record)}`);
        return null;
    }
};

const processFile = async (filePath) => {
    const filename = path.basename(filePath);
    let processed = 0;
    let batches = [];
    let currentBatch = [];


    let skippedLines = 0;

    // Reset progress for new file
    importProgressTracker.currentFile = filename;
    importProgressTracker.processed = 0;
    importProgressTracker.total = 0;
    importProgressTracker.upserted = 0;
    importProgressTracker.modified = 0;
    importProgressTracker.errors = [];
    importProgressTracker.isComplete = false;

    // Ensure indexes exist
    // await ensureIndexes();

    return new Promise((resolve, reject) => {
        const parser = csv.parse({
            columns: true,
            skip_empty_lines: true,
            relax_column_count: true,
            relax_quotes: true, // Be more flexible with quotes
            // skip_records_with_error: true, // Skip records with parsing errors
            highWaterMark: 1024 * 1024 // 1MB chunks
        });

        parser.on('readable', async () => {
            let record;
            while ((record = parser.read()) !== null) {
                try {
                    const processedRecord = processRecord(record);
                    if (processedRecord) {
                        currentBatch.push(processedRecord);
                        processed++;
                        importProgressTracker.processed = processed;

                        // Process in batches when we have enough records
                        if (currentBatch.length >= BATCH_SIZE) {
                            batches.push([...currentBatch]);
                            currentBatch = [];
                            // Process batches when we have enough
                            if (batches.length >= PARALLEL_BATCHES) {
                                const results = await processBatchesInParallel(batches, filename, processed);
                                batches = [];

                                // Add a small delay to allow memory cleanup
                                await new Promise(resolve => setTimeout(resolve, 100));
                            }
                        }
                    }
                } catch (error) {
                    skippedLines++;
                    // console the exact line that is causing the error with the line number and data could be read from the parser.read()
                    const line = parser.read();
                    // log these using logger.warn
                    socialScrapeLogger.error(`Skipping malformed line: ${error.message} at line: ${line}`);



                    // Add to errors but don't stop the process
                    importProgressTracker.errors.push({
                        filename,
                        error: `Skipped malformed line: ${error.message}`
                    });
                }
            }
        });

        parser.on('end', async () => {
            try {
                // Process remaining records
                if (currentBatch.length > 0) {
                    batches.push([...currentBatch]);
                }
                if (batches.length > 0) {
                    await processBatchesInParallel(batches, filename, processed);
                }

                // Log summary of skipped lines
                if (skippedLines > 0) {
                    socialScrapeLogger.info(`Completed processing ${filename}. Processed: ${processed}, Skipped: ${skippedLines} malformed lines`);
                    importProgressTracker.errors.push({
                        filename,
                        error: `Skipped ${skippedLines} malformed lines during processing`
                    });
                }

                await moveCompletedFile(filePath);
                importProgressTracker.isComplete = true;
                resolve({ filename, processed });
            } catch (error) {
                reject(error);
            }
        });

        parser.on('error', (error) => {
            // For CSV parsing errors, log but don't stop the entire process
            const errorMessage = `CSV parsing error (continuing with valid lines): ${error.message}`;
            socialScrapeLogger.warn(`Error in ${filename}: ${errorMessage}`);

            skippedLines++;
            importProgressTracker.errors.push({
                filename,
                error: errorMessage
            });

            // Don't reject the promise, let it continue processing
            // The parser will skip the problematic line and continue
        });

        // Use streams with smaller chunks for better memory management
        fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 }) // 1MB chunks
            .pipe(parser);
    });
};

const getImportFiles = async (isBlackList = false) => {
    try {
        await ensureImportDirectory();
        if (isBlackList) {
            socialScrapeLogger.info('Reading blacklist directory:', BLACKLIST_DIR);
        }
        else {
            socialScrapeLogger.info('Reading import directory:', IMPORT_DIR);
        }

        if (isBlackList) {
            const files = await fs.promises.readdir(BLACKLIST_DIR);
            return files.filter(file => file.endsWith('.csv'));

        }
        else {
            const files = await fs.promises.readdir(IMPORT_DIR);
            return files.filter(file => file.endsWith('.csv'));
        }

    } catch (error) {
        socialScrapeLogger.error('Error reading import directory:', error);
        return [];
    }
};

const getBlacklistFiles = async () => {
    try {
        await ensureImportDirectory();
        const files = await fs.promises.readdir(BLACKLIST_DIR);
        return files.filter(file => file.endsWith('.csv') || file.endsWith('.txt'));
    } catch (error) {
        socialScrapeLogger.error('Error reading blacklist directory:', error);
        throw new Error('Failed to read blacklist directory');
    }
};


const processBlacklistFile = async (filePath, urlColumn, processId) => {
    try {
        let progressTracker = blacklistProgressStore.get(processId);
        if (!progressTracker) {
            progressTracker = {
                currentFile: null,
                processed: 0,
                total: 0,
                upserted: 0,
                modified: 0,
                errors: [],
                isComplete: false
            };
            blacklistProgressStore.set(processId, progressTracker);
        }

        progressTracker.currentFile = path.basename(filePath);
        progressTracker.processed = 0;
        progressTracker.total = 0;
        progressTracker.upserted = 0;
        progressTracker.modified = 0;
        progressTracker.errors = [];
        progressTracker.isComplete = false;

        const logsDir = path.join(process.cwd(), 'logs', 'social_scrape');
        await fs.promises.mkdir(logsDir, { recursive: true });
        const logFile = path.join(logsDir, 'blacklisted_logs.log');

        const fileContent = await fs.promises.readFile(filePath, 'utf-8');
        const records = fileContent.split(/\r?\n/).filter(line => line.trim());
        progressTracker.total = records.length;

        await fs.promises.appendFile(logFile, `\n[${new Date().toISOString()}] Starting secure bulk processing: ${path.basename(filePath)}\n`);

        const seenRecords = new Set();
        let bulkOps = [];
        const BATCH_SIZE = 1000;

        // HARDENED: Isolated batch flushing utility to insulate imports from errors
        const flushBatch = async () => {
            if (bulkOps.length === 0) return;

            try {
                const result = await SocialScrape.bulkWrite(bulkOps, { ordered: false });
                
                // Track standard successful runs
                progressTracker.upserted += result.upsertedCount || 0;
                progressTracker.modified += (result.modifiedCount || 0) + ((result.matchedCount || 0) - (result.modifiedCount || 0));
            } catch (bulkError) {
                // Unordered batches populate bulkError.result with entries that succeeded before/during errors
                if (bulkError.result) {
                    const partialResult = bulkError.result;
                    progressTracker.upserted += partialResult.upsertedCount || 0;
                    progressTracker.modified += (partialResult.modifiedCount || 0) + ((partialResult.matchedCount || 0) - (partialResult.modifiedCount || 0));
                }

                // Parse out concrete details if specific items within the batch failed validation
                if (bulkError.writeErrors) {
                    bulkError.writeErrors.forEach(e => {
                        progressTracker.errors.push(`Row error at index ${e.index}: ${e.errmsg}`);
                    });
                    await fs.promises.appendFile(logFile, `[${new Date().toISOString()}] Batch completed with ${bulkError.writeErrors.length} individual write errors.\n`);
                } else {
                    progressTracker.errors.push(`Batch execution error: ${bulkError.message}`);
                    await fs.promises.appendFile(logFile, `[${new Date().toISOString()}] Batch encountered structural error: ${bulkError.message}\n`);
                }
            } finally {
                // CRITICAL: Guaranteed cleanup ensures memory drops items so processing never deadlocks
                progressTracker.processed += bulkOps.length;
                bulkOps = []; 
            }
        };

        for (const record of records) {
            try {
                const regex = /^(\d{2}\/\d{2}\/\d{4})[\s,]+\d{2}:\d{2}:\d{2}[\s,]+(https?:\/\/[^\s,]+)/i;
                const match = record.match(regex);

                if (!match) continue; // Safely bypass headers

                const [, dateStr, rawUrl] = match;
                const [day, month, year] = dateStr.split('/');
                const parsedDate = new Date(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0);

                let url;
                try {
                    url = new URL(rawUrl).hostname.replace(/^www\./i, '').toLowerCase();
                } catch (e) {
                    continue; // Skip individual broken URLs
                }

                if (!isValidDomain(url)) continue;

                const dateKey = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
                const uniqueKey = `${url}:${dateKey}`;
                
                if (seenRecords.has(uniqueKey)) continue;
                seenRecords.add(uniqueKey);

                bulkOps.push({
                    updateOne: {
                        filter: { url: url, date: parsedDate },
                        update: {
                            $set: { is_blacklisted: true },
                            $setOnInsert: { url: url, date: parsedDate }
                        },
                        upsert: true
                    }
                });

                // Flush when the batch hits limit threshold
                if (bulkOps.length >= BATCH_SIZE) {
                    await flushBatch();
                }

            } catch (rowError) {
                progressTracker.errors.push(`Line parsing exception: ${rowError.message}`);
            }
        }

        // Flush out remaining trailing operations cleanly
        await flushBatch();

        // Archive raw file
        const archiveDir = path.join(process.cwd(), 'imports', 'social_scrape_blacklisted', 'completed_' + new Date().toISOString().split('T')[0]);
        await archiveFile(filePath, {
            archiveDir,
            useTimestamp: true,
            timestampFormat: 'ISO',
            prefix: 'blacklist'
        });

        await fs.promises.appendFile(logFile, `[${new Date().toISOString()}] File completely parsed. Processed: ${progressTracker.processed} | Upserted: ${progressTracker.upserted} | Modified: ${progressTracker.modified} | Total Errors Logged: ${progressTracker.errors.length}\n`);

        progressTracker.isComplete = true;

    } catch (error) {
        socialScrapeLogger.error(`Fatal crash inside Blacklist importer engine: ${error.message}`);
        throw error;
    }
};


const getCollectionStats = async () => {
    return await SocialScrape.countDocuments();
};

const getBlacklistProgress = (processId) => {
    const progress = blacklistProgressStore.get(processId);
    return progress ? { ...progress } : null;
};

const getAreaCode = (phone) => {
    const areaCode = areaCodes.find(area => phone.startsWith(area.code));
    return areaCode ? areaCode.areaName : null;
};

// Phone number validation utility
const isValidPhoneNumber = (phone, url) => {
    if (!phone || typeof phone !== 'string') return false;

    // Clean the phone number first
    const cleanedPhone = cleanPhoneNumber(phone);
    if (!cleanedPhone) return false;



    return cleanedPhone ? cleanedPhone : false;
};

// Clean phone number for storage
const cleanPhoneNumber = (phone) => {
    if (!phone || typeof phone !== 'string') return null;

    let cleaned = phone.trim();

    // Handle scientific notation (e.g., 4.41245E+11, 4.41245E-11)
    if (cleaned.match(/[Ee][+-]?\d+/)) {
        try {
            // Convert scientific notation to full number
            const number = parseFloat(cleaned);
            if (!isNaN(number)) {
                cleaned = Math.floor(number).toString(); // Use Math.floor to avoid decimal places
            }
        } catch (error) {
            socialScrapeLogger.warn(`Failed to parse scientific notation: ${cleaned}`);
        }
    }

    // Remove spaces
    cleaned = cleaned.replace(/\s+/g, '');
    // Remove dashes
    cleaned = cleaned.replace(/-/g, '');

    // remove + 
    cleaned = cleaned.replace('+', '');

    // Remove dots (decimal points)
    cleaned = cleaned.replace(/\./g, '');

    // Remove brackets (both round and square brackets)
    cleaned = cleaned.replace(/[\(\)\[\]]/g, '');



    // keep only numbers, no other characters or special characters
    cleaned = cleaned.replace(/[^0-9]/g, '');

    // Validate phone number length (UK numbers are typically 10-11 digits)
    // if (cleaned.length < 10 || cleaned.length > 15) {
    //     socialScrapeLogger.warn(`Phone number length seems invalid: ${cleaned} (length: ${cleaned.length})`);
    //     return null;
    // }

    if (cleaned.startsWith('44')) {
        if (cleaned.length == 12) {
            cleaned = cleaned.slice(2);
            cleaned = '0' + cleaned;
        }
        if (cleaned.length == 13) {
            cleaned = cleaned.slice(2);
        }
    }
    if (cleaned.length == 10 && !cleaned.startsWith('44') && !cleaned.startsWith('0')) {
        cleaned = '0' + cleaned;
    }

    return cleaned;
};



// Get expected length for a country


const getPhoneFiles = async () => {
    try {
        await ensureImportDirectory();
        const files = await fs.promises.readdir(PHONE_DIR);
        return files.filter(file => file.endsWith('.csv'));
    } catch (error) {
        socialScrapeLogger.error('Error reading phone directory:', error);
        throw new Error('Failed to read phone directory');
    }
};

const processPhoneFile = async (filePath, processId) => {
    try {
        // Get or create progress tracker for this process
        let progressTracker = phoneProgressStore.get(processId);
        if (!progressTracker) {
            progressTracker = {
                currentFile: null,
                processed: 0,
                total: 0,
                updated: 0,
                created: 0,
                errors: [],
                isComplete: false,
                totalFiles: 0,
                completedFiles: 0
            };
            phoneProgressStore.set(processId, progressTracker);
            socialScrapeLogger.warn(`Created new progress tracker for ${processId} in service (should have been initialized in controller)`);
        } else {
            socialScrapeLogger.info(`Using existing progress tracker for ${processId}: totalFiles=${progressTracker.totalFiles}`);
        }

        // Update current file (don't reset other progress)
        progressTracker.currentFile = path.basename(filePath);
        // Don't reset processed, updated, created, errors, or total - accumulate them
        progressTracker.isComplete = false;

        // Create logs directory if it doesn't exist
        const logsDir = path.join(process.cwd(), 'logs', 'social_scrape');
        await fs.promises.mkdir(logsDir, { recursive: true });
        const logFile = path.join(logsDir, 'phone_logs.log');

        // Log start of processing
        await fs.promises.appendFile(logFile, `\n[${new Date().toISOString()}] Starting phone processing of file: ${path.basename(filePath)}\n`);

        return new Promise((resolve, reject) => {
            // Add timeout to prevent hanging
            const timeout = setTimeout(() => {
                const errorMsg = 'Phone processing timeout - process took too long';
                progressTracker.errors.push(errorMsg);
                progressTracker.completedFiles++;
                socialScrapeLogger.info(`Marked file ${path.basename(filePath)} as completed (timeout). Total completed: ${progressTracker.completedFiles}/${progressTracker.totalFiles}`);
                // phoneEventEmitter.emit('progress', { processId, ...progressTracker });
                reject(new Error(errorMsg));
            }, 30 * 60 * 1000); // 30 minutes timeout

            const parser = csv.parse({
                columns: false, // No headers
                skip_empty_lines: true,
                relax_column_count: true, // Allow flexible column count
                relax_quotes: true, // Be more flexible with quotes
                highWaterMark: 1024 * 1024 // 1MB chunks
            });

            let urlPhoneMap = new Map(); // To group phones by URL+DATE
            let urlCountMap = new Map(); // To count occurrences of each URL+DATE
            let processedUrls = new Set(); // Track URL+DATEs that have been processed
            let lineNumber = 0;
            let totalLines = 0;

            // First pass: count total lines for progress calculation
            const countLines = () => {
                return new Promise((resolve) => {
                    const lineCount = fs.readFileSync(filePath, 'utf-8').split('\n').filter(line => line.trim()).length;
                    resolve(lineCount);
                });
            };

            countLines().then((lineCount) => {
                totalLines = lineCount;
                progressTracker.total += lineCount;
                // phoneEventEmitter.emit('progress', { processId, ...progressTracker });
            });

            parser.on('readable', async () => {
                let record;
                while ((record = parser.read()) !== null) {
                    lineNumber++;
                    try {
                        // Skip records with insufficient data
                        if (!record || record.length < 3) {
                            const errorMsg = `Line ${lineNumber}: Invalid record format - expected at least 3 columns, got ${record ? record.length : 0}`;
                            progressTracker.errors.push(errorMsg);
                            continue;
                        }

                        const url = record[0]?.trim();
                        const code = record[1]?.trim();
                        const phoneData = record[2]?.trim();
                        // here dates are like this 28-05-2025
                        const date = record[3]?.trim();
                        // Parse date to ISO (YYYY-MM-DD) for consistency
                        let parsedDate = null;
                        if (date) {
                            // Accepts both DD-MM-YYYY and DD/MM/YYYY
                            const parts = date.includes('-') ? date.split('-') : date.split('/');
                            if (parts.length === 3) {
                                parsedDate = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
                            }
                        }
                        if (!parsedDate || isNaN(parsedDate.getTime())) {
                            // If date is missing or invalid, skip
                            const errorMsg = `Line ${lineNumber}: Invalid or missing date: ${date}`;
                            progressTracker.errors.push(errorMsg);
                            continue;
                        }

                        if (!url || !code || !phoneData) {
                            const errorMsg = `Line ${lineNumber}: Missing required data - URL: ${!!url}, Code: ${!!code}, Phone: ${!!phoneData}`;
                            progressTracker.errors.push(errorMsg);
                            continue;
                        }

                        // Only process records with [PN] code
                        if (code !== '[PN]') {
                            continue;
                        }

                        // Clean and validate URL
                        const cleanUrl = url
                            .replace(/^(https?:\/\/)/i, '') // remove http:// or https://
                            .replace(/^www\./i, '') // remove www.
                            .replace(/^([^/]+).*?$/, '$1') // remove everything after the first /
                            .toLowerCase(); // make lowercase

                        if (!isValidDomain(cleanUrl)) {
                            const errorMsg = `Line ${lineNumber}: Invalid domain format: ${cleanUrl}`;
                            progressTracker.errors.push(errorMsg);
                            continue;
                        }

                        const validPhone = isValidPhoneNumber(phoneData, cleanUrl);
                        if (!validPhone) {
                            const errorMsg = `Line ${lineNumber}: Invalid phone number: ${phoneData} for URL: ${cleanUrl}`;
                            progressTracker.errors.push(errorMsg);
                            continue;
                        }

                        const areaCode = getAreaCode(validPhone);
                        if (areaCode == null || validPhone.length != 11) {
                            continue;
                        }

                        const phoneWithArea = `${areaCode}/${validPhone}`;
                        // Group by url+date
                        const urlDateKey = `${cleanUrl}|||${parsedDate.toISOString().split('T')[0]}`;
                        urlCountMap.set(urlDateKey, (urlCountMap.get(urlDateKey) || 0) + 1);
                        if ((urlCountMap.get(urlDateKey) || 0) > 3) {
                            continue;
                        }
                        if (!urlPhoneMap.has(urlDateKey)) {
                            urlPhoneMap.set(urlDateKey, { phoneSet: new Set(), url: cleanUrl, date: parsedDate });
                        }
                        urlPhoneMap.get(urlDateKey).phoneSet.add(phoneWithArea);

                        progressTracker.processed++;
                        // phoneEventEmitter.emit('progress', { processId, ...progressTracker });

                        // Process in batches
                        if (urlPhoneMap.size >= BATCH_SIZE) {
                            // Filter out url+date that have already been processed
                            const unprocessed = new Map();
                            for (const [key, value] of urlPhoneMap) {
                                if (!processedUrls.has(key)) {
                                    unprocessed.set(key, value);
                                }
                            }
                            if (unprocessed.size > 0) {
                                await processPhoneBatch(unprocessed, progressTracker, logFile);
                                for (const key of unprocessed.keys()) {
                                    processedUrls.add(key);
                                }
                                socialScrapeLogger.debug(`Processed batch: ${unprocessed.size} url+date, Total processed: ${processedUrls.size}`);
                            }
                            urlPhoneMap.clear();
                        }

                    } catch (error) {
                        const errorMsg = `Line ${lineNumber}: Error processing record: ${error.message}`;
                        progressTracker.errors.push(errorMsg);
                        socialScrapeLogger.error(`Phone processing error on line ${lineNumber}:`, error);
                    }
                }
            });

            parser.on('end', async () => {
                try {
                    clearTimeout(timeout); // Clear timeout on successful completion

                    // Filter out url+date with more than 3 rows
                    const filteredUrlPhoneMap = new Map();
                    for (const [key, value] of urlPhoneMap) {
                        const urlCount = urlCountMap.get(key) || 0;
                        if (urlCount <= 3 && !processedUrls.has(key)) {
                            filteredUrlPhoneMap.set(key, value);
                        }
                    }
                    if (filteredUrlPhoneMap.size > 0) {
                        await processPhoneBatch(filteredUrlPhoneMap, progressTracker, logFile);
                    }

                    // Archive the file after processing
                    const archiveDir = path.join(process.cwd(), 'imports', 'social_scrape_phone', 'completed_' + new Date().toISOString().split('T')[0]);
                    await archiveFile(filePath, {
                        archiveDir,
                        useTimestamp: false
                    });

                    // Log completion
                    await fs.promises.appendFile(logFile, `[${new Date().toISOString()}] Phone processing completed. Processed: ${progressTracker.processed}, Updated: ${progressTracker.updated}, Created: ${progressTracker.created}, Errors: ${progressTracker.errors.length}\n`);

                    // Mark file as completed
                    progressTracker.completedFiles++;
                    socialScrapeLogger.info(`Marked file ${path.basename(filePath)} as completed. Total completed: ${progressTracker.completedFiles}/${progressTracker.totalFiles}`);

                    // Check if all files are completed
                    if (progressTracker.completedFiles >= progressTracker.totalFiles) {
                        progressTracker.isComplete = true;
                        progressTracker.currentFile = null; // Clear current file when complete
                        socialScrapeLogger.info(`All files completed for process ${processId}. Setting isComplete = true`);

                        // Schedule cleanup of this progress tracker after 1 hour
                        setTimeout(() => {
                            if (phoneProgressStore.has(processId)) {
                                phoneProgressStore.delete(processId);
                                socialScrapeLogger.info(`Cleaned up completed progress tracker for process: ${processId}`);
                            }
                        }, 60 * 60 * 1000); // 1 hour
                    }

                    // Update progress tracker with timestamp
                    updateProgressTracker(processId, progressTracker);
                    // phoneEventEmitter.emit('progress', { processId, ...progressTracker });
                    resolve({ filename: path.basename(filePath), processed: progressTracker.processed });
                } catch (error) {
                    clearTimeout(timeout);
                    // Mark file as completed even on error
                    progressTracker.completedFiles++;
                    socialScrapeLogger.info(`Marked file ${path.basename(filePath)} as completed (CSV error). Total completed: ${progressTracker.completedFiles}/${progressTracker.totalFiles}`);

                    // Check if all files are completed
                    if (progressTracker.completedFiles >= progressTracker.totalFiles) {
                        progressTracker.isComplete = true;
                        progressTracker.currentFile = null;
                        socialScrapeLogger.info(`All files completed for process ${processId} (with error). Setting isComplete = true`);

                        // Schedule cleanup of this progress tracker after 1 hour
                        setTimeout(() => {
                            if (phoneProgressStore.has(processId)) {
                                phoneProgressStore.delete(processId);
                                socialScrapeLogger.info(`Cleaned up completed progress tracker for process: ${processId}`);
                            }
                        }, 60 * 60 * 1000); // 1 hour
                    }

                    // Update progress tracker with timestamp
                    updateProgressTracker(processId, progressTracker);
                    // phoneEventEmitter.emit('progress', { processId, ...progressTracker });
                    reject(error);
                }
            });

            parser.on('error', (error) => {
                clearTimeout(timeout);
                const errorMsg = `CSV parsing error: ${error.message}`;
                progressTracker.errors.push(errorMsg);
                socialScrapeLogger.error('CSV parsing error:', error);

                // Mark file as completed even on error
                progressTracker.completedFiles++;
                socialScrapeLogger.info(`Marked file ${path.basename(filePath)} as completed (CSV error). Total completed: ${progressTracker.completedFiles}/${progressTracker.totalFiles}`);

                // Check if all files are completed
                if (progressTracker.completedFiles >= progressTracker.totalFiles) {
                    progressTracker.isComplete = true;
                    progressTracker.currentFile = null;
                    socialScrapeLogger.info(`All files completed for process ${processId} (with error). Setting isComplete = true`);

                    // Schedule cleanup of this progress tracker after 1 hour
                    setTimeout(() => {
                        if (phoneProgressStore.has(processId)) {
                            phoneProgressStore.delete(processId);
                            socialScrapeLogger.info(`Cleaned up completed progress tracker for process: ${processId}`);
                        }
                    }, 60 * 60 * 1000); // 1 hour
                }

                // Update progress tracker with timestamp
                updateProgressTracker(processId, progressTracker);
                // phoneEventEmitter.emit('progress', { processId, ...progressTracker });

                reject(error);
            });

            // Use streams with smaller chunks for better memory management
            fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 }) // 1MB chunks
                .pipe(parser);
        });

    } catch (error) {
        const errorMsg = `Error processing phone file: ${error.message}`;
        socialScrapeLogger.error(errorMsg);
        throw error;
    }
};

const processPhoneBatch = async (urlPhoneMap, progressTracker, logFile) => {
    try {
        socialScrapeLogger.debug(`Processing batch of ${urlPhoneMap.size} url+date pairs`);
        for (const [urlDateKey, value] of urlPhoneMap) {
            try {
                const { phoneSet, url, date } = value;
                const rawPhones = Array.from(phoneSet);
                const phones = rawPhones
                    .map(p => {
                        const [areaName, number] = p.split('/');
                        return number && areaName
                            ? { number: number.trim(), areaName: areaName.trim() }
                            : null;
                    })
                    .filter(Boolean);
                if (phones.length > 3) {
                    const skippedMsg = `skip this url+date: ${urlDateKey} as it has ${phones.length} numbers`;
                    progressTracker.errors.push(skippedMsg);
                    await fs.promises.appendFile(logFile, `[${new Date().toISOString()}] ${skippedMsg}\n`);
                    continue;
                }
                // Find record by url and date (date only, ignore time)
                const dateOnly = new Date(date.toISOString().split('T')[0]);
                const result = await SocialScrape.updateOne(
                    { url, date: dateOnly },
                    { $set: { phone: phones.slice(0, 3) } },
                    { upsert: true }
                );
                if (result.upsertedCount > 0) {
                    progressTracker.created++;
                } else if (result.modifiedCount > 0) {
                    progressTracker.updated++;
                }
            } catch (error) {
                const errorMsg = `Error processing url+date ${urlDateKey}: ${error.message}`;
                progressTracker.errors.push(errorMsg);
                socialScrapeLogger.error(`Error processing url+date ${urlDateKey}:`, error);
                await fs.promises.appendFile(logFile, `[${new Date().toISOString()}] ${errorMsg}\n`);
            }
        }
    } catch (error) {
        socialScrapeLogger.error('Error processing phone batch:', error);
        throw error;
    }
};

const getPhoneProgress = (processId) => {
    const progress = phoneProgressStore.get(processId);
    return progress ? { ...progress } : null;
};

// Clean up old progress trackers to prevent memory leaks
const cleanupOldProgressTrackers = () => {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours

    for (const [processId, progress] of phoneProgressStore.entries()) {
        // If process is complete and older than 24 hours, remove it
        if (progress.isComplete && progress.lastUpdated && (now - progress.lastUpdated) > maxAge) {
            phoneProgressStore.delete(processId);
            socialScrapeLogger.info(`Cleaned up old progress tracker for process: ${processId}`);
        }
    }
};

// Update progress tracker with timestamp
const updateProgressTracker = (processId, updates) => {
    const progress = phoneProgressStore.get(processId);
    if (progress) {
        Object.assign(progress, updates, { lastUpdated: Date.now() });
        phoneProgressStore.set(processId, progress);
    }
};

// Utility function to find URLs with multiple records (same URL, different dates)
const findDuplicateUrls = async () => {
    try {
        // Find URLs that have multiple records with different dates
        const duplicates = await SocialScrape.aggregate([
            {
                $group: {
                    _id: "$url",
                    count: { $sum: 1 },
                    records: { $push: { _id: "$_id", date: "$date", phone: "$phone" } }
                }
            },
            {
                $match: {
                    count: { $gt: 1 }
                }
            },
            {
                $sort: { count: -1 }
            }
        ]);

        socialScrapeLogger.info(`Found ${duplicates.length} URLs with multiple records (different dates)`);

        for (const duplicate of duplicates.slice(0, 10)) { // Show first 10
            socialScrapeLogger.info(`URL: ${duplicate._id}, Count: ${duplicate.count}, Records: ${duplicate.records.map(r => r._id).join(', ')}`);
        }

        return duplicates;
    } catch (error) {
        socialScrapeLogger.error('Error finding URLs with multiple records:', error);
        return [];
    }
};

const SocialScrapeService = {
    getImportFiles,
    getBlacklistFiles,
    getPhoneFiles,
    getCollectionStats,
    processFile,
    processBlacklistFile,
    processPhoneFile,
    getImportProgress: () => ({ ...importProgressTracker }),
    resetImportProgress,
    setImportRunning,
    getBlacklistProgress,
    getPhoneProgress,
    findDuplicateUrls,
    cleanupOldProgressTrackers,
    updateProgressTracker
};


setInterval(() => {
    cleanupOldProgressTrackers();
}, 6 * 60 * 60 * 1000); // 6 hours

module.exports = {
    SocialScrapeService,
    IMPORT_DIR,
    BLACKLIST_DIR,
    PHONE_DIR,
    phoneProgressStore
};
