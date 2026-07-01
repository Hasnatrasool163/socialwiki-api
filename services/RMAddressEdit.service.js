const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');

const AddressMasterMerged = require('../models/AddressMasterMerged');
const PostcodeDistrict = require('../models/PostcodeDistrict');
const RMAddressEditJob = require('../models/RMAddressEditJob');
const RMAddressDeletedBackup = require('../models/RMAddressDeletedBackup');
const rmAddressLogger = require('../config/loggers/rmAddressLogger');

const EDIT_EXPORT_DIR = path.join(__dirname, '../exports/rm_address_edit/');
const EDIT_IMPORT_DIR = path.join(__dirname, '../imports/rm_address_edit/');

const PREVIEW_LIMIT = 500;
const EXPORT_BATCH_SIZE = 1000;
const REIMPORT_BATCH_SIZE = 2000;

const ensureDir = (dir) => fs.promises.mkdir(dir, { recursive: true });

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizePostcode = (value) => {
    if (!value) return '';
    const compact = value.toString().trim().toUpperCase().replace(/\s+/g, ' ').replace(/[^A-Z0-9 ]/g, '');
    if (!compact) return '';
    const noSpace = compact.replace(/\s+/g, '');
    if (noSpace.length > 3) {
        return `${noSpace.slice(0, noSpace.length - 3)} ${noSpace.slice(noSpace.length - 3)}`;
    }
    return compact;
};

const buildAdjacentPhraseRegex = (phrase) => {
    if (!phrase) return null;
    const words = phrase.toString().trim().toUpperCase().split(/\s+/).filter(Boolean).map(escapeRegex);
    if (!words.length) return null;
    if (words.length === 1) return new RegExp(`\\b${words[0]}\\b`, 'i');
    return new RegExp(`\\b${words.join('[,\\s]+')}\\b`, 'i');
};

const addressTextFromDoc = (doc) => {
    if (typeof doc.address === 'string' && doc.address.startsWith('[')) {
        try {
            const parsed = JSON.parse(doc.address);
            if (Array.isArray(parsed)) return parsed.join(', ');
        } catch (e) { /* fall through */ }
    }
    return doc.address || '';
};

const buildEditSearchQuery = ({ searchPostcode = '', searchDistrict = '', searchAddress = '', searchDate = '', postcodes = [] }) => {
    const query = {};

    if (Array.isArray(postcodes) && postcodes.length > 0) {
        query.postcode = { $in: postcodes };
    } else {
        const pc = (searchPostcode || '').trim();
        if (pc) {
            const normalized = normalizePostcode(pc);
            query.postcode = { $gte: normalized, $lt: `${normalized}\uffff` };
        }
    }

    const dist = (searchDistrict || '').trim();
    const addr = (searchAddress || '').trim();
    const date = (searchDate || '').trim();


    if (addr) {
        const regex = buildAdjacentPhraseRegex(addr);
        if (regex) query.address = { $regex: regex };
    }
    if (dist) {
        const normalizedDist = dist.toUpperCase();
        query.district = { $gte: normalizedDist, $lt: `${normalizedDist}\uffff` };
    }
    if (date) {
        query.dateCreated = date;
    }
    return query;
};

const validateEditFilters = ({ searchAddress, searchDate, postcodes }) => {
    const hasAddress = !!(searchAddress || '').trim();
    const hasDate = !!(searchDate || '').trim();
    const hasPostcodeList = Array.isArray(postcodes) && postcodes.length > 0;

    if (!hasAddress && !hasDate && !hasPostcodeList) {
        throw new Error('Provide an address, a date, or upload a list of postcodes.');
    }
};

// STEP 1 — preview only. Nothing is touched in the DB.
const previewEditSearch = async ({ searchPostcode, searchDistrict, searchAddress, searchDate, postcodes = [] }) => {
    validateEditFilters({ searchAddress, searchDate, postcodes });
    const query = buildEditSearchQuery({ searchPostcode, searchDistrict, searchAddress, searchDate, postcodes });

    const sortStage = (searchPostcode || '').trim() || postcodes.length > 0 ? { postcode: 1, _id: 1 } : { _id: 1 };

    const [rows, totalMatching] = await Promise.all([
        AddressMasterMerged.find(query)
            .select({ postcode: 1, district: 1, address: 1, dateCreated: 1 })
            .sort(sortStage)
            .limit(PREVIEW_LIMIT)
            .maxTimeMS(60000)
            .lean(),
        AddressMasterMerged.countDocuments(query).maxTimeMS(60000)
    ]);

    return {
        previewCount: rows.length,
        totalMatching,
        rows: rows.map((r) => ({
            _id: r._id,
            postcode: r.postcode,
            district: r.district,
            address: addressTextFromDoc(r),
            dateCreated: r.dateCreated
        }))
    };
};

// STEP 2 — user clicked Continue. Export ALL matches to CSV,
// backing up + deleting in batches.
const startEditExportJob = async ({ searchPostcode, searchDistrict, searchAddress, searchDate, postcodes = [] }) => {
    validateEditFilters({ searchAddress, searchDate, postcodes });
    const query = buildEditSearchQuery({ searchPostcode, searchDistrict, searchAddress, searchDate, postcodes });

    await ensureDir(EDIT_EXPORT_DIR);

    const job = await RMAddressEditJob.create({
        jobType: 'export',
        status: 'running',
        searchPostcode: searchPostcode || '',
        searchDistrict: searchDistrict || '',
        searchAddress: searchAddress || '',
        searchDate: searchDate || '',
        bulkPostcodeCount: postcodes.length  
    });

    runEditExportJob(job._id, query).catch(async (error) => {
        rmAddressLogger.error(`Edit export job ${job._id} failed: ${error.message}`);
        await RMAddressEditJob.findByIdAndUpdate(job._id, { status: 'failed', error: error.message });
    });

    return { jobId: job._id };
};

const csvCell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const runEditExportJob = async (jobId, query) => {
    const fileName = `rm_address_edit_${jobId}.csv`;
    const filePath = path.join(EDIT_EXPORT_DIR, fileName);
    const outStream = fs.createWriteStream(filePath, { flags: 'w' });
    outStream.write('postcode,address,district\n');

    let exportedCount = 0;
    let deletedCount = 0;
    let lastId = null;

    while (true) {
        const batchQuery = lastId ? { ...query, _id: { $gt: lastId } } : query;
        const batch = await AddressMasterMerged.find(batchQuery)
            .sort({ _id: 1 })
            .limit(EXPORT_BATCH_SIZE)
            .lean();

        if (!batch.length) break;

        // Backup FIRST. If the process dies after this line but before delete,
        // the records still exist in address_master_merged AND in the backup — nothing lost.
        const backupDocs = batch.map((doc) => ({
            exportJobId: jobId,
            originalId: doc._id,
            postcode: doc.postcode,
            district: doc.district,
            address: doc.address,
            dateCreated: doc.dateCreated,
            correctionVersion: doc.correctionVersion,
            exceptionVersion: doc.exceptionVersion,
            status: 'exported'
        }));
        await RMAddressDeletedBackup.insertMany(backupDocs, { ordered: false });

        for (const doc of batch) {
            outStream.write([csvCell(doc.postcode), csvCell(addressTextFromDoc(doc)), csvCell(doc.district)].join(',') + '\n');
            exportedCount += 1;
        }

        const idsToDelete = batch.map((d) => d._id);
        const deleteResult = await AddressMasterMerged.deleteMany({ _id: { $in: idsToDelete } });
        deletedCount += deleteResult.deletedCount || 0;

        lastId = batch[batch.length - 1]._id;
        await RMAddressEditJob.findByIdAndUpdate(jobId, { exportedCount, deletedCount });
    }

    await new Promise((resolve, reject) => {
        outStream.end(() => resolve());
        outStream.on('error', reject);
    });

    await RMAddressEditJob.findByIdAndUpdate(jobId, {
        status: 'completed',
        exportedCount,
        deletedCount,
        fileName,
        filePath,
        completedAt: new Date()
    });

    rmAddressLogger.info(`Edit export job ${jobId} completed: exported=${exportedCount}, deleted=${deletedCount}`);
};

const getEditJobStatus = (jobId) => RMAddressEditJob.findById(jobId).lean();

const downloadEditExportFile = async (jobId) => {
    const job = await RMAddressEditJob.findById(jobId).lean();
    if (!job || !job.filePath || !fs.existsSync(job.filePath)) return null;
    return job;
};

const resolveDistrictForPostcode = async (postcode) => {
    const exact = await PostcodeDistrict.findOne({ postcode }).lean();
    if (exact?.district) return exact.district.toUpperCase().trim();
    const outward = postcode.split(' ')[0] || '';
    if (!outward) return null;
    const prefix = await PostcodeDistrict.findOne({
        postcode: { $regex: `^${escapeRegex(outward)}\\s`, $options: 'i' }
    }).lean();
    return prefix?.district ? prefix.district.toUpperCase().trim() : null;
};

const getDateCreated = () => {
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}/${now.getFullYear()}`;
};

// STEP 3 — reimport the edited CSV. Expects columns: postcode, address, district.
// district is optional per-row — falls back to postcode_district lookup if blank.
const reimportEditedCsv = async ({ filePath, exportJobId }) => {
    await ensureDir(EDIT_IMPORT_DIR);

    const reimportJob = await RMAddressEditJob.create({
        jobType: 'reimport',
        status: 'running',
        linkedJobId: exportJobId || null
    });

    processReimport(filePath, reimportJob._id, exportJobId).catch(async (error) => {
        rmAddressLogger.error(`Reimport job ${reimportJob._id} failed: ${error.message}`);
        await RMAddressEditJob.findByIdAndUpdate(reimportJob._id, { status: 'failed', error: error.message });
    });

    return { jobId: reimportJob._id };
};

const processReimport = async (filePath, reimportJobId, exportJobId) => {
    const parser = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 }).pipe(parse({
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
        relax_quotes: true
    }));

    let reimportedCount = 0;
    let skippedCount = 0;
    let batch = [];
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
        await AddressMasterMerged.bulkWrite(ops, { ordered: false });
        batch = [];
    };

    for await (const record of parser) {
        const rawPostcode = (record.postcode || record.Postcode || '').trim();
        const rawAddress = (record.address || record.Address || '').trim();
        const rawDistrict = (record.district || record.District || '').trim();

        const postcode = normalizePostcode(rawPostcode);
        if (!postcode || !rawAddress) {
            skippedCount += 1;
            continue;
        }

        const district = rawDistrict ? rawDistrict.toUpperCase() : await resolveDistrictForPostcode(postcode);
        if (!district) {
            skippedCount += 1;
            continue;
        }

        const addressParts = rawAddress.split(',').map((p) => p.trim()).filter(Boolean);

        batch.push({
            postcode,
            district,
            address: JSON.stringify(addressParts),
            dateCreated,                 // import date used, as agreed — original date isn't kept
            correctionVersion: 'v1-reimport'
        });

        reimportedCount += 1;
        if (batch.length >= REIMPORT_BATCH_SIZE) await flush();
    }
    await flush();

    // Mark the backup snapshots as reimported (audit trail link). Never deletes the backup itself.
    if (exportJobId) {
        await RMAddressDeletedBackup.updateMany(
            { exportJobId },
            { $set: { status: 'reimported', reimportJobId } }
        );
    }

    await RMAddressEditJob.findByIdAndUpdate(reimportJobId, {
        status: 'completed',
        reimportedCount,
        reimportSkippedCount: skippedCount,
        completedAt: new Date()
    });

    rmAddressLogger.info(`Reimport job ${reimportJobId} completed: reimported=${reimportedCount}, skipped=${skippedCount}`);

    await fs.promises.unlink(filePath).catch(() => undefined);
};

const parsePostcodeListContent = (content) => {
    const lines = content.split(/[\r\n,;]+/);
    const valid = [];
    const skipped = [];

    for (const line of lines) {
        const raw = line.trim();
        if (!raw) continue;
        const normalized = normalizePostcode(raw);
        if (normalized) {
            valid.push(normalized);
        } else {
            skipped.push(raw.slice(0, 20)); 
        }
    }

    const unique = [...new Set(valid)];
    return {
        postcodes: unique,
        validCount: unique.length,
        duplicatesRemoved: valid.length - unique.length,
        invalidCount: skipped.length
    };
};

module.exports = {
    RMAddressEditService: {
        previewEditSearch,
        startEditExportJob,
        getEditJobStatus,
        downloadEditExportFile,
        reimportEditedCsv,
        parsePostcodeListContent
    },
    EDIT_EXPORT_DIR,
    EDIT_IMPORT_DIR
};