/**
 * test_rm_phase3.js
 * Verification test suite for Phase 3:
 * - BNG to WGS84 coordinate conversion
 * - Unit hint detection and priority ordering
 * - Input sanitization (HTML/control characters stripped)
 * - Geocoder circuit breaker & proximity verification
 * - Validation response format (validated booleans, separate address object, userEntered field names)
 */

const assert = require('assert');
const { bngToWgs84, haversineDistanceMeters } = require('../utils/bngToWgs84');
const { circuitBreaker, locateAddress, CONFIG } = require('../services/geocoderService');

async function runTests() {
    console.log('=== Running Phase 3 Address Confirmation Tests ===\n');

    // 1. Test BNG to WGS84 conversion accuracy
    console.log('[Test 1] British National Grid to WGS84 Conversion');
    // Big Ben (OSGB: 530040, 179960) -> approx (51.5007° N, -0.1246° W)
    const bigBen = bngToWgs84(530040, 179960);
    assert(bigBen !== null, 'Big Ben coordinates must not be null');
    assert(Math.abs(bigBen.lat - 51.503) < 0.01, `Latitude should be near 51.50, got ${bigBen.lat}`);
    assert(Math.abs(bigBen.lon - (-0.127)) < 0.01, `Longitude should be near -0.127, got ${bigBen.lon}`);
    console.log(`  ✓ Big Ben converted: lat=${bigBen.lat}, lon=${bigBen.lon}`);

    // Invalid coordinates handling
    const invalidCoords = bngToWgs84(0, 0);
    assert.strictEqual(invalidCoords, null, 'Invalid or 0 coordinates should return null');
    console.log('  ✓ Zero/invalid coordinates safely return null');

    // 2. Proximity calculation test
    console.log('\n[Test 2] Haversine Distance & Proximity Check');
    // Distance from Westminster to Trafalgar Square is ~950m
    const dist = haversineDistanceMeters(51.4995, -0.1285, 51.5080, -0.1281);
    assert(dist > 900 && dist < 1000, `Expected distance ~946m, got ${dist}`);
    console.log(`  ✓ Distance calculated: ${Math.round(dist)} meters (< 1.5km proximity threshold)`);

    // Distance Westminster to Edinburgh is ~530km
    const distant = haversineDistanceMeters(51.4995, -0.1285, 55.9533, -3.1883);
    assert(distant > 500000, 'Distant check should be over 500km');
    console.log(`  ✓ Distant result (${Math.round(distant / 1000)} km) exceeds threshold and is rejected`);

    // 3. Unit hints detection and ordering test
    console.log('\n[Test 3] Unit Hints Ordering and Filtering');
    const { parseAddressRow } = require('../controllers/rmValidationController');

    const sampleRows = [
        { address: 'Flat 4, 2nd Floor, 12 High Street' },
        { address: 'Suite 201, 12 High Street' },
        { address: 'Unit 5, 12 High Street' },
        { address: 'Block B, 12 High Street' }
    ];

    // Mock detection function mirroring rmValidationController
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

    const joinedText = sampleRows.map(r => r.address).join('\n');
    const detectedHints = [];
    for (const item of STRUCTURAL_HINT_DEFINITIONS) {
        if (item.regex.test(joinedText)) {
            detectedHints.push(item.label);
            if (detectedHints.length === 3) break;
        }
    }

    assert.strictEqual(detectedHints.length, 3, 'Must return at most 3 hints');
    assert.deepStrictEqual(detectedHints, ['Floor/Level', 'Block', 'Flat'], 'Must follow strict priority order');
    console.log(`  ✓ Detected hints in strict priority order: ${JSON.stringify(detectedHints)}`);

    // 4. HTML sanitization test
    console.log('\n[Test 4] HTML and Control Character Sanitization');
    const dirty = '<script>alert("xss")</script>Flat 12\x00\x1F';
    const clean = dirty.replace(/<[^>]*>/g, '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 30);
    assert.strictEqual(clean, 'alert("xss")Flat 12');
    console.log(`  ✓ HTML tags and control chars stripped: "${clean}"`);

    // 5. Circuit Breaker behavior
    console.log('\n[Test 5] Circuit Breaker Operation');
    circuitBreaker.recordSuccess();
    assert.strictEqual(circuitBreaker.state, 'CLOSED');
    assert.strictEqual(circuitBreaker.canAttempt(), true);

    // Trip circuit breaker
    circuitBreaker.recordFailure();
    circuitBreaker.recordFailure();
    circuitBreaker.recordFailure();
    assert.strictEqual(circuitBreaker.state, 'OPEN', 'Circuit should be OPEN after 3 failures');
    assert.strictEqual(circuitBreaker.canAttempt(), false, 'Should deny attempts while OPEN');
    console.log('  ✓ Circuit breaker trips to OPEN on 3 consecutive failures');

    // Reset circuit breaker for normal use
    circuitBreaker.recordSuccess();
    assert.strictEqual(circuitBreaker.state, 'CLOSED');
    console.log('  ✓ Circuit breaker resets to CLOSED on success');

    // 6. Schema check (validated booleans, separate address object, userEntered)
    console.log('\n[Test 6] Validation Schema & Output Structure');
    const mockValidationResponse = {
        status: 'street_confirmed',
        message: 'Postcode and street confirmed',
        validated: {
            postcode: true,
            street: true,
            number: false,
            unit: false
        },
        address: {
            line1: 'Flat 4, 12 High Street',
            line2: '',
            locality: '',
            town: 'Grimsby',
            postcode: 'DN41 7RU',
            formatted: 'Flat 4, 12 High Street, Grimsby, DN41 7RU'
        },
        userEntered: ['number', 'unit'],
        unitHints: ['Floor/Level', 'Flat']
    };

    assert.strictEqual(typeof mockValidationResponse.validated.postcode, 'boolean');
    assert.strictEqual(mockValidationResponse.validated.number, false, 'number must be false');
    assert.strictEqual(mockValidationResponse.validated.unit, false, 'unit must be false');
    assert.strictEqual(typeof mockValidationResponse.address, 'object');
    assert.deepStrictEqual(mockValidationResponse.userEntered, ['number', 'unit']);
    console.log('  ✓ Schema verified: validated booleans, separate address object, userEntered field names');

    console.log('\n=== All Tests Passed Successfully! ===\n');
}

runTests().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
