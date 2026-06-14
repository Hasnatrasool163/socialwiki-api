const mongoose = require('mongoose');
require('dotenv').config();

const Botsol = require('../models/Botsol');

// STEP 1: Keep this false for one final check, then flip to true
const EXECUTE_CHANGES = false; 
const BATCH_SIZE = 5000;

const runAddressCleanup = async () => {
    try {
        console.log('Connecting to database...');
        await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/web_postalwiki');
        console.log('Connected to MongoDB.\n');

        const totalBefore = await Botsol.countDocuments({});
        console.log(`Current total records in collection: ${totalBefore}`);

        console.log('--- Step 1: Scanning Address Formatting (STRICT EDGES ONLY) ---');
        const badAddressQuery = {
            $or: [
                { address: { $regex: /^\s*["“”]/ } },
                { address: { $regex: /["“”]\s*$/ } },
                { address: { $regex: /^\s+/ } },
                { address: { $regex: /\s+$/ } }
            ]
        };

        const targetCount = await Botsol.countDocuments(badAddressQuery);
        console.log(`Found ${targetCount} addresses requiring quote/space cleanup.`);

        if (targetCount === 0) {
            console.log('No bad addresses left to clean. Exiting.');
            return;
        }

        if (EXECUTE_CHANGES) {
            console.log(`\n▶️ EXECUTE_CHANGES is TRUE. Committing updates for ${targetCount} records...`);
            const addressCursor = Botsol.find(badAddressQuery).cursor({ batchSize: BATCH_SIZE });
            
            let bulkOps = [];
            let processedOps = 0;

            for await (const doc of addressCursor) {
                // STRICT BOUNDARY CLEANING ONLY
                const cleanedAddress = doc.address
                    .replace(/^["“”]+/, '')     // Remove quote at start
                    .replace(/["“”\s]+$/, '');  // Remove space/quote at end

                bulkOps.push({
                    updateOne: {
                        filter: { _id: doc._id },
                        update: { $set: { address: cleanedAddress } }
                    }
                });

                if (bulkOps.length >= BATCH_SIZE) {
                    await Botsol.bulkWrite(bulkOps);
                    processedOps += bulkOps.length;
                    console.log(`  Progress: Updated ${processedOps} / ${targetCount} addresses...`);
                    bulkOps = [];
                }
            }

            if (bulkOps.length > 0) {
                await Botsol.bulkWrite(bulkOps);
                processedOps += bulkOps.length;
            }
            console.log(`\n✅ Finished updating all ${processedOps} address fields.`);
        } else {
            console.log('\n⚠️ DRY RUN ONLY. No data was modified. Set EXECUTE_CHANGES = true to run.');
        }

        const totalAfter = await Botsol.countDocuments({});
        console.log('\n================ VERIFICATION ================');
        console.log(`Total records BEFORE script: ${totalBefore}`);
        console.log(`Total records AFTER script : ${totalAfter}`);
        console.log(`Difference                 : ${totalBefore - totalAfter} (Should be 0)`);
        console.log('==============================================');

    } catch (error) {
        console.error('Fatal script error:', error);
    } finally {
        await mongoose.connection.close();
        console.log('Database connection securely closed.');
    }
};

runAddressCleanup();
