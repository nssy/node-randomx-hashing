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
    console.log(`  - Huge pages: ${hwInfo.hugePages.available} of ${hwInfo.hugePages.total} usable` +
        ` (${hwInfo.hugePages.pageSizeKB} kB), THP ${hwInfo.transparentHugePages.enabled}`);

    const caps = randomx.capabilities();
    caps.randomx = caps.randomx || 'unknown';
    const expectedCommit = require('../package.json').randomx.commit;
    console.log(`✓ Variants: ${caps.variants.join(', ')}; RandomX ${caps.randomx.slice(0, 12)}`);
    if (caps.randomx !== expectedCommit) {
        throw new Error(`addon was built from RandomX ${caps.randomx.slice(0, 12)}, package.json pins ` +
            `${expectedCommit.slice(0, 12)}; rebuild with \`npm run build\``);
    }

    // Test context creation and hashing
    const contextId = randomx.initContext(testSeed, { enableJit: true, enableAes: true });
    const memory = randomx.getContextInfo(contextId).memory;
    console.log(`✓ Context created successfully (cache: ${memory.cache} pages)`);

    const testInput = Buffer.from('RandomX verification test', 'utf8');
    const hash = randomx.hash(contextId, testInput);
    const rx2 = randomx.pow(contextId, testInput, { variant: 'rx/2' });

    if (hash && hash.length === 32) {
        console.log('✓ Hash calculation successful');
        console.log(`  rx/0 hash: ${hash.toString('hex')}`);
        console.log(`  rx/2 hash: ${rx2.hash.toString('hex')}`);
        console.log(`  rx/2 pow (commitment): ${rx2.pow.toString('hex')}`);
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
    console.error('2. Try running: npm run clean && npm run build');
    console.error('3. Check that deps/randomx is present (it ships with the package as a git subtree)');
    console.error('4. Verify CMake is installed');
    process.exit(1);
}
