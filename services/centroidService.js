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

    const clean = s.replace(/[^A-Z0-9]/g, '');
    if (clean.length > 3) {
        return `${clean.slice(0, -3)} ${clean.slice(-3)}`;
    }
    return clean;
}

/**
 * Retrieve centroid { lat, lon } for a given UK postcode or sector
 */
async function getPostcodeCentroid(rawPostcode) {
    const pc = normalizePostcode(rawPostcode);
    if (!pc) return null;

    // 1. LRU Cache check
    if (centroidCache.has(pc)) {
        return centroidCache.get(pc);
    }

    try {
        // 2. MongoDB check (exact match or sector prefix)
        let doc = await PostcodeCentroid.findOne({ postcode: pc }).lean();
        if (!doc) {
            const escaped = pc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            doc = await PostcodeCentroid.findOne({ postcode: { $regex: `^${escaped}` } }).lean();
        }

        if (doc && typeof doc.lat === 'number' && typeof doc.lon === 'number') {
            const centroid = { lat: doc.lat, lon: doc.lon, source: doc.source || 'os_codepoint_open' };
            centroidCache.set(pc, centroid);
            return centroid;
        }

        // 3. Fallback to api.postcodes.io
        const isFull = /^[A-Z]{1,2}[0-9][A-Z0-9]?\s+[0-9][A-Z]{2}$/i.test(pc);
        const outcode = pc.split(' ')[0];
        const url = isFull
            ? `https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`
            : `https://api.postcodes.io/outcodes/${encodeURIComponent(outcode)}`;

        const resp = await axios.get(url, { timeout: 2000 });

        if (resp.data && resp.data.result && typeof resp.data.result.latitude === 'number') {
            const lat = resp.data.result.latitude;
            const lon = resp.data.result.longitude;
            const eastings = resp.data.result.eastings || null;
            const northings = resp.data.result.northings || null;
            const isBT = pc.startsWith('BT');
            const source = isBT ? 'osni_postcodes_io' : (isFull ? 'postcodes_io_ogl' : 'postcodes_io_outcode');

            const centroid = { lat, lon, source };
            centroidCache.set(pc, centroid);

            // Async background save to MongoDB (do not block)
            PostcodeCentroid.findOneAndUpdate(
                { postcode: pc },
                { postcode: pc, lat, lon, eastings, northings, source },
                { upsert: true, new: true }
            ).catch(err => {
                logger.warn(`Failed to cache centroid in MongoDB for ${pc}: ${err.message}`);
            });

            return centroid;
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
