const mongoose = require('mongoose');
const RMAddressAiJob = require('../models/RMAddressAiJob');
const RMAddressAiCorrection = require('../models/RMAddressAiCorrection');
const RMAddressManualReview = require('../models/RMAddressManualReview');
const AddressMasterMerged = require('../models/AddressMasterMerged');
const rmAddressLogger = require('../config/loggers/rmAddressLogger');
const AddressMasterPending = require('../models/AddressMasterPending');
const { parse } = require('csv-parse');
const fs = require('fs');

const BATCH_TARGET = 300;


const createJob = async (req, res) => {
    try {
        const { jobName, sourceCollection } = req.body || {};

        const validCollections = ['address_master_merged', 'address_master_pending'];
        const resolvedSource = validCollections.includes(sourceCollection)
            ? sourceCollection
            : 'address_master_merged';

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

        const Model = job.sourceCollection === 'address_master_pending'
            ? require('../models/AddressMasterPending')
            : AddressMasterMerged;

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
            corrections = [],
            manualReview = [],
            cleanCount = 0
        } = req.body || {};

        if (!lastIdInBatch) {
            return res.status(400).json({ success: false, message: 'lastIdInBatch is required' });
        }

        // ── Determine which collection this job reads from ──
        const job = await RMAddressAiJob.findById(jobId).lean();
        if (!job) {
            return res.status(404).json({ success: false, message: 'Job not found' });
        }

        // Use the correct model based on sourceCollection
        const SourceModel = job.sourceCollection === 'address_master_pending'
            ? require('../models/AddressMasterPending')
            : AddressMasterMerged;

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            // Corrections — staged, no DB change yet (Option B)
            if (corrections.length > 0) {
                const correctionOps = corrections.map((c) => ({
                    updateOne: {
                        filter: {
                            jobId: jobId,
                            originalId: new mongoose.Types.ObjectId(c.originalId)
                        },
                        update: {
                            $setOnInsert: {
                                jobId,
                                originalId: new mongoose.Types.ObjectId(c.originalId),
                                postcode: c.postcode,
                                originalAddress: c.originalAddress,
                                correctedAddress: c.correctedAddress,
                                correctionType: c.correctionType,
                                confidence: c.confidence || 'high',
                                status: 'pending',
                                batchNumber
                            }
                        },
                        upsert: true
                    }
                }));
                await RMAddressAiCorrection.bulkWrite(correctionOps, { session });
            }

            // Manual review — backup from correct collection, then delete
            if (manualReview.length > 0) {
                const originalIds = manualReview.map((r) => new mongoose.Types.ObjectId(r.originalId));

                // ── KEY FIX: look up from the right collection ──
                const originalDocs = await SourceModel.find(
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
                        sourceCollection: job.sourceCollection,  // record where it came from
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

                // ── KEY FIX: delete from the right collection ──
                await SourceModel.deleteMany(
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

        rmAddressLogger.info(
            `Batch ${batchNumber} saved for job ${jobId} ` +
            `(source: ${job.sourceCollection}): ` +
            `${corrections.length} staged, ${manualReview.length} manual, ${cleanCount} clean`
        );

        return res.json({
            success: true,
            message: `Batch ${batchNumber} saved — ${corrections.length} staged, ${manualReview.length} manual review, ${cleanCount} clean`
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

        // ── Restore to the collection it came from ──
        const TargetModel = item.sourceCollection === 'address_master_pending'
            ? require('../models/AddressMasterPending')
            : AddressMasterMerged;

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
            await TargetModel.create({
                postcode: item.postcode,
                district: item.district,
                address: JSON.stringify(addressToApply.split(',').map(p => p.trim()).filter(Boolean)),
                dateCreated: item.dateCreated,
                correctionVersion: 'v1-ai-corrected'
            });
            await RMAddressManualReview.findByIdAndUpdate(req.params.id, { status: 'applied' });

        } else if (action === 'delete_permanently') {
            await RMAddressManualReview.findByIdAndUpdate(req.params.id, { status: 'deleted_permanently' });
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

        // Apply the human-edited version — not the AI suggestion
        await AddressMasterMerged.findByIdAndUpdate(
            correction.originalId,
            {
                $set: {
                    address: JSON.stringify(
                        manualAddress.trim().split(',').map((p) => p.trim()).filter(Boolean)
                    ),
                    correctionVersion: 'v1-manually-edited'
                }
            }
        );

        await RMAddressAiCorrection.findByIdAndUpdate(req.params.id, {
            status: 'manually_edited',
            manualAddress: manualAddress.trim()
        });

        rmAddressLogger.info(`Correction ${req.params.id} manually edited and applied`);
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

        await AddressMasterMerged.findByIdAndDelete(correction.originalId);

        await RMAddressAiCorrection.findByIdAndUpdate(req.params.id, { status: 'deleted' });

        rmAddressLogger.info(`Address ${correction.originalId} deleted via correction ${req.params.id}`);
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

    const districtCache = new Map();

    const resolveDistrict = async (postcode) => {
        if (districtCache.has(postcode)) return districtCache.get(postcode);
        const PostcodeDistrict = require('../models/PostcodeDistrict');
        const exact = await PostcodeDistrict.findOne({ postcode }).lean();
        if (exact?.district) {
            districtCache.set(postcode, exact.district.toUpperCase().trim());
            return districtCache.get(postcode);
        }
        const outward = postcode.split(' ')[0] || '';
        const prefix  = await PostcodeDistrict.findOne({
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
        if (noSpace.length > 3) return `${noSpace.slice(0, noSpace.length - 3)} ${noSpace.slice(noSpace.length - 3)}`;
        return compact;
    };

    const getDate = () => {
        const now = new Date();
        return `${String(now.getDate()).padStart(2,'0')}/${String(now.getMonth()+1).padStart(2,'0')}/${now.getFullYear()}`;
    };

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
    const dateCreated = getDate();

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
    districtCache.clear();

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