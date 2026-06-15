const mongoose = require('mongoose');
const fs = require('fs');
const { parse } = require('csv-parse');
const path = require('path');

const AddressMasterMerged = require('../models/AddressMasterMerged'); 

const CSV_FILE = '/home/dev/api.socialwiki.co.uk/deploy/exports/rm_address/rm_address_export_1781479428241.csv';
const MONGO_URI = 'mongodb://localhost:27017/web_postalwiki'; 

async function restore() {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB');

    const parser = fs.createReadStream(CSV_FILE).pipe(parse({ columns: true, skip_empty_lines: true }));
    let count = 0;
    const batch = [];

    for await (const row of parser) {
        // Prepare the document
        const doc = {
            _id: new mongoose.Types.ObjectId(row.id),
            postcode: row.postcode,
            district: row.district,
            address: row.address,
            dateCreated: row.dateCreated,
            correctionVersion: row.correctionVersion || 'v1',
            exceptionVersion: row.exceptionVersion || undefined
        };

        batch.push({
            updateOne: {
                filter: { _id: doc._id },
                update: { $set: doc },
                upsert: true
            }
        });

        if (batch.length >= 1000) {
            await AddressMasterMerged.bulkWrite(batch);
            count += batch.length;
            console.log(`Inserted ${count} records...`);
            batch.length = 0;
        }
    }

    if (batch.length > 0) {
        await AddressMasterMerged.bulkWrite(batch);
        count += batch.length;
    }

    console.log(`Successfully restored ${count} records.`);
    process.exit();
}

restore().catch(console.error);
