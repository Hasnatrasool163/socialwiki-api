/**
 * scripts/export_missing_screenshot_urls.js
 *
 * Compares UK Master URLs CSV (/home/dev/uk_urls.csv) against MongoDB screenshot_url collection.
 * Identifies all UK domains/URLs that DO NOT have an existing screenshot, and exports them.
 *
 * Features:
 * - High-speed batched queries using MongoDB index { url: 1, image: 1 }
 * - Multi-variation matching (bare domain, http://, https://, www., with/without trailing slash)
 * - Memory-safe streaming cursor via readline
 * - Real-time progress updates with ETA, throughput, and missing/found counts
 * - Exports both plain text (missing_uk_screenshot_urls.txt) and gzip (missing_uk_screenshot_urls.txt.gz)
 *
 * Usage:
 *   node scripts/export_missing_screenshot_urls.js
 *   node scripts/export_missing_screenshot_urls.js --input=/path/to/uk_urls.csv --batch=2000
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/web_postalwiki';
const DB_NAME = process.env.DB_NAME || 'web_postalwiki';
const COLLECTION_NAME = 'screenshot_url';

const args = process.argv.slice(2);
const getArg = (prefix, fallback) => {
    const found = args.find(a => a.startsWith(prefix));
    return found ? found.split('=')[1] : fallback;
};

const inputPath = getArg('--input=', '/home/dev/uk_urls.csv');
const outDir = getArg('--outdir=', path.dirname(inputPath));
const outputPath = path.join(outDir, 'missing_uk_screenshot_urls.txt');
const outputGzPath = path.join(outDir, 'missing_uk_screenshot_urls.txt.gz');
const BATCH_SIZE = parseInt(getArg('--batch=', '2000'), 10);

function normalizeDomain(raw) {
    if (!raw) return '';
    let clean = raw.trim().toLowerCase();
    clean = clean.replace(/^https?:\/\//i, '');
    clean = clean.replace(/^www\./i, '');
    clean = clean.replace(/\/.*$/, '');
    return clean;
}

function getVariations(raw) {
    const cleaned = raw.trim();
    const domain = normalizeDomain(cleaned);
    if (!domain) return [];

    const variations = new Set([
        cleaned,
        domain,
        `http://${domain}`,
        `https://${domain}`,
        `http://${domain}/`,
        `https://${domain}/`,
        `http://www.${domain}`,
        `https://www.${domain}`,
        `http://www.${domain}/`,
        `https://www.${domain}/`
    ]);

    return Array.from(variations);
}

async function run() {
    console.log('='.repeat(70));
    console.log('  SocialWiki UK Screenshot Gap Analyzer & Exporter');
    console.log('='.repeat(70));
    console.log(`Input UK Master File : ${inputPath}`);
    console.log(`Output Plain Text    : ${outputPath}`);
    console.log(`Output Compressed    : ${outputGzPath}`);
    console.log(`Batch Size           : ${BATCH_SIZE}`);
    console.log(`MongoDB URI          : ${MONGO_URI}`);
    console.log(`Database             : ${DB_NAME}`);
    console.log(`Collection           : ${COLLECTION_NAME}`);
    console.log('='.repeat(70));

    if (!fs.existsSync(inputPath)) {
        console.error(`Error: Input file does not exist at ${inputPath}`);
        process.exit(1);
    }

    const client = new MongoClient(MONGO_URI, { maxPoolSize: 10 });
    await client.connect();
    console.log('Connected to MongoDB.');

    const db = client.db(DB_NAME);
    const collection = db.collection(COLLECTION_NAME);

    // Verify index on url
    const indexes = await collection.indexes();
    const hasUrlIndex = indexes.some(idx => idx.key && (idx.key.url === 1 || idx.key.url === -1));
    console.log(`Index status: ${hasUrlIndex ? 'Covered index on url found.' : 'Warning: no primary url index, using available indexes.'}`);

    const totalSSCount = await collection.estimatedDocumentCount();
    console.log(`Total existing screenshot records in DB: ${totalSSCount.toLocaleString()}`);

    const fileStream = fs.createReadStream(inputPath, { encoding: 'utf-8' });
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    const outStream = fs.createWriteStream(outputPath, { encoding: 'utf-8' });
    const gzStream = zlib.createGzip({ level: 6 });
    const gzOutFile = fs.createWriteStream(outputGzPath);
    gzStream.pipe(gzOutFile);

    let processedCount = 0;
    let missingCount = 0;
    let foundCount = 0;
    let isHeaderLine = true;
    let currentBatch = [];
    const startTime = Date.now();

    async function processBatch(batch) {
        if (batch.length === 0) return;

        // Build candidate variations query map
        const queryVariants = [];
        const variantToOriginals = new Map();

        for (const item of batch) {
            const vars = getVariations(item.url);
            for (const v of vars) {
                queryVariants.push(v);
                if (!variantToOriginals.has(v)) {
                    variantToOriginals.set(v, []);
                }
                variantToOriginals.get(v).push(item.original);
            }
        }

        // Query MongoDB with projection { url: 1, _id: 0 }
        const foundDocs = await collection.find(
            { url: { $in: queryVariants } },
            { projection: { url: 1, _id: 0 } }
        ).toArray();

        const foundOriginals = new Set();
        for (const doc of foundDocs) {
            if (doc.url && variantToOriginals.has(doc.url)) {
                for (const orig of variantToOriginals.get(doc.url)) {
                    foundOriginals.add(orig);
                }
            }
            // Also normalize doc.url to match by base domain
            const base = normalizeDomain(doc.url);
            if (base && variantToOriginals.has(base)) {
                for (const orig of variantToOriginals.get(base)) {
                    foundOriginals.add(orig);
                }
            }
        }

        for (const item of batch) {
            if (foundOriginals.has(item.original)) {
                foundCount++;
            } else {
                missingCount++;
                const line = `${item.original}\n`;
                outStream.write(line);
                gzStream.write(line);
            }
        }
    }

    console.log('\nStarting stream processing...\n');

    for await (const line of rl) {
        const trimmed = line.trim().replace(/^["']|["']$/g, '');
        if (!trimmed) continue;

        if (isHeaderLine) {
            isHeaderLine = false;
            if (trimmed.toLowerCase() === 'url' || trimmed.toLowerCase().startsWith('url,')) {
                continue;
            }
        }

        processedCount++;
        currentBatch.push({ url: trimmed, original: trimmed });

        if (currentBatch.length >= BATCH_SIZE) {
            await processBatch(currentBatch);
            currentBatch = [];

            if (processedCount % 50000 === 0) {
                const elapsedSec = (Date.now() - startTime) / 1000;
                const rps = Math.round(processedCount / elapsedSec);
                console.log(`[Progress] Processed: ${processedCount.toLocaleString()} | Missing: ${missingCount.toLocaleString()} | Found: ${foundCount.toLocaleString()} | Speed: ${rps.toLocaleString()} URLs/s | Elapsed: ${elapsedSec.toFixed(1)}s`);
            }
        }
    }

    if (currentBatch.length > 0) {
        await processBatch(currentBatch);
        currentBatch = [];
    }

    outStream.end();
    gzStream.end();

    await new Promise(resolve => gzOutFile.on('finish', resolve));
    await client.close();

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const plainStats = fs.statSync(outputPath);
    const gzStats = fs.statSync(outputGzPath);

    console.log('\n' + '='.repeat(70));
    console.log('  EXPORT COMPLETE');
    console.log('='.repeat(70));
    console.log(`Total URLs Processed: ${processedCount.toLocaleString()}`);
    console.log(`Screenshots Found   : ${foundCount.toLocaleString()} (${((foundCount / processedCount) * 100).toFixed(2)}%)`);
    console.log(`Missing Screenshots : ${missingCount.toLocaleString()} (${((missingCount / processedCount) * 100).toFixed(2)}%)`);
    console.log(`Time Taken          : ${totalElapsed} seconds`);
    console.log(`Plain Output File   : ${outputPath} (${(plainStats.size / (1024 * 1024)).toFixed(2)} MB)`);
    console.log(`Gzip Output File    : ${outputGzPath} (${(gzStats.size / (1024 * 1024)).toFixed(2)} MB)`);
    console.log('='.repeat(70));
}

run().catch(err => {
    console.error('Fatal execution error:', err);
    process.exit(1);
});
