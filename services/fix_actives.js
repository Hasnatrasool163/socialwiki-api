const mongoose = require('mongoose');
const fs = require('fs');
const readline = require('readline');

const MONGO_URI = 'mongodb://localhost:27017/web_postalwiki';
const IS_DRY_RUN = process.argv[2] !== 'apply';

const CSV_FILE_PATH = 'NOT ACTIVE POST CODES-2.csv';

async function runSequence() {
    await mongoose.connect(MONGO_URI);
    const db = mongoose.connection.db;

    if (IS_DRY_RUN) {
        console.log("==================================================");
        console.log("🛡️  RUNNING IN DEBUG / SAFE MODE (PREVIEW ONLY)   ");
        console.log("   To execute live changes, run: node fix_actives.js apply");
        console.log("==================================================\n");
    } else {
        console.log("==================================================");
        console.log("🚀 RUNNING IN LIVE APPLICATION MODE                ");
        console.log("==================================================\n");
    }

    // --------------------------------------------------
    // STEP 1: PARSE AND IMPORT / OVERWRITE VIA CSV
    // --------------------------------------------------
    console.log("--------------------------------------------------");
    console.log(`▶️ STEP 1: Processing ${CSV_FILE_PATH}...`);
    console.log("--------------------------------------------------");

    if (!fs.existsSync(CSV_FILE_PATH)) {
        console.error(`❌ Error: Could not find file at ${CSV_FILE_PATH}`);
        await mongoose.disconnect();
        return;
    }

    const fileStream = fs.createReadStream(CSV_FILE_PATH);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let csvPostcodes = new Set();
    let batch = [];
    let importedCount = 0;

    for await (const line of rl) {
        if (!line.trim()) continue;

        const parts = line.split(/[\t,]+/);
        if (parts.length < 2) continue;

        const status = parts[0].replace(/['"]+/g, '').trim();   // "NOT ACTIVE"
        const postcode = parts[1].replace(/['"]+/g, '').trim(); // "AB1 0AA"

        if (!postcode) continue;
        csvPostcodes.add(postcode);

        if (!IS_DRY_RUN) {
            batch.push({
                updateOne: {
                    filter: { postcode: postcode },
                    update: { $set: { status: status } }, 
                    upsert: true
                }
            });

            if (batch.length >= 5000) {
                await db.collection('postcode_district').bulkWrite(batch, { ordered: false });
                importedCount += batch.length;
                console.log(`📥 Processed ${importedCount.toLocaleString()} postcodes...`);
                batch = [];
            }
        }
    }

    if (!IS_DRY_RUN && batch.length > 0) {
        await db.collection('postcode_district').bulkWrite(batch, { ordered: false });
        importedCount += batch.length;
    }

    console.log(`📊 Found ${csvPostcodes.size.toLocaleString()} unique postcodes in your CSV file.`);
    if (!IS_DRY_RUN) {
        console.log(`✅ Overwrite Import Complete: Synchronized ${importedCount.toLocaleString()} entries into postcode_district.`);
    }

    // --------------------------------------------------
    // STEP 2: ANALYZE & PURGE IMPACT ON RM MASTER
    // --------------------------------------------------
    console.log("\n--------------------------------------------------");
    console.log("▶️ STEP 2: Analyzing Impact on RM MASTER (address_master_merged)...");
    console.log("--------------------------------------------------");

    const targetPostcodes = Array.from(csvPostcodes);
    console.log(`📋 Total distinct codes targeted for cross-eviction: ${targetPostcodes.length.toLocaleString()}`);
    console.log("⚠️  Calculating matches inside address_master_merged in safe chunks... (Please wait)");

    const chunkSize = 50000;
    let matchCount = 0;

    // Split count checking into chunks to bypass 16MB query buffer limits
    for (let i = 0; i < targetPostcodes.length; i += chunkSize) {
        const chunk = targetPostcodes.slice(i, i + chunkSize);
        const chunkMatches = await db.collection('address_master_merged').countDocuments({
            postcode: { $in: chunk }
        });
        matchCount += chunkMatches;
    }

    console.log(`🔥 Total addresses found to purge: ${matchCount.toLocaleString()}`);

    if (!IS_DRY_RUN) {
        if (matchCount > 0) {
            console.log("🚀 Evicting records live in optimized blocks...");
            let totalPurged = 0;

            for (let i = 0; i < targetPostcodes.length; i += chunkSize) {
                const chunk = targetPostcodes.slice(i, i + chunkSize);
                const res = await db.collection('address_master_merged').deleteMany({
                    postcode: { $in: chunk }
                });
                totalPurged += res.deletedCount;
                console.log(`🗑️  Deleted ${totalPurged.toLocaleString()} rows...`);
            }
            console.log(`\n✨ Live Purge Complete: Permanently wiped out ${totalPurged.toLocaleString()} records from address_master_merged.`);
        } else {
            console.log("✅ RM Master was already perfectly clear of these codes.");
        }
    } else {
        console.log(`🛡️  [SAFE MODE] Will safely evict ${matchCount.toLocaleString()} total address records when executed live.`);
    }

    console.log("\n--------------------------------------------------");
    console.log(IS_DRY_RUN ? "🏁 SAFE RUN PREVIEW COMPLETE!" : "🏁 ALL LIVE TASKS SUCCESSFULLY COMPLETED!");
    console.log("--------------------------------------------------");
    await mongoose.disconnect();
}

runSequence().catch(console.error);
