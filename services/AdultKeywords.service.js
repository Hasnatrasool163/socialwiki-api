// services/AdultKeywords.service.js
const csv = require('csv-parse');
const fs = require('fs');
const path = require('path');
const SocialScrape = require('../models/SocialScrape');
const AdultKeywordsReference = require('../models/AdultKeywordsReference');
const { adultKeywords_exact_match, adultKeywords_contains } = require('../utils/adult_keywords');
const adultKeywordsLogger = require('../config/loggers/adultKeywordsLogger');
const { isValidDomain } = require('../utils/helpers');

const MATCH_DIR = path.join(__dirname, '../imports/social_scrape_match_adult_keywords/');
const BATCH_SIZE = 1000; // Reduced from 2000 for 4GB VPS
const MEMORY_THRESHOLD = 0.8; // 80% memory usage threshold

// Progress tracker
const matchingProgressTracker = {
    currentFile: null,
    processed: 0,
    exactMatches: 0,
    containsMatches: 0,
    updatedRecords: 0,
    createdReferences: 0,
    errors: [],
    isComplete: false,
    isRunning: false
};

// Memory-efficient URL tracking: only track current file, clear after each file
let currentFileProcessedUrls = new Set();
let currentFileExactMatches = 0;
let currentFileContainsMatches = 0;

// Clear current file tracking
const clearCurrentFileTracking = () => {
    currentFileProcessedUrls.clear();
    currentFileExactMatches = 0;
    currentFileContainsMatches = 0;
};

// Move completed file to completed_date folder
const moveCompletedFile = async (filePath, filename) => {
    try {
        const completedDir = path.join(MATCH_DIR, 'completed_' + new Date().toISOString().split('T')[0]);

        // Create completed directory if it doesn't exist
        await fs.promises.mkdir(completedDir, { recursive: true });

        const sourcePath = filePath;
        const destinationPath = path.join(completedDir, filename);

        // Move the file
        await fs.promises.rename(sourcePath, destinationPath);

        adultKeywordsLogger.info(`Moved completed file ${filename} to ${completedDir}`);

    } catch (error) {
        adultKeywordsLogger.error(`Error moving completed file ${filename}:`, error);
        // Don't throw error - file processing was successful, just couldn't move it
    }
};

// Clean up old completed folders (keep only last 7 days)
const cleanupOldCompletedFolders = async () => {
    try {
        const matchDir = await fs.promises.readdir(MATCH_DIR);
        const completedFolders = matchDir.filter(item =>
            item.startsWith('completed_') &&
            fs.statSync(path.join(MATCH_DIR, item)).isDirectory()
        );

        if (completedFolders.length > 7) {
            // Sort by date (oldest first) and remove oldest ones
            const sortedFolders = completedFolders.sort();
            const foldersToRemove = sortedFolders.slice(0, completedFolders.length - 7);

            for (const folder of foldersToRemove) {
                const folderPath = path.join(MATCH_DIR, folder);
                await fs.promises.rm(folderPath, { recursive: true, force: true });
                adultKeywordsLogger.info(`Cleaned up old completed folder: ${folder}`);
            }
        }
    } catch (error) {
        adultKeywordsLogger.error('Error cleaning up old completed folders:', error);
        // Don't throw error - this is cleanup, not critical
    }
};

// Get completed files statistics
const getCompletedFilesStats = async () => {
    try {
        const matchDir = await fs.promises.readdir(MATCH_DIR);
        const completedFolders = matchDir.filter(item =>
            item.startsWith('completed_') &&
            fs.statSync(path.join(MATCH_DIR, item)).isDirectory()
        );

        let totalCompletedFiles = 0;
        const folderStats = [];

        for (const folder of completedFolders) {
            const folderPath = path.join(MATCH_DIR, folder);
            const files = await fs.promises.readdir(folderPath);
            const csvFiles = files.filter(file => file.endsWith('.csv'));
            totalCompletedFiles += csvFiles.length;

            folderStats.push({
                folder,
                fileCount: csvFiles.length,
                files: csvFiles
            });
        }

        return {
            totalCompletedFolders: completedFolders.length,
            totalCompletedFiles,
            folderStats
        };
    } catch (error) {
        adultKeywordsLogger.error('Error getting completed files stats:', error);
        return {
            totalCompletedFolders: 0,
            totalCompletedFiles: 0,
            folderStats: []
        };
    }
};

// Utility Functions
const ensureMatchDirectory = async () => {
    try {
        await fs.promises.mkdir(MATCH_DIR, { recursive: true });
    } catch (error) {
        adultKeywordsLogger.error('Error creating match directory:', error);
        throw new Error('Failed to create match directory');
    }
};

const resetMatchingProgress = () => {
    matchingProgressTracker.currentFile = null;
    matchingProgressTracker.processed = 0;
    matchingProgressTracker.exactMatches = 0;
    matchingProgressTracker.containsMatches = 0;
    matchingProgressTracker.updatedRecords = 0;
    matchingProgressTracker.createdReferences = 0;
    matchingProgressTracker.errors = [];
    matchingProgressTracker.isComplete = false;
    matchingProgressTracker.isRunning = false;

    // Clear URL tracking for new process
    currentFileProcessedUrls.clear();
    currentFileExactMatches = 0;
    currentFileContainsMatches = 0;

    adultKeywordsLogger.info('Reset adult keywords matching progress tracker');
};

const setMatchingRunning = (running) => {
    matchingProgressTracker.isRunning = running;
    adultKeywordsLogger.info(`Set adult keywords matching running status to: ${running}`);
};

const getMatchingFiles = async () => {
    try {
        await ensureMatchDirectory();
        const files = await fs.promises.readdir(MATCH_DIR);
        return files.filter(file => file.endsWith('.csv'));
    } catch (error) {
        adultKeywordsLogger.error('Error reading match directory:', error);
        throw error;
    }
};

// Process a single record based on CODE
const processRecord = (record) => {
    try {
        const trimUrl = (url) => {
            if (!url) return '';
            return url
                .replace(/^(https?:\/\/)/i, '')
                .replace(/^www\./i, '')
                .replace(/^([^/]+).*?$/, '$1');
        };

        const cleanText = (text) => {
            if (!text) return '';
            return text.replace(/[\x00-\x1F\x7F-\x9F]/g, '')
                .replace(/\s+/g, ' ')
                .trim()
                .substring(0, 400);
        };

        // Get the URL from the first column
        const url = Object.values(record)[0];

        // Skip if URL is not a valid domain
        if (!isValidDomain(url)) {
            return null;
        }

        // Skip records with error or no data
        if (record.RESULT === 'Fetch error or no data found' || record.RESULT === 'not required') {
            const hasOtherData = Object.entries(record).some(([key, value]) =>
                key !== 'RESULT' && value && value.trim() !== ''
            );
            if (!hasOtherData) {
                return null;
            }
        }

        // Process the record based on CODE
        const processedRecord = {
            url: trimUrl(url),
            title: '',
            meta_description: '',
            keywords: ''
        };

        switch (record.CODE) {
            case '[TI]':
                processedRecord.title = cleanText(record.RESULT);
                break;
            case '[MD]':
                processedRecord.meta_description = cleanText(record.RESULT);
                break;
            case '[KW]':
                processedRecord.keywords = cleanText(record.RESULT);
                break;
        }

        return processedRecord;
    } catch (error) {
        adultKeywordsLogger.error(`Error processing record: ${error.message}`);
        return null;
    }
};

// Merge multiple records for the same URL
const mergeRecordsForSameUrl = (docs, filename) => {
    if (docs.length === 1) {
        return { ...docs[0], csv_source: filename };
    }

    const mergedDoc = {
        url: docs[0].url,
        title: '',
        meta_description: '',
        keywords: '',
        csv_source: filename
    };

    // Merge all fields from all records, taking the first non-empty value
    for (const doc of docs) {
        if (doc.title && !mergedDoc.title) mergedDoc.title = doc.title;
        if (doc.meta_description && !mergedDoc.meta_description) mergedDoc.meta_description = doc.meta_description;
        if (doc.keywords && !mergedDoc.keywords) mergedDoc.keywords = doc.keywords;
    }

    return mergedDoc;
};

// Check if text contains exact adult keywords
const checkExactMatch = (text) => {
    if (!text) return null;
    const lowerText = text.toLowerCase();
    const matches = [];

    for (const keyword of adultKeywords_exact_match) {
        const lowerKeyword = keyword.toLowerCase();

        if (lowerText.includes(lowerKeyword)) {
            const regex = new RegExp(`\\b${lowerKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            if (regex.test(text)) {
                matches.push(keyword);
            }
        }
    }
    // checker for checkExactMatch 
    // If only one match found and it's "models", "massage", "exotic", or "adult", ignore it
    if (matches.length === 1) {
        const lowerMatch = matches[0].toLowerCase();
        if (lowerMatch === 'models' || lowerMatch === 'massage' || lowerMatch === 'exotic' || lowerMatch === 'adult') {
            return null;
        }
    }

    // Return the first match if any valid matches found
    return matches.length > 0 ? matches[0] : null;
};

// Check if text contains any adult keywords from contains list
const checkContainsMatch = (text) => {
    if (!text) return [];
    const lowerText = text.toLowerCase();
    const matches = [];

    for (const keyword of adultKeywords_contains) {
        const lowerKeyword = keyword.toLowerCase();

        if (lowerText.includes(lowerKeyword)) {
            const regex = new RegExp(`\\b${lowerKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            if (regex.test(text)) {
                matches.push(keyword);
            }
        }

    }

    // checker for 
    // If only one match found and it's "models", "massage", "exotic", or "adult", ignore it
    if (matches.length === 1) {
        const lowerMatch = matches[0].toLowerCase();
        if (lowerMatch === 'models' || lowerMatch === 'massage' || lowerMatch === 'exotic' || lowerMatch === 'adult') {
            return [];
        }
    }

    return matches;
};

// Process batch of records - Core Logic
const processBatch = async (records, filename) => {
    try {
        if (!records || records.length === 0) return;

        // Memory check for VPS constraints
        const memUsage = process.memoryUsage();
        const memoryUsagePercent = memUsage.heapUsed / memUsage.heapTotal;

        if (memoryUsagePercent > MEMORY_THRESHOLD) {
            adultKeywordsLogger.warn(`High memory usage detected: ${Math.round(memoryUsagePercent * 100)}%. Forcing garbage collection.`);
            if (global.gc) {
                global.gc();
            }
        }

        // Records parameter is already an array of processed records from processFile
        const processedRecords = records;

        if (processedRecords.length === 0) return;

        // Group records by URL
        const urlMap = new Map();
        for (const record of processedRecords) {
            if (!urlMap.has(record.url)) {
                urlMap.set(record.url, []);
            }
            urlMap.get(record.url).push(record);
        }

        // Merge records for same URL
        const mergedRecords = [];
        for (const [url, docs] of urlMap) {
            const mergedDoc = mergeRecordsForSameUrl(docs, filename);
            mergedRecords.push(mergedDoc);
        }

        // Clear memory
        urlMap.clear();

        if (mergedRecords.length === 0) return;

        // Bulk lookup existing social scrape records
        const urls = mergedRecords.map(record => record.url);
        const existingSocialScrapeRecords = await SocialScrape.find({ url: { $in: urls } }).lean();
        const socialScrapeMap = new Map();
        existingSocialScrapeRecords.forEach(record => {
            socialScrapeMap.set(record.url, record);
        });

        // Process records according to your logic
        const exactMatchUpdates = [];
        const containsMatchReferences = [];

        // Track URLs that have been processed in this batch to avoid duplicate logging
        const processedUrlsInBatch = new Set();

        for (const record of mergedRecords) {
            const { url, title, meta_description, keywords } = record;

            // Skip if not in social scrape database
            if (!socialScrapeMap.has(url)) {
                continue;
            }

            // Check for exact matches first
            const titleExact = checkExactMatch(title);
            const descExact = checkExactMatch(meta_description);
            const keywordsExact = checkExactMatch(keywords);

            if (titleExact || descExact || keywordsExact) {
                // Exact match found - update social scrape record
                if (!processedUrlsInBatch.has(url) && !currentFileProcessedUrls.has(url)) {
                    processedUrlsInBatch.add(url);
                    currentFileProcessedUrls.add(url);
                    currentFileExactMatches++;
                }

                exactMatchUpdates.push({
                    updateOne: {
                        filter: { url: url },
                        update: {
                            $set: {
                                title: "Possible 18+ content – text / image removed",
                                meta_description: "Possible 18+ content – text / image removed",
                                is_adult_content: true
                            }
                        }
                    }
                });

                matchingProgressTracker.exactMatches++;
                matchingProgressTracker.updatedRecords++;
            } else {
                // Check for contains matches
                const titleContains = checkContainsMatch(title);
                const descContains = checkContainsMatch(meta_description);
                const keywordsContains = checkContainsMatch(keywords);

                if (titleContains.length > 0 || descContains.length > 0 || keywordsContains.length > 0) {
                    const allMatches = [...new Set([...titleContains, ...descContains, ...keywordsContains])];

                    if (!processedUrlsInBatch.has(url) && !currentFileProcessedUrls.has(url)) {
                        processedUrlsInBatch.add(url);
                        currentFileProcessedUrls.add(url);
                        currentFileContainsMatches++;
                    }

                    // Create reference data
                    const referenceData = {
                        url,
                        matched_keywords: allMatches,
                        match_type: 'contains',
                        csv_source: filename
                    };

                    if (titleContains.length > 0) referenceData.title = title;
                    if (descContains.length > 0) referenceData.meta_description = meta_description;
                    if (keywordsContains.length > 0) referenceData.keywords = keywords;

                    containsMatchReferences.push(referenceData);
                    matchingProgressTracker.containsMatches++;
                }
            }

            matchingProgressTracker.processed++;
        }

        // Execute bulk operations
        let updatedCount = 0;
        let referenceCount = 0;

        // Bulk update social scrape records for exact matches
        if (exactMatchUpdates.length > 0) {
            try {
                const updateResult = await SocialScrape.bulkWrite(exactMatchUpdates, {
                    ordered: false,
                    writeConcern: { w: 1 }
                });
                updatedCount = updateResult.modifiedCount;
            } catch (error) {
                adultKeywordsLogger.error('Error in bulk update of social scrape records:', error);
                // Fallback to individual updates
                for (const update of exactMatchUpdates) {
                    try {
                        await SocialScrape.updateOne(update.updateOne.filter, update.updateOne.update);
                        updatedCount++;
                    } catch (individualError) {
                        adultKeywordsLogger.error(`Individual update failed for URL: ${update.updateOne.filter.url}`, individualError);
                    }
                }
            }
        }

        // Bulk insert/update adult keywords references for contains matches
        if (containsMatchReferences.length > 0) {
            try {
                const referenceResult = await AdultKeywordsReference.bulkWrite(containsMatchReferences.map(ref => ({
                    updateOne: {
                        filter: { url: ref.url },
                        update: {
                            $set: {
                                ...ref,
                                updated_at: new Date()
                            }
                        },
                        upsert: true
                    }
                })), {
                    ordered: false,
                    writeConcern: { w: 1 }
                });
                referenceCount = referenceResult.upsertedCount + referenceResult.modifiedCount;
                matchingProgressTracker.createdReferences += referenceResult.upsertedCount;
            } catch (error) {
                adultKeywordsLogger.error('Error in bulk processing of adult keywords references:', error);
                // Fallback to individual operations
                for (const ref of containsMatchReferences) {
                    try {
                        await AdultKeywordsReference.updateOne(
                            { url: ref.url },
                            { $set: { ...ref, updated_at: new Date() } },
                            { upsert: true }
                        );
                        referenceCount++;
                        matchingProgressTracker.createdReferences++;
                    } catch (individualError) {
                        adultKeywordsLogger.error(`Individual reference operation failed for URL: ${ref.url}`, individualError);
                    }
                }
            }
        }

        // Clear memory
        exactMatchUpdates.length = 0;
        containsMatchReferences.length = 0;
        mergedRecords.length = 0;

        // Log batch results (essential for monitoring progress)
        adultKeywordsLogger.info(`Batch: ${processedRecords.length} records, ${updatedCount} updated, ${referenceCount} references`);

    } catch (error) {
        adultKeywordsLogger.error(`Error processing batch from ${filename}:`, error);
        matchingProgressTracker.errors.push({
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
};

// Process CSV file
const processFile = async (filePath) => {
    try {
        const filename = path.basename(filePath);

        // Clear tracking for new file
        clearCurrentFileTracking();

        matchingProgressTracker.currentFile = filename;

        let processed = 0;
        let currentBatch = [];
        let skippedLines = 0;

        // Reset progress for new file
        matchingProgressTracker.processed = 0;
        matchingProgressTracker.exactMatches = 0;
        matchingProgressTracker.containsMatches = 0;
        matchingProgressTracker.updatedRecords = 0;
        matchingProgressTracker.createdReferences = 0;
        matchingProgressTracker.errors = [];

        return new Promise((resolve, reject) => {
            const parser = csv.parse({
                columns: true,
                skip_empty_lines: true,
                relax_column_count: true,
                relax_quotes: true,
                highWaterMark: 1024 * 1024
            });

            // Add timeout to prevent infinite processing
            const processingTimeout = setTimeout(() => {
                adultKeywordsLogger.error(`Processing timeout for ${filename} after 30 minutes`);
                reject(new Error(`Processing timeout for ${filename}`));
            }, 30 * 60 * 1000);

            parser.on('readable', async () => {
                let record;

                while ((record = parser.read()) !== null) {
                    try {
                        // Skip status code records that don't contain content we need
                        if (record.CODE === '[SC]' || record.CODE === '[EM]' || record.CODE === '[FB]' || record.CODE === '[LK]' || record.CODE === '[TW]' || record.CODE === '[YT]') {
                            continue;
                        }

                        const processedRecord = processRecord(record);
                        if (processedRecord) {
                            currentBatch.push(processedRecord);
                            processed++;
                            matchingProgressTracker.processed = processed;

                            // Progress logging for large files (every 10,000 records)
                            if (processed % 10000 === 0) {
                                adultKeywordsLogger.info(`Progress: ${filename} - ${processed} records processed`);
                            }

                            // Process batch immediately when we have enough records
                            if (currentBatch.length >= BATCH_SIZE) {
                                // Process the current batch and clear it
                                await processBatch([...currentBatch], filename);
                                currentBatch = [];
                            }
                        }
                    } catch (error) {
                        skippedLines++;
                        matchingProgressTracker.errors.push({
                            filename,
                            error: `Skipped malformed line: ${error.message}`
                        });
                    }
                }
            });

            parser.on('end', async () => {
                try {
                    clearTimeout(processingTimeout);

                    // Process remaining records in the final batch
                    if (currentBatch.length > 0) {
                        await processBatch([...currentBatch], filename);
                    }

                    // Memory cleanup after file processing
                    if (global.gc) {
                        global.gc();
                    }

                    // Clear current file tracking to free memory
                    clearCurrentFileTracking();

                    // Log file completion with unique matches summary
                    const uniqueExactMatches = currentFileExactMatches;
                    const uniqueContainsMatches = currentFileContainsMatches;

                    adultKeywordsLogger.info(`Completed: ${filename} - ${processed} records, ${skippedLines} skipped, ${uniqueExactMatches} unique exact matches, ${uniqueContainsMatches} unique contains matches`);

                    // Move completed file to completed_date folder
                    await moveCompletedFile(filePath, filename);

                    resolve({ filename, processed });
                } catch (error) {
                    clearTimeout(processingTimeout);
                    reject(error);
                }
            });

            parser.on('error', (error) => {
                clearTimeout(processingTimeout);
                const errorMessage = `CSV parsing error: ${error.message}`;
                adultKeywordsLogger.error(`Error in ${filename}: ${errorMessage}`);
                skippedLines++;
                matchingProgressTracker.errors.push({
                    filename,
                    error: errorMessage
                });
            });

            fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 })
                .pipe(parser);
        });

    } catch (error) {
        adultKeywordsLogger.error(`Error processing file ${filePath}:`, error);
        throw error;
    }
};

// Start adult keywords matching process
const startMatching = async () => {
    try {
        if (matchingProgressTracker.isRunning) {
            throw new Error('Adult keywords matching is already running. Please wait for it to complete.');
        }

        const files = await getMatchingFiles();

        if (files.length === 0) {
            throw new Error('No CSV files found in match_adult_keywords directory');
        }

        // Clean up old completed folders before starting
        await cleanupOldCompletedFolders();

        resetMatchingProgress();
        setMatchingRunning(true);

        adultKeywordsLogger.info('Starting adult keywords matching', {
            filesCount: files.length,
            files: files,
            batchSize: BATCH_SIZE
        });

        processFiles(files).catch(error => {
            console.error('Error processing files for adult keywords matching:', error);
            setMatchingRunning(false);
        });

        return {
            success: true,
            message: 'Adult keywords matching started',
            files: files
        };
    } catch (error) {
        adultKeywordsLogger.error('Error starting adult keywords matching:', error);
        throw error;
    }
};

// Stop adult keywords matching process
const stopMatching = async () => {
    try {
        if (!matchingProgressTracker.isRunning) {
            return {
                success: false,
                message: 'Adult keywords matching is not currently running'
            };
        }

        setMatchingRunning(false);
        matchingProgressTracker.isComplete = true;

        adultKeywordsLogger.info('Adult keywords matching stopped by user');

        return {
            success: true,
            message: 'Adult keywords matching stopped successfully'
        };
    } catch (error) {
        adultKeywordsLogger.error('Error stopping adult keywords matching:', error);
        throw error;
    }
};

// Process multiple files
const processFiles = async (files) => {
    try {
        adultKeywordsLogger.info(`Processing ${files.length} files for adult keywords matching`);

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            try {
                adultKeywordsLogger.info(`File ${i + 1}/${files.length}: ${file}`);

                const filePath = path.join(MATCH_DIR, file);
                await processFile(filePath);

                adultKeywordsLogger.info(`Completed file ${i + 1}/${files.length}: ${file}`);

                if (!matchingProgressTracker.isRunning) {
                    adultKeywordsLogger.info('Adult keywords matching was stopped, stopping file processing');
                    break;
                }
            } catch (error) {
                adultKeywordsLogger.error(`Error processing file ${i + 1}/${files.length} (${file}):`, error);
                matchingProgressTracker.errors.push({
                    error: error.message,
                    file: file,
                    timestamp: new Date().toISOString()
                });
                continue;
            }
        }

        // Mark overall matching as complete
        matchingProgressTracker.isComplete = true;
        matchingProgressTracker.currentFile = null;
        setMatchingRunning(false);

        // Log completion summary
        adultKeywordsLogger.info('Adult keywords matching completed', {
            filesProcessed: files.length,
            exactMatches: matchingProgressTracker.exactMatches,
            containsMatches: matchingProgressTracker.containsMatches,
            updatedRecords: matchingProgressTracker.updatedRecords,
            createdReferences: matchingProgressTracker.createdReferences,
            errors: matchingProgressTracker.errors.length
        });

    } catch (error) {
        adultKeywordsLogger.error('Error in processFiles for adult keywords matching:', error);
        matchingProgressTracker.errors.push({
            error: error.message,
            timestamp: new Date().toISOString()
        });
        setMatchingRunning(false);
        throw error;
    }
};

// Get matching progress
const getMatchingProgress = () => {
    return { ...matchingProgressTracker };
};

// Get statistics
const getStats = async () => {
    try {
        const totalReferences = await AdultKeywordsReference.countDocuments();
        const unprocessedReferences = await AdultKeywordsReference.countDocuments({ processed: false });
        const exactMatches = await AdultKeywordsReference.countDocuments({ match_type: 'exact' });
        const containsMatches = await AdultKeywordsReference.countDocuments({ match_type: 'contains' });

        return {
            totalReferences,
            unprocessedReferences,
            exactMatches,
            containsMatches,
            currentProgress: matchingProgressTracker
        };
    } catch (error) {
        adultKeywordsLogger.error('Error getting adult keywords stats:', error);
        throw error;
    }
};

// Get all references
const getReferences = async () => {
    try {
        return await AdultKeywordsReference.find().sort({ created_at: -1 });
    } catch (error) {
        adultKeywordsLogger.error('Error getting adult keywords references:', error);
        throw error;
    }
};

// Get paginated references
const getPaginatedReferences = async (page = 1, limit = 50, matchType = null, processed = null) => {
    try {
        const skip = (page - 1) * limit;
        const filter = {};

        if (matchType) {
            filter.match_type = matchType;
        }

        if (processed !== null) {
            filter.processed = processed;
        }

        const references = await AdultKeywordsReference.find(filter)
            .sort({ created_at: -1 })
            .skip(skip)
            .limit(limit);

        const total = await AdultKeywordsReference.countDocuments(filter);

        return {
            references,
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit)
            }
        };
    } catch (error) {
        adultKeywordsLogger.error('Error getting paginated adult keywords references:', error);
        throw error;
    }
};

// Bulk process references
const bulkProcessReferences = async (recordIds, isAdultContent) => {
    try {
        adultKeywordsLogger.info('Starting bulk process for references', {
            recordCount: recordIds.length,
            isAdultContent: isAdultContent
        });

        let processed = 0;
        let updated = 0;

        const references = await AdultKeywordsReference.find({ _id: { $in: recordIds } });

        if (references.length === 0) {
            throw new Error('No references found with the provided IDs');
        }

        const processedUrls = [];

        for (const reference of references) {
            try {
                if (isAdultContent) {
                    const updateResult = await SocialScrape.updateMany(
                        { url: reference.url },
                        {
                            $set: {
                                title: "Possible 18+ content – text / image removed",
                                meta_description: "Possible 18+ content – text / image removed",
                                is_adult_content: true
                            }
                        }
                    );

                    if (updateResult.modifiedCount > 0) {
                        updated++;
                    }
                }

                await AdultKeywordsReference.updateOne(
                    { _id: reference._id },
                    {
                        $set: {
                            processed: true,
                            processed_at: new Date(),
                            updated_at: new Date()
                        }
                    }
                );

                processedUrls.push(reference.url);
                processed++;
            } catch (error) {
                adultKeywordsLogger.error(`Error processing reference ${reference._id}:`, error);
            }
        }

        adultKeywordsLogger.info('Completed bulk process for references', {
            totalRecords: recordIds.length,
            processed: processed,
            updated: updated,
            isAdultContent: isAdultContent,
            processedUrls: processedUrls // Log all processed URLs here
        });

        return {
            message: `Successfully processed ${processed} references${isAdultContent ? ` and updated ${updated} social scrape records` : ''}`,
            processed: processed,
            updated: updated
        };

    } catch (error) {
        adultKeywordsLogger.error('Error in bulk process references:', error);
        throw error;
    }
};

module.exports = {
    AdultKeywordsService: {
        startMatching,
        stopMatching,
        getMatchingProgress,
        getStats,
        getReferences,
        getPaginatedReferences,
        bulkProcessReferences,
        getCompletedFilesStats // Added new function to exports
    },
    matchingProgressTracker,
    resetMatchingProgress,
    setMatchingRunning
}; 