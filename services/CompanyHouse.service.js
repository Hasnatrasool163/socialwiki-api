// services/CompanyHouse.service.js
// Use the named `parse` export from csv-parse to create a streaming parser
const { parse } = require('csv-parse');
const fs = require('fs');
const path = require('path');
const CompanyHouse = require('../models/CompanyHouse');
const companyHouseLogger = require('../config/loggers/companyHouseLogger');
const { archiveFile } = require('../utils/fileUtils');

// Configuration
// Reduced batch size for better memory and GC behavior
const BATCH_SIZE = 2000;
// Number of batches to process in parallel (bounded concurrency)
const PARALLEL_BATCHES = 2;
const IMPORT_DIR = path.join(__dirname, '../imports/company_house/');

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
        companyHouseLogger.error('Error creating import directory:', error);
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
    companyHouseLogger.info('Reset import progress tracker');
};


const setImportRunning = (running) => {
    importProgressTracker.isRunning = running;
    companyHouseLogger.info(`Set import running status to: ${running}`);
};


const moveCompletedFile = async (filePath) => {
    try {
        const filename = path.basename(filePath);
        const today = new Date().toISOString().split('T')[0];
        const completedDir = path.join(IMPORT_DIR, `completed_${today}`);

        await fs.promises.mkdir(completedDir, { recursive: true });
        const newPath = path.join(completedDir, filename);
        await fs.promises.rename(filePath, newPath);

        companyHouseLogger.info(`Moved file ${filename} to completed directory`);
    } catch (error) {
        companyHouseLogger.error(`Error moving file: ${error.message}`);
        throw error;
    }
};

// Helper function to parse date in d/m/Y format
const parseDate = (dateString) => {
    if (!dateString || dateString.trim() === '') return null;
    
    // Parse date in d/m/Y format (e.g., "15/03/2020")
    const dateParts = dateString.split('/');
    if (dateParts.length === 3) {
        const [day, month, year] = dateParts;
        const date = new Date(year, month - 1, day); // month is 0-indexed
        
        // Validate the date
        if (!isNaN(date.getTime())) {
            return dateString; // Return original format for consistency with PHP
        }
    }
    return null;
};

// Clean and validate company data
const cleanText = (text) => {
    if (!text) return '';
    return text.toString().trim();
};

// Process a single CSV record into CompanyHouse format
const processRecord = (record, index) => {
    try {
        
        const companyName = cleanText(record[0] || record.CompanyName);
        const companyNumber = cleanText(record[1] || record.CompanyNumber);

        // Basic validation
        if (!companyName || !companyNumber) {
            companyHouseLogger.warn(`Skipping record ${index}: Missing required fields (CompanyName: ${companyName}, CompanyNumber: ${companyNumber})`);
            return null;
        }

        const processedRecord = {
            CompanyName: companyName,
            CompanyNumber: companyNumber,
            RegAddress: {
                AddressLine1: cleanText(record[4] || record.AddressLine1),
                AddressLine2: cleanText(record[5] || record.AddressLine2),
                PostTown: cleanText(record[6] || record.PostTown),
                County: cleanText(record[7] || record.County),
                PostCode: cleanText(record[9] || record.PostCode)
            },
            CompanyStatus: cleanText(record[11] || record.CompanyStatus),
            IncorporationDate: parseDate(record[14] || record.IncorporationDate)
        };

        return processedRecord;
    } catch (error) {
        companyHouseLogger.error(`Error processing record ${index}: ${error.message}`);
        return null;
    }
};

// Process CSV file
const processFile = async (filePath) => {
    return new Promise((resolve, reject) => {
        const filename = path.basename(filePath);
        const records = [];
        let processedCount = 0;
        let skippedLines = 0;
        
        companyHouseLogger.info(`Starting to process file: ${filename}`);
        importProgressTracker.currentFile = filename;

        const parser = parse({
            columns: false, // Don't use headers as column names, use array indices
            skip_empty_lines: true,
            trim: true,
            from_line: 2, // Skip header row 
            relax_column_count: true
        });

        parser.on('readable', function () {
            let record;
            while ((record = parser.read()) !== null) {
                const processedRecord = processRecord(record, processedCount);
                if (processedRecord) {
                    records.push(processedRecord);
                } else {
                    skippedLines++;
                }
                processedCount++;
            }
        });

        parser.on('error', function (error) {
            const errorMessage = `CSV parsing error (continuing with valid lines): ${error.message}`;
            companyHouseLogger.warn(`Error in ${filename}: ${errorMessage}`);

            skippedLines++;
            importProgressTracker.errors.push({
                filename,
                error: errorMessage
            });
        });

        parser.on('end', async function () {
            try {
                companyHouseLogger.info(`Parsed ${records.length} valid records from ${filename} (skipped ${skippedLines} invalid lines)`);
                // Set total so frontend can compute progress percentage
                importProgressTracker.total = records.length;
                
                if (records.length === 0) {
                    companyHouseLogger.warn(`No valid records found in ${filename}`);
                    await moveCompletedFile(filePath);
                    resolve({ processed: 0, upserted: 0, modified: 0 });
                    return;
                }

                // Process records in batches
                let totalUpserted = 0;
                let totalModified = 0;

                // Convert records array into batches queue
                const batches = [];
                for (let i = 0; i < records.length; i += BATCH_SIZE) {
                    batches.push(records.slice(i, i + BATCH_SIZE));
                }

                // Simple bounded concurrency worker
                let active = 0;
                let idx = 0;
                const results = { upserted: 0, modified: 0 };

                const runNext = async () => {
                    if (idx >= batches.length) return;
                    const batch = batches[idx++];
                    active++;
                    const start = Date.now();
                    try {
                        const bulkOps = batch.map(doc => ({
                            updateOne: {
                                filter: { CompanyNumber: doc.CompanyNumber },
                                update: { $set: doc },
                                upsert: true
                            }
                        }));

                        // Use unordered bulkWrite with relaxed writeConcern for throughput
                        const result = await CompanyHouse.bulkWrite(bulkOps, {
                            ordered: false,
                            writeConcern: { w: 1 },
                            bypassDocumentValidation: true
                        });

                        const elapsed = Date.now() - start;
                        const up = result.upsertedCount || 0;
                        const mod = result.modifiedCount || 0;

                        results.upserted += up;
                        results.modified += mod;

                        importProgressTracker.processed += batch.length;
                        importProgressTracker.upserted += up;
                        importProgressTracker.modified += mod;

                        companyHouseLogger.info(`Batch processed (size=${batch.length}) upserted=${up} modified=${mod} time=${elapsed}ms`);
                    } catch (err) {
                        companyHouseLogger.error(`Error processing batch in ${filename}: ${err.message}`);
                        importProgressTracker.errors.push({ filename, error: `Batch processing error: ${err.message}` });
                        // On duplicate key errors, try individual upserts
                        if (err && err.code === 11000) {
                            companyHouseLogger.warn('Duplicate key error encountered, retrying batch item-by-item');
                            for (const doc of batch) {
                                try {
                                    const r = await CompanyHouse.updateOne({ CompanyNumber: doc.CompanyNumber }, { $set: doc }, { upsert: true });
                                    if (r.upsertedCount && r.upsertedCount > 0) results.upserted++;
                                    if (r.modifiedCount && r.modifiedCount > 0) results.modified++;
                                } catch (uerr) {
                                    companyHouseLogger.warn(`Failed individual upsert for ${doc.CompanyNumber}: ${uerr.message}`);
                                    importProgressTracker.errors.push({ filename, error: `Failed upsert ${doc.CompanyNumber}: ${uerr.message}` });
                                }
                            }
                        }
                    } finally {
                        active--;
                        // Start next batch if any
                        if (idx < batches.length) {
                            // If we have spare capacity, start another
                            if (active < PARALLEL_BATCHES) runNext();
                        }
                    }
                };

                // Start initial workers
                const starters = Math.min(PARALLEL_BATCHES, batches.length);
                const starterPromises = [];
                for (let s = 0; s < starters; s++) {
                    starterPromises.push(runNext());
                }

                // Wait until all batches processed
                while (idx < batches.length || active > 0) {
                    // small delay to avoid busy loop
                    // eslint-disable-next-line no-await-in-loop
                    await new Promise(res => setTimeout(res, 100));
                }

                totalUpserted += results.upserted;
                totalModified += results.modified;

                await moveCompletedFile(filePath);
                
                companyHouseLogger.info(`Completed processing ${filename}: ${totalUpserted} upserted, ${totalModified} modified`);
                resolve({ processed: records.length, upserted: totalUpserted, modified: totalModified });

            } catch (error) {
                companyHouseLogger.error(`Error saving records from ${filename}: ${error.message}`);
                importProgressTracker.errors.push({
                    filename,
                    error: `Database error: ${error.message}`
                });
                reject(error);
            }
        });

        // Use streams with smaller chunks for better memory management
        fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 }) // 1MB chunks
            .pipe(parser);
    });
};

const getImportFiles = async () => {
    try {
        await ensureImportDirectory();
        companyHouseLogger.info('Reading import directory:', IMPORT_DIR);

        const files = await fs.promises.readdir(IMPORT_DIR);
        return files.filter(file => file.endsWith('.csv'));

    } catch (error) {
        companyHouseLogger.error('Error reading import directory:', error);
        return [];
    }
};

const getCollectionStats = async () => {
    return await CompanyHouse.countDocuments();
};

const CompanyHouseService = {
    processFile,
    getImportFiles,
    getCollectionStats,
    getImportProgress: () => ({ ...importProgressTracker }),
    resetImportProgress,
    setImportRunning
};

module.exports = {
    CompanyHouseService,
    IMPORT_DIR
};