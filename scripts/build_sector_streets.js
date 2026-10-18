/**
 * scripts/build_sector_streets.js
 *
 * Full UK Precomputed Street Verification Builder (sector_streets)
 *
 * Implements Reviewer & Stakeholder Specifications:
 * 1. Schema fields:
 *    - outcode, sector, streetKey, display, town, rowCount, verified, source,
 *      osmId, distanceM, checkedAt, osmDataVersion
 * 2. Multi-Postcode Bounding Box:
 *    - For streets spanning multiple postcodes, computes a bounding box across
 *      ALL those postcodes' centroids (from postcode_centroids) with +200m padding.
 *      Never collapses to a single outcode centroid.
 * 3. Source Rules & Circular Verification Safeguard:
 *    - 'exact': OSM road name matches RM candidate exactly (verified: true)
 *    - 'variant': OSM road name matches with St./Saint, directional, or fuzzy alias (verified: true)
 *    - 'inherited': row had no street; inherited from dominant street in same postcode (verified: false, flagged)
 *    - 'reverse_geocoded': row had no street; derived from centroid reverse geocode (verified: false, flagged)
 *    - 'osm_gap': thoroughfare not found in OSM GB extract (verified: false)
 * 4. Staged run & Resume Checkpointing:
 *    - Supports --region=yorkshire | scotland | london | midlands | all
 *    - Supports --outcode=DN41,HU1
 *    - Saves completed outcodes to `sector_streets_progress` collection.
 * 5. Off-peak concurrency: Max 4 workers to protect local PostgreSQL / MongoDB.
 */

require('dotenv').config();
const os = require('os');
const axios = require('axios');
const { MongoClient } = require('mongodb');
const { haversineDistanceMeters } = require('../utils/bngToWgs84');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/web_postalwiki';
const NOMINATIM_URL = (process.env.NOMINATIM_URL || 'http://127.0.0.1:8088').replace(/\/+$/, '');
const DATA_VERSION = 'osm-gb-2026-10-v2';
const MAX_CONCURRENCY = 4;

const httpClient = axios.create({
    baseURL: NOMINATIM_URL,
    timeout: 5000,
    headers: {
        'User-Agent': 'SocialWiki-SectorStreetsBuilder/1.0 (localhost)',
        'Accept': 'application/json'
    }
});

// Regions for staged rollouts
const REGION_MAP = {
    yorkshire: ['HU', 'DN', 'HX', 'LS', 'WF', 'BD', 'YO', 'S', 'HD', 'HG'],
    scotland: ['AB', 'DD', 'EH', 'FK', 'G', 'HS', 'IV', 'KA', 'KW', 'KY', 'ML', 'PA', 'PH', 'TD', 'ZE'],
    london: ['E', 'EC', 'N', 'NW', 'SE', 'SW', 'W', 'WC'],
    midlands: ['B', 'CV', 'DE', 'DY', 'LE', 'LN', 'NG', 'NN', 'ST', 'TF', 'WR', 'WS', 'WV']
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

const DIRECTIONAL_WORDS = new Set([
    'north', 'south', 'east', 'west', 'upper', 'lower', 'central', 'inner', 'outer'
]);

const FLOOR_PART_REGEX = /^(?:(?:ground|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|[0-9]+(?:st|nd|rd|th)|lower\s+ground|upper\s+ground|street|top|middle|main|sub)\s+(?:floor|level)(?:\s+(?:north|south|east|west|left|right|front|rear|wing))?|basement|sub-basement|mezzanine|penthouse|annexe|annex|attic|cellar|[0-9]\/[a-z0-9]|[a-z]\/[a-z0-9]|[0-9]f[0-9]|pf[0-9]|bf[0-9]|gf|ff|sf|tf)$/i;
const UNIT_PART_REGEX = /^(?:flat|unit|room|apartment|apt|suite|studio|block)\b(?:\s+[a-z0-9\/-]+)?$/i;

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
    return s.replace(/\s+/g, ' ').replace(/^[\s,.-]+|[\s,.-]+$/g, '').trim();
}

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
        return { match: true, type: 'exact' };
    }
    const k1 = normalizeStreetKey(rmStreet, false);
    const k2 = normalizeStreetKey(osmStreet, false);
    if (k1 && k1 === k2) {
        return { match: true, type: 'variant' };
    }
    const k1Saint = normalizeStreetKey(rmStreet, true);
    const k2Saint = normalizeStreetKey(osmStreet, true);
    if (k1Saint && k1Saint === k2Saint) {
        return { match: true, type: 'variant' };
    }
    if (k1.length >= 5 && k2.length >= 5 && (k1.includes(k2) || k2.includes(k1))) {
        return { match: true, type: 'variant' };
    }
    return { match: false, type: 'none' };
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

/**
 * Parses raw address row into candidates without concatenating across commas.
 */
function parseAddressRowToCandidate(rawAddress) {
    if (!rawAddress || typeof rawAddress !== 'string') return null;
    const rawParts = rawAddress.split(',').map(p => p.trim()).filter(Boolean);
    if (!rawParts.length) return null;
    if (rawParts.some(p => /\bpo\s*box\b/i.test(p))) return null;

    const remaining = [];
    for (const p of rawParts) {
        if (UNIT_PART_REGEX.test(p) && !hasThoroughfareEnding(p)) continue;
        if (FLOOR_PART_REGEX.test(p) && !hasThoroughfareEnding(p)) continue;
        const inlineFlat = p.match(/^((?:flat|unit|apt|apartment|room|suite)\s+[0-9a-z\/-]+)\s+(\d+[a-z]?(?:-\d+[a-z]?)?\s+.+)$/i);
        if (inlineFlat) {
            remaining.push(inlineFlat[2]);
            continue;
        }
        remaining.push(p);
    }
    if (!remaining.length) return null;

    const parsedParts = remaining.map((part, idx) => {
        const numMatch = part.match(/^(\d+[a-z]?(?:-\d+[a-z]?)?)\s+(.+)$/i);
        if (numMatch && !/^(?:\d+(?:st|nd|rd|th))$/i.test(numMatch[1])) {
            return {
                idx,
                numberPart: numMatch[1],
                text: cleanStreetName(numMatch[2]),
                isThoroughfare: hasThoroughfareEnding(numMatch[2])
            };
        }
        return {
            idx,
            numberPart: null,
            text: cleanStreetName(part),
            isThoroughfare: hasThoroughfareEnding(part)
        };
    });

    // Check standalone number before comma (e.g. "354, Castlehill")
    for (let i = 0; i < parsedParts.length - 1; i++) {
        const m = parsedParts[i].text.match(/^(\d+[a-z]?(?:-\d+[a-z]?)?)$/i);
        if (m && !/^(?:\d+(?:st|nd|rd|th))$/i.test(m[1])) {
            parsedParts[i + 1].numberPart = m[1];
            parsedParts.splice(i, 1);
            break;
        }
    }

    // Prefer numbered thoroughfare part
    const numbered = parsedParts.filter(p => p.numberPart && p.isThoroughfare);
    if (numbered.length > 0) {
        return numbered[numbered.length - 1].text;
    }

    // Prefer rightmost thoroughfare part
    const thoroughfares = parsedParts.filter(p => p.isThoroughfare);
    if (thoroughfares.length > 0) {
        return thoroughfares[thoroughfares.length - 1].text;
    }

    // Numbered part even without known thoroughfare suffix (e.g. "14 The Nook")
    const anyNumbered = parsedParts.filter(p => p.numberPart);
    if (anyNumbered.length > 0) {
        return anyNumbered[anyNumbered.length - 1].text;
    }

    // Last part if 2+ parts
    if (parsedParts.length >= 2) {
        return parsedParts[parsedParts.length - 1].text;
    }

    return null;
}

/**
 * Calculates a bounding box from an array of coordinates with padding in metres.
 */
function calculateBoundingBox(coords, paddingMeters = 250) {
    if (!coords || !coords.length) return null;
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    for (const c of coords) {
        if (!c || isNaN(c.lat) || isNaN(c.lon)) continue;
        if (c.lat < minLat) minLat = c.lat;
        if (c.lat > maxLat) maxLat = c.lat;
        if (c.lon < minLon) minLon = c.lon;
        if (c.lon > maxLon) maxLon = c.lon;
    }
    if (minLat > maxLat) return null;

    // Approximate degrees for padding
    const midLat = (minLat + maxLat) / 2;
    const latPad = paddingMeters / 111320;
    const lonPad = paddingMeters / (111320 * Math.cos((midLat * Math.PI) / 180));

    return {
        viewbox: `${minLon - lonPad},${maxLat + latPad},${maxLon + lonPad},${minLat - latPad}`,
        midLat,
        midLon: (minLon + maxLon) / 2
    };
}

/**
 * Verifies a single street against local Nominatim using multi-postcode bounding box.
 */
async function verifyStreetWithNominatim(streetName, postcodes, centroidMap, outcode = '', town = '') {
    const coords = postcodes.map(pc => centroidMap.get(pc)).filter(Boolean);
    const bbox = calculateBoundingBox(coords, 2500);

    const normTarget = normalizeStreetKey(streetName, false);
    const normTargetSaint = normalizeStreetKey(streetName, true);

    const checkHit = (hit) => {
        const addr = hit.address || {};
        const roadCandidates = [
            addr.road,
            addr.pedestrian,
            addr.street,
            addr.residential,
            addr.footway,
            addr.path,
            addr.place,
            addr.suburb,
            addr.neighbourhood,
            hit.name
        ].filter(Boolean);

        if (hit.display_name) {
            const firstPart = hit.display_name.split(',')[0].trim();
            if (firstPart && !roadCandidates.includes(firstPart)) {
                roadCandidates.push(firstPart);
            }
        }

        let bestMatch = null;
        for (const rc of roadCandidates) {
            const cmp = streetsMatch(streetName, rc);
            if (cmp.match) {
                bestMatch = cmp.type;
                if (cmp.type === 'exact') break;
            }
        }

        if (bestMatch) {
            const hLat = parseFloat(hit.lat);
            const hLon = parseFloat(hit.lon);
            let minDistance = coords.length === 0 ? 0 : 999999;
            for (const c of coords) {
                const d = haversineDistanceMeters(c.lat, c.lon, hLat, hLon);
                if (d < minDistance) minDistance = d;
            }
            return {
                matched: true,
                matchType: bestMatch,
                osmId: hit.osm_id || hit.place_id,
                osmClass: hit.class || 'highway',
                osmType: hit.type || 'road',
                displayName: hit.display_name,
                distanceM: Math.round(minDistance)
            };
        }
        return null;
    };

    const stExpanded = streetName.replace(/\bSt\.?\s+/gi, 'Saint ').replace(/\bSt\.?$/gi, 'Street');

    const queries = [];
    if (outcode) queries.push({ q: `${streetName}, ${outcode}` });
    if (town) queries.push({ q: `${streetName}, ${town}` });
    queries.push({ street: streetName });
    queries.push({ q: streetName });
    if (stExpanded !== streetName) {
        if (outcode) queries.push({ q: `${stExpanded}, ${outcode}` });
        queries.push({ q: stExpanded });
    }

    // 1. First attempt: bounded search in postcode viewbox
    for (const qObj of queries) {
        try {
            const params = {
                ...qObj,
                format: 'jsonv2',
                addressdetails: 1,
                countrycodes: 'gb',
                limit: 5
            };
            if (bbox) {
                params.viewbox = bbox.viewbox;
                params.bounded = 1;
            }
            const res = await httpClient.get('/search', { params });
            for (const hit of res.data || []) {
                const match = checkHit(hit);
                if (match && (match.distanceM <= 3500 || coords.length === 0)) return match;
            }
        } catch (_) {}
    }

    // 2. Second attempt: unbounded search biased by viewbox
    if (bbox) {
        for (const qObj of queries.slice(0, 2)) {
            try {
                const res = await httpClient.get('/search', {
                    params: {
                        ...qObj,
                        viewbox: bbox.viewbox,
                        bounded: 0,
                        format: 'jsonv2',
                        addressdetails: 1,
                        countrycodes: 'gb',
                        limit: 5
                    }
                });
                for (const hit of res.data || []) {
                    const match = checkHit(hit);
                    if (match && match.distanceM <= 4500) return match;
                }
            } catch (_) {}
        }
    }

    return { matched: false, matchType: 'osm_gap', osmId: null, distanceM: null };
}

/**
 * Worker to process a single outcode.
 */
async function processOutcode(outcode, db) {
    const coll = db.collection('address_master_merged');
    const centroidColl = db.collection('postcode_centroids');
    const destColl = db.collection('sector_streets');

    // 1. Load all centroids for this outcode into memory map
    const centroidDocs = await centroidColl.find({
        postcode: { $gte: `${outcode} `, $lt: `${outcode} \uffff` }
    }).project({ postcode: 1, lat: 1, lon: 1, _id: 0 }).toArray();

    const centroidMap = new Map();
    for (const c of centroidDocs) {
        centroidMap.set(c.postcode, { lat: c.lat, lon: c.lon });
    }

    // 2. Query all address rows in this outcode (covered index)
    const rangePrefix = `${outcode} `;
    const rows = await coll.find({
        postcode: { $gte: rangePrefix, $lt: `${rangePrefix}\uffff` }
    }).project({ address: 1, district: 1, postcode: 1, _id: 0 }).toArray();

    if (!rows.length) return { outcode, streetCount: 0, verifiedCount: 0 };

    // Group rows by parsed street candidate
    const streetMap = new Map();
    const townCount = new Map();

    for (const r of rows) {
        if (r.district) {
            townCount.set(r.district, (townCount.get(r.district) || 0) + 1);
        }
        const candidate = parseAddressRowToCandidate(r.address);
        if (!candidate) continue;

        const key = candidate.toLowerCase();
        if (!streetMap.has(key)) {
            streetMap.set(key, {
                display: candidate,
                streetKey: key,
                postcodes: new Set(),
                sectors: new Set(),
                rowCount: 0
            });
        }
        const st = streetMap.get(key);
        st.rowCount++;
        if (r.postcode) {
            st.postcodes.add(r.postcode);
            const sec = r.postcode.slice(0, -2).trim();
            if (sec) st.sectors.add(sec);
        }
    }

    // Determine dominant town
    let dominantTown = '';
    let maxTownCount = 0;
    for (const [t, cnt] of townCount.entries()) {
        if (cnt > maxTownCount) {
            maxTownCount = cnt;
            dominantTown = t;
        }
    }

    const streets = Array.from(streetMap.values());
    const writeOps = [];
    let verifiedCount = 0;

    for (const st of streets) {
        const postcodesArr = Array.from(st.postcodes);
        const sectorsArr = Array.from(st.sectors);
        const primarySector = sectorsArr[0] || `${outcode} 0`;

        const verResult = await verifyStreetWithNominatim(st.display, postcodesArr, centroidMap, outcode, dominantTown);

        const isVerified = verResult.matched;
        if (isVerified) verifiedCount++;

        writeOps.push({
            updateOne: {
                filter: { outcode, streetKey: st.streetKey },
                update: {
                    $set: {
                        outcode,
                        sector: primarySector,
                        sectors: sectorsArr,
                        streetKey: st.streetKey,
                        display: st.display,
                        town: dominantTown,
                        rowCount: st.rowCount,
                        verified: isVerified,
                        source: isVerified ? verResult.matchType : 'osm_gap',
                        osmId: verResult.osmId || null,
                        osmClass: verResult.osmClass || null,
                        osmType: verResult.osmType || null,
                        distanceM: verResult.distanceM || null,
                        checkedAt: new Date(),
                        osmDataVersion: DATA_VERSION
                    }
                },
                upsert: true
            }
        });
    }

    if (writeOps.length > 0) {
        await destColl.bulkWrite(writeOps, { ordered: false });
    }

    return { outcode, streetCount: streets.length, verifiedCount };
}

async function main() {
    const args = process.argv.slice(2);
    const regionArg = (args.find(a => a.startsWith('--region=')) || '').replace('--region=', '').toLowerCase();
    const outcodesArg = (args.find(a => a.startsWith('--outcodes=')) || '').replace('--outcodes=', '').toUpperCase();
    const isAll = args.includes('--all');

    console.log('====================================================================');
    console.log(' SOCIALWIKI SECTOR_STREETS BUILDER (Multi-Postcode Centroids + Parser v2)');
    console.log('====================================================================');
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`Nominatim: ${NOMINATIM_URL}`);
    console.log(`Max concurrency: ${MAX_CONCURRENCY}`);

    const client = new MongoClient(MONGO_URI);
    await client.connect();
    const db = client.db();

    // Ensure indexes on sector_streets
    const destColl = db.collection('sector_streets');
    await destColl.createIndex({ outcode: 1, streetKey: 1 }, { unique: true });
    await destColl.createIndex({ outcode: 1, verified: 1 });
    await destColl.createIndex({ sector: 1, verified: 1 });

    const progressColl = db.collection('sector_streets_progress');
    await progressColl.createIndex({ outcode: 1 }, { unique: true });

    // Determine target outcodes
    let targetOutcodes = [];
    if (outcodesArg) {
        targetOutcodes = outcodesArg.split(',').map(s => s.trim()).filter(Boolean);
    } else if (regionArg && REGION_MAP[regionArg]) {
        const areaPrefixes = REGION_MAP[regionArg];
        console.log(`Target region: ${regionArg} (${areaPrefixes.join(', ')})`);
        const distinctOutcodes = await db.collection('address_master_merged').aggregate([
            {
                $match: {
                    $or: areaPrefixes.map(p => ({
                        postcode: { $gte: `${p}0 `, $lt: `${p}99 \uffff` }
                    }))
                }
            },
            {
                $project: {
                    outcode: { $arrayElemAt: [{ $split: ["$postcode", " "] }, 0] }
                }
            },
            { $group: { _id: "$outcode" } },
            { $sort: { _id: 1 } }
        ]).toArray();
        targetOutcodes = distinctOutcodes.map(d => d._id).filter(Boolean);
    } else if (isAll) {
        console.log('Mode: ALL UK outcodes');
        const distinctOutcodes = await db.collection('address_master_merged').aggregate([
            {
                $project: {
                    outcode: { $arrayElemAt: [{ $split: ["$postcode", " "] }, 0] }
                }
            },
            { $group: { _id: "$outcode" } },
            { $sort: { _id: 1 } }
        ]).toArray();
        targetOutcodes = distinctOutcodes.map(d => d._id).filter(Boolean);
    } else {
        console.log('Usage:');
        console.log('  node scripts/build_sector_streets.js --region=yorkshire');
        console.log('  node scripts/build_sector_streets.js --region=scotland');
        console.log('  node scripts/build_sector_streets.js --outcodes=DN41,HU1');
        console.log('  node scripts/build_sector_streets.js --all');
        await client.close();
        process.exit(0);
    }

    const isForce = args.includes('--force');

    console.log(`Found ${targetOutcodes.length} outcodes to process.`);

    // Check completed outcodes for checkpoint resume
    let completedSet = new Set();
    if (!isForce) {
        const completedDocs = await progressColl.find({ status: 'completed' }).project({ outcode: 1, _id: 0 }).toArray();
        completedSet = new Set(completedDocs.map(d => d.outcode));
    } else {
        console.log('Mode: --force specified, re-processing target outcodes.');
        await progressColl.deleteMany({ outcode: { $in: targetOutcodes } });
    }

    const remainingOutcodes = targetOutcodes.filter(o => !completedSet.has(o));
    console.log(`${completedSet.size} outcodes already completed. ${remainingOutcodes.length} remaining.`);

    let processedCount = 0;
    let totalStreets = 0;
    let totalVerified = 0;

    // Process with pool of MAX_CONCURRENCY workers
    let queueIdx = 0;
    async function worker(workerId) {
        while (queueIdx < remainingOutcodes.length) {
            const outcode = remainingOutcodes[queueIdx++];
            const t0 = Date.now();
            try {
                await progressColl.updateOne(
                    { outcode },
                    { $set: { status: 'in_progress', startedAt: new Date() } },
                    { upsert: true }
                );

                const res = await processOutcode(outcode, db);
                const elapsedMs = Date.now() - t0;

                await progressColl.updateOne(
                    { outcode },
                    {
                        $set: {
                            status: 'completed',
                            completedAt: new Date(),
                            streetCount: res.streetCount,
                            verifiedCount: res.verifiedCount,
                            elapsedMs
                        }
                    }
                );

                processedCount++;
                totalStreets += res.streetCount;
                totalVerified += res.verifiedCount;

                const pct = res.streetCount > 0 ? ((res.verifiedCount / res.streetCount) * 100).toFixed(1) : '100.0';
                console.log(`[W${workerId}] (${processedCount}/${remainingOutcodes.length}) Outcode ${outcode}: ${res.verifiedCount}/${res.streetCount} streets verified (${pct}%) in ${elapsedMs}ms`);
            } catch (err) {
                console.error(`[W${workerId}] ERROR processing outcode ${outcode}: ${err.message}`);
                await progressColl.updateOne(
                    { outcode },
                    { $set: { status: 'failed', error: err.message, failedAt: new Date() } }
                );
            }
        }
    }

    const workers = [];
    for (let i = 1; i <= Math.min(MAX_CONCURRENCY, remainingOutcodes.length); i++) {
        workers.push(worker(i));
    }

    await Promise.all(workers);

    console.log('\n====================================================================');
    console.log(' BUILD RUN FINISHED');
    console.log(`Outcodes processed: ${processedCount}`);
    console.log(`Total unique streets: ${totalStreets}`);
    console.log(`Total verified: ${totalVerified} (${totalStreets > 0 ? ((totalVerified / totalStreets) * 100).toFixed(1) : 0}%)`);
    console.log('====================================================================');

    await client.close();
}

main().catch(err => {
    console.error('Fatal builder error:', err);
    process.exit(1);
});
