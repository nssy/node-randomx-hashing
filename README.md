# Node.js RandomX Share Verifier

A high-performance N-API addon for RandomX hashing and share verification in Node.js mining pools.

The primary API is now a `SeedPool`:
- one shared RandomX cache/dataset per seed
- a small VM pool per seed for concurrency
- direct `hashAsync(seed, input)` / `verifyShare(seed, ...)` calls

That maps much better to real pool workloads than making application code manage raw context ids.

## Features

- **Native Performance**: N-API addon with JIT compilation and AES acceleration
- **Shared Seed Resources**: One RandomX cache/dataset per seed, reused across multiple VMs
- **VM Pooling**: Multiple VMs can share the same seed resources for concurrent pool workloads
- **Pool Broker Friendly**: Works well behind a local socket broker shared by many pool workers
- **Pool-Ready**: Designed specifically for mining pool server workloads
- **Cross-Platform**: Supports Linux, Windows, and macOS
- **Vendored RandomX Source**: Builds from pinned local RandomX source in `deps/randomx`

## Performance

- **JIT Compilation**: Near-native speed RandomX execution
- **AES Hardware**: Hardware-accelerated AES when available
- **Memory Optimization**: Shared seed resources and optional large pages
- **Seed Reuse**: Current/previous `seed_hash` values stay warm without rebuilding full datasets
- **Async Hashing**: `hashAsync()` lets Node brokers overlap requests without blocking the event loop

## Installation

### Prerequisites

```bash
# Ubuntu/Debian
sudo apt-get install build-essential cmake git

# CentOS/RHEL
sudo yum groupinstall "Development Tools"
sudo yum install cmake git

# macOS
brew install cmake git
```

### Install from npm 

```bash
npm install "git+https://github.com/nssy/node-randomx-hashing.git"
```

### Build from Source

```bash
git clone https://github.com/nssy/node-randomx-hashing.git
cd node-randomx-hashing

# Build the addon
npm install
```

**That's it!** The build system:
- verifies `deps/randomx` exists
- configures and builds RandomX from local source
- compiles the N-API addon
- links everything together

## Quick Start

```javascript
const randomx = require('node-randomx-hashing');

// Primary API: a seed pool for current + previous seed_hash
const pool = randomx.createPoolSeedPool({
    maxSeeds: 2,
    vmPoolSize: 2,
    mode: 'fast',           // explicit: fast is never implied by magic
    threads: 4,             // dataset init threads
    enableHugePages: false
});

const seed = Buffer.alloc(32, 1);
const input = Buffer.from('mining-share-data');
const target = Buffer.alloc(32, 0xff);

await pool.warmSeedAsync(seed);
const result = pool.verifyShare(seed, input, target);
console.log('Share valid:', result.valid);
console.log('Hash time:', result.hashTime, 'ms');

// Async hashing, useful for broker/server patterns
const hash = await pool.hashAsync(seed, input);
console.log('Hash:', hash.toString('hex'));

// Clean up when done
pool.releaseAll();
```

## API Reference

### `initContext(seed, options)`

Low-level API. Initialize a single RandomX VM context for a seed.

For pool workloads, prefer `createSeedPool()` / `createPoolSeedPool()`.

**Parameters:**
- `seed` (Buffer): 32-byte RandomX seed
- `options` (Object): Configuration options
  - `mode` (string): `"light"` or `"fast"` (default: `"light"`)
  - `enableJit` (boolean): Enable JIT compilation (default: true)
  - `enableAes` (boolean): Enable AES acceleration (default: true)
  - `enableHugePages` (boolean): Enable large pages (default: false)
  - `threads` (number): Initialization threads (default: 1)

**Returns:** Context ID (number)

### `initContextAsync(seed, options)`

Low-level async API. Initialize a single RandomX VM context for a seed on libuv's worker pool.

For pool workloads, prefer `createSeedPool()` / `createPoolSeedPool()`.

**Parameters:**
- `seed` (Buffer): 32-byte RandomX seed
- `options` (Object): same options as `initContext`

**Returns:** `Promise<number>`

### `createSeedPool(options)`

Primary high-level API for pools and brokers.

**Parameters:**
- `options.maxSeeds` (number, default `2`): how many different seeds to retain
- `options.vmPoolSize` (number, default `1`): how many VMs to create per seed
- `options.mode` (string, default `"light"`): `"light"` or `"fast"`
- `options.threads` (number, default `os.cpus().length`): dataset init threads
- `options.enableJit` (boolean)
- `options.enableAes` (boolean)
- `options.enableHugePages` (boolean)
- `options.idleEvictMs` (number): evict idle seeds after this many ms

**Returns:** `SeedPool`

### `createPoolSeedPool(options)`

Convenience wrapper around `createSeedPool()` with the same semantics.
Use this when your workload is specifically RandomX epoch based (current + previous seed).

### `SeedPool`

Important methods:
- `hash(seed, input)`
- `hashAsync(seed, input)`
- `warmSeed(seed)` / `warmSeedAsync(seed)`
- `warmSeedFromHex(seedHex)` / `warmSeedAsyncFromHex(seedHex)`
- `verifyShare(seed, input, target, expectedHash?)`
- `hashFromHex(seedHex, input)`
- `hashAsyncFromHex(seedHex, input)`
- `verifyShareFromHex(seedHex, input, target, expectedHash?)`
- `getContext(seed)` / `getContextFromHex(seedHex)` for low-level interop
- `release(seed)` / `releaseFromHex(seedHex)` / `releaseAll()`
- `getSnapshot()`

Notes:
- `hashAsync()` and `hashAsyncFromHex()` are warmup-aware and will await any pending async warmup for that seed.
- sync `hash()` / `verifyShare()` methods do not wait for pending async warmups and may still initialize synchronously.
- in `fast` mode, a cold sync `hash()` / `verifyShare()` can block the Node.js event loop during dataset initialization; prefer `warmSeedAsync()` first, then use async APIs or only call sync APIs once the seed is known hot.
- `releaseAll()` is a full teardown; after calling it, the `SeedPool` instance should be considered disposed and will reject further use.

### `verifyShare(contextId, input, target, expectedHash?)`

Low-level API for raw context ids.

Verify a mining share against difficulty target.

**Parameters:**
- `contextId` (number): Context ID from `initContext`
- `input` (Buffer): Share data to hash
- `target` (Buffer): 32-byte difficulty target, little-endian
- `expectedHash` (Buffer, optional): Expected hash for validation

**Returns:** Object with:
- `valid` (boolean): Whether share meets target
- `difficulty` (number): Calculated difficulty
- `hash` (Buffer): 32-byte RandomX hash
- `hashTime` (number): Hash calculation time in ms

### `hash(contextId, input)`

Low-level API for raw context ids.

Calculate RandomX hash for given input.

**Parameters:**
- `contextId` (number): Context ID from `initContext`
- `input` (Buffer): Data to hash

**Returns:** 32-byte hash (Buffer)

### `hashAsync(contextId, input)`

Calculate RandomX hash asynchronously on libuv's worker pool.

This is the preferred primitive for Node.js broker/server patterns where one process
handles many concurrent requests against a shared set of RandomX VMs.

**Parameters:**
- `contextId` (number): Context ID from `initContext`
- `input` (Buffer): Data to hash

**Returns:** `Promise<Buffer>`

### `releaseContext(contextId)`

Release a RandomX context and free memory.

**Parameters:**
- `contextId` (number): Context ID to release

### `getStats()`

Get performance statistics.

**Returns:** Object with:
- `totalHashes` (number): Total hashes calculated
- `totalVerifications` (number): Total shares verified
- `activeVMs` (number): Active VM count
- `activeSeeds` (number): Active shared seed-resource count
- `averageHashTime` (number): Average hash time in ms
- `cacheHits` (number): Context cache hits
- `cacheMisses` (number): Context cache misses

### `getHardwareInfo()`

Get hardware capability information.

**Returns:** Object with:
- `hasJit` (boolean): JIT compilation available
- `hasAes` (boolean): AES acceleration available
- `hasHugePages` (boolean): Large pages available
- `cpuCores` (number): CPU core count
- `totalMemory` (number): Total system memory
- `hugePagesAvailable` (number): Available huge pages

## Build System

The build system is local-source based and builds from the vendored `deps/randomx` source tree included in the package:

### What Happens During `npm install`

1. **Check Vendored Source**: Verifies `deps/randomx` exists
2. **Configure RandomX**: Uses CMake with optimal performance settings
3. **Build RandomX**: Compiles the static library from local source
4. **Build Addon**: Compiles the N-API addon and links against RandomX

### Build Configuration

The build system automatically applies optimal settings:

- **Compiler Flags**: `-O3 -march=native -mtune=native`
- **RandomX Features**: JIT compilation + AES acceleration enabled
- **Cross-Platform**: Handles Linux, Windows, and macOS differences
- **Dependencies**: Automatically manages pthread and native build inputs

### Manual Build Control

```bash
# Clean local build output
npm run clean

# Rebuild addon + native library
npm run build

# Full install/build
npm install

# Verify installation
npm run verify

# Run tests
npm test

# Run example pool server
npm run example
```

## Performance Tuning

### System Optimization

For maximum performance on Linux:

```bash
# Enable performance governor
echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor

# Allocate huge pages (adjust count as needed)
echo 1024 | sudo tee /proc/sys/vm/nr_hugepages

# Set CPU affinity for mining processes
taskset -c 0-3 node your-pool-server.js
```

### Context Management

```javascript
// Pool server example with the primary seed-pool API
class PoolServer {
    constructor() {
        this.contexts = randomx.createPoolSeedPool({
            maxSeeds: 2,      // current + previous seed_hash
            vmPoolSize: 2,    // two VMs can share one dataset for concurrent work
            mode: 'fast',
            enableHugePages: false
        });
    }

    getContext(seedHex) {
        return this.contexts.getContextFromHex(seedHex);
    }

    verifyShare(seedHex, shareData, target) {
        return this.contexts.verifyShareFromHex(seedHex, shareData, target);
    }
}
```

### Pool Broker Pattern

For real pool deployments, a useful pattern is:

- keep RandomX in one or a few broker processes
- let pool workers send hash requests over a local socket
- use `createPoolSeedPool({ maxSeeds: 2, vmPoolSize: N, mode: 'fast' })`
- call `seedPool.warmSeedAsync(seed)` when a new `seed_hash` appears so dataset init happens off the main thread
- call `seedPool.hashAsync(seed, input)` inside the broker so one process can overlap requests

See:

- `examples/pool-broker.js`
- `examples/pool-cryptonote-style.js`
- `examples/pool-server.js`

## Benchmarks

Performance on modern hardware:

| CPU | Threads | Hashes/sec | Notes |
|-----|---------|------------|-------|
| Intel i9-12900K | 1 | ~15,000 | JIT + AES + Huge Pages |
| AMD Ryzen 9 5950X | 1 | ~12,000 | JIT + AES + Huge Pages |
| Intel Xeon E5-2680 | 1 | ~8,000 | JIT + AES |

## Development

### Building

```bash
# Setup development environment
npm install

# Rebuild addon only (keep RandomX)
npm run build

# Run verification
npm run verify

# Run tests
npm test

# Clean local build output
npm run clean
```

### Automated Build Features

The build system includes several automated features:

- **Vendored Source Check**: Fails fast if the package is incomplete and `deps/randomx` is missing
- **Dependency Detection**: Automatically checks for cmake and build tools
- **Platform Detection**: Handles Linux, Windows, macOS differences automatically
- **Version Pinning**: Uses the pinned vendored RandomX revision
- **Error Handling**: Clear error messages for missing dependencies
- **Incremental Builds**: Only rebuilds what's necessary

## Troubleshooting

### Common Issues

**Build fails with missing `deps/randomx`:**
```bash
# The package source is incomplete. Reinstall from a complete git checkout or archive.
rm -rf node_modules/randomx-hashing
npm install
```

**Build fails with "cmake not found":**
```bash
# Install cmake
sudo apt-get install cmake  # Ubuntu/Debian
brew install cmake          # macOS
```

**Large pages not available:**
- This is normal and doesn't affect functionality
- Large pages are off unless explicitly requested
- For pool brokers, start with `enableHugePages: false` and only enable after verifying the host can satisfy allocation reliably
- `getContextInfo(contextId).usedLargePages` is conservative; it stays `false` unless the addon can prove large-page backing

### Build Verification

```bash
# Verify installation
npm run verify

# Check hardware capabilities
node -e "console.log(require('./index').getHardwareInfo())"

# Test basic functionality
npm test
```

## Security

- Memory is securely cleared on context destruction
- No sensitive data persists after `releaseContext()`
- Validates all input parameters and buffer sizes
- Exception-safe with proper cleanup on errors

## License

MIT License - see LICENSE file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Submit a pull request

## Support

- File issues on GitHub
- Check troubleshooting section for common problems
- Review examples for usage patterns
- Verify installation with `npm run verify`
