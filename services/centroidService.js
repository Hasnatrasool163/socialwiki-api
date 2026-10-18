/**
 * centroidService.js
 *
 * Resolves postcode centroid coordinates (WGS84 lat/lon).
 * 1. Checks in-memory LRU cache
 * 2. Checks MongoDB collection 'postcode_centroids'
 * 3. Falls back to open OGL service (api.postcodes.io) for unseeded postcodes and Northern Ireland (BT)
 * 4. Caches result in MongoDB for sub-millisecond future queries.
 */

const { LRUCache } = require('lru-cache');
const axios = require('axios');
const PostcodeCentroid = require('../models/PostcodeCentroid');
const logger = require('../config/logger');

const centroidCache = new LRUCache({
    max: 50000,
    ttl: 1000 * 60 * 60 * 24 // 24 hours
});

/**
 * Normalise postcode string (e.g. "dn41 7ru" -> "DN41 7RU")
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
 * Retrieve centroid { lat, lon } for a given UK postcode, sector, or outcode
 */
async function getPostcodeCentroid(rawPostcode) {
    const pc = normalizePostcode(rawPostcode);
    if (!pc) return null;

    // 1. LRU Cache check
    if (centroidCache.has(pc)) {
        return centroidCache.get(pc);
    }

    try {
        // 2. MongoDB check (exact match or indexed range prefix)
        let doc = await PostcodeCentroid.findOne({ postcode: pc }).lean();
        if (!doc) {
            const rangePrefix = pc.includes(' ') ? pc : `${pc} `;
            doc = await PostcodeCentroid.findOne({
                postcode: { $gte: rangePrefix, $lt: `${rangePrefix}\uffff` }
            }).lean();
        }
        // Fallback if a 2-digit outcode was typed with a space (e.g. "AL1 0" -> "AL10 ")
        if (!doc && /^([A-Z]{1,2}[0-9])\s+([0-9])$/i.test(pc)) {
            const collapsed = pc.replace(/\s+/g, '');
            doc = await PostcodeCentroid.findOne({
                postcode: { $gte: `${collapsed} `, $lt: `${collapsed} \uffff` }
            }).lean();
        }

        if (doc && typeof doc.lat === 'number' && typeof doc.lon === 'number') {
            const centroid = { lat: doc.lat, lon: doc.lon, source: doc.source || 'os_codepoint_open' };
            centroidCache.set(pc, centroid);
            return centroid;
        }

        // 3. Fallback to local self-hosted UK Nominatim (127.0.0.1:8088) — no external API calls
        const nominatimBase = (process.env.NOMINATIM_URL || 'http://127.0.0.1:8088').replace(/\/+$/, '');
        const resp = await axios.get(`${nominatimBase}/search`, {
            params: {
                postalcode: pc,
                countrycodes: 'gb',
                format: 'jsonv2',
                limit: 1
            },
            timeout: 1500
        });

        if (Array.isArray(resp.data) && resp.data.length > 0 && resp.data[0].lat && resp.data[0].lon) {
            const lat = parseFloat(resp.data[0].lat);
            const lon = parseFloat(resp.data[0].lon);
            if (!isNaN(lat) && !isNaN(lon)) {
                const source = 'os_codepoint_open';
                const centroid = { lat, lon, source };
                centroidCache.set(pc, centroid);

                PostcodeCentroid.findOneAndUpdate(
                    { postcode: pc },
                    { postcode: pc, lat, lon, source },
                    { upsert: true, new: true }
                ).catch(err => {
                    logger.warn(`Failed to cache centroid in MongoDB for ${pc}: ${err.message}`);
                });

                return centroid;
            }
        }
    } catch (err) {
        logger.debug(`Centroid resolution note for ${pc}: ${err.message}`);
    }

    return null;
}

module.exports = {
    getPostcodeCentroid,
    normalizePostcode
};
