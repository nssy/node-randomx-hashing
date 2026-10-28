/**
 * Fast mode integration test with the default huge-page ladder.
 *
 * Not part of the default `npm test` suite (2+ GB dataset per run).
 *
 * Run:
 *   npm run test:fast-mode
 *
 * Huge pages are on by default and fall back step by step: reserved hugetlb pages (Linux:
 * default page size, only if it is 2 MiB), then transparent huge pages (madvise before first
 * touch), then normal pages. This test passes on any host and prints which backing was used.
 */

const assert = require('assert');
const crypto = require('crypto');
const os = require('os');
const randomx = require('../index');

const testInput = Buffer.from('Fast mode + large pages probe', 'utf8');
const testTarget = Buffer.alloc(32, 0xff);
const backings = ['hugetlb', 'thp', 'normal'];

const hw = randomx.getHardwareInfo();
console.log('Huge pages:', hw.hugePages, 'THP:', hw.transparentHugePages, '\n');

const seed = crypto.randomBytes(32);
const reference = randomx.initContext(seed, { mode: 'fast', enableHugePages: false, threads: os.cpus().length });
const expected = randomx.hash(reference, testInput, { variant: 'rx/2' });
randomx.releaseContext(reference);

for (const enableHugePages of [true, 'thp']) {
    const contextId = randomx.initContext(seed, { mode: 'fast', enableHugePages, threads: os.cpus().length });
    try {
        const meta = randomx.getContextInfo(contextId);
        assert.strictEqual(meta.mode, 'fast');
        assert.ok(backings.includes(meta.memory.dataset), `dataset backing ${meta.memory.dataset}`);
        if (enableHugePages === 'thp') {
            assert.notStrictEqual(meta.memory.dataset, 'hugetlb', "'thp' must not use reserved pages");
        }

        const started = process.hrtime.bigint();
        for (let i = 0; i < 500; i++) {
            randomx.hash(contextId, Buffer.concat([testInput, Buffer.from([i & 0xff])]));
        }
        const micros = Number(process.hrtime.bigint() - started) / 1000 / 500;

        assert.ok(randomx.hash(contextId, testInput, { variant: 'rx/2' }).equals(expected), 'backing changed the hash');
        assert.strictEqual(typeof randomx.verifyShare(contextId, testInput, testTarget).valid, 'boolean');
        console.log(`✓ enableHugePages=${String(enableHugePages).padEnd(4)} dataset=${meta.memory.dataset} ` +
            `cache=${meta.memory.cache} scratchpad=${JSON.stringify(meta.memory.scratchpad)} ${micros.toFixed(0)} µs/hash`);
    } finally {
        randomx.releaseContext(contextId);
    }
}
