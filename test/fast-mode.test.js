/**
 * Fast mode integration test (optional huge / large pages when supported).
 *
 * Not part of the default `npm test` suite (dataset init cost on first cold run).
 *
 * Run:
 *   npm run test:fast-mode
 *
 * Host tips (Linux):
 *   ulimit -l unlimited
 *   Enough free RAM (~2.5GB+) and/or hugetlb pages; may need CAP_IPC_LOCK for locked memory.
 *
 * Fast mode (~1–2 ms/hash) = full RandomX dataset (`mode: 'fast'`).
 * `usedLargePages` = RandomX was given RANDOMX_FLAG_LARGE_PAGES for allocations (see getContextInfo).
 * On Linux, RandomX uses MAP_HUGETLB — page size is the kernel default (usually 2 MiB), not 1 GiB pages.
 */

const assert = require('assert');
const crypto = require('crypto');
const os = require('os');
const randomx = require('../index');

const testInput = Buffer.from('Fast mode + large pages probe', 'utf8');
const testTarget = Buffer.alloc(32, 0xff);

console.log('Fast mode test (enableHugePages: true → RANDOMX_FLAG_LARGE_PAGES when init succeeds)\n');

const hw = randomx.getHardwareInfo();
console.log('Hardware:', hw);

const seed = crypto.randomBytes(32);
let contextId;

try {
    contextId = randomx.initContext(seed, {
        mode: 'fast',
        enableHugePages: true,
        threads: Math.max(1, os.cpus().length),
        enableJit: true,
        enableAes: true
    });

    assert.strictEqual(typeof contextId, 'number', 'context id');
    assert.ok(contextId > 0, 'positive context id');

    const meta = randomx.getContextInfo(contextId);
    assert.ok(meta, 'getContextInfo');
    assert.strictEqual(meta.mode, 'fast');
    assert.strictEqual(meta.enableHugePages, true);

    console.log('Context metadata:', meta);
    console.log(
        meta.usedLargePages
            ? '  → usedLargePages: true — RANDOMX_FLAG_LARGE_PAGES was set (RandomX allocLargePagesMemory / MAP_HUGETLB; usually kernel default huge size, often 2 MiB, not 1 GiB).'
            : '  → usedLargePages: false — large-page flag not set (RandomX reports no large-page support here; fast mode still uses the full dataset).'
    );

    const h1 = randomx.hash(contextId, testInput);
    assert.strictEqual(h1.length, 32, 'hash length');
    const h2 = randomx.hash(contextId, testInput);
    assert.ok(h1.equals(h2), 'deterministic hash');

    const result = randomx.verifyShare(contextId, testInput, testTarget);
    assert.strictEqual(typeof result.valid, 'boolean');
    assert.strictEqual(typeof result.hashTime, 'number');
    assert.ok(Buffer.isBuffer(result.hash) && result.hash.length === 32);

    console.log('Sample verifyShare hashTime:', result.hashTime.toFixed(3), 'ms');
    console.log(
        '✓ Fast mode (full dataset): typical ~1–2 ms/hash — independent of whether large pages were used.'
    );
    console.log('');
} catch (err) {
    console.error('✗ Failed:', err.message);
    console.error(
        '\nIf allocation failed: raise locked memory (ulimit -l unlimited), ensure enough RAM / hugetlb,'
    );
    console.error('or use initContext(seed, { mode: "fast", enableHugePages: false }).\n');
    process.exit(1);
} finally {
    if (contextId) {
        randomx.releaseContext(contextId);
    }
}
