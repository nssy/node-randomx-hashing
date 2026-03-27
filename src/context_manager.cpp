/**
 * RandomX Context Manager Implementation
 * Efficient context reuse and memory management
 */

#include "context_manager.h"
#include <chrono>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <thread>
#include <vector>

#ifdef __linux__
#include <sys/sysinfo.h>
#endif

std::unique_ptr<ContextManager> ContextManager::instance = nullptr;
std::mutex ContextManager::instanceMutex;

/**
 * RandomXSeedResources destructor
 */
RandomXSeedResources::~RandomXSeedResources() {
    if (dataset) {
        randomx_release_dataset(dataset);
        dataset = nullptr;
    }
    if (cache) {
        randomx_release_cache(cache);
        cache = nullptr;
    }
}

/**
 * RandomXContext destructor
 */
RandomXContext::~RandomXContext() {
    if (vm) {
        randomx_destroy_vm(vm);
        vm = nullptr;
    }
    resources.reset();
}

/**
 * Get singleton instance
 */
ContextManager& ContextManager::getInstance() {
    std::lock_guard<std::mutex> lock(instanceMutex);
    if (!instance) {
        instance = std::unique_ptr<ContextManager>(new ContextManager());
    }
    return *instance;
}

/**
 * Private constructor
 */
ContextManager::ContextManager()
    : nextContextId(1),
      totalHashes(0),
      totalHashTimeMicros(0),
      totalVerifications(0),
      cacheHits(0),
      cacheMisses(0) {}

/**
 * Destructor
 */
ContextManager::~ContextManager() {
    std::lock_guard<std::mutex> lock(contextsMutex);
    contexts.clear();
    std::lock_guard<std::mutex> seedLock(seedResourcesMutex);
    seedResources.clear();
    seedInitStates.clear();
}

randomx_flags ContextManager::getOptimalFlags(const RandomXConfig& config) {
    randomx_flags flags = RANDOMX_FLAG_DEFAULT;

    if (config.enableJit) {
        flags |= RANDOMX_FLAG_JIT;
    }

    if (config.enableAes) {
        flags |= RANDOMX_FLAG_HARD_AES;
    }

    // randomx_get_flags() does NOT include RANDOMX_FLAG_LARGE_PAGES (RandomX upstream design;
    // see api-example2.cpp: flags = randomx_get_flags(); flags |= RANDOMX_FLAG_LARGE_PAGES).
    // When set, randomx_alloc_cache/dataset catch failures and return nullptr — no extra build flag needed.
    if (config.enableHugePages && config.mode == RandomXMode::FAST) {
        flags |= RANDOMX_FLAG_LARGE_PAGES;
    }

    // Set memory mode based on configuration
    switch (config.mode) {
        case RandomXMode::FAST:
            flags |= RANDOMX_FLAG_FULL_MEM;
            break;
        case RandomXMode::LIGHT:
            // Light mode: don't add RANDOMX_FLAG_FULL_MEM
            break;
    }

    return flags;
}

/**
 * Create a new RandomX context
 */
uint32_t ContextManager::createContext(const uint8_t* seed, const RandomXConfig& config) {
    auto resources = acquireSeedResources(seed, config);
    if (!resources) {
        return 0;
    }

    auto context = std::make_shared<RandomXContext>();
    context->resources = resources;

    context->vm = randomx_create_vm(resources->flags, resources->cache, resources->dataset);
    if (!context->vm) {
        return 0;
    }

    // Set last used timestamp
    context->lastUsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();

    // Store context and return ID
    uint32_t contextId = nextContextId.fetch_add(1);
    {
        std::lock_guard<std::mutex> lock(contextsMutex);
        contexts[contextId] = std::move(context);
    }

    return contextId;
}

/**
 * Release a RandomX context
 */
bool ContextManager::releaseContext(uint32_t contextId) {
    std::lock_guard<std::mutex> lock(contextsMutex);
    auto it = contexts.find(contextId);
    if (it != contexts.end()) {
        contexts.erase(it);
        return true;
    }
    return false;
}

/**
 * Get a RandomX context by ID
 */
std::shared_ptr<RandomXContext> ContextManager::getContext(uint32_t contextId, bool updateLastUsed) {
    std::lock_guard<std::mutex> lock(contextsMutex);
    auto it = contexts.find(contextId);
    if (it != contexts.end()) {
        if (updateLastUsed) {
            it->second->lastUsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now().time_since_epoch()).count();
        }
        return it->second;
    }
    return nullptr;
}

bool ContextManager::getContextInfo(
    uint32_t contextId,
    bool& outUsedLargePages,
    bool& outRequestedLargePages,
    RandomXMode& outMode
) {
    auto ctx = getContext(contextId, false);
    if (!ctx) {
        return false;
    }
    outUsedLargePages = ctx->resources && ctx->resources->usedLargePages;
    outRequestedLargePages = ctx->resources && ctx->resources->config.enableHugePages;
    outMode = ctx->resources ? ctx->resources->config.mode : RandomXMode::LIGHT;
    return true;
}

/**
 * Get performance statistics
 */
PerformanceStats ContextManager::getStats() const {
    PerformanceStats stats = {};
    stats.totalHashes = totalHashes.load();
    stats.totalVerifications = totalVerifications.load();
    stats.cacheHits = cacheHits.load();
    stats.cacheMisses = cacheMisses.load();

    {
        std::lock_guard<std::mutex> lock(const_cast<std::mutex&>(contextsMutex));
        stats.activeContexts = contexts.size();
    }
    {
        std::lock_guard<std::mutex> lock(const_cast<std::mutex&>(seedResourcesMutex));
        uint32_t activeSeeds = 0;
        for (const auto& entry : seedResources) {
            if (!entry.second.expired()) {
                activeSeeds++;
            }
        }
        stats.activeSeeds = activeSeeds;
    }

    const uint64_t n = stats.totalHashes;
    if (n > 0) {
        stats.averageHashTime =
            static_cast<double>(totalHashTimeMicros.load()) / static_cast<double>(n) / 1000.0;
    }

    return stats;
}

/**
 * Get hardware capability information
 */
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

#ifdef __linux__
    // Get system information
    info.cpuCores = std::thread::hardware_concurrency();

    struct sysinfo si;
    if (sysinfo(&si) == 0) {
        info.totalMemory = si.totalram * si.mem_unit;
    }

    // Check huge pages availability
    FILE* fp = fopen("/proc/meminfo", "r");
    if (fp) {
        char line[256];
        while (fgets(line, sizeof(line), fp)) {
            if (strncmp(line, "HugePages_Free:", 15) == 0) {
                sscanf(line + 15, "%u", &info.hugePagesAvailable);
                break;
            }
        }
        fclose(fp);
    }
#else
    info.cpuCores = std::thread::hardware_concurrency();
    info.totalMemory = 0; // Platform-specific implementation needed
    info.hugePagesAvailable = 0;
#endif

    return info;
}

/**
 * Record hash operation for performance tracking
 */
void ContextManager::recordHash(uint32_t contextId, uint64_t elapsedMicros) {
    totalHashes.fetch_add(1);
    totalHashTimeMicros.fetch_add(elapsedMicros);

    auto context = getContext(contextId);
    if (context) {
        context->hashCount.fetch_add(1);
    }
}

/**
 * Record verification operation for performance tracking
 */
void ContextManager::recordVerification(uint32_t contextId) {
    totalVerifications.fetch_add(1);
}

std::string ContextManager::makeSeedKey(const uint8_t* seed, const RandomXConfig& config) const {
    std::string key(reinterpret_cast<const char*>(seed), 32);
    key.push_back(static_cast<char>(config.mode));
    key.push_back(static_cast<char>(config.enableJit ? 1 : 0));
    key.push_back(static_cast<char>(config.enableAes ? 1 : 0));
    key.push_back(static_cast<char>(config.enableHugePages ? 1 : 0));
    return key;
}

std::shared_ptr<RandomXSeedResources> ContextManager::acquireSeedResources(const uint8_t* seed, const RandomXConfig& config) {
    const std::string key = makeSeedKey(seed, config);
    std::shared_ptr<RandomXSeedInitState> initState;
    bool creator = false;

    {
        std::lock_guard<std::mutex> lock(seedResourcesMutex);
        auto it = seedResources.find(key);
        if (it != seedResources.end()) {
            auto existing = it->second.lock();
            if (existing) {
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
        initState->cv.wait(waitLock, [&initState]() {
            return initState->done;
        });
        return initState->resources;
    }

    auto resources = std::make_shared<RandomXSeedResources>();
    memcpy(resources->seed, seed, 32);
    resources->config = config;
    resources->flags = getOptimalFlags(config);
    resources->usedLargePages =
        (static_cast<int>(resources->flags) & static_cast<int>(RANDOMX_FLAG_LARGE_PAGES)) != 0;

    resources->cache = randomx_alloc_cache(resources->flags);
    if (!resources->cache) {
        {
            std::lock_guard<std::mutex> waitLock(initState->mutex);
            initState->resources.reset();
            initState->done = true;
        }
        {
            std::lock_guard<std::mutex> lock(seedResourcesMutex);
            seedInitStates.erase(key);
        }
        initState->cv.notify_all();
        return nullptr;
    }

    randomx_init_cache(resources->cache, seed, 32);

    if (config.mode == RandomXMode::FAST) {
        resources->dataset = randomx_alloc_dataset(resources->flags);
        if (!resources->dataset) {
            {
                std::lock_guard<std::mutex> waitLock(initState->mutex);
                initState->resources.reset();
                initState->done = true;
            }
            {
                std::lock_guard<std::mutex> lock(seedResourcesMutex);
                seedInitStates.erase(key);
            }
            initState->cv.notify_all();
            return nullptr;
        }

        auto datasetItemCount = randomx_dataset_item_count();
        uint32_t numThreads = config.threads;

        if (numThreads > 1) {
            std::vector<std::thread> initThreads;
            auto itemsPerThread = datasetItemCount / numThreads;
            auto remainder = datasetItemCount % numThreads;

            randomx_dataset* dataset = resources->dataset;
            randomx_cache* cache = resources->cache;

            for (uint32_t i = 0; i < numThreads; i++) {
                auto startItem = i * itemsPerThread;
                auto itemCount = itemsPerThread;
                if (i == numThreads - 1) {
                    itemCount += remainder;
                }

                initThreads.emplace_back([dataset, cache, startItem, itemCount]() {
                    randomx_init_dataset(dataset, cache, startItem, itemCount);
                });
            }

            for (auto& thread : initThreads) {
                thread.join();
            }
        } else {
            randomx_init_dataset(resources->dataset, resources->cache, 0, datasetItemCount);
        }
    }

    {
        std::lock_guard<std::mutex> waitLock(initState->mutex);
        initState->resources = resources;
        initState->done = true;
    }
    {
        std::lock_guard<std::mutex> lock(seedResourcesMutex);
        auto& slot = seedResources[key];
        auto existing = slot.lock();
        if (existing) {
            seedInitStates.erase(key);
            initState->cv.notify_all();
            return existing;
        }
        slot = resources;
        seedInitStates.erase(key);
    }

    initState->cv.notify_all();

    return resources;
}
