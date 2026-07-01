const fs = require('fs');
const { RMAddressEditService } = require('../services/RMAddressEdit.service');
const rmAddressLogger = require('../config/loggers/rmAddressLogger');

const previewSearch = async (req, res) => {
    try {
        const { searchPostcode, searchDistrict, searchAddress, searchDate, postcodes } = req.body || {};
        const result = await RMAddressEditService.previewEditSearch({
            searchPostcode, searchDistrict, searchAddress, searchDate,
            postcodes: Array.isArray(postcodes) ? postcodes : []
        });
        return res.status(200).json({ success: true, ...result });
    } catch (error) {
        rmAddressLogger.error(`Edit preview failed: ${error.message}`);
        return res.status(400).json({ success: false, message: error.message });
    }
};

const confirmExport = async (req, res) => {
    try {
        const { searchPostcode, searchDistrict, searchAddress, searchDate, postcodes } = req.body || {};
        const { jobId } = await RMAddressEditService.startEditExportJob({
            searchPostcode, searchDistrict, searchAddress, searchDate,
            postcodes: Array.isArray(postcodes) ? postcodes : []
        });
        return res.status(200).json({ success: true, jobId });
    } catch (error) {
        rmAddressLogger.error(`Edit export confirm failed: ${error.message}`);
        return res.status(400).json({ success: false, message: error.message });
    }
};

const parsePostcodeFile = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }

        const content = req.file.buffer.toString('utf8');
        const result = RMAddressEditService.parsePostcodeListContent(content);

        return res.status(200).json({ success: true, ...result });
    } catch (error) {
        rmAddressLogger.error(`Parse postcode file failed: ${error.message}`);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const getJobStatus = async (req, res) => {
    try {
        const job = await RMAddressEditService.getEditJobStatus(req.params.jobId);
        if (!job) return res.status(404).json({ success: false, message: 'Job not found' });
        return res.status(200).json({ success: true, data: job });
    } catch (error) {
        rmAddressLogger.error(`Edit job status failed: ${error.message}`);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const downloadExportCsv = async (req, res) => {
    try {
        const job = await RMAddressEditService.downloadEditExportFile(req.params.jobId);
        if (!job) return res.status(404).json({ success: false, message: 'File not available' });
        return res.download(job.filePath, job.fileName);
    } catch (error) {
        rmAddressLogger.error(`Edit download failed: ${error.message}`);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// Single-file upload, field name MUST be "file" — see route below.
const reimportCsv = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No CSV file uploaded' });
        }

        const exportJobId = req.body.exportJobId || null;
        const { jobId } = await RMAddressEditService.reimportEditedCsv({ filePath: req.file.path, exportJobId });

        return res.status(202).json({ success: true, message: 'Reimport started', jobId });
    } catch (error) {
        rmAddressLogger.error(`Reimport failed: ${error.message}`);
        if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => undefined);
        return res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    RMAddressEditController: {
        previewSearch,
        confirmExport,
        getJobStatus,
        downloadExportCsv,
        reimportCsv,
        parsePostcodeFile
    }
};