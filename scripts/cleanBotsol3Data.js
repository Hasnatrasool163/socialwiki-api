const mongoose = require('mongoose');
require('dotenv').config();

const Botsol = require('../models/Botsol');

const EXECUTE_CHANGES = false;

const BATCH_SIZE = 4000;

const runCleanup = async () => {
    try {
        console.log('Connecting to database...');
        await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/web_postalwiki');
        console.log('Connected.\n');

        let totalRecordsToRemove = 0;

        console.log('--- Checking Address Formatting ---');

        const addressCount = await Botsol.countDocuments({
            $or: [
                { address: { $regex: /^\s*["“”]/ } },
                { address: { $regex: /["“”]\s*$/ } },
                { address: { $regex: /^\s+/ } },
                { address: { $regex: /\s+$/ } }
            ]
        });

        console.log(`Found ${addressCount} addresses with bad formatting.`);

        console.log('Skipping address fix (Dry Run).\n');

// ---------------- DEBUG SAMPLE ADDRESSES (THE BAD ONES) ----------------
console.log('\n--- SAMPLE ADDRESS DEBUG (RAW vs CLEAN) ---');

// Define the criteria for "bad" addresses
const badAddressCriteria = {
    $or: [
        { address: { $regex: /^\s*["“”]/ } },
        { address: { $regex: /["“”]\s*$/ } },
        { address: { $regex: /^\s+/ } },
        { address: { $regex: /\s+$/ } }
    ]
};

// Use the EXACT same criteria to fetch 5 samples
const sampleDocs = await Botsol.find(badAddressCriteria)
    .limit(5);

if (sampleDocs.length === 0) {
    console.log("No bad addresses found to display.");
}

const visualize = (str) => {
    return str.replace(/ /g, '·').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '|';
};

sampleDocs.forEach((doc, i) => {
    const raw = doc.address;
    
    // Logic: Remove all quotes AND remove trailing spaces
    const cleaned = raw
        .replace(/["“”]/g, '')   // Remove all quotes globally
        .replace(/\s+$/g, '');  // Remove trailing spaces at the very end

    console.log(`\n[${i + 1}] Company:`, doc.company_name);
    console.log('RAW (End marked by |)    :', visualize(raw));
    console.log('CLEANED (End marked by |):', visualize(cleaned));
});
        // ---------------- RULE 1 ----------------
        console.log('--- Deduplication Rule 1: URL + Date + Postcode ---');

        const rule1Cursor = Botsol.aggregate([
            {
                $match: {
                    url: { $exists: true, $ne: "" },
                    postcode: { $exists: true, $ne: "" }
                }
            },
            {
                $group: {
                    _id: {
                        url: "$url",
                        dateStr: { $dateToString: { format: "%Y-%m-%d", date: "$date" } },
                        postcode: "$postcode"
                    },
                    ids: { $push: "$_id" },
                    count: { $sum: 1 }
                }
            },
            { $match: { count: { $gt: 1 } } }
        ]).cursor({ batchSize: BATCH_SIZE });

        let r1Count = 0;

        for await (const doc of rule1Cursor) {
            const idsToDelete = doc.ids.slice(1);
            r1Count += idsToDelete.length;

            if (EXECUTE_CHANGES && idsToDelete.length > 0) {
                for (let i = 0; i < idsToDelete.length; i += BATCH_SIZE) {
                    await Botsol.deleteMany({
                        _id: { $in: idsToDelete.slice(i, i + BATCH_SIZE) }
                    });
                }
            }
        }

        console.log(`Found ${r1Count} duplicates for Rule 1.`);
        totalRecordsToRemove += r1Count;

        // ---------------- RULE 2 ----------------
        console.log('--- Deduplication Rule 2: Date + Company + Postcode (No URL) ---');

        const rule2Cursor = Botsol.aggregate([
            {
                $match: {
                    $or: [
                        { url: { $exists: false } },
                        { url: null },
                        { url: "" }
                    ],
                    postcode: { $exists: true, $ne: "" }
                }
            },
            {
                $group: {
                    _id: {
                        dateStr: { $dateToString: { format: "%Y-%m-%d", date: "$date" } },
                        company_name: "$company_name",
                        postcode: "$postcode"
                    },
                    ids: { $push: "$_id" },
                    count: { $sum: 1 }
                }
            },
            { $match: { count: { $gt: 1 } } }
        ]).cursor({ batchSize: BATCH_SIZE });

        let r2Count = 0;

        for await (const doc of rule2Cursor) {
            const idsToDelete = doc.ids.slice(1);
            r2Count += idsToDelete.length;

            if (EXECUTE_CHANGES && idsToDelete.length > 0) {
                for (let i = 0; i < idsToDelete.length; i += BATCH_SIZE) {
                    await Botsol.deleteMany({
                        _id: { $in: idsToDelete.slice(i, i + BATCH_SIZE) }
                    });
                }
            }
        }

        console.log(`Found ${r2Count} duplicates for Rule 2.`);
        totalRecordsToRemove += r2Count;

        console.log('--- Deduplication Rule 3: Date + Company + Address (No Postcode) ---');

        const rule3Cursor = Botsol.aggregate([
            {
                $match: {
                    $or: [
                        { postcode: { $exists: false } },
                        { postcode: null },
                        { postcode: "" },
                        { postcode: { $regex: /^\s*$/ } }
                    ]
                }
            },
            {
                $group: {
                    _id: {
                        dateStr: {
                            $dateToString: {
                                format: "%Y-%m-%d",
                                date: "$date"
                            }
                        },

                        company_name: {
                            $toLower: {
                                $trim: { input: "$company_name" }
                            }
                        },

                        // NORMALIZED ADDRESS (THIS IS KEY FIX)
                        address: {
                            $toLower: {
                                $trim: {
                                    input: {
                                        $replaceAll: {
                                            input: "$address",
                                            find: ",",
                                            replacement: ""
                                        }
                                    }
                                }
                            }
                        }
                    },
                    ids: { $push: "$_id" },
                    count: { $sum: 1 }
                }
            },
            { $match: { count: { $gt: 1 } } }
        ]).cursor({ batchSize: BATCH_SIZE });

        console.log('\n=============================================');
        console.log(`TOTAL RECORDS IDENTIFIED FOR DELETION: ${totalRecordsToRemove}`);
        console.log('=============================================');

        if (!EXECUTE_CHANGES) {
            console.log('\nDRY RUN COMPLETE');
            console.log('No data was modified or deleted.');
        }

    } catch (error) {
        console.error('Script Error:', error);
    } finally {
        await mongoose.connection.close();
        console.log('Database connection closed.');
    }
};

runCleanup();
