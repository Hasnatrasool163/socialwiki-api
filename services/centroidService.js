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
    const clean = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (clean.length > 3) {
        return `${clean.slice(0, -3)} ${clean.slice(-3)}`;
    }
    return clean;
}

/**
 * Retrieve centroid { lat, lon } for a given UK postcode
 */
async function getPostcodeCentroid(rawPostcode) {
    const pc = normalizePostcode(rawPostcode);
    if (!pc || !pc.includes(' ')) return null;

    // 1. LRU Cache check
    if (centroidCache.has(pc)) {
        return centroidCache.get(pc);
    }

    try {
        // 2. MongoDB check
        const doc = await PostcodeCentroid.findOne({ postcode: pc }).lean();
        if (doc && typeof doc.lat === 'number' && typeof doc.lon === 'number') {
            const centroid = { lat: doc.lat, lon: doc.lon, source: doc.source || 'os_codepoint_open' };
            centroidCache.set(pc, centroid);
            return centroid;
        }

        // 3. Fallback to api.postcodes.io (OGL license, supports full UK including BT postcodes)
        const encoded = encodeURIComponent(pc);
        const resp = await axios.get(`https://api.postcodes.io/postcodes/${encoded}`, {
            timeout: 2000
        });

        if (resp.data && resp.data.result && typeof resp.data.result.latitude === 'number') {
            const lat = resp.data.result.latitude;
            const lon = resp.data.result.longitude;
            const eastings = resp.data.result.eastings || null;
            const northings = resp.data.result.northings || null;
            const isBT = pc.startsWith('BT');
            const source = isBT ? 'osni_postcodes_io' : 'postcodes_io_ogl';

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
