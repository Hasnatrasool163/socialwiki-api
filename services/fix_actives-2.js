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
        console.log("🚀 RUNNING IN LIVE PURGE MODE (DELETION ONLY)      ");
        console.log("==================================================\n");
    }

    // --------------------------------------------------
    // STEP 1: PARSE CSV (READ-ONLY, NO IMPORT)
    // --------------------------------------------------
    console.log("--------------------------------------------------");
    console.log(`▶️ STEP 1: Reading targets from ${CSV_FILE_PATH}...`);
    console.log("--------------------------------------------------");

    if (!fs.existsSync(CSV_FILE_PATH)) {
        console.error(`❌ Error: Could not find file at ${CSV_FILE_PATH}`);
        await mongoose.disconnect();
        return;
    }

    const fileStream = fs.createReadStream(CSV_FILE_PATH);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let csvPostcodes = new Set();

    for await (const line of rl) {
        if (!line.trim()) continue;

        const parts = line.split(/[\t,]+/);
        if (parts.length < 2) continue;

        const postcode = parts[1].replace(/['"]+/g, '').trim().toUpperCase();

        if (!postcode || postcode === 'POSTCODE' || postcode === 'POST CODE') continue;
        csvPostcodes.add(postcode);
    }

    console.log(`📊 Loaded ${csvPostcodes.size.toLocaleString()} unique postcodes from file.`);
    console.log(`🛡️  [SAFE] Skipping postcode_district import (Waiting for district field updates).`);

    // --------------------------------------------------
    // STEP 2: PURGE IMPACT ON RM MASTER
    // --------------------------------------------------
    console.log("\n--------------------------------------------------");
    console.log("▶️ STEP 2: Evicting Matches from RM MASTER (address_master_merged)...");
    console.log("--------------------------------------------------");

    const targetPostcodes = Array.from(csvPostcodes);
    console.log(`📋 Total distinct codes targeted for cross-eviction: ${targetPostcodes.length.toLocaleString()}`);
    console.log("⚠️  Calculating matches inside address_master_merged in safe chunks...");

    const chunkSize = 50000;
    let matchCount = 0;

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
    console.log(IS_DRY_RUN ? "🏁 SAFE RUN PREVIEW COMPLETE!" : "🏁 LIVE EVICITON TASK SUCCESSFULLY COMPLETED!");
    console.log("--------------------------------------------------");
    await mongoose.disconnect();
}

runSequence().catch(console.error);

