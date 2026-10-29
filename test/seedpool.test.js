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

test('latest used seed survives idle time and prewarming', async () => {
    const pool = rx.createPoolSeedPool({ ...light, idleEvictMs: 100 });
    const seed = crypto.randomBytes(32);
    await pool.hashAsync(seed, input);
    assert.strictEqual(pool.size, 1);
    await sleep(300);
    assert.ok(pool.has(seed), 'latest used seed must stay warm');
    assert.strictEqual(pool.getSnapshot().idleProtectedSeed, `${seed.toString('hex').slice(0, 16)}…`);
    assert.strictEqual(pool.getSnapshot().seeds[0].idleProtected, true);
    assert.strictEqual(pool.getSnapshot().seeds[0].protected, false);
    const next = crypto.randomBytes(32);
    await pool.warmSeedAsync(next);
    await sleep(300);
    assert.ok(pool.has(seed), 'prewarming must not replace the latest used seed');
    await pool.hashAsync(next, input);
    await sleep(300);
    assert.ok(!pool.has(seed), 'previous used seed must expire after transition');
    assert.ok(pool.has(next), 'new latest used seed must stay warm');
    assert.ok(pool.release(next), 'explicit release must override idle protection');
    assert.strictEqual(pool.size, 0);
    pool.releaseAll();
});

test('releasing the latest seed restores the previous used fallback', async () => {
    const pool = rx.createPoolSeedPool({ ...light, maxSeeds: 2, idleEvictMs: 100 });
    const previous = crypto.randomBytes(32);
    const latest = crypto.randomBytes(32);
    await pool.hashAsync(previous, input);
    await pool.hashAsync(latest, input);
    await pool.warmSeedAsync(previous); // Move it in LRU order without making it latest-used.
    assert.ok(pool.release(latest));
    await sleep(300);
    assert.ok(pool.has(previous), 'remaining latest-used seed was not promoted after release');
    pool.releaseAll();
});

test('an explicitly protected current seed wins over late work and LRU order', async () => {
    const pool = rx.createPoolSeedPool({ ...light, maxSeeds: 2, idleEvictMs: 100 });
    const previous = crypto.randomBytes(32);
    const current = crypto.randomBytes(32);
    const next = crypto.randomBytes(32);

    await pool.hashAsync(previous, input);
    await pool.hashAsync(current, input);
    await pool.protectSeedAsync(current);
    await pool.hashAsync(previous, input); // late work must not change the explicit identity
    await sleep(300);
    assert.ok(!pool.has(previous), 'late previous-seed work displaced the current seed');
    assert.ok(pool.has(current), 'explicit current seed expired as idle');
    assert.strictEqual(pool.getSnapshot().seeds[0].protected, true);
    assert.strictEqual(pool.getSnapshot().seeds[0].idleProtected, true);
    assert.strictEqual(pool.getSnapshot().idleProtectedSeed, `${current.toString('hex').slice(0, 16)}…`);

    // Recreate the real quiet-epoch order: current was warmed before the last previous share,
    // then an upcoming seed arrives while maxSeeds is full.
    await pool.warmSeedAsync(previous);
    await pool.hashAsync(previous, input);
    await pool.protectSeedAsync(current);
    await pool.warmSeedAsync(next);
    assert.ok(!pool.has(previous), 'LRU retained previous instead of protected current');
    assert.ok(pool.has(current), 'LRU evicted protected current');
    assert.ok(pool.has(next), 'next seed was not retained');

    assert.ok(pool.release(current), 'explicit release must override protection');
    assert.strictEqual(pool.getSnapshot().protectedSeed, null);
    pool.releaseAll();
});

test('the maxSeeds bound and sync protection API remain authoritative', async () => {
    const pool = rx.createPoolSeedPool({ ...light, maxSeeds: 1 });
    const current = crypto.randomBytes(32);
    const next = crypto.randomBytes(32);
    pool.protectSeedFromHex(current.toString('hex'));
    assert.ok(pool.has(current));
    assert.strictEqual(pool.getSnapshot().protectedSeed, `${current.toString('hex').slice(0, 16)}…`);
    await pool.warmSeedAsync(next);
    assert.ok(!pool.has(current), 'maxSeeds=1 must remain a hard memory bound');
    assert.ok(pool.has(next));
    assert.strictEqual(pool.getSnapshot().protectedSeed, null);
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
    assert.ok(pool.has(next), 'latest used seed must survive idle time');
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
    const protecting = assert.rejects(pool.protectSeedAsync(crypto.randomBytes(32)), /released/);
    pool.releaseAll();
    await warming;
    await protecting;
    assert.strictEqual(pool.size, 0);
    assert.strictEqual(pool.getSnapshot().protectedSeed, null);
    assert.strictEqual(rx.getStats().activeContexts, before, 'context leaked after releaseAll');
    await assert.rejects(pool.warmSeedAsync(crypto.randomBytes(32)), /released/);
    await assert.rejects(pool.protectSeedAsync(crypto.randomBytes(32)), /released/);
    await assert.rejects(pool.hashAsync(crypto.randomBytes(32), input), /released/);
});

test('release cancels pending protection immediately', async () => {
    const pool = rx.createPoolSeedPool(light);
    const seed = crypto.randomBytes(32);
    const protecting = pool.protectSeedAsync(seed);
    assert.ok(pool.getSnapshot().protectedSeed, 'pending protection was not visible');
    assert.strictEqual(pool.release(seed), false, 'pending seed must not claim a resident release');
    assert.strictEqual(pool.getSnapshot().protectedSeed, null, 'release left pending protection set');
    await assert.rejects(protecting, (error) => {
        assert.strictEqual(error.code, 'ERR_RANDOMX_SEED_RELEASED');
        return /released while warming/.test(error.message);
    });
    assert.strictEqual(pool.size, 0);
    pool.releaseAll();
});

test('release cancels a cold hash without rebuilding its seed', async () => {
    const pool = rx.createPoolSeedPool(light);
    const seed = crypto.randomBytes(32);
    const misses = rx.getStats().cacheMisses;
    const contexts = rx.getStats().activeContexts;
    const hashing = pool.hashAsync(seed, input);
    assert.strictEqual(pool.release(seed), false, 'cold seed must not claim a resident release');
    await assert.rejects(hashing, (error) => {
        assert.strictEqual(error.code, 'ERR_RANDOMX_SEED_RELEASED');
        return /released while warming/.test(error.message);
    });
    assert.strictEqual(rx.getStats().cacheMisses - misses, 1, 'cancelled hash rebuilt its seed');
    assert.strictEqual(rx.getStats().activeContexts, contexts, 'cancelled hash left a context resident');
    assert.strictEqual(pool.size, 0);
    pool.releaseAll();
});

test('new protection cancels a superseded pending seed build', async () => {
    const pool = rx.createPoolSeedPool({ ...light, maxSeeds: 1 });
    const superseded = crypto.randomBytes(32);
    const current = crypto.randomBytes(32);
    const misses = rx.getStats().cacheMisses;
    const oldResult = pool.protectSeedAsync(superseded).then(
        () => null,
        (error) => error
    );
    const oldHashResult = pool.hashAsync(superseded, input).then(
        () => null,
        (error) => error
    );
    await pool.protectSeedAsync(current);
    const oldError = await oldResult;
    const oldHashError = await oldHashResult;
    assert.strictEqual(oldError && oldError.code, 'ERR_RANDOMX_PROTECTION_SUPERSEDED');
    assert.strictEqual(oldHashError && oldHashError.code, 'ERR_RANDOMX_SEED_RELEASED');
    assert.strictEqual(rx.getStats().cacheMisses - misses, 2, 'cancelled hash rebuilt its seed');
    assert.ok(!pool.has(superseded));
    assert.ok(pool.has(current));
    assert.strictEqual(pool.getSnapshot().protectedSeed, `${current.toString('hex').slice(0, 16)}…`);
    pool.releaseAll();
});

test('superseding protection preserves hashes for the previous seed when capacity allows', async () => {
    const pool = rx.createPoolSeedPool({ ...light, maxSeeds: 2 });
    const previous = crypto.randomBytes(32);
    const current = crypto.randomBytes(32);
    const oldProtection = pool.protectSeedAsync(previous).then(
        () => null,
        (error) => error
    );
    const previousHash = pool.hashAsync(previous, input);

    await pool.protectSeedAsync(current);
    const oldError = await oldProtection;
    const hash = await previousHash;
    assert.strictEqual(oldError && oldError.code, 'ERR_RANDOMX_PROTECTION_SUPERSEDED');
    assert.ok(Buffer.isBuffer(hash), 'valid previous-seed hash was rejected during transition');
    assert.ok(pool.has(previous));
    assert.ok(pool.has(current));
    assert.strictEqual(pool.getSnapshot().protectedSeed, `${current.toString('hex').slice(0, 16)}…`);
    pool.releaseAll();
});

test('superseding resident protection rejects the older promise clearly', async () => {
    const pool = rx.createPoolSeedPool({ ...light, maxSeeds: 2 });
    const previous = crypto.randomBytes(32);
    const current = crypto.randomBytes(32);
    await pool.warmSeedAsync(previous);
    const oldResult = pool.protectSeedAsync(previous).then(
        () => null,
        (error) => error
    );
    await pool.protectSeedAsync(current);
    const oldError = await oldResult;
    assert.strictEqual(oldError && oldError.code, 'ERR_RANDOMX_PROTECTION_SUPERSEDED');
    assert.ok(pool.has(previous));
    assert.ok(pool.has(current));
    assert.strictEqual(pool.getSnapshot().protectedSeed, `${current.toString('hex').slice(0, 16)}…`);
    assert.strictEqual(pool.getSnapshot().idleProtectedSeed, `${current.toString('hex').slice(0, 16)}…`);
    pool.releaseAll();
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
        assert.throws(() => pool.protectSeedAsyncFromHex(bad), /seedHex/, `protected seedHex ${bad}`);
    }
    assert.throws(() => pool.hashAsync(Buffer.alloc(31), input), /32-byte/);
    assert.throws(() => pool.protectSeed(Buffer.alloc(31)), /32-byte/);
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
