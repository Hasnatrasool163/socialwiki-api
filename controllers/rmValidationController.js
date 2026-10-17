/**
 * rmValidationController.js
 *
 * Implements Phase 3: Address Validation (RM Residential Validation & Business Find)
 * Strictly follows Section 6 rules:
 * - Validation only: Never returns address row lists to customers.
 * - Derived streets via Section 6.2 parser rules.
 * - Negative confirmations are forbidden ("Postcode and street confirmed" on non-match).
 * - Flats/units/suites typed by user.
 * - Business Find: Public business information only (RM premises + Companies House).
 */

const mongoose = require('mongoose');
const { LRUCache } = require('lru-cache');
const PostcodeDistrict = require('../models/PostcodeDistrict');
const AddressMasterMerged = require('../models/AddressMasterMerged');
const NotFoundQueue = require('../models/NotFoundQueue');
const SearchEvent = require('../models/SearchEvent');
const UsageDaily = require('../models/UsageDaily');
const logger = require('../config/logger');
const { getPostcodeCentroid } = require('../services/centroidService');
const { locateAddress, searchNominatim, reverseNominatim } = require('../services/geocoderService');

// Fixed unit hint labels in priority order (Phase 3 addendum)
const STRUCTURAL_HINT_DEFINITIONS = [
    { label: 'Floor/Level', regex: /\b(?:floor|level|ground\s*floor|[0-9]+(?:st|nd|rd|th)\s*floor|basement)\b/i },
    { label: 'Block',       regex: /\bblock\b/i },
    { label: 'Flat',        regex: /\bflat\b/i },
    { label: 'Apartment',   regex: /\b(?:apartment|apt)\b/i },
    { label: 'Suite',       regex: /\bsuite\b/i },
    { label: 'Unit',        regex: /\bunit\b/i },
    { label: 'Room',        regex: /\broom\b/i },
    { label: 'Studio',      regex: /\bstudio\b/i }
];

function sanitizeInput(str, maxLen = 30) {
    if (!str || typeof str !== 'string') return '';
    return str.replace(/<[^>]*>/g, '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, maxLen);
}

function detectUnitHints(rows, streetLower, typedNumber, typedName) {
    const matchedRows = [];
    for (const r of rows) {
        if (!r.address) continue;
        const parsed = parseAddressRow(r.address);
        if (!parsed || !parsed.street || parsed.street.toLowerCase() !== streetLower) continue;

        if (typedNumber) {
            const pNum = (parsed.numberPart || '').toLowerCase();
            const tNum = typedNumber.toLowerCase();
            if (pNum === tNum || pNum.startsWith(tNum)) {
                matchedRows.push(r.address);
                continue;
            }
        }
        if (typedName && parsed.premises && parsed.premises.length > 0) {
            const pStr = parsed.premises.join(' ').toLowerCase();
            if (pStr.includes(typedName.toLowerCase())) {
                matchedRows.push(r.address);
                continue;
            }
        }
    }

    const candidateTexts = matchedRows.length > 0 ? matchedRows : rows.map(r => r.address);
    const joinedText = candidateTexts.join('\n');

    const hints = [];
    for (const item of STRUCTURAL_HINT_DEFINITIONS) {
        if (item.regex.test(joinedText)) {
            hints.push(item.label);
            if (hints.length === 3) break;
        }
    }
    return hints;
}

// LRU Caches for sub-10ms performance
const streetCache = new LRUCache({ max: 5000, ttl: 1000 * 60 * 60 * 24 }); // 24h
const areaCache = new LRUCache({ max: 500, ttl: 1000 * 60 * 60 * 24 });
const probeTracker = new LRUCache({ max: 10000, ttl: 1000 * 60 }); // 1 min probe rate limit

// Stop words for business search
const BUSINESS_STOP_WORDS = new Set([
    'ltd', 'limited', 'plc', 'llp', 'the', 'and', 'of', 'co', 'company', 'group', 'services', 'uk'
]);

// Business indicator words to retain
const BUSINESS_INDICATORS = [
    'ltd', 'limited', 'llp', 'plc', 'bank', 'surgery', 'centre', 'center', 'shop', 'store',
    'pharmacy', 'cafe', 'café', 'church', 'school', 'hotel', 'pub', 'club', 'garage',
    'salon', 'office', 'dental', 'clinic', 'restaurant', 'bar', 'inn', 'bakery', 'market',
    'solicitors', 'law', 'consulting', 'associates', 'holdings', 'enterprises', 'logistics'
];

// House-style names to drop in business search
const HOUSE_STYLE_SUFFIXES = [
    'cottage', 'lodge', 'villa', 'barn', 'bungalow', 'house', 'court', 'manor', 'hall', 'farm'
];

// Thoroughbred thoroughfare words (Section 6.2, Rule 4)
const THOROUGHFARE_WORDS = new Set([
    'road', 'street', 'avenue', 'lane', 'gardens', 'close', 'drive', 'way',
    'court', 'terrace', 'mews', 'place', 'gate', 'corner', 'row', 'walk',
    'hill', 'green', 'park', 'square', 'crescent', 'grove', 'rise', 'parade',
    'quay', 'wharf', 'fields', 'village', 'mound', 'broadway', 'boulevard',
    'esplanade', 'promenade', 'circus', 'causeway', 'approach', 'chase',
    'common', 'copse', 'croft', 'cross', 'dale', 'dene', 'downs', 'end',
    'estate', 'furlong', 'garth', 'glade', 'glen', 'grange', 'heath',
    'heights', 'hollow', 'kingsway', 'lawn', 'lea', 'link', 'loop', 'mall',
    'mead', 'meadow', 'meadows', 'mount', 'orchard', 'paddock', 'passage',
    'path', 'piazza', 'quadrant', 'queensway', 'reach', 'ridge', 'side',
    'slope', 'spinney', 'steps', 'strand', 'vale', 'view', 'villas',
    'walkway', 'waterside', 'wood', 'woods', 'wynd', 'brae', 'loan',
    'vennel', 'yard', 'market', 'bank', 'bridge', 'wall', 'castlehill',
    'lawnmarket', 'grassmarket', 'canongate', 'cowgate', 'haymarket',
    'piccadilly', 'whitehall', 'cheapside', 'cornhill'
]);

const UNIT_WORD_REGEX = /^(?:flat|unit|room|apartment|suite)\b(?:\s+[a-z0-9\/-]+)?$/i;
const FLOOR_WORD_REGEX = /^(?:ground\s+floor|first\s+floor|second\s+floor|third\s+floor|basement|annexe|[0-9]\/[a-z]|[a-z]\/[a-z])$/i;

/**
 * Section 6.2 Address Parser Rules
 * Derives street name and premises from an address row.
 */
function parseAddressRow(rawAddress) {
    if (!rawAddress || typeof rawAddress !== 'string') return null;
    const parts = rawAddress.split(',').map(p => p.trim()).filter(Boolean);
    if (!parts.length) return null;

    // Rule 5: Skip PO Box rows
    if (/^po\s+box\b/i.test(parts[0])) return null;

    // Rule 2: Drop unit-only parts from leading positions
    let idx = 0;
    let detectedUnitPrompt = null;
    while (idx < parts.length) {
        const p = parts[idx];
        const unitMatch = p.match(/^(flat|unit|room|apartment|suite)\b/i);
        if (unitMatch) {
            if (!detectedUnitPrompt) detectedUnitPrompt = unitMatch[1];
            idx++;
        } else if (FLOOR_WORD_REGEX.test(p)) {
            if (!detectedUnitPrompt) detectedUnitPrompt = p;
            idx++;
        } else {
            break;
        }
    }

    const remaining = parts.slice(idx);
    if (!remaining.length) return null;

    // Rule 3: Anchor on first part with leading house number or range
    for (let i = 0; i < remaining.length; i++) {
        const part = remaining[i];
        const numMatch = part.match(/^(\d+(?:[a-z]|-\d+)?)\s+(.+)$/i);
        if (numMatch) {
            const leadNum = numMatch[1];
            // Ensure word boundary so "2nd Avenue" is not treated as house number 2
            if (!/^(?:\d+(?:st|nd|rd|th))$/i.test(leadNum)) {
                const street = [numMatch[2], ...remaining.slice(i + 1)].join(', ');
                return {
                    street: cleanStreetName(street),
                    numberPart: leadNum,
                    premises: remaining.slice(0, i),
                    unitPrompt: detectedUnitPrompt
                };
            }
        }
        // Also handle house number separated by comma from the street (e.g. "354, Castlehill")
        const standaloneNum = part.match(/^(\d+(?:[a-z]|-\d+)?)$/i);
        if (standaloneNum && i + 1 < remaining.length) {
            const leadNum = standaloneNum[1];
            if (!/^(?:\d+(?:st|nd|rd|th))$/i.test(leadNum)) {
                const street = remaining.slice(i + 1).join(', ');
                return {
                    street: cleanStreetName(street),
                    numberPart: leadNum,
                    premises: remaining.slice(0, i),
                    unitPrompt: detectedUnitPrompt
                };
            }
        }
    }

    // Rule 4: With no number, anchor on first part ending in a thoroughfare word
    for (let i = 0; i < remaining.length; i++) {
        const words = remaining[i].split(/\s+/);
        const lastWord = words[words.length - 1].toLowerCase();
        if (THOROUGHFARE_WORDS.has(lastWord)) {
            const street = remaining.slice(i).join(', ');
            return {
                street: cleanStreetName(street),
                numberPart: null,
                premises: remaining.slice(0, i),
                unitPrompt: detectedUnitPrompt
            };
        }
    }

    // Rule 5: 2 or more parts -> drop first part (premises) and treat rest as street
    if (remaining.length >= 2) {
        return {
            street: cleanStreetName(remaining.slice(1).join(', ')),
            numberPart: null,
            premises: [remaining[0]],
            unitPrompt: detectedUnitPrompt
        };
    }

    // 1 part: premises only
    return {
        street: null,
        numberPart: null,
        premises: [remaining[0]],
        unitPrompt: detectedUnitPrompt
    };
}

function cleanStreetName(s) {
    if (!s) return '';
    return s.replace(/\s+/g, ' ').trim();
}

/**
 * Normalise postcode string (handles full postcodes, outcodes e.g. DN41/AL10, and sectors e.g. DN41 7)
 */
function normalizePostcode(raw) {
    if (!raw) return '';
    const s = String(raw).trim().toUpperCase().replace(/[^A-Z0-9\s]/g, '').replace(/\s+/g, ' ');
    if (!s) return '';

    // 1. Full postcode: "DN41 7RU" or "DN417RU" (always ends in digit + 2 letters)
    const fullMatch = s.match(/^([A-Z]{1,2}[0-9][A-Z0-9]?)\s*([0-9][A-Z]{2})$/i);
    if (fullMatch) {
        return `${fullMatch[1]} ${fullMatch[2]}`;
    }

    // 2. Outcode only (2-4 chars, NO space): "DN41", "AL10", "M11", "SW1A", "M1"
    // Checked BEFORE sector rules so "DN41" or "AL10" is never split into "DN4 1" or "AL1 0"
    const outcodeMatch = s.match(/^([A-Z]{1,2}[0-9][A-Z0-9]?)$/i);
    if (outcodeMatch) {
        return outcodeMatch[1];
    }

    // 3. Sector/prefix with explicit space: "DN41 7", "M1 1", "SW1A 1", "DN41 7R", "SW1A 1A"
    const sectorSpaceMatch = s.match(/^([A-Z]{1,2}[0-9][A-Z0-9]?)\s+([0-9][A-Z]?)$/i);
    if (sectorSpaceMatch) {
        return `${sectorSpaceMatch[1]} ${sectorSpaceMatch[2]}`;
    }

    // 4. Partial inward unit without space (outcode + digit + letter, e.g. "M11A" -> "M1 1A", "EH11Y" -> "EH1 1Y", "DN417R" -> "DN41 7R", "SW1A1A" -> "SW1A 1A")
    const partialUnitNoSpaceMatch = s.match(/^([A-Z]{1,2}[0-9][A-Z0-9]?)([0-9][A-Z])$/i);
    if (partialUnitNoSpaceMatch) {
        return `${partialUnitNoSpaceMatch[1]} ${partialUnitNoSpaceMatch[2]}`;
    }

    // 5. Sector without space (5-6 chars: 4-char outcode + 1-2 char inward prefix, e.g. "DN417", "SW1A1", "AL109")
    const sectorNoSpaceMatch = s.match(/^([A-Z]{2}[0-9]{2}|[A-Z]{1,2}[0-9][A-Z])([0-9][A-Z]?)$/i);
    if (sectorNoSpaceMatch) {
        return `${sectorNoSpaceMatch[1]} ${sectorNoSpaceMatch[2]}`;
    }

    return s;
}

/**
 * Log usage session
 */
async function recordUsage(user, type, queryTerm) {
    try {
        if (!user || user.role === 'admin') return;
        const today = new Date().toISOString().slice(0, 10);
        await UsageDaily.findOneAndUpdate(
            { userId: user._id, date: today },
            { $inc: { count: 1 } },
            { upsert: true }
        );
        await SearchEvent.create({
            userId: user._id,
            type,
            query: queryTerm,
            timestamp: new Date()
        });
    } catch (e) {
        logger.error(`Usage recording error: ${e.message}`);
    }
}

// ============================================================================
// 1. GET /api/rm/postcodes?q=
// ============================================================================
const getPostcodes = async (req, res) => {
    try {
        const rawQ = (req.query.q || '').trim().toUpperCase();
        if (!rawQ) {
            return res.json({ postcodes: [], hint: 'Enter a postcode, for example DN41 7' });
        }

        const normQ = normalizePostcode(rawQ);
        const isFull = /^[A-Z]{1,2}[0-9][A-Z0-9]?\s+[0-9][A-Z]{2}$/i.test(normQ);
        const isSector = !isFull && /^[A-Z]{1,2}[0-9][A-Z0-9]?\s+[0-9][A-Z]?$/i.test(normQ);
        const isOutcode = !isFull && !isSector && /^[A-Z]{1,2}[0-9][A-Z0-9]?$/i.test(normQ);
        const isAreaPrefix = !isFull && !isSector && !isOutcode && /^[A-Z]{2}$/i.test(normQ);

        if (!isFull && !isSector && !isOutcode && !isAreaPrefix) {
            return res.json({
                postcodes: [],
                hint: 'Enter a postcode, for example DN41 7 or SW1A 1AA'
            });
        }

        const db = req.app.locals.db || mongoose.connection.db;
        const coll = db.collection('postcode_district');
        const activeFilter = {
            status: { $ne: 'NOT ACTIVE' },
            district: { $exists: true, $nin: ['', 'NOT ACTIVE', null] }
        };

        if (isFull) {
            // 1. Check active postcode_district
            let exactDoc = await coll.findOne({
                postcode: normQ,
                ...activeFilter
            });

            // 2. Fallback: check if address_master_merged or UK Nominatim/centroid has this full postcode
            if (!exactDoc) {
                const masterDoc = await db.collection('address_master_merged').findOne(
                    { postcode: normQ },
                    { projection: { postcode: 1, district: 1 } }
                );
                if (masterDoc) {
                    exactDoc = { postcode: normQ, district: masterDoc.district || '' };
                } else {
                    const centroid = await getPostcodeCentroid(normQ);
                    if (centroid) {
                        let resolvedTown = '';
                        try {
                            const rev = await reverseNominatim({ lat: centroid.lat, lon: centroid.lon, zoom: 16 });
                            if (rev && rev.address) {
                                resolvedTown = rev.address.city || rev.address.town || rev.address.village || rev.address.county || '';
                            }
                        } catch (_) {}
                        exactDoc = { postcode: normQ, district: resolvedTown };
                    }
                }
            }

            if (!exactDoc) {
                try {
                    await NotFoundQueue.create({
                        type: 'rm_postcode',
                        query: normQ,
                        userId: req.user?._id || null,
                        date: new Date()
                    });
                } catch (_) {}

                return res.status(404).json({
                    postcodes: [],
                    error: 'Postcode not recognised or no longer active',
                    message: 'Postcode not recognised or no longer active'
                });
            }

            return res.json({
                postcodes: [{ postcode: exactDoc.postcode, town: exactDoc.district || '' }],
                truncated: false
            });
        }

        // Prefix range query for sector ("DN41 7"), outcode ("DN41 "), or area prefix ("DN")
        const rangePrefix = isOutcode ? `${normQ} ` : normQ;
        const limit = 120;

        let rows = await coll.find({
            postcode: { $gte: rangePrefix, $lt: `${rangePrefix}\uffff` },
            ...activeFilter
        }).project({ postcode: 1, district: 1, _id: 0 }).sort({ postcode: 1 }).limit(limit + 1).toArray();

        // If outcode with trailing space returned 0 rows (e.g. "SW1" where postcodes are "SW1A 1AA", "SW1E..."), search without trailing space
        if (rows.length === 0 && isOutcode) {
            rows = await coll.find({
                postcode: { $gte: normQ, $lt: `${normQ}\uffff` },
                ...activeFilter
            }).project({ postcode: 1, district: 1, _id: 0 }).sort({ postcode: 1 }).limit(limit + 1).toArray();
        }

        // Fallback if a 2-digit outcode was typed with a space (e.g. "AL1 0" -> "AL10 ")
        if (rows.length === 0 && /^([A-Z]{1,2}[0-9])\s+([0-9])$/i.test(normQ)) {
            const collapsed = normQ.replace(/\s+/g, '');
            const collapsedPrefix = `${collapsed} `;
            rows = await coll.find({
                postcode: { $gte: collapsedPrefix, $lt: `${collapsedPrefix}\uffff` },
                ...activeFilter
            }).project({ postcode: 1, district: 1, _id: 0 }).sort({ postcode: 1 }).limit(limit + 1).toArray();
        }

        // Fallback to postcode_centroids if postcode_district had 0 active matches (e.g. SW1A 1 / SW1A 1A)
        if (rows.length === 0 && (isSector || isOutcode)) {
            const centroidDocs = await db.collection('postcode_centroids').find({
                postcode: { $gte: rangePrefix, $lt: `${rangePrefix}\uffff` }
            }).project({ postcode: 1, _id: 0 }).sort({ postcode: 1 }).limit(25).toArray().catch(() => []);
            if (centroidDocs.length > 0) {
                rows = centroidDocs.map(c => ({ postcode: c.postcode, district: '' }));
            }
        }

        const activeRows = rows.filter(r => !r.district || r.district.trim().toUpperCase() !== 'NOT ACTIVE');
        const truncated = activeRows.length > limit;
        const results = (truncated ? activeRows.slice(0, limit) : activeRows).map(r => ({
            postcode: r.postcode,
            town: r.district || ''
        }));

        return res.json({
            postcodes: results,
            truncated
        });
    } catch (err) {
        logger.error(`getPostcodes error: ${err.message}`);
        return res.status(500).json({ error: 'Failed to look up postcodes' });
    }
};

// ============================================================================
// 2. GET /api/rm/streets?postcode=
// ============================================================================
const MAX_STREETS = 200;

const getStreets = async (req, res) => {
    try {
        const rawPc = (req.query.postcode || '').trim().toUpperCase();
        const pc = normalizePostcode(rawPc);

        if (!pc || pc.length < 2) {
            return res.status(400).json({ error: 'Valid postcode, sector, or outcode is required' });
        }

        // Check LRU cache
        if (streetCache.has(pc)) {
            return res.json(streetCache.get(pc));
        }

        const db = req.app.locals.db || mongoose.connection.db;
        const coll = db.collection('address_master_merged');
        const dictColl = db.collection('search_dictionary');

        let effectivePc = pc;
        const isFull = /^[A-Z]{1,2}[0-9][A-Z0-9]?\s+[0-9][A-Z]{2}$/i.test(effectivePc);

        let town = '';
        const streetSet = new Set();
        const fallbackPremisesSet = new Set();

        if (isFull) {
            // 1. Exact full postcode lookup in address_master_merged (uses { postcode: 1, address: 1 } index)
            const rows = await coll.find({ postcode: effectivePc })
                .project({ address: 1, district: 1, street: 1 })
                .toArray();

            for (const row of rows) {
                if (!town && row.district) town = row.district;
                if (row.street) {
                    streetSet.add(cleanStreetName(row.street));
                } else if (row.address) {
                    const parsed = parseAddressRow(row.address);
                    if (parsed && parsed.street) {
                        streetSet.add(parsed.street);
                    } else if (parsed && parsed.premises && parsed.premises.length > 0) {
                        fallbackPremisesSet.add(cleanStreetName(parsed.premises.join(', ')));
                    }
                }
            }

            if (streetSet.size === 0 && fallbackPremisesSet.size > 0) {
                for (const p of fallbackPremisesSet) streetSet.add(p);
            }
        } else {
            // 2. Sector ("DN41 7") or Outcode ("DN41") lookup
            const buildRangePrefix = (code) => (code.includes(' ') ? code : `${code} `);
            let rangePrefix = buildRangePrefix(effectivePc);

            // 2a. Fast lookup in pre-parsed search_dictionary (type: 'street')
            let dictDocs = await dictColl.find({
                type: 'street',
                postcodes: { $elemMatch: { $gte: rangePrefix, $lt: `${rangePrefix}\uffff` } }
            }).project({ street: 1, display: 1, town: 1 }).limit(MAX_STREETS + 50).maxTimeMS(1500).toArray().catch(() => []);

            // If outcode with space had 0 matches (e.g. "SW1" where postcodes are "SW1A 1AA"), try prefix without space
            if (dictDocs.length === 0 && !effectivePc.includes(' ')) {
                dictDocs = await dictColl.find({
                    type: 'street',
                    postcodes: { $elemMatch: { $gte: effectivePc, $lt: `${effectivePc}\uffff` } }
                }).project({ street: 1, display: 1, town: 1 }).limit(MAX_STREETS + 50).maxTimeMS(1500).toArray().catch(() => []);
            }

            // If 2-digit outcode was typed with a space (e.g. "AL1 0" or "DN4 1") and returned 0 docs, try collapsed outcode ("AL10" / "DN41")
            if (dictDocs.length === 0 && /^([A-Z]{1,2}[0-9])\s+([0-9])$/i.test(effectivePc)) {
                const collapsed = effectivePc.replace(/\s+/g, '');
                const collapsedPrefix = `${collapsed} `;
                const fallbackDocs = await dictColl.find({
                    type: 'street',
                    postcodes: { $elemMatch: { $gte: collapsedPrefix, $lt: `${collapsedPrefix}\uffff` } }
                }).project({ street: 1, display: 1, town: 1 }).limit(MAX_STREETS + 50).maxTimeMS(1500).toArray().catch(() => []);

                if (fallbackDocs.length > 0) {
                    dictDocs = fallbackDocs;
                    effectivePc = collapsed;
                    rangePrefix = collapsedPrefix;
                }
            }

            for (const d of dictDocs) {
                if (!town && d.town) town = d.town;
                const stName = cleanStreetName(d.street || d.display);
                if (stName) streetSet.add(stName);
            }

            // 2b. Fallback to indexed range scan on address_master_merged if search_dictionary had no hits
            if (streetSet.size === 0) {
                let rows = await coll.find({
                    postcode: { $gte: rangePrefix, $lt: `${rangePrefix}\uffff` }
                }).project({ address: 1, district: 1, street: 1 }).limit(2500).toArray();

                if (rows.length === 0 && /^([A-Z]{1,2}[0-9])\s+([0-9])$/i.test(effectivePc)) {
                    const collapsed = effectivePc.replace(/\s+/g, '');
                    const collapsedPrefix = `${collapsed} `;
                    rows = await coll.find({
                        postcode: { $gte: collapsedPrefix, $lt: `${collapsedPrefix}\uffff` }
                    }).project({ address: 1, district: 1, street: 1 }).limit(2500).toArray();
                    if (rows.length > 0) {
                        effectivePc = collapsed;
                    }
                }

                for (const row of rows) {
                    if (!town && row.district) town = row.district;
                    if (row.street) {
                        streetSet.add(cleanStreetName(row.street));
                    } else if (row.address) {
                        const parsed = parseAddressRow(row.address);
                        if (parsed && parsed.street) {
                            streetSet.add(parsed.street);
                        } else if (parsed && parsed.premises && parsed.premises.length > 0) {
                            fallbackPremisesSet.add(cleanStreetName(parsed.premises.join(', ')));
                        }
                    }
                }

                if (streetSet.size === 0 && fallbackPremisesSet.size > 0) {
                    for (const p of fallbackPremisesSet) streetSet.add(p);
                }
            }
        }

        const centroid = await getPostcodeCentroid(effectivePc);

        // 3. Fallback to search_dictionary (exact postcode) and local UK Nominatim if streetSet is still empty (e.g. EH1 1YZ, SW1A 1AA)
        if (streetSet.size === 0) {
            if (isFull) {
                const dictExact = await dictColl.find({
                    type: { $in: ['street', 'building', 'premises'] },
                    postcodes: effectivePc
                }).project({ street: 1, display: 1, town: 1 }).limit(50).toArray().catch(() => []);

                for (const d of dictExact) {
                    if (!town && d.town) town = d.town;
                    const stName = cleanStreetName(d.street || d.display);
                    if (stName) streetSet.add(stName);
                }
            }

            if (streetSet.size === 0) {
                try {
                    const nomHits = await searchNominatim({ postalcode: effectivePc, limit: 10 });
                    for (const hit of nomHits || []) {
                        const addr = hit.address || {};
                        const road = addr.road || addr.pedestrian || addr.street || addr.residential || addr.footway || addr.place || addr.building || addr.tourism || addr.amenity || addr.office || addr.historic || '';
                        if (road) streetSet.add(cleanStreetName(road));
                        if (!town) {
                            town = addr.city || addr.town || addr.village || addr.city_district || addr.suburb || addr.county || '';
                        }
                    }
                } catch (_) {}
            }

            if (streetSet.size === 0 && centroid) {
                try {
                    // Query both zoom 16 (nearest street segment in Nominatim) and zoom 18 (exact building/landmark)
                    const [revStreet, revBuilding] = await Promise.allSettled([
                        reverseNominatim({ lat: centroid.lat, lon: centroid.lon, zoom: 16 }),
                        reverseNominatim({ lat: centroid.lat, lon: centroid.lon, zoom: 18 })
                    ]);

                    for (const resItem of [revStreet, revBuilding]) {
                        if (resItem.status === 'fulfilled' && resItem.value) {
                            const rev = resItem.value;
                            const addr = rev.address || {};
                            const road = addr.road || addr.pedestrian || addr.street || addr.residential || addr.footway || addr.place || '';
                            if (road) streetSet.add(cleanStreetName(road));
                            const landmark = rev.name || addr.building || addr.tourism || addr.amenity || addr.office || addr.historic || addr.quarter || addr.suburb || '';
                            if (landmark && landmark.toUpperCase() !== effectivePc) {
                                streetSet.add(cleanStreetName(landmark));
                            }
                            if (!town) {
                                town = addr.city || addr.town || addr.village || addr.city_district || addr.suburb || addr.county || '';
                            }
                        }
                    }
                } catch (_) {}
            }
        }

        const allSortedStreets = Array.from(streetSet).filter(Boolean).sort((a, b) => a.localeCompare(b));
        const truncated = allSortedStreets.length > MAX_STREETS;
        const uniqueStreets = truncated ? allSortedStreets.slice(0, MAX_STREETS) : allSortedStreets;

        const payload = {
            postcode: effectivePc,
            town,
            streets: uniqueStreets,
            truncated,
            hint: truncated
                ? `Showing first ${MAX_STREETS} streets in ${effectivePc} — enter a fuller postcode to narrow down.`
                : null,
            preselect: uniqueStreets.length === 1,
            manualEntry: uniqueStreets.length === 0,
            centroid: centroid ? { lat: centroid.lat, lon: centroid.lon } : null
        };

        if (uniqueStreets.length > 0) {
            streetCache.set(pc, payload);
            if (effectivePc !== pc) streetCache.set(effectivePc, payload);
        }

        return res.json(payload);
    } catch (err) {
        logger.error(`getStreets error: ${err.message}`);
        return res.status(500).json({ error: 'Failed to retrieve street names' });
    }
};

// ============================================================================
// 3. POST /api/rm/validate
// ============================================================================
const validateAddress = async (req, res) => {
    try {
        const { postcode: rawPc, street: rawStreet, number: rawNumber, name: rawName, unit: rawUnit } = req.body || {};
        let pc = normalizePostcode(rawPc);
        const street = cleanStreetName(rawStreet);
        const typedNumber = sanitizeInput(rawNumber);
        const typedName = sanitizeInput(rawName);
        const typedUnit = sanitizeInput(rawUnit);

        if (!pc || !street) {
            return res.status(400).json({ error: 'Postcode and street are required for validation' });
        }

        // Rate-limiting number probing on a single street (max 30 probes per min per IP/user)
        const probeKey = `${req.ip}_${pc}_${street}`;
        const probeCount = (probeTracker.get(probeKey) || 0) + 1;
        probeTracker.set(probeKey, probeCount);

        if (probeCount > 30) {
            logger.warn(`[Suspicious Probe] Excessive number probes on ${pc} ${street} from ${req.ip}`);
            return res.status(429).json({
                error: 'Too many validation requests for this street. Please try again shortly.'
            });
        }

        const db = req.app.locals.db || mongoose.connection.db;
        const coll = db.collection('address_master_merged');

        const isFull = /^[A-Z]{1,2}[0-9][A-Z0-9]?\s+[0-9][A-Z]{2}$/i.test(pc);
        let rows = [];

        if (isFull) {
            rows = await coll.find({ postcode: pc })
                .project({ address: 1, district: 1, street: 1, postcode: 1 })
                .toArray();
        } else {
            const rangePrefix = pc.includes(' ') ? pc : `${pc} `;
            rows = await coll.find({
                postcode: { $gte: rangePrefix, $lt: `${rangePrefix}\uffff` }
            })
                .project({ address: 1, district: 1, street: 1, postcode: 1 })
                .limit(2500)
                .toArray();

            if (rows.length === 0 && /^([A-Z]{1,2}[0-9])\s+([0-9])$/i.test(pc)) {
                const collapsed = pc.replace(/\s+/g, '');
                const collapsedPrefix = `${collapsed} `;
                rows = await coll.find({
                    postcode: { $gte: collapsedPrefix, $lt: `${collapsedPrefix}\uffff` }
                })
                    .project({ address: 1, district: 1, street: 1, postcode: 1 })
                    .limit(2500)
                    .toArray();
                if (rows.length > 0) pc = collapsed;
            }
        }

        let town = rows[0]?.district || '';
        if (!town && streetCache.has(pc)) {
            town = streetCache.get(pc)?.town || '';
        }

        // Match in-memory
        let matchedBuilding = null;
        let matchedRangeLabel = null;
        let matchedRowPostcode = null;
        let isMatched = false;

        const streetLower = street.toLowerCase();

        for (const row of rows) {
            const parsed = parseAddressRow(row.address);
            if (!parsed) continue;

            const candidateStreet = parsed.street || (parsed.premises && parsed.premises.length > 0 ? cleanStreetName(parsed.premises.join(', ')) : null);
            if (!candidateStreet || candidateStreet.toLowerCase() !== streetLower) continue;

            if (!matchedRowPostcode && row.postcode) {
                matchedRowPostcode = row.postcode;
            }

            // Check house number match
            if (typedNumber) {
                const parsedNum = parsed.numberPart || '';
                if (parsedNum) {
                    const rangeMatch = parsedNum.match(/^(\d+)-(\d+)$/);
                    if (rangeMatch) {
                        const low = parseInt(rangeMatch[1], 10);
                        const high = parseInt(rangeMatch[2], 10);
                        const n = parseInt(typedNumber, 10);
                        if (!isNaN(n) && n >= low && n <= high) {
                            isMatched = true;
                            matchedRangeLabel = parsedNum;
                            if (row.postcode) matchedRowPostcode = row.postcode;
                            if (parsed.street && parsed.premises && parsed.premises.length > 0) {
                                matchedBuilding = parsed.premises.join(', ');
                            }
                            break;
                        }
                    } else if (parsedNum.toLowerCase() === typedNumber.toLowerCase()) {
                        isMatched = true;
                        matchedRangeLabel = parsedNum;
                        if (row.postcode) matchedRowPostcode = row.postcode;
                        if (parsed.street && parsed.premises && parsed.premises.length > 0) {
                            matchedBuilding = parsed.premises.join(', ');
                        }
                        break;
                    } else if (/^\d+$/.test(typedNumber) && parsedNum.toLowerCase().startsWith(typedNumber.toLowerCase())) {
                        isMatched = true;
                        matchedRangeLabel = parsedNum;
                        if (row.postcode) matchedRowPostcode = row.postcode;
                        if (parsed.street && parsed.premises && parsed.premises.length > 0) {
                            matchedBuilding = parsed.premises.join(', ');
                        }
                        break;
                    }
                }
            }

            // Check house/building name match
            if (typedName && parsed.premises && parsed.premises.length > 0) {
                const rowPremises = parsed.premises.join(' ').toLowerCase();
                if (rowPremises === typedName.toLowerCase() || rowPremises.includes(typedName.toLowerCase())) {
                    isMatched = true;
                    if (row.postcode) matchedRowPostcode = row.postcode;
                    if (parsed.street) {
                        matchedBuilding = parsed.premises.join(', ');
                    }
                    if (parsed.numberPart) matchedRangeLabel = parsed.numberPart;
                    break;
                }
            }
        }

        const finalPostcode = (!isFull && matchedRowPostcode) ? matchedRowPostcode : pc;

        // Detect structural unit hints (up to 3 labels in fixed order: Floor/Level, Block, Flat, Apartment, Suite, Unit, Room, Studio)
        const unitHints = detectUnitHints(rows, streetLower, typedNumber, typedName);

        // Final address assembly (fixed order: unit, building name, number and street, town, postcode)
        const line1Parts = [];
        if (typedUnit) line1Parts.push(typedUnit);
        if (matchedBuilding) {
            line1Parts.push(matchedBuilding);
        } else if (typedName && !typedNumber) {
            line1Parts.push(typedName);
        }

        const streetLine = typedNumber ? `${typedNumber} ${street}` : street;
        line1Parts.push(streetLine);

        const formattedAddress = {
            line1: line1Parts.join(', '),
            line2: '',
            locality: '',
            town,
            postcode: finalPostcode,
            formatted: [line1Parts.join(', '), town, finalPostcode].filter(Boolean).join(', ')
        };

        // Track userEntered fields
        const userEntered = [];
        if (typedNumber) userEntered.push('number');
        if (typedName) userEntered.push('name');
        if (typedUnit) userEntered.push('unit');

        // Validated booleans per specification (number and unit are unverified/false)
        const validated = {
            postcode: true,
            street: true,
            number: false,
            unit: false
        };

        // Record search session in usage
        await recordUsage(req.user, 'rm_validate', `${finalPostcode} ${street}`);

        return res.json({
            status: isMatched ? 'matched' : 'street_confirmed',
            message: 'Postcode and street confirmed',
            validated,
            address: formattedAddress,
            userEntered,
            unitHints,
            buildingName: matchedBuilding || null,
            rangeLabel: matchedRangeLabel || null
        });
    } catch (err) {
        logger.error(`validateAddress error: ${err.message}`);
        return res.status(500).json({ error: 'Address validation failed' });
    }
};

// ============================================================================
// 3b. POST /api/rm/locate (Server-side geocoding)
// ============================================================================
const locateAddressHandler = async (req, res) => {
    try {
        const { postcode: rawPc, street: rawStreet, number: rawNumber, unit: rawUnit } = req.body || {};
        const pc = normalizePostcode(rawPc);
        if (!pc) {
            return res.status(400).json({ error: 'Valid postcode is required for geocoding' });
        }

        const street = sanitizeInput(rawStreet);
        const number = sanitizeInput(rawNumber);
        const unit = sanitizeInput(rawUnit);

        const result = await locateAddress({ postcode: pc, street, number, unit });
        return res.json(result);
    } catch (err) {
        logger.error(`locateAddressHandler error: ${err.message}`);
        return res.status(500).json({ error: 'Address location failed' });
    }
};

// ============================================================================
// 4. GET /api/rm/business?area=&q=
// ============================================================================
const findBusiness = async (req, res) => {
    try {
        const areaRaw = (req.query.area || '').trim().toUpperCase();
        const qRaw = (req.query.q || '').trim();

        if (!areaRaw) {
            return res.json([]);
        }

        if (!qRaw || qRaw.length < 4) {
            return res.json([]);
        }

        // Filter stop words
        const words = qRaw.toLowerCase().split(/\s+/).filter(w => w.length > 0);
        const significantWords = words.filter(w => !BUSINESS_STOP_WORDS.has(w));

        if (!significantWords.length) {
            return res.json([]);
        }

        const db = req.app.locals.db || mongoose.connection.db;
        const dictColl = db.collection('search_dictionary');
        const chColl = db.collection('ch_data');

        const cleanQ = significantWords.join(' ');
        const regexTerm = new RegExp('(^|\\s)' + cleanQ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

        // Check if area is postcode area (e.g. HU) or town (e.g. HULL)
        const isPostcodeArea = /^[A-Z]{1,2}$/.test(areaRaw);

        // 1. Query search_dictionary for premises
        const premisesQuery = {
            type: 'premises',
            ...(isPostcodeArea
                ? { postcodes: { $regex: `^${areaRaw}[0-9]` } }
                : { town: areaRaw }),
            $or: [
                { key: { $regex: `^${cleanQ}`, $options: 'i' } },
                { tokens: { $in: significantWords } },
                { display: regexTerm }
            ]
        };

        const [premisesRows, chRows] = await Promise.all([
            dictColl.find(premisesQuery).limit(50).project({
                display: 1, street: 1, town: 1, postcodes: 1, _id: 0
            }).toArray().catch(() => []),

            chColl.find({
                CompanyStatus: 'Active',
                ...(isPostcodeArea
                    ? { 'RegAddress.PostCode': { $regex: `^${areaRaw}[0-9]` } }
                    : { 'RegAddress.PostTown': areaRaw }),
                CompanyName: regexTerm
            }).limit(50).project({
                CompanyName: 1,
                CompanyNumber: 1,
                'RegAddress.AddressLine1': 1,
                'RegAddress.PostTown': 1,
                'RegAddress.PostCode': 1,
                _id: 0
            }).toArray().catch(() => [])
        ]);

        const combined = [];
        const seen = new Set();

        // Format premises docs
        for (const p of premisesRows) {
            const name = (p.street || p.display || '').split(',')[0].trim();
            if (!name || name.length < 3) continue;

            const nameLower = name.toLowerCase();
            // Drop house-style names
            if (HOUSE_STYLE_SUFFIXES.some(s => nameLower.endsWith(s))) continue;

            const street = p.town ? `${p.town}` : '';
            const pc = p.postcodes?.[0] || '';
            const key = `${name.toLowerCase()}_${pc}`;

            if (!seen.has(key)) {
                seen.add(key);
                combined.push({
                    name,
                    street: p.street || p.display || '',
                    postcode: pc,
                    town: p.town || areaRaw,
                    source: 'RM'
                });
            }
        }

        // Format CH docs
        for (const ch of chRows) {
            const name = ch.CompanyName || '';
            const pc = ch['RegAddress.PostCode'] || '';
            const key = `${name.toLowerCase()}_${pc}`;

            if (!seen.has(key)) {
                seen.add(key);
                combined.push({
                    name,
                    street: ch['RegAddress.AddressLine1'] || '',
                    postcode: pc,
                    town: ch['RegAddress.PostTown'] || areaRaw,
                    source: 'Companies House'
                });
            }
        }

        // Rank names with business indicators first
        combined.sort((a, b) => {
            const aHasInd = BUSINESS_INDICATORS.some(ind => a.name.toLowerCase().includes(ind));
            const bHasInd = BUSINESS_INDICATORS.some(ind => b.name.toLowerCase().includes(ind));
            if (aHasInd && !bHasInd) return -1;
            if (!aHasInd && bHasInd) return 1;
            return a.name.localeCompare(b.name);
        });

        const results = combined.slice(0, 50);

        if (!results.length) {
            try {
                await NotFoundQueue.create({
                    type: 'rm_business',
                    query: `${areaRaw} ${qRaw}`,
                    userId: req.user?._id || null,
                    date: new Date()
                });
            } catch (_) {}
        }

        await recordUsage(req.user, 'rm_business', `${areaRaw} ${qRaw}`);

        return res.json(results);
    } catch (err) {
        logger.error(`findBusiness error: ${err.message}`);
        return res.status(500).json({ error: 'Business search failed' });
    }
};

// ============================================================================
// 5. GET /api/rm/areas?q= (Autocomplete for Towns / Postcode Areas)
// ============================================================================
const getAreas = async (req, res) => {
    try {
        const qRaw = (req.query.q || '').trim().toUpperCase();
        if (!qRaw || qRaw.length < 2) return res.json([]);

        if (areaCache.has(qRaw)) {
            return res.json(areaCache.get(qRaw));
        }

        const db = req.app.locals.db || mongoose.connection.db;
        const coll = db.collection('postcode_district');

        // Fast distinct on indexed district
        const towns = await coll.distinct('district', {
            district: { $regex: `^${qRaw}` }
        });

        const results = towns.slice(0, 15).map(t => ({
            area: t,
            type: 'Town'
        }));

        areaCache.set(qRaw, results);
        return res.json(results);
    } catch (err) {
        logger.error(`getAreas error: ${err.message}`);
        return res.status(500).json({ error: 'Failed to look up areas' });
    }
};

// ============================================================================
// 6. GET /api/rm/nominatim-search (Direct self-hosted Nominatim UK search)
// ============================================================================
const nominatimSearch = async (req, res) => {
    try {
        const { q, street, city, county, state, country, postalcode, limit } = req.query;
        const hasInput = [q, street, city, county, state, postalcode].some(v => v && String(v).trim().length > 0);
        if (!hasInput) {
            return res.json({ results: [] });
        }

        const results = await searchNominatim({
            q: sanitizeInput(q, 160),
            street: sanitizeInput(street, 100),
            city: sanitizeInput(city, 60),
            county: sanitizeInput(county, 60),
            state: sanitizeInput(state, 60),
            country: sanitizeInput(country || 'United Kingdom', 60),
            postalcode: sanitizeInput(postalcode, 20),
            limit
        });

        return res.json({ results });
    } catch (err) {
        logger.error(`nominatimSearch error: ${err.message}`);
        return res.status(500).json({ error: 'Map search failed', results: [] });
    }
};

// ============================================================================
// 7. GET /api/rm/nominatim-reverse (Direct self-hosted Nominatim UK reverse)
// ============================================================================
const nominatimReverse = async (req, res) => {
    try {
        const lat = parseFloat(req.query.lat);
        const lon = parseFloat(req.query.lon);
        const zoom = parseInt(req.query.zoom, 10) || 18;

        if (isNaN(lat) || isNaN(lon)) {
            return res.status(400).json({ error: 'Valid latitude and longitude are required' });
        }

        const result = await reverseNominatim({ lat, lon, zoom });
        return res.json({ result });
    } catch (err) {
        logger.error(`nominatimReverse error: ${err.message}`);
        return res.status(500).json({ error: 'Reverse lookup failed' });
    }
};

module.exports = {
    getPostcodes,
    getStreets,
    validateAddress,
    locateAddress: locateAddressHandler,
    findBusiness,
    getAreas,
    nominatimSearch,
    nominatimReverse,
    parseAddressRow,
    cleanStreetName,
    normalizePostcode
};
