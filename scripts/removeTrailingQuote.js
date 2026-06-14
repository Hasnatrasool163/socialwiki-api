const mongoose = require('mongoose');
require('dotenv').config();

const Botsol = require('../models/Botsol');

const EXECUTE_CHANGES = true;
const BATCH_SIZE = 4000;

const runTrailingQuoteCleanup = async () => {
    try {
        console.log('Connecting to database...');
        await mongoose.connect(
            process.env.MONGO_URI ||
            'mongodb://127.0.0.1:27017/web_postalwiki'
        );
        console.log('Connected to MongoDB.\n');

        const totalBefore = await Botsol.countDocuments({});
        console.log(`Current total records in collection: ${totalBefore}`);

        const badAddressQuery = {
            address: { $regex: /"$/ }
        };

        const targetCount = await Botsol.countDocuments(badAddressQuery);

        console.log(`Found ${targetCount} addresses ending with a quote.`);

        if (targetCount === 0) {
            console.log('No bad addresses left to clean. Exiting.');
            return;
        }

        if (EXECUTE_CHANGES) {
            console.log(`\n▶️ EXECUTE_CHANGES is TRUE. Updating ${targetCount} records...`);

            const cursor = Botsol.find(badAddressQuery).cursor({
                batchSize: BATCH_SIZE
            });

            let bulkOps = [];
            let processed = 0;

            for await (const doc of cursor) {
                const cleanedAddress = doc.address.replace(/"$/, '');

                bulkOps.push({
                    updateOne: {
                        filter: { _id: doc._id },
                        update: {
                            $set: {
                                address: cleanedAddress
                            }
                        }
                    }
                });

                if (bulkOps.length >= BATCH_SIZE) {
                    await Botsol.bulkWrite(bulkOps);
                    processed += bulkOps.length;

                    console.log(
                        `Progress: ${processed} / ${targetCount}`
                    );

                    bulkOps = [];
                }
            }

            if (bulkOps.length) {
                await Botsol.bulkWrite(bulkOps);
                processed += bulkOps.length;
            }

            console.log(`\n✅ Finished updating ${processed} addresses.`);
        } else {
            console.log('\n⚠️ DRY RUN ONLY. No data was modified.');
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

runTrailingQuoteCleanup();
