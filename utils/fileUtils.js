const fs = require('fs').promises;
const path = require('path');

/**
 * Archives a file to a specified directory with optional timestamp and format
 * @param {string} filePath - Path to the file to archive
 * @param {Object} options - Archive options
 * @param {string} options.archiveDir - Directory to archive the file to
 * @param {boolean} [options.useTimestamp=true] - Whether to add timestamp to filename
 * @param {string} [options.timestampFormat='ISO'] - Format for timestamp ('ISO' or 'DATE')
 * @param {string} [options.prefix=''] - Optional prefix for archived filename
 * @param {string} [options.suffix=''] - Optional suffix for archived filename
 * @returns {Promise<string>} Path to the archived file
 */
const archiveFile = async (filePath, options) => {
    try {
        const {
            archiveDir,
            useTimestamp = true,
            timestampFormat = 'ISO',
            prefix = '',
            suffix = ''
        } = options;

        // Create archive directory if it doesn't exist
        await fs.mkdir(archiveDir, { recursive: true });

        // Get original filename and extension
        const originalName = path.basename(filePath);
        const ext = path.extname(originalName);
        const baseName = path.basename(originalName, ext);

        // Generate timestamp if needed
        let timestamp = '';
        if (useTimestamp) {
            if (timestampFormat === 'ISO') {
                timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            } else if (timestampFormat === 'DATE') {
                timestamp = new Date().toISOString().split('T')[0];
            }
        }

        // Construct new filename
        const newFileName = [
            prefix,
            baseName,
            timestamp,
            suffix
        ].filter(Boolean).join('_') + ext;

        // Create full archive path
        const archivePath = path.join(archiveDir, newFileName);

        // Move the file
        await fs.rename(filePath, archivePath);

        return archivePath;
    } catch (error) {
        throw new Error(`Failed to archive file: ${error.message}`);
    }
};

module.exports = {
    archiveFile
}; 