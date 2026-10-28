/**
 * RandomX Context Manager Header
 * Shared per-seed resources (cache/dataset) with lazily created per-variant VM pools
 */

#ifndef CONTEXT_MANAGER_H
#define CONTEXT_MANAGER_H

#include <cstdint>
#include <memory>
#include <unordered_map>
#include <mutex>
#include <atomic>
#include <string>
#include <vector>
#include <condition_variable>

extern "C" {
    #include "randomx.h"
}

/**
 * RandomX mode enumeration
 */
enum class RandomXMode {
    FAST,   // Full memory mode (~2GB) - for mining
    LIGHT   // Light mode (~256MB) - for verification
};

/**
 * RandomX algorithm variant. Indexes per-variant arrays, so keep values dense.
 */
enum class RandomXVariant : uint8_t {
    RX0 = 0,  // "rx/0": RandomX v1
    RX2 = 1   // "rx/2": RandomX v2 (RANDOMX_FLAG_V2), PoW is the commitment
};
constexpr size_t kVariantCount = 2;

/**
 * How a buffer is backed in memory. Recorded once when the buffer is allocated.
 */
enum class MemoryBacking : uint8_t {
    NONE,     // buffer not allocated (e.g. no dataset in light mode)
    HUGETLB,  // reserved huge pages (RANDOMX_FLAG_LARGE_PAGES)
    THP,      // transparent huge pages advised with madvise(MADV_HUGEPAGE) before first touch
    NORMAL    // regular pages
};
constexpr size_t kBackingCount = 4;

/**
 * Which huge page sources a context may use.
 */
enum class HugePageMode : uint8_t {
    OFF,  // normal pages only
    THP,  // transparent huge pages only; never takes from the reserved hugetlb pool
    ALL   // reserved hugetlb pages first, then transparent huge pages
};

/**
 * RandomX configuration structure
 */
struct RandomXConfig {
    bool enableJit;
    bool enableAes;
    HugePageMode hugePages;
    uint32_t threads;
    uint32_t vmPoolSize;
    RandomXMode mode;
};

/**
 * Cache/dataset for one seed. Shared by every VM of every variant: RANDOMX_FLAG_V2 only
 * affects the VM, never cache or dataset initialization.
 */
struct RandomXSeedResources {
    randomx_dataset* dataset = nullptr;
    randomx_cache* cache = nullptr;     // released after dataset init in fast mode
    std::string seed;
    RandomXConfig config = {};
    randomx_flags vmFlags = RANDOMX_FLAG_DEFAULT;  // without V2 and LARGE_PAGES
    MemoryBacking datasetBacking = MemoryBacking::NONE;
    MemoryBacking cacheBacking = MemoryBacking::NONE;

    ~RandomXSeedResources();
};

/**
 * Pool of interchangeable VMs for one (seed, variant). Any idle VM is handed out; VMs are
 * created on demand up to maxSize, so a variant that is never used costs nothing.
 */
class RandomXVmPool {
public:
    RandomXVmPool(std::shared_ptr<RandomXSeedResources> resources, RandomXVariant variant, uint32_t maxSize);
    ~RandomXVmPool();

    /** Blocks while all maxSize VMs are busy. nullptr if a VM could not be created. */
    randomx_vm* acquire();
    void release(randomx_vm* vm);

    uint32_t created() const { return createdCount.load(); }
    uint32_t hugetlbScratchpads() const { return hugetlbCount.load(); }

private:
    randomx_vm* createVm();

    std::shared_ptr<RandomXSeedResources> resources;
    RandomXVariant variant;
    uint32_t maxSize;  // lowered when a VM can't be allocated; guarded by mutex
    std::mutex mutex;
    std::condition_variable available;
    std::vector<randomx_vm*> idle;
    std::atomic<uint32_t> createdCount{0};
    std::atomic<uint32_t> hugetlbCount{0};
};

/**
 * RAII lease of one VM from a pool.
 */
class RandomXVmLease {
public:
    explicit RandomXVmLease(std::shared_ptr<RandomXVmPool> pool)
        : pool(std::move(pool)), vm(this->pool->acquire()) {}
    ~RandomXVmLease() { if (vm) pool->release(vm); }
    RandomXVmLease(const RandomXVmLease&) = delete;
    RandomXVmLease& operator=(const RandomXVmLease&) = delete;

    randomx_vm* get() const { return vm; }

private:
    std::shared_ptr<RandomXVmPool> pool;
    randomx_vm* vm;
};

/**
 * A context is one seed handle: shared seed resources plus one VM pool per variant.
 */
struct RandomXContext {
    std::shared_ptr<RandomXSeedResources> resources;
    std::shared_ptr<RandomXVmPool> pools[kVariantCount];
    std::mutex poolsMutex;
    uint32_t vmPoolSize = 1;

    std::shared_ptr<RandomXVmPool> pool(RandomXVariant variant);
};

struct RandomXSeedInitState {
    std::mutex mutex;
    std::condition_variable cv;
    bool done = false;
    std::shared_ptr<RandomXSeedResources> resources;
};

struct VariantStats {
    uint64_t totalHashes;
    double averageHashTime;
};

/**
 * Performance statistics
 */
struct PerformanceStats {
    uint64_t totalHashes;
    uint64_t totalVerifications;
    uint32_t activeContexts;
    uint32_t activeVMs;
    uint32_t activeSeeds;
    double averageHashTime;
    uint64_t cacheHits;
    uint64_t cacheMisses;
    VariantStats variants[kVariantCount];
    uint32_t datasetBackings[kBackingCount];
    uint32_t cacheBackings[kBackingCount];
};

struct HugePagePool {
    uint64_t pageSizeKB;
    uint64_t total;
    uint64_t free;
    uint64_t reserved;
    uint64_t available;  // free - reserved: pages a new mapping can actually get
};

/**
 * Hardware capability information
 */
struct HardwareInfo {
    bool hasJit;
    bool hasAes;
    bool hasHugePages;
    uint32_t cpuCores;
    uint64_t totalMemory;
    HugePagePool hugePages;   // default huge page size pool (what MAP_HUGETLB uses)
    std::string thpEnabled;   // "always" | "madvise" | "never" | "" (unknown)
    std::string thpDefrag;
};

struct ContextInfo {
    RandomXMode mode;
    HugePageMode hugePages;
    uint32_t vmPoolSize;
    MemoryBacking datasetBacking;
    MemoryBacking cacheBacking;
    uint32_t vms[kVariantCount];
    uint32_t hugetlbScratchpads;
};

/**
 * Context Manager - Singleton for efficient context reuse
 */
class ContextManager {
private:
    std::unordered_map<uint32_t, std::shared_ptr<RandomXContext>> contexts;
    mutable std::mutex contextsMutex;
    std::unordered_map<std::string, std::weak_ptr<RandomXSeedResources>> seedResources;
    std::unordered_map<std::string, std::shared_ptr<RandomXSeedInitState>> seedInitStates;
    mutable std::mutex seedResourcesMutex;
    std::atomic<uint32_t> nextContextId;

    // Performance tracking
    std::atomic<uint64_t> totalHashes[kVariantCount];
    std::atomic<uint64_t> totalHashTimeMicros[kVariantCount];
    std::atomic<uint64_t> totalVerifications;
    std::atomic<uint64_t> cacheHits;
    std::atomic<uint64_t> cacheMisses;

    ContextManager();

    std::string makeSeedKey(const std::string& seed, const RandomXConfig& config) const;
    std::shared_ptr<RandomXSeedResources> acquireSeedResources(const std::string& seed, const RandomXConfig& config);
    std::shared_ptr<RandomXSeedResources> createSeedResources(const std::string& seed, const RandomXConfig& config);
    uint32_t createContextUnchecked(const uint8_t* seed, size_t seedLength, const RandomXConfig& config);

public:
    static ContextManager& getInstance();

    ~ContextManager();

    // Context management
    uint32_t createContext(const uint8_t* seed, size_t seedLength, const RandomXConfig& config);
    bool releaseContext(uint32_t contextId);
    std::shared_ptr<RandomXContext> getContext(uint32_t contextId) const;
    bool getContextInfo(uint32_t contextId, ContextInfo& out) const;

    // Statistics and info
    PerformanceStats getStats() const;
    HardwareInfo getHardwareInfo() const;

    // Performance tracking
    void recordHash(RandomXVariant variant, uint64_t elapsedMicros);
    void recordVerification();
};

#endif // CONTEXT_MANAGER_H
