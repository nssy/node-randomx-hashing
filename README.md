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
- **Vendored RandomX Source**: Builds from upstream RandomX pinned as a git subtree in `deps/randomx` (see [Updating RandomX](#updating-randomx))

## Performance

- **JIT Compilation**: Near-native speed RandomX execution
- **AES Hardware**: Hardware-accelerated AES when available
- **Memory Optimization**: Shared seed resources; huge pages by default with automatic fallback
- **RandomX v2 ready**: `rx/0` and `rx/2` per call, sharing one dataset per seed
- **Seed Reuse**: Explicitly protect the current `seed_hash` and reuse cached resources for an
  adjacent previous or prewarmed next seed without rebuilding full datasets
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
const randomx = require('randomx-hashing');

// Primary API: a seed pool for the current + adjacent transition seed_hash
const pool = randomx.createPoolSeedPool({
    maxSeeds: 2,
    vmPoolSize: 2,          // max concurrent VMs per variant per seed
    mode: 'fast',           // explicit: fast is never implied
    threads: 4              // dataset init threads
    // huge pages are on by default, with fallback; pass enableHugePages: false to opt out
});

const seed = Buffer.alloc(32, 1);
const blob = Buffer.from('hashing blob with nonce');

await pool.protectSeedAsync(seed); // current seed; warmSeedAsync(nextSeed) prewarms the next one

// Pick the variant per job from the block major version (Monero v17+ = RandomX v2)
const variant = randomx.getVariant(blob);

// `pow` is what must meet the target (and what miners submit as `result`):
// the hash for rx/0, the commitment for rx/2
const { hash, pow } = await pool.powAsync(seed, blob, { variant });
console.log(variant, 'hash:', hash.toString('hex'), 'pow:', pow.toString('hex'));

console.log('memory:', pool.getMemoryInfo(seed)); // e.g. { dataset: 'hugetlb', cache: null, ... } (fast mode frees the cache)

pool.releaseAll();
```

## RandomX v2 (`rx/2`)

Monero's hard fork 17 (FCMP++) switches PoW to RandomX v2. No activation height is announced yet,
and nothing here needs one: the variant comes from each job's hashing blob.

- **Variants** are named like the stratum `algo` strings: `'rx/0'` (default) and `'rx/2'`. Every
  hash call takes `{ variant }`; an unknown variant throws instead of falling back.
- **One dataset serves both variants.** `RANDOMX_FLAG_V2` only changes the VM, so a fork in the
  middle of a seed epoch needs no second dataset. Each variant gets its own VM pool, created on
  first use.
- **PoW vs hash:** for rx/2 the value compared with the target is the commitment
  `Blake2b-256(blob || hash)`, available as `pow` from `pow()` / `powAsync()` and via
  `commitment(input, hash)`. `verifyShare()` computes difficulty from `pow`.
- **xmrig's submit fields are swapped:** `result` is the commitment (`pow`), and `commitment` is
  the raw RandomX hash. `commitment(blob, params.commitment).equals(result)` is a cheap
  pre-check before the full hash.
- **`getVariant(blob)`**: `'rx/2'` when the block major version is 17 or higher.
- **`capabilities()`**: `{ abi, variants, commitment, randomx }`. Assert `variants.includes('rx/2')`
  at startup so a stale build fails loudly instead of returning v1 hashes. `randomx` is the
  upstream RandomX commit the addon was compiled from; log it at startup.

## Memory and huge pages

Huge pages are **on by default** and every buffer falls back on its own:

| Buffer | Tried in order |
|---|---|
| Dataset (fast mode, ~2 GiB) | reserved hugetlb pages → transparent huge pages → normal pages |
| Cache (~256 MiB; freed after dataset init in fast mode) | reserved hugetlb pages → transparent huge pages → normal pages |
| VM scratchpad (2 MiB per VM) | reserved hugetlb pages → normal pages |

- **Scratchpads never use transparent huge pages.** RandomX allocates them itself (2 MiB, not
  2 MiB-aligned), so THP can't back them whatever the THP mode: they are on reserved pages
  (one per VM) or normal pages. The cost is small: ≤4% per hash measured on Zen 2, against ~15%
  for the dataset.
- **Reserved hugetlb pages** are used only when the kernel's default huge page size is 2 MiB and
  enough pages are available (free minus reserved). 1 GiB pages are never used.
- In fast mode the long-lived dataset is allocated before its temporary initialization cache, so
  a constrained reserved pool prioritizes the memory that affects steady-state hash performance.
- **Transparent huge pages** are requested with `madvise(MADV_HUGEPAGE)` before the memory is
  first touched, when THP is `always` or `madvise`.
- `enableHugePages: 'thp'` uses transparent huge pages only and leaves the reserved pool to other
  processes (e.g. a miner or monerod on the same host). `enableHugePages: false` uses normal pages.
- **What was used is recorded once** when each buffer is allocated: `'hugetlb'`, `'thp'` or
  `'normal'`. See `getContextInfo(id).memory`, `SeedPool.getMemoryInfo(seed)`,
  `SeedPool.getSnapshot()` and `getStats().memory`. Reserved hugetlb pages do not count towards
  RSS.

Measured on a Zen 2 host (fast mode, single thread): ~1.73 ms/hash on normal pages, ~1.5 ms with
transparent or reserved huge pages.

### Sizing the reserved pool

Callers don't need to choose anything: leave `enableHugePages` unset and size the host. Per
process, in 2 MiB pages:

| Per seed | Pages |
|---|---|
| Fast mode (dataset) | 1,040 + 1 per VM |
| Light mode (cache) | 128 + 1 per VM |

VMs are created on demand, up to `vmPoolSize` per variant, so a seed hashed with both rx/0 and
rx/2 can reach `2 × vmPoolSize` VMs. Multiply by `maxSeeds` (2 during an epoch switch) and by the
number of processes that load the addon. Example: one fast broker with `vmPoolSize: 16` and
`maxSeeds: 2` needs at most 2 × (1,040 + 32) = 2,144 pages (4.2 GiB).

When the pool runs short, buffers land on transparent huge pages, or on normal pages, and keep
working. Log `getMemoryInfo(seed)` once per seed to see which (`examples/memory-backing.js`).

## API Reference

### `createSeedPool(options)` / `createPoolSeedPool(options)`

Primary high-level API for pools and brokers. `createPoolSeedPool` defaults `maxSeeds` to 2
(protected current + one adjacent transition seed).

Count options must be positive integers: other numbers (`NaN`, `±Infinity`, fractions, `0`,
negatives) and other types throw a `RangeError`. Values above a cap are lowered to it with a
one-time `RANDOMX_HASHING_CAPPED` process warning; past these, a setting costs memory or threads
without helping. The caps are exported as `LIMITS`. Context ids must be exact: `1.5` or `2**32 + 1`
never resolve to context 1.

**Options:**
- `maxSeeds` (integer, default `2`, capped at 4): how many seeds to retain (LRU)
- `vmPoolSize` (integer, default `1`, capped at the CPU count): max VMs per variant per seed; any idle VM serves a request
- `mode` (string, default `"light"`): `"light"` or `"fast"`. Omitted or falsy values select
  `"light"`; use `mode: "fast"` explicitly for the full-memory mode.
- `threads` (integer, default half the CPUs, capped at the CPU count): dataset init threads; leaves cores for live hashing during a seed change
- `enableJit`, `enableAes` (boolean, default `true`)
- `enableHugePages` (`true` | `'thp'` | `false`, default `true`): see [Memory and huge pages](#memory-and-huge-pages)
- `idleEvictMs` (number of ms; unset or `0` disables): release older used seeds idle for this many ms, checked on a timer. `protectSeedAsync()` identifies the current seed explicitly; without it, the latest seed used for hashing/context access is protected. Never-used prewarmed seeds also survive. The `maxSeeds` hard bound and explicit release still apply. This reclaims previous-epoch memory after transitions without making a quiet pool cold.

**Returns:** `SeedPool`

### `SeedPool`

All hashing methods take an optional `{ variant }` (default `'rx/0'`). Every method that takes a
seed also has a `...FromHex(seedHex, ...)` form, except `has` and `getMemoryInfo`.
- `hashAsync(seed, input, options?)` → `Promise<Buffer>`: raw hash
- `powAsync(seed, input, options?)` → `Promise<{ hash, pow }>`
- `hash(seed, input, options?)` / `pow(seed, input, options?)`: sync forms
- `verifyShare(seed, input, target, expectedPow?, options?)`: sync
- `warmSeedAsync(seed)` / `warmSeed(seed)`: build a seed's cache/dataset (variants need no warmup)
- `protectSeedAsync(seed)` / `protectSeed(seed)`: warm and identify the current seed; idle
  eviction keeps it and LRU evicts another seed when possible. A newer protection supersedes an
  older in-flight async call, whose promise rejects with
  `code === 'ERR_RANDOMX_PROTECTION_SUPERSEDED'`
- `getMemoryInfo(seed)`, `getSnapshot()`, `has(seed)`, `size`. The snapshot's
  `idleProtectedSeed` identifies the seed exempt from idle eviction (explicit protection when set,
  otherwise the latest used seed); `idleProtected` marks its resident entry. `protectedSeed` and
  `protected` report explicit protection only.
- `getContext(seed)` / `getContextFromHex(seedHex)`: context id for the low-level API
- `release(seed)` / `releaseFromHex(seedHex)` / `releaseAll()`

Notes:
- Async methods never block the event loop: a missing seed is warmed on the worker pool first,
  and concurrent requests for one seed share a single build.
- Sync methods initialize a missing seed synchronously; in fast mode that blocks the event loop
  for the dataset build. Warm first or use the async methods.
- Sync methods also wait for a free VM when all `vmPoolSize` VMs of that variant are busy with
  async work.
- Releasing or evicting a seed never breaks hashes already in flight, including a hash queued
  in the same tick as the release.
- `releaseAll()` is a full teardown; the pool rejects further use.
- **Concurrency is bounded by libuv's thread pool**, 4 threads by default. Async hashes and
  warmups run there, so `vmPoolSize: 16` with the default pool hashes only 4 at a time. Set
  `UV_THREADPOOL_SIZE` to at least `vmPoolSize + 2` before the process starts, and admit at most
  `vmPoolSize` native hash calls at once. Otherwise hashes waiting for a VM can occupy the spare
  workers intended for current/next seed warmup.
- Errors: invalid arguments (types, sizes, variants, count options) throw synchronously, even
  from async methods. A released pool and failed allocations reject.
- When memory runs out, a seed that can't be allocated fails with "Failed to initialize RandomX
  context", and a VM pool that can't add a VM keeps using the VMs it already has. The process is
  never aborted.

### Low-level API (context ids)

A context is one seed: its cache/dataset plus VM pools per variant.

- `initContext(seed, options)` / `initContextAsync(seed, options)` → context id. Same options as
  `createSeedPool` (`mode`, `enableJit`, `enableAes`, `enableHugePages`, `threads`, `vmPoolSize`;
  defaults `light`, true, true, true, 1, 1).
- `hash(id, input, options?)` / `hashAsync(id, input, options?)` → raw hash
- `pow(id, input, options?)` / `powAsync(id, input, options?)` → `{ hash, pow }`
- `verifyShare(id, input, target, expectedPow?, options?)` → `{ valid, difficulty, hash, pow, hashTime }`.
  `valid` means `pow <= target` (32-byte little-endian) and, if given, `pow` equals `expectedPow`;
  `difficulty` is `2^256 / pow`.
- `commitment(input, hash)` → `Blake2b-256(input || hash)`
- `releaseContext(id)`
- `getContextInfo(id)` → `{ mode, enableHugePages, hugePages, vmPoolSize, vms: { 'rx/0', 'rx/2' }, memory: { dataset, cache, scratchpad: { hugetlb, normal } } }` or `null`

### Info

- `getStats()`: `totalHashes`, `totalVerifications`, `activeContexts`, `activeVMs`, `activeSeeds`,
  `averageHashTime` (ms), `cacheHits`, `cacheMisses`, `variants: { 'rx/0': { totalHashes, averageHashTime }, 'rx/2': ... }`,
  `memory: { dataset: { hugetlb, thp, normal }, cache: { ... } }` (live seeds per backing)
- `getHardwareInfo()`: `hasJit`, `hasAes`, `hasHugePages`, `cpuCores`, `totalMemory`,
  `hugePages: { pageSizeKB, total, free, reserved, available }`, `hugePagesAvailable` (= `available`),
  `transparentHugePages: { enabled, defrag }`
- `capabilities()`: `{ abi, variants, commitment, randomx }`. `abi` is checked at load (an
  out-of-date build throws "native addon is out of date"); `randomx` is the compiled-in RandomX
  commit, which differs from package.json `randomx.commit` when the build is stale
- `LIMITS`: caps for `threads`, `vmPoolSize` and `maxSeeds`
- `normalizeInitOptions(options)`: the validated options `initContext` passes to native code
- Legacy aliases: `createContextCache` = `createSeedPool`, `createPoolEpochCache` =
  `createPoolSeedPool`, `RandomXContextCache` = `SeedPool`
- `getVariant(blob)`, `VARIANTS`, `MONERO_RX2_MAJOR_VERSION`

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

# Optional: reserve 2 MiB huge pages (~1,200 per fast-mode seed). Without them the addon
# uses transparent huge pages when THP is `always` or `madvise`.
echo 1250 | sudo tee /proc/sys/vm/nr_hugepages

# Set CPU affinity for mining processes
taskset -c 0-3 node your-pool-server.js
```

### Context Management

```javascript
// Pool server example with the primary seed-pool API
class PoolServer {
    constructor() {
        this.contexts = randomx.createPoolSeedPool({
            maxSeeds: 2,      // protected current + previous or prewarmed next seed_hash
            vmPoolSize: 2,    // up to two VMs per variant share one dataset
            mode: 'fast'
        });
    }

    // `pow` is compared with the target and with the miner's `result`
    powFor(seedHex, hashingBlob) {
        const variant = randomx.getVariant(hashingBlob);
        return this.contexts.powAsyncFromHex(seedHex, hashingBlob, { variant });
    }
}
```

### Pool Broker Pattern

For real pool deployments, a useful pattern is:

- keep RandomX in one or a few broker processes
- let pool workers send hash requests over a local socket
- use `createPoolSeedPool({ maxSeeds: 2, vmPoolSize: N, mode: 'fast' })`
- call `seedPool.protectSeedAsync(currentSeed)` for the current `seed_hash`, then `warmSeedAsync(nextSeed)` for `next_seed_hash`; this keeps LRU ordering correct even when a quiet pool receives no shares for an epoch
- admit at most `vmPoolSize` native hash calls per broker process and queue excess requests in JavaScript; native calls waiting for a VM occupy libuv workers, while admission control preserves spare workers for seed warmup
- call `seedPool.powAsync(seed, input, { variant })` inside the broker so one process can overlap requests
- pass the job's variant on every request, and check `capabilities()` on both sides so a stale broker can't silently return v1 hashes

See:

- `examples/pool-broker.js`: broker protocol 2 (`hello` handshake, `pow` with `variant`, `stats`),
  and a client that refuses rx/2 work on a peer that didn't report it
- `examples/pool-cryptonote-style.js`: variant per job from the blob, plus the cheap rx/2 submit
  pre-check (xmrig sends the commitment as `result` and the raw hash as `commitment`)
- `examples/pool-server.js`: async verification with exact BigInt share difficulty
- `examples/memory-backing.js`: which pages each seed actually got, how many huge pages a seed
  needs, and detecting a fallback (`node examples/memory-backing.js [--fast]`)
- `examples/init-with-fallback.js`: fast mode with a light-mode fallback

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

# Run verification (also fails on a stale build)
npm run verify

# Run tests: upstream known-answer vectors for rx/0, rx/2 and commitments in every mode and
# memory backing (vectors.test.js), SeedPool behaviour (seedpool.test.js), legacy API (test.js)
npm test

# Fast mode with and without reserved huge pages (~2 GiB per run)
npm run test:fast-mode

# Clean local build output
npm run clean
```

### Updating RandomX

`deps/randomx` is a squashed [git subtree](https://github.com/tevador/RandomX), not a submodule:
npm installs `github:` dependencies from GitHub tarballs, which never contain submodule files.
The pinned upstream commit is recorded in the subtree commit (`git-subtree-split: <sha>`) and in
package.json `randomx.commit`, which the build compiles in as `capabilities().randomx`. `npm run
verify` fails when the two differ, i.e. the addon wasn't rebuilt after an update.

Use the update script instead of copying files by hand:

```bash
# Show the pinned vs. latest upstream commit and what changed (exit code 2 = update available)
npm run update-randomx -- --check

# Update to upstream master (or pass a branch, tag or full commit SHA)
npm run update-randomx
npm run update-randomx -- <ref>

# Then rebuild in place and restart anything that has the addon loaded
npm run build
```

Before committing anything, the script builds the addon against the new RandomX in a temporary
export, so your working tree and `build/Release` stay untouched until every check passes:

- v1 hashes from the new build must be identical to your current `build/Release` (consensus check)
- upstream `randomx-tests` must pass (includes RandomX v2 and commitment vectors)
- `npm test` must pass (known-answer vectors for rx/0, rx/2 and commitments, SeedPool, legacy API)

It then merges the update as one squashed subtree commit and records the new commit in
package.json `randomx.commit`. Run it on a clean branch: tracked
files must have no uncommitted changes. It refuses targets older than upstream `7c761cf`, which
fixes wrong RandomX v2 code generation in the x86 JIT (present in the `v2.0.1` tag).
`--no-verify` skips the checks.

### Automated Build Features

The build system includes several automated features:

- **Vendored Source Check**: Fails fast if the package is incomplete and `deps/randomx` is missing
- **Dependency Detection**: Automatically checks for cmake and build tools
- **Platform Detection**: Handles Linux, Windows, macOS differences automatically
- **Version Pinning**: Uses the RandomX revision pinned by the `deps/randomx` git subtree
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

**Huge pages not used (`memory.dataset` is `'normal'`):**
- This is normal and doesn't affect correctness; hashing is ~15% slower than with huge pages
- Check `getHardwareInfo().hugePages.available` (free minus reserved) and `transparentHugePages.enabled`
- THP set to `never` and no reserved pages leaves only normal pages; set THP to `madvise` or reserve pages

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
