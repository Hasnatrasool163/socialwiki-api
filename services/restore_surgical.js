const mongoose = require('mongoose');
const fs = require('fs');
const csv = require('csv-parser');

const MONGO_URI = 'mongodb://localhost:27017/web_postalwiki';
const CSV_FILE = 'duplicate_deletes_preview.csv';
const BACKUP_COLL = 'address_master_merged_backup_2026_06_20';
const LIVE_COLL = 'address_master_merged';

async function runRestore() {
    await mongoose.connect(MONGO_URI);
    const db = mongoose.connection.db;
    const backup = db.collection(BACKUP_COLL);
    const live = db.collection(LIVE_COLL);

    // Read all rows into an array first
    const results = [];
    fs.createReadStream(CSV_FILE)
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', async () => {
            console.log(`🚀 Found ${results.length} records. Starting sequential restoration...`);

            // Use a for...of loop to process one-by-one
            for (const row of results) {
                const idToRestore = row.id_to_delete;
                if (!idToRestore) continue;

                try {
                    const cleanDoc = await backup.findOne({ _id: new mongoose.Types.ObjectId(idToRestore) });
                    
                    if (cleanDoc) {
                        await live.replaceOne(
                            { _id: new mongoose.Types.ObjectId(idToRestore) },
                            cleanDoc,
                            { upsert: true }
                        );
                        console.log(`✅ Restored: ${idToRestore}`);
                    } else {
                        console.log(`⚠️ Record not found in backup: ${idToRestore}`);
                    }
                } catch (err) {
                    console.error(`❌ Error restoring ${idToRestore}:`, err.message);
                }
            }
            
            console.log('🏁 Restoration process finished.');
            await mongoose.disconnect();
        });
}

runRestore().catch(console.error);
