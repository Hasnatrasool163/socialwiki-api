// controllers/AdultKeywords.controller.js
const { AdultKeywordsService } = require('../services/AdultKeywords.service');
const socialScrapeLogger = require('../config/socialScrapeLogger');

const startMatching = async (req, res) => {
    try {
        const result = await AdultKeywordsService.startMatching();

        res.json({
            success: true,
            message: result.message,
            files: result.files
        });
    } catch (error) {
        socialScrapeLogger.error('Error in start Matching controller:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

const stopMatching = async (req, res) => {
    try {
        const result = await AdultKeywordsService.stopMatching();

        res.json({
            success: result.success,
            message: result.message
        });
    } catch (error) {
        socialScrapeLogger.error('Error in stopMatching controller:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

const getMatchingProgress = async (req, res) => {
    try {
        const progress = AdultKeywordsService.getMatchingProgress();

        res.json({
            success: true,
            progress: progress
        });
    } catch (error) {
        socialScrapeLogger.error('Error in getMatchingProgress controller:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

const getStats = async (req, res) => {
    try {
        const stats = await AdultKeywordsService.getStats();

        res.json({
            success: true,
            stats: stats
        });
    } catch (error) {
        socialScrapeLogger.error('Error in getStats controller:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

const getReferences = async (req, res) => {
    try {
        const references = await AdultKeywordsService.getReferences();

        res.json({
            success: true,
            references: references
        });
    } catch (error) {
        socialScrapeLogger.error('Error in getReferences controller:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

const getPaginatedReferences = async (req, res) => {
    try {
        const { page = 1, limit = 50, matchType, processed } = req.query;

        const result = await AdultKeywordsService.getPaginatedReferences(
            parseInt(page),
            parseInt(limit),
            matchType,
            processed !== undefined ? processed === 'true' : null
        );

        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        socialScrapeLogger.error('Error in getPaginatedReferences controller:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

const bulkProcessReferences = async (req, res) => {
    try {
        const { recordIds, isAdultContent } = req.body;

        if (!recordIds || !Array.isArray(recordIds) || recordIds.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Record IDs array is required'
            });
        }

        if (typeof isAdultContent !== 'boolean') {
            return res.status(400).json({
                success: false,
                error: 'isAdultContent boolean flag is required'
            });
        }

        const result = await AdultKeywordsService.bulkProcessReferences(recordIds, isAdultContent);

        res.json({
            success: true,
            message: result.message,
            processed: result.processed,
            updated: result.updated
        });
    } catch (error) {
        socialScrapeLogger.error('Error in bulkProcessReferences controller:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

// Get memory status
const getMemoryStatus = async (req, res) => {
    try {
        const memUsage = process.memoryUsage();
        const memoryStatus = {
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024), // MB
            external: Math.round(memUsage.external / 1024 / 1024), // MB
            rss: Math.round(memUsage.rss / 1024 / 1024), // MB
            memoryUsagePercent: Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100),
            timestamp: new Date().toISOString()
        };

        res.json({
            success: true,
            memoryStatus
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to get memory status',
            error: error.message
        });
    }
};

// Get completed files statistics
const getCompletedFilesStats = async (req, res) => {
    try {
        const stats = await AdultKeywordsService.getCompletedFilesStats();

        res.json({
            success: true,
            stats: stats
        });
    } catch (error) {
        socialScrapeLogger.error('Error in getCompletedFilesStats controller:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

const { translate } = require('google-translate-api-x');

// ... existing imports ...

// Translate text
const translateText = async (req, res) => {
    try {
        const { text, targetLang = 'en' } = req.body;

        if (!text || typeof text !== 'string') {
            return res.status(400).json({ error: 'Text is required and must be a string' });
        }

        // Skip translation if text is very short or looks like a URL
        if (text.length < 3 || text.includes('http')) {
            return res.json({
                success: true,
                original: text,
                translated: text,
                detectedLang: 'en' // Assume EN
            });
        }

        const result = await translate(text, { to: targetLang });

        res.json({
            success: true,
            original: text,
            translated: result.text,
            detectedLang: result.from.language.iso
        });
    } catch (error) {
        socialScrapeLogger.error('Translation error:', error);
        res.status(500).json({
            success: false,
            error: 'Translation failed: ' + error.message
        });
    }
};

module.exports = {
    AdultKeywordsController: {
        startMatching,
        stopMatching,
        getMatchingProgress,
        getStats,
        getReferences,
        getPaginatedReferences,
        bulkProcessReferences,
        getMemoryStatus,
        getCompletedFilesStats,
        translateText
    }
}; 