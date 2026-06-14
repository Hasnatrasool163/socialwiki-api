const { parse } = require('csv-parse');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const AddressMasterMerged = require('../models/AddressMasterMerged');
const PostcodeDistrict = require('../models/PostcodeDistrict');
const rmAddressLogger = require('../config/loggers/rmAddressLogger');

const IMPORT_DIR = path.join(__dirname, '../imports/address_master/');
const EXPORT_DIR = path.join(__dirname, '../exports/rm_address/');
const BATCH_SIZE = 5000;
const MAX_FILES_PER_RUN = 1000;
const MAX_SKIPPED_SAMPLES = 20;

const importProgressTracker = {
    currentFile: null,
    processed: 0,
    total: 0,
    upserted: 0,
    modified: 0,
    skipped: 0,
    skippedSamples: [],
    errors: [],
    isComplete: false,
    isRunning: false
};

const exportJobs = {};

const ensureExportDirectory = async () => {
    await fs.promises.mkdir(EXPORT_DIR, { recursive: true });
};

const csvEscape = (value) => {
    if (value === null || value === undefined) return '';
    const s = String(value);
    if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
};

const buildAdjacentRegex = (phrase) => {
    if (!phrase) return null;
    const parts = phrase
        .toString()
        .trim()
        .toUpperCase()
        .split(/\s+/)
        .filter(Boolean)
        .map((p) => escapeRegex(p));

    if (!parts.length) return null;
    if (parts.length === 1) {
        return new RegExp(`\\b${parts[0]}\\b`, 'i');
    }

    return new RegExp(`\\b${parts.join('[,\\s]+')}\\b`, 'i');
};

const searchForExport = async ({ searchPostcode = '', searchDistrict = '', searchAddress = '', limit = 500 }) => {
    const query = {};
    const trimmedPostcode = (searchPostcode || '').trim();
    const trimmedDistrict = (searchDistrict || '').trim();
    const trimmedAddress = (searchAddress || '').trim();

    if (trimmedPostcode) {
        const postcodeQuery = buildPostcodePrefixQuery(trimmedPostcode);
        if (postcodeQuery) query.postcode = postcodeQuery;
    }

    if (trimmedDistrict) {
        const normalizedDistrict = trimmedDistrict.toUpperCase();
        query.district = { $gte: normalizedDistrict, $lt: `${normalizedDistrict}\uffff` };
    }

    if (trimmedAddress) {
        const phraseRegex = buildAdjacentRegex(trimmedAddress);
        if (phraseRegex) query.address = { $regex: phraseRegex };
    }

    const rows = await AddressMasterMerged.find(query)
        .select({ postcode: 1, district: 1, address: 1, dateCreated: 1, correctionVersion: 1, exceptionVersion: 1 })
        .sort({ _id: 1 })
        .limit(limit)
        .lean();

    return rows;
};

const exportToCsvAndDelete = async ({ query, jobId }) => {
    await ensureExportDirectory();
    const filename = `rm_address_export_${jobId}.csv`;
    const filePath = path.join(EXPORT_DIR, filename);
    const outStream = fs.createWriteStream(filePath, { flags: 'w' });

    exportJobs[jobId] = { status: 'running', filePath: null, processed: 0, deleted: 0, error: null };

    try {
        // write header
        outStream.write(['id', 'postcode', 'district', 'address', 'dateCreated', 'correctionVersion', 'exceptionVersion'].map(csvEscape).join(',') + '\n');

        const cursor = AddressMasterMerged.find(query).lean().cursor();
        const deleteIdsBatch = [];
        let processed = 0;

        for await (const doc of cursor) {
            processed += 1;
            const addressText = (typeof doc.address === 'string' && doc.address.startsWith('['))
                ? (() => { try { const p = JSON.parse(doc.address); return Array.isArray(p) ? p.join(', ') : doc.address; } catch (e) { return doc.address; } })()
                : doc.address;

            const row = [String(doc._id || ''), doc.postcode || '', doc.district || '', addressText || '', doc.dateCreated || '', doc.correctionVersion || '', doc.exceptionVersion || ''];
            outStream.write(row.map(csvEscape).join(',') + '\n');

            deleteIdsBatch.push(doc._id);

            if (deleteIdsBatch.length >= BATCH_SIZE) {
                await AddressMasterMerged.deleteMany({ _id: { $in: deleteIdsBatch } });
                exportJobs[jobId].deleted += deleteIdsBatch.length;
                deleteIdsBatch.length = 0;
            }

            exportJobs[jobId].processed = processed;
        }

        if (deleteIdsBatch.length) {
            await AddressMasterMerged.deleteMany({ _id: { $in: deleteIdsBatch } });
            exportJobs[jobId].deleted += deleteIdsBatch.length;
        }

        outStream.end();
        exportJobs[jobId].status = 'done';
        exportJobs[jobId].filePath = filePath;
        return { filePath, processed: exportJobs[jobId].processed, deleted: exportJobs[jobId].deleted };
    } catch (error) {
        exportJobs[jobId].status = 'failed';
        exportJobs[jobId].error = error.message;
        try { outStream.destroy(); } catch (e) {}
        throw error;
    }
};

const exportJobStarter = async ({ searchPostcode = '', searchDistrict = '', searchAddress = '', jobId }) => {
    const query = {};
    const trimmedPostcode = (searchPostcode || '').trim();
    const trimmedDistrict = (searchDistrict || '').trim();
    const trimmedAddress = (searchAddress || '').trim();

    if (trimmedPostcode) {
        const postcodeQuery = buildPostcodePrefixQuery(trimmedPostcode);
        if (postcodeQuery) query.postcode = postcodeQuery;
    }

    if (trimmedDistrict) {
        const normalizedDistrict = trimmedDistrict.toUpperCase();
        query.district = { $gte: normalizedDistrict, $lt: `${normalizedDistrict}\uffff` };
    }

    if (trimmedAddress) {
        const phraseRegex = buildAdjacentRegex(trimmedAddress);
        if (phraseRegex) query.address = { $regex: phraseRegex };
    }

    return exportToCsvAndDelete({ query, jobId });
};

const getExportStatus = (jobId) => {
    return exportJobs[jobId] || null;
};

const importFromCsv = async ({ filePath }) => {
    const filename = path.basename(filePath);
    rmAddressLogger.info(`Starting import from CSV: ${filename}`);

    const parser = parse({ columns: true, skip_empty_lines: true, trim: true, relax_column_count: true, relax_quotes: true });
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 }).pipe(parser);

    let batch = [];
    let processed = 0;
    let skipped = 0;

    for await (const record of stream) {
        const postcodeRaw = record.postcode || record.Postcode || '';
        const postcode = normalizePostcode(postcodeRaw);
        if (!postcode) {
            skipped += 1;
            continue;
        }

        const district = record.district || record.District || await resolveDistrict(postcode);
        if (!district) {
            skipped += 1;
            continue;
        }

        const addressRaw = record.address || record.Address || record.address_json || '';
        let addressParts = [];
        if (record.address_json) {
            try { const parsed = JSON.parse(record.address_json); if (Array.isArray(parsed)) addressParts = parsed; }
            catch (e) { addressParts = [String(record.address_json)]; }
        }

        if (!addressParts.length && addressRaw) {
            // split by comma to try to get parts
            addressParts = String(addressRaw).split(',').map((s) => s.trim()).filter(Boolean);
        }

        const addressCanonical = JSON.stringify(standardizeAddressParts(addressParts, postcode, district));
        const dateCreated = record.dateCreated || getDateCreated();

        batch.push({ postcode, district, address: addressCanonical, dateCreated, correctionVersion: record.correctionVersion || 'v1', exceptionVersion: record.exceptionVersion });
        processed += 1;

        if (batch.length >= BATCH_SIZE) {
            await flushBatch(batch, filename);
            batch = [];
        }
    }

    if (batch.length) await flushBatch(batch, filename);

    return { processed, skipped };
};

const updateRecord = async (id, data) => {
    const update = { ...data };
    if (update.postcode) update.postcode = normalizePostcode(update.postcode);
    if (update.address && Array.isArray(update.address)) update.address = JSON.stringify(update.address);
    if (update.address && typeof update.address === 'string' && update.address.startsWith('[')) {
        // assume canonical
    }

    const result = await AddressMasterMerged.updateOne({ _id: id }, { $set: update });
    return result;
};

const bulkApplyEdits = async (edits) => {
    if (!Array.isArray(edits) || !edits.length) return { processed: 0 };
    const ops = [];
    for (const e of edits) {
        const filter = e._id ? { _id: e._id } : (e.postcode && e.address ? { postcode: normalizePostcode(e.postcode), address: e.address } : null);
        if (!filter) continue;
        const update = { $set: {} };
        if (e.postcode) update.$set.postcode = normalizePostcode(e.postcode);
        if (e.district) update.$set.district = e.district;
        if (e.address) update.$set.address = typeof e.address === 'string' ? e.address : JSON.stringify(e.address);
        if (Object.keys(update.$set).length === 0) continue;
        ops.push({ updateOne: { filter, update, upsert: false } });
    }

    if (!ops.length) return { processed: 0 };

    const result = await AddressMasterMerged.bulkWrite(ops, { ordered: false });
    return { processed: result.nModified || result.modifiedCount || 0 };
};

const ensureImportDirectory = async () => {
    await fs.promises.mkdir(IMPORT_DIR, { recursive: true });
};

const resetImportProgress = () => {
    importProgressTracker.currentFile = null;
    importProgressTracker.processed = 0;
    importProgressTracker.total = 0;
    importProgressTracker.upserted = 0;
    importProgressTracker.modified = 0;
    importProgressTracker.skipped = 0;
    importProgressTracker.skippedSamples = [];
    importProgressTracker.errors = [];
    importProgressTracker.isComplete = false;
    importProgressTracker.isRunning = false;
};

const setImportRunning = (running) => {
    importProgressTracker.isRunning = running;
};

const setImportComplete = (complete) => {
    importProgressTracker.isComplete = complete;
    if (complete) {
        importProgressTracker.currentFile = null;
    }
};

const addImportError = (error) => {
    importProgressTracker.errors.push(error);
};

const previewRecord = (record) => {
    if (!Array.isArray(record)) {
        return '';
    }

    return record
        .map((field) => (field || '').toString().replace(/[\r\n]+/g, ' ').trim())
        .filter(Boolean)
        .join(' | ')
        .slice(0, 500);
};

const logSkippedRow = (filename, reason, record) => {
    const rowPreview = previewRecord(record);
    rmAddressLogger.warn(`Skipped row in ${filename}: ${reason}${rowPreview ? ` | row=${rowPreview}` : ''}`);

    importProgressTracker.skippedSamples.unshift({
        filename,
        reason,
        rowPreview
    });

    if (importProgressTracker.skippedSamples.length > MAX_SKIPPED_SAMPLES) {
        importProgressTracker.skippedSamples.length = MAX_SKIPPED_SAMPLES;
    }
};

const getDateCreated = () => {
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = now.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
};

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

const normalizeSearchPostcode = (value) => {
    if (!value) return '';

    let clean = value
        .toString()
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9 ]/g, '')
        .replace(/\s+/g, ' ');

    if (!clean) return '';

    const continuousText = clean.replace(/\s/g, '');

    const fullPostcodeNoSpaceRegex =
        /^([A-Z]{1,2}[0-9][A-Z0-9]?)([0-9][A-Z]{2})$/;

    if (fullPostcodeNoSpaceRegex.test(continuousText)) {
        return continuousText.replace(
            fullPostcodeNoSpaceRegex,
            '$1 $2'
        );
    }

    return clean;
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const outwardCode = (postcode) => {
    if (!postcode) return '';
    return postcode.split(' ')[0] || '';
};

const cleanPart = (value) => {
    if (!value) return '';
    return value
        .toString()
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
        .trim();
};

const getAddressParts = (record) => {
    if (!Array.isArray(record) || record.length < 2) return [];

    const rawParts = record.length > 2 ? record.slice(1) : [record[1]];

    if (rawParts.length === 1 && typeof rawParts[0] === 'string' && rawParts[0].includes(',')) {
        return rawParts[0].split(',').map((entry) => entry.trim());
    }

    return rawParts.map((entry) => cleanPart(entry));
};

const standardizeAddressParts = (parts, postcode, district) => {
    const normalizedDistrict = (district || '').trim().toUpperCase();
    const postcodeEscaped = escapeRegex(postcode);
    const outward = outwardCode(postcode);

    const cleaned = parts
        .map((part) => cleanPart(part))
        .map((part) => part.replace(new RegExp(`\\b${postcodeEscaped}\\b`, 'gi'), '').trim())
        .filter(Boolean)
        .filter((part) => part.toUpperCase() !== normalizedDistrict)
        .filter((part) => part.toUpperCase() !== outward.toUpperCase())
        .filter((part) => part !== '-');

    const deduped = [];
    for (const part of cleaned) {
        if (deduped.length === 0 || deduped[deduped.length - 1] !== part) {
            deduped.push(part);
        }
    }

    return deduped;
};

const resolveDistrict = async (postcode) => {
    const exactMatch = await PostcodeDistrict.findOne({ postcode }).lean();
    if (exactMatch?.district) return exactMatch.district.toUpperCase().trim();

    const outward = outwardCode(postcode);
    if (!outward) return null;

    const prefixMatch = await PostcodeDistrict.findOne({
        postcode: { $regex: `^${escapeRegex(outward)}\\s`, $options: 'i' }
    }).lean();

    return prefixMatch?.district ? prefixMatch.district.toUpperCase().trim() : null;
};

const flushBatch = async (docs, filename) => {
    if (!docs.length) return;

    const canonicalOps = docs.map((doc) => ({
        updateOne: {
            filter: { postcode: doc.postcode, address: doc.address },
            update: { $set: doc },
            upsert: true
        }
    }));

    const canonicalResult = await AddressMasterMerged.bulkWrite(canonicalOps, {
        ordered: false,
        writeConcern: { w: 1 }
    });

    const upsertedCount = canonicalResult.upsertedCount || 0;
    const modifiedCount = canonicalResult.modifiedCount || 0;

    importProgressTracker.upserted += upsertedCount;
    importProgressTracker.modified += modifiedCount;

    rmAddressLogger.info(`Batch processed for ${filename}: rows=${docs.length}, upserted=${upsertedCount}, modified=${modifiedCount}`);
};

const moveCompletedFile = async (filePath) => {
    const filename = path.basename(filePath);
    const today = new Date().toISOString().split('T')[0];
    const completedDir = path.join(IMPORT_DIR, `completed_${today}`);

    await fs.promises.mkdir(completedDir, { recursive: true });
    await fs.promises.rename(filePath, path.join(completedDir, filename));
};

const processFile = async (filePath) => {
    const filename = path.basename(filePath);
    importProgressTracker.currentFile = filename;

    rmAddressLogger.info(`Starting RM Address import file: ${filename}`);
    rmAddressLogger.info(`Processing steps: parse CSV row -> normalize postcode -> resolve district from postcode_district -> standardize address parts -> insert into address_master_merged`);

    const parser = parse({
        columns: false,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
        relax_quotes: true
    });

    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 }).pipe(parser);

    let batch = [];

    for await (const record of stream) {
        if (!importProgressTracker.isRunning) {
            rmAddressLogger.warn(`Import stop requested while processing ${filename}`);
            break;
        }

        importProgressTracker.total += 1;

        if (!Array.isArray(record) || record.length < 2) {
            importProgressTracker.skipped += 1;
            logSkippedRow(filename, 'invalid row shape or insufficient columns', record);
            continue;
        }

        const firstCol = (record[0] || '').toString().trim();
        if (!firstCol) {
            importProgressTracker.skipped += 1;
            logSkippedRow(filename, 'empty postcode column', record);
            continue;
        }

        if (firstCol.toLowerCase() === 'postcode') {
            rmAddressLogger.info(`Ignored header row in ${filename}`);
            continue;
        }

        const postcode = normalizePostcode(firstCol);
        if (!postcode) {
            importProgressTracker.skipped += 1;
            logSkippedRow(filename, 'postcode could not be normalized', record);
            continue;
        }

        const district = await resolveDistrict(postcode);
        if (!district) {
            importProgressTracker.skipped += 1;
            logSkippedRow(filename, `district not found for postcode ${postcode}`, record);
            importProgressTracker.errors.push({
                filename,
                error: `District not found for postcode ${postcode}`
            });
            continue;
        }

        const rawParts = getAddressParts(record);
        const addressParts = standardizeAddressParts(rawParts, postcode, district);
        if (!addressParts.length) {
            importProgressTracker.skipped += 1;
            logSkippedRow(filename, `address parts became empty after standardization for postcode ${postcode}`, record);
            continue;
        }

        const canonicalAddress = JSON.stringify(addressParts);
        const dateCreated = getDateCreated();

        batch.push({
            postcode,
            district,
            address: canonicalAddress,
            dateCreated,
            correctionVersion: 'v1',
            exceptionVersion: undefined
        });

        importProgressTracker.processed += 1;

        if (batch.length >= BATCH_SIZE) {
            await flushBatch(batch, filename);
            batch = [];
        }
    }

    if (batch.length > 0) {
        await flushBatch(batch, filename);
    }

    if (importProgressTracker.isRunning) {
        await moveCompletedFile(filePath);
    }

    rmAddressLogger.info(`Completed RM Address import file: ${filename}`);
};

const getImportFiles = async () => {
    await ensureImportDirectory();

    const entries = await fs.promises.readdir(IMPORT_DIR, { withFileTypes: true });
    const csvFiles = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.csv'))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));

    if (csvFiles.length > MAX_FILES_PER_RUN) {
        rmAddressLogger.warn(`Found ${csvFiles.length} files, limiting processing to first ${MAX_FILES_PER_RUN} files`);
    }

    return csvFiles.slice(0, MAX_FILES_PER_RUN);
};

const getImportFileDetails = async () => {
    await ensureImportDirectory();

    const entries = await fs.promises.readdir(IMPORT_DIR, { withFileTypes: true });
    const csvEntries = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.csv'))
        .slice(0, MAX_FILES_PER_RUN);

    const detailedFiles = await Promise.all(
        csvEntries.map(async (entry) => {
            const fullPath = path.join(IMPORT_DIR, entry.name);
            const stats = await fs.promises.stat(fullPath);

            return {
                filename: entry.name,
                sizeBytes: stats.size,
                lastModified: stats.mtime.toISOString(),
                status: 'pending'
            };
        })
    );

    detailedFiles.sort((a, b) => a.filename.localeCompare(b.filename));

    return {
        files: detailedFiles,
        pendingCount: detailedFiles.length,
        importEnabled: detailedFiles.length > 0
    };
};

const getStats = async () => {
    const addressMasterMergedCount = await AddressMasterMerged.estimatedDocumentCount();

    return {
        addressMasterMergedCount
    };
};

const buildPostcodePrefixQuery = (value) => {
    const normalized = normalizeSearchPostcode(value);
    if (!normalized) return null;
    return {
        $gte: normalized,
        $lt: `${normalized}\uffff`
    };
};

const encodeCursorToken = (payload) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');

const decodeCursorToken = (cursor) => {
    if (!cursor) return null;
    try {
        const decoded = JSON.parse(Buffer.from(String(cursor), 'base64').toString('utf8'));
        if (!decoded || typeof decoded !== 'object') return null;
        return decoded;
    } catch (error) {
        return null;
    }
};

const getPaginatedAddresses = async ({ page, limit, searchPostcode, searchDistrict, searchAddress, useCursor = true, cursor = null }) => {
    const safePage = Number.isFinite(page) && page > 0 ? page : 1;
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 200;
    const skip = (safePage - 1) * safeLimit;

    const query = {};

    const trimmedPostcode = (searchPostcode || '').trim();
    const trimmedDistrict = (searchDistrict || '').trim();
    const trimmedAddress = (searchAddress || '').trim();

    if (trimmedPostcode) {
        const postcodeQuery = buildPostcodePrefixQuery(trimmedPostcode);
        if (postcodeQuery) {
            query.postcode = postcodeQuery;
        }
    }

    if (trimmedDistrict) {
        const normalizedDistrict = trimmedDistrict.toUpperCase();
        query.district = {
            $gte: normalizedDistrict,
            $lt: `${normalizedDistrict}\uffff`
        };
    }

    if (trimmedAddress) {
        query.address = { $regex: escapeRegex(trimmedAddress), $options: 'i' };
    }

    let rows = [];
    let pagination;

    if (useCursor) {
        const cursorQuery = { ...query };

        if (trimmedPostcode) {
            const cursorData = decodeCursorToken(cursor);

            if (cursorData?.postcode && cursorData?._id) {
              cursorQuery.$or = [
                    { postcode: { $gt: cursorData.postcode } },
                    {
                        postcode: cursorData.postcode,
                        _id: { $gt: new mongoose.Types.ObjectId(cursorData._id) }
                    }
                ];
            }
        } else if (cursor && mongoose.isValidObjectId(cursor)) {
            cursorQuery._id = { $gt: cursor };
        }

        const cursorRows = await AddressMasterMerged.find(cursorQuery)
            .select({ postcode: 1, district: 1, address: 1, dateCreated: 1, correctionVersion: 1, exceptionVersion: 1 })
            .sort(trimmedPostcode ? { postcode: 1, _id: 1 } : { _id: 1 })
            .limit(safeLimit + 1)
            .lean();

        const hasNextPage = cursorRows.length > safeLimit;
        rows = hasNextPage ? cursorRows.slice(0, safeLimit) : cursorRows;
        
        const lastRow = rows[rows.length - 1] || null;
        const nextCursor = hasNextPage && lastRow
            ? (trimmedPostcode
                ? encodeCursorToken({ postcode: lastRow.postcode, _id: String(lastRow._id || '') })
                : String(lastRow._id || ''))
            : null

        pagination = {
            mode: 'cursor',
            limit: safeLimit,
            hasNextPage,
            nextCursor,
            total: null,
            totalPages: null,
            page: null
        };
    } else {
        const [offsetRows, total] = await Promise.all([
            AddressMasterMerged.find(query)
                .select({ postcode: 1, district: 1, address: 1, dateCreated: 1, correctionVersion: 1, exceptionVersion: 1 })
                .sort(trimmedPostcode ? { postcode: 1, _id: 1 } : { _id: 1 })
                .skip(skip)
                .limit(safeLimit)
                .lean(),
            Object.keys(query).length > 0
                ? AddressMasterMerged.countDocuments(query)
                : AddressMasterMerged.estimatedDocumentCount()
        ]);

        rows = offsetRows;
        pagination = {
            mode: 'offset',
            page: safePage,
            limit: safeLimit,
            total,
            totalPages: Math.ceil(total / safeLimit),
            hasNextPage: safePage * safeLimit < total,
            nextCursor: rows.length
                ? (trimmedPostcode
                    ? encodeCursorToken({ postcode: rows[rows.length - 1]?.postcode, _id: String(rows[rows.length - 1]?._id || '') })
                    : String(rows[rows.length - 1]?._id || ''))
                : null
        };
    }

    const mappedRows = rows.map((row) => {
        let addressText = row.address;
        if (typeof row.address === 'string' && row.address.startsWith('[')) {
            try {
                const parsed = JSON.parse(row.address);
                if (Array.isArray(parsed)) {
                    addressText = parsed.join(', ');
                }
            } catch (error) {
                addressText = row.address;
            }
        }

        return {
            ...row,
            address: addressText
        };
    });

    return {
        rows: mappedRows,
        pagination
    };
};

module.exports = {
    RMAddressService: {
        processFile,
        getImportFiles,
        getImportFileDetails,
        getStats,
        getPaginatedAddresses,
        getImportProgress: () => ({ ...importProgressTracker }),
        resetImportProgress,
        setImportRunning,
        setImportComplete,
        addImportError,
        searchForExport,
        exportToCsvAndDelete,
        exportJobStarter,
        getExportStatus,
        importFromCsv,
        updateRecord,
        bulkApplyEdits
    },
    IMPORT_DIR,
    EXPORT_DIR
};
