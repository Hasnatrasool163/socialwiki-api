const path = require('path');
const fs = require('fs');
const { PropPriceService, IMPORT_DIR } = require('../services/PropPrice.service');
const propPriceLogger = require('../config/loggers/propPriceLogger');

const processFiles = async (files) => {
    try {
        for (const file of files) {
            const state = PropPriceService.getImportProgress();
            if (!state.isRunning) {
                propPriceLogger.warn('Import loop stopped by user request');
                break;
            }

            try {
                const filePath = path.join(IMPORT_DIR, file);
                await PropPriceService.processFile(filePath);
            } catch (error) {
                propPriceLogger.error(`Error processing ${file}: ${error.message}`);
                PropPriceService.addImportError({ filename: file, error: error.message });
            }
        }

        PropPriceService.setImportComplete(true);
        PropPriceService.setImportRunning(false);
        propPriceLogger.info('Prop Price import process completed');
    } catch (error) {
        propPriceLogger.error(`Prop Price processFiles error: ${error.message}`);
        PropPriceService.setImportComplete(true);
        PropPriceService.addImportError({ filename: 'process', error: `Process failed: ${error.message}` });
        PropPriceService.setImportRunning(false);
    }
};

const startImport = async (req, res) => {
    try {
        const currentProgress = PropPriceService.getImportProgress();
        if (currentProgress.isRunning && !currentProgress.isComplete) {
            return res.status(409).json({ success: false, message: 'Import is already running. Please wait for completion.' });
        }

        const files = await PropPriceService.getImportFiles();
        if (!files.length) {
            return res.status(404).json({ success: false, message: 'No CSV files found in Prop Price import folder.' });
        }

        PropPriceService.resetImportProgress();
        PropPriceService.setImportRunning(true);

        processFiles(files).catch((error) => {
            propPriceLogger.error(`Failed to process Prop Price files: ${error.message}`);
            PropPriceService.setImportRunning(false);
        });

        return res.json({ success: true, message: 'Prop Price import started', files, totalFiles: files.length });
    } catch (error) {
        propPriceLogger.error(`Error starting Prop Price import: ${error.message}`);
        return res.status(500).json({ success: false, error: error.message });
    }
};

const getImportProgress = async (req, res) => {
    try {
        const data = PropPriceService.getImportProgress();
        return res.json({ success: true, data });
    } catch (error) {
        propPriceLogger.error(`Error getting Prop Price import progress: ${error.message}`);
        return res.status(500).json({ success: false, error: 'Failed to get import progress' });
    }
};

const getStats = async (req, res) => {
    try {
        const stats = await PropPriceService.getStats();
        return res.json({ success: true, stats });
    } catch (error) {
        propPriceLogger.error(`Error getting Prop Price stats: ${error.message}`);
        return res.status(500).json({ success: false, error: error.message });
    }
};

const listImportFiles = async (req, res) => {
    try {
        const data = await PropPriceService.getImportFileDetails();
        return res.json({ success: true, data });
    } catch (error) {
        propPriceLogger.error(`Error listing Prop Price import files: ${error.message}`);
        return res.status(500).json({ success: false, error: 'Failed to list import files' });
    }
};

const uploadImportFiles = async (req, res) => {
    try {
        const files = req.files || [];

        if (!files.length) {
            return res.status(400).json({ success: false, message: 'No CSV files were uploaded.' });
        }

        const uploadedFiles = files.map((file) => ({
            filename: file.filename,
            originalName: file.originalname,
            sizeBytes: file.size
        }));

        propPriceLogger.info(`Uploaded ${uploadedFiles.length} Prop Price file(s)`);

        const pending = await PropPriceService.getImportFileDetails();

        return res.json({
            success: true,
            message: 'CSV file(s) uploaded successfully.',
            uploadedFiles,
            data: pending
        });
    } catch (error) {
        propPriceLogger.error(`Error uploading Prop Price files: ${error.message}`);

        if (Array.isArray(req.files)) {
            await Promise.all(
                req.files.map(async (file) => {
                    if (!file?.path) return;
                    try {
                        await fs.promises.unlink(file.path);
                    } catch (cleanupError) {
                        propPriceLogger.warn(`Failed to cleanup uploaded file ${file.path}: ${cleanupError.message}`);
                    }
                })
            );
        }

        return res.status(500).json({ success: false, error: 'Failed to upload CSV files' });
    }
};

const getPaginatedRecords = async (req, res) => {
    try {
        const limit = parseInt(req.query.limit, 10) || 200;
        const searchPostcode = req.query.searchPostcode || '';
        const cursor = req.query.cursor ? String(req.query.cursor) : null;

        const { rows, pagination } = await PropPriceService.getPaginatedRecords({
            searchPostcode,
            limit,
            cursor
        });

        return res.json({
            success: true,
            data: rows,
            pagination
        });
    } catch (error) {
        propPriceLogger.error(`Error getting Prop Price paginated data: ${error.message}`);
        return res.status(500).json({ success: false, error: error.message });
    }
};

const stopImport = async (req, res) => {
    try {
        const currentProgress = PropPriceService.getImportProgress();

        if (!currentProgress.isRunning || currentProgress.isComplete) {
            return res.status(400).json({ success: false, message: 'No Prop Price import is currently running.' });
        }

        PropPriceService.setImportRunning(false);
        PropPriceService.setImportComplete(true);
        PropPriceService.addImportError({ filename: 'system', error: 'Import was stopped by user' });

        return res.json({ success: true, message: 'Prop Price import stopped successfully' });
    } catch (error) {
        propPriceLogger.error(`Error stopping Prop Price import: ${error.message}`);
        return res.status(500).json({ success: false, error: error.message });
    }
};

module.exports = {
    PropPriceController: {
        startImport,
        getImportProgress,
        getStats,
        listImportFiles,
        uploadImportFiles,
        getPaginatedRecords,
        stopImport
    }
};
