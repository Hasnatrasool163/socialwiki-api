const fs = require('fs');
const path = require('path');

const AddressMain = require('../models/AddressMain');
const PostcodeDistrict = require('../models/PostcodeDistrict');
const postcodeLogger = require('../config/loggers/postcodeDistrictLogger');

const REPORT_DIR = path.join(__dirname, '../imports/reports/missing-postcodes');
const REPORT_FILE_PREFIX = 'missing-postcodes';
const REPORT_BATCH_SIZE = 5000;

const activeReportJobs = new Map();

const ensureReportDirectory = async () => {
    await fs.promises.mkdir(REPORT_DIR, { recursive: true });
};

const normalizePostcode = (value) => {
    if (!value) {
        return '';
    }

    const compact = value
        .toString()
        .trim()
        .toUpperCase()
        .replace(/\s+/g, ' ')
        .replace(/[^A-Z0-9 ]/g, '');

    if (!compact) {
        return '';
    }

    const noSpace = compact.replace(/\s+/g, '');
    if (noSpace.length > 3) {
        return `${noSpace.slice(0, noSpace.length - 3)} ${noSpace.slice(noSpace.length - 3)}`;
    }

    return compact;
};

const writeLine = async (stream, line) => {
    if (stream.write(line)) {
        return;
    }

    await new Promise((resolve) => stream.once('drain', resolve));
};

const createReportJob = () => {
    const generatedAt = new Date();
    const jobId = `${generatedAt.getTime()}-${Math.random().toString(36).slice(2, 10)}`;
    const fileName = `${REPORT_FILE_PREFIX}-${generatedAt.toISOString().replace(/[:.]/g, '-')}.csv`;

    const job = {
        jobId,
        status: 'pending',
        stage: 'queued',
        progress: 0,
        totalRows: 0,
        processedRows: 0,
        missingCount: 0,
        fileName,
        filePath: path.join(REPORT_DIR, fileName),
        downloadUrl: `/api/reports/missing-postcodes/download/${jobId}`,
        startedAt: generatedAt.toISOString(),
        completedAt: null,
        error: null
    };

    activeReportJobs.set(jobId, job);
    return job;
};

const getReportJob = (jobId) => activeReportJobs.get(jobId?.toString());

const updateProgress = (job) => {
    if (!job.totalRows) {
        job.progress = job.status === 'completed' ? 100 : 0;
        return;
    }

    job.progress = Math.min(100, Math.round((job.processedRows / job.totalRows) * 100));
};

const generateMissingPostcodesReport = async (job) => {
    let outputStream;

    try {
        await ensureReportDirectory();

        job.status = 'processing';
        job.stage = 'counting';
        job.totalRows = await PostcodeDistrict.countDocuments({
            district: { $ne: 'NOT ACTIVE' }
        });
        job.processedRows = 0;
        job.missingCount = 0;
        job.error = null;
        job.completedAt = null;
        updateProgress(job);

        outputStream = fs.createWriteStream(job.filePath, { encoding: 'utf8' });
        outputStream.write('postcode\n');


     const cursor = PostcodeDistrict.aggregate(buildMissingPostcodesPipeline())
    .allowDiskUse(true)
    .cursor({ batchSize: 1000 });

        let missingCount = 0;

        for await (const row of cursor) {
            const postcode = normalizePostcode(row?.postcode);
            if (!postcode || seenPostcodes.has(postcode)) {
                continue;
            }

            seenPostcodes.add(postcode);
            pendingPostcodes.push(postcode);

            if (pendingPostcodes.length >= REPORT_BATCH_SIZE) {
                await flushPending();
            }
        }

        await flushPending();

        await new Promise((resolve, reject) => {
            outputStream.end(() => resolve());
            outputStream.once('error', reject);
        });

        job.status = 'completed';
        job.stage = 'completed';
        job.completedAt = new Date().toISOString();
        job.progress = 100;

        postcodeLogger.info(`Missing postcode report generated: ${job.fileName} (${job.missingCount} rows)`);
    } catch (error) {
        job.status = 'failed';
        job.stage = 'failed';
        job.error = error.message;

        postcodeLogger.error(`Error generating missing postcode report: ${error.message}`);

        if (outputStream && !outputStream.destroyed) {
            outputStream.destroy();
        }

        await fs.promises.unlink(job.filePath).catch(() => undefined);
    }
};

const startMissingPostcodesReport = async (req, res) => {
    try {
        const job = createReportJob();

        generateMissingPostcodesReport(job).catch((error) => {
            postcodeLogger.error(`Background missing postcode report job ${job.jobId} failed: ${error.message}`);
        });

        return res.status(202).json({
            success: true,
            message: 'Missing postcode report generation started',
            jobId: job.jobId,
            statusUrl: `/api/reports/missing-postcodes/status/${job.jobId}`,
            downloadUrl: job.downloadUrl
        });
    } catch (error) {
        postcodeLogger.error(`Error starting missing postcode report: ${error.message}`);

        return res.status(500).json({
            success: false,
            message: 'Failed to start missing postcode report generation'
        });
    }
};

const getMissingPostcodesReportStatus = async (req, res) => {
    try {
        const job = getReportJob(req.params.jobId);

        if (!job) {
            return res.status(404).json({
                success: false,
                message: 'Report job not found'
            });
        }

        return res.status(200).json({
            success: true,
            data: job
        });
    } catch (error) {
        postcodeLogger.error(`Error fetching missing postcode report status: ${error.message}`);

        return res.status(500).json({
            success: false,
            message: 'Failed to fetch missing postcode report status'
        });
    }
};

const downloadMissingPostcodesReport = async (req, res) => {
    try {
        const jobId = req.params.jobId || req.query.jobId;
        const job = getReportJob(jobId);

        if (!job) {
            return res.status(404).json({
                success: false,
                message: 'Report job not found'
            });
        }

        if (job.status !== 'completed') {
            return res.status(409).json({
                success: false,
                message: 'Report is not ready yet',
                data: job
            });
        }

        if (!job.filePath || !fs.existsSync(job.filePath)) {
            return res.status(404).json({
                success: false,
                message: 'Report file is no longer available'
            });
        }

        res.setHeader('X-Report-File-Name', job.fileName);
        res.setHeader('X-Report-File-Path', job.filePath);
        res.setHeader('X-Report-Download-Location', `/imports/reports/missing-postcodes/${job.fileName}`);

        return res.download(job.filePath, job.fileName, (downloadError) => {
            if (downloadError) {
                postcodeLogger.error(`Failed to download missing postcode report ${job.fileName}: ${downloadError.message}`);
            }
        });
    } catch (error) {
        postcodeLogger.error(`Error downloading missing postcode report: ${error.message}`);

        return res.status(500).json({
            success: false,
            message: 'Failed to download missing postcode report'
        });
    }
};
