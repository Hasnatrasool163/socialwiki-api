/**
 * SearchController.js
 *
 * Optimized high-performance handlers for the public search API.
 * Uses index-aligned prefix range scans ($gte / $lt: \uffff) on 36M+ doc collections
 * matching the composite indexes, preventing catastrophic full collection scans.
 *
 * Natural sort is applied in-memory on the returned page (up to 50 docs).
 */

const mongoose = require('mongoose');

// Models
const AddressMasterMerged = require('../models/AddressMasterMerged');
const PropPrice           = require('../models/PropPrice');
const ScreenshotUrl       = require('../models/ScreenshotUrl');
const SocialScrape        = require('../models/SocialScrape');
const FoundBusiness       = require('../models/FoundBusiness');
const WebsitePostcode     = require('../models/WebsitePostcode');
const ChData = mongoose.models.ChData ||
    mongoose.model('ChData', new mongoose.Schema({}, {
        strict: false,
        collection: 'ch_data',
        versionKey: false,
    }));

const SEARCH_LIMIT = 50;
const MAX_TIME_MS  = 10000; // 10s timeout guard

// ── Helpers ────────────────────────────────────────────────────────────────

function naturalCompare(a, b) {
    return String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Normalizes UK postcode to uppercase with standardized spacing
 */
function normalizeSearchPostcode(value) {
    if (!value) return '';
    let clean = value.toString().trim().toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ');
    if (!clean) return '';
    const continuousText = clean.replace(/\s/g, '');
    const fullPostcodeNoSpaceRegex = /^([A-Z]{1,2}[0-9][A-Z0-9]?)([0-9][A-Z]{2})$/;
    if (fullPostcodeNoSpaceRegex.test(continuousText)) {
        return continuousText.replace(fullPostcodeNoSpaceRegex, '$1 $2');
    }
    return clean;
}

function encodeCursorToken(payload) {
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function decodeCursorToken(cursor) {
    if (!cursor) return null;
    try {
        const decoded = JSON.parse(Buffer.from(String(cursor), 'base64').toString('utf8'));
        if (!decoded || typeof decoded !== 'object') return null;
        return decoded;
    } catch {
        return null;
    }
}

function usageBlock(req) {
    return req.searchUsage || null;
}

// ── 1. RM Address search (address_master_merged: 36M+ docs) ────────────────

const searchRmAddress = async (req, res) => {
    try {
        const { q = '', type = 'postcode', cursor, limit } = req.query;
        const term = q.trim();
        if (!term || term.length < 2) {
            return res.status(400).json({ success: false, message: 'Query must be at least 2 characters.' });
        }

        const lim = Math.min(parseInt(limit, 10) || SEARCH_LIMIT, SEARCH_LIMIT);

        let query = {};
        let sortStage = { _id: 1 };
        let isPostcodeQuery = (type === 'postcode');

        if (isPostcodeQuery) {
            const normalized = normalizeSearchPostcode(term);
            const fullPostcodeRegex = /^[A-Z]{1,2}[0-9][A-Z0-9]?\s[0-9][A-Z]{2}$/;

            if (fullPostcodeRegex.test(normalized)) {
                query.postcode = normalized;
            } else {
                // B-Tree prefix range query: hits postcode_1__id_1 index directly!
                query.postcode = { $gte: normalized, $lt: `${normalized}\uffff` };
            }

            sortStage = { postcode: 1, _id: 1 };

            // Keyset cursor pagination
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
            // Try full-text search on address if text index exists
            try {
                const textQuery = { $text: { $search: term } };
                if (cursor && mongoose.isValidObjectId(cursor)) {
                    textQuery._id = { $gt: new mongoose.Types.ObjectId(cursor) };
                }

                const cursorRows = await AddressMasterMerged
                    .find(textQuery, {
                        postcode: 1, district: 1, address: 1, _id: 1,
                        score: { $meta: 'textScore' }
                    })
                    .sort({ score: { $meta: 'textScore' }, _id: 1 })
                    .limit(lim + 1)
                    .maxTimeMS(MAX_TIME_MS)
                    .lean();

                const hasNextPage = cursorRows.length > lim;
                const rows = hasNextPage ? cursorRows.slice(0, lim) : cursorRows;
                const data = rows.sort((a, b) => naturalCompare(a.address, b.address));
                const nextCursor = hasNextPage && rows[rows.length - 1] ? String(rows[rows.length - 1]._id) : null;

                return res.json({
                    success: true,
                    db: 'rm_address',
                    count: data.length,
                    data: data.map(d => ({ postcode: d.postcode, district: d.district, address: d.address })),
                    cursor: nextCursor,
                    usage: usageBlock(req),
                });
            } catch (textErr) {
                // Text index not present — fall back to regex scan
                const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                query.address = { $regex: escaped, $options: 'i' };

                if (cursor && mongoose.isValidObjectId(cursor)) {
                    query._id = { $gt: new mongoose.Types.ObjectId(cursor) };
                }
                sortStage = { _id: 1 };
            }
        }

        const cursorRows = await AddressMasterMerged
            .find(query, { postcode: 1, district: 1, address: 1, _id: 1 })
            .sort(sortStage)
            .limit(lim + 1)
            .maxTimeMS(MAX_TIME_MS)
            .lean();

        const hasNextPage = cursorRows.length > lim;
        const rows = hasNextPage ? cursorRows.slice(0, lim) : cursorRows;

        // Natural sort: postcode first, then address (numeric: Cottage 1, Cottage 2, Cottage 10)
        const data = rows.sort((a, b) => {
            if (a.postcode !== b.postcode) {
                return naturalCompare(a.postcode, b.postcode);
            }
            return naturalCompare(a.address, b.address);
        });

        const lastRow = rows[rows.length - 1] || null;
        const nextCursor = hasNextPage && lastRow
            ? (isPostcodeQuery
                ? encodeCursorToken({ postcode: lastRow.postcode, _id: String(lastRow._id) })
                : String(lastRow._id))
            : null;

        return res.json({
            success: true,
            db: 'rm_address',
            count: data.length,
            data: data.map(d => ({ postcode: d.postcode, district: d.district, address: d.address })),
            cursor: nextCursor,
            usage: usageBlock(req),
        });
    } catch (err) {
        console.error('[searchRmAddress]', err.message);
        if (err.message && (err.message.includes('exceeded time limit') || err.message.includes('buffering timed out'))) {
            return res.status(504).json({
                success: false,
                error: 'Search timed out. Searching by Postcode is instant, or include a postcode prefix (e.g. "W1", "DD9").',
            });
        }
        return res.status(500).json({ success: false, error: err.message });
    }
};

// ── 2. Property Price search (prop_price: 31M+ docs) ───────────────────────

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

            if (cursor && mongoose.isValidObjectId(cursor)) {
                query._id = { $gt: new mongoose.Types.ObjectId(cursor) };
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
                : String(lastRow._id))
            : null;

        return res.json({
            success: true,
            db: 'prop_price',
            count: data.length,
            data: data.map(d => ({
                address:       d.address_display,
                postcode:      d.postcode,
                price:         d.price_paid,
                date:          d.deed_date ? new Date(d.deed_date).toLocaleDateString('en-GB') : null,
                property_type: d.property_type,
                new_build:     d.new_build,
                town:          d.town,
                district:      d.district,
                county:        d.county,
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

// ── 3. Companies House (ch_data: 5.6M+ docs) ───────────────────────────────

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

            if (cursor && mongoose.isValidObjectId(cursor)) {
                query._id = { $gt: new mongoose.Types.ObjectId(cursor) };
            }
        } else {
            // Check if text search is ready
            try {
                const textQuery = { $text: { $search: term } };
                if (cursor && mongoose.isValidObjectId(cursor)) {
                    textQuery._id = { $gt: new mongoose.Types.ObjectId(cursor) };
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
                const nextCursor = hasNextPage && rows[rows.length - 1] ? String(rows[rows.length - 1]._id) : null;

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
                if (cursor && mongoose.isValidObjectId(cursor)) {
                    query._id = { $gt: new mongoose.Types.ObjectId(cursor) };
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
        const nextCursor = hasNextPage && rows[rows.length - 1] ? String(rows[rows.length - 1]._id) : null;

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

function formatCompany(d) {
    const line1 = d['RegAddress.AddressLine1'] || d.RegAddress?.AddressLine1 || d.AddressLine1 || '';
    const line2 = d['RegAddress.AddressLine2'] || d.RegAddress?.AddressLine2 || d.AddressLine2 || '';
    const town  = d['RegAddress.PostTown']     || d.RegAddress?.PostTown     || d.PostTown     || '';
    const pc    = d['RegAddress.PostCode']     || d.RegAddress?.PostCode     || d.PostCode     || '';

    const parts = [line1, line2, town, pc].filter(Boolean);

    return {
        name:         d.CompanyName,
        number:       d.CompanyNumber,
        address:      parts.length > 0 ? parts.join(', ') : null,
        status:       d.CompanyStatus,
        incorporated: d.IncorporationDate,
    };
}

// ── 4. Website Screenshots search (screenshot_urls: 17M+ docs) ─────────────

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

        if (cursor && mongoose.isValidObjectId(cursor)) {
            query._id = { $gt: new mongoose.Types.ObjectId(cursor) };
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

        const nextCursor = hasNextPage && rows[rows.length - 1] ? String(rows[rows.length - 1]._id) : null;

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

function formatSocialScrape(d) {
    let phones = [];
    if (Array.isArray(d.phone)) {
        phones = d.phone.map(p => {
            if (typeof p === 'object' && p !== null) {
                return p.number ? (p.areaName ? `${p.number} (${p.areaName})` : p.number) : null;
            }
            return String(p || '');
        }).filter(Boolean);
    } else if (d.phone) {
        phones = [String(d.phone)];
    }

    return {
        _id: d._id,
        url: d.url,
        date: d.date,
        email: d.email || null,
        postcode: d.postcode || null,
        phone: phones,
        twitter: d.twitter || null,
        facebook: d.facebook || null,
        instagram: d.instagram || null,
        linkedin: d.linkedin || null,
        pinterest: d.pinterest || null,
        youtube: d.youtube || null,
    };
}

// ── 5. Social Scrapes search (socialscrapes: 85M docs) ─────────────────────

const searchSocialScrape = async (req, res) => {
    try {
        const { q = '', type = 'all', cursor, limit } = req.query;
        const term = q.trim();
        if (!term || term.length < 2) {
            return res.status(400).json({ success: false, message: 'Query must be at least 2 characters.' });
        }

        const lim = Math.min(parseInt(limit, 10) || SEARCH_LIMIT, SEARCH_LIMIT);
        let query = {};

        if (type === 'url') {
            const clean = term.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
            query = {
                $or: [
                    { url: clean },
                    { url: term },
                    { url: { $gte: clean, $lt: clean + '\uffff' } }
                ]
            };
        } else if (type === 'phone') {
            const digits = term.replace(/\D/g, '');
            const cleanPhone = term.replace(/[^0-9+]/g, '');
            let ukPhone = digits;
            if (digits.startsWith('44') && digits.length >= 10) {
                ukPhone = '0' + digits.slice(2);
            }
            if (digits.length === 10 && !digits.startsWith('0') && !digits.startsWith('44')) {
                ukPhone = '0' + digits;
            }
            const phoneVariants = [...new Set([cleanPhone, term, digits, ukPhone].filter(p => p && p.length >= 2))];
            const phoneConds = [];
            for (const p of phoneVariants) {
                phoneConds.push(
                    { 'phone.number': p },
                    { phone: { $elemMatch: { number: { $gte: p, $lt: p + '\uffff' } } } }
                );
            }
            query = { $or: phoneConds };
        } else if (type === 'email') {
            const cleanEmail = term.toLowerCase().trim();
            // Direct B-Tree index lookup — O(1) instantaneous scan, avoids 148s text token explosion on .co.uk
            query = {
                $or: [
                    { email: cleanEmail },
                    { email: { $gte: cleanEmail, $lt: cleanEmail + '\uffff' } }
                ]
            };
        } else if (type === 'social') {
            const clean = term.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '').trim();
            const cleanHandle = clean
                .replace(/^(twitter|x|facebook|instagram|linkedin|pinterest|youtube)\.com\/?(in\/|user\/|company\/)?/i, '')
                .replace(/^@/, '')
                .trim();

            const socialSearchTerms = [...new Set([
                term,
                clean,
                cleanHandle,
                `facebook.com/${cleanHandle}`,
                `twitter.com/${cleanHandle}`,
                `instagram.com/${cleanHandle}`,
                `linkedin.com/in/${cleanHandle}`,
                `pinterest.com/${cleanHandle}`,
                `youtube.com/${cleanHandle}`
            ].filter(Boolean))];

            query = {
                $or: [
                    { facebook:  { $in: socialSearchTerms } },
                    { twitter:   { $in: socialSearchTerms } },
                    { instagram: { $in: socialSearchTerms } },
                    { linkedin:  { $in: socialSearchTerms } },
                    { pinterest: { $in: socialSearchTerms } },
                    { youtube:   { $in: socialSearchTerms } },
                    { facebook:  { $gte: `facebook.com/${cleanHandle}`,  $lt: `facebook.com/${cleanHandle}\uffff` } },
                    { twitter:   { $gte: `twitter.com/${cleanHandle}`,   $lt: `twitter.com/${cleanHandle}\uffff` } },
                    { instagram: { $gte: `instagram.com/${cleanHandle}`, $lt: `instagram.com/${cleanHandle}\uffff` } }
                ]
            };
        } else if (type === 'postcode') {
            const normPc = normalizeSearchPostcode(term);
            query = {
                $or: [
                    { postcode: normPc },
                    { postcode: { $gte: normPc, $lt: normPc + '\uffff' } }
                ]
            };
        } else {
            // 'all': smart multi-field B-tree query (hits individual B-tree indexes, no $text required)
            const clean = term.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '').trim();
            const cleanLower = clean.toLowerCase();
            const normPc = normalizeSearchPostcode(term);
            const digitCount = (term.match(/\d/g) || []).length;
            const isPhone = digitCount >= 4 && /^[\d\s+()-]+$/.test(term.trim());

            const conditions = [];

            // 1. Website URL (hits url_1_date_1)
            conditions.push(
                { url: cleanLower },
                { url: { $gte: cleanLower, $lt: cleanLower + '\uffff' } }
            );

            // 2. Postcode (hits postcode_1)
            if (normPc && normPc.length >= 2) {
                conditions.push(
                    { postcode: normPc },
                    { postcode: { $gte: normPc, $lt: normPc + '\uffff' } }
                );
            }

            // 3. Email (hits email_1)
            if (term.includes('@') || cleanLower.includes('.')) {
                conditions.push(
                    { email: cleanLower },
                    { email: { $gte: cleanLower, $lt: cleanLower + '\uffff' } }
                );
            }

            // 4. Phone (hits phone.number_1)
            if (isPhone) {
                const digits = term.replace(/\D/g, '');
                const cleanPhone = term.replace(/[^0-9+]/g, '');
                let ukPhone = digits;
                if (digits.startsWith('44') && digits.length >= 10) {
                    ukPhone = '0' + digits.slice(2);
                }
                if (digits.length === 10 && !digits.startsWith('0') && !digits.startsWith('44')) {
                    ukPhone = '0' + digits;
                }
                const phoneVariants = [...new Set([cleanPhone, term, digits, ukPhone].filter(p => p && p.length >= 2))];
                for (const p of phoneVariants) {
                    conditions.push(
                        { 'phone.number': p },
                        { phone: { $elemMatch: { number: { $gte: p, $lt: p + '\uffff' } } } }
                    );
                }
            }

            // 5. Social handles (hits facebook_1, twitter_1, instagram_1, linkedin_1, pinterest_1, youtube_1)
            const cleanHandle = clean
                .replace(/^(twitter|x|facebook|instagram|linkedin|pinterest|youtube)\.com\/?(in\/|user\/|company\/)?/i, '')
                .replace(/^@/, '')
                .trim();

            const socialSearchTerms = [...new Set([
                term,
                clean,
                cleanHandle,
                `facebook.com/${cleanHandle}`,
                `twitter.com/${cleanHandle}`,
                `instagram.com/${cleanHandle}`,
                `linkedin.com/in/${cleanHandle}`,
                `pinterest.com/${cleanHandle}`,
                `youtube.com/${cleanHandle}`
            ].filter(Boolean))];

            conditions.push(
                { facebook:  { $in: socialSearchTerms } },
                { twitter:   { $in: socialSearchTerms } },
                { instagram: { $in: socialSearchTerms } },
                { linkedin:  { $in: socialSearchTerms } },
                { pinterest: { $in: socialSearchTerms } },
                { youtube:   { $in: socialSearchTerms } },
                { facebook:  { $gte: `facebook.com/${cleanHandle}`,  $lt: `facebook.com/${cleanHandle}\uffff` } },
                { twitter:   { $gte: `twitter.com/${cleanHandle}`,   $lt: `twitter.com/${cleanHandle}\uffff` } },
                { instagram: { $gte: `instagram.com/${cleanHandle}`, $lt: `instagram.com/${cleanHandle}\uffff` } }
            );

            query = { $or: conditions };
        }

        if (cursor && mongoose.isValidObjectId(cursor)) {
            query._id = { $gt: new mongoose.Types.ObjectId(cursor) };
        }

        // Exclude blacklisted records from search
        query.is_blacklisted = { $ne: true };

        const projection = {
            url: 1,
            date: 1,
            email: 1,
            postcode: 1,
            phone: 1,
            twitter: 1,
            facebook: 1,
            instagram: 1,
            linkedin: 1,
            pinterest: 1,
            youtube: 1,
            _id: 1
        };

        let cursorRows = await SocialScrape
            .find(query, projection)
            .sort({ _id: 1 })
            .limit(lim + 1)
            .maxTimeMS(MAX_TIME_MS)
            .lean();

        // If email search returned 0 (e.g. text index still building or single-field),
        // fallback to matching the email's domain against the indexed url field
        if (type === 'email' && cursorRows.length === 0 && !cursor && term.includes('@')) {
            const domain = term.split('@')[1]?.toLowerCase().trim();
            if (domain && domain.includes('.')) {
                const domainVariants = [
                    domain,
                    `http://${domain}`,
                    `https://${domain}`,
                    `http://www.${domain}`,
                    `https://www.${domain}`
                ];
                cursorRows = await SocialScrape
                    .find({ url: { $in: domainVariants }, is_blacklisted: { $ne: true } }, projection)
                    .sort({ _id: 1 })
                    .limit(lim + 1)
                    .maxTimeMS(MAX_TIME_MS)
                    .lean();
            }
        }

        const hasNextPage = cursorRows.length > lim;
        const rows = hasNextPage ? cursorRows.slice(0, lim) : cursorRows;
        const data = rows.map(formatSocialScrape);
        const nextCursor = hasNextPage && rows[rows.length - 1] ? String(rows[rows.length - 1]._id) : null;

        return res.json({
            success: true,
            db: 'socialscrapes',
            count: data.length,
            data,
            cursor: nextCursor,
            usage: usageBlock(req),
        });
    } catch (err) {
        console.error('[searchSocialScrape]', err.message);
        if (err.message && (err.message.includes('text index required') || err.message.includes('no text index'))) {
            return res.status(400).json({
                success: false,
                error: 'Unified text search index is currently building or missing. Please search by URL, Phone, or Postcode.',
            });
        }
        if (err.message && (err.message.includes('exceeded time limit') || err.message.includes('buffering timed out'))) {
            return res.status(504).json({
                success: false,
                error: 'Search timed out. Try refining your search query.',
            });
        }
        return res.status(500).json({ success: false, error: err.message });
    }
};

// ── 6. Business search (found_business_corrected: 1.5M docs) ───────────────

function formatBusiness(d) {
    return {
        _id: d._id,
        title: d.title || null,
        address: d.address || null,
        postcode: d.postcode || null,
        phone: d.phone || null,
        url: d.url || null,
        date: d.date || null
    };
}

const searchBusiness = async (req, res) => {
    try {
        const { q = '', type = 'all', cursor, limit } = req.query;
        const term = q.trim();
        if (!term || term.length < 2) {
            return res.status(400).json({ success: false, message: 'Query must be at least 2 characters.' });
        }

        const lim = Math.min(parseInt(limit, 10) || SEARCH_LIMIT, SEARCH_LIMIT);
        let query = {};

        if (type === 'name') {
            query = {
                $or: [
                    { title: term },
                    { title: term.toUpperCase() },
                    { title: { $gte: term, $lt: term + '\uffff' } },
                    { title: { $gte: term.toUpperCase(), $lt: term.toUpperCase() + '\uffff' } }
                ]
            };
        } else if (type === 'postcode') {
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
        } else if (type === 'phone') {
            const digits = term.replace(/\D/g, '');
            const cleanPhone = term.replace(/[^0-9+]/g, '');
            let ukPhone = digits;
            if (digits.startsWith('44') && digits.length >= 10) {
                ukPhone = '0' + digits.slice(2);
            }
            if (digits.length === 10 && !digits.startsWith('0') && !digits.startsWith('44')) {
                ukPhone = '0' + digits;
            }
            const phoneVariants = [...new Set([cleanPhone, term, digits, ukPhone].filter(p => p && p.length >= 2))];
            const phoneConds = [];
            for (const p of phoneVariants) {
                phoneConds.push(
                    { phone: p },
                    { phone: { $gte: p, $lt: p + '\uffff' } }
                );
            }
            query = { $or: phoneConds };
        } else if (type === 'url') {
            const clean = term.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '').toLowerCase();
            query = {
                $or: [
                    { url: clean },
                    { url: term },
                    { url: { $gte: clean, $lt: clean + '\uffff' } }
                ]
            };
        } else if (type === 'address') {
            const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            query = { address: { $regex: escaped, $options: 'i' } };
        } else {
            // 'all': multi-field query
            const clean = term.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '').trim();
            const cleanLower = clean.toLowerCase();
            const upperTerm = term.toUpperCase();
            const normPc = normalizeSearchPostcode(term);
            const digitCount = (term.match(/\d/g) || []).length;
            const isPhone = digitCount >= 4 && /^[\d\s+()-]+$/.test(term.trim());

            const conditions = [];

            // Title / Name
            conditions.push(
                { title: term },
                { title: upperTerm },
                { title: { $gte: term, $lt: term + '\uffff' } },
                { title: { $gte: upperTerm, $lt: upperTerm + '\uffff' } }
            );

            // Postcode
            if (normPc && normPc.length >= 2) {
                conditions.push(
                    { postcode: normPc },
                    { postcode: { $gte: normPc, $lt: normPc + '\uffff' } }
                );
            }

            // URL
            if (cleanLower.includes('.') || term.includes('/')) {
                conditions.push(
                    { url: cleanLower },
                    { url: { $gte: cleanLower, $lt: cleanLower + '\uffff' } }
                );
            }

            // Phone
            if (isPhone) {
                const digits = term.replace(/\D/g, '');
                const cleanPhone = term.replace(/[^0-9+]/g, '');
                let ukPhone = digits;
                if (digits.startsWith('44') && digits.length >= 10) {
                    ukPhone = '0' + digits.slice(2);
                }
                if (digits.length === 10 && !digits.startsWith('0') && !digits.startsWith('44')) {
                    ukPhone = '0' + digits;
                }
                const phoneVariants = [...new Set([cleanPhone, term, digits, ukPhone].filter(p => p && p.length >= 2))];
                for (const p of phoneVariants) {
                    conditions.push(
                        { phone: p },
                        { phone: { $gte: p, $lt: p + '\uffff' } }
                    );
                }
            }

            query = { $or: conditions };
        }

        if (cursor && mongoose.isValidObjectId(cursor)) {
            query._id = { $gt: new mongoose.Types.ObjectId(cursor) };
        }

        const projection = {
            title: 1,
            postcode: 1,
            address: 1,
            phone: 1,
            url: 1,
            date: 1,
            _id: 1
        };

        const cursorRows = await FoundBusiness
            .find(query, projection)
            .sort({ _id: 1 })
            .limit(lim + 1)
            .maxTimeMS(MAX_TIME_MS)
            .lean();

        const hasNextPage = cursorRows.length > lim;
        const rows = hasNextPage ? cursorRows.slice(0, lim) : cursorRows;
        const data = rows.map(formatBusiness);
        const nextCursor = hasNextPage && rows[rows.length - 1] ? String(rows[rows.length - 1]._id) : null;

        return res.json({
            success: true,
            db: 'found_business_corrected',
            count: data.length,
            data,
            cursor: nextCursor,
            usage: usageBlock(req),
        });
    } catch (err) {
        console.error('[searchBusiness]', err.message);
        if (err.message && (err.message.includes('exceeded time limit') || err.message.includes('buffering timed out'))) {
            return res.status(504).json({
                success: false,
                error: 'Search timed out. Try refining your search query or selecting a specific field.',
            });
        }
        return res.status(500).json({ success: false, error: err.message });
    }
};

// ── 7. Websites search (website_postcode: 689k docs) ───────────────────────

function formatWebsitePostcode(d) {
    return {
        _id: d._id,
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

        if (cursor && mongoose.isValidObjectId(cursor)) {
            query._id = { $gt: new mongoose.Types.ObjectId(cursor) };
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
        const nextCursor = hasNextPage && rows[rows.length - 1] ? String(rows[rows.length - 1]._id) : null;

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

// ── 8. Usage stats ─────────────────────────────────────────────────────────

const getUsage = async (req, res) => {
    try {
        const User = require('../models/User');
        const user = await User.findById(req.user.id).select('plan searchCount searchResetDate').lean();
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        const FREE_DAILY_LIMIT = parseInt(process.env.FREE_DAILY_LIMIT || '50', 10);
        const limit = user.plan === 'paid' || user.plan === 'admin' ? null : FREE_DAILY_LIMIT;

        const midnight = new Date();
        midnight.setUTCHours(24, 0, 0, 0);

        return res.json({
            success: true,
            plan:      user.plan,
            used:      user.searchCount || 0,
            limit,
            remaining: limit === null ? null : Math.max(0, limit - (user.searchCount || 0)),
            resetAt:   midnight.toISOString(),
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
};

module.exports = {
    searchRmAddress,
    searchPropPrice,
    searchCompany,
    searchScreenshot,
    searchSocialScrape,
    searchBusiness,
    searchWebsites,
    getUsage
};
