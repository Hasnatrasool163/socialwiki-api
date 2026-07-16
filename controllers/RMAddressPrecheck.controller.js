const mongoose              = require('mongoose');
const AddressMasterPrecheck = require('../models/AddressMasterPrecheck');
const AddressMasterAiQueue  = require('../models/AddressMasterAiQueue');
const AddressMasterChecked  = require('../models/AddressMasterChecked');
const rmAddressLogger       = require('../config/loggers/rmAddressLogger');

const addressPartsFromDoc = (address) => {
    if (typeof address === 'string' && address.startsWith('[')) {
        try {
            const parsed = JSON.parse(address);
            if (Array.isArray(parsed)) return parsed;
        } catch (e) {}
    }
    if (typeof address === 'string') {
        return address.split(',').map(p => p.trim()).filter(Boolean);
    }
    return [];
};

// GET /precheck/stats
const getStats = async (req, res) => {
    try {
        const [precheckCount, aiQueueCount, checkedCount] = await Promise.all([
            AddressMasterPrecheck.estimatedDocumentCount(),
            AddressMasterAiQueue.estimatedDocumentCount(),
            AddressMasterChecked.estimatedDocumentCount()
        ]);
        return res.json({ success: true, stats: { precheckCount, aiQueueCount, checkedCount } });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

// GET /precheck/next-block?after=AB10+1AS
// Returns all records for the next available postcode block.
// Optional `after` param skips to the block after that postcode.
const getNextBlock = async (req, res) => {
    try {
        const after = req.query.after || null;

        const postcodeQuery = after
            ? { postcode: { $gt: after } }
            : {};

        // Find the first postcode in precheck collection
        const firstDoc = await AddressMasterPrecheck.findOne(postcodeQuery)
            .sort({ postcode: 1, _id: 1 })
            .select({ postcode: 1 })
            .lean();

        if (!firstDoc) {
            return res.json({ success: true, done: true, message: 'No more blocks in precheck' });
        }

        const postcode = firstDoc.postcode;
        const records  = await AddressMasterPrecheck.find({ postcode })
            .sort({ _id: 1 })
            .lean();

        const formatted = records.map(r => ({
            _id:      String(r._id),
            postcode: r.postcode,
            district: r.district,
            parts:    addressPartsFromDoc(r.address),
            address:  r.address
        }));

        // Detect max column count for this block
        const maxParts = Math.max(...formatted.map(r => r.parts.length), 0);

        return res.json({
            success: true,
            done:    false,
            postcode,
            district: records[0]?.district || '',
            recordCount: records.length,
            maxParts,
            records: formatted
        });
    } catch (error) {
        rmAddressLogger.error(`getNextBlock failed: ${error.message}`);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// POST /precheck/block/:postcode/approve
// Move entire block to address_master_checked (OK button)
const approveBlock = async (req, res) => {
    try {
        const postcode = decodeURIComponent(req.params.postcode);

        const records = await AddressMasterPrecheck.find({ postcode }).lean();
        if (!records.length) {
            return res.status(404).json({ success: false, message: 'Block not found' });
        }

        const getDate = () => {
            const now = new Date();
            return `${String(now.getDate()).padStart(2,'0')}/${String(now.getMonth()+1).padStart(2,'0')}/${now.getFullYear()}`;
        };

        const ops = records.map(r => ({
            updateOne: {
                filter: { postcode: r.postcode, address: r.address },
                update: { $set: {
                    postcode:          r.postcode,
                    district:          r.district,
                    address:           r.address,
                    dateCreated:       r.dateCreated || getDate(),
                    correctionVersion: r.correctionVersion || 'v1',
                    sourceType:        'precheck_ok'
                }},
                upsert: true
            }
        }));

        await AddressMasterChecked.bulkWrite(ops, { ordered: false });
        await AddressMasterPrecheck.deleteMany({ postcode });

        rmAddressLogger.info(`Precheck approved: ${postcode} (${records.length} records) → address_master_checked`);

        // Return next block in the same response so UI doesn't need a second call
        const nextDoc = await AddressMasterPrecheck.findOne({ postcode: { $gt: postcode } })
            .sort({ postcode: 1, _id: 1 }).select({ postcode: 1 }).lean();

        return res.json({
            success:     true,
            moved:       records.length,
            destination: 'address_master_checked',
            nextPostcode: nextDoc?.postcode || null
        });
    } catch (error) {
        rmAddressLogger.error(`approveBlock failed: ${error.message}`);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// POST /precheck/block/:postcode/move-to-ai
// Move entire block to address_master_ai_queue (MOVE to AI button)
const moveBlockToAi = async (req, res) => {
    try {
        const postcode = decodeURIComponent(req.params.postcode);

        const records = await AddressMasterPrecheck.find({ postcode }).lean();
        if (!records.length) {
            return res.status(404).json({ success: false, message: 'Block not found' });
        }

        const ops = records.map(r => ({
            updateOne: {
                filter: { postcode: r.postcode, address: r.address },
                update: { $set: {
                    postcode:          r.postcode,
                    district:          r.district,
                    address:           r.address,
                    dateCreated:       r.dateCreated,
                    correctionVersion: r.correctionVersion || 'v1'
                }},
                upsert: true
            }
        }));

        await AddressMasterAiQueue.bulkWrite(ops, { ordered: false });
        await AddressMasterPrecheck.deleteMany({ postcode });

        rmAddressLogger.info(`Precheck moved to AI: ${postcode} (${records.length} records) → address_master_ai_queue`);

        const nextDoc = await AddressMasterPrecheck.findOne({ postcode: { $gt: postcode } })
            .sort({ postcode: 1, _id: 1 }).select({ postcode: 1 }).lean();

        return res.json({
            success:      true,
            moved:        records.length,
            destination:  'address_master_ai_queue',
            nextPostcode: nextDoc?.postcode || null
        });
    } catch (error) {
        rmAddressLogger.error(`moveBlockToAi failed: ${error.message}`);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// POST /precheck/block/:postcode/swap
// Swap two column positions across all records in the block, then reload same block.
// Body: { colA: 1, colB: 2 }  (1-indexed, matching what the UI shows)
const swapColumns = async (req, res) => {
    try {
        const postcode = decodeURIComponent(req.params.postcode);
        const { colA, colB } = req.body || {};

        if (colA === undefined || colB === undefined || colA === colB) {
            return res.status(400).json({ success: false, message: 'Provide two different column numbers to swap' });
        }

        const idxA = parseInt(colA) - 1;  // convert to 0-indexed
        const idxB = parseInt(colB) - 1;

        if (idxA < 0 || idxB < 0) {
            return res.status(400).json({ success: false, message: 'Column numbers must be 1 or higher' });
        }

        const records = await AddressMasterPrecheck.find({ postcode }).lean();
        if (!records.length) {
            return res.status(404).json({ success: false, message: 'Block not found' });
        }

        const ops = [];
        let swappedCount = 0;

        for (const record of records) {
            const parts = addressPartsFromDoc(record.address);

            // Only swap if both indices exist in this record
            if (idxA >= parts.length || idxB >= parts.length) continue;

            const newParts  = [...parts];
            const temp      = newParts[idxA];
            newParts[idxA]  = newParts[idxB];
            newParts[idxB]  = temp;

            ops.push({
                updateOne: {
                    filter: { _id: record._id },
                    update: { $set: {
                        address:           JSON.stringify(newParts),
                        correctionVersion: 'v1-precheck-swapped'
                    }}
                }
            });
            swappedCount++;
        }

        if (ops.length) {
            await AddressMasterPrecheck.bulkWrite(ops, { ordered: false });
        }

        rmAddressLogger.info(`Precheck swap col${colA}↔col${colB} on ${postcode}: ${swappedCount} records updated`);

        // Reload same block and return it — UI stays on this block
        const updated = await AddressMasterPrecheck.find({ postcode })
            .sort({ _id: 1 })
            .lean();

        const formatted = updated.map(r => ({
            _id:      String(r._id),
            postcode: r.postcode,
            district: r.district,
            parts:    addressPartsFromDoc(r.address),
            address:  r.address
        }));

        const maxParts = Math.max(...formatted.map(r => r.parts.length), 0);

        return res.json({
            success:      true,
            swappedCount,
            postcode,
            district:    updated[0]?.district || '',
            recordCount: updated.length,
            maxParts,
            records:     formatted
        });
    } catch (error) {
        rmAddressLogger.error(`swapColumns failed: ${error.message}`);
        return res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    RMAddressPrecheckController: {
        getStats,
        getNextBlock,
        approveBlock,
        moveBlockToAi,
        swapColumns
    }
};