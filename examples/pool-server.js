/**
 * Example mining pool server using RandomX share verification
 * Uses createSeedPool (LRU) so multiple seed_hash values can coexist
 * during fork transitions without unbounded RAM growth.
 */

const os = require('os');
const randomx = require('../index');
const crypto = require('crypto');

class MiningPool {
    constructor() {
        this.rxCache = randomx.createSeedPool({
            maxSeeds: 2,
            mode: 'fast',
            threads: Math.max(1, os.cpus().length),
            enableHugePages: false
        });

        this.shares = [];
        this.stats = {
            validShares: 0,
            invalidShares: 0,
            totalHashrate: 0
        };

        console.log('Mining Pool Server initialized');
        this.logHardwareInfo();
    }

    logHardwareInfo() {
        const hwInfo = randomx.getHardwareInfo();
        console.log('Hardware Capabilities:');
        console.log(`- JIT Compilation: ${hwInfo.hasJit ? '✓' : '✗'}`);
        console.log(`- AES Acceleration: ${hwInfo.hasAes ? '✓' : '✗'}`);
        console.log(`- Large Pages: ${hwInfo.hasHugePages ? '✓' : '✗'}`);
        console.log(`- CPU Cores: ${hwInfo.cpuCores}`);
        console.log(`- Total Memory: ${(hwInfo.totalMemory / 1024 / 1024 / 1024).toFixed(1)} GB`);
        console.log('');
    }

    /**
     * Verify a mining share
     */
    verifyShare(minerAddress, jobId, nonce, seedHex, difficulty) {
        try {
            const shareData = Buffer.concat([
                Buffer.from(jobId, 'hex'),
                Buffer.from(minerAddress, 'utf8'),
                Buffer.from(nonce.toString(16).padStart(8, '0'), 'hex')
            ]);

            const target = this.difficultyToTarget(difficulty);

            const startTime = Date.now();
            const result = this.rxCache.verifyShareFromHex(seedHex, shareData, target);
            const verifyTime = Date.now() - startTime;

            const shareInfo = {
                miner: minerAddress,
                jobId: jobId.substring(0, 8),
                nonce: nonce,
                difficulty: difficulty,
                valid: result.valid,
                hash: result.hash.toString('hex'),
                verifyTime: verifyTime
            };

            this.shares.push(shareInfo);

            if (result.valid) {
                this.stats.validShares++;
                console.log(`✓ Valid share from ${minerAddress} (diff: ${difficulty}, time: ${verifyTime}ms)`);
            } else {
                this.stats.invalidShares++;
                console.log(`✗ Invalid share from ${minerAddress} (diff: ${difficulty}, time: ${verifyTime}ms)`);
            }

            return shareInfo;
        } catch (error) {
            console.error(`Share verification failed: ${error.message}`);
            this.stats.invalidShares++;
            return {
                miner: minerAddress,
                valid: false,
                error: error.message
            };
        }
    }

    difficultyToTarget(difficulty) {
        const target = Buffer.alloc(32, 0xff);

        if (difficulty > 1) {
            const leadingZeros = Math.floor(Math.log2(difficulty) / 8);
            for (let i = 0; i < Math.min(leadingZeros, 31); i++) {
                target[31 - i] = 0x00;
            }

            if (leadingZeros < 31) {
                target[31 - leadingZeros] = Math.floor(0xff / (difficulty / Math.pow(2, leadingZeros * 8)));
            }
        }

        return target;
    }

    getStats() {
        const randomxStats = randomx.getStats();

        return {
            pool: this.stats,
            randomx: randomxStats,
            rxCache: this.rxCache.getSnapshot()
        };
    }

    shutdown() {
        console.log('Shutting down mining pool...');

        this.rxCache.releaseAll();

        const finalStats = this.getStats();
        console.log('Final Statistics:');
        console.log(`- Valid shares: ${finalStats.pool.validShares}`);
        console.log(`- Invalid shares: ${finalStats.pool.invalidShares}`);
        console.log(`- Total RandomX hashes: ${finalStats.randomx.totalHashes}`);
        console.log(`- Average hash time (see note in getStats): ${finalStats.randomx.averageHashTime.toFixed(3)}`);

        console.log('Pool server shutdown complete');
    }
}

function runDemo() {
    const pool = new MiningPool();

    const seedHex = crypto.randomBytes(32).toString('hex');
    const miners = ['miner1', 'miner2', 'miner3'];

    console.log('Starting mining simulation...\n');

    let shareCount = 0;
    const submitShare = () => {
        const miner = miners[Math.floor(Math.random() * miners.length)];
        const jobId = crypto.randomBytes(16).toString('hex');
        const nonce = Math.floor(Math.random() * 0xffffffff);
        const difficulty = Math.pow(2, Math.floor(Math.random() * 10) + 10);

        pool.verifyShare(miner, jobId, nonce, seedHex, difficulty);
        shareCount++;

        if (shareCount < 20) {
            setTimeout(submitShare, 100 + Math.random() * 200);
        } else {
            setTimeout(() => {
                console.log('\nSimulation complete!');
                console.log('\nFinal Pool Statistics:');
                console.log(JSON.stringify(pool.getStats(), null, 2));

                pool.shutdown();
            }, 1000);
        }
    };

    submitShare();
}

if (require.main === module) {
    runDemo();
}

module.exports = MiningPool;
