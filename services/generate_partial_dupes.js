const crypto = require('crypto');
global.crypto = crypto.webcrypto;

const { MongoClient } = require('mongodb');
const fs = require('fs');

const uri = 'mongodb://127.0.0.1:27017';
const dbName = 'web_postalwiki';
const outputFile = 'Duplicate_Addresses_Report.csv';

// Define how many records Node should hold in memory at once
const CURSOR_BATCH_SIZE = 5000; 

async function run() {
    console.log("Connecting to MongoDB...");
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db(dbName);
    const collection = db.collection('address_master_merged');

    console.log(`Running aggregation (Fetching in chunks of ${CURSOR_BATCH_SIZE})...`);

    const writeStream = fs.createWriteStream(outputFile);
    writeStream.write("Postcode,Address\n");

    try {
        // We set a strict batchSize on the cursor to prevent memory flooding
        const cursor = collection.aggregate([
            {
                $group: {
                    _id: "$address",
                    distinctPostcodes: { $addToSet: "$postcode" },
                    count: { $sum: 1 }
                }
            },
            {
                $match: { count: { $gt: 1 } }
            },
            {
                $project: {
                    _id: 0,
                    address: "$_id",
                    postcodes: "$distinctPostcodes",
                    occurrences: "$count"
                }
            },
            { $sort: { occurrences: -1 } }
        ], { allowDiskUse: true }).batchSize(CURSOR_BATCH_SIZE);

        let processedGroups = 0;
        let writtenRows = 0;

        for await (const doc of cursor) {
            let cleanAddress = doc.address;
            try {
                const parsed = JSON.parse(doc.address);
                if (Array.isArray(parsed)) {
                    cleanAddress = parsed.join(", ");
                }
            } catch (e) {
                // Keep raw string if JSON.parse fails
            }

            for (const pc of doc.postcodes) {
                const line = `${pc},"${cleanAddress}"\n`;
                
                // CHUNKING LOGIC: Safely write to the file
                const canWrite = writeStream.write(line);
                writtenRows++;

                // If the stream buffer is full, pause Node and wait for the hard drive to catch up
                if (!canWrite) {
                    await new Promise(resolve => writeStream.once('drain', resolve));
                }
            }
            
            processedGroups++;

            if (processedGroups % 5000 === 0) {
                console.log(`✅ Processed & Chunked ${processedGroups.toLocaleString()} duplicate groups...`);
            }
        }

        console.log("\n==================================================");
        console.log(`🏁 Report Complete!`);
        console.log(`Total Duplicate Address Groups Found: ${processedGroups.toLocaleString()}`);
        console.log(`Total Rows Safely Written to CSV: ${writtenRows.toLocaleString()}`);
        console.log("==================================================\n");

    } catch (error) {
        console.error("❌ An error occurred:", error);
    } finally {
        writeStream.end();
        await client.close();
    }
}

run();
