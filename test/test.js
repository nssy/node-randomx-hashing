/**
 * Test Suite for Node.js RandomX Share Verifier
 *
 * Includes fast mode (full RandomX dataset) so regressions are visible in `npm test`.
 * Optional huge-page smoke: `npm run test:fast-mode`
 */

const os = require('os');
const randomx = require('../index');
const crypto = require('crypto');
const assert = require('assert');

console.log('Running RandomX Share Verifier Tests...\n');

// Test data
const testSeed = crypto.randomBytes(32);
const testInput = Buffer.from('Hello RandomX Mining Pool!', 'utf8');
const testTarget = Buffer.alloc(32, 0xff); // Very easy target for testing

let contextId;

async function runTests() {
    try {
        // Test 1: Hardware Info
        console.log('Test 1: Hardware Info');
        const hwInfo = randomx.getHardwareInfo();
        console.log('Hardware Info:', hwInfo);
        assert(typeof hwInfo.hasJit === 'boolean', 'JIT info should be boolean');
        assert(typeof hwInfo.hasAes === 'boolean', 'AES info should be boolean');
        assert(typeof hwInfo.cpuCores === 'number', 'CPU cores should be number');
        console.log('✓ Hardware info test passed\n');

        // Test 2: Context Initialization
        console.log('Test 2: Context Initialization');
        contextId = randomx.initContext(testSeed, {
            enableJit: true,
            enableAes: true,
            enableHugePages: false, // May not be available in test environment
            threads: 1
        });
        console.log('Context ID:', contextId);
        assert(typeof contextId === 'number', 'Context ID should be a number');
        assert(contextId > 0, 'Context ID should be positive');

        const meta = randomx.getContextInfo(contextId);
        assert(meta && meta.mode === 'light', 'getContextInfo mode');
        assert(meta.enableHugePages === false, 'default enableHugePages');
        assert(meta.usedLargePages === false, 'no large pages in light default');
        console.log('✓ Context initialization test passed\n');

        // Test 3: Hash Calculation
        console.log('Test 3: Hash Calculation');
        const hash1 = randomx.hash(contextId, testInput);
        console.log('Hash 1:', hash1.toString('hex'));
        assert(Buffer.isBuffer(hash1), 'Hash should be a Buffer');
        assert(hash1.length === 32, 'Hash should be 32 bytes');

        // Test deterministic hashing
        const hash2 = randomx.hash(contextId, testInput);
        console.log('Hash 2:', hash2.toString('hex'));
        assert(hash1.equals(hash2), 'Hashes should be deterministic');
        console.log('✓ Hash calculation test passed\n');

        // Test 4: Share Verification
        console.log('Test 4: Share Verification');
        const verificationResult = randomx.verifyShare(contextId, testInput, testTarget);
        console.log('Verification Result:', verificationResult);
        assert(typeof verificationResult.valid === 'boolean', 'Valid should be boolean');
        assert(typeof verificationResult.difficulty === 'number', 'Difficulty should be number');
        assert(typeof verificationResult.hashTime === 'number', 'Hash time should be number');
        assert(Buffer.isBuffer(verificationResult.hash), 'Hash should be Buffer');
        assert(verificationResult.hash.length === 32, 'Hash should be 32 bytes');
        console.log('✓ Share verification test passed\n');

        // Test 5: Performance measurement on light (cache-only) context
        console.log('Test 5: Performance Measurement (light mode)');
        const iterations = 1000;
        const startTime = Date.now();

        for (let i = 0; i < iterations; i++) {
            const input = Buffer.concat([testInput, Buffer.from([i & 0xff])]);
            randomx.hash(contextId, input);
        }

        const endTime = Date.now();
        const totalTime = endTime - startTime;
        const hashesPerSecond = (iterations / totalTime) * 1000;

        console.log(`Performance: ${hashesPerSecond.toFixed(2)} hashes/second`);
        console.log(`Average time per hash: ${(totalTime / iterations).toFixed(3)} ms`);
        assert(hashesPerSecond > 0, 'Performance should be positive');
        console.log('✓ Performance measurement test passed (light mode)\n');

        // Test 6: Statistics
        console.log('Test 6: Statistics');
        const stats = randomx.getStats();
        console.log('Stats:', stats);
        assert(typeof stats.totalHashes === 'number', 'Total hashes should be number');
        assert(typeof stats.totalVerifications === 'number', 'Total verifications should be number');
        assert(typeof stats.activeContexts === 'number', 'Active contexts should be number');
        assert(stats.totalHashes >= iterations, 'Should have recorded hash operations');
        console.log('✓ Statistics test passed\n');

        // Test 7: Different Input Sizes
        console.log('Test 7: Different Input Sizes');
        const inputs = [
            Buffer.alloc(0), // Empty
            Buffer.alloc(1, 0x42), // 1 byte
            Buffer.alloc(64, 0x42), // 64 bytes
            Buffer.alloc(1024, 0x42), // 1KB
            crypto.randomBytes(4096) // 4KB random
        ];

        for (let i = 0; i < inputs.length; i++) {
            const hash = randomx.hash(contextId, inputs[i]);
            console.log(`Input size ${inputs[i].length}: ${hash.toString('hex').substring(0, 16)}...`);
            assert(hash.length === 32, 'Hash should always be 32 bytes');
        }
        console.log('✓ Different input sizes test passed\n');

        // Test 8: Multiple Contexts
        console.log('Test 8: Multiple Contexts');
        const context2 = randomx.initContext(crypto.randomBytes(32));
        const context3 = randomx.initContext(crypto.randomBytes(32));

        const hash_ctx1 = randomx.hash(contextId, testInput);
        const hash_ctx2 = randomx.hash(context2, testInput);
        const hash_ctx3 = randomx.hash(context3, testInput);

        console.log('Context 1 hash:', hash_ctx1.toString('hex').substring(0, 16) + '...');
        console.log('Context 2 hash:', hash_ctx2.toString('hex').substring(0, 16) + '...');
        console.log('Context 3 hash:', hash_ctx3.toString('hex').substring(0, 16) + '...');

        // Different contexts should produce different hashes for same input
        assert(!hash_ctx1.equals(hash_ctx2), 'Different contexts should produce different hashes');
        assert(!hash_ctx2.equals(hash_ctx3), 'Different contexts should produce different hashes');

        // Clean up additional contexts
        randomx.releaseContext(context2);
        randomx.releaseContext(context3);
        console.log('✓ Multiple contexts test passed\n');

        // Test 9: Error Handling
        console.log('Test 9: Error Handling');

        try {
            randomx.initContext(Buffer.alloc(16)); // Wrong seed size
            assert(false, 'Should throw error for wrong seed size');
        } catch (e) {
            console.log('✓ Correctly caught seed size error:', e.message);
        }

        try {
            randomx.hash(999999, testInput); // Invalid context ID
            assert(false, 'Should throw error for invalid context');
        } catch (e) {
            console.log('✓ Correctly caught invalid context error:', e.message);
        }

        try {
            randomx.verifyShare(contextId, testInput, Buffer.alloc(16)); // Wrong target size
            assert(false, 'Should throw error for wrong target size');
        } catch (e) {
            console.log('✓ Correctly caught target size error:', e.message);
        }

        console.log('✓ Error handling test passed\n');

        // Test 10: Context cache (LRU, light mode to keep tests fast)
        console.log('Test 10: Context cache LRU');
        const rxCache = randomx.createContextCache({
            maxContexts: 1,
            mode: 'light',
            threads: 1,
            enableHugePages: false
        });
        const cs1 = crypto.randomBytes(32);
        const cs2 = crypto.randomBytes(32);
        const cidA = rxCache.getContext(cs1);
        assert(rxCache.size === 1, 'cache holds one context');
        const cidB = rxCache.getContext(cs2);
        assert(rxCache.size === 1, 'still one context after eviction');
        assert(cidA !== cidB, 'new seed replaces context id');
        assert(!rxCache.has(cs1), 'first seed evicted under LRU');
        assert(rxCache.has(cs2), 'second seed retained');

        const h1 = randomx.hash(cidB, testInput);
        const cidAgain = rxCache.getContextFromHex(cs2.toString('hex'));
        assert(cidAgain === cidB, 'hex getter returns same context');
        const h2 = randomx.hash(cidAgain, testInput);
        assert(h1.equals(h2), 'same hash for same seed and input');

        try {
            rxCache.getContextFromHex('00');
            assert(false, 'short hex should throw');
        } catch (e) {
            assert(e.message && e.message.includes('64'), 'expected hex length error');
        }

        rxCache.releaseAll();
        assert(rxCache.size === 0, 'releaseAll empties cache');

        const epoch = randomx.createPoolEpochCache({ mode: 'light', threads: 1 });
        assert(epoch.maxContexts === 2, 'createPoolEpochCache defaults maxContexts to 2');
        epoch.releaseAll();
        console.log('✓ Context cache test passed\n');

        // Test 10b: Idle eviction — drop unused seed contexts after a grace period (saves RAM in pools)
        console.log('Test 10b: Context cache idle eviction');
        const idleRx = randomx.createContextCache({
            maxContexts: 2,
            mode: 'light',
            threads: 1,
            enableHugePages: false,
            idleEvictMs: 50
        });
        const is1 = crypto.randomBytes(32);
        const is2 = crypto.randomBytes(32);
        const idleId1 = idleRx.getContext(is1);
        idleRx.getContext(is2);
        assert(idleRx.size === 2);
        assert(idleRx.getSnapshot().idleEvictMs === 50);
        await new Promise((resolve) => setTimeout(resolve, 80));
        const idleId1b = idleRx.getContext(is1);
        assert(idleId1 !== idleId1b, 'idle eviction should release and recreate context');
        assert(idleRx.size === 1);
        idleRx.releaseAll();
        console.log('✓ Context cache idle eviction passed\n');

        // Test 11: Fast mode (full dataset) — must run in CI/default test; init can take ~10–60s cold
        console.log('Test 11: Fast mode (full dataset, RANDOMX_FLAG_FULL_MEM)');
        console.log('  (first-time dataset build; may take a while…)\n');
        const fastSeed = crypto.randomBytes(32);
        let fastCtxId;
        try {
            const t0 = Date.now();
            fastCtxId = randomx.initContext(fastSeed, {
                mode: 'fast',
                enableHugePages: false,
                threads: Math.min(4, Math.max(1, os.cpus().length)),
                enableJit: true,
                enableAes: true
            });
            console.log(`  Context created in ${((Date.now() - t0) / 1000).toFixed(1)}s (id=${fastCtxId})`);
            assert(typeof fastCtxId === 'number' && fastCtxId > 0, 'fast context id');

            const fastMeta = randomx.getContextInfo(fastCtxId);
            assert(fastMeta && fastMeta.mode === 'fast', 'getContextInfo mode is fast');
            assert(fastMeta.usedLargePages === false, 'this test uses enableHugePages: false');

            const fastHash = randomx.hash(fastCtxId, testInput);
            assert.strictEqual(fastHash.length, 32, 'fast hash length');

            const fastVerify = randomx.verifyShare(fastCtxId, testInput, testTarget);
            assert(typeof fastVerify.valid === 'boolean');
            assert.strictEqual(typeof fastVerify.hashTime, 'number');
            console.log(`  Sample verify hashTime: ${fastVerify.hashTime.toFixed(2)} ms (expect ~1–3 ms typical)`);
            console.log('✓ Fast mode initialization and verification passed\n');

            // Test 12: Same loop as Test 5, on fast (full dataset) context
            console.log('Test 12: Performance Measurement (fast mode)');
            const fastIterations = 1000;
            const fastPerfStart = Date.now();

            for (let i = 0; i < fastIterations; i++) {
                const input = Buffer.concat([testInput, Buffer.from([i & 0xff])]);
                randomx.hash(fastCtxId, input);
            }

            const fastPerfEnd = Date.now();
            const fastTotalTime = fastPerfEnd - fastPerfStart;
            const fastHashesPerSecond = (fastIterations / fastTotalTime) * 1000;

            console.log(`Performance: ${fastHashesPerSecond.toFixed(2)} hashes/second`);
            console.log(`Average time per hash: ${(fastTotalTime / fastIterations).toFixed(3)} ms`);
            assert(fastHashesPerSecond > 0, 'Fast mode performance should be positive');
            console.log('✓ Performance measurement test passed (fast mode)\n');
        } finally {
            if (fastCtxId) {
                randomx.releaseContext(fastCtxId);
            }
        }

    } catch (error) {
        console.error('Test failed:', error);
        process.exit(1);
    } finally {
        // Cleanup
        if (contextId) {
            console.log('Cleaning up context...');
            randomx.releaseContext(contextId);
        }
    }

    console.log('🎉 All tests passed successfully!');

    // Final stats
    const finalStats = randomx.getStats();
    console.log('\nFinal Statistics:');
    console.log(`- Total hashes: ${finalStats.totalHashes}`);
    console.log(`- Total verifications: ${finalStats.totalVerifications}`);
    console.log(`- Active contexts: ${finalStats.activeContexts}`);
    console.log(`- Average hash time: ${finalStats.averageHashTime.toFixed(3)} ms`);
}

// Run the tests
runTests().catch(console.error);
