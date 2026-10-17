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
    'quay', 'wharf', 'fields', 'village'
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
 * Normalise postcode string (handles full postcodes, sectors e.g. DN41 7, and outcodes)
 */
function normalizePostcode(raw) {
    if (!raw) return '';
    const s = String(raw).trim().toUpperCase();

    // 1. Full postcode: "DN41 7RU" or "DN417RU"
    const fullMatch = s.match(/^([A-Z]{1,2}[0-9][A-Z0-9]?)\s*([0-9][A-Z]{2})$/i);
    if (fullMatch) {
        return `${fullMatch[1]} ${fullMatch[2]}`;
    }

    // 2. Sector: "DN41 7" or "DN417"
    const sectorMatch = s.match(/^([A-Z]{1,2}[0-9][A-Z0-9]?)\s*([0-9])$/i);
    if (sectorMatch) {
        return `${sectorMatch[1]} ${sectorMatch[2]}`;
    }

    // 3. Outcode only: "DN41"
    const outcodeMatch = s.match(/^([A-Z]{1,2}[0-9][A-Z0-9]?)$/i);
    if (outcodeMatch) {
        return outcodeMatch[1];
    }

    // Fallback: clean alphanumeric
    const clean = s.replace(/[^A-Z0-9]/g, '');
    if (clean.length > 3) {
        return `${clean.slice(0, -3)} ${clean.slice(-3)}`;
    }
    return clean;
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

        // Full postcode regex: e.g. "DN41 7RU" or "DN417RU"
        const fullPcRegex = /^([A-Z]{1,2}[0-9][A-Z0-9]?)\s*([0-9][A-Z]{2})$/i;
        const fullMatch = rawQ.match(fullPcRegex);

        let queryPostcode = '';
        let isFull = false;

        if (fullMatch) {
            queryPostcode = `${fullMatch[1]} ${fullMatch[2]}`;
            isFull = true;
        } else {
            // Check for prefix: outward code + space + at least 1 digit of inward code
            // e.g. "DN41 7", "M1 1", "WC1A 1"
            const prefixRegex = /^([A-Z]{1,2}[0-9][A-Z0-9]?)\s+([0-9][A-Z0-9]?)$/i;
            const prefixMatch = rawQ.match(prefixRegex);

            if (!prefixMatch) {
                // Ambiguous without space (e.g. "M11") or incomplete outward code (e.g. "DN41")
                return res.json({
                    postcodes: [],
                    hint: 'Enter a postcode, for example DN41 7'
                });
            }

            queryPostcode = `${prefixMatch[1]} ${prefixMatch[2]}`;
        }

        const db = req.app.locals.db || mongoose.connection.db;
        const coll = db.collection('postcode_district');

        if (isFull) {
            // Exact full postcode query (must be an active postcode)
            const exactDoc = await coll.findOne({
                postcode: queryPostcode,
                district: { $ne: 'NOT ACTIVE' }
            });
            if (!exactDoc) {
                // Record unrecognised valid postcode in Not Found Queue
                try {
                    await NotFoundQueue.create({
                        type: 'rm_postcode',
                        query: queryPostcode,
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

        // Prefix range query: $gte: queryPostcode, $lt: nextPrefix
        // e.g. "DN41 7" -> next prefix: last char + 1 or next sector
        const prefixParts = queryPostcode.split(' ');
        const outcode = prefixParts[0];
        const inwardPrefix = prefixParts[1]; // e.g. "7"
        
        // Calculate upper bound for range
        const nextChar = String.fromCharCode(inwardPrefix.charCodeAt(inwardPrefix.length - 1) + 1);
        const upperInward = inwardPrefix.slice(0, -1) + nextChar;
        const upperBound = `${outcode} ${upperInward}`;

        const limit = 120;
        const cursor = coll.find({
            postcode: { $gte: queryPostcode, $lt: upperBound },
            district: { $ne: 'NOT ACTIVE' }
        }).project({ postcode: 1, district: 1, _id: 0 }).sort({ postcode: 1 }).limit(limit + 1);

        const rows = await cursor.toArray();
        const activeRows = rows.filter(r => r.district && r.district.trim().toUpperCase() !== 'NOT ACTIVE');
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
const getStreets = async (req, res) => {
    try {
        const rawPc = (req.query.postcode || '').trim().toUpperCase();
        const pc = normalizePostcode(rawPc);

        if (!pc || !pc.includes(' ')) {
            return res.status(400).json({ error: 'Valid full postcode is required' });
        }

        // Check LRU cache
        if (streetCache.has(pc)) {
            return res.json(streetCache.get(pc));
        }

        const db = req.app.locals.db || mongoose.connection.db;
        const coll = db.collection('address_master_merged');

        const isFull = /^[A-Z]{1,2}[0-9][A-Z0-9]?\s+[0-9][A-Z]{2}$/i.test(pc);
        let rows = [];

        if (isFull) {
            rows = await coll.find({ postcode: pc })
                .project({ address: 1, district: 1, street: 1 })
                .toArray();
        } else {
            // Sector or prefix query e.g. "DN41 7"
            const escaped = pc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            rows = await coll.find({ postcode: { $regex: `^${escaped}` } })
                .project({ address: 1, district: 1, street: 1 })
                .limit(3000)
                .toArray();
        }

        if (!rows.length) {
            return res.json({ postcode: pc, streets: [], town: '', preselect: false, manualEntry: true });
        }

        let town = '';
        const streetSet = new Set();

        for (const row of rows) {
            if (!town && row.district) town = row.district;
            if (row.street) {
                streetSet.add(cleanStreetName(row.street));
            } else if (row.address) {
                const parsed = parseAddressRow(row.address);
                if (parsed && parsed.street) {
                    streetSet.add(parsed.street);
                }
            }
        }

        const uniqueStreets = Array.from(streetSet).sort((a, b) => a.localeCompare(b));
        const centroid = await getPostcodeCentroid(pc);
        const payload = {
            postcode: pc,
            town,
            streets: uniqueStreets,
            preselect: uniqueStreets.length === 1,
            manualEntry: uniqueStreets.length === 0,
            centroid: centroid ? { lat: centroid.lat, lon: centroid.lon } : null
        };

        streetCache.set(pc, payload);
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
        const pc = normalizePostcode(rawPc);
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
            const escaped = pc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            rows = await coll.find({ postcode: { $regex: `^${escaped}` } })
                .project({ address: 1, district: 1, street: 1, postcode: 1 })
                .limit(2000)
                .toArray();
        }

        const town = rows[0]?.district || '';

        // Match in-memory
        let matchedBuilding = null;
        let matchedRangeLabel = null;
        let isMatched = false;

        const streetLower = street.toLowerCase();

        for (const row of rows) {
            const parsed = parseAddressRow(row.address);
            if (!parsed || !parsed.street) continue;

            if (parsed.street.toLowerCase() !== streetLower) continue;

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
                            if (parsed.premises && parsed.premises.length > 0) {
                                matchedBuilding = parsed.premises.join(', ');
                            }
                            break;
                        }
                    } else if (parsedNum.toLowerCase() === typedNumber.toLowerCase()) {
                        isMatched = true;
                        matchedRangeLabel = parsedNum;
                        if (parsed.premises && parsed.premises.length > 0) {
                            matchedBuilding = parsed.premises.join(', ');
                        }
                        break;
                    } else if (/^\d+$/.test(typedNumber) && parsedNum.toLowerCase().startsWith(typedNumber.toLowerCase())) {
                        isMatched = true;
                        matchedRangeLabel = parsedNum;
                        if (parsed.premises && parsed.premises.length > 0) {
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
                    matchedBuilding = parsed.premises.join(', ');
                    if (parsed.numberPart) matchedRangeLabel = parsed.numberPart;
                    break;
                }
            }
        }

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
            postcode: pc,
            formatted: [line1Parts.join(', '), town, pc].filter(Boolean).join(', ')
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
        await recordUsage(req.user, 'rm_validate', `${pc} ${street}`);

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
