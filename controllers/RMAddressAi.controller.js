const mongoose = require('mongoose');
const RMAddressAiJob = require('../models/RMAddressAiJob');
const RMAddressAiCorrection = require('../models/RMAddressAiCorrection');
const RMAddressManualReview = require('../models/RMAddressManualReview');
const AddressMasterMerged = require('../models/AddressMasterMerged');
const AddressMasterChecked = require('../models/AddressMasterChecked');
const AddressMasterPending = require('../models/AddressMasterPending');
const AddressMasterAiTemp = require('../models/AddressMasterAiTemp');
const PostcodeDistrict = require('../models/PostcodeDistrict');
const AddressMasterAiQueue = require('../models/AddressMasterAiQueue');
const rmAddressLogger = require('../config/loggers/rmAddressLogger');
const { parse } = require('csv-parse');
const fs = require('fs');

const BATCH_TARGET = 300;

const districtCache = new Map();

const resolveDistrict = async (postcode) => {
    if (districtCache.has(postcode)) return districtCache.get(postcode);

    const exact = await PostcodeDistrict.findOne({ postcode }).lean();
    if (exact?.district) {
        const d = exact.district.toUpperCase().trim();
        districtCache.set(postcode, d);
        return d;
    }

    const outward = postcode.split(' ')[0] || '';
    const prefix = await PostcodeDistrict.findOne({
        postcode: { $regex: `^${outward.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`, $options: 'i' }
    }).lean();

    const district = prefix?.district ? prefix.district.toUpperCase().trim() : null;
    districtCache.set(postcode, district);
    return district;
};

const normalizePostcode = (v) => {
    if (!v) return '';
    const compact = v.toString().trim().toUpperCase().replace(/\s+/g, ' ').replace(/[^A-Z0-9 ]/g, '');
    if (!compact) return '';
    const noSpace = compact.replace(/\s+/g, '');
    if (noSpace.length > 3) {
        return `${noSpace.slice(0, noSpace.length - 3)} ${noSpace.slice(noSpace.length - 3)}`;
    }
    return compact;
};

const getDateCreated = () => {
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}/${now.getFullYear()}`;
};

const getSourceModel = (sourceCollection) => {
    switch (sourceCollection) {
        case 'address_master_precheck': return require('../models/AddressMasterPrecheck');
        case 'address_master_ai_queue': return require('../models/AddressMasterAiQueue');
        case 'address_master_pending':  return require('../models/AddressMasterPending');
        case 'address_master_checked':  return AddressMasterChecked;
        default:                        return AddressMasterMerged;
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

// Upsert a corrected/clean address into address_master_checked (the new AI
// master). District is always resolved server-side from PostcodeDistrict —
// the Ollama/LM Studio client never supplies it.
const upsertChecked = async (postcode, addressParts, dateCreated) => {
    const district = await resolveDistrict(postcode);
    if (!district) return { ok: false, reason: `No district found for postcode ${postcode}` };

    await AddressMasterChecked.updateOne(
        { postcode, address: JSON.stringify(addressParts) },
        {
            $set: {
                postcode,
                district,
                address: JSON.stringify(addressParts),
                correctionVersion: 'v1-ai-corrected'
            },
            $setOnInsert: { dateCreated }
        },
        { upsert: true }
    );
    return { ok: true };
};


const createJob = async (req, res) => {
    try {
        const { jobName, sourceCollection } = req.body || {};

        const validCollections = ['address_master_merged', 'address_master_pending', 'address_master_precheck', 'address_master_ai_queue'];

        const resolvedSource = validCollections.includes(sourceCollection)
            ? sourceCollection
            : 'address_master_ai_queue';

        const job = await RMAddressAiJob.create({
            jobName: jobName || `ai_run_${Date.now()}`,
            sourceCollection: resolvedSource
        });

        rmAddressLogger.info(`AI job created: ${job._id} — ${job.jobName} — source: ${resolvedSource}`);
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
        if (!mongoose.Types.ObjectId.isValid(req.params.jobId)) {
            return res.status(404).json({ success: false, message: 'Invalid job ID format' });
        }

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
        if (job.status === 'completed' || job.status === 'stopped') {
            return res.json({ success: true, complete: true, message: 'Job finished' });
        }

        if (job.stopRequested) {
            await RMAddressAiJob.findByIdAndUpdate(job._id, {
                status: 'stopped',
                stopRequested: false
            });
            rmAddressLogger.info(`AI job ${job._id} stopped cleanly after batch completion`);
            return res.json({ success: true, stopped: true, message: 'Job stopped cleanly' });
        }

        const Model = getSourceModel(job.sourceCollection);

        const baseQuery = job.lastProcessedId
            ? { _id: { $gt: new mongoose.Types.ObjectId(job.lastProcessedId) } }
            : {};

        const initialBatch = await Model.find(baseQuery)
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

        const remainderOfBlock = await Model.find({
            _id: { $gt: lastRecord._id },
            postcode: lastPostcode
        })
            .sort({ _id: 1 })
            .select({ postcode: 1, district: 1, address: 1, dateCreated: 1 })
            .lean();

        const fullBatch = [...initialBatch, ...remainderOfBlock];
        const finalLastId = fullBatch[fullBatch.length - 1]._id;

        // Format for the AI client as "<24-char id>|<address text>" so its
        // response schema ("id" copied verbatim before "|") lines up exactly
        // with what's sent.
        const formattedRecords = fullBatch.map((r) => ({
            id: String(r._id),
            postcode: r.postcode,
            district: r.district,
            address: formatAddressForAi(r.address),
            formatted: `${String(r._id)}|${formatAddressForAi(r.address)}`
        }));

        const grouped = groupByPostcode(formattedRecords);

        return res.json({
            success: true,
            complete: false,
            sourceCollection: job.sourceCollection,
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
            corrections    = [],
            manualReview   = [],
            cleanCount     = 0,
            batchRecordIds = []
        } = req.body || {};

        if (!lastIdInBatch) {
            return res.status(400).json({ success: false, message: 'lastIdInBatch is required' });
        }

        const job = await RMAddressAiJob.findById(jobId).lean();
        if (!job) return res.status(404).json({ success: false, message: 'Job not found' });

        const SourceModel = getSourceModel(job.sourceCollection);

        // ── Step 1: Copy entire batch to TEMP collection ──
        if (batchRecordIds.length > 0) {
            const originalIds  = batchRecordIds.map(id => new mongoose.Types.ObjectId(id));
            const originalDocs = await SourceModel.find({ _id: { $in: originalIds } }).lean();

            const correctionIdSet    = new Set(corrections.map(c => c.originalId));
            const manualReviewIdSet  = new Set(manualReview.map(r => r.originalId));

            const tempOps = originalDocs.map(doc => {
                const idStr = String(doc._id);
                let recordStatus = 'clean';
                if (correctionIdSet.has(idStr))   recordStatus = 'pending_correction';
                if (manualReviewIdSet.has(idStr))  recordStatus = 'pending_manual_review';

                return {
                    updateOne: {
                        filter: { originalId: doc._id },
                        update: { $setOnInsert: {
                            jobId:        new mongoose.Types.ObjectId(jobId),
                            batchNumber,
                            originalId:   doc._id,
                            postcode:     doc.postcode,
                            district:     doc.district,
                            address:      doc.address,
                            dateCreated:  doc.dateCreated,
                            correctionVersion: doc.correctionVersion || 'v1',
                            recordStatus
                        }},
                        upsert: true
                    }
                };
            });

            if (tempOps.length) {
                await AddressMasterAiTemp.bulkWrite(tempOps, { ordered: false });
            }
        }

        // ── Step 2: Stage corrections for admin review ──
        if (corrections.length > 0) {
            const correctionOps = corrections.map(c => ({
                updateOne: {
                    filter: {
                        jobId,
                        originalId: new mongoose.Types.ObjectId(c.originalId)
                    },
                    update: {
                        $setOnInsert: {
                            jobId,
                            originalId:       new mongoose.Types.ObjectId(c.originalId),
                            postcode:         c.postcode,
                            originalAddress:  c.originalAddress,
                            correctedAddress: c.correctedAddress,
                            correctionType:   c.correctionType,
                            confidence:       c.confidence || 'high',
                            status:           'pending',
                            batchNumber
                        }
                    },
                    upsert: true
                }
            }));
            await RMAddressAiCorrection.bulkWrite(correctionOps, { ordered: false });
        }

        // ── Step 3: Backup manual review records then delete from source ──
        if (manualReview.length > 0) {
            const originalIds  = manualReview.map(r => new mongoose.Types.ObjectId(r.originalId));
            const originalDocs = await SourceModel.find({ _id: { $in: originalIds } }).lean();
            const docsMap      = Object.fromEntries(originalDocs.map(d => [String(d._id), d]));

            const reviewDocs = manualReview.map(r => {
                const original = docsMap[r.originalId] || {};
                return {
                    jobId,
                    originalId:         new mongoose.Types.ObjectId(r.originalId),
                    sourceCollection:   job.sourceCollection || 'address_master_ai_queue',
                    postcode:           original.postcode,
                    district:           original.district,
                    address:            original.address,
                    dateCreated:        original.dateCreated,
                    correctionVersion:  original.correctionVersion,
                    aiOriginalFormatted: r.originalAddress,
                    aiSuggestedAddress: r.suggestedAddress || '',
                    reason:             r.reason,
                    status:             'pending',
                    removedFromMain:    false,
                    batchNumber
                };
            });

            await RMAddressManualReview.insertMany(reviewDocs, { ordered: false });
            await SourceModel.deleteMany({ _id: { $in: originalIds } });
            await RMAddressManualReview.updateMany(
                { originalId: { $in: originalIds }, jobId },
                { $set: { removedFromMain: true } }
            );
        }

        // ── Step 4: If batch is entirely clean → confirm immediately ──
        if (corrections.length === 0 && manualReview.length === 0) {
            await checkAndConfirmBatch(
                new mongoose.Types.ObjectId(jobId),
                batchNumber
            );
        }

        // ── Advance job cursor ──
        await RMAddressAiJob.findByIdAndUpdate(jobId, {
            $set: {
                lastProcessedId: lastIdInBatch,
                lastPostcode:    lastPostcode || ''
            },
            $inc: {
                totalFetched:         (batchRecordIds.length || 0),
                totalBatchesComplete: 1,
                totalCorrections:     corrections.length,
                totalManualReview:    manualReview.length,
                totalClean:           cleanCount
            }
        });

        rmAddressLogger.info(
            `Batch ${batchNumber} saved for job ${jobId}: ` +
            `${corrections.length} corrections, ${manualReview.length} manual, ` +
            `${cleanCount} clean, ${batchRecordIds.length} total in batch`
        );

        return res.json({
            success: true,
            message: `Batch ${batchNumber} saved — ${corrections.length} corrections staged, ${manualReview.length} manual review, ${cleanCount} clean`
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

        const job = await RMAddressAiJob.findById(correction.jobId).lean();
        if (!job) return res.status(404).json({ success: false, message: 'Parent job not found' });

        // Apply correction to the temp record
        await AddressMasterAiTemp.updateOne(
            { originalId: correction.originalId },
            { $set: {
                address:      JSON.stringify(
                    correction.correctedAddress.split(',').map(p => p.trim()).filter(Boolean)
                ),
                recordStatus: 'resolved'
            }}
        );

        await RMAddressAiCorrection.findByIdAndUpdate(req.params.id, { status: 'approved' });
        rmAddressLogger.info(`Correction ${req.params.id} approved`);

        // Check if entire batch is now resolved — auto-confirms if so
        await checkAndConfirmBatch(
            new mongoose.Types.ObjectId(String(correction.jobId)),
            correction.batchNumber
        );

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

        await AddressMasterAiTemp.updateOne(
            { originalId: correction.originalId },
            { $set: { recordStatus: 'resolved' } }
        );

        await RMAddressAiCorrection.findByIdAndUpdate(req.params.id, { status: 'rejected' });

        await checkAndConfirmBatch(
            new mongoose.Types.ObjectId(String(correction.jobId)),
            correction.batchNumber
        );

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

        const jobIds = [...new Set(corrections.map((c) => String(c.jobId)))];
        const jobs = await RMAddressAiJob.find({ _id: { $in: jobIds } }).lean();
        const jobMap = Object.fromEntries(jobs.map((j) => [String(j._id), j]));

        const uniquePostcodes = [...new Set(corrections.map((c) => c.postcode))];
        const districtMap = {};
        for (const pc of uniquePostcodes) {
            districtMap[pc] = await resolveDistrict(pc);
        }

        const dateCreated = getDateCreated();
        const checkedOps = [];
        const deletesBySource = {};
        const approvedIds = [];
        const resolvedOriginalIds = [];
        const skippedIds = [];
        const affectedBatches = new Map();

        for (const c of corrections) {
            const district = districtMap[c.postcode];
            if (!district) {
                skippedIds.push(c._id);
                continue;
            }

            const parts = c.correctedAddress
                .split(',')
                .map((p) => p.trim())
                .filter(Boolean);

            checkedOps.push({
                updateOne: {
                    filter: {
                        postcode: c.postcode,
                        address: JSON.stringify(parts)
                    },
                    update: {
                        $set: {
                            postcode: c.postcode,
                            district,
                            address: JSON.stringify(parts),
                            correctionVersion: 'v1-ai-corrected'
                        },
                        $setOnInsert: {
                            dateCreated
                        }
                    },
                    upsert: true
                }
            });

            const src = jobMap[String(c.jobId)]?.sourceCollection || 'address_master_ai_queue';
            (deletesBySource[src] ||= []).push(c.originalId);

            approvedIds.push(c._id);
            resolvedOriginalIds.push(c.originalId);

            affectedBatches.set(
                `${String(c.jobId)}_${c.batchNumber}`,
                {
                    jobId: c.jobId,
                    batchNumber: c.batchNumber
                }
            );
        }

        if (checkedOps.length) {
            await AddressMasterChecked.bulkWrite(checkedOps, { ordered: false });
        }

        for (const [src, ids] of Object.entries(deletesBySource)) {
            const SourceModel = getSourceModel(src);
            await SourceModel.deleteMany({ _id: { $in: ids } });
        }

        if (approvedIds.length) {
            await RMAddressAiCorrection.updateMany(
                { _id: { $in: approvedIds } },
                { $set: { status: 'approved' } }
            );

            await AddressMasterAiTemp.updateMany(
                { originalId: { $in: resolvedOriginalIds } },
                { $set: { recordStatus: 'resolved' } }
            );
        }

        for (const { jobId, batchNumber } of affectedBatches.values()) {
            await checkAndConfirmBatch(jobId, batchNumber);
        }

        if (skippedIds.length) {
            rmAddressLogger.error(
                `bulkApproveCorrections: ${skippedIds.length} skipped — no district found for their postcodes`
            );
        }

        rmAddressLogger.info(
            `Bulk approved ${approvedIds.length} corrections → address_master_checked (type: ${correctionType || 'all'})`
        );

        return res.json({
            success: true,
            approved: approvedIds.length,
            skipped: skippedIds.length
        });

    } catch (error) {
        rmAddressLogger.error(`bulkApproveCorrections failed: ${error.message}`);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

const bulkRejectCorrections = async (req, res) => {
    try {
        const { jobId, correctionType } = req.body || {};

        const query = { status: 'pending' };
        if (jobId) query.jobId = jobId;
        if (correctionType) query.correctionType = correctionType;

        const corrections = await RMAddressAiCorrection.find(query)
            .select({
                _id: 1,
                jobId: 1,
                batchNumber: 1,
                originalId: 1
            })
            .lean();

        if (!corrections.length) {
            return res.json({
                success: true,
                rejected: 0,
                message: 'Nothing to reject'
            });
        }

        await RMAddressAiCorrection.updateMany(
            {
                _id: { $in: corrections.map(c => c._id) }
            },
            {
                $set: { status: 'rejected' }
            }
        );

        await AddressMasterAiTemp.updateMany(
            {
                originalId: {
                    $in: corrections.map(c => c.originalId)
                }
            },
            {
                $set: {
                    recordStatus: 'resolved'
                }
            }
        );

        const affectedBatches = new Map();

        for (const c of corrections) {
            affectedBatches.set(
                `${String(c.jobId)}_${c.batchNumber}`,
                {
                    jobId: c.jobId,
                    batchNumber: c.batchNumber
                }
            );
        }

        for (const { jobId, batchNumber } of affectedBatches.values()) {
            await checkAndConfirmBatch(jobId, batchNumber);
        }

        rmAddressLogger.info(
            `Bulk rejected ${corrections.length} corrections (type: ${correctionType || 'all'})`
        );

        return res.json({
            success: true,
            rejected: corrections.length
        });

    } catch (error) {
        rmAddressLogger.error(`bulkRejectCorrections failed: ${error.message}`);
        return res.status(500).json({
            success: false,
            message: error.message
        });
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

        const TargetModel = getSourceModel(item.sourceCollection);

        if (action === 'restore_original') {
            await TargetModel.create({
                _id: new mongoose.Types.ObjectId(String(item.originalId)),
                postcode: item.postcode,
                district: item.district,
                address: item.address,
                dateCreated: item.dateCreated,
                correctionVersion: item.correctionVersion,
                exceptionVersion: item.exceptionVersion
            });
            await RMAddressManualReview.findByIdAndUpdate(req.params.id, { status: 'restored' });

        } else if (action === 'apply_suggestion') {
            const addressToApply = correctedAddress || item.aiSuggestedAddress;
            if (!addressToApply) {
                return res.status(400).json({ success: false, message: 'No corrected address provided' });
            }

            const parts = addressToApply.split(',').map((p) => p.trim()).filter(Boolean);
            const result = await upsertChecked(item.postcode, parts, item.dateCreated || getDateCreated());
            if (!result.ok) {
                return res.status(422).json({ success: false, message: result.reason });
            }
            await RMAddressManualReview.findByIdAndUpdate(req.params.id, { status: 'applied' });

        } else if (action === 'delete_permanently') {
            await AddressMasterAiTemp.deleteOne({ originalId: item.originalId });
            await RMAddressManualReview.findByIdAndUpdate(req.params.id, { status: 'deleted_permanently' });
            
        } else {
            return res.status(400).json({ success: false, message: `Unknown action: ${action}` });
        }

        await AddressMasterAiTemp.updateOne(
            { originalId: item.originalId },
            { $set: { recordStatus: 'resolved' } }
        );

        // Resolve the batch if all items are done
        const correction = await RMAddressAiCorrection.findOne({
            originalId: item.originalId
        }).lean();

        if (correction) {
            await checkAndConfirmBatch(
                new mongoose.Types.ObjectId(String(item.jobId)),
                correction.batchNumber
            );
        }

        return res.json({ success: true });
    } catch (error) {
        rmAddressLogger.error(`resolveManualReview failed: ${error.message}`);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const applyManualEdit = async (req, res) => {
    try {
        const { manualAddress } = req.body || {};
        if (!manualAddress || !manualAddress.trim()) {
            return res.status(400).json({ success: false, message: 'manualAddress is required' });
        }

        const correction = await RMAddressAiCorrection.findById(req.params.id);
        if (!correction) return res.status(404).json({ success: false, message: 'Not found' });
        if (correction.status !== 'pending') {
            return res.status(400).json({ success: false, message: `Already ${correction.status}` });
        }

        const job = await RMAddressAiJob.findById(correction.jobId).lean();
        if (!job) return res.status(404).json({ success: false, message: 'Parent job not found' });

        const parts = manualAddress.trim().split(',').map((p) => p.trim()).filter(Boolean);

        // Apply the manual edit to the temp record — NOT directly to checked
        await AddressMasterAiTemp.updateOne(
            { originalId: correction.originalId },
            { $set: {
                address:      JSON.stringify(parts),
                recordStatus: 'resolved'
            }}
        );

        await RMAddressAiCorrection.findByIdAndUpdate(req.params.id, {
            status: 'manually_edited',
            manualAddress: manualAddress.trim()
        });

        rmAddressLogger.info(`Correction ${req.params.id} manually edited (source: ${job.sourceCollection})`);

        // Check if entire batch is now resolved — auto-confirms if so
        await checkAndConfirmBatch(
            new mongoose.Types.ObjectId(String(correction.jobId)),
            correction.batchNumber
        );

        return res.json({ success: true });
    } catch (error) {
        rmAddressLogger.error(`applyManualEdit failed: ${error.message}`);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const deleteOriginalAddress = async (req, res) => {
    try {
        const correction = await RMAddressAiCorrection.findById(req.params.id);
        if (!correction) return res.status(404).json({ success: false, message: 'Not found' });
        if (correction.status !== 'pending') {
            return res.status(400).json({ success: false, message: `Already ${correction.status}` });
        }

        const job = await RMAddressAiJob.findById(correction.jobId).lean();
        if (!job) return res.status(404).json({ success: false, message: 'Parent job not found' });

        await AddressMasterAiTemp.deleteOne({ originalId: correction.originalId });

        await RMAddressAiCorrection.findByIdAndUpdate(req.params.id, { status: 'deleted' });

        rmAddressLogger.info(`Address ${correction.originalId} deleted via correction ${req.params.id} (source: ${job.sourceCollection})`);

        await checkAndConfirmBatch(
            new mongoose.Types.ObjectId(String(correction.jobId)),
            correction.batchNumber
        );

        return res.json({ success: true });
    } catch (error) {
        rmAddressLogger.error(`deleteOriginalAddress failed: ${error.message}`);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// ── Stop Job ──────────────────────────────────────────────────────────────────

const stopJob = async (req, res) => {
    try {
        await RMAddressAiJob.findByIdAndUpdate(req.params.jobId, {
            stopRequested: true
        });
        rmAddressLogger.info(`Stop requested for AI job ${req.params.jobId}`);
        return res.json({ success: true, message: 'Stop requested — current batch will complete, no new batches will load' });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

// ── Upload to Pending ─────────────────────────────────────────────────────────

const uploadToPending = async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    res.status(202).json({ success: true, message: 'Import started', file: req.file.filename });
    processPendingFile(req.file.path).catch((err) => {
        rmAddressLogger.error(`Pending import failed: ${err.message}`);
    });
};

const processPendingFile = async (filePath) => {
    rmAddressLogger.info(`Pending import starting: ${filePath}`);

    const parser = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 }).pipe(parse({
        columns: false,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
        relax_quotes: true,
        bom: true
    }));

    let batch = [];
    let imported = 0;
    let skipped  = 0;
    const BATCH_SIZE  = 2000;
    const dateCreated = getDateCreated();

    const flush = async () => {
        if (!batch.length) return;
        const ops = batch.map((doc) => ({
            updateOne: {
                filter: { postcode: doc.postcode, address: doc.address },
                update: { $set: doc },
                upsert: true
            }
        }));
        await AddressMasterPending.bulkWrite(ops, { ordered: false });
        batch = [];
    };

    for await (const record of parser) {
        if (!Array.isArray(record) || record.length < 2) { skipped++; continue; }
        const postcode = normalizePostcode(record[0]);
        if (!postcode) { skipped++; continue; }
        const rawParts = record.slice(1).map((p) => (p || '').trim()).filter(Boolean);
        if (!rawParts.length) { skipped++; continue; }
        const district = await resolveDistrict(postcode);
        if (!district) { skipped++; continue; }

        batch.push({
            postcode,
            district,
            address: JSON.stringify(rawParts),
            dateCreated,
            correctionVersion: 'v1-pending'
        });

        imported++;
        if (batch.length >= BATCH_SIZE) await flush();
        if (imported % 25000 === 0) {
            rmAddressLogger.info(`Pending import: ${imported.toLocaleString()} imported, ${skipped} skipped`);
        }
    }

    await flush();

    rmAddressLogger.info(`Pending import complete: ${imported.toLocaleString()} imported, ${skipped} skipped`);
    await fs.promises.unlink(filePath).catch(() => undefined);
};

const getPendingStats = async (req, res) => {
    try {
        const count = await AddressMasterPending.estimatedDocumentCount();
        return res.json({ success: true, count });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

const fixBracketCapitalization = async (req, res) => {
    try {
        const { dryRun = true } = req.body || {};

        const candidates = await AddressMasterMerged.find({
            address: { $regex: '\\([a-z]' }
        })
            .select({ _id: 1, address: 1 })
            .lean();

        rmAddressLogger.info(`fixBracketCapitalization: found ${candidates.length} candidates, dryRun=${dryRun}`);

        if (dryRun) {
            const samples = candidates.slice(0, 20).map((c) => {
                const original = formatAddressForAi(c.address);
                const fixed    = original.replace(/\(([a-z])/g, (_, ch) => `(${ch.toUpperCase()}`);
                return { id: c._id, original, fixed };
            });
            return res.json({ success: true, dryRun: true, totalFound: candidates.length, samples });
        }

        const BATCH = 1000;
        let fixed = 0;

        for (let i = 0; i < candidates.length; i += BATCH) {
            const chunk = candidates.slice(i, i + BATCH);
            const ops   = [];

            for (const doc of chunk) {
                const addressText = formatAddressForAi(doc.address);
                const corrected   = addressText.replace(/\(([a-z])/g, (_, ch) => `(${ch.toUpperCase()}`);
                if (corrected === addressText) continue;
                const parts = corrected.split(',').map((p) => p.trim()).filter(Boolean);
                ops.push({
                    updateOne: {
                        filter: { _id: doc._id },
                        update: { $set: { address: JSON.stringify(parts), correctionVersion: 'v1-bracket-cap-fix' } }
                    }
                });
            }

            if (ops.length) {
                await AddressMasterMerged.bulkWrite(ops, { ordered: false });
                fixed += ops.length;
            }
        }

        rmAddressLogger.info(`fixBracketCapitalization complete: ${fixed} updated`);
        return res.json({ success: true, dryRun: false, totalFound: candidates.length, fixed });

    } catch (error) {
        rmAddressLogger.error(`fixBracketCapitalization failed: ${error.message}`);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const deleteJob = async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.jobId)) {
            return res.status(404).json({ success: false, message: 'Invalid job ID' });
        }

        const job = await RMAddressAiJob.findById(req.params.jobId);
        if (!job) return res.status(404).json({ success: false, message: 'Job not found' });

        if (job.status === 'running') {
            return res.status(400).json({
                success: false,
                message: 'Cannot delete a running job. Stop or pause it first.'
            });
        }

        await Promise.all([
            RMAddressAiJob.findByIdAndDelete(req.params.jobId),
            RMAddressAiCorrection.deleteMany({ jobId: req.params.jobId }),
            RMAddressManualReview.deleteMany({ jobId: req.params.jobId })
        ]);

        rmAddressLogger.info(`AI job ${req.params.jobId} deleted`);
        return res.json({ success: true, message: 'Job deleted' });
    } catch (error) {
        rmAddressLogger.error(`deleteJob failed: ${error.message}`);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const checkAndConfirmBatch = async (jobId, batchNumber) => {
    const pendingCount = await AddressMasterAiTemp.countDocuments({
        jobId,
        batchNumber,
        recordStatus: { $in: ['pending_correction', 'pending_manual_review'] }
    });

    if (pendingCount > 0) return; // still work to do

    const tempRecords = await AddressMasterAiTemp.find({ jobId, batchNumber }).lean();
    if (!tempRecords.length) return;

    const job = await RMAddressAiJob.findById(jobId).lean();
    const SourceModel = getSourceModel(job?.sourceCollection || 'address_master_ai_queue');

    const dateCreated = getDateCreated();
    const checkedOps  = tempRecords.map(r => ({
        updateOne: {
            filter: { postcode: r.postcode, address: r.address },
            update: { $set: {
                postcode:          r.postcode,
                district:          r.district,
                address:           r.address,
                dateCreated:       r.dateCreated || dateCreated,
                correctionVersion: r.correctionVersion || 'v1-ai-corrected',
                sourceType:        'ai_approved'
            }},
            upsert: true
        }
    }));

    await AddressMasterChecked.bulkWrite(checkedOps, { ordered: false });

    const originalIds = tempRecords.map(r => r.originalId);
    await SourceModel.deleteMany({ _id: { $in: originalIds } });

    await AddressMasterAiTemp.deleteMany({ jobId, batchNumber });

    rmAddressLogger.info(
        `Batch ${batchNumber} job ${jobId} auto-confirmed: ` +
        `${tempRecords.length} records → address_master_checked (source: ${job?.sourceCollection || 'unknown'})`
    );
};

module.exports = {
    RMAddressAiController: {
        createJob,
        listJobs,
        getJobStatus,
        pauseJob,
        resumeJob,
        resetJob,
        stopJob,
        deleteJob,
        applyManualEdit,
        deleteOriginalAddress,
        getNextBatch,
        submitBatchResults,
        getCorrections,
        approveCorrection,
        rejectCorrection,
        bulkApproveCorrections,
        bulkRejectCorrections,
        getManualReviewItems,
        resolveManualReview,
        uploadToPending,
        getPendingStats,
        fixBracketCapitalization
    }
};