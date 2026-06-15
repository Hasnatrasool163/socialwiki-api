const mongoose = require('mongoose');
const fs = require('fs');
const readline = require('readline');
const { createObjectCsvWriter } = require('csv-writer');

const MONGO_URI = 'mongodb://localhost:27017/web_postalwiki';
const Address = require('../models/AddressMasterMerged');

// Extracts clean text from stringified JSON array formatting for Excel viewing
function cleanForDisplay(rawStr) {
    if (!rawStr) return '';
    try {
        if (rawStr.trim().startsWith('[')) {
            const parsed = JSON.parse(rawStr);
            if (Array.isArray(parsed)) {
                return parsed.join(', ');
            }
        }
    } catch (e) {}
    return rawStr.replace(/[\[\]"]/g, '').split(',').map(s => s.trim()).join(', ');
}

// Converts entity safely inside arrays or raw strings
function processApostrophe(rawStr) {
    if (!rawStr) return { updatedStr: rawStr, isChanged: false };

    let elements = [];
    let isJson = false;

    try {
        if (rawStr.trim().startsWith('[')) {
            const parsed = JSON.parse(rawStr);
            if (Array.isArray(parsed)) {
                elements = parsed;
                isJson = true;
            }
        }
    } catch (e) {}

    if (!isJson) {
        elements = [rawStr];
    }

    let changed = false;
    const updatedElements = elements.map(el => {
        let fixed = el.replace(/&#39;/g, "'");
        if (fixed !== el) changed = true;
        return fixed;
    });

    const updatedStr = isJson ? JSON.stringify(updatedElements) : updatedElements[0];
    return { updatedStr, isChanged: changed };
}

async function runGlobalCleanup(mode = 'dump') {
    await mongoose.connect(MONGO_URI);

    // Target precisely the 77,376 rows containing the HTML entity
    const query = { address: /&#39;/ };

    // =====================================================
    // MODE 1: DUMP PREVIEW (EXCEL-READY CSV)
    // =====================================================
    if (mode === 'dump') {
        console.log(`🔍 Scanning 77,376 records for preview generation...`);
        const cursor = Address.find(query).cursor();

        const csvWriter = createObjectCsvWriter({
            path: 'apostrophe_clean_preview.csv',
            header: [
                { id: 'postcode', title: 'postcode' },
                { id: 'original_address', title: 'original_address' },
                { id: 'corrected_address', title: 'corrected_address' }
            ]
        });

        const duplicateCsvWriter = createObjectCsvWriter({
            path: 'apostrophe_duplicates_preview.csv',
            header: [
                { id: 'postcode', title: 'postcode' },
                { id: 'original_address', title: 'original_address' },
                { id: 'corrected_address', title: 'corrected_address' },
                { id: 'id_to_delete', title: 'id_to_delete' },
                { id: 'conflicting_existing_id', title: 'conflicting_existing_id' }
            ]
        });

        const previewRecords = [];
        const duplicateRecords = [];
        let count = 0;

        for await (const doc of cursor) {
            const { updatedStr, isChanged } = processApostrophe(doc.address);
            if (!isChanged) continue;

            const oldClean = cleanForDisplay(doc.address);
            const newClean = cleanForDisplay(updatedStr);

            previewRecords.push({
                postcode: doc.postcode || '',
                original_address: oldClean,
                corrected_address: newClean
            });

            // Safeguard check: Does a clean version already exist under this postcode?
            const duplicate = await Address.findOne({
                _id: { $ne: doc._id },
                postcode: doc.postcode,
                address: updatedStr
            });

            if (duplicate) {
                duplicateRecords.push({
                    postcode: doc.postcode,
                    original_address: oldClean,
                    corrected_address: newClean,
                    id_to_delete: doc._id.toString(),
                    conflicting_existing_id: duplicate._id.toString()
                });
            }

            count++;
            if (count % 20000 === 0) console.log(`Processed ${count} rows...`);
        }

        await csvWriter.writeRecords(previewRecords);
        await duplicateCsvWriter.writeRecords(duplicateRecords);

        console.log(`\n✅ SCAN COMPLETE`);
        console.log(`📂 Preview spreadsheet saved: apostrophe_clean_preview.csv`);
        if (duplicateRecords.length > 0) {
            console.log(`⚠️ Alert: ${duplicateRecords.length} unique index conflicts found! Logged to: apostrophe_duplicates_preview.csv`);
        } else {
            console.log(`✅ Zero index conflicts found.`);
        }

        await mongoose.disconnect();
        return;
    }

    // =====================================================
    // MODE 2: APPLY LIVE CHANGES (SAFE BATCHES)
    // =====================================================
    if (mode === 'apply') {
        console.log(`⚠️ Preparation: Reviewing first few replacements...`);
        const cursor = Address.find(query).limit(5);
        
        console.log("\n--- LIVE SNEAK PEEK ---");
        for await (const doc of cursor) {
            const { updatedStr } = processApostrophe(doc.address);
            console.log(`\x1b[31m${cleanForDisplay(doc.address)}\x1b[0m`);
            console.log(`\x1b[32m${cleanForDisplay(updatedStr)}\x1b[0m\n`);
        }
        console.log("------------------------");

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const confirm = await new Promise(res => {
            rl.question(`Proceed to execute cleanup on all matching records and clear index conflicts? (Y/N): `, ans => {
                rl.close(); res(ans.trim().toLowerCase());
            });
        });

        if (confirm !== 'y') {
            console.log('❌ Operation aborted.');
            await mongoose.disconnect();
            return;
        }

        console.log(`🚀 Executing high-speed bulk writes...`);
        const executionCursor = Address.find(query).cursor();
        let batch = [];
        let updateCount = 0;
        let deleteCount = 0;

        for await (const doc of executionCursor) {
            const { updatedStr, isChanged } = processApostrophe(doc.address);
            if (!isChanged) continue;

            const duplicate = await Address.findOne({
                _id: { $ne: doc._id },
                postcode: doc.postcode,
                address: updatedStr
            });

            if (duplicate) {
                batch.push({ deleteOne: { filter: { _id: doc._id } } });
                deleteCount++;
            } else {
                batch.push({
                    updateOne: {
                        filter: { _id: doc._id },
                        update: { $set: { address: updatedStr } }
                    }
                });
                updateCount++;
            }

            if (batch.length >= 1000) {
                await Address.bulkWrite(batch, { ordered: false });
                console.log(`🔄 Status: ${updateCount} rows updated, ${deleteCount} duplicates purged...`);
                batch = [];
            }
        }

        if (batch.length > 0) {
            await Address.bulkWrite(batch, { ordered: false });
        }

        console.log(`\n✅ COMPLETE! Successfully updated ${updateCount} rows and cleared ${deleteCount} unique conflicts.`);
    }

    await mongoose.disconnect();
}

const mode = process.argv[2] || 'dump';
runGlobalCleanup(mode).catch(console.error);
