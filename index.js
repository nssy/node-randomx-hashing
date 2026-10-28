/**
 * Node.js RandomX Share Verifier
 * High-performance N-API addon for RandomX share verification in Node.js mining pools
 */

const os = require('os');
const randomx = require('./build/Release/randomx');

const NATIVE_ABI = 2;
if (typeof randomx.capabilities !== 'function' || randomx.capabilities().abi !== NATIVE_ABI) {
    throw new Error('randomx-hashing: native addon is out of date; rebuild it with `npm run build`');
}

/** RandomX variants, named like the stratum `algo` strings. */
const VARIANTS = Object.freeze(['rx/0', 'rx/2']);

/** First Monero block major version hashed with RandomX v2 (hard fork 17). */
const MONERO_RX2_MAJOR_VERSION = 17;

const CPU_COUNT = Math.max(1, typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length);

/**
 * Upper bounds for count options. Larger values are capped (with a one-time warning), not
 * rejected: beyond these a setting only costs memory or threads. More dataset-init threads or VMs
 * than CPUs can't run at once, and Monero never needs more than three seeds (previous, current,
 * next); each fast-mode seed holds a ~2 GiB dataset.
 */
const LIMITS = Object.freeze({
    threads: Math.min(256, CPU_COUNT),
    vmPoolSize: Math.min(1024, CPU_COUNT),
    maxSeeds: 4
});

const cappedWarnings = new Set();

/**
 * Positive integer count option. Non-numbers, NaN, ±Infinity, fractions and values < 1 throw;
 * values above LIMITS[name] are capped.
 * @returns {number}
 */
function readCount(name, value, fallback) {
    if (value === undefined || value === null) {
        return fallback;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive integer (got ${String(value)})`);
    }
    const max = LIMITS[name];
    if (value > max) {
        if (!cappedWarnings.has(name)) {
            cappedWarnings.add(name);
            process.emitWarning(`randomx-hashing: ${name} ${value} capped at ${max}`, { code: 'RANDOMX_HASHING_CAPPED' });
        }
        return max;
    }
    return value;
}

/** Boolean option, default true. `0`, `null`, `"false"` etc. throw instead of meaning "on". */
function readBool(name, value) {
    if (value === undefined) {
        return true;
    }
    if (typeof value !== 'boolean') {
        throw new TypeError(`${name} must be a boolean (got ${String(value)})`);
    }
    return value;
}

/** idleEvictMs: unset or 0 disables idle eviction; otherwise a finite number of ms > 0. */
function readIdleEvictMs(value) {
    if (value === undefined || value === null || value === 0) {
        return null;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new RangeError(`idleEvictMs must be a non-negative finite number (got ${String(value)})`);
    }
    return value;
}

function assertSeed(seed) {
    if (!Buffer.isBuffer(seed) || seed.length !== 32) {
        throw new Error('Seed must be a 32-byte Buffer');
    }
}

function assertInput(input) {
    if (!Buffer.isBuffer(input)) {
        throw new Error('Input must be a Buffer');
    }
}

function seedFromHex(seedHex) {
    if (typeof seedHex !== 'string' || seedHex.length !== 64) {
        throw new Error('seedHex must be a 64-character hex string (32 bytes)');
    }
    if (!/^[0-9a-fA-F]+$/.test(seedHex)) {
        throw new Error('seedHex must be hexadecimal');
    }
    return Buffer.from(seedHex, 'hex');
}

/**
 * @param {{ variant?: string }} [options]
 * @returns {string} 'rx/0' (default) or 'rx/2'
 */
function normalizeVariant(options) {
    const variant = options && options.variant !== undefined ? options.variant : 'rx/0';
    if (!VARIANTS.includes(variant)) {
        throw new Error('Variant must be "rx/0" or "rx/2"');
    }
    return variant;
}

/**
 * Normalize options for native initContext.
 * @param {Object} options
 * @returns {Object}
 */
function normalizeInitOptions(options = {}) {
    const hugePages = options.enableHugePages === undefined ? true : options.enableHugePages;
    if (hugePages !== true && hugePages !== false && hugePages !== 'thp') {
        throw new Error('enableHugePages must be true, false or "thp"');
    }
    const config = {
        ...options,
        enableJit: readBool('enableJit', options.enableJit),
        enableAes: readBool('enableAes', options.enableAes),
        enableHugePages: hugePages,
        threads: readCount('threads', options.threads, 1),
        vmPoolSize: readCount('vmPoolSize', options.vmPoolSize, 1),
        mode: options.mode || 'light'
    };

    if (typeof config.mode !== 'string' || !['light', 'fast'].includes(config.mode)) {
        throw new Error('Mode must be "light" or "fast"');
    }

    return config;
}

/**
 * Monero's rule for which RandomX variant hashes a block: the hashing blob starts with the
 * block major version (a varint), and v17+ uses RandomX v2.
 * @param {Buffer} blob hashing blob (or block blob)
 * @returns {string} 'rx/0' or 'rx/2'
 */
function getVariant(blob) {
    if (!Buffer.isBuffer(blob) || blob.length < 1) {
        throw new Error('Blob must be a non-empty Buffer');
    }
    if (blob[0] & 0x80) {
        throw new Error('Unsupported multi-byte block major version');
    }
    return blob[0] >= MONERO_RX2_MAJOR_VERSION ? 'rx/2' : 'rx/0';
}

/**
 * Initialize a RandomX context: shared cache/dataset for the seed plus VM pools per variant.
 * @param {Buffer} seed - RandomX seed (32 bytes)
 * @param {Object} options - Configuration options
 * @param {string} options.mode - RandomX mode: 'light' (~256MB) or 'fast' (~2GB). Omitted or
 *   falsy values use 'light'; 'fast' must be explicit.
 * @param {boolean} options.enableJit - Enable JIT compilation (default: true)
 * @param {boolean} options.enableAes - Enable AES acceleration (default: true)
 * @param {boolean|string} options.enableHugePages - true (default): reserved hugetlb pages, then
 *   transparent huge pages, then normal pages; 'thp': transparent huge pages only (leaves the
 *   reserved pool to other processes); false: normal pages only
 * @param {number} options.threads - Number of threads for dataset init (default: 1)
 * @param {number} options.vmPoolSize - Max VMs per variant for concurrent hashing (default: 1)
 * @returns {number} Context ID for reuse
 */
function initContext(seed, options = {}) {
    assertSeed(seed);
    return randomx.initContext(seed, normalizeInitOptions(options));
}

function initContextAsync(seed, options = {}) {
    assertSeed(seed);
    return randomx.initContextAsync(seed, normalizeInitOptions(options));
}

/**
 * LRU seed pool keyed by 32-byte seed. Each seed owns one native context: one shared
 * cache/dataset plus VM pools per variant, created on first use.
 */
class SeedPool {
    /**
     * @param {number} maxSeeds
     * @param {Object} initOptions options passed to initContext for every new seed
     * @param {number|null} [idleEvictMs] if set, release seeds not hashed for this many ms (frees RAM);
     *   seeds that were only warmed are kept until first use or LRU displacement
     * @param {number} [vmPoolSize] max VMs per variant per seed
     */
    constructor(maxSeeds, initOptions, idleEvictMs = null, vmPoolSize = 1) {
        this.maxSeeds = readCount('maxSeeds', maxSeeds, 2);
        this._vmPoolSize = readCount('vmPoolSize', vmPoolSize, 1);
        this._initOptions = normalizeInitOptions({ ...initOptions, vmPoolSize: this._vmPoolSize });
        /** @type {Map<string, { contextId: number, lastUsed: number, used: boolean }>} */
        this._lru = new Map();
        /** @type {Map<string, { promise: Promise<void>, cancelled: boolean }>} */
        this._pendingWarmups = new Map();
        this._destroyed = false;
        this._idleEvictMs = readIdleEvictMs(idleEvictMs);
        this._sweepTimer = null;
    }

    _assertAlive() {
        if (this._destroyed) {
            throw new Error('SeedPool has been released');
        }
    }

    /**
     * Mark a seed as most recently used and return its entry. `use` is false for warmups, which
     * keep a seed that has never been hashed safe from idle eviction.
     */
    _touch(key, use = true) {
        const entry = this._lru.get(key);
        if (entry) {
            entry.lastUsed = Date.now();
            entry.used = entry.used || use;
            this._lru.delete(key);
            this._lru.set(key, entry);
        }
        return entry;
    }

    _insert(key, contextId, used) {
        while (this._lru.size >= this.maxSeeds) {
            this._releaseKey(this._lru.keys().next().value);
        }
        this._lru.set(key, { contextId, lastUsed: Date.now(), used });
        this._startSweep();
    }

    _releaseKey(key) {
        const entry = this._lru.get(key);
        if (!entry) {
            return false;
        }
        this._lru.delete(key);
        randomx.releaseContext(entry.contextId);
        return true;
    }

    _startSweep() {
        if (this._idleEvictMs == null || this._sweepTimer) {
            return;
        }
        const interval = Math.min(Math.max(this._idleEvictMs / 2, 10), 60000);
        this._sweepTimer = setInterval(() => this._expireIdle(), interval);
        this._sweepTimer.unref();
    }

    _stopSweep() {
        if (this._sweepTimer) {
            clearInterval(this._sweepTimer);
            this._sweepTimer = null;
        }
    }

    /**
     * Release seeds idle longer than idleEvictMs. Runs on a timer, so memory is freed without
     * traffic. A seed that was warmed but never hashed is kept (maxSeeds still bounds it): Monero
     * publishes next_seed_hash ~64 blocks (~2 h) before the switch, longer than a typical idle
     * window, and evicting the prewarmed dataset would make every epoch switch cold.
     */
    _expireIdle() {
        const cutoff = Date.now() - this._idleEvictMs;
        for (const [key, entry] of this._lru) {
            if (entry.used && entry.lastUsed < cutoff) {
                this._releaseKey(key);
            }
        }
        if (this._lru.size === 0) {
            this._stopSweep();
        }
    }

    _cancelPendingWarmup(key) {
        const pending = this._pendingWarmups.get(key);
        if (pending) {
            pending.cancelled = true;
            this._pendingWarmups.delete(key);
        }
    }

    /**
     * Context for a seed, initializing it synchronously when missing (blocks the event loop;
     * prefer the async methods).
     * @param {Buffer} seed
     * @returns {number} contextId
     */
    getContext(seed) {
        return this._getContextSync(seed, true);
    }

    _getContextSync(seed, use) {
        assertSeed(seed);
        this._assertAlive();
        const key = seed.toString('hex');
        const entry = this._touch(key, use);
        if (entry) {
            return entry.contextId;
        }
        // A pending async warmup of this seed will find the entry and drop its own context.
        const contextId = randomx.initContext(seed, this._initOptions);
        this._insert(key, contextId, use);
        return contextId;
    }

    /**
     * Run `fn(contextId)` for a seed, warming it on the worker pool when missing. Never blocks the
     * event loop. `fn` runs in the same tick as the lookup, so a release in between can't turn a
     * queued hash into "Invalid context" (native work keeps its context alive once started).
     */
    async _withContextAsync(seed, fn) {
        const key = seed.toString('hex');
        for (let attempt = 0; attempt < 2; attempt++) {
            this._assertAlive();
            const entry = this._touch(key);
            if (entry) {
                return fn(entry.contextId);
            }
            await this.warmSeedAsync(seed);
        }
        throw new Error('Seed was released while warming up');
    }

    /**
     * @param {string} seedHex 64 hex chars (32 bytes)
     * @returns {number} contextId
     */
    getContextFromHex(seedHex) {
        return this.getContext(seedFromHex(seedHex));
    }

    /** Sync hashing; initializes a missing seed synchronously. */
    hash(seed, input, options) {
        assertInput(input);
        const variant = normalizeVariant(options);
        return randomx.hash(this.getContext(seed), input, variant);
    }

    hashFromHex(seedHex, input, options) {
        return this.hash(seedFromHex(seedHex), input, options);
    }

    /**
     * Raw RandomX hash on the worker pool.
     * @returns {Promise<Buffer>}
     */
    hashAsync(seed, input, options) {
        assertSeed(seed);
        assertInput(input);
        const variant = normalizeVariant(options);
        return this._withContextAsync(seed, (contextId) => randomx.hashAsync(contextId, input, variant));
    }

    hashAsyncFromHex(seedHex, input, options) {
        return this.hashAsync(seedFromHex(seedHex), input, options);
    }

    /** Sync hash + PoW (see powAsync). */
    pow(seed, input, options) {
        assertInput(input);
        const variant = normalizeVariant(options);
        return randomx.pow(this.getContext(seed), input, variant);
    }

    powFromHex(seedHex, input, options) {
        return this.pow(seedFromHex(seedHex), input, options);
    }

    /**
     * Hash and PoW on the worker pool. `pow` is the value compared with the target and submitted
     * by miners as `result`: the hash for rx/0, the commitment for rx/2.
     * @returns {Promise<{ hash: Buffer, pow: Buffer }>}
     */
    powAsync(seed, input, options) {
        assertSeed(seed);
        assertInput(input);
        const variant = normalizeVariant(options);
        return this._withContextAsync(seed, (contextId) => randomx.powAsync(contextId, input, variant));
    }

    powAsyncFromHex(seedHex, input, options) {
        return this.powAsync(seedFromHex(seedHex), input, options);
    }

    warmSeed(seed) {
        this._getContextSync(seed, false);
    }

    warmSeedFromHex(seedHex) {
        this.warmSeed(seedFromHex(seedHex));
    }

    /**
     * Build a seed's cache/dataset on the worker pool. Concurrent calls for one seed share one
     * build. Variants need no warmup: their VMs are created on first use.
     * @returns {Promise<void>}
     */
    async warmSeedAsync(seed) {
        assertSeed(seed);
        this._assertAlive();
        const key = seed.toString('hex');

        if (this._touch(key, false)) {
            return;
        }
        if (this._pendingWarmups.has(key)) {
            return this._pendingWarmups.get(key).promise;
        }

        const pending = { cancelled: false, promise: null };
        pending.promise = randomx.initContextAsync(Buffer.from(seed), this._initOptions).then(
            (contextId) => {
                if (this._pendingWarmups.get(key) === pending) {
                    this._pendingWarmups.delete(key);
                }
                if (pending.cancelled || this._destroyed || this._lru.has(key)) {
                    randomx.releaseContext(contextId);
                    return;
                }
                this._insert(key, contextId, false);
            },
            (error) => {
                if (this._pendingWarmups.get(key) === pending) {
                    this._pendingWarmups.delete(key);
                }
                throw error;
            }
        );
        this._pendingWarmups.set(key, pending);
        return pending.promise;
    }

    async warmSeedAsyncFromHex(seedHex) {
        return this.warmSeedAsync(seedFromHex(seedHex));
    }

    /** Sync verification; initializes a missing seed synchronously. */
    verifyShare(seed, input, target, expectedPow = null, options) {
        assertInput(input);
        return verifyShare(this.getContext(seed), input, target, expectedPow, options);
    }

    verifyShareFromHex(seedHex, input, target, expectedPow = null, options) {
        return this.verifyShare(seedFromHex(seedHex), input, target, expectedPow, options);
    }

    /**
     * @param {Buffer} seed
     * @returns {boolean}
     */
    has(seed) {
        assertSeed(seed);
        return this._lru.has(seed.toString('hex'));
    }

    /**
     * How a seed's memory is backed, recorded once at allocation.
     * @param {Buffer} seed
     * @returns {{ dataset: string|null, cache: string|null, scratchpad: { hugetlb: number, normal: number } } | null}
     */
    getMemoryInfo(seed) {
        assertSeed(seed);
        const entry = this._lru.get(seed.toString('hex'));
        const info = entry ? randomx.getContextInfo(entry.contextId) : null;
        return info ? info.memory : null;
    }

    /**
     * @param {Buffer} seed
     * @returns {boolean} whether a seed was released
     */
    release(seed) {
        assertSeed(seed);
        const key = seed.toString('hex');
        this._cancelPendingWarmup(key);
        return this._releaseKey(key);
    }

    /**
     * @param {string} seedHex
     * @returns {boolean}
     */
    releaseFromHex(seedHex) {
        return this.release(seedFromHex(seedHex));
    }

    releaseAll() {
        this._destroyed = true;
        this._stopSweep();
        for (const key of [...this._pendingWarmups.keys()]) {
            this._cancelPendingWarmup(key);
        }
        for (const key of [...this._lru.keys()]) {
            this._releaseKey(key);
        }
    }

    get size() {
        return this._lru.size;
    }

    /**
     * Introspection for logging (truncated seeds).
     */
    getSnapshot() {
        const seeds = [...this._lru].map(([key, entry]) => {
            const info = randomx.getContextInfo(entry.contextId);
            return {
                seed: `${key.slice(0, 16)}…`,
                lastUsed: entry.lastUsed,
                used: entry.used,
                vms: info ? info.vms : null,
                memory: info ? info.memory : null
            };
        });
        return {
            size: this._lru.size,
            maxSeeds: this.maxSeeds,
            vmPoolSize: this._vmPoolSize,
            idleEvictMs: this._idleEvictMs,
            seedPrefixes: seeds.map((s) => s.seed),
            seeds
        };
    }
}

/**
 * Create a seed-keyed LRU pool suitable for pool share verification.
 * Defaults: mode `light`, huge pages on (with fallback), dataset init on half the CPUs so live
 * hashing keeps cores during a seed change.
 *
 * @param {Object} [options]
 * @param {number} [options.maxSeeds=2] Max simultaneous seeds to retain.
 * @param {string} [options.mode='light'] RandomX mode when not overridden. Omitted or falsy values
 *   use 'light'; 'fast' must be explicit.
 * @param {number} [options.threads] Dataset init threads; defaults to half the CPUs (minimum 1).
 * @param {number} [options.vmPoolSize=1] Max VMs per variant per seed.
 * @param {boolean} [options.enableJit]
 * @param {boolean} [options.enableAes]
 * @param {boolean|string} [options.enableHugePages] true (default), 'thp' (no reserved pages) or false
 * @param {number} [options.idleEvictMs] release seeds not hashed for this long (ms) to reclaim RAM;
 *   a warmed seed that was never hashed is kept until first use (or LRU displacement)
 * @returns {SeedPool}
 */
function createSeedPool(options = {}) {
    const { maxSeeds, idleEvictMs, vmPoolSize, ...rest } = options;
    const initOptions = {
        mode: 'light',
        threads: Math.max(1, Math.floor(CPU_COUNT / 2)),
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
 * @param {Buffer} target - 32-byte little-endian target; valid when pow <= target
 * @param {Buffer} [expectedPow] - PoW the miner submitted as `result` (optional)
 * @param {{ variant?: string }} [options]
 * @returns {{ valid: boolean, difficulty: number, hashTime: number, hash: Buffer, pow: Buffer }}
 */
function verifyShare(contextId, input, target, expectedPow = null, options) {
    assertInput(input);
    if (!Buffer.isBuffer(target) || target.length !== 32) {
        throw new Error('Target must be a 32-byte Buffer');
    }
    if (expectedPow && (!Buffer.isBuffer(expectedPow) || expectedPow.length !== 32)) {
        throw new Error('Expected PoW must be a 32-byte Buffer');
    }

    return randomx.verifyShare(contextId, input, target, expectedPow, normalizeVariant(options));
}

/**
 * Calculate the raw RandomX hash
 * @param {number} contextId - Context ID from initContext
 * @param {Buffer} input - Input data to hash
 * @param {{ variant?: string }} [options]
 * @returns {Buffer} 32-byte hash result
 */
function hash(contextId, input, options) {
    assertInput(input);
    return randomx.hash(contextId, input, normalizeVariant(options));
}

/**
 * Calculate the raw RandomX hash on the worker pool.
 * @returns {Promise<Buffer>} 32-byte hash result
 */
function hashAsync(contextId, input, options) {
    assertInput(input);
    return randomx.hashAsync(contextId, input, normalizeVariant(options));
}

/**
 * Hash and PoW: `pow` is the hash for rx/0 and the commitment for rx/2.
 * @returns {{ hash: Buffer, pow: Buffer }}
 */
function pow(contextId, input, options) {
    assertInput(input);
    return randomx.pow(contextId, input, normalizeVariant(options));
}

/**
 * Hash and PoW on the worker pool.
 * @returns {Promise<{ hash: Buffer, pow: Buffer }>}
 */
function powAsync(contextId, input, options) {
    assertInput(input);
    return randomx.powAsync(contextId, input, normalizeVariant(options));
}

/**
 * RandomX v2 commitment: Blake2b-256(input || hash). Cheap; no VM involved.
 * @param {Buffer} input
 * @param {Buffer} hash 32-byte RandomX hash of `input`
 * @returns {Buffer}
 */
function commitment(input, hashValue) {
    assertInput(input);
    return randomx.commitment(input, hashValue);
}

/**
 * Release a context and free associated memory
 * @param {number} contextId - Context ID to release
 */
function releaseContext(contextId) {
    return randomx.releaseContext(contextId);
}

/**
 * How this context was built, recorded once at allocation.
 * @param {number} contextId
 * @returns {{ mode: string, enableHugePages: boolean, hugePages: string, vmPoolSize: number, vms: Object,
 *   memory: { dataset: string|null, cache: string|null, scratchpad: { hugetlb: number, normal: number } } } | null}
 *   null if invalid id. Backings are 'hugetlb', 'thp' (advised before first touch) or 'normal'.
 */
function getContextInfo(contextId) {
    if (typeof contextId !== 'number') {
        throw new Error('contextId must be a number');
    }
    return randomx.getContextInfo(contextId);
}

/**
 * Performance statistics. `averageHashTime` is the mean RandomX hash duration in milliseconds
 * (excluding waits for a free VM); `variants` splits it per variant; `memory` counts live
 * seeds per backing.
 * @returns {Object} Performance metrics
 */
function getStats() {
    return randomx.getStats();
}

/**
 * Host / capability snapshot. `hugePages` is the default-size hugetlb pool; `available` is
 * free minus reserved, the pages a new mapping can actually get. `transparentHugePages` is the
 * kernel's THP mode.
 * @returns {Object} Available hardware features
 */
function getHardwareInfo() {
    return randomx.getHardwareInfo();
}

/**
 * Native capabilities: `{ abi, variants, commitment, randomx }`. Check `variants.includes('rx/2')`
 * before relying on RandomX v2. `randomx` is the upstream RandomX commit the addon was compiled
 * from; it differs from package.json `randomx.commit` when the build is stale.
 */
function capabilities() {
    return randomx.capabilities();
}

module.exports = {
    VARIANTS,
    MONERO_RX2_MAJOR_VERSION,
    LIMITS,
    initContext,
    initContextAsync,
    normalizeInitOptions,
    getVariant,
    createSeedPool,
    createPoolSeedPool,
    createContextCache: createSeedPool,
    createPoolEpochCache: createPoolSeedPool,
    SeedPool,
    RandomXContextCache: SeedPool,
    verifyShare,
    hash,
    hashAsync,
    pow,
    powAsync,
    commitment,
    releaseContext,
    getContextInfo,
    getStats,
    getHardwareInfo,
    capabilities
};
