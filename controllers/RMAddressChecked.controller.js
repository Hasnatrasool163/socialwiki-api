const AddressMasterChecked  = require('../models/AddressMasterChecked');
const AddressMasterPrecheck = require('../models/AddressMasterPrecheck');
const rmAddressLogger       = require('../config/loggers/rmAddressLogger');
const { addressPartsFromDoc, normalizePostcode } = require('../utils/addressParts');

// GET /checked/search?postcode=AB12+3BE
// Exact-postcode lookup against address_master_checked.
// Uses the postcode_1__id_1 index for both the filter and the sort..
const searchBlock = async (req, res) => {
    try {
        const rawPostcode = req.query.postcode || '';
        const postcode = normalizePostcode(rawPostcode);

        if (!postcode) {
            return res.status(400).json({ success: false, message: 'postcode is required' });
        }

        const records = await AddressMasterChecked.find({ postcode })
            .sort({ _id: 1 })
            .lean();

        if (!records.length) {
            return res.json({
                success: true,
                found: false,
                postcode,
                message: 'No checked records found for this postcode'
            });
        }

        const formatted = records.map(r => ({
            _id:               String(r._id),
            postcode:          r.postcode,
            district:          r.district,
            parts:             addressPartsFromDoc(r.address),
            address:           r.address,
            correctionVersion: r.correctionVersion || '',
            sourceType:        r.sourceType || ''
        }));

        const maxParts = Math.max(...formatted.map(r => r.parts.length), 0);

        return res.json({
            success:     true,
            found:       true,
            postcode,
            district:    records[0]?.district || '',
            recordCount: records.length,
            maxParts,
            records:     formatted
        });
    } catch (error) {
        rmAddressLogger.error(`checked searchBlock failed: ${error.message}`);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// DELETE /checked/record/:id
// Deletes one bad/duplicate record from address_master_checked, then moves
// every OTHER remaining record for that same postcode back into
// address_master_precheck for re-review. A delete here is never a partial
// action — the rest of the block is never left behind in "checked" alone.
const deleteRecordAndRecycle = async (req, res) => {
    try {
        const { id } = req.params;

        const record = await AddressMasterChecked.findById(id).lean();
        if (!record) {
            return res.status(404).json({ success: false, message: 'Record not found' });
        }

        const postcode = record.postcode;

        // Remove only the flagged record first
        await AddressMasterChecked.deleteOne({ _id: id });

        // Everything else still in checked for this postcode goes back to precheck
        const remaining = await AddressMasterChecked.find({ postcode }).lean();

        let recycledCount = 0;
        let duplicateSkipped = 0;

        if (remaining.length) {
            const ops = remaining.map(r => ({
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

            const bulkResult = await AddressMasterPrecheck.bulkWrite(ops, { ordered: false })
                .catch(err => err); 

        
            if (bulkResult && bulkResult.writeErrors && bulkResult.writeErrors.length) {
                duplicateSkipped = bulkResult.writeErrors.length;
                rmAddressLogger.warn(
                    `Checked recycle: ${duplicateSkipped} record(s) for ${postcode} hit a duplicate-key conflict moving to precheck — check manually.`
                );
            }

            const remainingIds = remaining.map(r => r._id);
            await AddressMasterChecked.deleteMany({ _id: { $in: remainingIds } });
            recycledCount = remaining.length;
        }

        rmAddressLogger.info(
            `Checked delete+recycle: ${id} removed, ${recycledCount} remaining record(s) for ${postcode} moved back to precheck` +
            (duplicateSkipped ? ` (${duplicateSkipped} had duplicate-key conflicts)` : '')
        );

        return res.json({
            success:         true,
            deletedId:       id,
            postcode,
            recycledCount,
            duplicateSkipped
        });
    } catch (error) {
        rmAddressLogger.error(`deleteRecordAndRecycle failed: ${error.message}`);
        return res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    RMAddressCheckedController: {
        searchBlock,
        deleteRecordAndRecycle
    }
};
