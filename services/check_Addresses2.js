const mongoose = require('mongoose');
const fs = require('fs');
const readline = require('readline');
const { createObjectCsvWriter } = require('csv-writer');

const MONGO_URI = 'mongodb://localhost:27017/web_postalwiki';
const Address = require('../models/AddressMasterMerged');

// Extracts clean, readable text from stringified JSON array formatting
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

// Applies strict single-character filtering rules
function processAddressField(rawStr) {
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
        // SOLUTION 1: Safely convert raw HTML entity strings into true apostrophes
        // This ensures downstream regex rules read text naturally and accurately
        let fixed = el.replace(/&#39;/g, "'");

        // 1. Rule: Compress 2 or more sequential single alpha letters safely (A A Name -> AA Name)
        // FIXED: Added (?<!') lookbehind to protect letters directly trailing an apostrophe (e.g., "Ty'r Y Sarn")
        fixed = fixed.replace(/(?<!')\b([A-Za-z])(?:\s+([A-Za-z]))+(?=\s|,|$)/g, m => m.replace(/\s+/g, ''));

        // 2. Exception 2: Fix Ampersands "A & A" -> "A&A" (STRICTLY single letters only)
        // FIXED: Added lookarounds (?<!') and (?!') to keep spaces around ampersands for contractions like "P's & Q's"
        fixed = fixed.replace(/(?<!')\b([A-Za-z])\s*&\s*([A-Za-z])\b(?!')/g, '$1&$2');

        // 3. Exception 3: Fix Dashes "A – A" -> "A-A" (STRICTLY single letters only using literal en-dash)
        // FIXED: Added identical lookaround guards to avoid potential edge case collisions with dashes
        fixed = fixed.replace(/(?<!')\b([A-Za-z])\s*[–-]\s*([A-Za-z])\b(?!')/g, '$1-$2');

        if (fixed !== el) changed = true;
        return fixed;
    });

    const updatedStr = isJson ? JSON.stringify(updatedElements) : updatedElements[0];
    return { updatedStr, isChanged: changed };
}

async function runCorrection(mode = 'dump') {
    await mongoose.connect(MONGO_URI);

    // NARROWED QUERY: Targets only actual patterns (A A, A & A, A - A) avoiding broad COLLSCAN flags
    const query = {
        address: {
            $regex: /\b[A-Za-z](?:\s+[A-Za-z])+\b|\b[A-Za-z]\s*&\s*[A-Za-z]\b|\b[A-Za-z]\s*[–-]\s*[A-Za-z]\b/
        }
    };

    // ----------------------------------------------------
    // MODE 1: DUMP ONLY (Outputs ultra-clean scan files)
    // ----------------------------------------------------
    if (mode === 'dump') {
        console.log(`🔍 Scanning database for candidate adjustments...`);
        const cursor = Address.find(query).cursor();

        const candidateRecords = [];
        let count = 0;

        for await (const doc of cursor) {
            const { updatedStr, isChanged } = processAddressField(doc.address);
            if (!isChanged) continue;

            candidateRecords.push({ doc, updatedStr });
            count++;
            if (count >= 100000) break; // Capped sample size
        }

        console.log(`📊 Found ${candidateRecords.length} candidate corrections. Writing preview files...`);

        const writeStream = fs.createWriteStream('address_preview.txt');
        const csvWriter = createObjectCsvWriter({
            path: 'duplicate_deletes_preview.csv',
            header: [
                { id: 'postcode', title: 'postcode' },
                { id: 'original_address', title: 'original_address' },
                { id: 'corrected_address', title: 'corrected_address' },
                { id: 'id_to_delete', title: 'id_to_delete' },
                { id: 'conflicting_existing_id', title: 'conflicting_existing_id' }
            ]
        });

        const duplicateRecordsCsv = [];

        for (const item of candidateRecords) {
            const oldClean = cleanForDisplay(item.doc.address);
            const newClean = cleanForDisplay(item.updatedStr);

            // Output requested format: Old on line 1, New on line 2, space below
            writeStream.write(`${oldClean}\n${newClean}\n\n`);

            // Check for potential duplicate conflicts before running updates
            const duplicate = await Address.findOne({
                _id: { $ne: item.doc._id }, // Don't match self
                postcode: item.doc.postcode,
                address: item.updatedStr
            });

            if (duplicate) {
                duplicateRecordsCsv.push({
                    postcode: item.doc.postcode,
                    original_address: oldClean,
                    corrected_address: newClean,
                    id_to_delete: item.doc._id.toString(),
                    conflicting_existing_id: duplicate._id.toString()
                });
            }
        }

        writeStream.end();

        if (duplicateRecordsCsv.length > 0) {
            await csvWriter.writeRecords(duplicateRecordsCsv);
            console.log(`⚠️  Alert: ${duplicateRecordsCsv.length} records will result in conflicts and will be DELETED during apply mode.`);
            console.log(`📂 Conflict mapping details dumped to: duplicate_deletes_preview.csv`);
        } else {
            await csvWriter.writeRecords([]); // Clear out file if empty
            console.log(`✅ Clean scan: Zero unique index conflicts or duplicate deletes detected.`);
        }

        console.log(`✅ Visual text file generated: address_preview.txt`);
        await mongoose.disconnect();
        return;
    }

    // ----------------------------------------------------
    // MODE 2: APPLY CORRECTIONS (Safe execution with live verification)
    // ----------------------------------------------------
    if (mode === 'apply') {
        console.log(`⚠️ Analyzing correction patterns for screen preview...`);
        const cursor = Address.find(query).cursor();

        let previewCount = 0;
        const previewPairs = [];

        for await (const doc of cursor) {
            const { updatedStr, isChanged } = processAddressField(doc.address);
            if (isChanged) {
                previewPairs.push({
                    old: cleanForDisplay(doc.address),
                    new: cleanForDisplay(updatedStr)
                });
                previewCount++;
                if (previewCount >= 5) break;
            }
        }

        if (previewPairs.length === 0) {
            console.log("✅ Database matches clean targets. No adjustments necessary.");
            await mongoose.disconnect();
            return;
        }

        // Output sample modifications to terminal screen
        console.log("\n--- PEACE OF MIND LIVE PREVIEW ---");
        previewPairs.forEach(pair => {
            console.log(`\x1b[31m${pair.old}\x1b[0m`);
            console.log(`\x1b[32m${pair.new}\x1b[0m\n`);
        });
        console.log("----------------------------------");

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const confirm = await new Promise(res => {
            rl.question('Do these change patterns look correct? Apply changes and purge duplicates? (Y/N): ', ans => {
                rl.close(); res(ans.trim().toLowerCase());
            });
        });

        if (confirm !== 'y') {
            console.log('❌ Operation aborted.');
            await mongoose.disconnect();
            return;
        }

        console.log(`🚀 Committing batch modifications...`);
        const executionCursor = Address.find(query).cursor();
        let batch = [];
        let updateCount = 0;
        let deleteCount = 0;

        for await (const doc of executionCursor) {
            const { updatedStr, isChanged } = processAddressField(doc.address);
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
                console.log(`🔄 Execution status: ${updateCount} records updated, ${deleteCount} duplicates cleared...`);
                batch = [];
            }
        }

        if (batch.length > 0) {
            await Address.bulkWrite(batch, { ordered: false });
        }

        console.log(`\n✅ COMPLETE! Successfully updated: ${updateCount} records. Safely removed: ${deleteCount} duplicates.`);
    }

    await mongoose.disconnect();
}

const mode = process.argv[2] || 'dump';
runCorrection(mode).catch(console.error);
