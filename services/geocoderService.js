/**
 * geocoderService.js
 *
 * Implements server-side geocoding with:
 * - Configurable URL, key, tile URL, and MAP_ENABLED flag
 * - 2-second request timeout
 * - Circuit breaker (trips on 3 consecutive failures, resets after cooldown)
 * - 1 request/sec global rate-limiter queue (OSM Acceptable Use Policy)
 * - Identifying User-Agent
 * - Centroid bounding (~1 km viewbox, bounded=1, countrycodes=gb, limit=1)
 * - Proximity verification (accepts result only if <= 1.5 km from centroid)
 * - 24-hour in-memory LRU cache (never stored in DB to respect ODbL)
 * - Silent fallback to Step 1 centroid map
 */

const axios = require('axios');
const { LRUCache } = require('lru-cache');
const { haversineDistanceMeters } = require('../utils/bngToWgs84');
const { getPostcodeCentroid, normalizePostcode } = require('./centroidService');
const logger = require('../config/logger');

// Configuration
const CONFIG = {
    get mapEnabled() {
        return process.env.MAP_ENABLED !== 'false';
    },
    get geocoderUrl() {
        return process.env.GEOCODER_URL || 'https://nominatim.openstreetmap.org/search';
    },
    get geocoderKey() {
        return process.env.GEOCODER_KEY || '';
    },
    get tileUrl() {
        return process.env.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
    },
    userAgent: process.env.GEOCODER_USER_AGENT || 'SocialWiki-AddressConfirmation/1.0 (admin@socialwiki.co.uk; https://socialwiki.co.uk)',
    timeoutMs: 2000,
    maxDistanceMeters: 1500, // 1.5 km proximity threshold around centroid
    disclaimer: 'Map locations come from OpenStreetMap contributors and are indicative only.'
};

// 24-hour in-memory cache (never persisted to DB)
const geocodeCache = new LRUCache({
    max: 10000,
    ttl: 1000 * 60 * 60 * 24 // 24 hours
});

// Circuit Breaker State
const circuitBreaker = {
    state: 'CLOSED', // 'CLOSED' | 'OPEN' | 'HALF_OPEN'
    consecutiveFailures: 0,
    threshold: 3,
    resetTimeoutMs: 60000, // 60 seconds cooldown
    nextAttempt: 0,

    recordSuccess() {
        this.consecutiveFailures = 0;
        this.state = 'CLOSED';
    },

    recordFailure() {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.threshold) {
            this.state = 'OPEN';
            this.nextAttempt = Date.now() + this.resetTimeoutMs;
            logger.warn(`[Circuit Breaker] Trip OPEN. Geocoder paused for ${this.resetTimeoutMs / 1000}s`);
        }
    },

    canAttempt() {
        if (this.state === 'CLOSED') return true;
        if (this.state === 'OPEN') {
            if (Date.now() >= this.nextAttempt) {
                this.state = 'HALF_OPEN';
                logger.info('[Circuit Breaker] Transitioning to HALF_OPEN probe');
                return true;
            }
            return false;
        }
        return true; // HALF_OPEN
    }
};

// Global 1 request per second FIFO Queue
class RateLimitedQueue {
    constructor(intervalMs = 1000) {
        this.intervalMs = intervalMs;
        this.queue = [];
        this.running = false;
        this.lastCallTime = 0;
    }

    enqueue(task) {
        return new Promise((resolve, reject) => {
            this.queue.push({ task, resolve, reject });
            this.process();
        });
    }

    async process() {
        if (this.running || this.queue.length === 0) return;
        this.running = true;

        while (this.queue.length > 0) {
            const now = Date.now();
            const timeSinceLast = now - this.lastCallTime;
            if (timeSinceLast < this.intervalMs) {
                await new Promise(r => setTimeout(r, this.intervalMs - timeSinceLast));
            }

            const item = this.queue.shift();
            if (!item) break;

            this.lastCallTime = Date.now();
            try {
                const result = await item.task();
                item.resolve(result);
            } catch (err) {
                item.reject(err);
            }
        }

        this.running = false;
    }
}

const globalQueue = new RateLimitedQueue(1000);

/**
 * Locate structured address
 * POST /api/rm/locate payload: { postcode, street, number, unit }
 */
async function locateAddress({ postcode: rawPc, street: rawStreet, number: rawNum }) {
    const pc = normalizePostcode(rawPc);
    const street = (rawStreet || '').trim();
    const number = (rawNum || '').trim();

    // 1. Resolve postcode centroid first (Step 1 map reference)
    const centroid = await getPostcodeCentroid(pc);

    // If map disabled or no centroid available, return silent fallback
    if (!CONFIG.mapEnabled || !centroid) {
        return {
            status: 'fallback',
            mapEnabled: CONFIG.mapEnabled,
            tileUrl: CONFIG.tileUrl,
            centroid: centroid || null,
            location: null,
            disclaimer: CONFIG.disclaimer
        };
    }

    // Cache key for geocode result
    const cacheKey = `${pc}|${street.toLowerCase()}|${number.toLowerCase()}`;
    if (geocodeCache.has(cacheKey)) {
        const cached = geocodeCache.get(cacheKey);
        return {
            status: cached ? 'located' : 'fallback',
            mapEnabled: true,
            tileUrl: CONFIG.tileUrl,
            centroid,
            location: cached,
            disclaimer: CONFIG.disclaimer
        };
    }

    // Circuit breaker check
    if (!circuitBreaker.canAttempt()) {
        logger.debug('[Geocoder] Circuit breaker open, falling back to Step 1 centroid map');
        return {
            status: 'fallback',
            mapEnabled: true,
            tileUrl: CONFIG.tileUrl,
            centroid,
            location: null,
            disclaimer: CONFIG.disclaimer
        };
    }

    // Calculate ~1 km viewbox around centroid
    // 1 km lat delta approx 0.009 deg; 1 km lon delta approx 0.009 / cos(lat)
    const latDelta = 0.009;
    const lonDelta = 0.009 / Math.cos(centroid.lat * Math.PI / 180);

    const minLon = (centroid.lon - lonDelta).toFixed(6);
    const maxLon = (centroid.lon + lonDelta).toFixed(6);
    const minLat = (centroid.lat - latDelta).toFixed(6);
    const maxLat = (centroid.lat + latDelta).toFixed(6);

    // Viewbox format: left,top,right,bottom (minlon,maxlat,maxlon,minlat)
    const viewboxStr = `${minLon},${maxLat},${maxLon},${minLat}`;

    // Build structured query: "number street, postcode, gb"
    const queryParts = [];
    if (number) queryParts.push(number);
    if (street) queryParts.push(street);
    queryParts.push(pc);
    queryParts.push('gb');
    const queryString = queryParts.join(', ');

    try {
        const result = await globalQueue.enqueue(async () => {
            const params = {
                q: queryString,
                format: 'jsonv2',
                limit: 1,
                countrycodes: 'gb',
                viewbox: viewboxStr,
                bounded: 1
            };

            if (CONFIG.geocoderKey) {
                params.key = CONFIG.geocoderKey;
            }

            const response = await axios.get(CONFIG.geocoderUrl, {
                params,
                headers: {
                    'User-Agent': CONFIG.userAgent,
                    'Accept': 'application/json'
                },
                timeout: CONFIG.timeoutMs
            });

            return response.data;
        });

        circuitBreaker.recordSuccess();

        if (Array.isArray(result) && result.length > 0) {
            const hit = result[0];
            const hitLat = parseFloat(hit.lat);
            const hitLon = parseFloat(hit.lon);

            if (!isNaN(hitLat) && !isNaN(hitLon)) {
                // Verify proximity: accept ONLY if near centroid (<= 1.5 km)
                const dist = haversineDistanceMeters(centroid.lat, centroid.lon, hitLat, hitLon);
                if (dist <= CONFIG.maxDistanceMeters) {
                    const locationData = {
                        lat: hitLat,
                        lon: hitLon,
                        label: 'Map location (OpenStreetMap)',
                        distanceMeters: Math.round(dist)
                    };

                    geocodeCache.set(cacheKey, locationData);
                    return {
                        status: 'located',
                        mapEnabled: true,
                        tileUrl: CONFIG.tileUrl,
                        centroid,
                        location: locationData,
                        disclaimer: CONFIG.disclaimer
                    };
                } else {
                    logger.debug(`[Geocoder] Hit rejected: distance ${Math.round(dist)}m exceeds threshold from centroid ${pc}`);
                }
            }
        }

        // Cache negative result so we don't hammer Nominatim repeatedly
        geocodeCache.set(cacheKey, null);
    } catch (err) {
        circuitBreaker.recordFailure();
        logger.warn(`[Geocoder] Request failed: ${err.message} (code: ${err.code})`);
    }

    // Silent fallback to Step 1 centroid map
    return {
        status: 'fallback',
        mapEnabled: true,
        tileUrl: CONFIG.tileUrl,
        centroid,
        location: null,
        disclaimer: CONFIG.disclaimer
    };
}

module.exports = {
    locateAddress,
    CONFIG,
    circuitBreaker
};
