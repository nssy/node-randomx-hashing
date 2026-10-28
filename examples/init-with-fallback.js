/**
 * Prefer RandomX fast mode (full dataset), but fall back to light mode when init fails
 * (e.g. not enough RAM for the ~2 GB dataset on small hosts).
 *
 * Huge pages need no fallback here: each buffer already falls back natively from reserved
 * hugetlb pages to transparent huge pages to normal pages, and records what it got
 * (`getContextInfo(id).memory`; see examples/memory-backing.js).
 */

const os = require('os');
const randomx = require('../index');
const { describeBacking, fellBack } = require('./memory-backing');

/**
 * @param {Buffer} seed - 32-byte RandomX seed
 * @param {object} [options]
 * @param {number} [options.threads] - threads for fast-mode dataset init (default: CPU count, min 1)
 * @param {boolean} [options.enableJit]
 * @param {boolean} [options.enableAes]
 * @returns {{ contextId: number, strategy: string }}
 */
function initContextPreferFastWithFallback(seed, options = {}) {
    const enableJit = options.enableJit !== false;
    const enableAes = options.enableAes !== false;
    const threadsFast =
        options.threads != null
            ? Math.max(1, options.threads)
            : Math.max(1, os.cpus().length);

    const attempts = [
        { strategy: 'fast', opts: { mode: 'fast', enableJit, enableAes, threads: threadsFast } },
        { strategy: 'light', opts: { mode: 'light', enableJit, enableAes, threads: 1 } }
    ];

    const failures = [];

    for (const { strategy, opts } of attempts) {
        try {
            const contextId = randomx.initContext(seed, opts);
            return { contextId, strategy };
        } catch (err) {
            failures.push(`${strategy}: ${err.message}`);
        }
    }

    throw new Error(`RandomX init failed for all strategies:\n  ${failures.join('\n  ')}`);
}

function demo() {
    const crypto = require('crypto');
    const seed = crypto.randomBytes(32);
    const input = Buffer.from('fallback example', 'utf8');

    console.log('Trying init with fallbacks (fast preferred → light)…\n');

    const { contextId, strategy } = initContextPreferFastWithFallback(seed);
    const meta = randomx.getContextInfo(contextId);

    console.log('Chosen strategy:', strategy);
    console.log('Memory:', describeBacking(meta), fellBack(meta) ? '(huge pages fell back)' : '');
    console.log('getContextInfo:', meta);

    const t0 = Date.now();
    const hash = randomx.hash(contextId, input);
    const ms = Date.now() - t0;
    console.log(`hash (${hash.length} bytes) in ${ms} ms (single sample; not a benchmark)`);

    randomx.releaseContext(contextId);
    console.log('\nDone.');
}

if (require.main === module) {
    demo();
}

module.exports = {
    initContextPreferFastWithFallback
};
