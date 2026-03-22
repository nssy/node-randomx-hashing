/**
 * Node.js RandomX Share Verifier
 * High-performance N-API addon for RandomX share verification in Node.js mining pools
 */

const os = require('os');
const randomx = require('./build/Release/randomx');

/**
 * Normalize options for native initContext (shared by initContext and context cache).
 * @param {Object} options
 * @returns {Object}
 */
function normalizeInitOptions(options = {}) {
    const config = {
        enableJit: options.enableJit !== false,
        enableAes: options.enableAes !== false,
        enableHugePages: options.enableHugePages === true,
        threads: options.threads || 1,
        mode: options.mode || 'light',
        ...options
    };

    if (typeof config.mode !== 'string' || !['light', 'fast', 'auto'].includes(config.mode)) {
        throw new Error('Mode must be "light", "fast", or "auto"');
    }

    return config;
}

/**
 * Initialize RandomX context with optimal settings
 * @param {Buffer} seed - RandomX seed (32 bytes)
 * @param {Object} options - Configuration options
 * @param {string} options.mode - RandomX mode: 'light' (~256MB), 'fast' (~2GB), 'auto'
 * @param {boolean} options.enableJit - Enable JIT compilation (default: true)
 * @param {boolean} options.enableAes - Enable AES acceleration (default: true)
 * @param {boolean} options.enableHugePages - Enable huge pages (default: false unless set true)
 * @param {number} options.threads - Number of threads for dataset init (default: 1)
 * @returns {number} Context ID for reuse
 */
function initContext(seed, options = {}) {
    if (!Buffer.isBuffer(seed) || seed.length !== 32) {
        throw new Error('Seed must be a 32-byte Buffer');
    }

    return randomx.initContext(seed, normalizeInitOptions(options));
}

/**
 * LRU cache of RandomX contexts keyed by 32-byte seed. Evicts least-recently-used
 * contexts when the cap is reached (~2GB RAM per fast-mode context — size accordingly).
 */
class RandomXContextCache {
    /**
     * @param {number} maxContexts
     * @param {Object} initOptions options passed to initContext for every new context
     * @param {number|null} [idleEvictMs] if set, drop contexts not accessed for this many ms (frees RAM)
     */
    constructor(maxContexts, initOptions, idleEvictMs = null) {
        if (!Number.isFinite(maxContexts) || maxContexts < 1) {
            throw new Error('maxContexts must be a positive number');
        }
        this.maxContexts = maxContexts;
        this._initOptions = initOptions;
        /** @type {Map<string, { contextId: number, lastUsed: number }>} */
        this._lru = new Map();
        this._idleEvictMs =
            idleEvictMs != null && Number(idleEvictMs) > 0 ? Number(idleEvictMs) : null;
    }

    _expireIdleContexts() {
        if (this._idleEvictMs == null) {
            return;
        }
        const cutoff = Date.now() - this._idleEvictMs;
        const toRemove = [];
        for (const [key, entry] of this._lru) {
            if (entry.lastUsed < cutoff) {
                toRemove.push([key, entry.contextId]);
            }
        }
        for (const [key, contextId] of toRemove) {
            this._lru.delete(key);
            randomx.releaseContext(contextId);
        }
    }

    _assertSeed(seed) {
        if (!Buffer.isBuffer(seed) || seed.length !== 32) {
            throw new Error('Seed must be a 32-byte Buffer');
        }
    }

    /**
     * @param {Buffer} seed
     * @returns {number} contextId
     */
    getContext(seed) {
        this._assertSeed(seed);
        const key = seed.toString('hex');

        this._expireIdleContexts();

        if (this._lru.has(key)) {
            const entry = this._lru.get(key);
            entry.lastUsed = Date.now();
            this._lru.delete(key);
            this._lru.set(key, entry);
            return entry.contextId;
        }

        if (this._lru.size >= this.maxContexts) {
            const evictKey = this._lru.keys().next().value;
            const evictEntry = this._lru.get(evictKey);
            this._lru.delete(evictKey);
            randomx.releaseContext(evictEntry.contextId);
        }

        const contextId = randomx.initContext(seed, normalizeInitOptions(this._initOptions));
        // lastUsed after init: init can take >> idleEvictMs; pre-init timestamps wrongly evict "stale" entries
        this._lru.set(key, { contextId, lastUsed: Date.now() });
        return contextId;
    }

    /**
     * @param {string} seedHex 64 hex chars (32 bytes)
     * @returns {number} contextId
     */
    getContextFromHex(seedHex) {
        if (typeof seedHex !== 'string' || seedHex.length !== 64) {
            throw new Error('seedHex must be a 64-character hex string (32 bytes)');
        }
        if (!/^[0-9a-fA-F]+$/.test(seedHex)) {
            throw new Error('seedHex must be hexadecimal');
        }
        return this.getContext(Buffer.from(seedHex, 'hex'));
    }

    /**
     * @param {Buffer} seed
     * @returns {boolean}
     */
    has(seed) {
        this._assertSeed(seed);
        return this._lru.has(seed.toString('hex'));
    }

    /**
     * @param {Buffer} seed
     * @returns {boolean} whether a context was released
     */
    release(seed) {
        this._assertSeed(seed);
        const key = seed.toString('hex');
        if (!this._lru.has(key)) {
            return false;
        }
        const entry = this._lru.get(key);
        this._lru.delete(key);
        randomx.releaseContext(entry.contextId);
        return true;
    }

    /**
     * @param {string} seedHex
     * @returns {boolean}
     */
    releaseFromHex(seedHex) {
        if (typeof seedHex !== 'string' || seedHex.length !== 64) {
            throw new Error('seedHex must be a 64-character hex string (32 bytes)');
        }
        return this.release(Buffer.from(seedHex, 'hex'));
    }

    releaseAll() {
        for (const entry of this._lru.values()) {
            randomx.releaseContext(entry.contextId);
        }
        this._lru.clear();
    }

    get size() {
        return this._lru.size;
    }

    /**
     * Lightweight introspection for logging (truncated keys).
     * @returns {{ size: number, maxContexts: number, seedPrefixes: string[] }}
     */
    getSnapshot() {
        return {
            size: this._lru.size,
            maxContexts: this.maxContexts,
            idleEvictMs: this._idleEvictMs,
            seedPrefixes: [...this._lru.keys()].map((k) => `${k.slice(0, 16)}…`)
        };
    }
}

/**
 * Create a seed-keyed LRU cache suitable for pool share verification.
 * Defaults favor throughput: mode `fast`, threads = CPU count (override with options).
 *
 * @param {Object} [options]
 * @param {number} [options.maxContexts=2] Max simultaneous contexts (each fast context ~2GB).
 * @param {string} [options.mode='fast'] RandomX mode when not overridden.
 * @param {number} [options.threads] Defaults to os.cpus().length (minimum 1).
 * @param {boolean} [options.enableJit]
 * @param {boolean} [options.enableAes]
 * @param {boolean} [options.enableHugePages]
 * @param {number} [options.idleEvictMs] release contexts unused for this long (ms) to reclaim RAM (e.g. after seed changes)
 * @returns {RandomXContextCache}
 */
function createContextCache(options = {}) {
    const maxContexts =
        options.maxContexts != null ? Number(options.maxContexts) : 2;
    if (!Number.isFinite(maxContexts) || maxContexts < 1) {
        throw new Error('maxContexts must be a positive number');
    }

    const { maxContexts: _mc, idleEvictMs, ...rest } = options;
    const initOptions = {
        mode: 'fast',
        threads: Math.max(1, os.cpus().length),
        enableJit: true,
        enableAes: true,
        enableHugePages: false,
        ...rest
    };

    return new RandomXContextCache(maxContexts, initOptions, idleEvictMs);
}

/**
 * LRU cache sized for Monero-style RandomX epochs: at most two `seed_hash`
 * values are needed (current + previous block template) during a fork/transition.
 * Same as {@link createContextCache} with `maxContexts: 2` by default.
 *
 * @param {Object} [options] forwarded to {@link createContextCache}; `maxContexts` defaults to 2
 * @param {number} [options.idleEvictMs] optional: drop contexts unused this long (ms) to reclaim RAM when the pool no longer sends old seeds
 * @returns {RandomXContextCache}
 */
function createPoolEpochCache(options = {}) {
    const max = options.maxContexts != null ? options.maxContexts : 2;
    return createContextCache({ ...options, maxContexts: max });
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
 * Snapshot of how this context was built (for logging / tests).
 * @param {number} contextId
 * @returns {{ mode: string, enableHugePages: boolean, usedLargePages: boolean } | null} null if invalid id
 */
function getContextInfo(contextId) {
    if (typeof contextId !== 'number') {
        throw new Error('contextId must be a number');
    }
    return randomx.getContextInfo(contextId);
}

/**
 * Get performance statistics. `averageHashTime` is the mean RandomX hash duration in milliseconds
 * (excluding queue/wait if workers contend on the same context).
 * @returns {Object} Performance metrics
 */
function getStats() {
    return randomx.getStats();
}

/**
 * Host / capability snapshot. `hasHugePages` means this OS has RandomX’s large-page allocator
 * (e.g. Linux MAP_HUGETLB path), not `randomx_get_flags() & LARGE_PAGES` (RandomX never sets that bit).
 * `hugePagesAvailable` is HugePages_Free from /proc/meminfo (kernel hugetlb pool), a separate knob.
 * @returns {Object} Available hardware features
 */
function getHardwareInfo() {
    return randomx.getHardwareInfo();
}

module.exports = {
    initContext,
    normalizeInitOptions,
    createContextCache,
    createPoolEpochCache,
    RandomXContextCache,
    verifyShare,
    hash,
    releaseContext,
    getContextInfo,
    getStats,
    getHardwareInfo
};
