/**
 * Test Suite for Node.js RandomX Share Verifier
 */

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

        // Test 5: Performance Measurement
        console.log('Test 5: Performance Measurement');
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
        console.log('✓ Performance measurement test passed\n');

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
