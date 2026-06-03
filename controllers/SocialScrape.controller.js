// controllers/SocialScrapeController.js
const { SocialScrapeService, IMPORT_DIR, BLACKLIST_DIR, PHONE_DIR, phoneProgressStore } = require('../services/SocialScrape.service');
const path = require('path');
const SocialScrape = require('../models/SocialScrape');
// const { importEventEmitter, blacklistEventEmitter, phoneEventEmitter } = require('../services/SocialScrape.service');
const socialScrapeLogger = require('../config/socialScrapeLogger');
const { v4: uuidv4 } = require('uuid');


const startImport = async (req, res) => {
    try {
    
        // Check if import is already running
        const currentProgress = SocialScrapeService.getImportProgress();
        if (currentProgress.isRunning && !currentProgress.isComplete) {
            return res.status(409).json({
                success: false,
                message: 'Import is already running. Please wait for it to complete.'
            });
        }

        const files = await SocialScrapeService.getImportFiles();

        if (files.length === 0) {
            return res.status(404).json({ message: 'No CSV files found to import' });
        }

        // Reset import progress before starting new import
        SocialScrapeService.resetImportProgress();

        // Set import as running
        SocialScrapeService.setImportRunning(true);

        // Start processing files asynchronously
        processFiles(files).catch(error => {
            console.error('Error processing files:', error);
            // Set import as not running on error
            SocialScrapeService.setImportRunning(false);
        });

        res.json({
            success: true,
            message: 'Import started',
            files: files
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

const processFiles = async (files) => {
    try {
        socialScrapeLogger.info(`Starting to process ${files.length} files`);

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            try {
                socialScrapeLogger.info(`Processing file ${i + 1}/${files.length}: ${file}`);

                const filePath = path.join(IMPORT_DIR, file);
                await SocialScrapeService.processFile(filePath);

                socialScrapeLogger.info(`Completed processing file ${i + 1}/${files.length}: ${file}`);
                
                // Check if import was marked as complete due to an error
                const progress = SocialScrapeService.getImportProgress();
                if (progress && progress.isComplete && progress.errors.length > 0) {
                    // Only stop if there are fatal errors (not CSV parsing errors)
                    const hasFatalErrors = progress.errors.some(error => 
                        !error.error.includes('CSV parsing error') && 
                        !error.error.includes('Skipped malformed line') &&
                        !error.error.includes('Skipped') &&
                        !error.error.includes('continuing with valid lines')
                    );
                    
                    if (hasFatalErrors) {
                        socialScrapeLogger.info(`Import marked as complete with fatal errors, stopping file processing`);
                        break;
                    }
                }
            } catch (error) {
                socialScrapeLogger.error(`Error processing file ${i + 1}/${files.length} (${file}):`, error);

                // Check if this was a fatal error (not CSV parsing errors)
                if (error.message.includes('CSV parsing error') || error.message.includes('Quote Not Closed')) {
                    socialScrapeLogger.warn(`CSV parsing error detected, but continuing with other files`);
                    continue; // Continue with next file instead of stopping
                }

                // Continue with next file for non-fatal errors
                continue;
            }
        }

        // Mark overall import as complete when all files are done
        const progress = SocialScrapeService.getImportProgress();
        if (progress) {
            progress.isComplete = true;
            progress.currentFile = null;
            socialScrapeLogger.info(`Completed processing all ${files.length} files`);
            // importEventEmitter.emit('progress', { ...progress });
        }

        // Set import as not running
        SocialScrapeService.setImportRunning(false);

    } catch (error) {
        socialScrapeLogger.error('Error in processFiles:', error);

        // Mark as complete with error
        const progress = SocialScrapeService.getImportProgress();
        if (progress) {
            progress.isComplete = true;
            progress.errors.push(`Process failed: ${error.message}`);
            // importEventEmitter.emit('progress', { ...progress });
        }

        // Set import as not running
        SocialScrapeService.setImportRunning(false);

        throw error;
    }
};

const getStats = async (req, res) => {
    try {
        // Use estimatedDocumentCount instead of countDocuments for better performance
        const stats = await SocialScrape.estimatedDocumentCount();
        res.json({ success: true, stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

const getBlacklistedCount = async (req,res) => {
    try {
        // OPTIMIZATION: Use the most efficient query approach with is_blacklisted index
        // 
        // Performance benefits with index:
        // 1. Direct index scan - fastest possible query
        // 2. No aggregation overhead - pure counting
        // 3. Leverages the is_blacklisted:1 index directly
        // 4. Should be 100-1000x faster than before for 50M+ records
        //
        // Using countDocuments with proper hint to force index usage
        const count = await SocialScrape.countDocuments(
            { is_blacklisted: true },
            { 
                hint: { is_blacklisted: 1 },  // Force index usage
                maxTimeMS: 10000               // 10 second timeout for safety
            }
        );
        
        res.json({ success: true, count });
    } catch (error) {
        // If index hint fails, try without hint
        try {
            const count = await SocialScrape.countDocuments({ is_blacklisted: true });
            res.json({ success: true, count });
        } catch (fallbackError) {
            res.status(500).json({ success: false, error: fallbackError.message });
        }
    }
};

const getImportProgress = async (req, res) => {
    try {
        const progress = SocialScrapeService.getImportProgress();
        res.json({
            success: true,
            data: progress
        });
    } catch (error) {
        socialScrapeLogger.error('Error getting import progress:', error);
        res.status(500).json({ success: false, error: 'Failed to get import progress' });
    }
};

const getBlacklistProgress = async (req, res) => {
    try {
        const { processId } = req.query;
        if (!processId) {
            return res.status(400).json({ error: 'Process ID is required' });
        }

        const progress = SocialScrapeService.getBlacklistProgress(processId);
        if (!progress) {
            return res.status(404).json({ error: 'Process not found' });
        }

        res.json(progress);
    } catch (error) {
        socialScrapeLogger.error('Error getting blacklist progress:', error);
        res.status(500).json({ error: 'Failed to get blacklist progress' });
    }
};

const getPaginatedSocialScrapes = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 100;
        const searchUrl = req.query.searchUrl?.toLowerCase() || '';
        const skip = (page - 1) * limit;
        
        // Cursor-based pagination parameters
        const cursor = req.query.cursor; // Last document ID from previous page
        const useCursorPagination = req.query.useCursor === 'true';

        // Build query with optimized search
        let query = {};
        let sort = { date: -1 };
        let projection = { 
            url: 1, 
            date: 1, 
            title: 1, 
            twitter: 1, 
            facebook: 1, 
            instagram: 1, 
            linkedin: 1, 
            youtube: 1, 
            pinterest: 1, 
            email: 1, 
            phone: 1, 
            postcode: 1, 
            statusCode: 1, 
            redirect_url: 1, 
            meta_description: 1, 
            is_blacklisted: 1 
        };
        
        if (searchUrl) {
            // Check if it looks like a full domain (contains dot and no spaces)
            const isFullDomain = searchUrl.includes('.') && !searchUrl.includes(' ');
            
            if (isFullDomain) {
                // For full domains, use exact match (fastest)
                query.url = searchUrl;
                sort = { date: -1 };
            } else {
                // For partial searches, use prefix search
                query.url = { $regex: '^' + searchUrl, $options: 'i' };
                sort = { date: -1 };
            }
        }

        // Use cursor-based pagination for better performance on deep pages
        if (useCursorPagination && cursor) {
            // Add cursor condition to query
            query._id = { $lt: cursor };
        } else if (useCursorPagination && !cursor) {
            // First page with cursor pagination
            // No additional query conditions needed
        } else {
            // Traditional offset pagination
            // Protect against huge skips
            if (skip > 1_000_000) {
                return res.status(400).json({
                    success: false,
                    error: 'Pagination offset too large. Please use cursor-based pagination (useCursor=true) for deep pages.'
                });
            }
        }

        let socialScrapes;
        let total;

        if (useCursorPagination) {
            // Cursor-based pagination (much faster for deep pages)
            socialScrapes = await SocialScrape.find(query)
                .select(projection)
                .sort(sort)
                .limit(limit + 1) // Get one extra to check if there are more pages
                .lean();

            // Check if there are more pages
            const hasNextPage = socialScrapes.length > limit;
            if (hasNextPage) {
                socialScrapes.pop(); // Remove the extra item
            }

            // For cursor pagination, we don't need total count (expensive operation)
            total = null;
        } else {
            // Traditional offset pagination
            socialScrapes = await SocialScrape.find(query)
                .select(projection)
                .sort(sort)
                .skip(skip)
                .limit(limit)
                .lean();

            total = searchUrl
                ? await SocialScrape.countDocuments(query)
                : await SocialScrape.estimatedDocumentCount();
        }

        // Get cursor for next page
        const nextCursor = socialScrapes.length > 0 ? socialScrapes[socialScrapes.length - 1]._id : null;

        res.json({
            success: true,
            data: socialScrapes,
            pagination: useCursorPagination ? {
                hasNextPage: socialScrapes.length === limit,
                nextCursor,
                limit
            } : {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Error fetching social scrapes:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
};


const processBlacklistFiles = async (files, urlColumn, processId) => {
    for (const file of files) {
        const filePath = path.join(BLACKLIST_DIR, file);
        await SocialScrapeService.processBlacklistFile(filePath, urlColumn, processId);
    }
};

const updateBlacklist = async (req, res) => {
    try {
        const { urlColumn = 1 } = req.body; // Default to first column if not specified

        const files = await SocialScrapeService.getBlacklistFiles();

        if (files.length === 0) {
            return res.status(404).json({ message: 'No CSV files found in blacklist directory' });
        }

        // Generate a unique process ID
        const processId = uuidv4();

        // Start processing files asynchronously
        processBlacklistFiles(files, urlColumn, processId).catch(error => {
            socialScrapeLogger.error('Error processing blacklist files:', error);
            const progress = SocialScrapeService.getBlacklistProgress(processId);
            if (progress) {
                progress.errors.push(error.message);
                progress.isComplete = true;
                // blacklistEventEmitter.emit('progress', { processId, ...progress });
            }
        });

        res.json({
            success: true,
            message: 'Blacklist update started',
            processId,
            files: files
        });
    } catch (error) {
        socialScrapeLogger.error('Error starting blacklist update:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

const getProgress = async (req, res) => {
    try {
        const progress = SocialScrapeService.getProgress();
        res.json(progress);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

const updatePhoneNumber = async (req, res) => {
    try {
        const files = await SocialScrapeService.getPhoneFiles();

        if (files.length === 0) {
            return res.status(404).json({ message: 'No CSV files found in phone directory' });
        }

        // Generate a unique process ID
        const processId = uuidv4();

        // Initialize progress tracker BEFORE starting async processing
        const initialProgress = {
            currentFile: null,
            processed: 0,
            total: 0,
            updated: 0,
            created: 0,
            errors: [],
            isComplete: false,
            totalFiles: files.length,
            completedFiles: 0,
            lastUpdated: Date.now()
        };

        // Store the initial progress tracker
        phoneProgressStore.set(processId, initialProgress);

        socialScrapeLogger.info(`Initialized progress tracker for ${processId}: totalFiles=${files.length}`);

        // Start processing files asynchronously
        processPhoneFiles(files, processId).catch(error => {
            socialScrapeLogger.error('Error processing phone files:', error);
            const progress = SocialScrapeService.getPhoneProgress(processId);
            if (progress) {
                progress.errors.push(error.message);
                progress.isComplete = true;
                // phoneEventEmitter.emit('progress', { processId, ...progress });
            }
        });

        res.json({
            success: true,
            message: 'Phone number update started',
            processId,
            files: files
        });
    } catch (error) {
        socialScrapeLogger.error('Error starting phone number update:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

const processPhoneFiles = async (files, processId) => {
    try {
        socialScrapeLogger.info(`Starting phone processing for ${files.length} files with process ID: ${processId}`);

        // Get the existing progress tracker (already initialized in updatePhoneNumber)
        const progress = SocialScrapeService.getPhoneProgress(processId);
        if (!progress) {
            socialScrapeLogger.error(`No progress tracker found for process ID: ${processId}`);
            throw new Error('Progress tracker not found');
        }

        socialScrapeLogger.info(`Using existing progress tracker for ${processId}: totalFiles=${progress.totalFiles}`);

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            try {
                socialScrapeLogger.info(`Processing phone file ${i + 1}/${files.length}: ${file}`);
                const filePath = path.join(PHONE_DIR, file);
                await SocialScrapeService.processPhoneFile(filePath, processId);
                socialScrapeLogger.info(`Completed processing phone file ${i + 1}/${files.length}: ${file}`);

                // Log progress after each file
                const currentProgress = SocialScrapeService.getPhoneProgress(processId);
                if (currentProgress) {
                    socialScrapeLogger.info(`Progress after file ${file}: completedFiles=${currentProgress.completedFiles}/${currentProgress.totalFiles}, processed=${currentProgress.processed}, updated=${currentProgress.updated}, created=${currentProgress.created}`);
                }
            } catch (error) {
                socialScrapeLogger.error(`Error processing phone file ${i + 1}/${files.length} (${file}):`, error);

                // Update progress with error
                const progress = SocialScrapeService.getPhoneProgress(processId);
                if (progress) {
                    progress.errors.push(`Failed to process file ${file}: ${error.message}`);
                    // completedFiles is already incremented in the service
                }

                // Continue with next file instead of stopping completely
                continue;
            }
        }

        // Mark process as complete when all files are done
        const finalProgress = SocialScrapeService.getPhoneProgress(processId);
        if (finalProgress) {
            // Only set completion if not already complete
            if (!finalProgress.isComplete) {
                finalProgress.isComplete = true;
                finalProgress.currentFile = null; // Clear current file when complete
                socialScrapeLogger.info(`Completed phone processing for all files with process ID: ${processId}. Total files: ${finalProgress.totalFiles}, Completed files: ${finalProgress.completedFiles}`);
                socialScrapeLogger.info(`Final stats - Processed: ${finalProgress.processed}, Updated: ${finalProgress.updated}, Created: ${finalProgress.created}, Errors: ${finalProgress.errors.length}`);

                // Emit final progress update
                // phoneEventEmitter.emit('progress', { processId, ...finalProgress });
            } else {
                socialScrapeLogger.info(`Process ${processId} was already marked as complete by service`);
            }
        } else {
            socialScrapeLogger.error(`No progress tracker found for process ID: ${processId} at completion`);
        }

    } catch (error) {
        socialScrapeLogger.error('Error in processPhoneFiles:', error);

        // Mark process as complete with error
        const progress = SocialScrapeService.getPhoneProgress(processId);
        if (progress) {
            progress.isComplete = true;
            progress.errors.push(`Process failed: ${error.message}`);
            // phoneEventEmitter.emit('progress', { processId, ...progress });
        }

        throw error;
    }
};

const getPhoneProgress = async (req, res) => {
    try {
        const { processId } = req.query;
        if (!processId) {
            return res.status(400).json({ error: 'Process ID is required' });
        }

        // socialScrapeLogger.info(`Getting phone progress for process ID: ${processId}`);

        const progress = SocialScrapeService.getPhoneProgress(processId);
        if (!progress) {
            socialScrapeLogger.warn(`No progress found for process ID: ${processId}`);
            return res.status(404).json({ error: 'Process not found' });
        }

        // socialScrapeLogger.info(`Phone progress for ${processId}:`, {
        //     currentFile: progress.currentFile,
        //     processed: progress.processed,
        //     total: progress.total,
        //     updated: progress.updated,
        //     created: progress.created,
        //     errors: progress.errors.length,
        //     isComplete: progress.isComplete,
        //     totalFiles: progress.totalFiles,
        //     completedFiles: progress.completedFiles
        // });

        res.json(progress);
    } catch (error) {
        socialScrapeLogger.error('Error getting phone progress:', error);
        res.status(500).json({ error: 'Failed to get phone progress' });
    }
};



const stopImport = async (req, res) => {
    try {
        const currentProgress = SocialScrapeService.getImportProgress();

        if (!currentProgress.isRunning || currentProgress.isComplete) {
            return res.status(400).json({
                success: false,
                message: 'No import is currently running.'
            });
        }

        // Set import as not running and complete
        SocialScrapeService.setImportRunning(false);
        const progress = SocialScrapeService.getImportProgress();
        if (progress) {
            progress.isComplete = true;
            progress.errors.push('Import was stopped by user');
            // importEventEmitter.emit('progress', { ...progress });
        }

        res.json({
            success: true,
            message: 'Import stopped successfully'
        });
    } catch (error) {
        socialScrapeLogger.error('Error stopping import:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

const stopPhoneProcessing = async (req, res) => {
    try {
        const { processId } = req.body;
        if (!processId) {
            return res.status(400).json({ error: 'Process ID is required' });
        }

        const progress = SocialScrapeService.getPhoneProgress(processId);
        if (!progress) {
            return res.status(404).json({ error: 'Process not found' });
        }

        if (progress.isComplete) {
            return res.status(400).json({
                success: false,
                message: 'Process is already complete.'
            });
        }

        // Mark process as complete and stopped
        progress.isComplete = true;
        progress.currentFile = null;
        progress.errors.push('Process was stopped by user');

        // Update the progress tracker
        SocialScrapeService.updateProgressTracker(processId, progress);

        // Emit progress update
        // phoneEventEmitter.emit('progress', { processId, ...progress });

        res.json({
            success: true,
            message: 'Phone processing stopped successfully'
        });
    } catch (error) {
        socialScrapeLogger.error('Error stopping phone processing:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

const SocialScrapeController = {
    startImport,
    getStats,
    getImportProgress,
    getBlacklistProgress,
    getPhoneProgress,
    getPaginatedSocialScrapes,
    getBlacklistedCount,
    updateBlacklist,
    getProgress,
    updatePhoneNumber,
    stopPhoneProcessing,
    stopImport,

};

module.exports = {
    SocialScrapeController
};