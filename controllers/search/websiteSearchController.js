/**
 * websiteSearchController.js
 * Dedicated controller for Websites search (website_postcode: 689k docs).
 */

const mongoose = require('mongoose');
const WebsitePostcode = require('../../models/WebsitePostcode');
const {
    SEARCH_LIMIT,
    MAX_TIME_MS,
    normalizeSearchPostcode,
    encodeCursorToken,
    decodeCursorToken,
    usageBlock,
} = require('./searchHelper');

function formatWebsitePostcode(d) {
    return {
        url: d.url || null,
        postcode: d.postcode || null,
        date: d.date || null
    };
}

const searchWebsites = async (req, res) => {
    try {
        const { q = '', type = 'all', cursor, limit } = req.query;
        const term = q.trim();
        if (!term || term.length < 2) {
            return res.status(400).json({ success: false, message: 'Query must be at least 2 characters.' });
        }

        const lim = Math.min(parseInt(limit, 10) || SEARCH_LIMIT, SEARCH_LIMIT);
        let query = {};

        if (type === 'postcode') {
            const normPc = normalizeSearchPostcode(term);
            const fullPostcodeRegex = /^[A-Z]{1,2}[0-9][A-Z0-9]?\s[0-9][A-Z]{2}$/;
            if (fullPostcodeRegex.test(normPc)) {
                query.postcode = normPc;
            } else {
                query = {
                    $or: [
                        { postcode: normPc },
                        { postcode: { $gte: normPc, $lt: normPc + '\uffff' } }
                    ]
                };
            }
        } else if (type === 'url') {
            const clean = term.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '').toLowerCase();
            query = {
                $or: [
                    { url: clean },
                    { url: term.toLowerCase() },
                    { url: { $gte: clean, $lt: clean + '\uffff' } }
                ]
            };
        } else {
            // 'all': multi-field query
            const clean = term.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '').toLowerCase();
            const normPc = normalizeSearchPostcode(term);
            const conditions = [];

            // Postcode condition (uses postcode_1)
            if (normPc && normPc.length >= 2) {
                conditions.push(
                    { postcode: normPc },
                    { postcode: { $gte: normPc, $lt: normPc + '\uffff' } }
                );
            }

            // URL condition (uses url_1_postcode_1_date_1)
            conditions.push(
                { url: clean },
                { url: { $gte: clean, $lt: clean + '\uffff' } }
            );

            query = { $or: conditions };
        }

        if (cursor) {
            const cursorId = typeof decodeCursorToken(cursor) === 'object' ? decodeCursorToken(cursor)?._id : decodeCursorToken(cursor);
            if (cursorId && mongoose.isValidObjectId(cursorId)) {
                query._id = { $gt: new mongoose.Types.ObjectId(cursorId) };
            }
        }

        const projection = {
            url: 1,
            postcode: 1,
            date: 1,
            _id: 1
        };

        const cursorRows = await WebsitePostcode
            .find(query, projection)
            .sort({ _id: 1 })
            .limit(lim + 1)
            .maxTimeMS(MAX_TIME_MS)
            .lean();

        const hasNextPage = cursorRows.length > lim;
        const rows = hasNextPage ? cursorRows.slice(0, lim) : cursorRows;
        const data = rows.map(formatWebsitePostcode);
        const nextCursor = hasNextPage && rows[rows.length - 1] ? encodeCursorToken({ _id: String(rows[rows.length - 1]._id) }) : null;

        return res.json({
            success: true,
            db: 'website_postcode',
            count: data.length,
            data,
            cursor: nextCursor,
            usage: usageBlock(req),
        });
    } catch (err) {
        console.error('[searchWebsites]', err.message);
        if (err.message && (err.message.includes('exceeded time limit') || err.message.includes('buffering timed out'))) {
            return res.status(504).json({
                success: false,
                error: 'Search timed out. Try refining your search query or selecting a specific field.',
            });
        }
        return res.status(500).json({ success: false, error: err.message });
    }
};

module.exports = {
    searchWebsites,
};
