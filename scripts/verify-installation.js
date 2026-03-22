/**
 * Installation Verification Script
 * Verifies that the RandomX addon was built correctly
 */

console.log('Verifying RandomX installation...\n');

try {
    const randomx = require('../index.js');

    // Test basic functionality
    const testSeed = Buffer.alloc(32, 0x42);
    console.log('✓ Module loaded successfully');

    // Check hardware capabilities
    const hwInfo = randomx.getHardwareInfo();
    console.log('Hardware Capabilities:');
    console.log(`  - JIT Compilation: ${hwInfo.hasJit ? '✓' : '✗'}`);
    console.log(`  - AES Acceleration: ${hwInfo.hasAes ? '✓' : '✗'}`);
    console.log(`  - Large Pages: ${hwInfo.hasHugePages ? '✓' : '✗'}`);
    console.log(`  - CPU Cores: ${hwInfo.cpuCores}`);
    console.log(`  - Total Memory: ${(hwInfo.totalMemory / 1024 / 1024 / 1024).toFixed(1)} GB`);

    // Test context creation and hashing
    const contextId = randomx.initContext(testSeed, {
        enableJit: true,
        enableAes: true,
        enableHugePages: false // Safe default
    });
    console.log('✓ Context created successfully');

    const testInput = Buffer.from('RandomX verification test', 'utf8');
    const hash = randomx.hash(contextId, testInput);

    if (hash && hash.length === 32) {
        console.log('✓ Hash calculation successful');
        console.log(`  Hash: ${hash.toString('hex')}`);
    } else {
        throw new Error('Hash calculation returned invalid result');
    }

    // Test share verification
    const target = Buffer.alloc(32, 0xff); // Very easy target
    const result = randomx.verifyShare(contextId, testInput, target);

    if (typeof result === 'object' && typeof result.valid === 'boolean') {
        console.log('✓ Share verification working');
        console.log(`  Valid: ${result.valid}`);
        console.log(`  Difficulty: ${result.difficulty.toExponential(2)}`);
        console.log(`  Hash time: ${result.hashTime.toFixed(3)}ms`);
    } else {
        throw new Error('Share verification returned invalid result');
    }

    // Cleanup
    randomx.releaseContext(contextId);
    console.log('✓ Context cleanup successful');

    console.log('\n🎉 Installation verification completed successfully!');
    console.log('RandomX share verifier is ready for use.\n');

} catch (error) {
    console.error('❌ Installation verification failed:');
    console.error(error.message);
    console.error('\nTroubleshooting:');
    console.error('1. Ensure all build dependencies are installed');
    console.error('2. Try running: npm run clean && npm install');
    console.error('3. Check that git is available for downloading RandomX');
    console.error('4. Verify CMake is installed if using manual build');
    process.exit(1);
}
