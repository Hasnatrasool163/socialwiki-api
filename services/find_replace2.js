const mongoose = require('mongoose');
const fs = require('fs');
const readline = require('readline');
const { createObjectCsvWriter } = require('csv-writer'); // Added for native Excel support

const MONGO_URI = 'mongodb://localhost:27017/web_postalwiki';
const Address = require('../models/AddressMasterMerged');

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Clean for human scanning ONLY
 * - removes JSON artifacts if present
 * - keeps natural readable address
 */
function cleanForDisplay(addrStr) {
    if (!addrStr) return '';

    try {
        if (typeof addrStr === 'string' && addrStr.trim().startsWith('[')) {
            const parsed = JSON.parse(addrStr);
            if (Array.isArray(parsed)) {
                return parsed.join(', ');
            }
        }
    } catch (e) {}

    return String(addrStr)
        .replace(/[\[\]"]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Core transformation logic
 */
function applyReplace(value, findRegex, replaceTerm) {
    return value.replace(findRegex, replaceTerm);
}

async function runFindReplace(mode, findTerm, replaceTerm) {
    await mongoose.connect(MONGO_URI);

    const findRegex = new RegExp(`\\b${escapeRegex(findTerm)}\\b`, 'gi');

    // =====================================================
    // MODE 1: DUMP ONLY (EXCEL-READY CSV FORMAT)
    // =====================================================
    if (mode === 'dump') {
        console.log(`🔍 Dumping up to 100,000 changes for review...\n`);

        const cursor = Address.find({ address: findRegex }).cursor();
        
        // Configured a structured CSV output with explicit headers for Excel compatibility
        const csvWriter = createObjectCsvWriter({
            path: 'find_replace_preview.csv',
            header: [
                { id: 'postcode', title: 'postcode' },
                { id: 'original_address', title: 'original_address' },
                { id: 'replaced_address', title: 'replaced_address' }
            ]
        });

        const previewRecordsCsv = [];
        let count = 0;

        for await (const doc of cursor) {
            const oldAddr = doc.address;
            const newAddr = applyReplace(oldAddr, findRegex, replaceTerm);

            if (oldAddr === newAddr) continue;

            const oldClean = cleanForDisplay(oldAddr);
            const newClean = cleanForDisplay(newAddr);

            // Structure data cleanly into rows
            previewRecordsCsv.push({
                postcode: doc.postcode || '',
                original_address: oldClean,
                replaced_address: newClean
            });

            count++;

            // Capped sample size
            if (count >= 100000) break;
        }

        // Flush all records to disk as a clean CSV
        await csvWriter.writeRecords(previewRecordsCsv);

        console.log(`\n✅ DONE`);
        console.log(`📂 Excel-ready CSV preview generated: find_replace_preview.csv`);
        console.log(`🔢 Total changes listed: ${count}`);

        await mongoose.disconnect();
        return;
    }

    // =====================================================
    // MODE 2: APPLY CHANGES (SAFE CONFIRMATION)
    // =====================================================
    if (mode === 'replace') {
        console.log(`⚠️ APPLY MODE: "${findTerm}" → "${replaceTerm}"`);

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        const confirm = await new Promise(resolve => {
            rl.question('Confirm apply changes to DB? (Y/N): ', ans => {
                rl.close();
                resolve(ans.trim().toLowerCase());
            });
        });

        if (confirm !== 'y') {
            console.log('❌ Aborted.');
            await mongoose.disconnect();
            return;
        }

        const cursor = Address.find({ address: findRegex }).cursor();

        let batch = [];
        let count = 0;

        for await (const doc of cursor) {
            const newAddr = applyReplace(doc.address, findRegex, replaceTerm);

            if (newAddr === doc.address) continue;

            batch.push({
                updateOne: {
                    filter: { _id: doc._id },
                    update: { $set: { address: newAddr } }
                }
            });

            if (batch.length >= 1000) {
                await Address.bulkWrite(batch, { ordered: false });
                count += batch.length;
                console.log(`🔄 Updated: ${count}`);
                batch = [];
            }
        }

        if (batch.length > 0) {
            await Address.bulkWrite(batch, { ordered: false });
            count += batch.length;
        }

        console.log(`\n✅ COMPLETE`);
        console.log(`🔢 Total updated: ${count}`);

        await mongoose.disconnect();
        return;
    }

    await mongoose.disconnect();
}

// CLI
const [,, mode, findTerm, replaceTerm] = process.argv;

// FIX: Now strictly requires replaceTerm for ALL modes to prevent 'undefined' injection
if (!mode || !findTerm || !replaceTerm || !['dump', 'replace'].includes(mode)) {
    console.log(`
❌ ERROR: Missing arguments!

Usage:
  node find_replace.js dump "find_text" "replace_text"
  node find_replace.js replace "find_text" "replace_text"

Examples:
  node find_replace.js dump "po box" "PO Box"
  node find_replace.js replace "po box" "PO Box"
`);
    process.exit(1);
}

runFindReplace(mode, findTerm, replaceTerm).catch(console.error);
