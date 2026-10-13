/**
 * import_postcode_centroids.js
 *
 * Importer for Ordnance Survey Code-Point Open.
 * Converts British National Grid (EPSG:27700 Eastings/Northings) to WGS84 (EPSG:4326 Lat/Lon).
 *
 * Usage:
 *   node scripts/import_postcode_centroids.js --dir=/path/to/codepoint/csvs
 *   or
 *   node scripts/import_postcode_centroids.js --file=/path/to/single_file.csv
 *   or
 *   node scripts/import_postcode_centroids.js --seed-sample (seeds sample postcodes for dev/testing)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const mongoose = require('mongoose');
require('dotenv').config();

const { bngToWgs84 } = require('../utils/bngToWgs84');
const PostcodeCentroid = require('../models/PostcodeCentroid');

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/web_postalwiki';

async function connectDB() {
    console.log(`Connecting to MongoDB...`);
    await mongoose.connect(MONGO_URI);
    console.log(`Connected successfully.`);
}

/**
 * Process a single Code-Point Open CSV file
 * OS Code-Point Open CSV format without headers:
 * Col 0: Postcode (e.g. "AB10 1XG")
 * Col 1: Positional Quality Indicator
 * Col 2: Easting
 * Col 3: Northing
 * Col 4: Country code
 * ...
 */
async function processCsvFile(filePath) {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    let batch = [];
    let count = 0;
    let btCount = 0;
    const BATCH_SIZE = 2000;

    for await (const line of rl) {
        if (!line.trim()) continue;
        const cols = line.split(',').map(s => s.replace(/^"|"$/g, '').trim());
        const pc = cols[0];
        const easting = parseInt(cols[2], 10);
        const northing = parseInt(cols[3], 10);

        if (!pc) continue;

        // Northern Ireland BT check
        if (pc.startsWith('BT')) {
            btCount++;
            // Note: OS Code-Point Open provides 0,0 or excludes BT postcodes
            // because Northern Ireland uses Irish National Grid / OSNI licensing.
            continue;
        }

        if (isNaN(easting) || isNaN(northing) || easting <= 0 || northing <= 0) {
            continue;
        }

        const coords = bngToWgs84(easting, northing);
        if (!coords) continue;

        batch.push({
            updateOne: {
                filter: { postcode: pc.toUpperCase() },
                update: {
                    $set: {
                        postcode: pc.toUpperCase(),
                        lat: coords.lat,
                        lon: coords.lon,
                        eastings: easting,
                        northings: northing,
                        source: 'os_codepoint_open'
                    }
                },
                upsert: true
            }
        });

        if (batch.length >= BATCH_SIZE) {
            await PostcodeCentroid.bulkWrite(batch, { ordered: false });
            count += batch.length;
            process.stdout.write(`\rImported ${count} postcodes...`);
            batch = [];
        }
    }

    if (batch.length > 0) {
        await PostcodeCentroid.bulkWrite(batch, { ordered: false });
        count += batch.length;
    }

    console.log(`\nFinished ${filePath}: ${count} imported (${btCount} BT postcodes skipped for OSNI/postcodes.io lookup).`);
    return { count, btCount };
}

async function main() {
    const args = process.argv.slice(2);
    const dirArg = args.find(a => a.startsWith('--dir='));
    const fileArg = args.find(a => a.startsWith('--file='));
    const seedArg = args.includes('--seed-sample');

    await connectDB();

    // Ensure index
    await PostcodeCentroid.collection.createIndex({ postcode: 1 }, { unique: true });

    if (seedArg) {
        console.log(`Seeding sample UK postcodes with converted BNG coordinates...`);
        const samples = [
            { pc: 'SW1A 1AA', e: 529090, n: 179645 }, // Buckingham Palace
            { pc: 'SW1A 2AA', e: 530040, n: 179960 }, // 10 Downing Street
            { pc: 'DN41 7RU', e: 519500, n: 410200 }, // Example from brief
            { pc: 'M1 1AE',   e: 384500, n: 398200 }, // Manchester Piccadilly
            { pc: 'B1 1BB',   e: 406800, n: 286700 }, // Birmingham
            { pc: 'EH1 1YZ',  e: 325900, n: 673900 }, // Edinburgh
            { pc: 'CF10 1DD', e: 318300, n: 176300 }, // Cardiff
        ];

        for (const s of samples) {
            const coords = bngToWgs84(s.e, s.n);
            await PostcodeCentroid.findOneAndUpdate(
                { postcode: s.pc },
                {
                    postcode: s.pc,
                    lat: coords.lat,
                    lon: coords.lon,
                    eastings: s.e,
                    northings: s.n,
                    source: 'os_codepoint_open'
                },
                { upsert: true }
            );
            console.log(`Seeded ${s.pc} -> Lat: ${coords.lat}, Lon: ${coords.lon}`);
        }

        console.log(`Sample seeding complete.`);
        process.exit(0);
    }

    if (fileArg) {
        const filePath = fileArg.split('=')[1];
        await processCsvFile(filePath);
        process.exit(0);
    }

    if (dirArg) {
        const dirPath = dirArg.split('=')[1];
        const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.csv'));
        console.log(`Found ${files.length} CSV files in ${dirPath}`);
        for (const f of files) {
            await processCsvFile(path.join(dirPath, f));
        }
        process.exit(0);
    }

    console.log(`No input specified. Run with --seed-sample or --dir=/path/to/codepoint/csvs`);
    process.exit(0);
}

if (require.main === module) {
    main().catch(err => {
        console.error('Import failed:', err);
        process.exit(1);
    });
}

module.exports = { processCsvFile };
