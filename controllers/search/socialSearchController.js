/**
 * socialSearchController.js
 * Dedicated controller for Social Scrapes search (socialscrapes: 85M docs).
 */

const mongoose = require('mongoose');
const SocialScrape = require('../../models/SocialScrape');
const {
    SEARCH_LIMIT,
    MAX_TIME_MS,
    normalizeSearchPostcode,
    encodeCursorToken,
    decodeCursorToken,
    usageBlock,
} = require('./searchHelper');

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
            query = { email: term.toLowerCase() };
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
        } else if (type === 'social') {
            const clean = term
                .replace(/^https?:\/\/(www\.)?/i, '')
                .replace(/^(twitter|x|facebook|instagram|linkedin|pinterest|youtube)\.com\/?(in\/|user\/|company\/)?/i, '')
                .replace(/^@/, '')
                .replace(/\/+$/, '')
                .trim();

            const candidates = [
                clean,
                `@${clean}`,
                `facebook.com/${clean}`,
                `twitter.com/${clean}`,
                `instagram.com/${clean}`,
                `linkedin.com/in/${clean}`,
                `pinterest.com/${clean}`,
                `youtube.com/${clean}`,
            ];

            const prefixMatches = [
                { facebook: { $gte: `facebook.com/${clean}`, $lt: `facebook.com/${clean}\uffff` } },
                { twitter: { $gte: `twitter.com/${clean}`, $lt: `twitter.com/${clean}\uffff` } },
                { instagram: { $gte: `instagram.com/${clean}`, $lt: `instagram.com/${clean}\uffff` } }
            ];

            query = {
                $or: [
                    { facebook: { $in: candidates } },
                    { twitter: { $in: candidates } },
                    { instagram: { $in: candidates } },
                    { linkedin: { $in: candidates } },
                    { pinterest: { $in: candidates } },
                    { youtube: { $in: candidates } },
                    ...prefixMatches
                ]
            };
        } else {
            // 'all': Multi-field search
            const clean = term.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '').toLowerCase();
            const normPc = normalizeSearchPostcode(term);
            const digits = term.replace(/\D/g, '');
            const cleanPhone = term.replace(/[^0-9+]/g, '');
            let ukPhone = digits;
            if (digits.startsWith('44') && digits.length >= 10) {
                ukPhone = '0' + digits.slice(2);
            }
            if (digits.length === 10 && !digits.startsWith('0') && !digits.startsWith('44')) {
                ukPhone = '0' + digits;
            }

            const conditions = [];

            // 1. URL
            if (clean.includes('.') || term.includes('/') || term.startsWith('www')) {
                conditions.push(
                    { url: clean },
                    { url: term },
                    { url: { $gte: clean, $lt: clean + '\uffff' } }
                );
            }

            // 2. Email
            if (term.includes('@')) {
                conditions.push({ email: term.toLowerCase() });
            }

            // 3. Postcode
            if (normPc && normPc.length >= 2 && (/\d/.test(normPc) || normPc.length <= 4)) {
                conditions.push(
                    { postcode: normPc },
                    { postcode: { $gte: normPc, $lt: normPc + '\uffff' } }
                );
            }

            // 4. Phone
            if (digits.length >= 5) {
                const phoneVariants = [...new Set([cleanPhone, term, digits, ukPhone].filter(p => p && p.length >= 2))];
                for (const p of phoneVariants) {
                    conditions.push(
                        { 'phone.number': p },
                        { phone: { $elemMatch: { number: { $gte: p, $lt: p + '\uffff' } } } }
                    );
                }
            }

            // 5. Social handles
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
                { facebook: { $in: socialSearchTerms } },
                { twitter: { $in: socialSearchTerms } },
                { instagram: { $in: socialSearchTerms } },
                { linkedin: { $in: socialSearchTerms } },
                { pinterest: { $in: socialSearchTerms } },
                { youtube: { $in: socialSearchTerms } },
                { facebook: { $gte: `facebook.com/${cleanHandle}`, $lt: `facebook.com/${cleanHandle}\uffff` } },
                { twitter: { $gte: `twitter.com/${cleanHandle}`, $lt: `twitter.com/${cleanHandle}\uffff` } },
                { instagram: { $gte: `instagram.com/${cleanHandle}`, $lt: `instagram.com/${cleanHandle}\uffff` } }
            );

            query = { $or: conditions };
        }

        if (cursor) {
            const cursorId = typeof decodeCursorToken(cursor) === 'object' ? decodeCursorToken(cursor)?._id : decodeCursorToken(cursor);
            if (cursorId && mongoose.isValidObjectId(cursorId)) {
                query._id = { $gt: new mongoose.Types.ObjectId(cursorId) };
            }
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

        // If email search returned 0, fallback to matching the email's domain
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
        const nextCursor = hasNextPage && rows[rows.length - 1] ? encodeCursorToken({ _id: String(rows[rows.length - 1]._id) }) : null;

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

module.exports = {
    searchSocialScrape,
};
