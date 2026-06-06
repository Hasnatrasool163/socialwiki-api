// controllers/BotsolController.js
const { BotsolService, IMPORT_DIR } = require('../services/Botsol.service');
const path = require('path');
const Botsol = require('../models/Botsol');

const startImport = async (req, res) => {
    try {
        // Check if import is already running
        const currentProgress = BotsolService.getImportProgress();
        if (currentProgress.isRunning && !currentProgress.isComplete) {
            return res.status(409).json({
                success: false,
                message: 'Import is already running. Please wait for it to complete.'
            });
        }

        const files = await BotsolService.getImportFiles();

        if (files.length === 0) {
            return res.status(404).json({ message: 'No CSV files found to import' });
        }

        // Reset import progress before starting new import
        BotsolService.resetImportProgress();

        // Set import as running
        BotsolService.setImportRunning(true);

        // Start processing files asynchronously
        processFiles(files).catch(error => {
            console.error('Error processing files:', error);
            // Set import as not running on error
            BotsolService.setImportRunning(false);
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
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            try {
                const filePath = path.join(IMPORT_DIR, file);
                await BotsolService.processFile(filePath);
                
                // Check if import was marked as complete due to an error
                const progress = BotsolService.getImportProgress();
                if (progress && progress.isComplete && progress.errors.length > 0) {
                    // Only stop if there are fatal errors (not CSV parsing errors)
                    const hasFatalErrors = progress.errors.some(error => 
                        !error.error.includes('CSV parsing error') && 
                        !error.error.includes('Skipped malformed line') &&
                        !error.error.includes('Skipped') &&
                        !error.error.includes('continuing with valid lines')
                    );
                    
                    if (hasFatalErrors) {
                        break;
                    }
                }
            } catch (error) {
                console.error(`Error processing file ${i + 1}/${files.length} (${file}):`, error);

                // Check if this was a fatal error (not CSV parsing errors)
                if (error.message.includes('CSV parsing error') || error.message.includes('Quote Not Closed')) {
                    console.warn(`CSV parsing error detected, but continuing with other files`);
                    continue; // Continue with next file instead of stopping
                }

                // Continue with next file for non-fatal errors
                continue;
            }
        }

        // Mark overall import as complete when all files are done
        const progress = BotsolService.getImportProgress();
        if (progress) {
            progress.isComplete = true;
            progress.currentFile = null;
        }

        // Set import as not running
        BotsolService.setImportRunning(false);

    } catch (error) {
        console.error('Error in processFiles:', error);

        // Mark as complete with error
        const progress = BotsolService.getImportProgress();
        if (progress) {
            progress.isComplete = true;
            progress.errors.push(`Process failed: ${error.message}`);
        }

        // Set import as not running
        BotsolService.setImportRunning(false);

        throw error;
    }
};

const getStats = async (req, res) => {
    try {
        // Use estimatedDocumentCount instead of countDocuments for better performance
        const stats = await Botsol.estimatedDocumentCount();
        res.json({ success: true, stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

const getImportProgress = async (req, res) => {
    try {
        const progress = BotsolService.getImportProgress();
        res.json({
            success: true,
            data: progress
        });
    } catch (error) {
        console.error('Error getting import progress:', error);
        res.status(500).json({ success: false, error: 'Failed to get import progress' });
    }
};

const getPaginatedBotsols = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 100;
        const searchUrl = req.query.searchUrl?.toLowerCase() || '';
        const searchCompany = req.query.searchCompany?.toLowerCase() || '';
        const skip = (page - 1) * limit;
        
        // Cursor-based pagination parameters
        const cursor = req.query.cursor;
        const useCursorPagination = req.query.useCursor === 'true';

        // Build query with optimized search
        let query = {};
        let sort = { date: -1 };
        let projection = { 
            company_name: 1, 
            url: 1, 
            date: 1, 
            address: 1,
            email: 1, 
            phone: 1, 
            postcode: 1, 
            facebook: 1, 
            twitter: 1, 
            instagram: 1, 
            meta_description: 1, 
            is_blacklisted: 1 
        };
        
        if (searchUrl) {
            const isFullDomain = searchUrl.includes('.') && !searchUrl.includes(' ');
            
            if (isFullDomain) {
                query.url = searchUrl;
                sort = { date: -1 };
            } else {
                query.url = { $regex: '^' + searchUrl, $options: 'i' };
                sort = { date: -1 };
            }
        }

        if (searchCompany) {
            query.company_name = { $regex: searchCompany, $options: 'i' };
        }

        // Use cursor-based pagination for better performance on deep pages
        if (useCursorPagination && cursor) {
            query._id = { $lt: cursor };
        } else if (useCursorPagination && !cursor) {
            // First page with cursor pagination
        } else {
            // Traditional offset pagination
            if (skip > 1_000_000) {
                return res.status(400).json({
                    success: false,
                    error: 'Pagination offset too large. Please use cursor-based pagination (useCursor=true) for deep pages.'
                });
            }
        }

        let botsols;
        let total;

        if (useCursorPagination) {
            // Cursor-based pagination
            botsols = await Botsol.find(query)
                .select(projection)
                .sort(sort)
                .limit(limit + 1)
                .lean();

            const hasNextPage = botsols.length > limit;
            if (hasNextPage) {
                botsols.pop();
            }

            total = null;
        } else {
            // Traditional offset pagination
            botsols = await Botsol.find(query)
                .select(projection)
                .sort(sort)
                .skip(skip)
                .limit(limit)
                .lean();

            total = (searchUrl || searchCompany)
                ? await Botsol.countDocuments(query)
                : await Botsol.estimatedDocumentCount();
        }

        // Get cursor for next page
        const nextCursor = botsols.length > 0 ? botsols[botsols.length - 1]._id : null;

        res.json({
            success: true,
            data: botsols,
            pagination: useCursorPagination ? {
                hasNextPage: botsols.length === limit,
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
        console.error('Error fetching botsols:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

const stopImport = async (req, res) => {
    try {
        const currentProgress = BotsolService.getImportProgress();

        if (!currentProgress.isRunning || currentProgress.isComplete) {
            return res.status(400).json({
                success: false,
                message: 'No import is currently running.'
            });
        }

        // Set import as not running and complete
        BotsolService.setImportRunning(false);
        const progress = BotsolService.getImportProgress();
        if (progress) {
            progress.isComplete = true;
            progress.errors.push('Import was stopped by user');
        }

        res.json({
            success: true,
            message: 'Import stopped successfully'
        });
    } catch (error) {
        console.error('Error stopping import:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

const cleanData = async (req, res) => {
    try {
        const progress = BotsolService.getImportProgress();
        if (progress.isRunning) {
            return res.status(409).json({ 
                success: false, 
                message: 'An import is currently running. Please wait for it to finish.' 
            });
        }

        const result = await BotsolService.cleanDatabase();
        
        res.json({
            success: true,
            message: `Cleanup successful. ${result.removedCount} duplicates removed.`
        });
    } catch (error) {
        console.error('Error in cleanData controller:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

const BotsolController = {
    startImport,
    getStats,
    getImportProgress,
    getCleanData,
    getPaginatedBotsols,
    stopImport,
};

module.exports = {
    BotsolController
};
