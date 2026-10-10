/**
 * rmSearchController.js
 * Dedicated controller for Royal Mail Address search, suggestion autocomplete, and cascading lookups.
 */

const mongoose = require('mongoose');
const { LRUCache } = require('lru-cache');
const AddressMasterMerged = require('../../models/AddressMasterMerged');
const {
    SEARCH_LIMIT,
    MAX_TIME_MS,
    naturalCompare,
    normalizeSearchPostcode,
    encodeCursorToken,
    decodeCursorToken,
    usageBlock,
    norm,
    esc,
    nextPrefix,
    isPostcode,
    UNIT,
    parseQuery,
} = require('./searchHelper');

const searchCache = new LRUCache({ max: 5000, ttl: 1000 * 60 * 60 });

// ==========================================
// 1. AUTOCOMPLETE DROPDOWN (Slim payload, up to 50 suggestions)
// ==========================================
const suggestRmAddress = async (req, res) => {
    try {
        const qRaw = req.query.q || '';
        const q = norm(qRaw);
        const { unit, num, rest } = parseQuery(q);

        if (rest.length < 3) return res.json([]);

        // Check cache for the stripped street name
        if (searchCache.has(rest)) {
            const cached = searchCache.get(rest);
            return res.json(cached.map(r => ({ ...r, requestedUnit: unit, requestedNumber: num })));
        }

        const db = req.app.locals.db || mongoose.connection.db; 
        const dictColl = db.collection('search_dictionary');
        let results = [];
        const projection = {
            display: 1,
            type: 1,
            street: 1,
            town: 1,
            count: 1,
            postcodes: { $slice: 1 }
        }; 

        const SUGGEST_LIMIT = 50;

        if (isPostcode(rest)) {
            const compactQuery = rest.replace(/\s+/g, '');
            results = await dictColl.find({
                type: 'postcode',
                compact: { $gte: compactQuery, $lt: nextPrefix(compactQuery) }
            }).sort({ compact: 1 }).limit(SUGGEST_LIMIT).project(projection).toArray();
        } else {
            results = await dictColl.find({
                type: { $in: ['street', 'locality', 'building', 'premises'] },
                key: { $gte: rest, $lt: nextPrefix(rest) }
            }).sort({ key: 1, count: -1 }).limit(SUGGEST_LIMIT).maxTimeMS(300).project(projection).toArray();

            if (results.length < SUGGEST_LIMIT) {
                const cleanQuery = rest.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '');
                const words = cleanQuery.split(/\s+/).filter(w => w.length > 0);
                if (words.length > 0) {
                    const tokenConditions = words.map(w => ({
                        tokens: { $elemMatch: { $gte: w, $lt: nextPrefix(w) } }
                    }));

                    const tokenResults = await dictColl.find({
                        type: { $in: ['street', 'locality', 'building', 'premises'] },
                        $and: tokenConditions
                    }).sort({ count: -1, key: 1 }).limit(SUGGEST_LIMIT - results.length).maxTimeMS(1200).project(projection).toArray();

                    const seen = new Set(results.map(r => String(r._id)));
                    tokenResults.forEach(r => {
                        if (!seen.has(String(r._id))) results.push(r);
                    });
                }
            }
        }

        // Cache the slim payload (without numbers)
        const safePayload = results.map(r => {
            const isPc = r.type === 'postcode';
            return {
                id: String(r._id),
                display: r.display,
                title: isPc ? r.display : (r.street || r.display),
                town: r.town || '',
                postcode: isPc ? '' : (r.postcodes?.[0] || ''),
                count: r.count || null,
                more: r.type === 'street' && (r.count || 0) > 1,
                type: r.type
            };
        });

        if (safePayload.length > 0) {
            searchCache.set(rest, safePayload);
        }

        // Map numbers back onto the response for this specific user request
        res.json(safePayload.map(r => ({ ...r, requestedUnit: unit, requestedNumber: num })));

    } catch (error) {
        console.error('[suggestRmAddress]', error.message);
        res.status(500).json([]);
    }
};

// ==========================================
// 2. THE CASCADE (User selects a dropdown item)
// ==========================================
const cascadeRmAddress = async (req, res) => {
    try {
        const { id, requestedNumber } = req.query;
        if (!id || !mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid Dictionary ID' });
        }

        const db = req.app.locals.db || mongoose.connection.db; 
        const dictColl = db.collection('search_dictionary');
        const mainColl = db.collection('address_master_merged');

        const dictDoc = await dictColl.findOne({ _id: new mongoose.Types.ObjectId(id) });
        if (!dictDoc || !dictDoc.postcodes || dictDoc.postcodes.length === 0) {
            return res.json({ success: true, count: 0, data: [], exactMatch: false });
        }

        const proj = { projection: { postcode: 1, district: 1, address: 1 } };
        const base = [{ postcode: { $in: dictDoc.postcodes } }];
        if (dictDoc.street) {
            const isStreet = dictDoc.type === 'street';
            const pattern = isStreet
                ? `(^|[\\s,])${esc(dictDoc.street)}$`
                : `(^|[\\s,])${esc(dictDoc.street)}`;
            base.push({ address: { $regex: pattern, $options: 'i' } });
        }

        const num = /^\d+[a-z]?$/i.test(requestedNumber || '') ? requestedNumber : null;
        
        const find = (extra, lim) => mainColl
            .find({ $and: extra ? [...base, extra] : base }, proj)
            .sort({ postcode: 1, address: 1 }).limit(lim).maxTimeMS(2000).toArray();

        // exact and whole-street queries run in parallel
        const [exact, street] = await Promise.all([
            num ? find({ address: { $regex: `(^|,\\s*)${esc(num)}[a-z]?\\b`, $options: 'i' } }, 100) : [],
            find(null, 501),
        ]);

        const truncated = street.length > 500;
        const exactIds = new Set(exact.map(r => String(r._id)));
        const rest = street.slice(0, 500).filter(r => !exactIds.has(String(r._id)));

        // sort by parsed house number, not by the whole string
        const houseKey = a => {
            for (const p of a.split(',')) {
                const m = p.trim().match(/^(\d+)([a-z]?)\b/i);
                if (m) return [parseInt(m[1], 10), m[2].toLowerCase()];
            }
            return [Infinity, ''];
        };
        const byHouse = (a, b) => {
            const [an, al] = houseKey(a.address), [bn, bl] = houseKey(b.address);
            return (an - bn) || al.localeCompare(bl) ||
                a.address.localeCompare(b.address, undefined, { numeric: true, sensitivity: 'base' });
        };
        exact.sort(byHouse); rest.sort(byHouse);

        const hasExact = exact.length > 0;
        
        return res.json({
            success: true, 
            db: 'rm_address',
            requestedNumber: num,
            exactMatch: num ? hasExact : null,
            message: num && !hasExact ? `No exact match for "${num}". Showing all addresses on this street.` : null,
            data: hasExact ? exact : rest,
            more: hasExact ? rest : [],
            truncated: truncated,
            count: (hasExact ? exact.length : 0) + rest.length,
            usage: usageBlock(req),
        });

    } catch (error) {
        console.error('[cascadeRmAddress]', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
};

// ==========================================
// 3. RM ADDRESS SEARCH (address_master_merged: 36M+ docs)
// ==========================================
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
                query.postcode = { $gte: normalized, $lt: `${normalized}\uffff` };
            }

            sortStage = { postcode: 1, _id: 1 };

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
            const { unit, num, rest } = parseQuery(norm(term));
            if (rest.length < 3) {
                return res.json({ success: true, count: 0, data: [], message: 'Query too short.', usage: usageBlock(req) });
            }

            const db = req.app.locals.db || mongoose.connection.db; 
            const dictColl = db.collection('search_dictionary');
            const mainColl = db.collection('address_master_merged');

            let dictDoc = await dictColl.findOne({
                type: { $in: ['street', 'locality', 'building', 'premises'] },
                key: { $gte: rest, $lt: nextPrefix(rest) }
            }, { sort: { count: -1, key: 1 } });

            if (!dictDoc) {
                const cleanQuery = rest.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '');
                const words = cleanQuery.split(/\s+/).filter(w => w.length > 0);
                if (words.length > 0) {
                    const tokenConditions = words.map(w => ({
                        tokens: { $elemMatch: { $gte: w, $lt: nextPrefix(w) } }
                    }));
                    dictDoc = await dictColl.findOne({
                        type: { $in: ['street', 'locality', 'building', 'premises'] },
                        $and: tokenConditions
                    }, { sort: { count: -1, key: 1 } });
                }
            }

            if (!dictDoc || !dictDoc.postcodes || dictDoc.postcodes.length === 0) {
                return res.json({
                    success: true, db: 'rm_address', count: 0, data: [], 
                    message: 'No matching addresses found.', usage: usageBlock(req)
                });
            }

            const proj = { projection: { postcode: 1, district: 1, address: 1 } };
            const base = [{ postcode: { $in: dictDoc.postcodes } }];
            if (dictDoc.street) {
                const isStreet = dictDoc.type === 'street';
                const pattern = isStreet
                    ? `(^|[\\s,])${esc(dictDoc.street)}$`
                    : `(^|[\\s,])${esc(dictDoc.street)}`;
                base.push({ address: { $regex: pattern, $options: 'i' } });
            }

            const extras = [];
            if (unit) extras.push({ address: { $regex: `(^|,\\s*)(${UNIT})\\s+${esc(unit)}\\b`, $options: 'i' } });
            if (num)  extras.push({ address: { $regex: `(^|,\\s*)${unit ? '' : `((${UNIT})\\s+)?`}${esc(num)}[a-z]?\\b`, $options: 'i' } });

            const find = (ex, lim) => mainColl.find({ $and: [...base, ...ex] }, proj)
                .sort({ postcode: 1, address: 1 }).limit(lim).maxTimeMS(2000).toArray();

            const [exact, street] = await Promise.all([ extras.length ? find(extras, 100) : [], find([], 501) ]);

            const truncated = street.length > 500;
            const exactIds = new Set(exact.map(r => String(r._id)));
            const restRows = street.slice(0, 500).filter(r => !exactIds.has(String(r._id)));

            const houseKey = a => {
                for (const p of a.split(',')) {
                    const m = p.trim().match(/^(\d+)([a-z]?)\b/i);
                    if (m) return [parseInt(m[1], 10), m[2].toLowerCase()];
                }
                return [Infinity, ''];
            };
            const byHouse = (a, b) => {
                const [an, al] = houseKey(a.address), [bn, bl] = houseKey(b.address);
                return (an - bn) || al.localeCompare(bl) || a.address.localeCompare(b.address, undefined, { numeric: true, sensitivity: 'base' });
            };
            
            const rank = r => (num && !unit && houseKey(r.address)[0] === parseInt(num, 10)) ? 0 : 1;
            exact.sort((a, b) => rank(a) - rank(b) || byHouse(a, b));
            restRows.sort(byHouse);

            const hasExact = exact.length > 0;
            const msgStr = [unit && 'flat ' + unit, num].filter(Boolean).join(' ');

            return res.json({
                success: true,
                db: 'rm_address',
                requestedNumber: num,
                requestedUnit: unit,
                exactMatch: extras.length ? hasExact : null,
                message: extras.length && !hasExact ? `No exact match for "${msgStr}". Showing all addresses on this street.` : null,
                data: hasExact ? exact : restRows,
                more: hasExact ? restRows : [],
                truncated: truncated,
                count: (hasExact ? exact.length : 0) + restRows.length,
                cursor: null,
                usage: usageBlock(req),
            });
        }

        const cursorRows = await AddressMasterMerged
            .find(query, { postcode: 1, district: 1, address: 1, _id: 1 })
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
            return naturalCompare(a.address, b.address);
        });

        const lastRow = rows[rows.length - 1] || null;
        const nextCursor = hasNextPage && lastRow
            ? (isPostcodeQuery
                ? encodeCursorToken({ postcode: lastRow.postcode, _id: String(lastRow._id) })
                : encodeCursorToken({ _id: String(lastRow._id) }))
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

module.exports = {
    suggestRmAddress,
    cascadeRmAddress,
    searchRmAddress,
};
