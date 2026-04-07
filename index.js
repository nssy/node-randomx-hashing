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
        ...options,
        enableJit: options.enableJit !== false,
        enableAes: options.enableAes !== false,
        enableHugePages: options.enableHugePages === true,
        threads: options.threads || 1,
        mode: options.mode || 'light'
    };

    if (typeof config.mode !== 'string' || !['light', 'fast'].includes(config.mode)) {
        throw new Error('Mode must be "light" or "fast"');
    }

    return config;
}

/**
 * Initialize RandomX context with optimal settings
 * @param {Buffer} seed - RandomX seed (32 bytes)
 * @param {Object} options - Configuration options
 * @param {string} options.mode - RandomX mode: 'light' (~256MB) or 'fast' (~2GB)
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

function initContextAsync(seed, options = {}) {
    if (!Buffer.isBuffer(seed) || seed.length !== 32) {
        throw new Error('Seed must be a 32-byte Buffer');
    }

    return randomx.initContextAsync(seed, normalizeInitOptions(options));
}

/**
 * LRU seed pool keyed by 32-byte seed. Each seed entry owns one shared cache/dataset
 * plus a small VM pool.
 */
class SeedPool {
    /**
     * @param {number} maxSeeds
     * @param {Object} initOptions options passed to initContext for every new context
     * @param {number|null} [idleEvictMs] if set, drop contexts not accessed for this many ms (frees RAM)
     */
    constructor(maxSeeds, initOptions, idleEvictMs = null, vmPoolSize = 1) {
        if (!Number.isFinite(maxSeeds) || maxSeeds < 1) {
            throw new Error('maxSeeds must be a positive number');
        }
        this.maxSeeds = maxSeeds;
        this._initOptions = initOptions;
        this._vmPoolSize = Math.max(1, Number(vmPoolSize) || 1);
        /** @type {Map<string, { contextIds: number[], lastUsed: number, nextIndex: number }>} */
        this._lru = new Map();
        this._pendingWarmups = new Map();
        this._destroyed = false;
        this._idleEvictMs =
            idleEvictMs != null && Number(idleEvictMs) > 0 ? Number(idleEvictMs) : null;
    }

    _cancelPendingWarmup(key) {
        const pending = this._pendingWarmups.get(key);
        if (pending) {
            pending.cancelled = true;
            this._pendingWarmups.delete(key);
        }
    }

    _expireIdleContexts() {
        if (this._idleEvictMs == null) {
            return;
        }
        const cutoff = Date.now() - this._idleEvictMs;
        const toRemove = [];
        for (const [key, entry] of this._lru) {
            if (entry.lastUsed < cutoff) {
                toRemove.push([key, entry.contextIds]);
            }
        }
        for (const [key, contextIds] of toRemove) {
            this._lru.delete(key);
            for (const contextId of contextIds) {
                randomx.releaseContext(contextId);
            }
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
        if (this._destroyed) {
            throw new Error('SeedPool has been released');
        }
        const key = seed.toString('hex');

        this._expireIdleContexts();

        if (this._lru.has(key)) {
            const entry = this._lru.get(key);
            entry.lastUsed = Date.now();
            this._lru.delete(key);
            this._lru.set(key, entry);
            const index = entry.nextIndex % entry.contextIds.length;
            const contextId = entry.contextIds[index];
            entry.nextIndex = (index + 1) % entry.contextIds.length;
            return contextId;
        }

        if (this._lru.size >= this.maxSeeds) {
            const evictKey = this._lru.keys().next().value;
            const evictEntry = this._lru.get(evictKey);
            this._lru.delete(evictKey);
            for (const contextId of evictEntry.contextIds) {
                randomx.releaseContext(contextId);
            }
        }

        const contextIds = [];
        try {
            for (let i = 0; i < this._vmPoolSize; i++) {
                contextIds.push(randomx.initContext(seed, normalizeInitOptions(this._initOptions)));
            }
        } catch (error) {
            for (const contextId of contextIds) {
                randomx.releaseContext(contextId);
            }
            throw error;
        }
        // lastUsed after init: init can take >> idleEvictMs; pre-init timestamps wrongly evict "stale" entries
        this._lru.set(key, { contextIds, lastUsed: Date.now(), nextIndex: 1 % contextIds.length });
        return contextIds[0];
    }

    _getContextForSeed(seed) {
        return this.getContext(seed);
    }

    async _getContextForSeedAsync(seed) {
        this._assertSeed(seed);
        const key = seed.toString('hex');
        const pending = this._pendingWarmups.get(key);
        if (pending) {
            await pending.promise;
        }
        if (this._destroyed) {
            throw new Error('SeedPool has been released');
        }
        return this.getContext(seed);
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

    hash(seed, input) {
        this._assertSeed(seed);
        if (!Buffer.isBuffer(input)) {
            throw new Error('Input must be a Buffer');
        }

        // Sync hashing does not wait for pending async warmups and may initialize synchronously.
        return randomx.hash(this._getContextForSeed(seed), input);
    }

    hashFromHex(seedHex, input) {
        return randomx.hash(this.getContextFromHex(seedHex), input);
    }

    hashAsync(seed, input) {
        this._assertSeed(seed);
        if (!Buffer.isBuffer(input)) {
            throw new Error('Input must be a Buffer');
        }

        return this._getContextForSeedAsync(seed).then((contextId) => randomx.hashAsync(contextId, input));
    }

    hashAsyncFromHex(seedHex, input) {
        if (typeof seedHex !== 'string' || seedHex.length !== 64) {
            throw new Error('seedHex must be a 64-character hex string (32 bytes)');
        }
        if (!/^[0-9a-fA-F]+$/.test(seedHex)) {
            throw new Error('seedHex must be hexadecimal');
        }
        if (!Buffer.isBuffer(input)) {
            throw new Error('Input must be a Buffer');
        }

        return this._getContextForSeedAsync(Buffer.from(seedHex, 'hex'))
            .then((contextId) => randomx.hashAsync(contextId, input));
    }

    warmSeed(seed) {
        this._assertSeed(seed);
        this.getContext(seed);
    }

    warmSeedFromHex(seedHex) {
        this.getContextFromHex(seedHex);
    }

    async warmSeedAsync(seed) {
        this._assertSeed(seed);
        const seedCopy = Buffer.from(seed);
        const key = seedCopy.toString('hex');

        this._expireIdleContexts();

        if (this._lru.has(key)) {
            const entry = this._lru.get(key);
            entry.lastUsed = Date.now();
            return;
        }

        if (this._pendingWarmups.has(key)) {
            return this._pendingWarmups.get(key).promise;
        }

        const pending = {
            cancelled: false,
            promise: null
        };

        const warmup = (async () => {
            const contextIds = [];
            try {
                for (let i = 0; i < this._vmPoolSize; i++) {
                    contextIds.push(await initContextAsync(seedCopy, this._initOptions));
                    if (pending.cancelled) {
                        for (const contextId of contextIds) {
                            randomx.releaseContext(contextId);
                        }
                        return;
                    }
                }

                if (this._lru.has(key)) {
                    for (const contextId of contextIds) {
                        randomx.releaseContext(contextId);
                    }
                    const entry = this._lru.get(key);
                    entry.lastUsed = Date.now();
                    return;
                }

                if (this._lru.size >= this.maxSeeds) {
                    const evictKey = this._lru.keys().next().value;
                    const evictEntry = this._lru.get(evictKey);
                    this._lru.delete(evictKey);
                    for (const contextId of evictEntry.contextIds) {
                        randomx.releaseContext(contextId);
                    }
                }

                this._lru.set(key, { contextIds, lastUsed: Date.now(), nextIndex: 1 % contextIds.length });
            } catch (error) {
                for (const contextId of contextIds) {
                    randomx.releaseContext(contextId);
                }
                throw error;
            } finally {
                const current = this._pendingWarmups.get(key);
                if (current === pending) {
                    this._pendingWarmups.delete(key);
                }
            }
        })();

        pending.promise = warmup;
        this._pendingWarmups.set(key, pending);
        return warmup;
    }

    async warmSeedAsyncFromHex(seedHex) {
        if (typeof seedHex !== 'string' || seedHex.length !== 64) {
            throw new Error('seedHex must be a 64-character hex string (32 bytes)');
        }
        if (!/^[0-9a-fA-F]+$/.test(seedHex)) {
            throw new Error('seedHex must be hexadecimal');
        }
        return this.warmSeedAsync(Buffer.from(seedHex, 'hex'));
    }

    verifyShare(seed, input, target, expectedHash = null) {
        this._assertSeed(seed);
        if (!Buffer.isBuffer(input)) {
            throw new Error('Input must be a Buffer');
        }
        // Sync verification does not wait for pending async warmups and may initialize synchronously.
        return randomx.verifyShare(this._getContextForSeed(seed), input, target, expectedHash);
    }

    verifyShareFromHex(seedHex, input, target, expectedHash = null) {
        if (!Buffer.isBuffer(input)) {
            throw new Error('Input must be a Buffer');
        }

        return randomx.verifyShare(this.getContextFromHex(seedHex), input, target, expectedHash);
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
        this._cancelPendingWarmup(key);
        if (!this._lru.has(key)) {
            return false;
        }
        const entry = this._lru.get(key);
        this._lru.delete(key);
        for (const contextId of entry.contextIds) {
            randomx.releaseContext(contextId);
        }
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
        this._destroyed = true;
        for (const key of this._pendingWarmups.keys()) {
            this._cancelPendingWarmup(key);
        }
        for (const entry of this._lru.values()) {
            for (const contextId of entry.contextIds) {
                randomx.releaseContext(contextId);
            }
        }
        this._lru.clear();
    }

    get size() {
        return this._lru.size;
    }

    /**
     * Lightweight introspection for logging (truncated keys).
     * @returns {{ size: number, maxSeeds: number, seedPrefixes: string[] }}
     */
    getSnapshot() {
        return {
            size: this._lru.size,
            maxSeeds: this.maxSeeds,
            vmPoolSize: this._vmPoolSize,
            idleEvictMs: this._idleEvictMs,
            seedPrefixes: [...this._lru.keys()].map((k) => `${k.slice(0, 16)}…`)
        };
    }
}

/**
 * Create a seed-keyed LRU pool suitable for pool share verification.
 * Defaults favor safety: mode `light`, threads = CPU count (override with options).
 *
 * @param {Object} [options]
 * @param {number} [options.maxSeeds=2] Max simultaneous seeds to retain.
 * @param {string} [options.mode='light'] RandomX mode when not overridden.
 * @param {number} [options.threads] Defaults to os.cpus().length (minimum 1).
 * @param {boolean} [options.enableJit]
 * @param {boolean} [options.enableAes]
 * @param {boolean} [options.enableHugePages]
 * @param {number} [options.idleEvictMs] release contexts unused for this long (ms) to reclaim RAM (e.g. after seed changes)
 * @returns {SeedPool}
 */
function createSeedPool(options = {}) {
    const maxSeeds = options.maxSeeds != null ? Number(options.maxSeeds) : 2;
    if (!Number.isFinite(maxSeeds) || maxSeeds < 1) {
        throw new Error('maxSeeds must be a positive number');
    }
    const vmPoolSize =
        options.vmPoolSize != null ? Number(options.vmPoolSize) : 1;
    if (!Number.isFinite(vmPoolSize) || vmPoolSize < 1) {
        throw new Error('vmPoolSize must be a positive number');
    }

    const { maxSeeds: _ms, idleEvictMs, vmPoolSize: _vp, ...rest } = options;
    const initOptions = {
        mode: 'light',
        threads: Math.max(1, os.cpus().length),
        enableJit: true,
        enableAes: true,
        enableHugePages: false,
        ...rest
    };

    return new SeedPool(maxSeeds, initOptions, idleEvictMs, vmPoolSize);
}

/**
 * LRU cache sized for Monero-style RandomX epochs: at most two `seed_hash`
 * values are needed (current + previous block template) during a fork/transition.
 * Same as {@link createSeedPool} with `maxSeeds: 2` by default.
 *
 * @param {Object} [options] forwarded to {@link createSeedPool}; `maxSeeds` defaults to 2
 * @param {number} [options.idleEvictMs] optional: drop contexts unused this long (ms) to reclaim RAM when the pool no longer sends old seeds
 * @returns {SeedPool}
 */
function createPoolSeedPool(options = {}) {
    const max = options.maxSeeds != null ? options.maxSeeds : 2;
    return createSeedPool({ ...options, maxSeeds: max });
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
 * Calculate RandomX hash asynchronously.
 * @param {number} contextId - Context ID from initContext
 * @param {Buffer} input - Input data to hash
 * @returns {Promise<Buffer>} 32-byte hash result
 */
function hashAsync(contextId, input) {
    if (!Buffer.isBuffer(input)) {
        throw new Error('Input must be a Buffer');
    }

    return randomx.hashAsync(contextId, input);
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
 * `usedLargePages` is conservative; it is false unless the addon can prove large-page backing.
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
    initContextAsync,
    normalizeInitOptions,
    createSeedPool,
    createPoolSeedPool,
    createContextCache: createSeedPool,
    createPoolEpochCache: createPoolSeedPool,
    SeedPool,
    RandomXContextCache: SeedPool,
    verifyShare,
    hash,
    hashAsync,
    releaseContext,
    getContextInfo,
    getStats,
    getHardwareInfo
};
