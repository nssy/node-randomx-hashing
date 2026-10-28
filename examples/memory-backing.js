/**
 * Which memory a context actually got, and how to report it.
 *
 * Every buffer (dataset, cache, each VM scratchpad) walks the same ladder once, at allocation:
 *   1. reserved hugetlb pages  (enableHugePages: true, the default; needs free − reserved pages)
 *   2. transparent huge pages  (madvise before first touch; THP mode `always` or `madvise`)
 *   3. normal pages
 * `enableHugePages: 'thp'` skips step 1 (leaves the reserved pool to miners or monerod);
 * `false` uses normal pages only. The result is recorded once and never re-probed, so reading it
 * is free: log it at startup and after each seed change.
 *
 * Where to read it:
 *   getHardwareInfo().hugePages        host pool before you allocate (`available` = free − reserved)
 *   getContextInfo(id).memory          one context: { dataset, cache, scratchpad: { hugetlb, normal } }
 *   seedPool.getMemoryInfo(seed)       same, by seed
 *   seedPool.getSnapshot().seeds[]     every live seed, with VM counts per variant
 *   getStats().memory                  process-wide counts of live seeds per backing
 *
 * Fast mode frees the cache once the dataset is built, so `cache` is null there. Scratchpads are
 * 2 MiB each and are never THP-advised: they count as `hugetlb` or `normal`.
 *
 * Run:  node examples/memory-backing.js [--fast]
 */

'use strict';

const crypto = require('crypto');
const os = require('os');
const randomx = require('../index');

const DATASET_PAGES_2M = 1040; // ~2080 MiB dataset in 2 MiB pages
const CACHE_PAGES_2M = 128; // 256 MiB cache

/** Pages a context needs for hugetlb backing, to compare with getHardwareInfo().hugePages.available. */
function hugePagesNeeded(mode, vmsPerVariant, variants = 1) {
    const buffers = mode === 'fast' ? DATASET_PAGES_2M : CACHE_PAGES_2M;
    return buffers + vmsPerVariant * variants; // one 2 MiB scratchpad page per VM
}

/**
 * One-line summary for logs, e.g. "fast dataset=hugetlb scratchpads: hugetlb=17 normal=0".
 * @param {{ mode: string, memory: object }} info getContextInfo() result
 */
function describeBacking(info) {
    const m = info.memory;
    const buffers = info.mode === 'fast' ? `dataset=${m.dataset}` : `cache=${m.cache}`;
    return `${info.mode} ${buffers} scratchpads: hugetlb=${m.scratchpad.hugetlb} normal=${m.scratchpad.normal}`;
}

/**
 * True when you asked for huge pages but some buffer fell back. Measured on a Zen 2 host in fast
 * mode: ~1.5 ms/hash with reserved or transparent huge pages, ~1.73 ms on normal pages. A dataset
 * on normal pages is worth a warning.
 */
function fellBack(info) {
    if (info.hugePages === 'off') {
        return false;
    }
    const m = info.memory;
    const main = info.mode === 'fast' ? m.dataset : m.cache;
    const wantReserved = info.hugePages === 'all';
    return main === 'normal' || (wantReserved && (main !== 'hugetlb' || m.scratchpad.normal > 0));
}

async function demo() {
    const mode = process.argv.includes('--fast') ? 'fast' : 'light';
    const hw = randomx.getHardwareInfo();
    console.log('Host huge pages:', hw.hugePages, 'THP:', hw.transparentHugePages);
    console.log(`A ${mode} seed with 4 VMs per variant needs ${hugePagesNeeded(mode, 4, 2)} reserved 2 MiB pages\n`);

    const seed = crypto.randomBytes(32);
    const input = Buffer.from('memory backing example');

    for (const enableHugePages of [true, 'thp', false]) {
        const pool = randomx.createPoolSeedPool({
            mode,
            enableHugePages,
            vmPoolSize: 4,
            threads: Math.max(1, Math.floor(os.cpus().length / 2))
        });
        await pool.warmSeedAsync(seed);
        await pool.hashAsync(seed, input, { variant: 'rx/2' }); // lazily adds an rx/2 VM

        const info = randomx.getContextInfo(pool.getContext(seed));
        console.log(`enableHugePages=${JSON.stringify(enableHugePages).padEnd(6)} → ${describeBacking(info)}` +
            (fellBack(info) ? '  (fell back)' : ''));
        console.log('  getMemoryInfo:', JSON.stringify(pool.getMemoryInfo(seed)), ' vms:', JSON.stringify(info.vms));
        console.log('  getStats().memory:', JSON.stringify(randomx.getStats().memory));
        pool.releaseAll();
    }
}

if (require.main === module) {
    demo().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { hugePagesNeeded, describeBacking, fellBack };
