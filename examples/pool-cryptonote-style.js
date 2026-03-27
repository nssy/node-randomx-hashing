/**
 * Sketch: wiring node-randomx-hashing into a node-cryptonote-pool–style flow.
 *
 * Real pools (e.g. lib/pool.js) typically:
 *   1. Receive block templates from the daemon (`getblocktemplate`).
 *   2. Store `seed_hash` (Monero RandomX key) on the template — hex, 32 bytes.
 *   3. Build the block blob miners hash (cryptonote-util / pool-specific helpers).
 *   4. Verify shares with the same blob + seed the miner used.
 *
 * P2pool keeps two RandomX key slots (current + previous epoch). We mirror that with
 * `createPoolSeedPool` — default `maxSeeds: 2` (current + previous seed_hash).
 * If you drop old jobs immediately on template change, use `maxSeeds: 1` to halve peak memory,
 * or keep `maxSeeds: 2` and set `idleEvictMs` (e.g. 60_000) so the previous-seed VM is released
 * after a short grace period when nothing touches it (pools rarely resend old seed_hash).
 *
 * This file does not depend on cryptonote-util; it shows where RandomX fits.
 * Replace `buildPlaceholderBlob()` with your pool's blob conversion + nonce injection.
 */

const os = require('os');
const randomx = require('../index');

/**
 * @param {object} opts
 * @param {boolean} [opts.fast=true] Use fast mode (~2GB per context) for ~1–2ms hashes.
 * @param {number} [opts.idleEvictMs] Release a seed’s context after this many ms without a get/hash (saves RAM vs holding two fast VMs forever).
 */
function createPoolVerifier(opts = {}) {
    const fast = opts.fast !== false;
    return randomx.createPoolSeedPool({
        // 2 = current + previous seed_hash; 1 = less RAM if you never verify old jobs
        maxSeeds: opts.maxSeeds != null ? opts.maxSeeds : 2,
        mode: fast ? 'fast' : 'light',
        threads: opts.threads != null ? opts.threads : Math.max(1, os.cpus().length),
        enableHugePages: opts.enableHugePages === true,
        enableJit: opts.enableJit !== false,
        enableAes: opts.enableAes !== false,
        ...(opts.idleEvictMs != null ? { idleEvictMs: opts.idleEvictMs } : {})
    });
}

/**
 * Example: verify a share the same way you would after `randomX(blob, seedBuf, 0)`
 * from cryptonight-hashing — same inputs, but context is reused via seed_hash.
 *
 * **When `seedHashHex` changes:** `verifyShareFromHex` looks up that seed in the LRU cache.
 * - First time this seed is seen → **new** `initContext` (full dataset init in fast mode; costly once per epoch).
 * - Seed still in cache (e.g. current + previous job with `maxSeeds: 2`) → **same seed resources**, no re-init.
 * - New seed and cache full → **evicts** LRU entry, creates context for the new seed (releases old VM).
 *
 * @param {import('../index').SeedPool} cache
 * @param {string} seedHashHex — from block template: `blockTemplate.seed_hash`
 * @param {Buffer} blockBlob — full block blob with nonce (what miners hash)
 * @param {Buffer} target — 32-byte pool target (from difficulty)
 */
function verifyShareCryptonoteStyle(cache, seedHashHex, blockBlob, target) {
    return cache.verifyShareFromHex(seedHashHex, blockBlob, target);
}

/**
 * Placeholder — in a real pool you merge job id, extra_nonce, pool nonce, etc.
 * @returns {Buffer}
 */
function buildPlaceholderBlob() {
    return Buffer.alloc(76, 0x42);
}

function demo() {
    const cache = createPoolVerifier({ fast: true });

    const seedHashHex = 'ab'.repeat(32);
    const blob = buildPlaceholderBlob();
    const target = Buffer.alloc(32, 0xff);

    const result = verifyShareCryptonoteStyle(cache, seedHashHex, blob, target);
    console.log('Demo verify result:', {
        valid: result.valid,
        hashTimeMs: result.hashTime,
        hashPrefix: result.hash.toString('hex').slice(0, 16) + '…'
    });

    console.log('Cache snapshot:', cache.getSnapshot());

    cache.releaseAll();
}

if (require.main === module) {
    try {
        demo();
    } catch (e) {
        console.error(e.message);
        process.exitCode = 1;
    }
}

module.exports = {
    createPoolVerifier,
    verifyShareCryptonoteStyle,
    createSeedPool: randomx.createSeedPool,
    createPoolSeedPool: randomx.createPoolSeedPool
};
