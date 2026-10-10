/**
 * companySearchController.js
 * Dedicated controller for Companies House search (ch_data: 5.6M+ docs).
 */

const mongoose = require('mongoose');
const ChData = mongoose.models.ChData ||
    mongoose.model('ChData', new mongoose.Schema({}, {
        strict: false,
        collection: 'ch_data',
        versionKey: false,
    }));

const {
    SEARCH_LIMIT,
    MAX_TIME_MS,
    naturalCompare,
    normalizeSearchPostcode,
    encodeCursorToken,
    decodeCursorToken,
    usageBlock,
} = require('./searchHelper');

function formatCompany(d) {
    const line1 = d['RegAddress.AddressLine1'] || d.RegAddress?.AddressLine1 || d.AddressLine1 || '';
    const line2 = d['RegAddress.AddressLine2'] || d.RegAddress?.AddressLine2 || d.AddressLine2 || '';
    const town = d['RegAddress.PostTown'] || d.RegAddress?.PostTown || d.PostTown || '';
    const pc = d['RegAddress.PostCode'] || d.RegAddress?.PostCode || d.PostCode || '';

    const parts = [line1, line2, town, pc].filter(Boolean);

    return {
        name: d.CompanyName,
        number: d.CompanyNumber,
        address: parts.length > 0 ? parts.join(', ') : null,
        status: d.CompanyStatus,
        incorporated: d.IncorporationDate,
    };
}

const searchCompany = async (req, res) => {
    try {
        const { q = '', type = 'name', cursor, limit } = req.query;
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
                query['RegAddress.PostCode'] = normalized;
            } else {
                query['RegAddress.PostCode'] = { $gte: normalized, $lt: `${normalized}\uffff` };
            }

            sortStage = { 'RegAddress.PostCode': 1, _id: 1 };

            if (cursor) {
                const cursorId = typeof decodeCursorToken(cursor) === 'object' ? decodeCursorToken(cursor)?._id : decodeCursorToken(cursor);
                if (cursorId && mongoose.isValidObjectId(cursorId)) {
                    query._id = { $gt: new mongoose.Types.ObjectId(cursorId) };
                }
            }
        } else {
            // Check if text search is ready
            try {
                const textQuery = { $text: { $search: term } };
                if (cursor) {
                    const cursorId = typeof decodeCursorToken(cursor) === 'object' ? decodeCursorToken(cursor)?._id : decodeCursorToken(cursor);
                    if (cursorId && mongoose.isValidObjectId(cursorId)) {
                        textQuery._id = { $gt: new mongoose.Types.ObjectId(cursorId) };
                    }
                }

                const cursorRows = await ChData
                    .find(textQuery, { score: { $meta: 'textScore' } })
                    .sort({ score: { $meta: 'textScore' }, _id: 1 })
                    .limit(lim + 1)
                    .maxTimeMS(MAX_TIME_MS)
                    .lean();

                const hasNextPage = cursorRows.length > lim;
                const rows = hasNextPage ? cursorRows.slice(0, lim) : cursorRows;
                const data = rows.sort((a, b) => naturalCompare(a.CompanyName, b.CompanyName));
                const nextCursor = hasNextPage && rows[rows.length - 1] ? encodeCursorToken({ _id: String(rows[rows.length - 1]._id) }) : null;

                return res.json({
                    success: true,
                    db: 'ch_data',
                    count: data.length,
                    data: data.map(formatCompany),
                    cursor: nextCursor,
                    usage: usageBlock(req),
                });
            } catch (textErr) {
                // Text index fallback: prefix match with anchored regex if text index is not yet built
                const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                query = {
                    $or: [
                        { CompanyName: { $regex: `^${escaped}`, $options: 'i' } },
                        { CompanyNumber: term.trim() }
                    ]
                };
                if (cursor) {
                    const cursorId = typeof decodeCursorToken(cursor) === 'object' ? decodeCursorToken(cursor)?._id : decodeCursorToken(cursor);
                    if (cursorId && mongoose.isValidObjectId(cursorId)) {
                        query._id = { $gt: new mongoose.Types.ObjectId(cursorId) };
                    }
                }
                sortStage = { _id: 1 };
            }
        }

        const cursorRows = await ChData
            .find(query)
            .sort(sortStage)
            .limit(lim + 1)
            .maxTimeMS(MAX_TIME_MS)
            .lean();

        const hasNextPage = cursorRows.length > lim;
        const rows = hasNextPage ? cursorRows.slice(0, lim) : cursorRows;
        const data = rows.sort((a, b) => naturalCompare(a.CompanyName, b.CompanyName));
        const nextCursor = hasNextPage && rows[rows.length - 1] ? encodeCursorToken({ _id: String(rows[rows.length - 1]._id) }) : null;

        return res.json({
            success: true,
            db: 'ch_data',
            count: data.length,
            data: data.map(formatCompany),
            cursor: nextCursor,
            usage: usageBlock(req),
        });
    } catch (err) {
        console.error('[searchCompany]', err.message);
        if (err.message && (err.message.includes('exceeded time limit') || err.message.includes('buffering timed out'))) {
            return res.status(504).json({
                success: false,
                error: 'Search timed out. Try searching by Postcode or refine the company name.',
            });
        }
        return res.status(500).json({ success: false, error: err.message });
    }
};

module.exports = {
    searchCompany,
};
