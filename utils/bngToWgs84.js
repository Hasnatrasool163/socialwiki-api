/**
 * bngToWgs84.js
 *
 * Converts British National Grid (OSGB36, EPSG:27700) Eastings and Northings
 * into WGS84 (EPSG:4326) Latitude and Longitude using the standard
 * Transverse Mercator projection reverse calculation and Helmert 7-parameter datum shift.
 *
 * Accuracy: Within 1-2 meters across Great Britain.
 * Note: Northern Ireland (BT) postcodes use Irish National Grid (EPSG:29903) or
 * Irish Transverse Mercator (EPSG:2157) and are handled separately.
 */

function bngToWgs84(E, N) {
    if (!E || !N || isNaN(E) || isNaN(N) || E <= 0 || N <= 0) {
        return null;
    }

    // Airy 1830 ellipsoid parameters
    const a = 6377563.396;
    const b = 6356256.909;
    const F0 = 0.9996012717;
    const lat0 = 49 * Math.PI / 180;
    const lon0 = -2 * Math.PI / 180;
    const N0 = -100000;
    const E0 = 400000;
    const e2 = 1 - (b * b) / (a * a);
    const n = (a - b) / (a + b);
    const n2 = n * n;
    const n3 = n * n * n;

    let lat = lat0;
    let M = 0;
    do {
        lat = (N - N0 - M) / (a * F0) + lat;
        const Ma = (1 + n + (5 / 4) * n2 + (5 / 4) * n3) * (lat - lat0);
        const Mb = (3 * n + 3 * n2 + (21 / 8) * n3) * Math.sin(lat - lat0) * Math.cos(lat + lat0);
        const Mc = ((15 / 8) * n2 + (15 / 8) * n3) * Math.sin(2 * (lat - lat0)) * Math.cos(2 * (lat + lat0));
        const Md = (35 / 24) * n3 * Math.sin(3 * (lat - lat0)) * Math.cos(3 * (lat + lat0));
        M = b * F0 * (Ma - Mb + Mc - Md);
    } while (N - N0 - M >= 0.00001);

    const cosLat = Math.cos(lat);
    const sinLat = Math.sin(lat);
    const nu = a * F0 / Math.sqrt(1 - e2 * sinLat * sinLat);
    const rho = a * F0 * (1 - e2) / Math.pow(1 - e2 * sinLat * sinLat, 1.5);
    const eta2 = nu / rho - 1;

    const tanLat = Math.tan(lat);
    const tan2Lat = tanLat * tanLat;
    const tan4Lat = tan2Lat * tan2Lat;
    const tan6Lat = tan4Lat * tan2Lat;
    const secLat = 1 / cosLat;
    const nu3 = nu * nu * nu;
    const nu5 = nu3 * nu * nu;
    const nu7 = nu5 * nu * nu;

    const VII = tanLat / (2 * rho * nu);
    const VIII = tanLat / (24 * rho * nu3) * (5 + 3 * tan2Lat + eta2 - 9 * tan2Lat * eta2);
    const IX = tanLat / (720 * rho * nu5) * (61 + 90 * tan2Lat + 45 * tan4Lat);
    const X = secLat / nu;
    const XI = secLat / (6 * nu3) * (nu / rho + 2 * tan2Lat);
    const XII = secLat / (120 * nu5) * (5 + 28 * tan2Lat + 24 * tan4Lat);
    const XIIA = secLat / (5040 * nu7) * (61 + 662 * tan2Lat + 1320 * tan4Lat + 720 * tan6Lat);

    const dE = (E - E0);
    const dE2 = dE * dE;
    const dE3 = dE2 * dE;
    const dE4 = dE2 * dE2;
    const dE5 = dE3 * dE2;
    const dE6 = dE4 * dE2;
    const dE7 = dE5 * dE2;

    lat = lat - VII * dE2 + VIII * dE4 - IX * dE6;
    const lon = lon0 + X * dE - XI * dE3 + XII * dE5 - XIIA * dE7;

    // Helmert 7-parameter transformation from OSGB36 to WGS84
    const H = 0;
    const sinPhi = Math.sin(lat);
    const cosPhi = Math.cos(lat);
    const sinLambda = Math.sin(lon);
    const cosLambda = Math.cos(lon);
    const v = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);

    const x1 = (v + H) * cosPhi * cosLambda;
    const y1 = (v + H) * cosPhi * sinLambda;
    const z1 = ((1 - e2) * v + H) * sinPhi;

    const s = -20.4894e-6;
    const rx = (0.1502 / 3600) * Math.PI / 180;
    const ry = (0.2470 / 3600) * Math.PI / 180;
    const rz = (0.8421 / 3600) * Math.PI / 180;
    const tx = 446.448;
    const ty = -125.157;
    const tz = 542.060;

    const x2 = tx + (1 + s) * x1 - rz * y1 + ry * z1;
    const y2 = ty + rz * x1 + (1 + s) * y1 - rx * z1;
    const z2 = tz - ry * x1 + rx * y1 + (1 + s) * z1;

    // Convert back from Cartesian to geodetic on WGS84 ellipsoid
    const a2 = 6378137.0;
    const b2 = 6356752.31425;
    const e2_2 = 1 - (b2 * b2) / (a2 * a2);
    const p = Math.sqrt(x2 * x2 + y2 * y2);
    let phi2 = Math.atan2(z2, p * (1 - e2_2));
    let phi2Old = 0;

    do {
        phi2Old = phi2;
        const v2 = a2 / Math.sqrt(1 - e2_2 * Math.sin(phi2) * Math.sin(phi2));
        phi2 = Math.atan2(z2 + e2_2 * v2 * Math.sin(phi2), p);
    } while (Math.abs(phi2 - phi2Old) > 1e-10);

    const lambda2 = Math.atan2(y2, x2);

    return {
        lat: Number((phi2 * 180 / Math.PI).toFixed(6)),
        lon: Number((lambda2 * 180 / Math.PI).toFixed(6))
    };
}

/**
 * Calculates Haversine distance in meters between two lat/lon pairs
 */
function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth radius in meters
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const dPhi = (lat2 - lat1) * Math.PI / 180;
    const dLambda = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
              Math.cos(phi1) * Math.cos(phi2) *
              Math.sin(dLambda / 2) * Math.sin(dLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

module.exports = {
    bngToWgs84,
    haversineDistanceMeters
};
