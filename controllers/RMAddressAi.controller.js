const mongoose = require('mongoose');
const RMAddressAiJob = require('../models/RMAddressAiJob');
const RMAddressAiCorrection = require('../models/RMAddressAiCorrection');
const RMAddressManualReview = require('../models/RMAddressManualReview');
const AddressMasterMerged = require('../models/AddressMasterMerged');
const rmAddressLogger = require('../config/loggers/rmAddressLogger');

const BATCH_TARGET = 300;


const createJob = async (req, res) => {
    try {
        const { jobName } = req.body || {};
        const job = await RMAddressAiJob.create({
            jobName: jobName || `ai_run_${Date.now()}`
        });
        rmAddressLogger.info(`AI job created: ${job._id} — ${job.jobName}`);
        return res.json({ success: true, jobId: job._id, job });
    } catch (error) {
        rmAddressLogger.error(`Create AI job failed: ${error.message}`);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const listJobs = async (req, res) => {
    try {
        const jobs = await RMAddressAiJob.find()
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();
        return res.json({ success: true, jobs });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

const getJobStatus = async (req, res) => {
    try {
        const job = await RMAddressAiJob.findById(req.params.jobId).lean();
        if (!job) return res.status(404).json({ success: false, message: 'Job not found' });

        const [pendingCorrections, pendingManualReview] = await Promise.all([
            RMAddressAiCorrection.countDocuments({ jobId: req.params.jobId, status: 'pending' }),
            RMAddressManualReview.countDocuments({ jobId: req.params.jobId, status: 'pending' })
        ]);

        return res.json({ success: true, job: { ...job, pendingCorrections, pendingManualReview } });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

const pauseJob = async (req, res) => {
    try {
        await RMAddressAiJob.findByIdAndUpdate(req.params.jobId, { status: 'paused' });
        return res.json({ success: true, message: 'Job paused' });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

const resumeJob = async (req, res) => {
    try {
        await RMAddressAiJob.findByIdAndUpdate(req.params.jobId, { status: 'running' });
        return res.json({ success: true, message: 'Job resumed' });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

const resetJob = async (req, res) => {
    try {
        await RMAddressAiJob.findByIdAndUpdate(req.params.jobId, {
            lastProcessedId: null,
            lastPostcode: null,
            totalFetched: 0,
            totalBatchesComplete: 0,
            totalCorrections: 0,
            totalManualReview: 0,
            totalClean: 0,
            status: 'running'
        });
        return res.json({ success: true, message: 'Job reset to beginning' });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};


const getNextBatch = async (req, res) => {
    try {
        const job = await RMAddressAiJob.findById(req.params.jobId);
        if (!job) return res.status(404).json({ success: false, message: 'Job not found' });

        if (job.status === 'paused') {
            return res.json({ success: true, paused: true, message: 'Job is paused' });
        }
        if (job.status === 'completed') {
            return res.json({ success: true, complete: true, message: 'All records processed' });
        }

        const baseQuery = job.lastProcessedId
            ? { _id: { $gt: new mongoose.Types.ObjectId(job.lastProcessedId) } }
            : {};

        const initialBatch = await AddressMasterMerged.find(baseQuery)
            .sort({ _id: 1 })
            .limit(BATCH_TARGET)
            .select({ postcode: 1, district: 1, address: 1, dateCreated: 1 })
            .lean();

        if (!initialBatch.length) {
            await RMAddressAiJob.findByIdAndUpdate(job._id, { status: 'completed' });
            return res.json({ success: true, complete: true, records: [], message: 'All records processed' });
        }

        const lastRecord = initialBatch[initialBatch.length - 1];
        const lastPostcode = lastRecord.postcode;

        const remainderOfBlock = await AddressMasterMerged.find({
            _id: { $gt: lastRecord._id },
            postcode: lastPostcode
        })
            .sort({ _id: 1 })
            .select({ postcode: 1, district: 1, address: 1, dateCreated: 1 })
            .lean();

        const fullBatch = [...initialBatch, ...remainderOfBlock];
        const finalLastId = fullBatch[fullBatch.length - 1]._id;

        const formattedRecords = fullBatch.map((r) => ({
            id: String(r._id),
            postcode: r.postcode,
            district: r.district,
            address: formatAddressForAi(r.address),
            formatted: `${r.postcode},${formatAddressForAi(r.address)}`
        }));

        const grouped = groupByPostcode(formattedRecords);

        return res.json({
            success: true,
            complete: false,
            batchNumber: job.totalBatchesComplete + 1,
            recordCount: fullBatch.length,
            initialCount: initialBatch.length,
            blockCompletionCount: remainderOfBlock.length,
            lastPostcode,
            lastIdInBatch: String(finalLastId),
            grouped,
            records: formattedRecords
        });
    } catch (error) {
        rmAddressLogger.error(`getNextBatch failed: ${error.message}`);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const submitBatchResults = async (req, res) => {
    try {
        const { jobId } = req.params;
        const {
            lastIdInBatch,
            lastPostcode,
            batchNumber,
            corrections = [],
            manualReview = [],
            cleanCount = 0
        } = req.body || {};

        if (!lastIdInBatch) {
            return res.status(400).json({ success: false, message: 'lastIdInBatch is required' });
        }

        const session = await mongoose.startSession();
        session.startTransaction();

        try {

            if (corrections.length > 0) {
                const correctionDocs = corrections.map((c) => ({
                    jobId,
                    originalId: new mongoose.Types.ObjectId(c.originalId),
                    postcode: c.postcode,
                    originalAddress: c.originalAddress,
                    correctedAddress: c.correctedAddress,
                    correctionType: c.correctionType,
                    confidence: c.confidence || 'high',
                    status: 'pending',   
                    batchNumber
                }));
                await RMAddressAiCorrection.insertMany(correctionDocs, { session });
            }

            if (manualReview.length > 0) {
                const originalIds = manualReview.map((r) => new mongoose.Types.ObjectId(r.originalId));

                const originalDocs = await AddressMasterMerged.find(
                    { _id: { $in: originalIds } }
                ).lean();

                const originalDocsMap = {};
                for (const doc of originalDocs) {
                    originalDocsMap[String(doc._id)] = doc;
                }

                const reviewDocs = manualReview.map((r) => {
                    const original = originalDocsMap[r.originalId] || {};
                    return {
                        jobId,
                        originalId: new mongoose.Types.ObjectId(r.originalId),
                        postcode: original.postcode,
                        district: original.district,
                        address: original.address,          
                        dateCreated: original.dateCreated,
                        correctionVersion: original.correctionVersion,
                        exceptionVersion: original.exceptionVersion,
                        aiOriginalFormatted: r.originalAddress,
                        aiSuggestedAddress: r.suggestedAddress || '',
                        reason: r.reason,
                        status: 'pending',
                        removedFromMain: false,
                        batchNumber
                    };
                });

                await RMAddressManualReview.insertMany(reviewDocs, { session });

                await AddressMasterMerged.deleteMany(
                    { _id: { $in: originalIds } },
                    { session }
                );

                await RMAddressManualReview.updateMany(
                    { originalId: { $in: originalIds }, jobId },
                    { $set: { removedFromMain: true } },
                    { session }
                );
            }

            await RMAddressAiJob.findByIdAndUpdate(jobId, {
                $set: {
                    lastProcessedId: lastIdInBatch,
                    lastPostcode: lastPostcode
                },
                $inc: {
                    totalFetched: corrections.length + manualReview.length + cleanCount,
                    totalBatchesComplete: 1,
                    totalCorrections: corrections.length,
                    totalManualReview: manualReview.length,
                    totalClean: cleanCount
                }
            }, { session });

            await session.commitTransaction();
        } catch (error) {
            await session.abortTransaction();
            throw error;
        } finally {
            session.endSession();
        }

        rmAddressLogger.info(`Batch ${batchNumber} saved for job ${jobId}: ${corrections.length} staged, ${manualReview.length} manual, ${cleanCount} clean`);

        return res.json({
            success: true,
            message: `Batch ${batchNumber} saved — ${corrections.length} staged for approval, ${manualReview.length} manual review, ${cleanCount} clean`
        });
    } catch (error) {
        rmAddressLogger.error(`submitBatchResults failed: ${error.message}`);
        return res.status(500).json({ success: false, message: error.message });
    }
};


const getCorrections = async (req, res) => {
    try {
        const {
            jobId,
            status = 'pending',
            correctionType,
            page = 1,
            limit = 50
        } = req.query;

        const query = { status };
        if (jobId) query.jobId = jobId;
        if (correctionType) query.correctionType = correctionType;

        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);

        const [corrections, total] = await Promise.all([
            RMAddressAiCorrection.find(query)
                .sort({ createdAt: -1 })
                .skip((pageNum - 1) * limitNum)
                .limit(limitNum)
                .lean(),
            RMAddressAiCorrection.countDocuments(query)
        ]);

        const correctionTypes = await RMAddressAiCorrection.distinct('correctionType', jobId ? { jobId } : {});

        return res.json({
            success: true,
            corrections,
            total,
            page: pageNum,
            totalPages: Math.ceil(total / limitNum),
            correctionTypes
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

const approveCorrection = async (req, res) => {
    try {
        const correction = await RMAddressAiCorrection.findById(req.params.id);
        if (!correction) return res.status(404).json({ success: false, message: 'Not found' });
        if (correction.status !== 'pending') {
            return res.status(400).json({ success: false, message: `Already ${correction.status}` });
        }

        await AddressMasterMerged.findByIdAndUpdate(
            correction.originalId,
            {
                $set: {
                    address: JSON.stringify(
                        correction.correctedAddress.split(',').map((p) => p.trim()).filter(Boolean)
                    ),
                    correctionVersion: 'v1-ai-corrected'
                }
            }
        );

        await RMAddressAiCorrection.findByIdAndUpdate(req.params.id, { status: 'approved' });
        rmAddressLogger.info(`Correction ${req.params.id} approved`);

        return res.json({ success: true });
    } catch (error) {
        rmAddressLogger.error(`approveCorrection failed: ${error.message}`);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const rejectCorrection = async (req, res) => {
    try {
        const correction = await RMAddressAiCorrection.findById(req.params.id);
        if (!correction) return res.status(404).json({ success: false, message: 'Not found' });

        await RMAddressAiCorrection.findByIdAndUpdate(req.params.id, { status: 'rejected' });

        return res.json({ success: true });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

const bulkApproveCorrections = async (req, res) => {
    try {
        const { jobId, correctionType } = req.body || {};

        const query = { status: 'pending' };
        if (jobId) query.jobId = jobId;
        if (correctionType) query.correctionType = correctionType;

        const corrections = await RMAddressAiCorrection.find(query).lean();
        if (!corrections.length) {
            return res.json({ success: true, approved: 0, message: 'Nothing to approve' });
        }

        const ops = corrections.map((c) => ({
            updateOne: {
                filter: { _id: c.originalId },
                update: {
                    $set: {
                        address: JSON.stringify(
                            c.correctedAddress.split(',').map((p) => p.trim()).filter(Boolean)
                        ),
                        correctionVersion: 'v1-ai-corrected'
                    }
                }
            }
        }));

        await AddressMasterMerged.bulkWrite(ops, { ordered: false });
        await RMAddressAiCorrection.updateMany(query, { $set: { status: 'approved' } });

        rmAddressLogger.info(`Bulk approved ${corrections.length} corrections (type: ${correctionType || 'all'})`);

        return res.json({ success: true, approved: corrections.length });
    } catch (error) {
        rmAddressLogger.error(`bulkApproveCorrections failed: ${error.message}`);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const bulkRejectCorrections = async (req, res) => {
    try {
        const { jobId, correctionType } = req.body || {};

        const query = { status: 'pending' };
        if (jobId) query.jobId = jobId;
        if (correctionType) query.correctionType = correctionType;

        const result = await RMAddressAiCorrection.updateMany(query, { $set: { status: 'rejected' } });

        return res.json({ success: true, rejected: result.modifiedCount });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};


const getManualReviewItems = async (req, res) => {
    try {
        const { jobId, status = 'pending', page = 1, limit = 50 } = req.query;

        const query = { status };
        if (jobId) query.jobId = jobId;

        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);

        const [items, total] = await Promise.all([
            RMAddressManualReview.find(query)
                .sort({ createdAt: -1 })
                .skip((pageNum - 1) * limitNum)
                .limit(limitNum)
                .lean(),
            RMAddressManualReview.countDocuments(query)
        ]);

        return res.json({
            success: true,
            items,
            total,
            page: pageNum,
            totalPages: Math.ceil(total / limitNum)
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

const resolveManualReview = async (req, res) => {
    try {
        const { action, correctedAddress } = req.body || {};

        const item = await RMAddressManualReview.findById(req.params.id);
        if (!item) return res.status(404).json({ success: false, message: 'Not found' });
        if (item.status !== 'pending') {
            return res.status(400).json({ success: false, message: `Already resolved: ${item.status}` });
        }

        if (action === 'restore_original') {
            await AddressMasterMerged.create({
                _id: new mongoose.Types.ObjectId(String(item.originalId)),
                postcode: item.postcode,
                district: item.district,
                address: item.address,         
                dateCreated: item.dateCreated,
                correctionVersion: item.correctionVersion,
                exceptionVersion: item.exceptionVersion
            });
            await RMAddressManualReview.findByIdAndUpdate(req.params.id, { status: 'restored' });
            rmAddressLogger.info(`Manual review ${req.params.id} restored to main collection`);

        } else if (action === 'apply_suggestion') {
            const addressToApply = correctedAddress || item.aiSuggestedAddress;
            if (!addressToApply) {
                return res.status(400).json({ success: false, message: 'No corrected address provided' });
            }

            await AddressMasterMerged.create({
                postcode: item.postcode,
                district: item.district,
                address: JSON.stringify(
                    addressToApply.split(',').map((p) => p.trim()).filter(Boolean)
                ),
                dateCreated: item.dateCreated,
                correctionVersion: 'v1-ai-corrected'
            });
            await RMAddressManualReview.findByIdAndUpdate(req.params.id, { status: 'applied' });
            rmAddressLogger.info(`Manual review ${req.params.id} applied with correction`);

        } else if (action === 'delete_permanently') {
            await RMAddressManualReview.findByIdAndUpdate(req.params.id, {
                status: 'deleted_permanently'
            });
            rmAddressLogger.info(`Manual review ${req.params.id} permanently deleted`);

        } else {
            return res.status(400).json({ success: false, message: `Unknown action: ${action}` });
        }

        return res.json({ success: true });
    } catch (error) {
        rmAddressLogger.error(`resolveManualReview failed: ${error.message}`);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const formatAddressForAi = (address) => {
    if (typeof address === 'string' && address.startsWith('[')) {
        try {
            const parsed = JSON.parse(address);
            if (Array.isArray(parsed)) return parsed.join(', ');
        } catch (e) {}
    }
    return address || '';
};

const groupByPostcode = (records) => {
    return records.reduce((acc, r) => {
        if (!acc[r.postcode]) acc[r.postcode] = [];
        acc[r.postcode].push(r);
        return acc;
    }, {});
};

module.exports = {
    RMAddressAiController: {
        createJob,
        listJobs,
        getJobStatus,
        pauseJob,
        resumeJob,
        resetJob,
        getNextBatch,
        submitBatchResults,
        getCorrections,
        approveCorrection,
        rejectCorrection,
        bulkApproveCorrections,
        bulkRejectCorrections,
        getManualReviewItems,
        resolveManualReview
    }
};