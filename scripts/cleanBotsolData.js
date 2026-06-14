const mongoose = require('mongoose');
require('dotenv').config();

const Botsol = require('../models/Botsol');

// =========================================================================
// SET THIS TO true TO EXECUTE THE FINAL CLEANUP AND DELETE RECORDS
// =========================================================================
const EXECUTE_CHANGES = true; 
const BATCH_SIZE = 5000;

const runCompleteCleanup = async () => {
    try {
        console.log('Connecting to database...');
        await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/web_postalwiki');
        console.log('Connected to MongoDB.\n');

        const totalBefore = await Botsol.countDocuments({});
        console.log(`Initial total records in collection: ${totalBefore}\n`);
        
        let totalDeleted = 0;

        // =========================================================================
        // STEP 1: ADDRESS FORMATTING SANITIZATION (STRICT BOUNDARIES)
        // =========================================================================
        console.log('--- Step 1: Cleaning Address Formatting ---');
        const badAddressQuery = {
            $or: [
                { address: { $regex: /^["“”]/ } },
                { address: { $regex: /["“”]$/ } }
            ]
        };

        const addressCount = await Botsol.countDocuments(badAddressQuery);
        console.log(`Found ${addressCount} addresses requiring boundary quote cleanup.`);

        if (addressCount > 0 && EXECUTE_CHANGES) {
            console.log('Processing address updates in optimized bulk batches...');
            const addressCursor = Botsol.find(badAddressQuery).cursor({ batchSize: BATCH_SIZE });
            let bulkOps = [];
            let processedOps = 0;

            for await (const doc of addressCursor) {
                const cleanedAddress = doc.address
                    .replace(/^["“”]+/, '')     // Remove quote at start
                    .replace(/["“”]+$/, '')     // Remove quote at end 
                    .trim();                    // Clean any dangling edge spacing

                bulkOps.push({
                    updateOne: {
                        filter: { _id: doc._id },
                        update: { $set: { address: cleanedAddress } }
                    }
                });

                if (bulkOps.length >= BATCH_SIZE) {
                    await Botsol.bulkWrite(bulkOps);
                    processedOps += bulkOps.length;
                    console.log(`  Progress: Updated ${processedOps}/${addressCount} addresses...`);
                    bulkOps = [];
                }
            }
            if (bulkOps.length > 0) {
                await Botsol.bulkWrite(bulkOps);
                processedOps += bulkOps.length;
            }
            console.log(`✅ Finished updating all ${processedOps} address fields.`);
        }
        console.log('--------------------------------------------------\n');


        // =========================================================================
        // STEP 2: DEDUPLICATION RULE 1 (URL + DATE + POSTCODE)
        // =========================================================================
        console.log('--- Step 2: Deduplication Rule 1 (URL + Date + Postcode) ---');
        const rule1Cursor = Botsol.aggregate([
            {
                $match: {
                    url: { $exists: true, $ne: "" },
                    postcode: { $exists: true, $ne: "" },
                    date: { $exists: true }
                }
            },
            {
                $group: {
                    _id: {
                        url: "$url",
                        date: "$date",
                        postcode: "$postcode"
                    },
                    ids: { $push: "$_id" },
                    count: { $sum: 1 }
                }
            },
            { $match: { count: { $gt: 1 } } }
        ]).allowDiskUse(true).cursor({ batchSize: BATCH_SIZE });

        let r1Count = 0;
        for await (const group of rule1Cursor) {
            const idsToDelete = group.ids.slice(1);
            r1Count += idsToDelete.length;

            if (EXECUTE_CHANGES && idsToDelete.length > 0) {
                await Botsol.deleteMany({ _id: { $in: idsToDelete } });
            }
        }
        console.log(`✅ Rule 1: Removed ${r1Count} duplicate records.`);
        totalDeleted += r1Count;
        console.log('--------------------------------------------------\n');


        // =========================================================================
        // STEP 3: DEDUPLICATION RULE 2 (NO URL -> DATE + COMPANY + POSTCODE)
        // =========================================================================
        console.log('--- Step 3: Deduplication Rule 2 (No URL -> Date + Company + Postcode) ---');
        const rule2Cursor = Botsol.aggregate([
            {
                $match: {
                    $or: [{ url: { $exists: false } }, { url: null }, { url: "" }],
                    company_name: { $exists: true, $ne: "" },
                    postcode: { $exists: true, $ne: "" },
                    date: { $exists: true }
                }
            },
            {
                $group: {
                    _id: {
                        company_name: "$company_name",
                        date: "$date",
                        postcode: "$postcode"
                    },
                    ids: { $push: "$_id" },
                    count: { $sum: 1 }
                }
            },
            { $match: { count: { $gt: 1 } } }
        ]).allowDiskUse(true).cursor({ batchSize: BATCH_SIZE });

        let r2Count = 0;
        for await (const group of rule2Cursor) {
            const idsToDelete = group.ids.slice(1);
            r2Count += idsToDelete.length;

            if (EXECUTE_CHANGES && idsToDelete.length > 0) {
                await Botsol.deleteMany({ _id: { $in: idsToDelete } });
            }
        }
        console.log(`✅ Rule 2: Removed ${r2Count} duplicate records.`);
        totalDeleted += r2Count;
        console.log('--------------------------------------------------\n');


        // =========================================================================
        // FINAL COMPREHENSIVE VERIFICATION
        // =========================================================================
        const totalAfter = await Botsol.countDocuments({});
        
        console.log('==================== SUMMARY BREAKDOWN ====================');
        console.log(`Total Database Records Before Cleanup : ${totalBefore}`);
        console.log(`Total Duplicate Records Dropped       : ${totalDeleted}`);
        console.log(`Actual Database Records Remaining     : ${totalAfter}`);
        console.log(`Net Loss Drop Rate                    : ${((totalDeleted / totalBefore) * 100).toFixed(2)}%`);
        console.log('===========================================================');

    } catch (error) {
        console.error('Fatal execution error running cleanup script:', error);
    } finally {
        await mongoose.connection.close();
        console.log('Database connection safely closed.');
    }
};

runCompleteCleanup();
