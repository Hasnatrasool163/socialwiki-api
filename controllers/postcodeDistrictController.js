const PostcodeDistrict = require('../models/PostcodeDistrict');
const PostcodeImportJob = require('../models/PostcodeImportJob');
const postcodeLogger = require('../config/loggers/postcodeDistrictLogger');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');

const CHECK_IMPORT_DIR = path.join(__dirname, '../imports/postcode_check');
const CHECK_RESULT_DIR = path.join(CHECK_IMPORT_DIR, 'results');
const CHECK_BATCH_SIZE = 10000;
const CHECK_SAMPLE_LIMIT = 100;

const activeCheckJobs = new Map();

const normalizePostcode = (value) => {
    if (!value) return '';

    const compact = value
        .toString()
        .trim()
        .toUpperCase()
        .replace(/\s+/g, ' ')
        .replace(/[^A-Z0-9 ]/g, '');

    if (!compact) return '';

    const noSpace = compact.replace(/\s+/g, '');
    if (noSpace.length > 3) {
        return `${noSpace.slice(0, noSpace.length - 3)} ${noSpace.slice(noSpace.length - 3)}`;
    }

    return compact;
};

const cleanText = (value) => {
    if (!value) return '';

    return value
        .toString()
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
        .trim();
};

const ensureCheckDirectories = async () => {
    await fs.promises.mkdir(CHECK_RESULT_DIR, { recursive: true });
};

const escapeCsvCell = (value) => {
    const text = value === null || value === undefined ? '' : value.toString();
    return `"${text.replace(/"/g, '""')}"`;
};

const readJobState = (jobId) => {
    const key = jobId.toString();
    if (!activeCheckJobs.has(key)) {
        activeCheckJobs.set(key, { stopRequested: false });
    }

    return activeCheckJobs.get(key);
};

const pushErrorLog = (job, message) => {
    if (!job.errorLogs) {
        job.errorLogs = [];
    }

    if (job.errorLogs.length < 50) {
        job.errorLogs.push(message);
    }
};

// Start Import Job
exports.startImportJob = async (req, res) => {
    try {
        const job = await PostcodeImportJob.create({
            status: 'pending'
        });
        postcodeLogger.info(`Started new import job: ${job._id}`);
        res.status(200).json({ jobId: job._id });
    } catch (error) {
        postcodeLogger.error(`Error starting import job: ${error.message}`);
        res.status(500).json({ message: 'Failed to start import job' });
    }
};

// Upload and Process File (Background)
exports.uploadAndProcess = async (req, res) => {
    const { jobId } = req.params;

    if (!req.file) {
        return res.status(400).json({ message: 'No file uploaded' });
    }

    try {
        // Return 202 immediately
        res.status(202).json({ message: 'File accepted for processing' });

        // Identify Job
        const job = await PostcodeImportJob.findById(jobId);
        if (!job) {
            postcodeLogger.warn(`Job ${jobId} not found, deleting file.`);
            fs.unlinkSync(req.file.path);
            return;
        }

        job.status = 'processing';
        await job.save();
        postcodeLogger.info(`Processing file for job ${jobId}: ${req.file.originalname}`);

        // Start Processing
        processCsvFile(req.file.path, job);

    } catch (error) {
        postcodeLogger.error(`Error in upload handler: ${error.message}`);
    }
};

async function processCsvFile(filePath, job) {
    const batchSize = 5000;
    let batch = [];
    let processedCount = 0;

    postcodeLogger.info(`Starting CSV parse for job ${job._id}`);

    try {
        // Create Read Stream
        const parser = fs.createReadStream(filePath)
            .pipe(parse({
                columns: ['district', 'postcode'], // Explicit columns for headerless file
                skip_empty_lines: true,
                trim: true,
                relax_column_count: true
            }));

        for await (const row of parser) {
            // Check if it's a header row inadvertently
            if (row.district && row.district.toLowerCase() === 'district' &&
                row.postcode && row.postcode.toLowerCase().includes('postcode')) {
                postcodeLogger.info(`Skipping header row for job ${job._id}`);
                continue;
            }

            const postcode = row.postcode;
            const district = row.district;

            if (postcode && district) {
                batch.push({
                    postcode: postcode.trim(),
                    district: district.trim()
                });
            }

            if (batch.length >= batchSize) {
                await insertBatch(batch, job);
                processedCount += batch.length;
                job.totalProcessed = processedCount;
                await job.save();
                batch = [];
                postcodeLogger.debug(`Job ${job._id}: Processed ${processedCount} rows`);
            }
        }

        // Insert remaining
        if (batch.length > 0) {
            await insertBatch(batch, job);
            processedCount += batch.length;
            job.totalProcessed = processedCount;
            await job.save();
        }

        // Finish
        job.status = 'completed';
        await job.save();
        postcodeLogger.info(`Job ${job._id} completed. Total processed: ${processedCount}, Inserted: ${job.insertedCount}, Errors: ${job.errorCount}`);

    } catch (error) {
        postcodeLogger.error(`Error processing CSV for job ${job._id}: ${error.message}`);
        job.status = 'failed';
        job.errorLogs.push(error.message);

        // Ensure not saving NaN which causes validation error like the user saw
        if (isNaN(job.insertedCount)) {
            postcodeLogger.warn(`Fixed NaN insertedCount before saving failure status.`);
            job.insertedCount = 0;
        }
        if (isNaN(job.errorCount)) job.errorCount = 0;

        await job.save();
    } finally {
        // Cleanup
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (e) { postcodeLogger.error('Error deleting temp file', e); }
    }
}

async function insertBatch(batch, job) {
    try {
        const result = await PostcodeDistrict.insertMany(batch, { ordered: false });
        job.insertedCount += result.length;
    } catch (error) {
        // Detailed logging for debugging production issues
        postcodeLogger.debug(`Batch insertion exception. Code: ${error.code}, Name: ${error.name}.`);

        if (error.code === 11000 || error.name === 'BulkWriteError' || error.name === 'MongoBulkWriteError') {
            // Handle duplicates / partial success

            // 1. Calculate inserted count safely
            // Mongoose creates error.insertedDocs for unordered mode
            const insertedDocsCount = error.insertedDocs ? error.insertedDocs.length : 0;
            // Native driver might provide result.nInserted
            const resultInserted = (error.result && typeof error.result.nInserted === 'number') ? error.result.nInserted : 0;

            // Use whichever is available, default to 0
            // Logic: If result.nInserted is available, it's usually reliable. If not, insertedDocs length.
            const nInserted = Math.max(insertedDocsCount, resultInserted);

            job.insertedCount += nInserted;

            if (isNaN(job.insertedCount)) {
                postcodeLogger.error(`Critical: Job insertedCount became NaN. Batch size: ${batch.length}, nInserted derived: ${nInserted}`);
                job.insertedCount = 0;
            }

            // 2. Handle Errors
            if (error.writeErrors) {
                job.errorCount += error.writeErrors.length;

                // Log sample for user
                if (error.writeErrors.length > 0 && job.errorLogs.length < 50) {
                    const firstErr = error.writeErrors[0];
                    const opCode = firstErr.err && firstErr.err.op ? firstErr.err.op.postcode : 'Batch Error';
                    job.errorLogs.push(`Duplicate/Error: ${opCode}`);
                }

                // Detailed server log
                if (error.writeErrors.length > 0) {
                    postcodeLogger.info(`Batch had ${error.writeErrors.length} duplicates. Successfully inserted: ${nInserted}`);
                }
            } else {
                job.errorCount += (batch.length - nInserted);
                postcodeLogger.warn(`Batch error 11000 but no writeErrors found. Full error: ${JSON.stringify(error)}`);
            }
        } else {
            // General unexpected error
            job.errorCount += batch.length;
            job.errorLogs.push(error.message || 'Unknown batch error');
            postcodeLogger.error(`Batch insert critical failure job ${job._id}: ${error.message}`, { stack: error.stack });
        }
    }
}

// Get Job Status
exports.getImportStatus = async (req, res) => {
    try {
        const job = await PostcodeImportJob.findById(req.params.jobId);
        if (!job) return res.status(404).json({ message: 'Job not found' });
        res.status(200).json(job);
    } catch (error) {
        postcodeLogger.error(`Error getting status: ${error.message}`);
        res.status(500).json({ message: 'Error fetching status' });
    }
};

// Search with Pagination
exports.searchPostcodes = async (req, res) => {
    const { postcode, district, page = 1, limit = 500 } = req.body;

    try {
        const query = {};
        if (postcode) query.postcode = { $regex: postcode, $options: 'i' };
        if (district) query.district = { $regex: district, $options: 'i' };

        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const skip = (pageNum - 1) * limitNum;

        // Count logic: if empty query, use fast estimate
        let count;
        if (Object.keys(query).length === 0) {
            count = await PostcodeDistrict.estimatedDocumentCount();
        } else {
            count = await PostcodeDistrict.countDocuments(query);
        }

        const data = await PostcodeDistrict.find(query)
            .sort({ _id: 1 })
            .skip(skip)
            .limit(limitNum)
            .lean(); // Optimization

        res.status(200).json({
            success: true,
            count: data.length,
            total: count,
            page: pageNum,
            totalPages: Math.ceil(count / limitNum),
            data
        });
    } catch (error) {
        postcodeLogger.error(`Search failed: ${error.message}`);
        res.status(500).json({ message: 'Search failed', error: error.message });
    }
};

// Create Single
exports.createEntry = async (req, res) => {
    try {
        const { postcode, district } = req.body;
        const entry = await PostcodeDistrict.create({ postcode, district });
        postcodeLogger.info(`Created entry: ${postcode}`);
        res.status(201).json({ success: true, data: entry });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ message: 'Postcode already exists' });
        }
        postcodeLogger.error(`Creation failed: ${error.message}`);
        res.status(500).json({ message: 'Creation failed' });
    }
};

// Update
exports.updateEntry = async (req, res) => {
    try {
        const { id } = req.params;
        const { district } = req.body;
        await PostcodeDistrict.updateOne({ _id: id }, { $set: { district } });
        postcodeLogger.info(`Updated entry ${id}`);
        res.status(200).json({ success: true });
    } catch (error) {
        postcodeLogger.error(`Update failed: ${error.message}`);
        res.status(500).json({ message: 'Update failed' });
    }
};

// Delete
exports.deleteEntry = async (req, res) => {
    try {
        const { id } = req.params;
        await PostcodeDistrict.deleteOne({ _id: id });
        postcodeLogger.info(`Deleted entry ${id}`);
        res.status(200).json({ success: true });
    } catch (error) {
        postcodeLogger.error(`Deletion failed: ${error.message}`);
        res.status(500).json({ message: 'Deletion failed' });
    }
};

// Check list of postcodes and report which are missing
exports.checkPostcodes = async (req, res) => {
    try {
        const inputPostcodes = Array.isArray(req.body?.postcodes) ? req.body.postcodes : [];

        if (!inputPostcodes.length) {
            return res.status(400).json({
                success: false,
                message: 'Please provide at least one postcode.'
            });
        }

        if (inputPostcodes.length > 500) {
            return res.status(400).json({
                success: false,
                message: 'Maximum 500 postcodes are allowed per check.'
            });
        }

        const normalized = inputPostcodes
            .map((item) => normalizePostcode(item))
            .filter(Boolean);

        const uniquePostcodes = Array.from(new Set(normalized));

        if (!uniquePostcodes.length) {
            return res.status(400).json({
                success: false,
                message: 'No valid postcodes found after normalization.'
            });
        }

        // Uses exact match on indexed postcode field for high performance.
        const foundDocs = await PostcodeDistrict.find(
            { postcode: { $in: uniquePostcodes } },
            { _id: 0, postcode: 1 }
        ).lean();

        const foundSet = new Set(foundDocs.map((doc) => doc.postcode));
        const missingPostcodes = uniquePostcodes.filter((postcode) => !foundSet.has(postcode));

        return res.status(200).json({
            success: true,
            data: {
                inputCount: inputPostcodes.length,
                normalizedCount: normalized.length,
                uniqueCount: uniquePostcodes.length,
                foundCount: uniquePostcodes.length - missingPostcodes.length,
                missingCount: missingPostcodes.length,
                missingPostcodes
            }
        });
    } catch (error) {
        postcodeLogger.error(`Check postcodes failed: ${error.message}`);
        return res.status(500).json({
            success: false,
            message: 'Postcode check failed',
            error: error.message
        });
    }
};

exports.startCheckJob = async (req, res) => {
    try {
        const job = await PostcodeImportJob.create({
            jobType: 'check',
            status: 'pending',
            stage: 'queued'
        });

        readJobState(job._id);

        postcodeLogger.info(`Started postcode check job: ${job._id}`);
        return res.status(200).json({ success: true, jobId: job._id });
    } catch (error) {
        postcodeLogger.error(`Error starting postcode check job: ${error.message}`);
        return res.status(500).json({ success: false, message: 'Failed to start postcode check job' });
    }
};

exports.uploadAndProcessCheckFile = async (req, res) => {
    const { jobId } = req.params;

    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No CSV file uploaded' });
    }

    try {
        res.status(202).json({ success: true, message: 'File accepted for background processing' });

        const job = await PostcodeImportJob.findById(jobId);
        if (!job) {
            postcodeLogger.warn(`Check job ${jobId} not found, deleting uploaded file.`);
            await fs.promises.unlink(req.file.path).catch(() => undefined);
            return;
        }

        const state = readJobState(jobId);
        state.stopRequested = false;

        job.jobType = 'check';
        job.status = 'processing';
        job.stage = 'reading';
        job.inputFileName = req.file.originalname;
        job.stopRequested = false;
        job.totalProcessed = 0;
        job.inputCount = 0;
        job.uniqueCount = 0;
        job.foundCount = 0;
        job.missingCount = 0;
        job.insertedCount = 0;
        job.errorCount = 0;
        job.sampleMissingPostcodes = [];
        job.errorLogs = [];
        job.resultFileName = '';
        job.resultFilePath = '';
        await job.save();

        processCheckCsvFile(req.file.path, jobId).catch(async (error) => {
            postcodeLogger.error(`Check job ${jobId} failed: ${error.message}`);
            try {
                const failedJob = await PostcodeImportJob.findById(jobId);
                if (failedJob) {
                    failedJob.status = 'failed';
                    failedJob.stage = 'failed';
                    failedJob.stopRequested = false;
                    pushErrorLog(failedJob, error.message);
                    await failedJob.save();
                }
            } catch (saveError) {
                postcodeLogger.error(`Failed to persist check job failure ${jobId}: ${saveError.message}`);
            }
        });
    } catch (error) {
        postcodeLogger.error(`Error starting check upload for ${jobId}: ${error.message}`);
        return res.status(500).json({ success: false, message: 'Failed to start postcode check processing' });
    }
};

const processCheckCsvFile = async (filePath, jobId) => {
    await ensureCheckDirectories();

    const job = await PostcodeImportJob.findById(jobId);
    if (!job) {
        await fs.promises.unlink(filePath).catch(() => undefined);
        return;
    }

    const state = readJobState(jobId);
    const resultFileName = `postcode_missing_${jobId}_${Date.now()}.csv`;
    const resultFilePath = path.join(CHECK_RESULT_DIR, resultFileName);
    const resultStream = fs.createWriteStream(resultFilePath, { encoding: 'utf8' });

    resultStream.write('postcode\n');

    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 }).pipe(parse({
        columns: false,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
        relax_quotes: true
    }));

    const seenPostcodes = new Set();
    let pendingPostcodes = [];
    let inputCount = 0;
    let uniqueCount = 0;
    let foundCount = 0;
    let missingCount = 0;
    let invalidCount = 0;
    const sampleMissingPostcodes = [];

    const saveProgress = async () => {
        job.totalProcessed = inputCount;
        job.inputCount = inputCount;
        job.uniqueCount = uniqueCount;
        job.foundCount = foundCount;
        job.missingCount = missingCount;
        job.insertedCount = foundCount;
        job.errorCount = invalidCount;
        job.sampleMissingPostcodes = sampleMissingPostcodes;
        job.resultFileName = resultFileName;
        job.resultFilePath = resultFilePath;
        await job.save();
    };

    const writeResultLine = async (postcode) => {
        if (resultStream.write(`${escapeCsvCell(postcode)}\n`)) {
            return;
        }

        await new Promise((resolve) => resultStream.once('drain', resolve));
    };

    const flushPending = async () => {
        if (!pendingPostcodes.length) {
            return;
        }

        job.stage = 'checking';
        const foundDocs = await PostcodeDistrict.find(
            { postcode: { $in: pendingPostcodes } },
            { _id: 0, postcode: 1 }
        ).lean();

        const foundSet = new Set(foundDocs.map((doc) => normalizePostcode(doc.postcode)));
        let chunkFound = 0;
        let chunkMissing = 0;

        for (const postcode of pendingPostcodes) {
            if (foundSet.has(postcode)) {
                chunkFound += 1;
                continue;
            }

            chunkMissing += 1;
            if (sampleMissingPostcodes.length < CHECK_SAMPLE_LIMIT) {
                sampleMissingPostcodes.push(postcode);
            }

            await writeResultLine(postcode);
        }

        foundCount += chunkFound;
        missingCount += chunkMissing;
        pendingPostcodes = [];

        job.stage = 'writing';
        await saveProgress();
    };

    try {
        for await (const record of stream) {
            inputCount += 1;

            if (state.stopRequested) {
                postcodeLogger.warn(`Stop requested for postcode check job ${jobId}`);
                break;
            }

            if (!Array.isArray(record) || record.length === 0) {
                invalidCount += 1;
                continue;
            }

            const rawPostcode = cleanText(record[0]);

            if (!rawPostcode) {
                invalidCount += 1;
                continue;
            }

            if (rawPostcode.toLowerCase() === 'postcode') {
                continue;
            }

            const postcode = normalizePostcode(rawPostcode);
            if (!postcode) {
                invalidCount += 1;
                continue;
            }

            if (seenPostcodes.has(postcode)) {
                continue;
            }

            seenPostcodes.add(postcode);
            uniqueCount += 1;
            pendingPostcodes.push(postcode);

            if (inputCount % 5000 === 0) {
                job.stage = pendingPostcodes.length ? 'checking' : 'reading';
                await saveProgress();
            }

            if (pendingPostcodes.length >= CHECK_BATCH_SIZE) {
                await flushPending();
            }
        }

        await flushPending();

        await new Promise((resolve, reject) => {
            resultStream.end(() => resolve());
            resultStream.on('error', reject);
        });

        const finalStatus = state.stopRequested ? 'stopped' : 'completed';
        job.status = finalStatus;
        job.stage = finalStatus;
        job.stopRequested = false;
        if (finalStatus === 'completed') {
            job.completedAt = new Date();
        }
        await saveProgress();

        postcodeLogger.info(`Postcode check job ${jobId} finished with status=${finalStatus}, input=${inputCount}, unique=${uniqueCount}, found=${foundCount}, missing=${missingCount}, invalid=${invalidCount}`);
    } catch (error) {
        try {
            resultStream.destroy();
        } catch (streamError) {
            postcodeLogger.warn(`Failed to destroy result stream for job ${jobId}: ${streamError.message}`);
        }

        job.status = 'failed';
        job.stage = 'failed';
        job.stopRequested = false;
        pushErrorLog(job, error.message);
        await job.save();
        throw error;
    } finally {
        activeCheckJobs.delete(jobId.toString());
        await fs.promises.unlink(filePath).catch(() => undefined);
    }
};

exports.getCheckStatus = async (req, res) => {
    try {
        const job = await PostcodeImportJob.findById(req.params.jobId).lean();
        if (!job) {
            return res.status(404).json({ success: false, message: 'Job not found' });
        }

        return res.status(200).json({ success: true, data: job });
    } catch (error) {
        postcodeLogger.error(`Error getting postcode check status: ${error.message}`);
        return res.status(500).json({ success: false, message: 'Failed to fetch postcode check status' });
    }
};

exports.stopCheckJob = async (req, res) => {
    try {
        const job = await PostcodeImportJob.findById(req.params.jobId);
        if (!job) {
            return res.status(404).json({ success: false, message: 'Job not found' });
        }

        job.stopRequested = true;
        if (job.status === 'pending') {
            job.status = 'stopped';
            job.stage = 'stopped';
        }
        await job.save();

        const state = readJobState(job._id);
        state.stopRequested = true;

        postcodeLogger.info(`Stop requested for postcode check job ${job._id}`);
        return res.status(200).json({ success: true, message: 'Stop requested' });
    } catch (error) {
        postcodeLogger.error(`Error stopping postcode check job: ${error.message}`);
        return res.status(500).json({ success: false, message: 'Failed to stop postcode check job' });
    }
};

exports.downloadCheckResult = async (req, res) => {
    try {
        const job = await PostcodeImportJob.findById(req.params.jobId).lean();
        if (!job) {
            return res.status(404).json({ success: false, message: 'Job not found' });
        }

        if (!job.resultFilePath || !fs.existsSync(job.resultFilePath)) {
            return res.status(404).json({ success: false, message: 'Result file not available yet' });
        }

        return res.download(job.resultFilePath, job.resultFileName || path.basename(job.resultFilePath));
    } catch (error) {
        postcodeLogger.error(`Error downloading postcode check result: ${error.message}`);
        return res.status(500).json({ success: false, message: 'Failed to download postcode check result' });
    }
};
