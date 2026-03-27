/**
 * Prefer RandomX fast mode (full dataset), but fall back when init fails:
 *   1) fast + large/huge pages (best throughput if allocation succeeds)
 *   2) fast without large pages (still ~1–2 ms/hash, normal RAM)
 *   3) light (~256 MB cache only, slower per hash)
 *
 * Use this pattern when `enableHugePages: true` may fail (no hugetlb, ulimit, etc.)
 * or when fast mode OOMs on small hosts.
 */

const os = require('os');
const randomx = require('../index');

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
        {
            strategy: 'fast+hugepages',
            opts: {
                mode: 'fast',
                enableHugePages: true,
                enableJit,
                enableAes,
                threads: threadsFast
            }
        },
        {
            strategy: 'fast',
            opts: {
                mode: 'fast',
                enableHugePages: false,
                enableJit,
                enableAes,
                threads: threadsFast
            }
        },
        {
            strategy: 'light',
            opts: {
                mode: 'light',
                enableHugePages: false,
                enableJit,
                enableAes,
                threads: 1
            }
        }
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
