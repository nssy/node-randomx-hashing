/**
 * SeedPool, variants, VM pools and share math. Light mode keeps it quick.
 */

const assert = require('assert');
const crypto = require('crypto');
const rx = require('../index');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const input = Buffer.from('seed pool test input');
const light = { mode: 'light', threads: 1 };

/** Largest gap between event-loop ticks while `fn` runs. */
async function maxLoopGap(fn) {
    let last = process.hrtime.bigint();
    let max = 0;
    const timer = setInterval(() => {
        const now = process.hrtime.bigint();
        max = Math.max(max, Number(now - last) / 1e6);
        last = now;
    }, 5);
    try {
        await fn();
    } finally {
        clearInterval(timer);
    }
    return max;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('cold hashAsync warms off the event loop', async () => {
    const pool = rx.createPoolSeedPool(light);
    const gap = await maxLoopGap(() => pool.hashAsync(crypto.randomBytes(32), input));
    pool.releaseAll();
    // Measured ~5 ms (timer resolution); synchronous init stalled for ~600 ms.
    assert.ok(gap < 50, `event loop blocked for ${gap.toFixed(0)} ms`);
});

test('idle seeds are released without any traffic', async () => {
    const pool = rx.createPoolSeedPool({ ...light, idleEvictMs: 100 });
    const seed = crypto.randomBytes(32);
    await pool.hashAsync(seed, input);
    assert.strictEqual(pool.size, 1);
    await sleep(300);
    assert.strictEqual(pool.size, 0, 'idle seed still held');
    pool.releaseAll();
});

test('a prewarmed seed waits for its first hash', async () => {
    const pool = rx.createPoolSeedPool({ ...light, idleEvictMs: 100 });
    const next = crypto.randomBytes(32);
    await pool.warmSeedAsync(next); // next_seed_hash: published ~2 h before it is used
    pool.warmSeed(next);
    await sleep(300);
    assert.ok(pool.has(next), 'prewarmed seed evicted before first use');
    assert.strictEqual(pool.getSnapshot().seeds[0].used, false);
    await pool.hashAsync(next, input);
    await sleep(300);
    assert.ok(!pool.has(next), 'seed kept after use went idle');
    pool.releaseAll();
});

test('a seed in use is never evicted as idle', async () => {
    const pool = rx.createPoolSeedPool({ ...light, idleEvictMs: 150 });
    const busy = crypto.randomBytes(32);
    const idle = crypto.randomBytes(32);
    await pool.hashAsync(busy, input);
    await pool.hashAsync(idle, input);
    for (let i = 0; i < 8; i++) {
        await pool.hashAsync(busy, input);
        await sleep(50);
    }
    assert.ok(pool.has(busy), 'busy seed evicted');
    assert.ok(!pool.has(idle), 'idle seed kept');
    pool.releaseAll();
});

test('releaseAll rejects new work and drops in-flight warmups', async () => {
    const pool = rx.createPoolSeedPool(light);
    const before = rx.getStats().activeContexts;
    const warming = pool.warmSeedAsync(crypto.randomBytes(32));
    pool.releaseAll();
    await warming;
    assert.strictEqual(pool.size, 0);
    assert.strictEqual(rx.getStats().activeContexts, before, 'context leaked after releaseAll');
    await assert.rejects(pool.warmSeedAsync(crypto.randomBytes(32)), /released/);
    await assert.rejects(pool.hashAsync(crypto.randomBytes(32), input), /released/);
});

test('concurrent warmups of one seed build it once', async () => {
    const pool = rx.createPoolSeedPool(light);
    const seed = crypto.randomBytes(32);
    const misses = rx.getStats().cacheMisses;
    await Promise.all(Array.from({ length: 6 }, () => pool.warmSeedAsync(seed)));
    assert.strictEqual(rx.getStats().cacheMisses - misses, 1);
    assert.strictEqual(pool.size, 1);
    pool.releaseAll();
});

test('variants share one dataset and get separate lazy VM pools', async () => {
    const pool = rx.createPoolSeedPool({ ...light, vmPoolSize: 4 });
    const seed = crypto.randomBytes(32);
    const seedsBefore = rx.getStats().activeSeeds;
    const v1 = await pool.hashAsync(seed, input);
    const v2 = await pool.hashAsync(seed, input, { variant: 'rx/2' });
    assert.ok(!v1.equals(v2), 'rx/0 and rx/2 hashes must differ');
    assert.strictEqual(rx.getStats().activeSeeds - seedsBefore, 1, 'one cache for both variants');

    const contextId = pool.getContext(seed);
    assert.deepStrictEqual(rx.getContextInfo(contextId).vms, { 'rx/0': 1, 'rx/2': 1 });

    // 32 concurrent rx/2 requests never create more than vmPoolSize VMs, and all agree.
    const inputs = Array.from({ length: 32 }, (_, i) => Buffer.from(`input ${i}`));
    const results = await Promise.all(inputs.map((b) => pool.powAsync(seed, b, { variant: 'rx/2' })));
    assert.ok(rx.getContextInfo(contextId).vms['rx/2'] <= 4, 'VM pool exceeded vmPoolSize');
    results.forEach((r, i) => assert.ok(r.hash.equals(rx.hash(contextId, inputs[i], { variant: 'rx/2' }))));
    pool.releaseAll();
});

test('pow is the hash for rx/0 and the commitment for rx/2', async () => {
    const pool = rx.createPoolSeedPool(light);
    const seed = crypto.randomBytes(32);
    const r0 = await pool.powAsync(seed, input);
    assert.ok(r0.pow.equals(r0.hash));
    assert.ok(pool.powFromHex(seed.toString('hex'), input).pow.equals(r0.pow), 'sync hex form agrees');
    const r2 = await pool.powAsync(seed, input, { variant: 'rx/2' });
    assert.ok(r2.pow.equals(rx.commitment(input, r2.hash)));
    assert.ok(!r2.pow.equals(r2.hash));
    pool.releaseAll();
});

test('unknown variants throw instead of falling back', () => {
    const pool = rx.createPoolSeedPool(light);
    const seed = crypto.randomBytes(32);
    assert.throws(() => pool.hashAsync(seed, input, { variant: 'rx/1' }), /Variant/);
    assert.throws(() => pool.hash(seed, input, { variant: 'RX/2' }), /Variant/);
    pool.releaseAll();
});

test('a hash queued before a release in the same tick still completes', async () => {
    const pool = rx.createPoolSeedPool(light);
    const seed = crypto.randomBytes(32);
    await pool.warmSeedAsync(seed);
    const queued = [pool.hashAsync(seed, input), pool.powAsync(seed, input, { variant: 'rx/2' })];
    pool.release(seed);
    const [hash, { pow }] = await Promise.all(queued);
    assert.strictEqual(hash.length, 32);
    assert.strictEqual(pow.length, 32);
    pool.releaseAll();
});

test('stats count hashes per variant and live seeds per backing', async () => {
    const pool = rx.createPoolSeedPool({ ...light, enableHugePages: false });
    const seed = crypto.randomBytes(32);
    const before = rx.getStats();
    await pool.hashAsync(seed, input);
    await pool.hashAsync(seed, input, { variant: 'rx/2' });
    await pool.hashAsync(seed, input, { variant: 'rx/2' });
    const after = rx.getStats();
    assert.strictEqual(after.variants['rx/0'].totalHashes - before.variants['rx/0'].totalHashes, 1);
    assert.strictEqual(after.variants['rx/2'].totalHashes - before.variants['rx/2'].totalHashes, 2);
    assert.strictEqual(after.totalHashes - before.totalHashes, 3);
    assert.ok(after.variants['rx/2'].averageHashTime > 0);
    assert.strictEqual(after.memory.cache.normal - before.memory.cache.normal, 1);
    assert.strictEqual(after.activeVMs - before.activeVMs, 2, 'one VM per used variant');
    pool.releaseAll();
    assert.strictEqual(rx.getStats().memory.cache.normal, before.memory.cache.normal, 'seed freed');
});

test('buffer and hex arguments are validated', () => {
    const native = require('../build/Release/randomx');
    const id = rx.initContext(crypto.randomBytes(32), light);
    const easy = Buffer.alloc(32, 0xff);
    assert.throws(() => native.verifyShare(id, input, easy, 'ab'.repeat(32)), /Expected PoW/);
    assert.throws(() => rx.verifyShare(id, input, easy, Buffer.alloc(31)), /Expected PoW/);
    assert.throws(() => rx.verifyShare(id, input, Buffer.alloc(31)), /Target/);
    assert.throws(() => rx.commitment(input, Buffer.alloc(31)), /32 bytes/);
    assert.throws(() => rx.hash(id, 'not a buffer'), /Buffer/);
    rx.releaseContext(id);

    const pool = rx.createPoolSeedPool(light);
    for (const bad of ['ab'.repeat(31), 'zz'.repeat(32), 42]) {
        assert.throws(() => pool.hashAsyncFromHex(bad, input), /seedHex/, `seedHex ${bad}`);
    }
    assert.throws(() => pool.hashAsync(Buffer.alloc(31), input), /32-byte/);
    pool.releaseAll();
});

test('releasing a seed does not break in-flight hashes', async () => {
    const pool = rx.createPoolSeedPool({ ...light, vmPoolSize: 2 });
    const seed = crypto.randomBytes(32);
    await pool.warmSeedAsync(seed);
    const pending = Array.from({ length: 8 }, (_, i) => pool.hashAsync(seed, Buffer.from([i])));
    await sleep(0);
    pool.release(seed);
    const hashes = await Promise.all(pending);
    hashes.forEach((h) => assert.strictEqual(h.length, 32));
    pool.releaseAll();
});

test('getVariant follows the block major version', () => {
    assert.strictEqual(rx.getVariant(Buffer.from([16, 16])), 'rx/0');
    assert.strictEqual(rx.getVariant(Buffer.from([17, 17])), 'rx/2');
    assert.strictEqual(rx.getVariant(Buffer.from([18])), 'rx/2');
    assert.throws(() => rx.getVariant(Buffer.from([0x80, 0x01])), /multi-byte/);
    assert.throws(() => rx.getVariant(Buffer.alloc(0)), /non-empty/);
});

test('verifyShare: difficulty is 2^256 / pow and expected pow is checked', () => {
    const contextId = rx.initContext(crypto.randomBytes(32), light);
    const easy = Buffer.alloc(32, 0xff);
    for (const variant of ['rx/0', 'rx/2']) {
        const r = rx.verifyShare(contextId, input, easy, null, { variant });
        let value = 0;
        for (let i = 31; i >= 0; i--) value = value * 256 + r.pow[i];
        const expected = 2 ** 256 / value;
        assert.ok(Math.abs(r.difficulty - expected) / expected < 1e-12, `difficulty ${r.difficulty} vs ${expected}`);
        assert.ok(r.valid);
        assert.ok(rx.verifyShare(contextId, input, easy, r.pow, { variant }).valid, 'matching pow');
        assert.ok(!rx.verifyShare(contextId, input, easy, r.hash.map((b) => b ^ 1), { variant }).valid, 'wrong pow');
        assert.ok(!rx.verifyShare(contextId, input, Buffer.alloc(32, 0), null, { variant }).valid, 'impossible target');
    }
    rx.releaseContext(contextId);
});

test('memory backing is recorded and reported', async () => {
    const pool = rx.createPoolSeedPool({ ...light, enableHugePages: false });
    const seed = crypto.randomBytes(32);
    await pool.warmSeedAsync(seed);
    assert.deepStrictEqual(pool.getMemoryInfo(seed), { dataset: null, cache: 'normal', scratchpad: { hugetlb: 0, normal: 1 } });
    assert.strictEqual(pool.getSnapshot().seeds[0].memory.cache, 'normal');
    pool.releaseAll();

    const thp = rx.createPoolSeedPool({ ...light, enableHugePages: 'thp' });
    await thp.warmSeedAsync(seed);
    const mode = rx.getHardwareInfo().transparentHugePages.enabled;
    const expected = mode === 'always' || mode === 'madvise' ? 'thp' : 'normal';
    assert.strictEqual(thp.getMemoryInfo(seed).cache, expected);
    assert.strictEqual(thp.getMemoryInfo(seed).scratchpad.hugetlb, 0, "'thp' must not use reserved pages");
    thp.releaseAll();

    assert.throws(() => rx.createPoolSeedPool({ ...light, enableHugePages: 'yes' }), /enableHugePages/);
});

test('options reject garbage and cap oversized values', () => {
    const native = require('../build/Release/randomx');
    const seed = crypto.randomBytes(32);
    const garbage = [NaN, Infinity, -Infinity, 0, -1, 1.5, '4', null];
    for (const name of ['threads', 'vmPoolSize']) {
        for (const value of garbage.filter((v) => v !== null)) {
            assert.throws(() => rx.initContext(seed, { ...light, [name]: value }), RangeError, `${name}=${value}`);
            const nativeError = typeof value === 'number' ? RangeError : TypeError;
            assert.throws(() => native.initContext(seed, { mode: 'light', [name]: value }), nativeError, `native ${name}=${value}`);
        }
    }
    for (const value of garbage.filter((v) => v !== null)) {
        assert.throws(() => rx.createSeedPool({ maxSeeds: value }), RangeError, `maxSeeds=${value}`);
    }
    for (const name of ['enableJit', 'enableAes']) {
        for (const value of [0, 1, null, 'false', 'true']) {
            assert.throws(() => rx.initContext(seed, { ...light, [name]: value }), TypeError, `${name}=${value}`);
        }
    }
    for (const value of [NaN, Infinity, -1, '1000']) {
        assert.throws(() => rx.createSeedPool({ idleEvictMs: value }), RangeError, `idleEvictMs=${value}`);
    }

    // Oversized values are capped, not rejected.
    const pool = rx.createSeedPool({ ...light, maxSeeds: 1e6, vmPoolSize: 1e6, threads: 1e6, idleEvictMs: 0 });
    assert.strictEqual(pool.maxSeeds, rx.LIMITS.maxSeeds);
    assert.strictEqual(pool.getSnapshot().vmPoolSize, rx.LIMITS.vmPoolSize);
    assert.strictEqual(pool.getSnapshot().idleEvictMs, null);
    pool.releaseAll();
    const id = native.initContext(seed, { mode: 'light', vmPoolSize: 1e6 });
    assert.strictEqual(native.getContextInfo(id).vmPoolSize, 1024, 'native backstop cap');

    // Context ids must be exact: no truncation onto a live context, no uint32 wrap-around.
    for (const bad of [id + 0.5, id + 2 ** 32, -id, NaN, Infinity]) {
        assert.throws(() => rx.hash(bad, input), /Invalid context/, `contextId ${bad}`);
        assert.strictEqual(rx.getContextInfo(bad), null, `getContextInfo(${bad})`);
    }
    native.releaseContext(id);
});

test('hardware info reports usable huge pages, not just free ones', () => {
    const { hugePages, hugePagesAvailable } = rx.getHardwareInfo();
    assert.strictEqual(hugePagesAvailable, hugePages.available);
    assert.strictEqual(hugePages.available, Math.max(0, hugePages.free - hugePages.reserved));
});

test('capabilities advertise rx/2 and commitments', () => {
    const caps = rx.capabilities();
    assert.deepStrictEqual(caps.variants, ['rx/0', 'rx/2']);
    assert.strictEqual(caps.commitment, true);
    assert.strictEqual(caps.abi, 2);
    assert.strictEqual(caps.randomx, require('../package.json').randomx.commit, 'stale build');
});

(async () => {
    for (const { name, fn } of tests) {
        const started = Date.now();
        try {
            await fn();
            console.log(`✓ ${name} (${Date.now() - started} ms)`);
        } catch (error) {
            console.error(`✗ ${name}\n`, error);
            process.exit(1);
        }
    }
    console.log(`\nAll ${tests.length} seed pool tests passed`);
})();
