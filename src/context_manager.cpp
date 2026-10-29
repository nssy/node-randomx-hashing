/**
 * RandomX Context Manager Implementation
 * Shared per-seed resources (cache/dataset) with lazily created per-variant VM pools
 */

#include "context_manager.h"
#include "configuration.h"
#include <algorithm>
#include <chrono>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <system_error>
#include <thread>
#include <vector>

#ifdef __linux__
#include <sys/mman.h>
#include <sys/sysinfo.h>
#include <unistd.h>
#endif

namespace {

// Live VM count. A plain constant-initialized atomic rather than a ContextManager member: VM
// pools can be destroyed during static destruction, after ContextManager's mutexes are gone.
std::atomic<int64_t> liveVms{0};

constexpr size_t kCacheBytes = static_cast<size_t>(RANDOMX_ARGON_MEMORY) * 1024;
constexpr size_t kScratchpadBytes = RANDOMX_SCRATCHPAD_L3;

std::string readFirstLine(const char* path) {
    std::ifstream file(path);
    std::string line;
    std::getline(file, line);
    return line;
}

uint64_t readNumber(const std::string& path) {
    std::ifstream file(path);
    uint64_t value = 0;
    file >> value;
    return value;
}

/** Selected value of a sysfs choice file, e.g. "always [madvise] never" -> "madvise". */
std::string selectedChoice(const char* path) {
    const std::string line = readFirstLine(path);
    const size_t open = line.find('[');
    const size_t close = line.find(']', open);
    return (open == std::string::npos || close == std::string::npos) ? "" : line.substr(open + 1, close - open - 1);
}

HugePagePool readHugePagePool() {
    HugePagePool pool = {};
#ifdef __linux__
    std::ifstream meminfo("/proc/meminfo");
    std::string key;
    while (meminfo >> key) {
        if (key == "Hugepagesize:") {
            meminfo >> pool.pageSizeKB;
            break;
        }
        meminfo.ignore(256, '\n');
    }
    if (pool.pageSizeKB == 0) {
        return pool;
    }
    const std::string dir = "/sys/kernel/mm/hugepages/hugepages-" + std::to_string(pool.pageSizeKB) + "kB/";
    pool.total = readNumber(dir + "nr_hugepages");
    pool.free = readNumber(dir + "free_hugepages");
    pool.reserved = readNumber(dir + "resv_hugepages");
    pool.available = pool.free > pool.reserved ? pool.free - pool.reserved : 0;
#endif
    return pool;
}

/**
 * Worth trying RANDOMX_FLAG_LARGE_PAGES for `bytes`? A hint only: the allocation result decides.
 * On Linux RandomX maps the *default* huge page size, so skip it unless that size is 2 MiB:
 * 1 GiB pages are only ever used when the operator configures them explicitly.
 */
bool hugetlbWorthTrying(size_t bytes) {
#ifdef __linux__
    const HugePagePool pool = readHugePagePool();
    return pool.pageSizeKB == 2048 && pool.available * 2048 * 1024 >= bytes;
#else
    (void)bytes;
    return true;
#endif
}

bool thpEnabled() {
#ifdef __linux__
    static const bool enabled = [] {
        const std::string mode = selectedChoice("/sys/kernel/mm/transparent_hugepage/enabled");
        return mode == "always" || mode == "madvise";
    }();
    return enabled;
#else
    return false;
#endif
}

/** Ask for transparent huge pages on [memory, memory + bytes). Must run before first touch. */
bool adviseHugePages(void* memory, size_t bytes) {
#ifdef __linux__
    const uintptr_t page = static_cast<uintptr_t>(sysconf(_SC_PAGESIZE));
    const uintptr_t begin = (reinterpret_cast<uintptr_t>(memory) + page - 1) & ~(page - 1);
    const uintptr_t end = (reinterpret_cast<uintptr_t>(memory) + bytes) & ~(page - 1);
    return end > begin && madvise(reinterpret_cast<void*>(begin), end - begin, MADV_HUGEPAGE) == 0;
#else
    (void)memory;
    (void)bytes;
    return false;
#endif
}

/**
 * Allocate a cache or dataset trying hugetlb, then THP, then normal pages.
 * `alloc` takes flags; `memoryOf` returns the buffer of the allocated object.
 */
template<typename T, typename Alloc, typename MemoryOf>
T* allocWithBacking(randomx_flags flags, HugePageMode hugePages, size_t bytes, Alloc alloc, MemoryOf memoryOf, MemoryBacking& backing) {
    if (hugePages == HugePageMode::ALL && hugetlbWorthTrying(bytes)) {
        if (T* object = alloc(static_cast<randomx_flags>(flags | RANDOMX_FLAG_LARGE_PAGES))) {
            backing = MemoryBacking::HUGETLB;
            return object;
        }
    }
    T* object = alloc(static_cast<randomx_flags>(flags & ~RANDOMX_FLAG_LARGE_PAGES));
    if (object) {
        backing = (hugePages != HugePageMode::OFF && thpEnabled() && adviseHugePages(memoryOf(object), bytes))
            ? MemoryBacking::THP
            : MemoryBacking::NORMAL;
    }
    return object;
}

randomx_flags baseFlags(const RandomXConfig& config) {
    randomx_flags flags = randomx_get_flags();
    if (!config.enableJit) {
        flags = static_cast<randomx_flags>(flags & ~(RANDOMX_FLAG_JIT | RANDOMX_FLAG_SECURE));
    }
    if (!config.enableAes) {
        flags = static_cast<randomx_flags>(flags & ~RANDOMX_FLAG_HARD_AES);
    }
    return flags;
}

} // namespace

RandomXSeedResources::~RandomXSeedResources() {
    if (dataset) {
        randomx_release_dataset(dataset);
    }
    if (cache) {
        randomx_release_cache(cache);
    }
}

RandomXVmPool::RandomXVmPool(std::shared_ptr<RandomXSeedResources> resources, RandomXVariant variant, uint32_t maxSize)
    : resources(std::move(resources)), variant(variant), maxSize(std::max<uint32_t>(1, maxSize)) {
    // release() runs in a lease destructor and must not allocate; maxSize only ever shrinks.
    idle.reserve(this->maxSize);
}

RandomXVmPool::~RandomXVmPool() {
    for (randomx_vm* vm : idle) {
        randomx_destroy_vm(vm);
        liveVms.fetch_sub(1);
    }
}

randomx_vm* RandomXVmPool::createVm() {
    randomx_flags flags = resources->vmFlags;
    if (variant == RandomXVariant::RX2) {
        flags = static_cast<randomx_flags>(flags | RANDOMX_FLAG_V2);
    }
    // Fast-mode VMs only read the dataset; the cache is released after dataset init.
    randomx_cache* cache = resources->dataset ? nullptr : resources->cache;

    randomx_vm* vm = nullptr;
    if (resources->config.hugePages == HugePageMode::ALL && hugetlbWorthTrying(kScratchpadBytes)) {
        vm = randomx_create_vm(static_cast<randomx_flags>(flags | RANDOMX_FLAG_LARGE_PAGES), cache, resources->dataset);
        if (vm) {
            hugetlbCount.fetch_add(1);
        }
    }
    if (!vm) {
        vm = randomx_create_vm(flags, cache, resources->dataset);
    }
    if (vm) {
        liveVms.fetch_add(1);
    }
    return vm;
}

randomx_vm* RandomXVmPool::acquire() {
    std::unique_lock<std::mutex> lock(mutex);
    for (;;) {
        if (!idle.empty()) {
            randomx_vm* vm = idle.back();
            idle.pop_back();
            return vm;
        }
        if (createdCount.load() < maxSize) {
            createdCount.fetch_add(1);
            lock.unlock();
            if (randomx_vm* vm = createVm()) {
                return vm;
            }
            lock.lock();
            // Out of memory for another VM: stop growing and share the VMs that exist. Fail only
            // when there are none.
            maxSize = createdCount.fetch_sub(1) - 1;
            if (maxSize == 0) {
                maxSize = 1;
                available.notify_all();
                return nullptr;
            }
            continue;
        }
        available.wait(lock);
    }
}

void RandomXVmPool::release(randomx_vm* vm) {
    {
        std::lock_guard<std::mutex> lock(mutex);
        idle.push_back(vm);
    }
    available.notify_one();
}

std::shared_ptr<RandomXVmPool> RandomXContext::pool(RandomXVariant variant) {
    std::lock_guard<std::mutex> lock(poolsMutex);
    auto& slot = pools[static_cast<size_t>(variant)];
    if (!slot) {
        slot = std::make_shared<RandomXVmPool>(resources, variant, vmPoolSize);
    }
    return slot;
}

ContextManager& ContextManager::getInstance() {
    // Thread-safe initialization without a lock on every call (called per hash).
    static ContextManager instance;
    return instance;
}

ContextManager::ContextManager()
    : nextContextId(1),
      totalHashes(),
      totalHashTimeMicros(),
      totalVerifications(0),
      cacheHits(0),
      cacheMisses(0) {}

ContextManager::~ContextManager() {
    {
        std::lock_guard<std::mutex> seedLock(seedResourcesMutex);
        seedResources.clear();
        seedInitStates.clear();
    }
    {
        std::lock_guard<std::mutex> lock(contextsMutex);
        contexts.clear();
    }
}

/**
 * Create a new context: shared seed resources plus one eagerly created rx/0 VM, so
 * allocation problems surface here rather than on the first hash. Returns 0 on failure,
 * including allocation failures: an exception must never escape into N-API or a libuv worker.
 */
uint32_t ContextManager::createContext(const uint8_t* seed, size_t seedLength, const RandomXConfig& config) {
    try {
        return createContextUnchecked(seed, seedLength, config);
    } catch (const std::exception&) {
        return 0;
    }
}

uint32_t ContextManager::createContextUnchecked(const uint8_t* seed, size_t seedLength, const RandomXConfig& config) {
    auto resources = acquireSeedResources(std::string(reinterpret_cast<const char*>(seed), seedLength), config);
    if (!resources) {
        return 0;
    }

    auto context = std::make_shared<RandomXContext>();
    context->resources = std::move(resources);
    context->vmPoolSize = std::max<uint32_t>(1, config.vmPoolSize);
    {
        RandomXVmLease lease(context->pool(RandomXVariant::RX0));
        if (!lease.get()) {
            return 0;
        }
    }

    const uint32_t contextId = nextContextId.fetch_add(1);
    {
        std::lock_guard<std::mutex> lock(contextsMutex);
        contexts[contextId] = std::move(context);
    }
    return contextId;
}

/**
 * Release a context. In-flight hashes keep their VM pool and seed resources alive.
 */
bool ContextManager::releaseContext(uint32_t contextId) {
    std::lock_guard<std::mutex> lock(contextsMutex);
    return contexts.erase(contextId) > 0;
}

std::shared_ptr<RandomXContext> ContextManager::getContext(uint32_t contextId) const {
    std::lock_guard<std::mutex> lock(contextsMutex);
    auto it = contexts.find(contextId);
    return it != contexts.end() ? it->second : nullptr;
}

bool ContextManager::getContextInfo(uint32_t contextId, ContextInfo& out) const {
    auto ctx = getContext(contextId);
    if (!ctx) {
        return false;
    }
    out = {};
    out.mode = ctx->resources->config.mode;
    out.hugePages = ctx->resources->config.hugePages;
    out.vmPoolSize = ctx->vmPoolSize;
    out.datasetBacking = ctx->resources->datasetBacking;
    out.cacheBacking = ctx->resources->cacheBacking;

    std::lock_guard<std::mutex> lock(ctx->poolsMutex);
    for (size_t i = 0; i < kVariantCount; i++) {
        if (ctx->pools[i]) {
            out.vms[i] = ctx->pools[i]->created();
            out.hugetlbScratchpads += ctx->pools[i]->hugetlbScratchpads();
        }
    }
    return true;
}

PerformanceStats ContextManager::getStats() const {
    PerformanceStats stats = {};
    stats.totalVerifications = totalVerifications.load();
    stats.cacheHits = cacheHits.load();
    stats.cacheMisses = cacheMisses.load();
    stats.activeVMs = static_cast<uint32_t>(std::max<int64_t>(0, liveVms.load()));

    uint64_t allMicros = 0;
    for (size_t i = 0; i < kVariantCount; i++) {
        const uint64_t n = totalHashes[i].load();
        const uint64_t micros = totalHashTimeMicros[i].load();
        stats.variants[i].totalHashes = n;
        stats.variants[i].averageHashTime = n ? static_cast<double>(micros) / static_cast<double>(n) / 1000.0 : 0.0;
        stats.totalHashes += n;
        allMicros += micros;
    }
    if (stats.totalHashes > 0) {
        stats.averageHashTime = static_cast<double>(allMicros) / static_cast<double>(stats.totalHashes) / 1000.0;
    }

    {
        std::lock_guard<std::mutex> lock(contextsMutex);
        stats.activeContexts = static_cast<uint32_t>(contexts.size());
    }
    {
        std::lock_guard<std::mutex> lock(seedResourcesMutex);
        for (const auto& entry : seedResources) {
            if (auto resources = entry.second.lock()) {
                stats.activeSeeds++;
                stats.datasetBackings[static_cast<size_t>(resources->datasetBacking)]++;
                stats.cacheBackings[static_cast<size_t>(resources->cacheBacking)]++;
            }
        }
    }
    return stats;
}

HardwareInfo ContextManager::getHardwareInfo() const {
    HardwareInfo info = {};

    randomx_flags flags = randomx_get_flags();
    info.hasJit = (flags & RANDOMX_FLAG_JIT) != 0;
    info.hasAes = (flags & RANDOMX_FLAG_HARD_AES) != 0;
    // Not from randomx_get_flags() — that API never sets LARGE_PAGES. This means "RandomX has a
    // large-page allocation path on this OS" (MAP_HUGETLB / Windows / superpages, etc.).
#if defined(__OpenBSD__) || defined(__NetBSD__)
    info.hasHugePages = false;
#elif defined(_WIN32) || defined(__CYGWIN__) || defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__)
    info.hasHugePages = true;
#else
    info.hasHugePages = false;
#endif
    info.cpuCores = std::thread::hardware_concurrency();

#ifdef __linux__
    struct sysinfo si;
    if (sysinfo(&si) == 0) {
        info.totalMemory = static_cast<uint64_t>(si.totalram) * si.mem_unit;
    }
    info.hugePages = readHugePagePool();
    info.thpEnabled = selectedChoice("/sys/kernel/mm/transparent_hugepage/enabled");
    info.thpDefrag = selectedChoice("/sys/kernel/mm/transparent_hugepage/defrag");
#endif

    return info;
}

void ContextManager::recordHash(RandomXVariant variant, uint64_t elapsedMicros) {
    totalHashes[static_cast<size_t>(variant)].fetch_add(1);
    totalHashTimeMicros[static_cast<size_t>(variant)].fetch_add(elapsedMicros);
}

void ContextManager::recordVerification() {
    totalVerifications.fetch_add(1);
}

std::string ContextManager::makeSeedKey(const std::string& seed, const RandomXConfig& config) const {
    std::string key = seed;
    key.push_back(static_cast<char>(config.mode));
    key.push_back(static_cast<char>(config.enableJit ? 1 : 0));
    key.push_back(static_cast<char>(config.enableAes ? 1 : 0));
    key.push_back(static_cast<char>(config.hugePages));
    key.push_back(static_cast<char>(seed.size()));
    return key;
}

/**
 * Return the shared resources for (seed, config), creating them once even when several
 * threads ask for the same seed concurrently.
 */
std::shared_ptr<RandomXSeedResources> ContextManager::acquireSeedResources(const std::string& seed, const RandomXConfig& config) {
    const std::string key = makeSeedKey(seed, config);
    std::shared_ptr<RandomXSeedInitState> initState;
    bool creator = false;

    {
        std::lock_guard<std::mutex> lock(seedResourcesMutex);
        for (auto it = seedResources.begin(); it != seedResources.end();) {
            it = it->second.expired() ? seedResources.erase(it) : std::next(it);
        }
        auto it = seedResources.find(key);
        if (it != seedResources.end()) {
            // The last owner may release outside this mutex, so lock() can still come back empty.
            if (auto existing = it->second.lock()) {
                cacheHits.fetch_add(1);
                return existing;
            }
            seedResources.erase(it);
        }

        auto initIt = seedInitStates.find(key);
        if (initIt != seedInitStates.end()) {
            initState = initIt->second;
        } else {
            initState = std::make_shared<RandomXSeedInitState>();
            seedInitStates[key] = initState;
            creator = true;
        }
    }

    if (!creator) {
        std::unique_lock<std::mutex> waitLock(initState->mutex);
        initState->cv.wait(waitLock, [&initState]() { return initState->done; });
        return initState->resources;
    }

    cacheMisses.fetch_add(1);
    // Whatever happens, finish initState: waiters would otherwise block forever, and the stale
    // entry would make every later request for this seed wait too.
    std::shared_ptr<RandomXSeedResources> resources;
    try {
        resources = createSeedResources(seed, config);
    } catch (const std::exception&) {
        resources = nullptr;  // e.g. bad_alloc in randomx_init_cache; partial buffers are freed
    }

    {
        std::lock_guard<std::mutex> lock(seedResourcesMutex);
        if (resources) {
            seedResources[key] = resources;
        }
        seedInitStates.erase(key);
    }
    {
        std::lock_guard<std::mutex> waitLock(initState->mutex);
        initState->resources = resources;
        initState->done = true;
    }
    initState->cv.notify_all();
    return resources;
}

/**
 * Allocate and initialize the cache (and in fast mode the dataset) for one seed.
 * Fast mode allocates its long-lived dataset before the temporary cache so a constrained
 * reserved huge-page pool benefits hashing rather than dataset initialization.
 * Each buffer records which memory backing it got.
 */
std::shared_ptr<RandomXSeedResources> ContextManager::createSeedResources(const std::string& seed, const RandomXConfig& config) {
    auto resources = std::make_shared<RandomXSeedResources>();
    resources->seed = seed;
    resources->config = config;

    const randomx_flags flags = baseFlags(config);
    const bool fast = config.mode == RandomXMode::FAST;
    resources->vmFlags = fast ? static_cast<randomx_flags>(flags | RANDOMX_FLAG_FULL_MEM) : flags;

    const unsigned long itemCount = fast ? randomx_dataset_item_count() : 0;
    if (fast) {
        resources->dataset = allocWithBacking<randomx_dataset>(
            flags, config.hugePages, static_cast<size_t>(itemCount) * RANDOMX_DATASET_ITEM_SIZE,
            randomx_alloc_dataset, randomx_get_dataset_memory, resources->datasetBacking);
        if (!resources->dataset) {
            return nullptr;
        }
    }

    resources->cache = allocWithBacking<randomx_cache>(
        flags, config.hugePages, kCacheBytes,
        randomx_alloc_cache, randomx_get_cache_memory, resources->cacheBacking);
    if (!resources->cache) {
        return nullptr;
    }
    randomx_init_cache(resources->cache, seed.data(), seed.size());

    if (!fast) {
        return resources;
    }

    const uint32_t numThreads = std::max<uint32_t>(1, config.threads);
    randomx_dataset* dataset = resources->dataset;
    randomx_cache* cache = resources->cache;
    auto initChunk = [=](uint32_t i) {
        const unsigned long start = itemCount * i / numThreads;
        const unsigned long end = itemCount * (i + 1) / numThreads;
        randomx_init_dataset(dataset, cache, start, end - start);
    };
    // Chunk 0, and any chunk whose thread can't be started (thread limits), runs here: an
    // exception escaping a libuv worker would abort the process.
    std::vector<std::thread> initThreads;
    uint32_t spawned = 1;
    try {
        initThreads.reserve(numThreads - 1);
        for (; spawned < numThreads; spawned++) {
            initThreads.emplace_back(initChunk, spawned);
        }
    } catch (const std::exception&) {
    }
    for (uint32_t i = spawned; i < numThreads; i++) {
        initChunk(i);
    }
    initChunk(0);
    for (auto& thread : initThreads) {
        thread.join();
    }

    // Fast-mode VMs never read the cache; keep only the dataset (~256 MB less per seed).
    randomx_release_cache(resources->cache);
    resources->cache = nullptr;
    resources->cacheBacking = MemoryBacking::NONE; // report memory held, not memory once used
    return resources;
}
