const ScreenshotUrl = require("../models/ScreenshotUrl");
const axios = require('axios');
const ssUrlLogger = require("../config/loggers/ssUrlLogger");
const https = require('https');

let indexSyncPromise = null;

// Create an HTTPS agent for connection pooling
const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 200, // Increased for higher concurrency
    maxFreeSockets: 20,
    timeout: 60000 // 60 seconds socket timeout
});

// Helper function to check image with retries
const checkImageWithRetry = async (url, retries = 3) => {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await axios.head(url, {
                timeout: 15000,
                maxRedirects: 2,
                httpsAgent: httpsAgent,
                validateStatus: function (status) {
                    return status >= 200 && status < 500;
                }
            });
            return response;
        } catch (error) {
            const isLastAttempt = i === retries - 1;
            const shouldRetry = !error.response || (error.response.status >= 500 && error.response.status < 600);

            if (!shouldRetry || isLastAttempt) {
                throw error;
            }
            // Faster backoff for performance: 500ms, 1000ms, 2000ms
            await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, i)));
        }
    }
};

const escapeRegex = (value = '') => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ensureSSUrlIndexes = async () => {
    if (indexSyncPromise) {
        return indexSyncPromise;
    }

    indexSyncPromise = (async () => {
        const indexes = await ScreenshotUrl.collection.indexes();
        const imageUniqueIndex = indexes.find(index =>
            index.unique === true &&
            index.key &&
            index.key.image === 1 &&
            Object.keys(index.key).length === 1
        );

        if (imageUniqueIndex) {
            await ScreenshotUrl.collection.dropIndex(imageUniqueIndex.name);
        }

        await ScreenshotUrl.collection.createIndex(
            { url: 1, image: 1 },
            { unique: true, background: true, name: 'url_1_image_1' }
        );
    })();

    try {
        await indexSyncPromise;
    } finally {
        indexSyncPromise = null;
    }
};

const importSSUrl = async (req, res) => {
    try {
        const { chunk, bucketName } = req.body;

        if (!chunk || !Array.isArray(chunk) || !bucketName) {
            return res.status(400).json({
                status: 0,
                success: 0,
                errors: 0,
                totalcount: 0,
                notfound: 0,
                duplicates: 0,
                errormessages: 'Invalid request data',
                resultdebug: ''
            });
        }

        // Set a significantly longer timeout for this route
        req.setTimeout(300000); // 5 minutes timeout

        await ensureSSUrlIndexes();

        let totalCount = 0;
        let successCount = 0;
        let errorsCount = 0;
        let notFoundCount = 0;
        let duplicateCount = 0;
        let errorMessages = [];
        let resultDebug = [];

        const entriesToInsert = [];
        const processedUrlImageKeys = new Set();

        // Optimizing Batch Size for Speed
        const BATCH_SIZE = 50;
        for (let i = 0; i < chunk.length; i += BATCH_SIZE) {
            const batch = chunk.slice(i, i + BATCH_SIZE);

            // Process batch concurrently
            await Promise.all(batch.map(async (csvLine, index) => {
                totalCount++;

                if (!csvLine.url || !csvLine.image) {
                    const msg = `Line without URL or Image found.`;
                    errorMessages.push(msg);
                    ssUrlLogger.error(msg, { reason: 'Missing Data' });
                    errorsCount++;
                    return;
                }

                const url = csvLine.url.trim();
                const image = csvLine.image.trim();

                if (!url || !image) {
                    const msg = `URL or Image empty: URL: ${url} | Image: ${image}`;
                    errorMessages.push(msg);
                    ssUrlLogger.error(msg, { url, image, reason: 'Empty Data' });
                    errorsCount++;
                    return;
                }

                try {
                    const imageUrl = `https://h1m7.c11.e2-4.dev/${bucketName}/${image}`;
                    const imagePath = `${bucketName}/${image}`;
                    const compositeKey = `${url}__${imagePath}`;

                    if (processedUrlImageKeys.has(compositeKey)) {
                        duplicateCount++; // Tracking internal duplicates in chunk by url+image
                        return;
                    }
                    processedUrlImageKeys.add(compositeKey);

                    const response = await checkImageWithRetry(imageUrl);

                    if (response.status === 404) {
                        notFoundCount++;
                        resultDebug.push(`Image not found at URL: ${bucketName}/${image}`);
                        return;
                    }

                    const imgExists = response.status === 200 &&
                        response.headers['content-type'] === 'image/webp';

                    if (!imgExists) {
                        notFoundCount++;
                        const msg = `Image not a WebP image or error: ${bucketName}/${image} (Status: ${response.status})`;
                        resultDebug.push(msg);
                        ssUrlLogger.error(msg, { url: imageUrl, image, reason: `Invalid Content Type or Status ${response.status}` });
                        return;
                    }

                    entriesToInsert.push({
                        url,
                        image: imagePath
                    });

                } catch (error) {
                    let reason = error.message;
                    if (error.code === 'ECONNABORTED') {
                        reason = 'Timeout after retries';
                        errorMessages.push(`Timeout checking image ${image}`);
                    } else {
                        errorMessages.push(`Error checking image ${image}: ${error.message}`);
                    }
                    ssUrlLogger.error('Image check failed', { url, image, reason });
                    errorsCount++;
                }
            }));

            // Insert batch
            if (entriesToInsert.length > 0) {
                try {
                    const result = await ScreenshotUrl.insertMany(entriesToInsert, {
                        ordered: false,
                        writeConcern: { w: 1 }
                    });
                    successCount += result.length;

                    // Note: With w:0, result might not strictly return nInserted in all drivers, 
                    // but usually it does or simply implies success if no error thrown.
                    // If result.length is undefined (legacy), assume entriesToInsert.length.
                    if (result && typeof result.length === 'undefined') {
                        // fallback if insertMany returns varying result format
                        // In Mongoose insertMany returns the documents.
                    }

                } catch (error) {
                    // Normalize bulk write error shapes across Mongo/Mongoose versions.
                    const isBulkWriteError = error.name === 'BulkWriteError' || error.name === 'MongoBulkWriteError';
                    const writeErrors = Array.isArray(error.writeErrors)
                        ? error.writeErrors
                        : Array.isArray(error.result?.writeErrors)
                            ? error.result.writeErrors
                            : [];
                    let currentBatchSuccess = 0;
                    let batchDuplicates = 0;
                    let batchOtherErrors = 0;

                    // If it's a BulkWriteError, process all write errors
                    if (isBulkWriteError && writeErrors.length > 0) {
                        // Count successful inserts
                        if (error.result && error.result.nInserted) {
                            currentBatchSuccess = error.result.nInserted;
                        } else if (error.insertedDocs) {
                            currentBatchSuccess = error.insertedDocs.length;
                        }

                        // Count duplicates vs other errors
                        writeErrors.forEach((writeError, idx) => {
                            const writeErrorCode = writeError.code
                                || writeError.err?.code
                                || writeError.errorResponse?.code
                                || writeError?.errInfo?.code;
                            const writeErrorMessage = writeError.errmsg
                                || writeError.message
                                || writeError.err?.errmsg
                                || writeError.err?.message
                                || writeError.errorResponse?.errmsg
                                || writeError.errorResponse?.message
                                || 'Unknown write error';

                            if (writeErrorCode === 11000) {
                                batchDuplicates++;
                            } else {
                                batchOtherErrors++;
                                const msg = `DB Error: ${writeErrorMessage}`;
                                errorMessages.push(msg);
                                ssUrlLogger.error('Database Write Error', {
                                    reason: msg,
                                    writeErrorIndex: idx,
                                    writeErrorCode,
                                    writeError
                                });
                            }
                        });
                    } 
                    // If it's a single duplicate error (not BulkWriteError)
                    else if (error.code === 11000) {
                        // When single duplicate error is thrown for unordered inserts,
                        // treat remaining failed rows as duplicates for accurate stats.
                        batchDuplicates = Math.max(1, entriesToInsert.length - currentBatchSuccess);
                    } 
                    // Unknown error
                    else {
                        // Some driver versions surface duplicate details under keyPattern/keyValue.
                        if (error.keyPattern && (error.keyPattern.url === 1 || error.keyPattern.image === 1)) {
                            batchDuplicates = Math.max(1, entriesToInsert.length - currentBatchSuccess);
                        } else {
                            batchOtherErrors = entriesToInsert.length;
                        }
                        const msg = `Database error: ${error.message}`;
                        errorMessages.push(msg);
                        ssUrlLogger.error('Database Fatal Error', { 
                            reason: msg, 
                            errorName: error.name,
                            errorCode: error.code,
                            writeErrorCount: writeErrors.length,
                            keyPattern: error.keyPattern,
                            keyValue: error.keyValue
                        });
                    }

                    // Keep PM2 output clean: duplicate-only batches are expected with unordered inserts.
                    if (batchOtherErrors > 0) {
                        ssUrlLogger.warn('Batch insert completed with non-duplicate write errors', {
                            errorName: error.name,
                            errorCode: error.code,
                            isBulkWriteError,
                            writeErrorCount: writeErrors.length,
                            entriesToInsertCount: entriesToInsert.length,
                            currentBatchSuccess,
                            batchDuplicates,
                            batchOtherErrors,
                            totalSuccessCount: successCount + currentBatchSuccess,
                            totalDuplicateCount: duplicateCount + batchDuplicates
                        });
                    } else if (batchDuplicates > 0) {
                        ssUrlLogger.debug('Batch insert had duplicate rows only', {
                            currentBatchSuccess,
                            batchDuplicates,
                            totalSuccessCount: successCount + currentBatchSuccess,
                            totalDuplicateCount: duplicateCount + batchDuplicates
                        });
                    }

                    successCount += currentBatchSuccess;
                    duplicateCount += batchDuplicates;
                    errorsCount += batchOtherErrors;
                }
                entriesToInsert.length = 0;
            }

            // Reduced delay for higher throughput
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        // Calculate errors as records that weren't successful, notFound, or duplicates
        // Only do this for records counted in totalCount but not accounted for elsewhere
        const accounted = successCount + notFoundCount + duplicateCount + errorsCount;
        if (accounted < totalCount) {
            errorsCount += (totalCount - accounted);
        }

        return res.json({
            status: (successCount > 0 || duplicateCount > 0) ? 1 : 0,
            success: successCount,
            errors: errorsCount,
            totalcount: totalCount,
            notfound: notFoundCount,
            duplicates: duplicateCount,
            errormessages: errorMessages.join('<br>'),
            resultdebug: resultDebug.join('<br>')
        });

    } catch (error) {
        ssUrlLogger.error('Server specific error', { reason: error.message, stack: error.stack });
        console.error('Server error:', error);
        return res.status(500).json({
            status: 0,
            success: 0,
            errors: 1,
            totalcount: 1,
            notfound: 0,
            duplicates: 0,
            errormessages: `Server error: ${error.message}`,
            resultdebug: ''
        });
    }
}

const totalCount = async (req, res) => {
    const count = await ScreenshotUrl.countDocuments();
    res.json({
        collectionName: 'screenshotUrls',
        totalCount: count,
    });
}

const searchSSUrls = async (req, res) => {
    const { url = '', image = '', page = 1, limit = 500 } = req.body || {};

    try {
        const query = {};

        if (url && String(url).trim()) {
            query.url = { $regex: escapeRegex(String(url).trim()), $options: 'i' };
        }

        if (image && String(image).trim()) {
            query.image = { $regex: escapeRegex(String(image).trim()), $options: 'i' };
        }

        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const limitNum = Math.min(1000, Math.max(1, parseInt(limit, 10) || 500));
        const skip = (pageNum - 1) * limitNum;

        const countPromise = Object.keys(query).length === 0
            ? ScreenshotUrl.estimatedDocumentCount()
            : ScreenshotUrl.countDocuments(query);

        const [total, data] = await Promise.all([
            countPromise,
            ScreenshotUrl.find(query)
                .sort({ _id: 1 })
                .skip(skip)
                .limit(limitNum)
                .select({ _id: 1, url: 1, image: 1 })
                .lean()
        ]);

        return res.status(200).json({
            success: true,
            count: data.length,
            total,
            page: pageNum,
            totalPages: Math.max(1, Math.ceil(total / limitNum)),
            data
        });
    } catch (error) {
        ssUrlLogger.error('SS URL search failed', { reason: error.message, stack: error.stack });
        return res.status(500).json({
            success: false,
            message: 'Search failed',
            error: error.message
        });
    }
}


const dropAll = async (req, res) => {
    try {
        await ScreenshotUrl.deleteMany({});
        res.status(200).json({ message: 'All records deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting records', error: error.message });
    }
}


module.exports = {
    importSSUrl,
    dropAll,
    totalCount,
    searchSSUrls
}
