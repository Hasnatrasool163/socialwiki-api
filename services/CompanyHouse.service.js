// services/CompanyHouse.service.js
// Use the named `parse` export from csv-parse to create a streaming parser
const { parse } = require('csv-parse');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const CompanyHouse = require('../models/CompanyHouse');
const companyHouseLogger = require('../config/loggers/companyHouseLogger');
const { archiveFile } = require('../utils/fileUtils');

// Configuration
// Reduced batch size for better memory and GC behavior
const BATCH_SIZE = 4000;
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
    const filename = path.basename(filePath);
    let processedCount = 0;
    let skippedLines = 0;
    let batch = [];
    let totalInserted = 0;

    companyHouseLogger.info(`Starting to process file: ${filename}`);
    importProgressTracker.currentFile = filename;

    try {
        const db = mongoose.connection.db;
        const currentCollectionName = CompanyHouse.collection.name;
        const tempCollectionName = `${currentCollectionName}_tmp`;
        const oldCollectionName = `${currentCollectionName}_old`;

        // 1. GET BASELINE FOR SANITY CHECK
        const previousCount = await CompanyHouse.countDocuments();
        companyHouseLogger.info(`Baseline check: Live collection currently has ${previousCount} documents.`);

        // 2. SETUP TEMPORARY COLLECTION & INDEXES
	delete mongoose.models['CompanyHouseTmp'];
	const TempCompanyHouse = mongoose.model('CompanyHouseTmp', CompanyHouse.schema, tempCollectionName);


        companyHouseLogger.info(`Preparing temporary collection (${tempCollectionName})...`);
        await db.collection(tempCollectionName).drop().catch(() => {}); // Ensure completely clean slate
        await TempCompanyHouse.createCollection();
        await TempCompanyHouse.syncIndexes(); // Ensures queries stay fast after the swap

        const parser = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 })
            .pipe(parse({
                columns: false,
                skip_empty_lines: true,
                trim: true,
                from_line: 2, 
                relax_column_count: true
            }));

        // 3. PROCESS ON-THE-FLY
        for await (const record of parser) {
            const processedRecord = processRecord(record, processedCount);
            
            if (processedRecord) {
                batch.push(processedRecord);
            } else {
                skippedLines++;
            }
            
            processedCount++;
            importProgressTracker.processed = processedCount;

            // Progress Logging (Visibility for 2.7GB file)
            if (processedCount % 100000 === 0) {
                companyHouseLogger.info(`Processed ${processedCount.toLocaleString()} rows...`);
            }

            // 4. INSERT BATCH
            if (batch.length >= BATCH_SIZE) {
                try {
                    const result = await TempCompanyHouse.insertMany(batch, { ordered: false });
                    totalInserted += result.length;
                } catch (err) {
                    const insertedThisBatch = err.insertedDocs ? err.insertedDocs.length : (err.insertedCount || 0);
                    totalInserted += insertedThisBatch;
                    companyHouseLogger.warn(`Batch warning: Inserted ${insertedThisBatch}/${batch.length}. Error: ${err.message}`);
                }
                importProgressTracker.upserted = totalInserted;
                batch = []; 
            }
        }

        // 5. INSERT REMAINING RECORDS
        if (batch.length > 0) {
            try {
                const result = await TempCompanyHouse.insertMany(batch, { ordered: false });
                totalInserted += result.length;
            } catch (err) {
                const insertedThisBatch = err.insertedDocs ? err.insertedDocs.length : (err.insertedCount || 0);
                totalInserted += insertedThisBatch;
            }
            importProgressTracker.upserted = totalInserted;
        }

        // 6. VALIDATE IMPORT COMPLETION
        const finalTempCount = await TempCompanyHouse.countDocuments();
        companyHouseLogger.info(`Temp collection contains ${finalTempCount} documents. Tracked inserts: ${totalInserted}`);

        if (Math.abs(finalTempCount - totalInserted) > 100) {
            throw new Error(`Inserted count mismatch! Expected around ${totalInserted}, but DB has ${finalTempCount}.`);
        }

        // Sanity Check: Ensure we didn't just import a broken/empty file
        if (previousCount > 0 && finalTempCount < previousCount * 0.9) {
            throw new Error(`Import aborted to protect live data. Imported count (${finalTempCount}) is suspiciously lower than previous month (${previousCount}).`);
        }

        // 7. ATOMIC SWAP (Safe Rename)
	companyHouseLogger.info(`Import validated. Performing atomic collection swap...`);

try {
    // 1. Rename existing live to old (Backup)
    await db.collection(currentCollectionName).rename(oldCollectionName, { dropTarget: true });

    try {
        // 2. Rename temp to live
        await db.collection(tempCollectionName).rename(currentCollectionName);
    } catch (renameErr) {
        // ROLLBACK: If step 2 fails, put the backup back to live
        companyHouseLogger.error(`CRITICAL: Rename failed! Rolling back backup...`);
        await db.collection(oldCollectionName).rename(currentCollectionName);
        throw new Error(`Swap failed. Rollback executed: ${renameErr.message}`);
    }
} catch (err) {
    throw new Error(`Collection swap failed: ${err.message}`);
}
        
        companyHouseLogger.info(`Collection swap successful! Processed ${processedCount} rows. Removed ${skippedLines} invalid lines.`);
        
        importProgressTracker.total = processedCount;
        await moveCompletedFile(filePath);

        return { 
            processed: processedCount, 
            inserted: finalTempCount, 
            modified: 0 
        };

    } catch (error) {
        companyHouseLogger.error(`Critical Error processing ${filename}: ${error.message}`);
        importProgressTracker.errors.push({
            filename,
            error: `Critical error: ${error.message}`
        });
        throw error; // Rethrow to let the controller handle the failure
    }
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
