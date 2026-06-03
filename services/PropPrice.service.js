const { parse } = require('csv-parse');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const PropPrice = require('../models/PropPrice');
const propPriceLogger = require('../config/loggers/propPriceLogger');

const IMPORT_DIR = path.join(__dirname, '../imports/prop_price/');
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
    propPriceLogger.warn(`Skipped row in ${filename}: ${reason}${rowPreview ? ` | row=${rowPreview}` : ''}`);

    importProgressTracker.skippedSamples.unshift({
        filename,
        reason,
        rowPreview
    });

    if (importProgressTracker.skippedSamples.length > MAX_SKIPPED_SAMPLES) {
        importProgressTracker.skippedSamples.length = MAX_SKIPPED_SAMPLES;
    }
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

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const cleanText = (value) => {
    if (!value) return '';
    return value
        .toString()
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
        .trim();
};

const parseMoney = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const compact = value.toString().replace(/,/g, '').trim();
    const parsed = Number(compact);
    return Number.isFinite(parsed) ? parsed : null;
};

const parseDeedDate = (value) => {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const formatDateDDMMYYYY = (value) => {
    if (!value) return '-';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '-';

    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${day}/${month}/${year}`;
};

const formatMoney = (value) => {
    if (value === null || value === undefined || value === '') return '-';
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) return '-';
    return `£${numberValue.toLocaleString('en-GB')}`;
};

const buildAddressDisplay = ({ saon, paon, street, locality, town, district, county }) => {
    const parts = [saon, paon, street, locality, town, district, county]
        .map((value) => cleanText(value))
        .filter(Boolean);

    return Array.from(new Set(parts)).join(', ');
};

const flushBatch = async (docs, filename) => {
    if (!docs.length) return;

    const ops = docs.map((doc) => ({
        updateOne: {
            filter: { unique_id: doc.unique_id },
            update: { $set: doc },
            upsert: true
        }
    }));

    const result = await PropPrice.bulkWrite(ops, {
        ordered: false,
        writeConcern: { w: 1 }
    });

    importProgressTracker.upserted += result.upsertedCount || 0;
    importProgressTracker.modified += result.modifiedCount || 0;

    propPriceLogger.info(`Batch processed for ${filename}: rows=${docs.length}, upserted=${result.upsertedCount || 0}, modified=${result.modifiedCount || 0}`);
};

const moveCompletedFile = async (filePath) => {
    const filename = path.basename(filePath);
    const today = new Date().toISOString().split('T')[0];
    const completedDir = path.join(IMPORT_DIR, `completed_${today}`);

    await fs.promises.mkdir(completedDir, { recursive: true });
    await fs.promises.rename(filePath, path.join(completedDir, filename));
};

const getImportFiles = async () => {
    await ensureImportDirectory();

    const entries = await fs.promises.readdir(IMPORT_DIR, { withFileTypes: true });
    const csvFiles = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.csv'))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));

    if (csvFiles.length > MAX_FILES_PER_RUN) {
        propPriceLogger.warn(`Found ${csvFiles.length} files, limiting processing to first ${MAX_FILES_PER_RUN} files`);
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

const processFile = async (filePath) => {
    const filename = path.basename(filePath);
    importProgressTracker.currentFile = filename;

    propPriceLogger.info(`Starting Prop Price import file: ${filename}`);
    propPriceLogger.info('Processing steps: parse CSV row -> normalize postcode -> derive address display -> insert into prop_price');

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
            propPriceLogger.warn(`Import stop requested while processing ${filename}`);
            break;
        }

        importProgressTracker.total += 1;

        if (!Array.isArray(record) || record.length < 10) {
            importProgressTracker.skipped += 1;
            logSkippedRow(filename, 'invalid row shape or insufficient columns', record);
            continue;
        }

        const uniqueIdRaw = cleanText(record[0]);
        if (!uniqueIdRaw) {
            importProgressTracker.skipped += 1;
            logSkippedRow(filename, 'empty unique_id column', record);
            continue;
        }

        if (uniqueIdRaw.toLowerCase() === 'unique_id') {
            propPriceLogger.info(`Ignored header row in ${filename}`);
            continue;
        }

        const pricePaid = parseMoney(record[1]);
        const deedDate = parseDeedDate(record[2]);
        const postcode = normalizePostcode(record[3]);

        if (!pricePaid || !deedDate || !postcode) {
            importProgressTracker.skipped += 1;
            logSkippedRow(filename, `invalid price/date/postcode for unique_id ${uniqueIdRaw}`, record);
            continue;
        }

        const saon = cleanText(record[7]);
        const paon = cleanText(record[8]);
        const street = cleanText(record[9]);
        const locality = cleanText(record[10]);
        const town = cleanText(record[11]);
        const district = cleanText(record[12]);
        const county = cleanText(record[13]);
        const addressDisplay = buildAddressDisplay({ saon, paon, street, locality, town, district, county });

        if (!addressDisplay) {
            importProgressTracker.skipped += 1;
            logSkippedRow(filename, `address display became empty for unique_id ${uniqueIdRaw}`, record);
            continue;
        }

        batch.push({
            unique_id: uniqueIdRaw,
            price_paid: pricePaid,
            deed_date: deedDate,
            postcode,
            property_type: cleanText(record[4]),
            new_build: cleanText(record[5]),
            estate_type: cleanText(record[6]),
            saon,
            paon,
            street,
            locality,
            town,
            district,
            county,
            transaction_category: cleanText(record[14]),
            linked_data_uri: cleanText(record[15]),
            address_display: addressDisplay
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

    propPriceLogger.info(`Completed Prop Price import file: ${filename}`);
};

const getStats = async () => {
    const propPriceCount = await PropPrice.estimatedDocumentCount();
    return { propPriceCount };
};

const parseCursor = (cursor) => {
    if (!cursor) return null;

    try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
        if (!decoded) return null;

        return {
            postcode: cleanText(decoded.postcode || ''),
            addressDisplay: cleanText(decoded.addressDisplay || ''),
            deedDate: decoded.deedDate ? new Date(decoded.deedDate) : null,
            _id: decoded._id ? String(decoded._id) : ''
        };
    } catch (error) {
        propPriceLogger.warn(`Invalid cursor received: ${error.message}`);
        return null;
    }
};

const getPaginatedRecords = async ({ searchPostcode, limit, cursor = null }) => {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 200;
    const normalizedPostcode = normalizePostcode(searchPostcode);
    const cursorData = parseCursor(cursor);

    const query = {};
    const sort = normalizedPostcode
        ? { address_display: 1, deed_date: -1, _id: 1 }
        : { postcode: 1, address_display: 1, deed_date: -1, _id: 1 };

    if (normalizedPostcode) {
        query.postcode = normalizedPostcode;
    }

    if (cursorData && cursorData._id && cursorData.deedDate instanceof Date && !Number.isNaN(cursorData.deedDate.getTime())) {
        if (normalizedPostcode) {
            query.$or = [
                { address_display: { $gt: cursorData.addressDisplay } },
                {
                    address_display: cursorData.addressDisplay,
                    deed_date: { $lt: cursorData.deedDate }
                },
                {
                    address_display: cursorData.addressDisplay,
                    deed_date: cursorData.deedDate,
                    _id: { $gt: new mongoose.Types.ObjectId(cursorData._id) }
                }
            ];
        } else {
            query.$or = [
                { postcode: { $gt: cursorData.postcode } },
                {
                    postcode: cursorData.postcode,
                    address_display: { $gt: cursorData.addressDisplay }
                },
                {
                    postcode: cursorData.postcode,
                    address_display: cursorData.addressDisplay,
                    deed_date: { $lt: cursorData.deedDate }
                },
                {
                    postcode: cursorData.postcode,
                    address_display: cursorData.addressDisplay,
                    deed_date: cursorData.deedDate,
                    _id: { $gt: new mongoose.Types.ObjectId(cursorData._id) }
                }
            ];
        }
    }

    const rows = await PropPrice.find(query)
        .select({ unique_id: 1, price_paid: 1, deed_date: 1, postcode: 1, saon: 1, paon: 1, street: 1, address_display: 1 })
        .sort(sort)
        .limit(safeLimit + 1)
        .lean();

    const hasNextPage = rows.length > safeLimit;
    const slicedRows = hasNextPage ? rows.slice(0, safeLimit) : rows;
    const lastRow = slicedRows[slicedRows.length - 1] || null;

    const mappedRows = slicedRows.map((row) => ({
        ...row,
        deed_date_display: formatDateDDMMYYYY(row.deed_date),
        price_paid_display: formatMoney(row.price_paid)
    }));

    const nextCursor = lastRow
        ? Buffer.from(JSON.stringify({
            postcode: lastRow.postcode || '',
            addressDisplay: lastRow.address_display || '',
            deedDate: lastRow.deed_date,
            _id: String(lastRow._id)
        })).toString('base64')
        : null;

    return {
        rows: mappedRows,
        pagination: {
            mode: 'cursor',
            page: null,
            limit: safeLimit,
            total: null,
            totalPages: null,
            hasNextPage,
            nextCursor
        }
    };
};

module.exports = {
    PropPriceService: {
        processFile,
        getImportFiles,
        getImportFileDetails,
        getStats,
        getPaginatedRecords,
        getImportProgress: () => ({ ...importProgressTracker }),
        resetImportProgress,
        setImportRunning,
        setImportComplete,
        addImportError
    },
    IMPORT_DIR
};
