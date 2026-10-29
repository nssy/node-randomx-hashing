/**
 * Sketch: wiring node-randomx-hashing into a node-cryptonote-pool–style flow.
 *
 * Real pools (e.g. lib/pool.js) typically:
 *   1. Receive block templates from the daemon (`getblocktemplate`).
 *   2. Store `seed_hash` (Monero RandomX key) on the template — hex, 32 bytes.
 *   3. Build the block blob miners hash (cryptonote-util / pool-specific helpers).
 *   4. Verify shares with the same blob + seed the miner used.
 *
 * P2pool keeps current and previous RandomX key slots. With `maxSeeds: 2`, protect the current
 * seed explicitly and use the other slot for previous work or a prewarmed next seed. On daemon
 * template updates call `protectSeedAsync(currentSeed)` and, when available,
 * `warmSeedAsync(nextSeed)`. Do not infer current-seed identity from whichever share arrived last.
 * `idleEvictMs` can then release older used contexts after a grace period. If old jobs are dropped
 * immediately, `maxSeeds: 1` lowers peak memory instead.
 *
 * This file does not depend on cryptonote-util; it shows where RandomX fits.
 * Replace `buildPlaceholderBlob()` with your pool's blob conversion + nonce injection.
 */

const os = require('os');
const randomx = require('../index');

/**
 * @param {object} opts
 * @param {boolean} [opts.fast=true] Use fast mode (~2GB per context) for ~1–2ms hashes.
 * @param {number} [opts.idleEvictMs] Release older used, unprotected seed contexts after this
 *   many ms without use; current and never-used prewarmed seeds are retained (subject to maxSeeds).
 */
function createPoolVerifier(opts = {}) {
    const fast = opts.fast !== false;
    return randomx.createPoolSeedPool({
        // 2 = protected current + one adjacent transition seed; 1 = less RAM if no old jobs remain
        maxSeeds: opts.maxSeeds != null ? opts.maxSeeds : 2,
        mode: fast ? 'fast' : 'light',
        threads: opts.threads != null ? opts.threads : Math.max(1, os.cpus().length),
        enableHugePages: opts.enableHugePages !== undefined ? opts.enableHugePages : true,
        enableJit: opts.enableJit !== false,
        enableAes: opts.enableAes !== false,
        ...(opts.idleEvictMs != null ? { idleEvictMs: opts.idleEvictMs } : {})
    });
}

/**
 * Verify a share asynchronously, picking the RandomX variant from the hashing blob.
 *
 * Monero hard fork 17 switches to RandomX v2 (`rx/2`): the block major version (first byte of
 * the hashing blob) decides the variant per job, so shares for pre-fork jobs still verify as
 * rx/0 after the switch. For rx/2 the value compared with the target is the commitment (`pow`),
 * which xmrig submits as `result` (its `commitment` field carries the raw hash).
 *
 * **When `seedHashHex` changes:** the seed pool looks it up in its LRU. Separately, the pool's
 * template-update handler must call `protectSeedAsync()` for the daemon's current seed.
 * - First time this seed is seen → built once on the worker pool (dataset init in fast mode).
 * - Seed still cached (current + adjacent previous/next with `maxSeeds: 2`) → same resources, no re-init.
 * - New seed and cache full → evicts the least recently used unprotected seed when possible.
 *
 * @param {import('../index').SeedPool} cache
 * @param {string} seedHashHex — from block template: `blockTemplate.seed_hash`
 * @param {Buffer} hashingBlob — hashing blob with the miner's nonce
 * @param {number} difficulty — share difficulty
 * @param {Buffer} [minerResult] — 32-byte `result` from the miner's submit
 * @returns {Promise<{ valid: boolean, hashDifficulty: number, pow: Buffer, variant: string }>}
 */
async function verifyShareCryptonoteStyle(cache, seedHashHex, hashingBlob, difficulty, minerResult) {
    const variant = randomx.getVariant(hashingBlob);
    const { pow } = await cache.powAsyncFromHex(seedHashHex, hashingBlob, { variant });

    let value = 0;
    for (let i = 31; i >= 0; i--) value = value * 256 + pow[i];
    const hashDifficulty = value === 0 ? Infinity : 2 ** 256 / value;

    const matches = !minerResult || pow.equals(minerResult);
    return { valid: matches && hashDifficulty >= difficulty, hashDifficulty, pow, variant };
}

/**
 * Cheap checks on an xmrig-style submit before spending a VM on it. For rx/2, xmrig swaps the
 * names: `result` is the commitment (the PoW compared with the target) and `commitment` is the
 * raw RandomX v2 hash. `result` must equal Blake2b(hashingBlob || commitment), which costs a
 * Blake2b call, not a RandomX hash. A share that fails it is invalid whatever the VM says.
 *
 * Passing it does not prove the work (any `commitment` value passes if `result` is derived from
 * it), so still verify with powAsync unless the share is trusted.
 *
 * @param {string} variant from getVariant(hashingBlob)
 * @param {Buffer} hashingBlob with the miner's nonce
 * @param {{ result: string, commitment?: string }} params submit params (hex)
 * @returns {{ ok: boolean, reason?: string, result?: Buffer }}
 */
function precheckSubmit(variant, hashingBlob, params) {
    const hex32 = (value) => typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value);
    if (!hex32(params.result)) {
        return { ok: false, reason: 'malformed result' };
    }
    const result = Buffer.from(params.result, 'hex');
    if (variant === 'rx/0') {
        return { ok: true, result };
    }
    if (!hex32(params.commitment)) {
        return { ok: false, reason: 'rx/2 submit without commitment (miner is not rx/2 capable)' };
    }
    const expected = randomx.commitment(hashingBlob, Buffer.from(params.commitment, 'hex'));
    return expected.equals(result) ? { ok: true, result } : { ok: false, reason: 'commitment mismatch' };
}

/**
 * Placeholder — in a real pool you merge job id, extra_nonce, pool nonce, etc.
 * @returns {Buffer}
 */
function buildPlaceholderBlob() {
    return Buffer.alloc(76, 0x42);
}

async function demo() {
    const cache = createPoolVerifier({ fast: true });
    const seedHashHex = 'ab'.repeat(32);
    await cache.protectSeedAsync(Buffer.from(seedHashHex, 'hex'));

    for (const majorVersion of [16, 17]) {
        const blob = buildPlaceholderBlob();
        blob[0] = majorVersion;
        const result = await verifyShareCryptonoteStyle(cache, seedHashHex, blob, 1);
        console.log(`v${majorVersion} share:`, {
            variant: result.variant,
            valid: result.valid,
            hashDifficulty: result.hashDifficulty,
            powPrefix: result.pow.toString('hex').slice(0, 16) + '…'
        });
    }

    // What an rx/2 miner (xmrig) submits for a v17 job, and the pool's checks on it.
    const blob = buildPlaceholderBlob();
    blob[0] = 17;
    const variant = randomx.getVariant(blob);
    const { hash, pow } = await cache.powAsyncFromHex(seedHashHex, blob, { variant });
    const submit = { result: pow.toString('hex'), commitment: hash.toString('hex') };
    console.log('rx/2 submit precheck:', precheckSubmit(variant, blob, submit).ok);
    console.log('rx/2 submit with raw hash as result:',
        precheckSubmit(variant, blob, { ...submit, result: submit.commitment }).reason);
    console.log('rx/2 submit from an rx/0-only miner:', precheckSubmit(variant, blob, { result: submit.result }).reason);
    const verified = await verifyShareCryptonoteStyle(cache, seedHashHex, blob, 1, Buffer.from(submit.result, 'hex'));
    console.log('rx/2 full verification:', verified.valid);

    // Which memory the seed got (recorded once; see examples/memory-backing.js).
    console.log('Memory:', cache.getMemoryInfo(Buffer.from(seedHashHex, 'hex')));
    console.log('Cache snapshot:', JSON.stringify(cache.getSnapshot(), null, 2));
    cache.releaseAll();
}

if (require.main === module) {
    demo().catch((e) => {
        console.error(e.message);
        process.exitCode = 1;
    });
}

module.exports = {
    createPoolVerifier,
    verifyShareCryptonoteStyle,
    precheckSubmit,
    createSeedPool: randomx.createSeedPool,
    createPoolSeedPool: randomx.createPoolSeedPool
};
