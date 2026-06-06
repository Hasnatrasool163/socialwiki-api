const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: '../.env' });

const PostcodeDistrict = require('../models/PostcodeDistrict');

const REPORT_DIR = path.join(__dirname, '../imports/reports/missing-postcodes');
const REPORT_FILE_PREFIX = 'missing-postcodes';

async function runReport() {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGODB_URI);
    
    const generatedAt = new Date();
    const fileName = `${REPORT_FILE_PREFIX}-${generatedAt.toISOString().replace(/[:.]/g, '-')}.csv`;
    const filePath = path.join(REPORT_DIR, fileName);

    await fs.promises.mkdir(REPORT_DIR, { recursive: true });
    const outputStream = fs.createWriteStream(filePath, { encoding: 'utf8' });

    console.log("Starting aggregation (this may take a while)...");

    

const pipeline = [
    { $match: { district: { $ne: 'NOT ACTIVE' } } },
    { $lookup: { from: 'address_main', localField: 'postcode', foreignField: 'postcode', as: 'addressMatches' } },
    { $match: { 'addressMatches.0': { $exists: false } } },
    { 
        $project: { 
            _id: 0, 
            postcode_1: '$postcode', 
            district_1: '$district' 
        } 
    },
    { $sort: { postcode_1: 1 } }
];

   const cursor = PostcodeDistrict.aggregate(pipeline)
        .allowDiskUse(true)
        .cursor({ batchSize: 1000 });

    let missingCount = 0;
    for await (const row of cursor) {
        const postcode = (row?.postcode_1 || '').toString().trim();
        if (postcode) {
outputStream.write(`${row.postcode_1},${row.district_1}\n`);
            missingCount++;
            if (missingCount % 5000 === 0) console.log(`Processed ${missingCount} records...`);
        }
    }

    outputStream.end();
    console.log(`Report finished! Generated: ${fileName} (${missingCount} rows)`);
    await mongoose.disconnect();
}

runReport().catch(err => {
    console.error("FATAL ERROR:", err);
    process.exit(1);
});
