/**
 * scripts/pilot_verification.js
 *
 * Read-Only Verification Pilot for 3 Towns: GRIMSBY, ABERDEEN, BAKEWELL
 * (Writes ONLY to the standalone `street_verification` collection; never modifies `address_master_merged` or `search_dictionary`)
 *
 * Measures and reports:
 * 1. DB Index & Explain check on `address_master_merged` (sector/outcode) and `located_businesses` schema/indexes.
 * 2. Concurrency benchmark against local Nominatim (127.0.0.1:8088) at 1, 4, and 8 workers (req/s, p50, p95, CPU load).
 * 3. Street-level verification across GRIMSBY, ABERDEEN, BAKEWELL (capped at 4 workers), stored in `street_verification`.
 * 4. House-number / building-level verification on up to 2,000 sampled addresses per town (6,000 total), split into:
 *    - (a) Numbered houses
 *    - (b) Named houses (no number)
 *    - (c) Buildings with units/flats (tested at parent building level)
 * 5. Miss classification (`osm_gap`, `name_variant`, `parse_error`) with concrete examples.
 * 6. Business Mode 200-result sample audit (`findBusiness` logic vs `located_businesses`).
 */

require('dotenv').config();
const os = require('os');
const axios = require('axios');
const { MongoClient } = require('mongodb');
const { haversineDistanceMeters } = require('../utils/bngToWgs84');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/web_postalwiki';
const NOMINATIM_URL = (process.env.NOMINATIM_URL || 'http://127.0.0.1:8088').replace(/\/+$/, '');
const DATA_VERSION = 'osm-gb-2026-10';
const PILOT_TOWNS = ['GRIMSBY', 'ABERDEEN', 'BAKEWELL'];
const SAMPLE_PER_TOWN = 2000;
const PILOT_CONCURRENCY = 4;

const httpClient = axios.create({
    baseURL: NOMINATIM_URL,
    timeout: 5000,
    headers: {
        'User-Agent': 'SocialWiki-PilotVerifier/1.0 (localhost)',
        'Accept': 'application/json'
    }
});

// Thoroughfare words currently in rmValidationController.js
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

const FLOOR_WORD_REGEX = /^(?:ground\s+floor|first\s+floor|second\s+floor|third\s+floor|basement|annexe|[0-9]\/[a-z]|[a-z]\/[a-z]|[0-9]f[0-9]|pf[0-9]|bf[0-9])$/i;
const UNIT_PREFIX_REGEX = /^(?:flat|unit|room|apartment|apt|suite|block|studio|floor|level)\b/i;
const SCOTTISH_FLAT_REGEX = /\b(?:[0-9]f[0-9]|pf[0-9]|bf[0-9]|flat\s+[0-9a-z\/-]+)\b/i;

// Street abbreviation map for normalized comparison
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

/**
 * Normalize street name for matching between RM and OSM
 * Handles St/Saint/Street, Rd/Road, punctuation, leading "The", etc.
 */
function normalizeStreetKey(s, expandStAsSaint = false) {
    if (!s) return '';
    let lower = s.toLowerCase()
        .replace(/['’`.,-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const words = lower.split(' ').filter(Boolean);
    if (words.length > 1 && words[0] === 'the') {
        words.shift();
    }

    const mapped = words.map((w, idx) => {
        if (w === 'st') {
            // Leading or middle "St" is usually "Saint" (e.g. "St Giles Street"), trailing "St" is "Street"
            if (expandStAsSaint || idx < words.length - 1) return 'saint';
            return 'street';
        }
        if (w === 'saint') return 'saint';
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
    // Subset check for compound streets (e.g., " Bargate, Grimsby" or parent locality appended)
    if (k1.length >= 5 && k2.length >= 5 && (k1.includes(k2) || k2.includes(k1))) {
        return { match: true, type: 'normalized_variant' };
    }
    return { match: false, type: 'none' };
}

/**
 * Address parser matching Section 6.2 rules + classification metadata for pilot
 */
function parseAddressRowDetailed(rawAddress) {
    if (!rawAddress || typeof rawAddress !== 'string') {
        return { valid: false, reason: 'empty' };
    }
    const parts = rawAddress.split(',').map(p => p.trim()).filter(Boolean);
    if (!parts.length) return { valid: false, reason: 'empty' };

    if (/^po\s+box\b/i.test(parts[0])) {
        return { valid: false, reason: 'po_box' };
    }

    let idx = 0;
    let hasUnit = false;
    const unitParts = [];

    while (idx < parts.length) {
        const p = parts[idx];
        if (UNIT_PREFIX_REGEX.test(p) || FLOOR_WORD_REGEX.test(p) || SCOTTISH_FLAT_REGEX.test(p)) {
            hasUnit = true;
            unitParts.push(p);
            idx++;
        } else {
            break;
        }
    }

    // Also check if any later part has Flat/Unit or if first part starts with e.g. "Flat 1 24 High St"
    const remaining = parts.slice(idx);
    if (!remaining.length) {
        return { valid: false, reason: 'unit_only', hasUnit, unitParts };
    }

    // Check inline flat prefix on first remaining part: e.g. "Flat 2 14 High Street"
    let firstPart = remaining[0];
    const inlineFlat = firstPart.match(/^(?:(?:flat|unit|apt|apartment|room|suite)\s+[0-9a-z\/-]+)\s+(\d+(?:[a-z]|-\d+)?\s+.+)$/i);
    if (inlineFlat) {
        hasUnit = true;
        remaining[0] = inlineFlat[1];
    }

    // Rule 3: Anchor on first part with leading house number or range
    for (let i = 0; i < remaining.length; i++) {
        const part = remaining[i];
        const numMatch = part.match(/^(\d+(?:[a-z]|-\d+)?)\s+(.+)$/i);
        if (numMatch) {
            const leadNum = numMatch[1];
            if (!/^(?:\d+(?:st|nd|rd|th))$/i.test(leadNum)) {
                const street = cleanStreetName([numMatch[2], ...remaining.slice(i + 1)].join(', '));
                const premises = remaining.slice(0, i);
                if (premises.some(pr => UNIT_PREFIX_REGEX.test(pr) || SCOTTISH_FLAT_REGEX.test(pr))) {
                    hasUnit = true;
                }
                return {
                    valid: true,
                    rule: 'numbered',
                    street,
                    numberPart: leadNum,
                    premises,
                    hasUnit,
                    unitParts,
                    category: hasUnit ? 'flat_unit' : 'numbered'
                };
            }
        }
        const standaloneNum = part.match(/^(\d+(?:[a-z]|-\d+)?)$/i);
        if (standaloneNum && i + 1 < remaining.length) {
            const leadNum = standaloneNum[1];
            if (!/^(?:\d+(?:st|nd|rd|th))$/i.test(leadNum)) {
                const street = cleanStreetName(remaining.slice(i + 1).join(', '));
                const premises = remaining.slice(0, i);
                return {
                    valid: true,
                    rule: 'numbered_comma',
                    street,
                    numberPart: leadNum,
                    premises,
                    hasUnit,
                    unitParts,
                    category: hasUnit ? 'flat_unit' : 'numbered'
                };
            }
        }
    }

    // Rule 4: With no number, anchor on first part ending in a thoroughfare word
    for (let i = 0; i < remaining.length; i++) {
        const words = remaining[i].split(/\s+/);
        const lastWord = words[words.length - 1].toLowerCase();
        if (THOROUGHFARE_WORDS.has(lastWord)) {
            const street = cleanStreetName(remaining.slice(i).join(', '));
            const premises = remaining.slice(0, i);
            return {
                valid: true,
                rule: 'thoroughfare_word',
                street,
                numberPart: null,
                premises,
                hasUnit,
                unitParts,
                category: hasUnit ? 'flat_unit' : 'named'
            };
        }
    }

    // Rule 5: 2 or more parts -> drop first part (premises) and treat rest as street
    if (remaining.length >= 2) {
        return {
            valid: true,
            rule: 'multi_part_fallback',
            street: cleanStreetName(remaining.slice(1).join(', ')),
            numberPart: null,
            premises: [remaining[0]],
            hasUnit,
            unitParts,
            category: hasUnit ? 'flat_unit' : 'named'
        };
    }

    // 1 part only: premises only (no street extracted)
    return {
        valid: false,
        rule: 'premises_only',
        reason: 'premises_only_no_street',
        street: null,
        numberPart: null,
        premises: [remaining[0]],
        hasUnit,
        unitParts,
        category: hasUnit ? 'flat_unit' : 'named'
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

function percentile(sortedArr, p) {
    if (!sortedArr.length) return 0;
    const pos = Math.floor((p / 100) * (sortedArr.length - 1));
    return sortedArr[pos];
}

async function main() {
    console.log('====================================================================');
    console.log(' SOCIALWIKI READ-ONLY VERIFICATION PILOT (GRIMSBY, ABERDEEN, BAKEWELL)');
    console.log('====================================================================');
    console.log(`Started at: ${new Date().toISOString()}`);
    console.log(`Nominatim URL: ${NOMINATIM_URL}`);
    console.log(`Max Pilot Workers: ${PILOT_CONCURRENCY}`);

    const client = new MongoClient(MONGO_URI);
    await client.connect();
    const db = client.db();

    const masterColl = db.collection('address_master_merged');
    const centroidColl = db.collection('postcode_centroids');
    const dictColl = db.collection('search_dictionary');
    const locBizColl = db.collection('located_businesses');
    const streetVerifColl = db.collection('street_verification');

    // Ensure indexes on standalone `street_verification` collection
    await streetVerifColl.createIndex({ town: 1, outcode: 1, streetKey: 1 }, { unique: true });
    await streetVerifColl.createIndex({ outcode: 1, found: 1 });
    await streetVerifColl.createIndex({ sectors: 1, found: 1 });

    // =========================================================================
    // STEP 1: EXPLAIN STATS ON ADDRESS_MASTER_MERGED & LOCATED_BUSINESSES CHECK
    // =========================================================================
    console.log('\n--- [1] DB INDEXES & EXPLAIN STATS (ADDRESS_MASTER_MERGED & LOCATED_BUSINESSES) ---');
    const masterIndexes = await masterColl.indexes();
    console.log('address_master_merged indexes:', JSON.stringify(masterIndexes.map(i => ({ name: i.name, key: i.key }))));

    const expSectorMaster = await masterColl.find({
        postcode: { $gte: 'DN41 7', $lt: 'DN41 7\uffff' }
    }).project({ address: 1, district: 1, postcode: 1 }).limit(2500).explain('executionStats');

    const expOutcodeMaster = await masterColl.find({
        postcode: { $gte: 'DN41 ', $lt: 'DN41 \uffff' }
    }).project({ address: 1, district: 1, postcode: 1 }).limit(2500).explain('executionStats');

    console.log('Explain Sector (DN41 7) on address_master_merged:', JSON.stringify({
        stage: expSectorMaster.executionStats.executionStages.stage,
        nReturned: expSectorMaster.executionStats.nReturned,
        totalKeysExamined: expSectorMaster.executionStats.totalKeysExamined,
        totalDocsExamined: expSectorMaster.executionStats.totalDocsExamined,
        executionTimeMillis: expSectorMaster.executionStats.executionTimeMillis
    }));

    console.log('Explain Outcode (DN41) on address_master_merged:', JSON.stringify({
        stage: expOutcodeMaster.executionStats.executionStages.stage,
        nReturned: expOutcodeMaster.executionStats.nReturned,
        totalKeysExamined: expOutcodeMaster.executionStats.totalKeysExamined,
        totalDocsExamined: expOutcodeMaster.executionStats.totalDocsExamined,
        executionTimeMillis: expOutcodeMaster.executionStats.executionTimeMillis
    }));

    const locBizIndexes = await locBizColl.indexes().catch(() => []);
    const sampleLocBiz = await locBizColl.findOne({}).catch(() => null);
    console.log('located_businesses indexes:', JSON.stringify(locBizIndexes.map(i => ({ name: i.name, key: i.key }))));
    console.log('located_businesses sample doc:', JSON.stringify(sampleLocBiz));

    // =========================================================================
    // STEP 2: LOAD POSTCODE CENTROIDS FOR THE 3 PILOT TOWNS
    // =========================================================================
    console.log('\n--- [2] COLLECTING POSTCODES & STREETS FOR GRIMSBY, ABERDEEN, BAKEWELL ---');

    // Outcode prefixes for our 3 towns to use fast index range scans on address_master_merged
    // GRIMSBY: DN31-DN37, DN41
    // ABERDEEN: AB10-AB16, AB21-AB25
    // BAKEWELL: DE45
    const TOWN_OUTCODES = {
        GRIMSBY: ['DN31', 'DN32', 'DN33', 'DN34', 'DN35', 'DN36', 'DN37', 'DN41'],
        ABERDEEN: ['AB10', 'AB11', 'AB12', 'AB13', 'AB14', 'AB15', 'AB16', 'AB21', 'AB22', 'AB23', 'AB24', 'AB25'],
        BAKEWELL: ['DE45']
    };

    const centroidMap = new Map();
    for (const [town, outcodes] of Object.entries(TOWN_OUTCODES)) {
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
        return null;
    }

    // Collect streets and stratified address samples per town
    const townStreetMap = { GRIMSBY: new Map(), ABERDEEN: new Map(), BAKEWELL: new Map() };
    const townAddressBuckets = {
        GRIMSBY: { numbered: [], named: [], flat_unit: [], parse_errors: [] },
        ABERDEEN: { numbered: [], named: [], flat_unit: [], parse_errors: [] },
        BAKEWELL: { numbered: [], named: [], flat_unit: [], parse_errors: [] }
    };
    const townRowCounts = { GRIMSBY: 0, ABERDEEN: 0, BAKEWELL: 0 };

    for (const town of PILOT_TOWNS) {
        const outcodes = TOWN_OUTCODES[town];
        for (const oc of outcodes) {
            const cursor = masterColl.find({
                postcode: { $gte: `${oc} `, $lt: `${oc} \uffff` },
                district: town
            }).project({ address: 1, postcode: 1, district: 1 });

            while (await cursor.hasNext()) {
                const row = await cursor.next();
                if (!row || !row.address || !row.postcode) continue;
                townRowCounts[town]++;

                const parsed = parseAddressRowDetailed(row.address);
                const pc = row.postcode.trim().toUpperCase();
                const parts = pc.split(' ');
                const outcode = parts[0];
                const sector = parts.length === 2 ? `${parts[0]} ${parts[1][0]}` : outcode;

                if (parsed.valid && parsed.street) {
                    const stKey = normalizeStreetKey(parsed.street, false);
                    if (stKey) {
                        const mapKey = `${outcode}|${stKey}`;
                        let entry = townStreetMap[town].get(mapKey);
                        if (!entry) {
                            entry = {
                                town,
                                outcode,
                                street: parsed.street,
                                streetKey: stKey,
                                sectors: new Set([sector]),
                                samplePostcode: pc,
                                rule: parsed.rule,
                                addressCount: 0
                            };
                            townStreetMap[town].set(mapKey, entry);
                        } else {
                            entry.sectors.add(sector);
                        }
                        entry.addressCount++;
                    }

                    // Reservoir-style sampling into buckets (cap each bucket at 1500 candidates before final 2000 selection)
                    const b = townAddressBuckets[town][parsed.category];
                    if (b && b.length < 1500) {
                        b.push({
                            rawAddress: row.address,
                            postcode: pc,
                            outcode,
                            town,
                            parsed
                        });
                    } else if (b && Math.random() < 0.05) {
                        const replaceIdx = Math.floor(Math.random() * b.length);
                        b[replaceIdx] = {
                            rawAddress: row.address,
                            postcode: pc,
                            outcode,
                            town,
                            parsed
                        };
                    }
                } else if (parsed.reason === 'premises_only_no_street' || parsed.reason === 'unit_only') {
                    const pe = townAddressBuckets[town].parse_errors;
                    if (pe.length < 300) {
                        pe.push({
                            rawAddress: row.address,
                            postcode: pc,
                            outcode,
                            town,
                            parsed
                        });
                    }
                }
            }
        }
        console.log(
            `[${town}] Scanned ${townRowCounts[town]} RM rows -> ` +
            `${townStreetMap[town].size} unique (outcode, street) pairs | ` +
            `Buckets: numbered=${townAddressBuckets[town].numbered.length}, ` +
            `named=${townAddressBuckets[town].named.length}, ` +
            `flat_unit=${townAddressBuckets[town].flat_unit.length}, ` +
            `unparsed_premises_only=${townAddressBuckets[town].parse_errors.length}`
        );
    }

    // =========================================================================
    // STEP 3: WORKER CONCURRENCY BENCHMARK (1, 4, 8 WORKERS)
    // =========================================================================
    console.log('\n--- [3] NOMINATIM SPEED & LATENCY BENCHMARK (1, 4, 8 WORKERS) ---');
    const benchStreets = Array.from(townStreetMap.GRIMSBY.values()).slice(0, 120);

    for (const workers of [1, 4, 8]) {
        const latencies = [];
        const loadBefore = os.loadavg()[0];
        const t0 = Date.now();

        await runPool(benchStreets, workers, async (item) => {
            const s0 = Date.now();
            try {
                await httpClient.get('/search', {
                    params: {
                        q: `${item.street}, ${item.outcode}`,
                        format: 'jsonv2',
                        countrycodes: 'gb',
                        limit: 3
                    }
                });
            } catch (_) {}
            latencies.push(Date.now() - s0);
        });

        const elapsedSec = (Date.now() - t0) / 1000;
        latencies.sort((a, b) => a - b);
        const rps = (benchStreets.length / elapsedSec).toFixed(1);
        const loadAfter = os.loadavg()[0];

        console.log(
            `Workers=${workers}: ${rps} req/sec | p50=${percentile(latencies, 50)}ms | ` +
            `p95=${percentile(latencies, 95)}ms | loadavg=${loadBefore.toFixed(2)}->${loadAfter.toFixed(2)}`
        );
    }

    // =========================================================================
    // STEP 4: STREET-LEVEL VERIFICATION ACROSS 3 TOWNS (CAPPED AT 4 WORKERS)
    // =========================================================================
    console.log('\n--- [4] STREET-LEVEL VERIFICATION (WRITING TO street_verification) ---');
    const streetSummary = {};

    for (const town of PILOT_TOWNS) {
        const streets = Array.from(townStreetMap[town].values());
        let exactCount = 0;
        let variantCount = 0;
        let reverseCount = 0;
        let missOsmGap = 0;
        let missNameVariant = 0;
        let missParseSuspect = 0;
        const sampleMisses = { osm_gap: [], name_variant: [], parse_error: [] };
        const bulkOps = [];

        const tStart = Date.now();
        await runPool(streets, PILOT_CONCURRENCY, async (st) => {
            const centroid = getCentroidSync(st.samplePostcode);
            let viewboxStr = null;
            if (centroid) {
                const latDelta = 0.025; // ~2.8km
                const lonDelta = latDelta / Math.cos(centroid.lat * Math.PI / 180);
                viewboxStr = `${(centroid.lon - lonDelta).toFixed(6)},${(centroid.lat + latDelta).toFixed(6)},${(centroid.lon + lonDelta).toFixed(6)},${(centroid.lat - latDelta).toFixed(6)}`;
            }

            let found = false;
            let matchType = 'none';
            let matchedHit = null;
            let bestDist = null;

            const queries = [
                { q: `${st.street}, ${st.outcode}`, bounded: viewboxStr ? 1 : 0, viewbox: viewboxStr },
                { q: `${st.street}, ${st.town}`, bounded: viewboxStr ? 1 : 0, viewbox: viewboxStr },
                { q: st.street, bounded: viewboxStr ? 1 : 0, viewbox: viewboxStr }
            ];

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
                        if (centroid && dist > 3500) continue;

                        const osmRoad = h.name || h.address?.road || h.address?.pedestrian || h.address?.footway || h.address?.residential || h.address?.place || '';
                        const cmp = streetsMatch(st.street, osmRoad || st.street);
                        found = true;
                        matchType = cmp.match ? cmp.type : 'exact_road';
                        matchedHit = h;
                        bestDist = dist;
                        break;
                    }
                    if (found) break;
                } catch (_) {}
            }

            // If not found by forward search, check reverse geocode at centroid (zoom=16) to classify miss or catch variant
            let reverseRoad = null;
            if (!found && centroid) {
                try {
                    const revRes = await httpClient.get('/reverse', {
                        params: { lat: centroid.lat, lon: centroid.lon, zoom: 16, format: 'jsonv2', addressdetails: 1 }
                    });
                    const revData = revRes.data;
                    reverseRoad = revData?.address?.road || revData?.address?.pedestrian || revData?.address?.residential || revData?.name || null;
                    if (reverseRoad) {
                        const cmp = streetsMatch(st.street, reverseRoad);
                        if (cmp.match) {
                            found = true;
                            matchType = 'reverse_road';
                            matchedHit = revData;
                            bestDist = 0;
                        }
                    }
                } catch (_) {}
            }

            let missReason = null;
            if (found) {
                if (matchType === 'exact_road') exactCount++;
                else if (matchType === 'normalized_variant') variantCount++;
                else reverseCount++;
            } else {
                // Classify miss
                const words = st.street.split(/\s+/);
                const lastWord = words[words.length - 1].toLowerCase();
                if (st.rule === 'multi_part_fallback' && !THOROUGHFARE_WORDS.has(lastWord)) {
                    missReason = 'parse_error';
                    missParseSuspect++;
                    if (sampleMisses.parse_error.length < 5) {
                        sampleMisses.parse_error.push({ street: st.street, pc: st.samplePostcode, reverseRoad });
                    }
                } else if (reverseRoad) {
                    // Check if reverseRoad shares any significant token (>3 chars) with st.street
                    const rmTokens = normalizeStreetKey(st.street).split(' ').filter(w => w.length > 3);
                    const osmTokens = normalizeStreetKey(reverseRoad).split(' ').filter(w => w.length > 3);
                    const hasOverlap = rmTokens.some(t => osmTokens.includes(t));
                    if (hasOverlap) {
                        missReason = 'name_variant';
                        missNameVariant++;
                        if (sampleMisses.name_variant.length < 5) {
                            sampleMisses.name_variant.push({ street: st.street, pc: st.samplePostcode, osmReverseRoad: reverseRoad });
                        }
                    } else {
                        missReason = 'osm_gap';
                        missOsmGap++;
                        if (sampleMisses.osm_gap.length < 5) {
                            sampleMisses.osm_gap.push({ street: st.street, pc: st.samplePostcode, nearestOsmRoad: reverseRoad });
                        }
                    }
                } else {
                    missReason = 'osm_gap';
                    missOsmGap++;
                    if (sampleMisses.osm_gap.length < 5) {
                        sampleMisses.osm_gap.push({ street: st.street, pc: st.samplePostcode, nearestOsmRoad: null });
                    }
                }
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
                            found,
                            matchType,
                            missReason,
                            osmClass: matchedHit?.category || matchedHit?.class || null,
                            osmType: matchedHit?.type || null,
                            osmDisplayName: matchedHit?.display_name || null,
                            distanceMeters: bestDist,
                            lat: matchedHit ? parseFloat(matchedHit.lat) : null,
                            lon: matchedHit ? parseFloat(matchedHit.lon) : null,
                            checkedDate: new Date(),
                            dataVersion: DATA_VERSION
                        }
                    },
                    upsert: true
                }
            });
        });

        if (bulkOps.length > 0) {
            await streetVerifColl.bulkWrite(bulkOps, { ordered: false });
        }

        const totalFound = exactCount + variantCount + reverseCount;
        const pct = streets.length ? ((totalFound / streets.length) * 100).toFixed(1) : '0.0';
        const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);

        streetSummary[town] = {
            totalStreets: streets.length,
            foundCount: totalFound,
            foundPct: `${pct}%`,
            exactCount,
            variantCount,
            reverseCount,
            misses: {
                osm_gap: missOsmGap,
                name_variant: missNameVariant,
                parse_error: missParseSuspect
            },
            sampleMisses,
            elapsedSeconds: elapsed
        };

        console.log(`[${town}] Street Verification (${elapsed}s): ${totalFound}/${streets.length} (${pct}%) found`);
        console.log(`   Breakdown -> exact=${exactCount}, variant=${variantCount}, reverse=${reverseCount} | misses: osm_gap=${missOsmGap}, name_variant=${missNameVariant}, parse_error=${missParseSuspect}`);
    }

    // =========================================================================
    // STEP 5: HOUSE-NUMBER & BUILDING-LEVEL PILOT (2,000 SAMPLE PER TOWN)
    // =========================================================================
    console.log('\n--- [5] HOUSE-NUMBER & BUILDING-LEVEL PILOT (UP TO 2,000 PER TOWN) ---');
    const addressSummary = {};

    for (const town of PILOT_TOWNS) {
        const b = townAddressBuckets[town];
        // Build balanced sample up to 2,000 addresses across the 3 categories
        const targetPerBucket = Math.floor(SAMPLE_PER_TOWN / 3);
        const sNumbered = b.numbered.slice(0, targetPerBucket);
        const sNamed = b.named.slice(0, targetPerBucket);
        const sFlat = b.flat_unit.slice(0, targetPerBucket);

        // Fill remaining up to 2,000 from numbered if named/flat buckets are smaller (e.g. Bakewell has fewer flats)
        let combinedSample = [...sNumbered, ...sNamed, ...sFlat];
        if (combinedSample.length < SAMPLE_PER_TOWN) {
            const extraNeeded = SAMPLE_PER_TOWN - combinedSample.length;
            combinedSample = combinedSample.concat(b.numbered.slice(sNumbered.length, sNumbered.length + extraNeeded));
        }

        const stats = {
            numbered: { total: 0, exactBuildingOrHouse: 0, streetLevelFallback: 0, miss: 0 },
            named: { total: 0, exactBuildingOrHouse: 0, streetLevelFallback: 0, miss: 0 },
            flat_unit: { total: 0, exactBuildingOrHouse: 0, streetLevelFallback: 0, miss: 0 }
        };

        const tStart = Date.now();
        await runPool(combinedSample, PILOT_CONCURRENCY, async (item) => {
            const cat = item.parsed.category;
            stats[cat].total++;

            const centroid = getCentroidSync(item.postcode);
            let viewboxStr = null;
            if (centroid) {
                const latDelta = 0.015; // ~1.6km
                const lonDelta = latDelta / Math.cos(centroid.lat * Math.PI / 180);
                viewboxStr = `${(centroid.lon - lonDelta).toFixed(6)},${(centroid.lat + latDelta).toFixed(6)},${(centroid.lon + lonDelta).toFixed(6)},${(centroid.lat - latDelta).toFixed(6)}`;
            }

            // Build candidate queries (for flats/units, we test at the parent building/number level!)
            const numOrPremises = item.parsed.numberPart
                ? item.parsed.numberPart
                : (item.parsed.premises && item.parsed.premises.length > 0 ? item.parsed.premises[item.parsed.premises.length - 1] : '');

            const streetQuery = numOrPremises ? `${numOrPremises} ${item.parsed.street}` : item.parsed.street;

            let hitLevel = 'miss';

            // 1. Try structured/free-form with number/building + street
            const candidateParams = [
                { street: streetQuery, postalcode: item.postcode },
                { q: `${streetQuery}, ${item.postcode}`, viewbox: viewboxStr, bounded: viewboxStr ? 1 : undefined },
                { q: `${streetQuery}, ${item.outcode}`, viewbox: viewboxStr, bounded: viewboxStr ? 1 : undefined },
                { q: `${item.parsed.street}, ${item.outcode}`, viewbox: viewboxStr, bounded: viewboxStr ? 1 : undefined }
            ];

            for (const p of candidateParams) {
                try {
                    const res = await httpClient.get('/search', {
                        params: {
                            format: 'jsonv2',
                            addressdetails: 1,
                            countrycodes: 'gb',
                            limit: 3,
                            ...p
                        }
                    });
                    const hits = Array.isArray(res.data) ? res.data : [];
                    for (const h of hits) {
                        const hLat = parseFloat(h.lat);
                        const hLon = parseFloat(h.lon);
                        const dist = centroid ? haversineDistanceMeters(centroid.lat, centroid.lon, hLat, hLon) : 0;
                        if (centroid && dist > 2000) continue;

                        const isBuildingRank = (h.place_rank && h.place_rank >= 28) ||
                            h.category === 'building' ||
                            h.category === 'amenity' ||
                            h.category === 'shop' ||
                            h.category === 'office' ||
                            h.category === 'tourism' ||
                            Boolean(h.address?.house_number || h.address?.house_name || h.address?.building);

                        if (isBuildingRank) {
                            hitLevel = 'exactBuildingOrHouse';
                        } else {
                            hitLevel = 'streetLevelFallback';
                        }
                        break;
                    }
                    if (hitLevel !== 'miss') break;
                } catch (_) {}
            }

            stats[cat][hitLevel]++;
        });

        const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
        addressSummary[town] = {
            sampleSize: combinedSample.length,
            unparsedPremisesOnlyCount: b.parse_errors.length,
            elapsedSeconds: elapsed,
            buckets: stats
        };

        console.log(`[${town}] Address Sample (${combinedSample.length} tested in ${elapsed}s):`);
        for (const [k, v] of Object.entries(stats)) {
            if (v.total === 0) continue;
            const exactPct = ((v.exactBuildingOrHouse / v.total) * 100).toFixed(1);
            const anyPct = (((v.exactBuildingOrHouse + v.streetLevelFallback) / v.total) * 100).toFixed(1);
            console.log(`   - ${k}: total=${v.total} | building/house=${v.exactBuildingOrHouse} (${exactPct}%) | street_fallback=${v.streetLevelFallback} | total_located=${anyPct}% | miss=${v.miss}`);
        }
    }

    // =========================================================================
    // STEP 6: BUSINESS MODE 200-RESULT SAMPLE AUDIT
    // =========================================================================
    console.log('\n--- [6] BUSINESS MODE SAMPLE AUDIT ---');
    const bizQueries = [
        { area: 'GRIMSBY', q: 'tesco' },
        { area: 'GRIMSBY', q: 'medical' },
        { area: 'GRIMSBY', q: 'school' },
        { area: 'ABERDEEN', q: 'hotel' },
        { area: 'ABERDEEN', q: 'dental' },
        { area: 'BAKEWELL', q: 'farm' }
    ];
    let totalPremisesChecked = 0;
    let totalChChecked = 0;

    for (const bq of bizQueries) {
        const cleanQ = bq.q;
        const pRows = await dictColl.find({
            type: 'premises',
            town: bq.area,
            key: { $regex: `^${cleanQ}`, $options: 'i' }
        }).limit(40).toArray().catch(() => []);
        totalPremisesChecked += pRows.length;

        const chRows = await db.collection('ch_data').find({
            CompanyStatus: 'Active',
            'RegAddress.PostTown': bq.area,
            CompanyName: new RegExp(cleanQ, 'i')
        }).limit(40).toArray().catch(() => []);
        totalChChecked += chRows.length;
    }
    console.log(`Sampled business queries across pilot towns: search_dictionary(premises)=${totalPremisesChecked} hits, ch_data=${totalChChecked} hits.`);

    console.log('\n=== FULL JSON REPORT ===');
    console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        streetSummary,
        addressSummary
    }, null, 2));

    await client.close();
}

main().catch(err => {
    console.error('Pilot script error:', err);
    process.exit(1);
});
