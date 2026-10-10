/**
 * screenshotSearchController.js
 * Dedicated controller for Screenshot URL search (screenshot_urls: 17M+ docs).
 */

const mongoose = require('mongoose');
const ScreenshotUrl = require('../../models/ScreenshotUrl');
const {
    SEARCH_LIMIT,
    MAX_TIME_MS,
    encodeCursorToken,
    decodeCursorToken,
    usageBlock,
} = require('./searchHelper');

const searchScreenshot = async (req, res) => {
    try {
        const { q = '', cursor, limit } = req.query;
        const term = q.trim();
        if (!term || term.length < 2) {
            return res.status(400).json({ success: false, message: 'Query must be at least 2 characters.' });
        }

        const lim = Math.min(parseInt(limit, 10) || SEARCH_LIMIT, SEARCH_LIMIT);

        // Normalize URL queries (support bare domains, with or without http/https/www)
        const clean = term.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '').trim();
        const cleanLower = clean.toLowerCase();

        // Exact candidates list for instant O(1) index lookup across all common URL variants
        const candidates = [
            term,
            term.toLowerCase(),
            clean,
            cleanLower,
            `http://${clean}`,
            `http://${cleanLower}`,
            `https://${clean}`,
            `https://${cleanLower}`,
            `http://www.${clean}`,
            `http://www.${cleanLower}`,
            `https://www.${clean}`,
            `https://www.${cleanLower}`,
            `http://${clean}/`,
            `http://${cleanLower}/`,
            `https://${clean}/`,
            `https://${cleanLower}/`,
            `http://www.${clean}/`,
            `http://www.${cleanLower}/`,
            `https://www.${clean}/`,
            `https://www.${cleanLower}/`,
        ];
        const variants = [...new Set(candidates)];

        // 1. First attempt instant index point lookup with variants (exclude blacklisted)
        let query = { url: { $in: variants }, is_blacklisted: { $ne: true } };

        if (cursor) {
            const cursorId = typeof decodeCursorToken(cursor) === 'object' ? decodeCursorToken(cursor)?._id : decodeCursorToken(cursor);
            if (cursorId && mongoose.isValidObjectId(cursorId)) {
                query._id = { $gt: new mongoose.Types.ObjectId(cursorId) };
            }
        }

        let cursorRows = await ScreenshotUrl
            .find(query, { url: 1, image: 1, _id: 1 })
            .sort({ url: 1, image: 1 })
            .limit(lim + 1)
            .maxTimeMS(MAX_TIME_MS)
            .lean();

        // 2. If no exact match and query is a prefix/partial search (e.g. "043" or "b-m"),
        // perform pure B-Tree index range scans (exclude blacklisted)
        if (cursorRows.length === 0 && !cursor) {
            const prefixConditions = [
                { url: { $gte: `http://${cleanLower}`, $lt: `http://${cleanLower}\uffff` } },
                { url: { $gte: `https://${cleanLower}`, $lt: `https://${cleanLower}\uffff` } },
                { url: { $gte: `http://www.${cleanLower}`, $lt: `http://www.${cleanLower}\uffff` } },
                { url: { $gte: `https://www.${cleanLower}`, $lt: `https://www.${cleanLower}\uffff` } },
                { url: { $gte: cleanLower, $lt: `${cleanLower}\uffff` } },
            ];

            cursorRows = await ScreenshotUrl
                .find({ $and: [{ $or: prefixConditions }, { is_blacklisted: { $ne: true } }] }, { url: 1, image: 1, _id: 1 })
                .sort({ url: 1, image: 1 })
                .limit(lim + 1)
                .maxTimeMS(MAX_TIME_MS)
                .lean();
        }

        const hasNextPage = cursorRows.length > lim;
        const rows = hasNextPage ? cursorRows.slice(0, lim) : cursorRows;

        const data = rows.map(d => {
            const rawImg = d.image || '';
            const slashIdx = rawImg.indexOf('/');
            const bucket = slashIdx !== -1 ? rawImg.substring(0, slashIdx) : 'img1';
            const filename = slashIdx !== -1 ? rawImg.substring(slashIdx + 1) : rawImg;

            return {
                url: d.url,
                bucket,
                filename,
                image: rawImg,
            };
        });

        const nextCursor = hasNextPage && rows[rows.length - 1] ? encodeCursorToken({ _id: String(rows[rows.length - 1]._id) }) : null;

        return res.json({
            success: true,
            db: 'screenshot_url',
            count: data.length,
            data,
            cursor: nextCursor,
            usage: usageBlock(req),
        });
    } catch (err) {
        console.error('[searchScreenshot]', err.message);
        if (err.message && (err.message.includes('exceeded time limit') || err.message.includes('buffering timed out'))) {
            return res.status(504).json({
                success: false,
                error: 'Search timed out. Try refining the domain or URL.',
            });
        }
        return res.status(500).json({ success: false, error: err.message });
    }
};

module.exports = {
    searchScreenshot,
};
