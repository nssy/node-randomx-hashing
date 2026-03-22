/**
 * RandomX Download Script
 * Automatically downloads and prepares RandomX for building
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RANDOMX_VERSION = 'v1.2.1';
const PROJECT_ROOT = path.join(__dirname, '..');
const DEPS_DIR = path.join(PROJECT_ROOT, 'deps');
const RANDOMX_DIR = path.join(DEPS_DIR, 'randomx');

console.log('Downloading and setting up RandomX...');

// Create deps directory
if (!fs.existsSync(DEPS_DIR)) {
    fs.mkdirSync(DEPS_DIR, { recursive: true });
}

// Check if RandomX already exists and is valid
if (fs.existsSync(path.join(RANDOMX_DIR, 'CMakeLists.txt'))) {
    console.log('RandomX already exists, skipping download');
    process.exit(0);
}

// Remove any incomplete download
if (fs.existsSync(RANDOMX_DIR)) {
    fs.rmSync(RANDOMX_DIR, { recursive: true, force: true });
}

try {
    // Check if git is available
    execSync('git --version', { stdio: 'ignore' });

    // Clone RandomX
    console.log(`Cloning RandomX ${RANDOMX_VERSION}...`);
    execSync(`git clone --depth 1 --branch ${RANDOMX_VERSION} https://github.com/tevador/RandomX.git randomx`, {
        cwd: DEPS_DIR,
        stdio: 'inherit'
    });

    // Verify download was successful
    if (!fs.existsSync(path.join(RANDOMX_DIR, 'CMakeLists.txt'))) {
        throw new Error('RandomX download verification failed');
    }

    console.log('✓ RandomX downloaded successfully');

} catch (error) {
    console.error('Failed to download RandomX:', error.message);
    console.error('\nPlease ensure:');
    console.error('1. Git is installed and available in PATH');
    console.error('2. Internet connection is available');
    console.error('3. No firewall blocking git clone');
    process.exit(1);
}
