// services/BotsolService.js
const csv = require('csv-parse');
const fs = require('fs');
const path = require('path');
const Botsol = require('../models/Botsol');
const areaCodes = require('../utils/areaCodes');
const botsolLogger = require('../config/loggers/botsolLogger');

// Configuration
const BATCH_SIZE = 2000;
const PARALLEL_BATCHES = 2;
const IMPORT_DIR = path.join(__dirname, '../imports/botsol/');

// Progress tracker
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

// Utility Functions
const ensureImportDirectory = async () => {
    try {
        await fs.promises.mkdir(IMPORT_DIR, { recursive: true });
    } catch (error) {
        botsolLogger.error('Error creating import directory:', error);
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
    botsolLogger.info('Reset import progress tracker');
};

const setImportRunning = (running) => {
    importProgressTracker.isRunning = running;
    botsolLogger.info(`Set import running status to: ${running}`);
};

const moveCompletedFile = async (filePath) => {
    try {
        const filename = path.basename(filePath);
        const today = new Date().toISOString().split('T')[0];
        const completedDir = path.join(IMPORT_DIR, `completed_${today}`);

        await fs.promises.mkdir(completedDir, { recursive: true });
        const newPath = path.join(completedDir, filename);
        await fs.promises.rename(filePath, newPath);

        botsolLogger.info(`Moved file ${filename} to completed directory`);
    } catch (error) {
        botsolLogger.error(`Failed to move file: ${error.message}`);
        throw error;
    }
};

// Domain validation utility
const isValidDomain = (domain) => {
    if (!domain || typeof domain !== 'string') return false;
    
    // Basic domain validation
    const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    return domainRegex.test(domain) && domain.length > 0 && domain.length <= 253;
};

// Phone utilities
const cleanPhoneNumber = (phone) => {
    if (!phone || typeof phone !== 'string') return null;

    let cleaned = phone.trim();

    // Handle scientific notation
    if (cleaned.match(/[Ee][+-]?\d+/)) {
        try {
            const number = parseFloat(cleaned);
            if (!isNaN(number)) {
                cleaned = Math.floor(number).toString();
            }
        } catch (error) {
            botsolLogger.warn(`Failed to parse scientific notation: ${cleaned}`);
        }
    }

    // Clean the phone number
    cleaned = cleaned.replace(/\s+/g, '')
        .replace(/-/g, '')
        .replace('+', '')
        .replace(/\./g, '')
        .replace(/[\(\)\[\]]/g, '')
        .replace(/[^0-9]/g, '');

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

const getAreaCode = (phone) => {
    const areaCode = areaCodes.find(area => phone.startsWith(area.code));
    return areaCode ? areaCode.areaName : null;
};

const isValidPhoneNumber = (phone, url) => {
    if (!phone || typeof phone !== 'string') return false;
    const cleanedPhone = cleanPhoneNumber(phone);
    return cleanedPhone ? cleanedPhone : false;
};

// Check if date is within 90 days
const isWithin90Days = (existingDate, newDate) => {
    const diffTime = Math.abs(newDate - existingDate);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays <= 90;
};

const processRecord = (record) => {
    try {
        // --- CLEANING UTILITIES ---
        const cleanText = (text) => {
            if (!text) return '';
            return text
                .replace(/jho/gi, '') //  Remove "jho"
                .replace(/[\x00-\x1F\x7F-\x9F]/g, '')
                .replace(/\s+/g, ' ')
                .trim()
                .substring(0, 400);
        };

        const trimUrl = (url) => {
            if (!url) return '';
            return url
                .replace(/^(https?:\/\/)/i, '')
                .replace(/^www\./i, '')
                .replace(/^([^/]+).*?$/, '$1');
        };

        const cleanSocialUrl = (url) => {
            if (!url) return '';
            return url.replace(/^(https?:\/\/)/i, '')
                .replace(/^www\./i, '').split('?')[0];
        };

        // --- FIELD PROCESSING ---
        const companyName = cleanText(record.Name);
        if (!companyName) {
            botsolLogger.debug(`Skipping record with no company name`);
            return null;
        }

        // Extract postcode from address
        const rawAddress = cleanText(record.Full_Address);
        let postcode = '';
        if (rawAddress) {
            const postcodeMatch = rawAddress.match(/[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}/i);
            if (postcodeMatch) {
                postcode = postcodeMatch[0].toUpperCase();
            }
        }

        // Remove postcode, then remove leading " and trailing <space>"
        let cleanAddress = rawAddress;
        if (cleanAddress && postcode) {
            cleanAddress = cleanAddress.replace(new RegExp(postcode, 'gi'), '');
        }
        
        if (cleanAddress) {
            cleanAddress = cleanAddress.replace(/^["\s]+|["\s]+$/g, '');
            // Cleanup extra commas or spaces
            cleanAddress = cleanAddress.replace(/,\s*,/g, ',')
                                       .replace(/^,\s*/, '')
                                       .replace(/\s*,$/, '')
                                       .trim();
        }

        const processedRecord = {
            company_name: companyName,
            postcode: postcode,
            url: record.Website ? trimUrl(record.Website) : '',
            date: new Date(),
            address: cleanAddress,
            email: cleanText(record.Email),
            facebook: cleanSocialUrl(record.Facebook),
            twitter: cleanSocialUrl(record.Twitter),
            instagram: cleanSocialUrl(record.Instagram),
            meta_description: cleanText(record.Description),
            phone: []
        };

        // Process phone number
        if (record.Phone) {
            const validPhone = isValidPhoneNumber(record.Phone, processedRecord.url);
            if (validPhone) {
                const areaCode = getAreaCode(validPhone);
                if (areaCode && validPhone.length === 11) {
                    processedRecord.phone.push({
                        number: validPhone,
                        areaName: areaCode
                    });
                }
            }
        }

        return processedRecord;
    } catch (error) {
        botsolLogger.error(`Error processing record: ${error.message}`);
        return null;
    }
};

// Batch processing with optimized memory usage
const insertBatch = async (batch, filename, processed) => {
    try {
        let upserted = 0;
        let modified = 0;

        // Deduplicate within the batch first (small memory footprint)
        const uniqueRecords = new Map();
        for (const doc of batch) {
            const key = `${doc.company_name}_${doc.postcode}`;
            if (!uniqueRecords.has(key)) {
                uniqueRecords.set(key, doc);
            } else {
                // If we have multiple records with same company+postcode in batch, 
                // keep the one with the most recent date
                const existing = uniqueRecords.get(key);
                if (doc.date > existing.date) {
                    uniqueRecords.set(key, doc);
                }
            }
        }

        // Bulk lookup existing records
        const uniqueKeys = Array.from(uniqueRecords.keys());
        const lookupQueries = uniqueKeys.map(key => {
            const [company_name, postcode] = key.split('_');
            return { company_name, postcode };
        });

        // Bulk find existing records
        const existingRecords = await Botsol.find({
            $or: lookupQueries
        }).lean();

        // Create a map for fast lookup - handle multiple records with same company+postcode
        const existingMap = new Map();
        existingRecords.forEach(record => {
            const key = `${record.company_name}_${record.postcode}`;
            // If multiple records exist with same company+postcode, keep the most recent one
            if (!existingMap.has(key) || record.date > existingMap.get(key).date) {
                existingMap.set(key, record);
            }
        });

        // Create operations for bulkWrite
        const operations = [];
        const processedKeys = new Set(); // Track keys we've already processed in this batch
        
        for (const [key, doc] of uniqueRecords) {
            // Skip if we've already processed this key in this batch
            if (processedKeys.has(key)) {
                continue;
            }
            processedKeys.add(key);
            
            const existingRecord = existingMap.get(key);

            if (existingRecord) {
                // Check if the existing record is within 90 days of the new record date
                const isWithin90 = isWithin90Days(existingRecord.date, doc.date);

                if (isWithin90) {
                    // Update existing record with new information
                    const updateData = {};

                    // Only update fields that have values
                    if (doc.url) updateData.url = doc.url;
                    if (doc.address) updateData.address = doc.address;
                    if (doc.email) updateData.email = doc.email;
                    if (doc.facebook) updateData.facebook = doc.facebook;
                    if (doc.twitter) updateData.twitter = doc.twitter;
                    if (doc.instagram) updateData.instagram = doc.instagram;
                    if (doc.meta_description) updateData.meta_description = doc.meta_description;

                    // Merge phone arrays
                    if (doc.phone && doc.phone.length > 0) {
                        const existingPhones = existingRecord.phone || [];
                        const newPhones = doc.phone;
                        const mergedPhones = [...existingPhones];

                        for (const newPhone of newPhones) {
                            const exists = mergedPhones.some(existing =>
                                existing.number === newPhone.number && existing.areaName === newPhone.areaName
                            );
                            if (!exists) {
                                mergedPhones.push(newPhone);
                            }
                        }
                        updateData.phone = mergedPhones;
                    }

                    if (Object.keys(updateData).length > 0) {
                        operations.push({
                            updateOne: {
                                filter: { _id: existingRecord._id },
                                update: { $set: updateData }
                            }
                        });
                        modified++;
                    }
                } else {
                    // Create new record if existing record is more than 90 days old
                    operations.push({
                        insertOne: {
                            document: doc
                        }
                    });
                    upserted++;
                }
            } else {
                // Create new record if no existing record found
                operations.push({
                    insertOne: {
                        document: doc
                    }
                });
                upserted++;
            }
        }

        // Execute bulk operations
        if (operations.length > 0) {
            const result = await Botsol.bulkWrite(operations, {
                ordered: false,
                writeConcern: { w: 1, j: true }
            });
        }

        importProgressTracker.upserted += upserted;
        importProgressTracker.modified += modified;
        importProgressTracker.processed = processed;

        return {
            success: true,
            upserted: upserted,
            modified: modified
        };
    } catch (error) {
        botsolLogger.error(`Error in insertBatch: ${error.message}`);
        importProgressTracker.errors.push({
            filename,
            error: error.message
        });
        throw error;
    }
};

const processBatchesInParallel = async (batches, filename, processed) => {
    try {
        let results = { upserted: 0, modified: 0 };

        // Process batches sequentially to prevent race conditions
        for (const batch of batches) {
            const result = await insertBatch(batch, filename, processed);
            results.upserted += result.upserted;
            results.modified += result.modified;
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        return results;
    } catch (error) {
        botsolLogger.error('Error processing batches:', error);
        throw error;
    }
};

// Main file processing
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

    // Try to get file creation date
    let fileDate = new Date();
    try {
        const stats = await fs.promises.stat(filePath);
        // Try different date properties in order of preference
        fileDate = stats.birthtime || stats.ctime || stats.mtime || new Date();
        
        // If we couldn't get a proper creation date, use modification time
        if (!stats.birthtime && stats.mtime) {
            fileDate = stats.mtime;
        }
    } catch (error) {
        botsolLogger.warn(`Could not get file creation date for ${filename}, using current date: ${error.message}`);
        fileDate = new Date();
    }

    return new Promise((resolve, reject) => {
        // First, read the file to understand its structure
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const lines = fileContent.split('\n').filter(line => line.trim());

        // Check if first line is sep=,
        let startIndex = 0;
        if (lines[0] && lines[0].includes('sep=')) {
            startIndex = 1;
        }

        // Parse headers from the appropriate line
        const headerLine = lines[startIndex];

        const parser = csv.parse({
            columns: false,
            skip_empty_lines: true,
            relax_column_count: true,
            relax_quotes: true,
            highWaterMark: 1024 * 1024,
            skip_records_with_error: true
        });

        let headers = null;
        let lineCount = 0;
        let headerFound = false;

        parser.on('readable', async () => {
            let record;
            while ((record = parser.read()) !== null) {
                lineCount++;
                try {
                    // Skip the sep=, line if it's the first line
                    if (lineCount === 1 && record && record.length === 1 && record[0] && record[0].includes('sep=')) {
                        continue;
                    }

                    // Find headers
                    if (!headerFound) {
                        // Check if this line contains header-like content
                        const headerText = record.join(' ').toLowerCase();
                        if (headerText.includes('name') || headerText.includes('address') || headerText.includes('website') || headerText.includes('phone')) {
                            headers = record;
                            headerFound = true;
                            continue;
                        }
                    }

                    // Process data rows
                    if (headers && headerFound) {
                        const processedRecord = processRecordWithHeaders(record, headers);
                        if (processedRecord) {
                            // Use file creation date if available
                            if (fileDate) {
                                processedRecord.date = fileDate;
                            }
                            
                            currentBatch.push(processedRecord);
                            processed++;
                            importProgressTracker.processed = processed;

                            if (currentBatch.length >= BATCH_SIZE) {
                                batches.push([...currentBatch]);
                                currentBatch = [];
                                if (batches.length >= PARALLEL_BATCHES) {
                                    const results = await processBatchesInParallel(batches, filename, processed);
                                    batches = [];
                                    await new Promise(resolve => setTimeout(resolve, 100));
                                }
                            }
                        }
                    }
                } catch (error) {
                    skippedLines++;
                    botsolLogger.error(`Skipping malformed line: ${error.message}`);
                    importProgressTracker.errors.push({
                        filename,
                        error: `Skipped malformed line: ${error.message}`
                    });
                }
            }
        });

        parser.on('end', async () => {
            try {
                if (currentBatch.length > 0) {
                    batches.push([...currentBatch]);
                }
                if (batches.length > 0) {
                    await processBatchesInParallel(batches, filename, processed);
                }

                if (skippedLines > 0) {
                    botsolLogger.info(`Completed processing ${filename}. Processed: ${processed}, Skipped: ${skippedLines} malformed lines`);
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
            const errorMessage = `CSV parsing error (continuing with valid lines): ${error.message}`;
            botsolLogger.warn(`Error in ${filename}: ${errorMessage}`);
            skippedLines++;
            importProgressTracker.errors.push({
                filename,
                error: errorMessage
            });
        });

        fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 })
            .pipe(parser);
    });
};

// Process record with explicit headers
const processRecordWithHeaders = (record, headers) => {
    try {
        // --- CLEANING UTILITIES ---
        const cleanText = (text) => {
            if (!text) return '';
            return text
                .replace(/jho/gi, '') // Remove "jho"
                .replace(/[\x00-\x1F\x7F-\x9F]/g, '')
                .replace(/\s+/g, ' ')
                .trim()
                .substring(0, 400);
        };

        const trimUrl = (url) => {
            if (!url) return '';
            return url
                .replace(/^(https?:\/\/)/i, '')
                .replace(/^www\./i, '')
                .replace(/^([^/]+).*?$/, '$1');
        };

        const cleanSocialUrl = (url) => {
            if (!url) return '';
            return url.replace(/^(https?:\/\/)/i, '')
                .replace(/^www\./i, '').split('?')[0];
        };

        // Create a record object using headers
        const recordObj = {};
        headers.forEach((header, index) => {
            recordObj[header] = record[index] || '';
        });

        // Get company name and postcode first
        const companyName = cleanText(recordObj.Name);
        if (!companyName) {
            botsolLogger.debug(`Skipping record with no company name`);
            return null;
        }

        // Extract postcode from address
        const rawAddress = cleanText(recordObj.Full_Address);
        let postcode = '';
        if (rawAddress) {
            const postcodeMatch = rawAddress.match(/[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}/i);
            if (postcodeMatch) {
                postcode = postcodeMatch[0].toUpperCase();
            }
        }

        if (!postcode) {
            return null;
        }

        // Clean address by removing the postcode and applying quote/space cleanup
        let cleanAddress = rawAddress;
        if (cleanAddress && postcode) {
            // Remove the postcode from the address
            cleanAddress = cleanAddress.replace(new RegExp(postcode, 'gi'), '');
            
            // Requirement: Remove leading " and trailing space + "
            cleanAddress = cleanAddress.replace(/^["\s]+|["\s]+$/g, '');
            
            // Clean up any extra commas or spaces
            cleanAddress = cleanAddress.replace(/,\s*,/g, ',')
                                       .replace(/^,\s*/, '')
                                       .replace(/\s*,$/, '')
                                       .trim();
        }

        const processedRecord = {
            company_name: companyName,
            postcode: postcode,
            url: recordObj.Website ? trimUrl(recordObj.Website) : '',
            date: new Date(),
            address: cleanAddress,
            email: cleanText(recordObj.Email),
            facebook: cleanSocialUrl(recordObj.Facebook),
            twitter: cleanSocialUrl(recordObj.Twitter),
            instagram: cleanSocialUrl(recordObj.Instagram),
            meta_description: cleanText(recordObj.Description),
            phone: []
        };

        // Process phone number
        if (recordObj.Phone) {
            const validPhone = isValidPhoneNumber(recordObj.Phone, processedRecord.url);
            if (validPhone) {
                const areaCode = getAreaCode(validPhone);
                if (areaCode && validPhone.length === 11) {
                    processedRecord.phone.push({
                        number: validPhone,
                        areaName: areaCode
                    });
                }
            }
        }

        return processedRecord;
    } catch (error) {
        botsolLogger.error(`Error processing record: ${error.message}`);
        return null;
    }
};

const getImportFiles = async () => {
    try {
        await ensureImportDirectory();
        botsolLogger.info('Reading import directory:', IMPORT_DIR);

        const files = await fs.promises.readdir(IMPORT_DIR);
        return files.filter(file => file.endsWith('.csv'));

    } catch (error) {
        botsolLogger.error('Error reading import directory:', error);
        return [];
    }
};

const getCollectionStats = async () => {
    return await Botsol.countDocuments();
};

const cleanDatabase = async () => {
    try {
        const duplicates = await Botsol.aggregate([
            {
                $project: {
                    url: { $trim: { input: { $ifNull: ["$url", ""] } } },
                    date: 1,
                    postcode: { $trim: { input: { $ifNull: ["$postcode", ""] } } },
                    company_name: { $trim: { input: { $toLower: { $ifNull: ["$company_name", ""] } } } },
                    address: { $trim: { input: { $ifNull: ["$address", ""] } } }
                }
            },
            { $sort: { date: -1 } },
            {
                $addFields: {
                    dedupeKey: {
                        $switch: {
                            branches: [
                                {
                                    case: { $gt: [{ $strLenCP: "$url" }, 0] },
                                    then: { $concat: ["URL|", "$url", "|", { $toString: "$date" }, "|", "$postcode"] }
                                },
                                {
                                    case: { $gt: [{ $strLenCP: "$postcode" }, 0] },
                                    then: { $concat: ["POST|", "$company_name", "|", { $toString: "$date" }, "|", "$postcode"] }
                                }
                            ],
                            default: { $concat: ["ADDR|", "$company_name", "|", { $toString: "$date" }, "|", "$address"] }
                        }
                    }
                }
            },
            { $group: { _id: "$dedupeKey", ids: { $push: "$_id" }, count: { $sum: 1 } } },
            { $match: { count: { $gt: 1 } } }
        ], { allowDiskUse: true });

        let allIdsToDelete = [];
        for (const group of duplicates) {
            allIdsToDelete.push(...group.ids.slice(1));
        }

        const chunkSize = 50000;
        let totalDeleted = 0;
        for (let i = 0; i < allIdsToDelete.length; i += chunkSize) {
            const chunk = allIdsToDelete.slice(i, i + chunkSize);
            const res = await Botsol.deleteMany({ _id: { $in: chunk } });
            totalDeleted += res.deletedCount;
        }
        
        botsolLogger.info(`Cleanup complete. Removed ${totalDeleted} duplicates.`);
        return { success: true, removedCount: totalDeleted };
    } catch (error) {
        botsolLogger.error(`Cleanup failed: ${error.message}`);
        throw error;
    }
};

const BotsolService = {
    getImportFiles,
    getCollectionStats,
    processFile,
    cleanDatabase,
    getImportProgress: () => ({ ...importProgressTracker }),
    resetImportProgress,
    setImportRunning
};

module.exports = {
    BotsolService,
    IMPORT_DIR
};
