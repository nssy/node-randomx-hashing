/**
 * Example mining pool server using RandomX share verification.
 *
 * - createSeedPool (LRU) lets several seed_hash values coexist during an epoch change without
 *   unbounded RAM growth.
 * - Shares are hashed with powAsync on the libuv pool so the event loop never runs a RandomX hash
 *   or a dataset build (SeedPool#verifyShare does the same check synchronously).
 * - The variant comes from the job (`getVariant`), never from a global setting, so jobs
 *   issued before a fork keep verifying as rx/0 afterwards.
 * - Memory backing is logged per seed once it is built.
 * - This demo uses one generated seed. A live pool should call `protectSeedAsync(currentSeed)` on
 *   daemon template updates; do not infer current-seed identity from whichever share arrives.
 */

'use strict';

const crypto = require('crypto');
const os = require('os');
const randomx = require('../index');

const TWO_256 = 1n << 256n;

/** 32-byte little-endian value (a RandomX hash or commitment) as a BigInt. */
function fromLittleEndian(buffer) {
    return BigInt('0x' + (Buffer.from(buffer).reverse().toString('hex') || '0'));
}

/**
 * Difficulty a PoW value meets: floor(2^256 / pow), Monero's definition. A share is valid for
 * difficulty D when shareDifficulty >= D (equivalently pow * D < 2^256).
 */
function shareDifficulty(pow) {
    const value = fromLittleEndian(pow);
    return value === 0n ? TWO_256 : TWO_256 / value;
}

class MiningPool {
    constructor() {
        this.rxCache = randomx.createSeedPool({
            maxSeeds: 2,
            mode: process.argv.includes('--fast') ? 'fast' : 'light',
            vmPoolSize: Math.max(1, Math.floor(os.cpus().length / 4))
        });
        this.reportedSeeds = new Set();
        this.stats = { validShares: 0, invalidShares: 0 };

        console.log('Mining Pool Server initialized');
        this.logHardwareInfo();
    }

    logHardwareInfo() {
        const hw = randomx.getHardwareInfo();
        const caps = randomx.capabilities();
        console.log('Hardware Capabilities:');
        console.log(`- JIT Compilation: ${hw.hasJit ? '✓' : '✗'}`);
        console.log(`- AES Acceleration: ${hw.hasAes ? '✓' : '✗'}`);
        console.log(`- Huge pages: ${hw.hugePages.available} usable of ${hw.hugePages.total}, THP ${hw.transparentHugePages.enabled}`);
        console.log(`- CPU Cores: ${hw.cpuCores}`);
        console.log(`- Total Memory: ${(hw.totalMemory / 1024 / 1024 / 1024).toFixed(1)} GB`);
        console.log(`- Variants: ${caps.variants.join(', ')} (RandomX ${caps.randomx.slice(0, 12)})`);
        console.log('');
    }

    /** Log what a seed's memory ended up on, once per seed. */
    reportSeed(seedHex) {
        if (this.reportedSeeds.has(seedHex)) {
            return;
        }
        this.reportedSeeds.add(seedHex);
        const memory = this.rxCache.getMemoryInfo(Buffer.from(seedHex, 'hex'));
        console.log(`Seed ${seedHex.slice(0, 16)}… ready: dataset=${memory.dataset} cache=${memory.cache}` +
            ` scratchpads: hugetlb=${memory.scratchpad.hugetlb} normal=${memory.scratchpad.normal}`);
    }

    /**
     * Verify a share.
     * @param {string} minerAddress
     * @param {Buffer} hashingBlob job blob with the miner's nonce
     * @param {string} seedHex job seed_hash
     * @param {number} difficulty share difficulty
     * @param {Buffer} [minerResult] `result` from the submit: the hash (rx/0) or commitment (rx/2)
     */
    async verifyShare(minerAddress, hashingBlob, seedHex, difficulty, minerResult = null) {
        try {
            const variant = randomx.getVariant(hashingBlob);
            const seed = Buffer.from(seedHex, 'hex');
            await this.rxCache.warmSeedAsync(seed); // no-op once built; builds off the event loop
            this.reportSeed(seedHex);

            const started = process.hrtime.bigint();
            const { pow } = await this.rxCache.powAsync(seed, hashingBlob, { variant });
            const reached = shareDifficulty(pow);
            const matches = !minerResult || pow.equals(minerResult);
            const share = {
                miner: minerAddress,
                variant,
                difficulty,
                valid: matches && reached >= BigInt(difficulty),
                shareDifficulty: reached.toString(),
                verifyTime: Number(process.hrtime.bigint() - started) / 1e6
            };

            if (share.valid) {
                this.stats.validShares++;
            } else {
                this.stats.invalidShares++;
            }
            console.log(`${share.valid ? '✓' : '✗'} ${variant} share from ${minerAddress}` +
                ` (diff ${difficulty}, reached ${share.shareDifficulty}, ${share.verifyTime.toFixed(2)} ms)`);
            return share;
        } catch (error) {
            console.error(`Share verification failed: ${error.message}`);
            this.stats.invalidShares++;
            return { miner: minerAddress, valid: false, error: error.message };
        }
    }

    getStats() {
        return {
            pool: this.stats,
            randomx: randomx.getStats(),
            rxCache: this.rxCache.getSnapshot()
        };
    }

    shutdown() {
        console.log('Shutting down mining pool...');
        const finalStats = this.getStats();
        this.rxCache.releaseAll();
        console.log('Final Statistics:');
        console.log(`- Valid shares: ${finalStats.pool.validShares}`);
        console.log(`- Invalid shares: ${finalStats.pool.invalidShares}`);
        console.log(`- RandomX hashes: ${finalStats.randomx.totalHashes}`,
            `(rx/0 ${finalStats.randomx.variants['rx/0'].totalHashes}, rx/2 ${finalStats.randomx.variants['rx/2'].totalHashes})`);
        console.log(`- Average hash time: ${finalStats.randomx.averageHashTime.toFixed(3)} ms`);
        console.log('Pool server shutdown complete');
    }
}

async function runDemo() {
    const pool = new MiningPool();
    const seedHex = crypto.randomBytes(32).toString('hex');
    const miners = ['miner1', 'miner2', 'miner3'];

    console.log('Starting mining simulation (random nonces, so most shares miss the target)...\n');

    for (let i = 0; i < 20; i++) {
        const blob = crypto.randomBytes(76);
        blob[0] = i < 10 ? 16 : 17; // second half after the v17 fork: rx/2
        const difficulty = 2 ** (Math.floor(Math.random() * 4) + 1);
        await pool.verifyShare(miners[i % miners.length], blob, seedHex, difficulty);
    }

    console.log('\nSimulation complete!');
    console.log(JSON.stringify(pool.getStats().rxCache, null, 2));
    pool.shutdown();
}

if (require.main === module) {
    runDemo().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { MiningPool, shareDifficulty };
