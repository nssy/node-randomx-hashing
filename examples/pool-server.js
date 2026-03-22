/**
 * Example Mining Pool Server using RandomX Share Verifier
 * Demonstrates context management and share verification
 */

const randomx = require('../index');
const crypto = require('crypto');

class MiningPool {
    constructor() {
        this.contexts = new Map();
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
     * Get or create RandomX context for given seed
     */
    getContext(seedHex) {
        if (!this.contexts.has(seedHex)) {
            console.log(`Creating new RandomX context for seed: ${seedHex.substring(0, 16)}...`);

            const seed = Buffer.from(seedHex, 'hex');
            const contextId = randomx.initContext(seed, {
                enableJit: true,
                enableAes: true,
                enableHugePages: true,
                threads: 1 // Single-threaded for consistent pool behavior
            });

            this.contexts.set(seedHex, {
                id: contextId,
                created: Date.now(),
                uses: 0
            });

            console.log(`Context ${contextId} created successfully`);
        }

        return this.contexts.get(seedHex);
    }

    /**
     * Verify a mining share
     */
    verifyShare(minerAddress, jobId, nonce, seedHex, difficulty) {
        try {
            // Get context for this seed
            const context = this.getContext(seedHex);
            context.uses++;

            // Construct share data (simplified example)
            const shareData = Buffer.concat([
                Buffer.from(jobId, 'hex'),
                Buffer.from(minerAddress, 'utf8'),
                Buffer.from(nonce.toString(16).padStart(8, '0'), 'hex')
            ]);

            // Convert difficulty to target
            const target = this.difficultyToTarget(difficulty);

            // Verify the share
            const startTime = Date.now();
            const result = randomx.verifyShare(context.id, shareData, target);
            const verifyTime = Date.now() - startTime;

            // Log the result
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

    /**
     * Convert difficulty number to 32-byte target
     */
    difficultyToTarget(difficulty) {
        // Simplified difficulty to target conversion
        // In real pools, this would be more sophisticated
        const target = Buffer.alloc(32, 0xff);

        if (difficulty > 1) {
            const leadingZeros = Math.floor(Math.log2(difficulty) / 8);
            for (let i = 0; i < Math.min(leadingZeros, 31); i++) {
                target[i] = 0x00;
            }

            if (leadingZeros < 31) {
                target[leadingZeros] = Math.floor(0xff / (difficulty / Math.pow(2, leadingZeros * 8)));
            }
        }

        return target;
    }

    /**
     * Get pool statistics
     */
    getStats() {
        const randomxStats = randomx.getStats();

        return {
            pool: this.stats,
            randomx: randomxStats,
            contexts: {
                total: this.contexts.size,
                details: Array.from(this.contexts.entries()).map(([seed, ctx]) => ({
                    seed: seed.substring(0, 16) + '...',
                    uses: ctx.uses,
                    age: Date.now() - ctx.created
                }))
            }
        };
    }

    /**
     * Cleanup old contexts
     */
    cleanupContexts(maxAge = 5 * 60 * 1000) { // 5 minutes
        const now = Date.now();
        const toRemove = [];

        for (const [seed, context] of this.contexts.entries()) {
            if (now - context.created > maxAge) {
                toRemove.push(seed);
            }
        }

        for (const seed of toRemove) {
            const context = this.contexts.get(seed);
            randomx.releaseContext(context.id);
            this.contexts.delete(seed);
            console.log(`Cleaned up context for seed: ${seed.substring(0, 16)}...`);
        }

        return toRemove.length;
    }

    /**
     * Shutdown the pool server
     */
    shutdown() {
        console.log('Shutting down mining pool...');

        // Release all contexts
        for (const [seed, context] of this.contexts.entries()) {
            randomx.releaseContext(context.id);
            console.log(`Released context ${context.id}`);
        }

        this.contexts.clear();

        // Log final stats
        const finalStats = this.getStats();
        console.log('Final Statistics:');
        console.log(`- Valid shares: ${finalStats.pool.validShares}`);
        console.log(`- Invalid shares: ${finalStats.pool.invalidShares}`);
        console.log(`- Total RandomX hashes: ${finalStats.randomx.totalHashes}`);
        console.log(`- Average hash time: ${finalStats.randomx.averageHashTime.toFixed(3)}ms`);

        console.log('Pool server shutdown complete');
    }
}

// Demo usage
function runDemo() {
    const pool = new MiningPool();

    // Simulate some mining activity
    const seedHex = crypto.randomBytes(32).toString('hex');
    const miners = ['miner1', 'miner2', 'miner3'];

    console.log('Starting mining simulation...\n');

    // Simulate share submissions
    let shareCount = 0;
    const submitShare = () => {
        const miner = miners[Math.floor(Math.random() * miners.length)];
        const jobId = crypto.randomBytes(16).toString('hex');
        const nonce = Math.floor(Math.random() * 0xffffffff);
        const difficulty = Math.pow(2, Math.floor(Math.random() * 10) + 10); // Random difficulty

        pool.verifyShare(miner, jobId, nonce, seedHex, difficulty);
        shareCount++;

        if (shareCount < 20) {
            setTimeout(submitShare, 100 + Math.random() * 200);
        } else {
            // End simulation
            setTimeout(() => {
                console.log('\nSimulation complete!');
                console.log('\nFinal Pool Statistics:');
                console.log(JSON.stringify(pool.getStats(), null, 2));

                pool.shutdown();
            }, 1000);
        }
    };

    // Start submitting shares
    submitShare();

    // Periodic cleanup
    const cleanupInterval = setInterval(() => {
        const cleaned = pool.cleanupContexts();
        if (cleaned > 0) {
            console.log(`Cleaned up ${cleaned} old contexts`);
        }
    }, 10000);

    // Stop cleanup when simulation ends
    setTimeout(() => {
        clearInterval(cleanupInterval);
    }, 25000);
}

// Run the demo if this file is executed directly
if (require.main === module) {
    runDemo();
}

module.exports = MiningPool;
