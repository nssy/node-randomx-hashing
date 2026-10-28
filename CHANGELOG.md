# Changelog

## 2.0.0 (2026-10-28)

### RandomX
- RandomX is a git subtree of upstream master `ff6daa1` (was hand-copied v1.2.1); update with
  `npm run update-randomx`. v1 hashes are unchanged.

### Added
- RandomX v2: every hash call takes `{ variant: 'rx/0' | 'rx/2' }` (default `'rx/0'`). Unknown
  variants throw. Both variants share one cache/dataset per seed.
- `pow()` / `powAsync()` return `{ hash, pow }`: `pow` is the value compared with the target (the
  hash for rx/0, the commitment for rx/2). `commitment(input, hash)`.
- `getVariant(blob)`, `VARIANTS`, `MONERO_RX2_MAJOR_VERSION`, `capabilities()`.
  `capabilities().randomx` is the RandomX commit compiled in (from package.json `randomx.commit`;
  `npm run verify` fails when the build is stale).
- `SeedPool.getMemoryInfo(seed)`; per-seed `vms` and `memory` in `getSnapshot().seeds`;
  `pow` / `powAsync` and their `...FromHex` forms. `LIMITS`.
- `getStats().variants` and `getStats().memory`; `getHardwareInfo().hugePages` and
  `.transparentHugePages`.

### Examples
- `pool-broker.js` implements broker protocol 2 (`hello`, `pow`, `variant`, `stats`); new
  `memory-backing.js`; `pool-server.js` verifies off the event loop with exact difficulty;
  `pool-cryptonote-style.js` shows the rx/2 submit pre-check.

### Changed (breaking)
- **Huge pages are on by default**, falling back per buffer: reserved hugetlb pages → transparent
  huge pages (madvise before first touch) → normal pages. `enableHugePages: 'thp'` skips the
  reserved pool; `false` opts out. The backing used is recorded once and reported via
  `getContextInfo(id).memory` (replaces `usedLargePages`).
- A context is one seed with lazily created VM pools per variant (`vmPoolSize` VMs each); any
  idle VM serves a request. `SeedPool` keeps one context per seed instead of one per VM.
- `verifyShare()` returns `pow`; `difficulty` is `2^256 / pow` (was wrong) and `expectedPow` is
  compared with `pow`.
- `createSeedPool()` defaults `threads` to half the CPUs (was all).
- `enableJit` / `enableAes` must be booleans (`0`, `null`, `"false"` used to mean "on").
- Options are type-checked: count options must be positive integers (`NaN`, `±Infinity`,
  fractions, `0` and negatives throw `RangeError`; `threads: 0` used to become 1 silently).
  Oversized values are capped with a one-time warning: `threads` and `vmPoolSize` at the CPU
  count, `maxSeeds` at 4 (`LIMITS`). Native backstop: 256 threads, 1024 VMs. Context ids must be
  exact integers (`1.5` used to resolve to context 1, `2**32 + 1` wrapped). The native layer
  accepts 1–64-byte seeds (the JS API still requires 32).
- `getHardwareInfo().hugePagesAvailable` is free minus reserved pages (was free pages).

### Fixed
- Async hashing of a seed that isn't warm no longer initializes it synchronously on the event loop.
- `idleEvictMs` releases idle seeds on a timer, and never evicts the seed being requested. A
  warmed seed is exempt until its first hash: a prewarmed `next_seed_hash` (published ~2 h before
  the switch) used to be dropped before use, making every epoch switch cold.
- `warmSeedAsync()` after `releaseAll()` rejects instead of re-allocating.
- Fast mode releases the 256 MiB cache after building the dataset (`memory.cache` is then `null`).
- Flags start from `randomx_get_flags()`: AVX2/SSSE3 Argon2 is used, and hardware AES is no longer
  forced on CPUs without it.
- A VM whose scratchpad can't get huge pages falls back to normal pages instead of failing.
- Out of memory no longer aborts the process: allocation or thread-start failures while building
  a seed reject with "Failed to initialize RandomX context" (the addon is now built with C++
  exceptions so these can be caught), and a VM pool that can't add a VM shares the ones it has.
  Concurrent requests for a seed whose build failed all reject; none waits forever.
- `hashAsync`/`powAsync` call native code in the same tick as the seed lookup, so a hash queued
  just before `release(seed)` no longer fails with "Invalid context".
- Native `verifyShare` rejects an `expectedPow` that isn't a Buffer (it was ignored).
- The context manager singleton no longer takes a global mutex on every call.
