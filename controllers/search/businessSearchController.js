/**
 * businessSearchController.js
 * Dedicated controller for Located Businesses search (located_businesses: 2.49M docs).
 */

const mongoose = require('mongoose');
const LocatedBusiness = require('../../models/LocatedBusiness');
const {
    SEARCH_LIMIT,
    MAX_TIME_MS,
    normalizeSearchPostcode,
    encodeCursorToken,
    decodeCursorToken,
    usageBlock,
} = require('./searchHelper');

function formatLocatedBusiness(d) {
    let phones = [];
    if (Array.isArray(d.phone)) {
        phones = d.phone.map(p => {
            if (!p) return '';
            if (typeof p === 'string') return p;
            return p.number || '';
        }).filter(Boolean);
    } else if (d.phone) {
        phones = [String(d.phone)];
    }

    let addressStr = d.address || '';
    if (!addressStr && Array.isArray(d.address_lines)) {
        addressStr = d.address_lines.filter(Boolean).join(', ');
    }

    let dateStr = d.raw_date_text || '';
    if (!dateStr && d.date_recorded) {
        try {
            dateStr = new Date(d.date_recorded).toLocaleDateString('en-GB');
        } catch {
            dateStr = '';
        }
    }

    return {
        company_name: d.company_name || null,
        title: d.company_name || null,
        address: addressStr || null,
        address_lines: Array.isArray(d.address_lines) ? d.address_lines : null,
        postcode: d.postcode || null,
        phone: phones,
        email: d.email || null,
        url: d.url || null,
        twitter: d.twitter || null,
        facebook: d.facebook || null,
        instagram: d.instagram || null,
        linkedin: d.linkedin || null,
        date: dateStr || null
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
            const upperTerm = term.toUpperCase();
            const titleCaseTerm = term.replace(/\b[a-z]/g, c => c.toUpperCase());
            query = {
                $or: [
                    { company_name: term },
                    { company_name: upperTerm },
                    { company_name: titleCaseTerm },
                    { company_name: { $gte: term, $lt: term + '\uffff' } },
                    { company_name: { $gte: upperTerm, $lt: upperTerm + '\uffff' } },
                    { company_name: { $gte: titleCaseTerm, $lt: titleCaseTerm + '\uffff' } }
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
                    { 'phone.number': p },
                    { phone: { $elemMatch: { number: { $gte: p, $lt: p + '\uffff' } } } }
                );
            }
            query = { $or: phoneConds };
        } else if (type === 'email') {
            query = { email: term.toLowerCase() };
        } else if (type === 'url') {
            const clean = term.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '').toLowerCase();
            query = {
                $or: [
                    { url: clean },
                    { url: term.toLowerCase() },
                    { url: { $gte: clean, $lt: clean + '\uffff' } }
                ]
            };
        } else if (type === 'address') {
            const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            query = {
                $or: [
                    { address: { $regex: escaped, $options: 'i' } },
                    { address_lines: { $regex: escaped, $options: 'i' } }
                ]
            };
        } else {
            // 'all': multi-field query
            const clean = term.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
            const cleanLower = clean.toLowerCase();
            const normPc = normalizeSearchPostcode(term);
            const digits = term.replace(/\D/g, '');
            const cleanPhone = term.replace(/[^0-9+]/g, '');
            let ukPhone = digits;
            const upperTerm = term.toUpperCase();

            const conditions = [];

            // 1. Email (hits email_1)
            if (term.includes('@')) {
                conditions.push({ email: term.toLowerCase() });
            }

            // 2. Phone (hits phone.number_1)
            if (digits.length >= 5) {
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

            // 3. Postcode (hits postcode_1)
            if (normPc && normPc.length >= 2 && (/\d/.test(normPc) || normPc.length <= 4)) {
                conditions.push(
                    { postcode: normPc },
                    { postcode: { $gte: normPc, $lt: normPc + '\uffff' } }
                );
            }

            // 4. URL (hits url_1)
            if (cleanLower.includes('.') || term.includes('/') || term.startsWith('www')) {
                conditions.push(
                    { url: cleanLower },
                    { url: { $gte: cleanLower, $lt: cleanLower + '\uffff' } }
                );
            }

            // 5. Company Name (hits company_name_1_postcode_1 index)
            const titleCaseTerm = term.replace(/\b[a-z]/g, c => c.toUpperCase());
            conditions.push(
                { company_name: term },
                { company_name: upperTerm },
                { company_name: titleCaseTerm },
                { company_name: { $gte: term, $lt: term + '\uffff' } },
                { company_name: { $gte: upperTerm, $lt: upperTerm + '\uffff' } },
                { company_name: { $gte: titleCaseTerm, $lt: titleCaseTerm + '\uffff' } }
            );

            query = { $or: conditions };
        }

        query.is_blacklisted = { $ne: true };

        if (cursor) {
            const cursorId = typeof decodeCursorToken(cursor) === 'object' ? decodeCursorToken(cursor)?._id : decodeCursorToken(cursor);
            if (cursorId && mongoose.isValidObjectId(cursorId)) {
                query._id = { $gt: new mongoose.Types.ObjectId(cursorId) };
            }
        }

        const projection = {
            company_name: 1,
            postcode: 1,
            address: 1,
            address_lines: 1,
            phone: 1,
            email: 1,
            url: 1,
            twitter: 1,
            facebook: 1,
            instagram: 1,
            linkedin: 1,
            date_recorded: 1,
            raw_date_text: 1,
            _id: 1
        };

        const cursorRows = await LocatedBusiness
            .find(query, projection)
            .sort({ _id: 1 })
            .limit(lim + 1)
            .maxTimeMS(MAX_TIME_MS)
            .lean();

        const hasNextPage = cursorRows.length > lim;
        const rows = hasNextPage ? cursorRows.slice(0, lim) : cursorRows;
        const data = rows.map(formatLocatedBusiness);
        const nextCursor = hasNextPage && rows[rows.length - 1] ? encodeCursorToken({ _id: String(rows[rows.length - 1]._id) }) : null;

        return res.json({
            success: true,
            db: 'located_businesses',
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

module.exports = {
    searchBusiness,
};
