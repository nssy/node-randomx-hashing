/**
 * Node.js RandomX Share Verifier
 * High-performance N-API addon for mining pool share verification
 */

const randomx = require('./build/Release/randomx');

/**
 * Initialize RandomX context with optimal settings
 * @param {Buffer} seed - RandomX seed (32 bytes)
 * @param {Object} options - Configuration options
 * @param {string} options.mode - RandomX mode: 'light' (~256MB), 'fast' (~2GB), 'auto'
 * @param {boolean} options.enableJit - Enable JIT compilation (default: true)
 * @param {boolean} options.enableAes - Enable AES acceleration (default: true)
 * @param {boolean} options.enableHugePages - Enable huge pages (default: false for light, true for fast)
 * @param {number} options.threads - Number of threads for initialization (default: 1)
 * @returns {number} Context ID for reuse
 */
function initContext(seed, options = {}) {
    if (!Buffer.isBuffer(seed) || seed.length !== 32) {
        throw new Error('Seed must be a 32-byte Buffer');
    }

    // Default configuration optimized for verification
    const config = {
        enableJit: options.enableJit !== false,
        enableAes: options.enableAes !== false,
        enableHugePages: options.enableHugePages === true,  // Default false for memory efficiency
        threads: options.threads || 1,
        mode: options.mode || 'light',  // Default to light mode for verification
        ...options
    };

    // Validate mode parameter
    if (!['light', 'fast', 'auto'].includes(config.mode)) {
        throw new Error('Mode must be "light", "fast", or "auto"');
    }

    return randomx.initContext(seed, config);
}

/**
 * Verify a mining share
 * @param {number} contextId - Context ID from initContext
 * @param {Buffer} input - Input data to hash
 * @param {Buffer} target - Target difficulty
 * @param {Buffer} expectedHash - Expected hash result (optional)
 * @returns {Object} Verification result
 */
function verifyShare(contextId, input, target, expectedHash = null) {
    if (!Buffer.isBuffer(input)) {
        throw new Error('Input must be a Buffer');
    }
    if (!Buffer.isBuffer(target) || target.length !== 32) {
        throw new Error('Target must be a 32-byte Buffer');
    }
    if (expectedHash && (!Buffer.isBuffer(expectedHash) || expectedHash.length !== 32)) {
        throw new Error('Expected hash must be a 32-byte Buffer');
    }

    return randomx.verifyShare(contextId, input, target, expectedHash);
}

/**
 * Calculate RandomX hash
 * @param {number} contextId - Context ID from initContext
 * @param {Buffer} input - Input data to hash
 * @returns {Buffer} 32-byte hash result
 */
function hash(contextId, input) {
    if (!Buffer.isBuffer(input)) {
        throw new Error('Input must be a Buffer');
    }

    return randomx.hash(contextId, input);
}

/**
 * Release a context and free associated memory
 * @param {number} contextId - Context ID to release
 */
function releaseContext(contextId) {
    return randomx.releaseContext(contextId);
}

/**
 * Get performance statistics
 * @returns {Object} Performance metrics
 */
function getStats() {
    return randomx.getStats();
}

/**
 * Check if hardware features are available
 * @returns {Object} Available hardware features
 */
function getHardwareInfo() {
    return randomx.getHardwareInfo();
}

module.exports = {
    initContext,
    verifyShare,
    hash,
    releaseContext,
    getStats,
    getHardwareInfo
};
