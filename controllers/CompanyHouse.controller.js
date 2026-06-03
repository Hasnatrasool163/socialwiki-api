// controllers/CompanyHouse.controller.js
const { CompanyHouseService, IMPORT_DIR } = require('../services/CompanyHouse.service');
const path = require('path');
const CompanyHouse = require('../models/CompanyHouse');
const companyHouseLogger = require('../config/loggers/companyHouseLogger');

const startImport = async (req, res) => {
    try {
        // Check if import is already running
        const currentProgress = CompanyHouseService.getImportProgress();
        if (currentProgress.isRunning && !currentProgress.isComplete) {
            return res.status(409).json({
                success: false,
                message: 'Import is already running. Please wait for it to complete.'
            });
        }

        const files = await CompanyHouseService.getImportFiles();
            // Limit the number of files to process in a single run to avoid overload
            const MAX_FILES_PER_RUN = 1000;
            let filesToProcess = files;
            if (files.length > MAX_FILES_PER_RUN) {
                companyHouseLogger.warn(`Found ${files.length} files, limiting to first ${MAX_FILES_PER_RUN} files for this run`);
                filesToProcess = files.slice(0, MAX_FILES_PER_RUN);
            }
        if (files.length === 0) {
            return res.status(404).json({ 
                success: false,
                message: 'No CSV files found to import' 
            });
        }

        // Reset import progress before starting new import
        CompanyHouseService.resetImportProgress();

        // Set import as running
        CompanyHouseService.setImportRunning(true);

        // Start processing files asynchronously
        processFiles(filesToProcess).catch(error => {
            companyHouseLogger.error('Error processing files:', error);
            // Set import as not running on error
            CompanyHouseService.setImportRunning(false);
        });

        res.json({
            success: true,
            message: 'Import started',
            files: filesToProcess,
            totalFound: files.length,
            limitedTo: filesToProcess.length
        });
    } catch (error) {
        companyHouseLogger.error('Error starting import:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

const processFiles = async (files) => {
    try {
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            try {
                const filePath = path.join(IMPORT_DIR, file);
                await CompanyHouseService.processFile(filePath);
                
                // Check if import was marked as complete due to an error
                const progress = CompanyHouseService.getImportProgress();
                if (progress && progress.isComplete && progress.errors.length > 0) {
                    // Only stop if there are fatal errors (not CSV parsing errors)
                    const hasFatalErrors = progress.errors.some(error => 
                        !error.error.includes('CSV parsing error') && 
                        !error.error.includes('Batch processing error')
                    );
                    
                    if (hasFatalErrors) {
                        companyHouseLogger.error('Stopping import due to fatal errors');
                        break;
                    }
                }
            } catch (fileError) {
                companyHouseLogger.error(`Error processing file ${file}: ${fileError.message}`);
                // Continue with next file
            }
        }

        // Mark import as complete
        const progress = CompanyHouseService.getImportProgress();
        if (progress) {
            progress.isComplete = true;
        }

        // Set import as not running
        CompanyHouseService.setImportRunning(false);

        companyHouseLogger.info('Import process completed');

    } catch (error) {
        companyHouseLogger.error('Error in processFiles:', error);

        // Mark as complete with error
        const progress = CompanyHouseService.getImportProgress();
        if (progress) {
            progress.isComplete = true;
            progress.errors.push(`Process failed: ${error.message}`);
        }

        // Set import as not running
        CompanyHouseService.setImportRunning(false);

        throw error;
    }
};

const getStats = async (req, res) => {
    try {
        // Use estimatedDocumentCount instead of countDocuments for better performance
        const stats = await CompanyHouse.estimatedDocumentCount();
        res.json({ success: true, stats });
    } catch (error) {
        companyHouseLogger.error('Error getting stats:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

const getImportProgress = async (req, res) => {
    try {
        const progress = CompanyHouseService.getImportProgress();
        res.json({
            success: true,
            data: progress
        });
    } catch (error) {
        companyHouseLogger.error('Error getting import progress:', error);
        res.status(500).json({ success: false, error: 'Failed to get import progress' });
    }
};

const getPaginatedCompanies = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 100;
        const searchCompany = req.query.searchCompany?.toLowerCase() || '';
        const searchNumber = req.query.searchNumber || '';
        const searchPostcode = req.query.searchPostcode || '';
        const searchStatus = req.query.searchStatus || '';
        const skip = (page - 1) * limit;
        
        // Debug logging
        companyHouseLogger.info('Paginated request:', {
            page, limit, searchCompany, searchNumber, searchPostcode, searchStatus
        });
        
        // Cursor-based pagination parameters
        const cursor = req.query.cursor;
        const useCursorPagination = req.query.useCursor === 'true';

        // Build query with optimized search
        let query = {};
        let sort = { date: -1 };
        let projection = { 
            CompanyName: 1, 
            CompanyNumber: 1, 
            'RegAddress.AddressLine1': 1,
            'RegAddress.AddressLine2': 1,
            'RegAddress.PostCode': 1,
            'RegAddress.PostTown': 1,
            'RegAddress.County': 1,
            CompanyStatus: 1,
            IncorporationDate: 1,
            createdAt: 1 
        };

        // Add search filters
        if (searchCompany) {
            // Use regex search for company name with word boundaries for better matching
            const escapedSearch = searchCompany.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            query.CompanyName = { $regex: escapedSearch, $options: 'i' };
        }

        if (searchNumber) {
            query.CompanyNumber = { $regex: searchNumber, $options: 'i' };
        }

        if (searchPostcode) {
            query['RegAddress.PostCode'] = { $regex: searchPostcode, $options: 'i' };
        }

        if (searchStatus) {
            query.CompanyStatus = { $regex: searchStatus, $options: 'i' };
        }

        // Debug the constructed query
        companyHouseLogger.info('Constructed query:', JSON.stringify(query, null, 2));

        let companies;
        let totalCount = 0;

        if (useCursorPagination && cursor) {
            // Cursor-based pagination for better performance with large datasets
            query._id = { $lt: cursor };
            companies = await CompanyHouse.find(query, projection)
                .sort({ _id: -1 })
                .limit(limit)
                .lean();
            
            // For cursor pagination, we don't calculate total count for performance
            totalCount = null;
        } else {
            // Traditional pagination
            const [companiesResult, count] = await Promise.all([
                CompanyHouse.find(query, projection)
                    .sort(sort)
                    .skip(skip)
                    .limit(limit)
                    .lean(),
                
                // Only count if we really need it and query is not too complex
                Object.keys(query).length <= 2 ? 
                    CompanyHouse.countDocuments(query) : 
                    CompanyHouse.estimatedDocumentCount()
            ]);

            companies = companiesResult;
            totalCount = count;
        }

        const hasMore = companies.length === limit;
        const nextCursor = hasMore && companies.length > 0 ? 
            companies[companies.length - 1]._id : null;

        res.json({
            success: true,
            data: companies,
            pagination: {
                page,
                limit,
                total: totalCount,
                hasMore,
                nextCursor
            }
        });

    } catch (error) {
        companyHouseLogger.error('Error getting paginated companies:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

const getCompanyByNumber = async (req, res) => {
    try {
        const { companyNumber } = req.params;
        
        if (!companyNumber) {
            return res.status(400).json({
                success: false,
                message: 'Company number is required'
            });
        }

        const company = await CompanyHouse.findOne({ 
            CompanyNumber: companyNumber 
        }).lean();

        if (!company) {
            return res.status(404).json({
                success: false,
                message: 'Company not found'
            });
        }

        res.json({
            success: true,
            data: company
        });

    } catch (error) {
        companyHouseLogger.error('Error getting company by number:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

const searchCompanies = async (req, res) => {
    try {
        const { query: searchQuery, limit = 10 } = req.query;
        
        if (!searchQuery) {
            return res.status(400).json({
                success: false,
                message: 'Search query is required'
            });
        }

        const companies = await CompanyHouse.find(
            { $text: { $search: searchQuery } },
            { 
                CompanyName: 1, 
                CompanyNumber: 1, 
                'RegAddress.PostCode': 1,
                'RegAddress.PostTown': 1,
                CompanyStatus: 1,
                score: { $meta: 'textScore' }
            }
        )
        .sort({ score: { $meta: 'textScore' } })
        .limit(parseInt(limit))
        .lean();

        res.json({
            success: true,
            data: companies,
            count: companies.length
        });

    } catch (error) {
        companyHouseLogger.error('Error searching companies:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

const stopImport = async (req, res) => {
    try {
        const currentProgress = CompanyHouseService.getImportProgress();
        
        if (!currentProgress.isRunning || currentProgress.isComplete) {
            return res.status(400).json({
                success: false,
                message: 'No import is currently running.'
            });
        }

        // Set import as not running and complete
        CompanyHouseService.setImportRunning(false);
        const progress = CompanyHouseService.getImportProgress();
        if (progress) {
            progress.isComplete = true;
            progress.errors.push('Import was stopped by user');
        }

        res.json({
            success: true,
            message: 'Import stopped successfully'
        });
    } catch (error) {
        companyHouseLogger.error('Error stopping import:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

const deleteAllData = async (req, res) => {
    try {
        // Check if confirmation is provided
        const { confirm } = req.body;
        
        if (!confirm || confirm !== 'DELETE_ALL_COMPANY_HOUSE_DATA') {
            return res.status(400).json({
                success: false,
                message: 'Confirmation required. Please provide { "confirm": "DELETE_ALL_COMPANY_HOUSE_DATA" } in request body.'
            });
        }

        // Get count before deletion for logging
        const countBeforeDeletion = await CompanyHouse.countDocuments();
        
        companyHouseLogger.warn(`Starting deletion of all CompanyHouse data. Total records: ${countBeforeDeletion}`);
        
        // Delete all documents
        const result = await CompanyHouse.deleteMany({});
        
        companyHouseLogger.warn(`Successfully deleted ${result.deletedCount} CompanyHouse records`);
        
        res.json({
            success: true,
            message: `Successfully deleted all CompanyHouse data`,
            deletedCount: result.deletedCount,
            previousCount: countBeforeDeletion
        });
        
    } catch (error) {
        companyHouseLogger.error('Error deleting all CompanyHouse data:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            message: 'Failed to delete CompanyHouse data'
        });
    }
};

const CompanyHouseController = {
    startImport,
    getStats,
    getImportProgress,
    getPaginatedCompanies,
    getCompanyByNumber,
    searchCompanies,
    stopImport,
    deleteAllData,
};

module.exports = {
    CompanyHouseController
};