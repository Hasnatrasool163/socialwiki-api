const path = require('path');
const fs = require('fs');
const { RMAddressService, IMPORT_DIR } = require('../services/RMAddress.service');
const rmAddressLogger = require('../config/loggers/rmAddressLogger');

const processFiles = async (files) => {
    try {
        for (const file of files) {
            const state = RMAddressService.getImportProgress();
            if (!state.isRunning) {
                rmAddressLogger.warn('Import loop stopped by user request');
                break;
            }

            try {
                const filePath = path.join(IMPORT_DIR, file);
                await RMAddressService.processFile(filePath);
            } catch (error) {
                rmAddressLogger.error(`Error processing ${file}: ${error.message}`);
                RMAddressService.addImportError({
                    filename: file,
                    error: error.message
                });
            }
        }

        RMAddressService.setImportComplete(true);
        RMAddressService.setImportRunning(false);
        rmAddressLogger.info('RM Address import process completed');
    } catch (error) {
        rmAddressLogger.error(`RM Address processFiles error: ${error.message}`);

        RMAddressService.setImportComplete(true);
        RMAddressService.addImportError({
            filename: 'process',
            error: `Process failed: ${error.message}`
        });

        RMAddressService.setImportRunning(false);
    }
};

const startImport = async (req, res) => {
    try {
        const currentProgress = RMAddressService.getImportProgress();
        if (currentProgress.isRunning && !currentProgress.isComplete) {
            return res.status(409).json({
                success: false,
                message: 'Import is already running. Please wait for completion.'
            });
        }

        const files = await RMAddressService.getImportFiles();
        if (!files.length) {
            return res.status(404).json({
                success: false,
                message: 'No CSV files found in RM Address import folder.'
            });
        }

        RMAddressService.resetImportProgress();
        RMAddressService.setImportRunning(true);

        processFiles(files).catch((error) => {
            rmAddressLogger.error(`Failed to process RM Address files: ${error.message}`);
            RMAddressService.setImportRunning(false);
        });

        return res.json({
            success: true,
            message: 'RM Address import started',
            files,
            totalFiles: files.length
        });
    } catch (error) {
        rmAddressLogger.error(`Error starting RM Address import: ${error.message}`);
        return res.status(500).json({ success: false, error: error.message });
    }
};

const getImportProgress = async (req, res) => {
    try {
        const data = RMAddressService.getImportProgress();
        return res.json({ success: true, data });
    } catch (error) {
        rmAddressLogger.error(`Error getting RM Address import progress: ${error.message}`);
        return res.status(500).json({ success: false, error: 'Failed to get import progress' });
    }
};

const getStats = async (req, res) => {
    try {
        const stats = await RMAddressService.getStats();
        return res.json({ success: true, stats });
    } catch (error) {
        rmAddressLogger.error(`Error getting RM Address stats: ${error.message}`);
        return res.status(500).json({ success: false, error: error.message });
    }
};

const listImportFiles = async (req, res) => {
    try {
        const data = await RMAddressService.getImportFileDetails();
        return res.json({ success: true, data });
    } catch (error) {
        rmAddressLogger.error(`Error listing RM Address import files: ${error.message}`);
        return res.status(500).json({ success: false, error: 'Failed to list import files' });
    }
};

const uploadImportFiles = async (req, res) => {
    try {
        const files = req.files || [];

        if (!files.length) {
            return res.status(400).json({
                success: false,
                message: 'No CSV files were uploaded.'
            });
        }

        const uploadedFiles = files.map((file) => ({
            filename: file.filename,
            originalName: file.originalname,
            sizeBytes: file.size
        }));

        rmAddressLogger.info(`Uploaded ${uploadedFiles.length} RM Address file(s)`);

        const pending = await RMAddressService.getImportFileDetails();

        return res.json({
            success: true,
            message: 'CSV file(s) uploaded successfully.',
            uploadedFiles,
            data: pending
        });
    } catch (error) {
        rmAddressLogger.error(`Error uploading RM Address files: ${error.message}`);

        if (Array.isArray(req.files)) {
            await Promise.all(
                req.files.map(async (file) => {
                    if (!file?.path) return;
                    try {
                        await fs.promises.unlink(file.path);
                    } catch (cleanupError) {
                        rmAddressLogger.warn(`Failed to cleanup uploaded file ${file.path}: ${cleanupError.message}`);
                    }
                })
            );
        }

        return res.status(500).json({ success: false, error: 'Failed to upload CSV files' });
    }
};

const getPaginatedAddresses = async (req, res) => {
    try {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 200;
        const useCursor = req.query.useCursor !== 'false';
        const cursor = req.query.cursor ? String(req.query.cursor) : null;

        const { rows, pagination } = await RMAddressService.getPaginatedAddresses({
            page,
            limit,
            useCursor,
            cursor,
            searchPostcode: req.query.searchPostcode || '',
            searchDistrict: req.query.searchDistrict || '',
            searchAddress: req.query.searchAddress || ''
        });

        return res.json({
            success: true,
            data: rows,
            pagination
        });
    } catch (error) {
        rmAddressLogger.error(`Error getting RM Address paginated data: ${error.message}`);
        return res.status(500).json({ success: false, error: error.message });
    }
};

const stopImport = async (req, res) => {
    try {
        const currentProgress = RMAddressService.getImportProgress();

        if (!currentProgress.isRunning || currentProgress.isComplete) {
            return res.status(400).json({
                success: false,
                message: 'No RM Address import is currently running.'
            });
        }

        RMAddressService.setImportRunning(false);
        RMAddressService.setImportComplete(true);
        RMAddressService.addImportError({ filename: 'system', error: 'Import was stopped by user' });

        return res.json({ success: true, message: 'RM Address import stopped successfully' });
    } catch (error) {
        rmAddressLogger.error(`Error stopping RM Address import: ${error.message}`);
        return res.status(500).json({ success: false, error: error.message });
    }
};

module.exports = {
    RMAddressController: {
        startImport,
        getImportProgress,
        getStats,
        listImportFiles,
        uploadImportFiles,
        getPaginatedAddresses,
        stopImport
    }
};
