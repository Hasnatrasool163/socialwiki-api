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
    get nominatimBaseUrl() {
        return (process.env.NOMINATIM_URL || 'http://127.0.0.1:8088').replace(/\/+$/, '');
    },
    get geocoderUrl() {
        return process.env.GEOCODER_URL || `${this.nominatimBaseUrl}/search`;
    },
    get reverseUrl() {
        return process.env.GEOCODER_REVERSE_URL || `${this.nominatimBaseUrl}/reverse`;
    },
    get isLocal() {
        const u = this.geocoderUrl;
        return u.includes('127.0.0.1') || u.includes('localhost');
    },
    get geocoderKey() {
        return process.env.GEOCODER_KEY || '';
    },
    get tileUrl() {
        return process.env.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
    },
    userAgent: process.env.GEOCODER_USER_AGENT || 'SocialWiki-AddressConfirmation/1.0 (admin@socialwiki.co.uk; https://socialwiki.co.uk)',
    timeoutMs: 3000,
    maxDistanceMeters: 1500, // 1.5 km proximity threshold around full postcode centroid
    sectorMaxDistanceMeters: 3500, // 3.5 km proximity threshold around postcode sector centroid
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
    threshold: 5,
    resetTimeoutMs: 30000, // 30 seconds cooldown
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

// Global FIFO Queue (only throttles external public OSM, instant for local 127.0.0.1:8088)
class RateLimitedQueue {
    constructor(intervalMs = 1000) {
        this.intervalMs = intervalMs;
        this.queue = [];
        this.running = false;
        this.lastCallTime = 0;
    }

    enqueue(task) {
        if (CONFIG.isLocal) {
            return task();
        }
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
 * Helper to execute a search query against Nominatim
 */
async function queryNominatimSearch(params) {
    return globalQueue.enqueue(async () => {
        const queryParams = {
            format: 'jsonv2',
            countrycodes: 'gb',
            ...params
        };
        if (CONFIG.geocoderKey) {
            queryParams.key = CONFIG.geocoderKey;
        }
        const response = await axios.get(CONFIG.geocoderUrl, {
            params: queryParams,
            headers: {
                'User-Agent': CONFIG.userAgent,
                'Accept': 'application/json'
            },
            timeout: CONFIG.timeoutMs
        });
        return response.data;
    });
}

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

    const isFullPc = /^[A-Z]{1,2}[0-9][A-Z0-9]?\s+[0-9][A-Z]{2}$/i.test(pc);
    const maxAllowedDist = isFullPc ? CONFIG.maxDistanceMeters : CONFIG.sectorMaxDistanceMeters;

    // Calculate viewbox around centroid (~1.5 km for full postcode, ~3.5 km for sector)
    const latDelta = isFullPc ? 0.012 : 0.028;
    const lonDelta = latDelta / Math.cos(centroid.lat * Math.PI / 180);

    const minLon = (centroid.lon - lonDelta).toFixed(6);
    const maxLon = (centroid.lon + lonDelta).toFixed(6);
    const minLat = (centroid.lat - latDelta).toFixed(6);
    const maxLat = (centroid.lat + latDelta).toFixed(6);

    // Viewbox format: left,top,right,bottom (minlon,maxlat,maxlon,minlat)
    const viewboxStr = `${minLon},${maxLat},${maxLon},${minLat}`;
    const outcode = pc.split(' ')[0];

    // Candidate queries in priority order:
    // 1. Full query with postcode (if full postcode)
    // 2. Number + street bounded within centroid viewbox
    // 3. Street + outcode bounded within centroid viewbox
    // 4. Street only bounded within centroid viewbox
    const candidateQueries = [];
    if (isFullPc && street) {
        candidateQueries.push([number, street, pc].filter(Boolean).join(', '));
    }
    if (street && number) {
        candidateQueries.push(`${number} ${street}, ${outcode}`);
        candidateQueries.push(`${number} ${street}`);
    }
    if (street) {
        candidateQueries.push(`${street}, ${outcode}`);
        candidateQueries.push(street);
    }

    try {
        let matchedHit = null;
        let matchedDist = 0;

        for (const qStr of candidateQueries) {
            const result = await queryNominatimSearch({
                q: qStr,
                limit: 3,
                addressdetails: 1,
                viewbox: viewboxStr,
                bounded: 1
            });

            if (Array.isArray(result) && result.length > 0) {
                for (const hit of result) {
                    const hitLat = parseFloat(hit.lat);
                    const hitLon = parseFloat(hit.lon);
                    if (!isNaN(hitLat) && !isNaN(hitLon)) {
                        const dist = haversineDistanceMeters(centroid.lat, centroid.lon, hitLat, hitLon);
                        if (dist <= maxAllowedDist) {
                            matchedHit = hit;
                            matchedDist = dist;
                            break;
                        }
                    }
                }
            }
            if (matchedHit) break;
        }

        circuitBreaker.recordSuccess();

        if (matchedHit) {
            const locationData = {
                lat: parseFloat(matchedHit.lat),
                lon: parseFloat(matchedHit.lon),
                label: 'Map location (OpenStreetMap)',
                displayName: matchedHit.display_name || '',
                category: matchedHit.category || '',
                type: matchedHit.type || '',
                placeRank: matchedHit.place_rank || null,
                distanceMeters: Math.round(matchedDist)
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

/**
 * Direct Nominatim Search (Simple q= or Structured street/city/county/state/country/postalcode)
 */
async function searchNominatim(rawParams = {}) {
    const baseParams = {
        format: 'jsonv2',
        addressdetails: 1,
        extratags: 1,
        namedetails: 1,
        polygon_geojson: 1,
        limit: Math.min(parseInt(rawParams.limit, 10) || 15, 40),
        countrycodes: rawParams.countrycodes || 'gb'
    };

    if (rawParams.dedupe !== undefined) {
        baseParams.dedupe = rawParams.dedupe;
    }

    if (rawParams.q) {
        const data = await queryNominatimSearch({
            ...baseParams,
            q: String(rawParams.q).trim()
        });
        return Array.isArray(data) ? data : [];
    }

    const structuredParams = { ...baseParams };
    if (rawParams.street) structuredParams.street = String(rawParams.street).trim();
    if (rawParams.city) structuredParams.city = String(rawParams.city).trim();
    if (rawParams.county) structuredParams.county = String(rawParams.county).trim();
    if (rawParams.state) structuredParams.state = String(rawParams.state).trim();
    if (rawParams.country) structuredParams.country = String(rawParams.country).trim();
    if (rawParams.postalcode) structuredParams.postalcode = String(rawParams.postalcode).trim();

    let data = await queryNominatimSearch(structuredParams);
    if ((!Array.isArray(data) || data.length === 0) && rawParams.postalcode) {
        const pcNorm = normalizePostcode(rawParams.postalcode);
        const outcode = pcNorm.split(' ')[0];
        const fallbackQ = [
            rawParams.street,
            rawParams.city,
            rawParams.county,
            outcode
        ].map(v => (v ? String(v).trim() : '')).filter(Boolean).join(', ');

        if (fallbackQ) {
            data = await queryNominatimSearch({
                ...baseParams,
                q: fallbackQ
            });
        }
    }

    return Array.isArray(data) ? data : [];
}

/**
 * Direct Nominatim Reverse Geocode (lat, lon, zoom)
 */
async function reverseNominatim({ lat, lon, zoom = 18 }) {
    return globalQueue.enqueue(async () => {
        const params = {
            lat: Number(lat),
            lon: Number(lon),
            zoom: Number(zoom) || 18,
            format: 'jsonv2',
            addressdetails: 1,
            extratags: 1,
            namedetails: 1,
            polygon_geojson: 1
        };
        if (CONFIG.geocoderKey) {
            params.key = CONFIG.geocoderKey;
        }
        const response = await axios.get(CONFIG.reverseUrl, {
            params,
            headers: {
                'User-Agent': CONFIG.userAgent,
                'Accept': 'application/json'
            },
            timeout: CONFIG.timeoutMs
        });
        return response.data;
    });
}

module.exports = {
    locateAddress,
    searchNominatim,
    reverseNominatim,
    CONFIG,
    circuitBreaker
};
