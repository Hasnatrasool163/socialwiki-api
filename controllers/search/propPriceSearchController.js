/**
 * propPriceSearchController.js
 * Dedicated controller for UK Property Price search (prop_price: 31M+ docs).
 */

const mongoose = require('mongoose');
const PropPrice = require('../../models/PropPrice');
const {
    SEARCH_LIMIT,
    MAX_TIME_MS,
    naturalCompare,
    normalizeSearchPostcode,
    encodeCursorToken,
    decodeCursorToken,
    usageBlock,
} = require('./searchHelper');

const searchPropPrice = async (req, res) => {
    try {
        const { q = '', type = 'postcode', cursor, limit } = req.query;
        const term = q.trim();
        if (!term || term.length < 2) {
            return res.status(400).json({ success: false, message: 'Query must be at least 2 characters.' });
        }

        const lim = Math.min(parseInt(limit, 10) || SEARCH_LIMIT, SEARCH_LIMIT);

        let query = {};
        let sortStage = { _id: 1 };
        const isPostcodeQuery = (type === 'postcode');

        if (isPostcodeQuery) {
            const normalized = normalizeSearchPostcode(term);
            const fullPostcodeRegex = /^[A-Z]{1,2}[0-9][A-Z0-9]?\s[0-9][A-Z]{2}$/;

            if (fullPostcodeRegex.test(normalized)) {
                query.postcode = normalized;
            } else {
                query.postcode = { $gte: normalized, $lt: `${normalized}\uffff` };
            }

            // Matches compound index { postcode: 1, deed_date: -1 }
            sortStage = { postcode: 1, deed_date: -1, _id: 1 };

            if (cursor) {
                const cursorData = decodeCursorToken(cursor);
                if (cursorData?.postcode && cursorData?._id) {
                    query.$or = [
                        { postcode: { $gt: cursorData.postcode } },
                        { postcode: cursorData.postcode, _id: { $gt: new mongoose.Types.ObjectId(cursorData._id) } }
                    ];
                } else if (mongoose.isValidObjectId(cursor)) {
                    query._id = { $gt: new mongoose.Types.ObjectId(cursor) };
                }
            }
        } else {
            const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            query.address_display = { $regex: escaped, $options: 'i' };

            if (cursor) {
                const cursorId = typeof decodeCursorToken(cursor) === 'object' ? decodeCursorToken(cursor)?._id : decodeCursorToken(cursor);
                if (cursorId && mongoose.isValidObjectId(cursorId)) {
                    query._id = { $gt: new mongoose.Types.ObjectId(cursorId) };
                }
            }
            sortStage = { _id: 1 };
        }

        const cursorRows = await PropPrice
            .find(query, {
                address_display: 1, postcode: 1, price_paid: 1,
                deed_date: 1, property_type: 1, new_build: 1,
                town: 1, district: 1, county: 1, _id: 1,
            })
            .sort(sortStage)
            .limit(lim + 1)
            .maxTimeMS(MAX_TIME_MS)
            .lean();

        const hasNextPage = cursorRows.length > lim;
        const rows = hasNextPage ? cursorRows.slice(0, lim) : cursorRows;

        const data = rows.sort((a, b) => {
            if (a.postcode !== b.postcode) {
                return naturalCompare(a.postcode, b.postcode);
            }
            return naturalCompare(a.address_display, b.address_display);
        });

        const lastRow = rows[rows.length - 1] || null;
        const nextCursor = hasNextPage && lastRow
            ? (isPostcodeQuery
                ? encodeCursorToken({ postcode: lastRow.postcode, _id: String(lastRow._id) })
                : encodeCursorToken({ _id: String(lastRow._id) }))
            : null;

        return res.json({
            success: true,
            db: 'prop_price',
            count: data.length,
            data: data.map(d => ({
                address: d.address_display,
                postcode: d.postcode,
                price: d.price_paid,
                date: d.deed_date ? new Date(d.deed_date).toLocaleDateString('en-GB') : null,
                property_type: d.property_type,
                new_build: d.new_build,
                town: d.town,
                district: d.district,
                county: d.county,
            })),
            cursor: nextCursor,
            usage: usageBlock(req),
        });
    } catch (err) {
        console.error('[searchPropPrice]', err.message);
        if (err.message && (err.message.includes('exceeded time limit') || err.message.includes('buffering timed out'))) {
            return res.status(504).json({
                success: false,
                error: 'Search timed out. Searching by Postcode is instant, or include a postcode prefix.',
            });
        }
        return res.status(500).json({ success: false, error: err.message });
    }
};

module.exports = {
    searchPropPrice,
};
