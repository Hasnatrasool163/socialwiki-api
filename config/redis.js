const Redis = require('ioredis');
const logger = require('./logger');

const redisHost = process.env.REDIS_HOST || '127.0.0.1';
const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);
const redisPassword = process.env.REDIS_PASSWORD || undefined;
const redisUrl = process.env.REDIS_URL;

let redisClient = null;
let isRedisAvailable = false;

try {
    const redisOptions = {
        host: redisHost,
        port: redisPort,
        password: redisPassword,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        retryStrategy(times) {
            if (times > 5) {
                // Stop retrying every few ms if Redis is completely down
                return Math.min(times * 1000, 30000);
            }
            return 2000;
        }
    };

    redisClient = redisUrl ? new Redis(redisUrl, redisOptions) : new Redis(redisOptions);

    redisClient.on('connect', () => {
        isRedisAvailable = true;
        logger.info(`[Redis] Connected to Redis at ${redisHost}:${redisPort}`);
    });

    redisClient.on('ready', () => {
        isRedisAvailable = true;
        logger.info('[Redis] Redis client is ready');
    });

    redisClient.on('error', (err) => {
        isRedisAvailable = false;
        logger.warn(`[Redis] Connection warning: ${err.message}. Falling back to memory insurance limiter.`);
    });

    redisClient.on('close', () => {
        isRedisAvailable = false;
        logger.warn('[Redis] Connection closed');
    });

    // Attempt non-blocking connection
    redisClient.connect().catch((err) => {
        isRedisAvailable = false;
        logger.warn(`[Redis] Initial connection failed (${err.message}). Rate limiter will operate with memory insurance.`);
    });
} catch (err) {
    isRedisAvailable = false;
    logger.warn(`[Redis] Initialization error: ${err.message}`);
}

module.exports = {
    getRedisClient: () => redisClient,
    isRedisReady: () => isRedisAvailable && redisClient?.status === 'ready'
};
