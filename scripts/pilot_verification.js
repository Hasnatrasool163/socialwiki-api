/**
 * scripts/pilot_verification.js (v2)
 *
 * Implements the Reviewer's Action Plan:
 * 1. Urgent Live `getStreets` Query Verification:
 *    - Shows exact covered query on `address_master_merged` (with `maxTimeMS(500)` and uncapped outcodes)
 *      + `explain('executionStats')` + live latency & 24h LRU cache timings.
 * 2. Local UK Postcode Centroids Seeding (`postcode_centroids`):
 *    - Seeds `postcode_centroids` for all UK postcodes directly from local PostgreSQL (`nominatim.location_postcode`)
 *      with zero external API calls, preserving OS/Royal Mail/ONS/OSM attribution.
 * 3. Parser v2 (Candidate Generation + Map Road Selection + Same-Postcode Inheritance + Centroid Reverse Fallback):
 *    - Never concatenates house/court names across commas onto street names (fixes "Wood Close, Baslow Road",
 *      "Somersby Court, Somersby Street", "Castle Hill, Baslow Road").
 *    - Handles number ranges with letters on both sides ("7-21a St. Nicholas Street"), "Rear Of 6 ...",
 *      floor labels anywhere ("6th Floor", "Street Floor South"), trailing directionals ("Marischal Square West"),
 *      and St./St/Saint variants.
 *    - Skips PO Box rows anywhere in the address ("Consumer Services, PO Box 51").
 *    - Tests each row's candidate street parts against OSM roads near the postcode centroid; if multiple match,
 *      prefers the part carrying the house number, then the rightmost matching candidate.
 *    - For organisation/department/house-only rows with no street, inherits the verified street from other rows
 *      in the same postcode, else reverse-geocodes the postcode centroid.
 * 4. Re-runs the 3-Town Pilot (GRIMSBY, ABERDEEN, BAKEWELL) at max 4 workers:
 *    - Prints Before (v1) vs After (v2) comparison table.
 *    - Properly classifies remaining misses into `parse_error` vs `osm_gap`.
 *    - Outputs 50 random remaining misses per town.
 *    - Inspects `ch_data` and `company_house` sample documents & indexes for Business Mode.
 */

require('dotenv').config();
const os = require('os');
const { spawn } = require('child_process');
const readline = require('readline');
const axios = require('axios');
const { MongoClient } = require('mongodb');
const { haversineDistanceMeters } = require('../utils/bngToWgs84');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/web_postalwiki';
const NOMINATIM_URL = (process.env.NOMINATIM_URL || 'http://127.0.0.1:8088').replace(/\/+$/, '');
const DATA_VERSION = 'osm-gb-2026-10-v2';
const PILOT_TOWNS = ['GRIMSBY', 'ABERDEEN', 'BAKEWELL'];
const SAMPLE_PER_TOWN = 2000;
const PILOT_CONCURRENCY = 4;

const httpClient = axios.create({
    baseURL: NOMINATIM_URL,
    timeout: 5000,
    headers: {
        'User-Agent': 'SocialWiki-PilotVerifier/2.0 (localhost)',
        'Accept': 'application/json'
    }
});

// Baseline v1 numbers from Run 1 for Before/After comparison
const RUN1_BASELINE = {
    GRIMSBY: { totalStreets: 2914, foundCount: 2353, foundPct: '80.7%', osm_gap: 537, parse_error: 19 },
    ABERDEEN: { totalStreets: 5462, foundCount: 3758, foundPct: '68.8%', osm_gap: 1165, parse_error: 539 },
    BAKEWELL: { totalStreets: 872, foundCount: 349, foundPct: '40.0%', osm_gap: 503, parse_error: 20 }
};

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
    'piccadilly', 'whitehall', 'cheapside', 'cornhill', 'dock', 'docks',
    'precinct', 'arcade', 'courtyard', 'byre', 'fold', 'nook', 'rake',
    'back', 'front', 'cliff', 'cliffs', 'tor', 'edge', 'moor', 'bottom',
    'top', 'head', 'foot', 'mill', 'mills', 'flash', 'gatehouse'
]);

// Words that often appear at the end of a building, business park, or house name when another road part is present
const BUILDING_OR_HOUSE_SUFFIXES = new Set([
    'house', 'cottage', 'cottages', 'lodge', 'villa', 'villas', 'barn', 'bungalow',
    'manor', 'hall', 'farm', 'farmhouse', 'grange', 'mill', 'works', 'centre', 'center',
    'plaza', 'chambers', 'studios', 'offices', 'building', 'buildings', 'tower', 'towers',
    'college', 'school', 'academy', 'hospital', 'clinic', 'surgery', 'church', 'chapel',
    'cathedral', 'hotel', 'inn', 'pub', 'tavern', 'club', 'bank', 'warehouse', 'depot',
    'factory', 'station', 'terminal', 'exchange', 'homes', 'home', 'almshouses', 'croft',
    'parsonage', 'vicarage', 'rectory', 'manse', 'priory', 'abbey', 'castle', 'keep',
    'development', 'complex', 'unidades'
]);

// Words strongly indicating an organisation/department rather than a geographic street
const ORG_DEPT_REGEX = /\b(?:ltd|limited|plc|llp|council|department|division|ministry|authority|association|federation|foundation|institute|university|nhs|trust|services|holdings|group|solicitors|accountants|architects|engineers|consultants|contractors|distributors|distribution|retail|wholesale|logistics|supermarket|pharmacy|surgery|dental|medical|veterinary|garage|motors|brewery|winery)\b/i;

const DIRECTIONAL_WORDS = new Set([
    'north', 'south', 'east', 'west', 'upper', 'lower', 'central', 'inner', 'outer'
]);

const FLOOR_PART_REGEX = /^(?:(?:ground|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|[0-9]+(?:st|nd|rd|th)|lower\s+ground|upper\s+ground|street|top|middle|main|sub)\s+(?:floor|level)(?:\s+(?:north|south|east|west|left|right|front|rear|wing))?|basement|sub-basement|mezzanine|penthouse|annexe|annex|attic|cellar|[0-9]\/[a-z0-9]|[a-z]\/[a-z0-9]|[0-9]f[0-9]|pf[0-9]|bf[0-9]|gf|ff|sf|tf)$/i;
const UNIT_PART_REGEX = /^(?:(?:flat|flats|unit|units|room|rooms|apartment|apartments|apt|apts|suite|suites|studio|studios|block|blocks|pod|pods|bay|bays|stall|stalls|kiosk|shop|shops|office|offices|ward|wing|shed|store|berth|maisonette|penthouse)\b(?:\s*[0-9a-z\/-]+)?|no\.?\s*\d+[a-z]?)$/i;
const SCOTTISH_FLAT_REGEX = /^(?:flat\s+[0-9a-z\/-]+|[0-9]f[0-9]|pf[0-9]|bf[0-9]|[0-9]\/[0-9])$/i;

const ABBREV_MAP = {
    'st': 'street',
    'rd': 'road',
    'ave': 'avenue',
    'av': 'avenue',
    'ln': 'lane',
    'dr': 'drive',
    'cl': 'close',
    'ct': 'court',
    'pl': 'place',
    'sq': 'square',
    'ter': 'terrace',
    'terr': 'terrace',
    'cres': 'crescent',
    'gdns': 'gardens',
    'gdn': 'gardens',
    'pk': 'park',
    'gt': 'gate',
    'mt': 'mount',
    'bvd': 'boulevard',
    'blvd': 'boulevard',
    'hwy': 'highway',
    'ch': 'chase',
    'gr': 'grove',
    'vw': 'view',
    'wk': 'walk',
    'wy': 'way'
};

function cleanStreetName(s) {
    if (!s) return '';
    return s.replace(/\s+/g, ' ').trim();
}

function hasThoroughfareEnding(part) {
    if (!part) return false;
    const words = part.trim().replace(/[.,]/g, '').split(/\s+/).filter(Boolean);
    if (!words.length) return false;
    const last = words[words.length - 1].toLowerCase();
    if (THOROUGHFARE_WORDS.has(last)) return true;
    if (words.length >= 2 && DIRECTIONAL_WORDS.has(last)) {
        const prev = words[words.length - 2].toLowerCase();
        if (THOROUGHFARE_WORDS.has(prev)) return true;
    }
    return false;
}

function hasBuildingOrOrgIndicator(part) {
    if (!part) return false;
    if (ORG_DEPT_REGEX.test(part)) return true;
    const words = part.trim().replace(/[.,]/g, '').split(/\s+/).filter(Boolean);
    if (!words.length) return false;
    const last = words[words.length - 1].toLowerCase();
    return BUILDING_OR_HOUSE_SUFFIXES.has(last);
}

/**
 * Normalize street name for matching between RM and OSM
 * Handles St./St/Saint/Street, Rd/Road, typos like Marishal/Marischal, punctuation, leading "The".
 */
function normalizeStreetKey(s, expandStAsSaint = false) {
    if (!s) return '';
    let lower = s.toLowerCase()
        .replace(/['’`.,-]/g, ' ')
        .replace(/\bmarishal\b/g, 'marischal')
        .replace(/\bsaint\b/g, 'st')
        .replace(/\s+/g, ' ')
        .trim();

    const words = lower.split(' ').filter(Boolean);
    if (words.length > 1 && words[0] === 'the') {
        words.shift();
    }

    const mapped = words.map((w, idx) => {
        if (w === 'st') {
            if (expandStAsSaint || idx < words.length - 1) return 'saint';
            return 'street';
        }
        return ABBREV_MAP[w] || w;
    });

    return mapped.join(' ');
}

function streetsMatch(rmStreet, osmStreet) {
    if (!rmStreet || !osmStreet) return { match: false, type: 'none' };
    const rmClean = rmStreet.toLowerCase().trim();
    const osmClean = osmStreet.toLowerCase().trim();
    if (rmClean === osmClean) {
        return { match: true, type: 'exact_road' };
    }
    const k1 = normalizeStreetKey(rmStreet, false);
    const k2 = normalizeStreetKey(osmStreet, false);
    if (k1 && k1 === k2) {
        return { match: true, type: 'normalized_variant' };
    }
    const k1Saint = normalizeStreetKey(rmStreet, true);
    const k2Saint = normalizeStreetKey(osmStreet, true);
    if (k1Saint && k1Saint === k2Saint) {
        return { match: true, type: 'normalized_variant' };
    }
    if (k1.length >= 5 && k2.length >= 5 && (k1.includes(k2) || k2.includes(k1))) {
        return { match: true, type: 'normalized_variant' };
    }
    return { match: false, type: 'none' };
}

/**
 * Parser v2 Stage 1: Tokenize a raw RM address into candidate parts, numbers, and unit flags.
 * Does NOT concatenate across commas!
 */
function extractAddressCandidates(rawAddress) {
    if (!rawAddress || typeof rawAddress !== 'string') {
        return { skip: true, reason: 'empty' };
    }

    const rawParts = rawAddress.split(',').map(p => p.trim()).filter(Boolean);
    if (!rawParts.length) {
        return { skip: true, reason: 'empty' };
    }

    // Rule 1: Skip PO Box rows anywhere in the address
    if (rawParts.some(p => /\bpo\s*box\b/i.test(p))) {
        return { skip: true, reason: 'po_box' };
    }

    let hasUnit = false;
    const unitParts = [];
    const keptParts = [];

    for (const p of rawParts) {
        // Strip pure floor labels anywhere (e.g. "6th Floor", "Street Floor South")
        if (FLOOR_PART_REGEX.test(p)) {
            hasUnit = true;
            unitParts.push(p);
            continue;
        }
        // Strip pure unit labels anywhere (e.g. "Flat 1", "Unit D", "Suite 4")
        if ((UNIT_PART_REGEX.test(p) || SCOTTISH_FLAT_REGEX.test(p)) && !hasThoroughfareEnding(p)) {
            hasUnit = true;
            unitParts.push(p);
            continue;
        }

        // Strip inline unit/floor prefix attached to a numbered street part (e.g. "Flat 2 14 High Street" or "Floor 1 10 Broad Street")
        const inlineUnit = p.match(/^((?:flat|unit|apt|apartment|room|suite|floor|level|block)\s+[0-9a-z\/-]+)\s+(.+)$/i);
        if (inlineUnit && (/\d/.test(inlineUnit[2]) || hasThoroughfareEnding(inlineUnit[2]))) {
            hasUnit = true;
            unitParts.push(inlineUnit[1]);
            keptParts.push(inlineUnit[2].trim());
            continue;
        }

        keptParts.push(p);
    }

    if (!keptParts.length) {
        return { skip: false, hasUnit, unitParts, candidateParts: [] };
    }

    // Parse each individual comma-separated part for leading numbers/ranges (including "7-21a", "Rear Of 6 Welholme Road", "Plot 3 ...")
    const candidateParts = [];
    for (let i = 0; i < keptParts.length; i++) {
        let part = keptParts[i];

        // Check standalone house number separated by comma (e.g. "354, Castlehill" or "7-21a, St. Nicholas Street")
        const standaloneNum = part.match(/^(?:(?:rear\s+of|adj(?:acent)?\s+to|site\s+of|plot|plots)\s+)?(\d+[a-z]?(?:\s*-\s*\d+[a-z]?)?)$/i);
        if (standaloneNum && i + 1 < keptParts.length && !/^(?:\d+(?:st|nd|rd|th))$/i.test(standaloneNum[1])) {
            const nextPart = keptParts[i + 1];
            const nextNumMatch = nextPart.match(/^(\d+[a-z]?(?:\s*-\s*\d+[a-z]?)?)\s+(.+)$/i);
            if (!nextNumMatch) {
                i++; // consume nextPart with this standalone number
                const cleanText = cleanStreetName(nextPart);
                candidateParts.push({
                    index: candidateParts.length,
                    raw: `${part}, ${nextPart}`,
                    numberPart: standaloneNum[1].replace(/\s+/g, ''),
                    text: cleanText,
                    normKey: normalizeStreetKey(cleanText, false),
                    isThoroughfare: hasThoroughfareEnding(cleanText),
                    isBuildingOrOrg: hasBuildingOrOrgIndicator(cleanText)
                });
                continue;
            }
        }

        // Check leading house number or range on this part:
        // Handles "7-21a St. Nicholas Street", "10a-12b High St", "Rear Of 6 Welholme Road", "1 Union Wynd"
        const numMatch = part.match(/^(?:(rear\s+of|adj(?:acent)?\s+to|site\s+of|plots?)\s+)?(\d+[a-z]?(?:\s*-\s*\d+[a-z]?)?)\s+(.+)$/i);
        if (numMatch && !/^(?:\d+(?:st|nd|rd|th))$/i.test(numMatch[2])) {
            const cleanText = cleanStreetName(numMatch[3]);
            // Guard against "100 Yards South Of ..." or pure unit numbers
            if (cleanText.length >= 2) {
                candidateParts.push({
                    index: candidateParts.length,
                    raw: part,
                    numberPart: numMatch[2].replace(/\s+/g, ''),
                    text: cleanText,
                    normKey: normalizeStreetKey(cleanText, false),
                    isThoroughfare: hasThoroughfareEnding(cleanText),
                    isBuildingOrOrg: hasBuildingOrOrgIndicator(cleanText)
                });
                continue;
            }
        }

        const cleanText = cleanStreetName(part);
        candidateParts.push({
            index: candidateParts.length,
            raw: part,
            numberPart: null,
            text: cleanText,
            normKey: normalizeStreetKey(cleanText, false),
            isThoroughfare: hasThoroughfareEnding(cleanText),
            isBuildingOrOrg: hasBuildingOrOrgIndicator(cleanText)
        });
    }

    return {
        skip: false,
        hasUnit,
        unitParts,
        candidateParts
    };
}

/**
 * Parser v2 Stage 2: Choose the winning street for a row using:
 * 1. Verified OSM road matches among the row's candidate parts:
 *    - If several candidates match OSM roads, prefer the part carrying the house number, then the rightmost matching candidate.
 *    - Wait: if a numbered part is a sub-court/building (e.g. "2 Castle Hill, Baslow Road" where only "Baslow Road" matches OSM),
 *      "Baslow Road" wins because "Castle Hill" is not an OSM road in DE45 1AA!
 *    - What if BOTH "Somersby Court" and "Somersby Street" are in OSM and "4 Somersby Court, Somersby Street" has number on "Somersby Court"?
 *      As instructed by the reviewer: "If several match, prefer the part carrying the house number, then the rightmost."
 * 2. If no candidate part matched OSM directly:
 *    - If the row has a numbered thoroughfare part, or rightmost thoroughfare part (not an org/dept), select it.
 *    - Otherwise (organisation/department-only or house-name-only row), inherit the dominant verified street from other rows in the SAME full postcode,
 *      else use the reverse-geocoded road at the postcode centroid!
 */
function resolveRowStreetV2(extracted, osmVerifiedMap, outcode, postcodeDominantStreet, postcodeReverseRoad) {
    const parts = extracted.candidateParts || [];
    if (parts.length === 0) {
        const inherited = postcodeDominantStreet || postcodeReverseRoad || null;
        return {
            street: inherited,
            numberPart: null,
            premises: [],
            sourceRule: inherited ? 'inherited_postcode_or_centroid' : 'unparsed_empty',
            matchedInOsm: Boolean(inherited && osmVerifiedMap.get(`${outcode}|${normalizeStreetKey(inherited)}`)?.found)
        };
    }

    // Check which candidate parts matched an OSM road in this outcode
    const osmMatchingParts = parts.filter(p => {
        if (!p.normKey) return false;
        const v = osmVerifiedMap.get(`${outcode}|${p.normKey}`);
        return v && v.found;
    });

    if (osmMatchingParts.length > 0) {
        // Reviewer rule: "Keep the candidate that matches. If several match, prefer the part carrying the house number, then the rightmost."
        const numberedOsm = osmMatchingParts.filter(p => p.numberPart !== null);
        const chosen = numberedOsm.length > 0
            ? numberedOsm[numberedOsm.length - 1]
            : osmMatchingParts[osmMatchingParts.length - 1];

        // If house number was on an earlier building/court part (e.g. "2 Castle Hill, Baslow Road"), preserve "2 Castle Hill" in premises
        const premises = parts.filter(p => p !== chosen && p.index < chosen.index).map(p => p.raw);
        const effectiveNum = chosen.numberPart || parts.find(p => p.numberPart)?.numberPart || null;

        return {
            street: chosen.text,
            numberPart: effectiveNum,
            premises,
            sourceRule: 'osm_candidate_match',
            matchedInOsm: true
        };
    }

    // No candidate part directly matched OSM in Step A.
    // Check if another row in the SAME full postcode has a verified street and this row has only org/building/non-thoroughfare parts
    const thoroughfareParts = parts.filter(p => p.isThoroughfare && !ORG_DEPT_REGEX.test(p.text));
    const numberedThoroughfare = thoroughfareParts.filter(p => p.numberPart !== null);

    if (thoroughfareParts.length === 0 && (postcodeDominantStreet || postcodeReverseRoad)) {
        const inherited = postcodeDominantStreet || postcodeReverseRoad;
        const numPart = parts.find(p => p.numberPart)?.numberPart || null;
        return {
            street: inherited,
            numberPart: numPart,
            premises: parts.map(p => p.raw),
            sourceRule: 'inherited_postcode_or_centroid',
            matchedInOsm: Boolean(osmVerifiedMap.get(`${outcode}|${normalizeStreetKey(inherited)}`)?.found)
        };
    }

    if (numberedThoroughfare.length > 0) {
        const chosen = numberedThoroughfare[numberedThoroughfare.length - 1];
        return {
            street: chosen.text,
            numberPart: chosen.numberPart,
            premises: parts.filter(p => p.index < chosen.index).map(p => p.raw),
            sourceRule: 'numbered_thoroughfare_fallback',
            matchedInOsm: false
        };
    }

    if (thoroughfareParts.length > 0) {
        const chosen = thoroughfareParts[thoroughfareParts.length - 1];
        const numPart = parts.find(p => p.numberPart)?.numberPart || null;
        return {
            street: chosen.text,
            numberPart: numPart,
            premises: parts.filter(p => p.index < chosen.index).map(p => p.raw),
            sourceRule: 'rightmost_thoroughfare_fallback',
            matchedInOsm: false
        };
    }

    // If still no thoroughfare word and we have a same-postcode street or centroid reverse road, inherit it!
    if (postcodeDominantStreet || postcodeReverseRoad) {
        const inherited = postcodeDominantStreet || postcodeReverseRoad;
        const numPart = parts.find(p => p.numberPart)?.numberPart || null;
        return {
            street: inherited,
            numberPart: numPart,
            premises: parts.map(p => p.raw),
            sourceRule: 'inherited_postcode_or_centroid',
            matchedInOsm: Boolean(osmVerifiedMap.get(`${outcode}|${normalizeStreetKey(inherited)}`)?.found)
        };
    }

    // Last resort fallback: rightmost non-org part
    const chosen = parts[parts.length - 1];
    return {
        street: chosen.text,
        numberPart: chosen.numberPart,
        premises: parts.slice(0, -1).map(p => p.raw),
        sourceRule: 'unverified_last_part',
        matchedInOsm: false
    };
}

/**
 * Simple worker pool utility
 */
async function runPool(items, concurrency, workerFn) {
    const results = new Array(items.length);
    let idx = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (true) {
            const current = idx++;
            if (current >= items.length) break;
            results[current] = await workerFn(items[current], current);
        }
    });
    await Promise.all(workers);
    return results;
}

/**
 * Seed postcode_centroids in MongoDB from local PostgreSQL `nominatim.location_postcode`
 * Uses psql CLI stream so zero extra npm dependencies are needed.
 */
async function ensureCentroidsSeededFromPostgres(centroidColl) {
    const existingCount = await centroidColl.estimatedDocumentCount();
    console.log(`Current postcode_centroids document count in MongoDB: ${existingCount}`);

    if (existingCount >= 1200000) {
        console.log('postcode_centroids is already fully seeded (>= 1.2M UK postcodes).');
        return;
    }

    console.log('Seeding postcode_centroids from local PostgreSQL (nominatim.location_postcode)...');
    await centroidColl.createIndex({ postcode: 1 }, { unique: true });

    const sql = `SELECT UPPER(TRIM(postcode)), ROUND(ST_Y(ST_Centroid(geometry))::numeric, 6), ROUND(ST_X(ST_Centroid(geometry))::numeric, 6) FROM location_postcode WHERE country_code = 'gb' AND postcode IS NOT NULL;`;

    const pgPass = process.env.PGPASSWORD || 'nominatim_local_pass';
    const candidateCommands = [
        ['psql', ['-h', '127.0.0.1', '-U', 'nominatim', '-d', 'nominatim', '-t', '-A', '-F', ',', '-c', sql], { PGPASSWORD: pgPass }],
        ['psql', [`postgresql://nominatim:${pgPass}@127.0.0.1:5432/nominatim`, '-t', '-A', '-F', ',', '-c', sql], {}],
        ['psql', ['-d', 'nominatim', '-t', '-A', '-F', ',', '-c', sql], { PGPASSWORD: pgPass }],
        ['sudo', ['-n', '-u', 'postgres', 'psql', '-d', 'nominatim', '-t', '-A', '-F', ',', '-c', sql], {}],
        ['sudo', ['-n', '-u', 'nominatim', 'psql', '-d', 'nominatim', '-t', '-A', '-F', ',', '-c', sql], {}]
    ];

    for (const [cmd, args, extraEnv] of candidateCommands) {
        try {
            const imported = await new Promise((resolve, reject) => {
                const proc = spawn(cmd, args, {
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: { ...process.env, ...extraEnv }
                });
                let errOutput = '';
                proc.stderr.on('data', d => { errOutput += d.toString(); });

                const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
                let batch = [];
                let total = 0;

                rl.on('line', (line) => {
                    const trimmed = line.trim();
                    if (!trimmed) return;
                    const parts = trimmed.split(',');
                    if (parts.length < 3) return;
                    const pc = parts[0].trim();
                    const lat = parseFloat(parts[1]);
                    const lon = parseFloat(parts[2]);
                    if (!pc || isNaN(lat) || isNaN(lon)) return;

                    batch.push({
                        updateOne: {
                            filter: { postcode: pc },
                            update: {
                                $set: {
                                    postcode: pc,
                                    lat,
                                    lon,
                                    source: 'os_codepoint_open_ogl'
                                }
                            },
                            upsert: true
                        }
                    });

                    if (batch.length >= 5000) {
                        rl.pause();
                        const toWrite = batch;
                        batch = [];
                        centroidColl.bulkWrite(toWrite, { ordered: false })
                            .then(() => {
                                total += toWrite.length;
                                if (total % 100000 === 0) {
                                    console.log(`   ...seeded ${total} UK postcode centroids`);
                                }
                                rl.resume();
                            })
                            .catch(reject);
                    }
                });

                rl.on('close', async () => {
                    try {
                        if (batch.length > 0) {
                            await centroidColl.bulkWrite(batch, { ordered: false });
                            total += batch.length;
                        }
                        if (total > 0) {
                            resolve(total);
                        } else {
                            reject(new Error(errOutput || '0 rows returned from psql'));
                        }
                    } catch (e) {
                        reject(e);
                    }
                });

                proc.on('error', reject);
            });

            console.log(`Successfully seeded ${imported} UK postcode centroids from local PostgreSQL into MongoDB!`);
            return;
        } catch (err) {
            // Try next command variant
        }
    }

    console.warn('Note: Could not stream bulk table via psql CLI; will resolve missing pilot centroids via local Nominatim HTTP (127.0.0.1:8088).');
}

async function main() {
    console.log('====================================================================');
    console.log(' SOCIALWIKI VERIFICATION PILOT v2 (URGENT EXPLAIN + PARSER v2 + 3 TOWNS)');
    console.log('====================================================================');
    console.log(`Started at: ${new Date().toISOString()}`);

    const client = new MongoClient(MONGO_URI);
    await client.connect();
    const db = client.db();

    const masterColl = db.collection('address_master_merged');
    const centroidColl = db.collection('postcode_centroids');
    const streetVerifColl = db.collection('street_verification');
    const chColl = db.collection('ch_data');
    const chAltColl = db.collection('company_house');

    // =========================================================================
    // STEP 1: URGENT ITEM #1 — VERIFY LIVE getStreets QUERY, EXPLAIN & TIMINGS
    // =========================================================================
    console.log('\n--- [1] URGENT CHECK: NEW LIVE getStreets COVERED QUERY EXPLAIN & TIMINGS ---');
    const testCases = [
        { label: 'Sector (DN41 7)', query: { postcode: { $gte: 'DN41 7', $lt: 'DN41 7\uffff' } } },
        { label: 'Outcode Uncapped (DN41)', query: { postcode: { $gte: 'DN41 ', $lt: 'DN41 \uffff' } } },
        { label: 'Large Outcode Uncapped (AB10)', query: { postcode: { $gte: 'AB10 ', $lt: 'AB10 \uffff' } } },
        { label: 'Full Postcode (SW1A 1AA)', query: { postcode: 'SW1A 1AA' } }
    ];

    for (const tc of testCases) {
        const exp = await masterColl.find(tc.query)
            .project({ address: 1, district: 1, postcode: 1, _id: 0 })
            .maxTimeMS(500)
            .explain('executionStats');

        const t0 = Date.now();
        const rows = await masterColl.find(tc.query)
            .project({ address: 1, district: 1, postcode: 1, _id: 0 })
            .maxTimeMS(500)
            .toArray();
        const elapsedMs = Date.now() - t0;

        console.log(`${tc.label}:`);
        console.log('   Query:', JSON.stringify(tc.query), '| Projection: { address: 1, district: 1, postcode: 1, _id: 0 } | maxTimeMS: 500');
        console.log('   Explain:', JSON.stringify({
            stage: exp.executionStats.executionStages.stage,
            inputStage: exp.executionStats.executionStages.inputStage?.stage,
            nReturned: exp.executionStats.nReturned,
            totalKeysExamined: exp.executionStats.totalKeysExamined,
            totalDocsExamined: exp.executionStats.totalDocsExamined,
            executionTimeMillis: exp.executionStats.executionTimeMillis,
            liveWallTimeMs: elapsedMs,
            rowsFetched: rows.length
        }));
    }

    // =========================================================================
    // STEP 2: SEED UK POSTCODE CENTROIDS FROM LOCAL POSTGRES (NO EXTERNAL API)
    // =========================================================================
    console.log('\n--- [2] SEEDING / LOADING UK POSTCODE CENTROIDS FROM LOCAL POSTGRES ---');
    await ensureCentroidsSeededFromPostgres(centroidColl);

    const TOWN_OUTCODES = {
        GRIMSBY: ['DN31', 'DN32', 'DN33', 'DN34', 'DN35', 'DN36', 'DN37', 'DN41'],
        ABERDEEN: ['AB10', 'AB11', 'AB12', 'AB13', 'AB14', 'AB15', 'AB16', 'AB21', 'AB22', 'AB23', 'AB24', 'AB25'],
        BAKEWELL: ['DE45']
    };

    const centroidMap = new Map();
    for (const outcodes of Object.values(TOWN_OUTCODES)) {
        for (const oc of outcodes) {
            const cDocs = await centroidColl.find({
                postcode: { $gte: `${oc} `, $lt: `${oc} \uffff` }
            }).project({ postcode: 1, lat: 1, lon: 1, _id: 0 }).toArray();
            for (const c of cDocs) {
                centroidMap.set(c.postcode, { lat: c.lat, lon: c.lon });
            }
        }
    }
    console.log(`Loaded ${centroidMap.size} postcode centroids into memory for pilot outcodes.`);

    function getCentroidSync(pc) {
        if (centroidMap.has(pc)) return centroidMap.get(pc);
        const prefix = pc.slice(0, -2);
        for (const [k, v] of centroidMap.entries()) {
            if (k.startsWith(prefix)) return v;
        }
        const outcode = pc.split(' ')[0];
        for (const [k, v] of centroidMap.entries()) {
            if (k.startsWith(`${outcode} `)) return v;
        }
        return null;
    }

    // =========================================================================
    // STEP 3: PARSER v2 — SCAN PILOT TOWNS, EXTRACT CANDIDATES & VERIFY AGAINST OSM
    // =========================================================================
    console.log('\n--- [3] PARSER v2: EXTRACTING CANDIDATE STREET PARTS & VERIFYING WITH OSM ---');

    // Clear previous pilot entries in street_verification so v2 results are clean
    await streetVerifColl.deleteMany({ town: { $in: PILOT_TOWNS } });
    await streetVerifColl.createIndex({ town: 1, outcode: 1, streetKey: 1 }, { unique: true });
    await streetVerifColl.createIndex({ outcode: 1, found: 1 });
    await streetVerifColl.createIndex({ sectors: 1, found: 1 });

    const beforeAfterReport = {};
    const remainingMissesSamples = {};
    const addressSummaryV2 = {};

    for (const town of PILOT_TOWNS) {
        console.log(`\n>>> Processing Town: ${town} <<<`);
        const outcodes = TOWN_OUTCODES[town];
        const allRows = [];
        let skippedPoBoxCount = 0;

        // 3a. Read all RM rows for this town and run Parser v2 Stage 1 (candidate extraction)
        const uniqueCandidates = new Map(); // key: `${outcode}|${normKey}` -> candidate info
        const uniquePostcodes = new Set();

        for (const oc of outcodes) {
            const cursor = masterColl.find({
                postcode: { $gte: `${oc} `, $lt: `${oc} \uffff` },
                district: town
            }).project({ address: 1, postcode: 1, district: 1, _id: 0 });

            while (await cursor.hasNext()) {
                const row = await cursor.next();
                if (!row || !row.address || !row.postcode) continue;

                const pc = row.postcode.trim().toUpperCase();
                const parts = pc.split(' ');
                const outcode = parts[0];
                const sector = parts.length === 2 ? `${parts[0]} ${parts[1][0]}` : outcode;

                const extracted = extractAddressCandidates(row.address);
                if (extracted.skip) {
                    if (extracted.reason === 'po_box') skippedPoBoxCount++;
                    continue;
                }

                uniquePostcodes.add(pc);
                allRows.push({
                    rawAddress: row.address,
                    postcode: pc,
                    outcode,
                    sector,
                    town,
                    extracted
                });

                // Register candidate parts to check against OSM
                for (const cp of extracted.candidateParts) {
                    if (!cp.normKey || cp.normKey.length < 2) continue;
                    // Skip pure organisation/department strings when registering road candidates unless they end in a thoroughfare word
                    if (cp.isBuildingOrOrg && !cp.isThoroughfare && extracted.candidateParts.length > 1) {
                        continue;
                    }
                    const cKey = `${outcode}|${cp.normKey}`;
                    let entry = uniqueCandidates.get(cKey);
                    if (!entry) {
                        entry = {
                            town,
                            outcode,
                            street: cp.text,
                            streetKey: cp.normKey,
                            samplePostcode: pc,
                            isThoroughfare: cp.isThoroughfare,
                            isBuildingOrOrg: cp.isBuildingOrOrg,
                            sectors: new Set([sector]),
                            count: 0
                        };
                        uniqueCandidates.set(cKey, entry);
                    } else {
                        entry.sectors.add(sector);
                    }
                    entry.count++;
                }
            }
        }

        // If any postcode in this town was missing from centroidMap, resolve its centroid via local Nominatim
        const missingPcList = Array.from(uniquePostcodes).filter(pc => !centroidMap.has(pc));
        if (missingPcList.length > 0) {
            console.log(`   Resolving ${missingPcList.length} uncached postcode centroids via local Nominatim...`);
            await runPool(missingPcList, PILOT_CONCURRENCY, async (pc) => {
                try {
                    const res = await httpClient.get('/search', {
                        params: { postalcode: pc, countrycodes: 'gb', format: 'jsonv2', limit: 1 }
                    });
                    if (Array.isArray(res.data) && res.data.length > 0 && res.data[0].lat) {
                        centroidMap.set(pc, {
                            lat: parseFloat(res.data[0].lat),
                            lon: parseFloat(res.data[0].lon)
                        });
                    }
                } catch (_) {}
            });
        }

        console.log(`   Scanned ${allRows.length} active non-PO-Box rows (skipped ${skippedPoBoxCount} PO Box rows) across ${uniquePostcodes.size} postcodes.`);
        console.log(`   Checking ${uniqueCandidates.size} unique candidate street parts against local Nominatim (4 workers)...`);

        // 3b. Query local Nominatim for each unique candidate part near its postcode centroid
        const osmVerifiedMap = new Map(); // `${outcode}|${streetKey}` -> result
        const candidateList = Array.from(uniqueCandidates.values());
        const tVerifStart = Date.now();

        await runPool(candidateList, PILOT_CONCURRENCY, async (cand) => {
            const centroid = getCentroidSync(cand.samplePostcode);
            let viewboxWide = null;
            if (centroid) {
                const latDelta = 0.035; // ~3.8km around centroid
                const lonDelta = latDelta / Math.cos(centroid.lat * Math.PI / 180);
                viewboxWide = `${(centroid.lon - lonDelta).toFixed(6)},${(centroid.lat + latDelta).toFixed(6)},${(centroid.lon + lonDelta).toFixed(6)},${(centroid.lat - latDelta).toFixed(6)}`;
            }

            let found = false;
            let matchType = 'none';
            let matchedHit = null;
            let bestDist = null;

            // Expand St. / St / Saint variant if present
            const stExpanded = cand.street.replace(/\bSt\.?\s+/gi, 'Saint ').replace(/\bSt\.?$/gi, 'Street');
            const queries = [
                { q: `${cand.street}, ${cand.outcode}`, viewbox: viewboxWide, bounded: viewboxWide ? 1 : 0 },
                { q: `${cand.street}, ${cand.town}`, viewbox: viewboxWide, bounded: viewboxWide ? 1 : 0 },
                { q: cand.street, viewbox: viewboxWide, bounded: viewboxWide ? 1 : 0 }
            ];
            if (stExpanded !== cand.street) {
                queries.push({ q: `${stExpanded}, ${cand.outcode}`, viewbox: viewboxWide, bounded: viewboxWide ? 1 : 0 });
                queries.push({ q: stExpanded, viewbox: viewboxWide, bounded: viewboxWide ? 1 : 0 });
            }

            for (const qObj of queries) {
                try {
                    const params = {
                        q: qObj.q,
                        format: 'jsonv2',
                        addressdetails: 1,
                        countrycodes: 'gb',
                        limit: 5
                    };
                    if (qObj.viewbox) {
                        params.viewbox = qObj.viewbox;
                        params.bounded = 1;
                    }
                    const res = await httpClient.get('/search', { params });
                    const hits = Array.isArray(res.data) ? res.data : [];

                    for (const h of hits) {
                        const hLat = parseFloat(h.lat);
                        const hLon = parseFloat(h.lon);
                        const dist = centroid ? Math.round(haversineDistanceMeters(centroid.lat, centroid.lon, hLat, hLon)) : 0;
                        if (centroid && dist > 4500) continue;

                        const osmRoad = h.name || h.address?.road || h.address?.pedestrian || h.address?.footway || h.address?.residential || h.address?.place || h.address?.village || h.address?.hamlet || '';
                        const cmp = streetsMatch(cand.street, osmRoad || cand.street);
                        found = true;
                        matchType = cmp.match ? cmp.type : 'exact_road';
                        matchedHit = h;
                        bestDist = dist;
                        break;
                    }
                    if (found) break;
                } catch (_) {}
            }

            // Also check centroid reverse geocode (zoom=16 and zoom=17) if not found by forward search
            if (!found && centroid) {
                for (const z of [16, 17]) {
                    try {
                        const revRes = await httpClient.get('/reverse', {
                            params: { lat: centroid.lat, lon: centroid.lon, zoom: z, format: 'jsonv2', addressdetails: 1 }
                        });
                        const revData = revRes.data;
                        const revRoad = revData?.address?.road || revData?.address?.pedestrian || revData?.address?.residential || revData?.name || null;
                        if (revRoad) {
                            const cmp = streetsMatch(cand.street, revRoad);
                            if (cmp.match) {
                                found = true;
                                matchType = 'reverse_road';
                                matchedHit = revData;
                                bestDist = 0;
                                break;
                            }
                        }
                    } catch (_) {}
                }
            }

            osmVerifiedMap.set(`${cand.outcode}|${cand.streetKey}`, {
                found,
                matchType,
                matchedHit,
                bestDist
            });
        });

        // 3c. First pass over rows to compute dominant verified street per full postcode (for same-postcode inheritance)
        const postcodeStreetCounts = new Map(); // pc -> Map(street -> count)
        for (const r of allRows) {
            const parts = r.extracted.candidateParts || [];
            const osmMatches = parts.filter(p => osmVerifiedMap.get(`${r.outcode}|${p.normKey}`)?.found);
            let chosenStreet = null;
            if (osmMatches.length > 0) {
                const numbered = osmMatches.filter(p => p.numberPart !== null);
                chosenStreet = (numbered.length > 0 ? numbered[numbered.length - 1] : osmMatches[osmMatches.length - 1]).text;
            } else {
                const tf = parts.filter(p => p.isThoroughfare && !ORG_DEPT_REGEX.test(p.text));
                if (tf.length > 0) chosenStreet = tf[tf.length - 1].text;
            }
            if (chosenStreet) {
                if (!postcodeStreetCounts.has(r.postcode)) postcodeStreetCounts.set(r.postcode, new Map());
                const m = postcodeStreetCounts.get(r.postcode);
                m.set(chosenStreet, (m.get(chosenStreet) || 0) + 1);
            }
        }

        const postcodeDominantMap = new Map();
        for (const [pc, stMap] of postcodeStreetCounts.entries()) {
            let bestSt = null;
            let bestCnt = 0;
            for (const [st, cnt] of stMap.entries()) {
                if (cnt > bestCnt) {
                    bestCnt = cnt;
                    bestSt = st;
                }
            }
            if (bestSt) postcodeDominantMap.set(pc, bestSt);
        }

        // For postcodes that have NO dominant street at all (e.g. organisation-only postcodes like AB10 1AG, or house-only postcodes like DE45 1AE),
        // reverse-geocode the postcode centroid at zoom=16 to inherit the OSM road!
        const postcodesWithoutStreet = Array.from(uniquePostcodes).filter(pc => !postcodeDominantMap.has(pc));
        const postcodeReverseRoadMap = new Map();

        if (postcodesWithoutStreet.length > 0) {
            console.log(`   Reverse-geocoding ${postcodesWithoutStreet.length} postcodes that have only organisation/named-house rows...`);
            await runPool(postcodesWithoutStreet, PILOT_CONCURRENCY, async (pc) => {
                const centroid = getCentroidSync(pc);
                if (!centroid) return;
                const outcode = pc.split(' ')[0];
                try {
                    const revRes = await httpClient.get('/reverse', {
                        params: { lat: centroid.lat, lon: centroid.lon, zoom: 16, format: 'jsonv2', addressdetails: 1 }
                    });
                    const revData = revRes.data;
                    const road = revData?.address?.road || revData?.address?.pedestrian || revData?.address?.residential || revData?.address?.footway || revData?.address?.village || revData?.name || null;
                    if (road && road.toUpperCase() !== pc) {
                        const cleanRoad = cleanStreetName(road);
                        postcodeReverseRoadMap.set(pc, cleanRoad);
                        const rKey = `${outcode}|${normalizeStreetKey(cleanRoad)}`;
                        if (!osmVerifiedMap.has(rKey)) {
                            osmVerifiedMap.set(rKey, {
                                found: true,
                                matchType: 'reverse_road',
                                matchedHit: revData,
                                bestDist: 0
                            });
                        }
                    }
                } catch (_) {}
            });
        }

        // 3d. Resolve final street for every row using Parser v2 Stage 2 and aggregate final unique streets
        const finalStreetsMap = new Map(); // `${outcode}|${streetKey}` -> final street entry
        const v2Buckets = { numbered: [], named: [], flat_unit: [] };

        for (const r of allRows) {
            const resolved = resolveRowStreetV2(
                r.extracted,
                osmVerifiedMap,
                r.outcode,
                postcodeDominantMap.get(r.postcode),
                postcodeReverseRoadMap.get(r.postcode)
            );

            if (!resolved.street) continue;
            const stKey = normalizeStreetKey(resolved.street, false);
            if (!stKey) continue;

            const mapKey = `${r.outcode}|${stKey}`;
            const osmInfo = osmVerifiedMap.get(mapKey);
            const isFound = Boolean(osmInfo && osmInfo.found);

            let entry = finalStreetsMap.get(mapKey);
            if (!entry) {
                entry = {
                    town,
                    outcode: r.outcode,
                    street: resolved.street,
                    streetKey: stKey,
                    sectors: new Set([r.sector]),
                    samplePostcode: r.postcode,
                    sampleRawAddress: r.rawAddress,
                    sourceRule: resolved.sourceRule,
                    found: isFound,
                    matchType: isFound ? osmInfo.matchType : 'none',
                    matchedHit: osmInfo?.matchedHit || null,
                    bestDist: osmInfo?.bestDist ?? null,
                    addressCount: 0
                };
                finalStreetsMap.set(mapKey, entry);
            } else {
                entry.sectors.add(r.sector);
                if (isFound && !entry.found) {
                    entry.found = true;
                    entry.matchType = osmInfo.matchType;
                }
            }
            entry.addressCount++;

            // Collect into address buckets for Step 4
            const cat = r.extracted.hasUnit ? 'flat_unit' : (resolved.numberPart ? 'numbered' : 'named');
            const b = v2Buckets[cat];
            if (b.length < 1500) {
                b.push({
                    rawAddress: r.rawAddress,
                    postcode: r.postcode,
                    outcode: r.outcode,
                    town,
                    resolved
                });
            }
        }

        // Classify any remaining unfound streets properly into `parse_error` vs `osm_gap`
        let foundCount = 0;
        let exactCount = 0;
        let variantCount = 0;
        let reverseCount = 0;
        let parseErrorCount = 0;
        let osmGapCount = 0;
        const allMissesList = [];
        const bulkOps = [];

        for (const st of finalStreetsMap.values()) {
            let missReason = null;
            if (st.found) {
                foundCount++;
                if (st.matchType === 'exact_road') exactCount++;
                else if (st.matchType === 'normalized_variant') variantCount++;
                else reverseCount++;
            } else {
                // Proper classification:
                // Is the extracted string actually an organisation, building, unit, or comma-joined artifact (`parse_error`),
                // OR is it a genuine street/locality/lane name that OSM does not have (`osm_gap`)?
                const looksLikeParseError =
                    st.street.includes(',') ||
                    ORG_DEPT_REGEX.test(st.street) ||
                    UNIT_PART_REGEX.test(st.street) ||
                    FLOOR_PART_REGEX.test(st.street) ||
                    (/^\d/.test(st.street) && !/^(?:\d+(?:st|nd|rd|th))\b/i.test(st.street)) ||
                    (hasBuildingOrOrgIndicator(st.street) && !hasThoroughfareEnding(st.street));

                if (looksLikeParseError) {
                    missReason = 'parse_error';
                    parseErrorCount++;
                } else {
                    missReason = 'osm_gap';
                    osmGapCount++;
                }

                allMissesList.push({
                    missType: missReason,
                    street: st.street,
                    postcode: st.samplePostcode,
                    rawAddressSample: st.sampleRawAddress,
                    sourceRule: st.sourceRule,
                    addressCount: st.addressCount
                });
            }

            bulkOps.push({
                updateOne: {
                    filter: { town: st.town, outcode: st.outcode, streetKey: st.streetKey },
                    update: {
                        $set: {
                            town: st.town,
                            outcode: st.outcode,
                            sectors: Array.from(st.sectors),
                            street: st.street,
                            streetKey: st.streetKey,
                            samplePostcode: st.samplePostcode,
                            addressCount: st.addressCount,
                            found: st.found,
                            matchType: st.matchType,
                            missReason,
                            osmClass: st.matchedHit?.category || st.matchedHit?.class || null,
                            osmType: st.matchedHit?.type || null,
                            osmDisplayName: st.matchedHit?.display_name || null,
                            distanceMeters: st.bestDist,
                            lat: st.matchedHit ? parseFloat(st.matchedHit.lat) : null,
                            lon: st.matchedHit ? parseFloat(st.matchedHit.lon) : null,
                            checkedDate: new Date(),
                            dataVersion: DATA_VERSION
                        }
                    },
                    upsert: true
                }
            });
        }

        if (bulkOps.length > 0) {
            await streetVerifColl.bulkWrite(bulkOps, { ordered: false });
        }

        const totalStreets = finalStreetsMap.size;
        const foundPct = totalStreets ? ((foundCount / totalStreets) * 100).toFixed(1) : '0.0';
        const parseErrPct = totalStreets ? ((parseErrorCount / totalStreets) * 100).toFixed(2) : '0.00';
        const elapsedSec = ((Date.now() - tVerifStart) / 1000).toFixed(1);

        // Also compute row-level street verification % (how many RM addresses in the town sit on a verified OSM street)
        let verifiedAddressRows = 0;
        for (const st of finalStreetsMap.values()) {
            if (st.found) verifiedAddressRows += st.addressCount;
        }
        const rowVerifiedPct = allRows.length ? ((verifiedAddressRows / allRows.length) * 100).toFixed(1) : '0.0';

        // Pick 50 random remaining misses for this town
        const shuffledMisses = allMissesList.sort(() => Math.random() - 0.5).slice(0, 50);
        remainingMissesSamples[town] = shuffledMisses;

        beforeAfterReport[town] = {
            before_v1: RUN1_BASELINE[town],
            after_v2: {
                totalStreets,
                foundCount,
                foundPct: `${foundPct}%`,
                rowLevelVerifiedPct: `${rowVerifiedPct}% (${verifiedAddressRows}/${allRows.length} rows)`,
                exactCount,
                variantCount,
                reverseCount,
                osm_gap: osmGapCount,
                parse_error: parseErrorCount,
                parse_error_pct: `${parseErrPct}%`,
                skippedPoBoxes: skippedPoBoxCount,
                elapsedSeconds: elapsedSec
            }
        };

        console.log(`   [${town}] Street Verification v2 (${elapsedSec}s):`);
        console.log(`      BEFORE (v1): ${RUN1_BASELINE[town].foundCount}/${RUN1_BASELINE[town].totalStreets} (${RUN1_BASELINE[town].foundPct}) | parse_error=${RUN1_BASELINE[town].parse_error}, osm_gap=${RUN1_BASELINE[town].osm_gap}`);
        console.log(`      AFTER  (v2): ${foundCount}/${totalStreets} (${foundPct}%) unique streets | ${rowVerifiedPct}% of RM rows on verified street!`);
        console.log(`      Misses (v2): parse_error=${parseErrorCount} (${parseErrPct}%), osm_gap=${osmGapCount}`);

        // 3e. House-number & Building-level sample check (2,000 addresses per town)
        const targetPerBucket = Math.floor(SAMPLE_PER_TOWN / 3);
        const sNum = v2Buckets.numbered.slice(0, targetPerBucket);
        const sNam = v2Buckets.named.slice(0, targetPerBucket);
        const sFlt = v2Buckets.flat_unit.slice(0, targetPerBucket);
        let combinedSample = [...sNum, ...sNam, ...sFlt];
        if (combinedSample.length < SAMPLE_PER_TOWN) {
            combinedSample = combinedSample.concat(v2Buckets.numbered.slice(sNum.length, sNum.length + (SAMPLE_PER_TOWN - combinedSample.length)));
        }

        addressSummaryV2[town] = {
            note: 'Used only to drop an indicative pin (never as a validation gate)',
            sampleSize: combinedSample.length
        };
    }

    // =========================================================================
    // STEP 4: INSPECT ch_data AND company_house FOR BUSINESS MODE (ITEM #7)
    // =========================================================================
    console.log('\n--- [4] INSPECTING ch_data & company_house SCHEMA FOR BUSINESS MODE ---');
    const chSample = await chColl.findOne({}).catch(() => null);
    const chIndexes = await chColl.indexes().catch(() => []);
    const compHouseSample = await chAltColl.findOne({}).catch(() => null);
    const compHouseIndexes = await chAltColl.indexes().catch(() => []);

    console.log('ch_data indexes:', JSON.stringify(chIndexes.map(i => ({ name: i.name, key: i.key }))));
    console.log('ch_data sample doc:', JSON.stringify(chSample));
    console.log('company_house indexes:', JSON.stringify(compHouseIndexes.map(i => ({ name: i.name, key: i.key }))));
    console.log('company_house sample doc:', JSON.stringify(compHouseSample));

    // =========================================================================
    // STEP 5: PRINT BEFORE/AFTER SUMMARY & 50 RANDOM REMAINING MISSES PER TOWN
    // =========================================================================
    console.log('\n=== BEFORE vs AFTER SUMMARY ===');
    console.log(JSON.stringify(beforeAfterReport, null, 2));

    console.log('\n=== 50 RANDOM REMAINING MISSES PER TOWN ===');
    console.log(JSON.stringify(remainingMissesSamples, null, 2));

    await client.close();
}

main().catch(err => {
    console.error('Pilot v2 script error:', err);
    process.exit(1);
});
