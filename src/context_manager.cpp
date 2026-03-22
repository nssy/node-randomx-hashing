/**
 * RandomX Context Manager Implementation
 * Efficient context reuse and memory management
 */

#include "context_manager.h"
#include <chrono>
#include <cstring>
#include <cstdio>
#include <thread>
#include <vector>
#include <future>

#ifdef __linux__
#include <sys/mman.h>
#include <unistd.h>
#include <numa.h>
#include <sys/sysinfo.h>
#endif

std::unique_ptr<ContextManager> ContextManager::instance = nullptr;
std::mutex ContextManager::instanceMutex;

/**
 * RandomXContext destructor
 */
RandomXContext::~RandomXContext() {
    if (vm) {
        randomx_destroy_vm(vm);
        vm = nullptr;
    }
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
    : nextContextId(1), totalHashes(0), totalVerifications(0), cacheHits(0), cacheMisses(0) {

    // Initialize hardware optimizations
    optimizeHardware();
}

/**
 * Destructor
 */
ContextManager::~ContextManager() {
    std::lock_guard<std::mutex> lock(contextsMutex);
    contexts.clear();
}

/**
 * Set up huge pages for better performance
 */
void ContextManager::setupHugePages() {
#ifdef __linux__
    // Enable transparent huge pages
    system("echo madvise > /sys/kernel/mm/transparent_hugepage/enabled");
    system("echo madvise > /sys/kernel/mm/transparent_hugepage/defrag");

    // Allocate huge pages (estimate based on RandomX memory requirements)
    const size_t hugePagesNeeded = (2048 + 32) / 2 + 1; // ~1000 2MB pages for dataset + cache
    char cmd[256];
    snprintf(cmd, sizeof(cmd), "echo %zu > /proc/sys/vm/nr_hugepages", hugePagesNeeded);
    system(cmd);
#endif
}

/**
 * Optimize hardware settings for maximum performance
 */
void ContextManager::optimizeHardware() {
#ifdef __linux__
    // Disable hardware prefetchers for better cache utilization
    system("echo 0 > /sys/devices/system/cpu/cpufreq/boost");

    // Set CPU governor to performance
    system("echo performance | tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor");

    // Disable CPU frequency scaling
    system("echo 1 > /sys/devices/system/cpu/intel_pstate/no_turbo");

    // Setup NUMA if available
    if (numa_available() != -1) {
        numa_set_localalloc();
    }

    setupHugePages();
#endif
}

/**
 * Get optimal RandomX flags based on configuration
 */
randomx_flags ContextManager::getOptimalFlags(const RandomXConfig& config) {
    randomx_flags flags = RANDOMX_FLAG_DEFAULT;

    if (config.enableJit) {
        flags |= RANDOMX_FLAG_JIT;
    }

    if (config.enableAes) {
        flags |= RANDOMX_FLAG_HARD_AES;
    }

    // Enable large pages only for fast mode and when explicitly requested
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
        case RandomXMode::AUTO:
            // Default to light mode for verification workloads
            // Fast mode should be explicitly requested for mining
            break;
    }

    return flags;
}

/**
 * Create a new RandomX context
 */
uint32_t ContextManager::createContext(const uint8_t* seed, const RandomXConfig& config) {
    auto context = std::make_unique<RandomXContext>();
    memcpy(context->seed, seed, 32);
    context->config = config;

    // Get optimal flags
    randomx_flags flags = getOptimalFlags(config);

    // Create cache
    context->cache = randomx_alloc_cache(flags);
    if (!context->cache) {
        return 0; // Failed to allocate cache
    }

    // Initialize cache with seed
    randomx_init_cache(context->cache, seed, 32);

    // Create dataset only for fast mode
    if (config.mode == RandomXMode::FAST) {
        context->dataset = randomx_alloc_dataset(flags);
        if (!context->dataset) {
            randomx_release_cache(context->cache);
            return 0; // Failed to allocate dataset
        }

        // Initialize dataset with multiple threads for faster warmup
        auto datasetItemCount = randomx_dataset_item_count();
        uint32_t numThreads = config.threads;

        if (numThreads > 1) {
            // Multi-threaded initialization for maximum performance
            std::vector<std::thread> initThreads;
            auto itemsPerThread = datasetItemCount / numThreads;
            auto remainder = datasetItemCount % numThreads;

            // Get raw pointers for thread-safe access
            randomx_dataset* dataset = context->dataset;
            randomx_cache* cache = context->cache;

            for (uint32_t i = 0; i < numThreads; i++) {
                auto startItem = i * itemsPerThread;
                auto itemCount = itemsPerThread;

                // Last thread gets the remainder items
                if (i == numThreads - 1) {
                    itemCount += remainder;
                }

                initThreads.emplace_back([dataset, cache, startItem, itemCount]() {
                    randomx_init_dataset(dataset, cache, startItem, itemCount);
                });
            }

            // Wait for all threads to complete
            for (auto& thread : initThreads) {
                thread.join();
            }
        } else {
            // Single-threaded fallback
            randomx_init_dataset(context->dataset, context->cache, 0, datasetItemCount);
        }

        // Dataset initialization completed (timing removed for production)
    }

    // Create VM (with or without dataset depending on mode)
    context->vm = randomx_create_vm(flags, context->cache, context->dataset);
    if (!context->vm) {
        if (context->dataset) {
            randomx_release_dataset(context->dataset);
        }
        randomx_release_cache(context->cache);
        return 0; // Failed to create VM
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
RandomXContext* ContextManager::getContext(uint32_t contextId) {
    std::lock_guard<std::mutex> lock(contextsMutex);
    auto it = contexts.find(contextId);
    if (it != contexts.end()) {
        // Update last used timestamp
        it->second->lastUsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now().time_since_epoch()).count();
        return it->second.get();
    }
    return nullptr;
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

        // Calculate average hash time
        uint64_t totalHashCount = 0;
        for (const auto& pair : contexts) {
            totalHashCount += pair.second->hashCount.load();
        }

        if (totalHashCount > 0) {
            stats.averageHashTime = static_cast<double>(stats.totalHashes) / totalHashCount;
        }
    }

    return stats;
}

/**
 * Get hardware capability information
 */
HardwareInfo ContextManager::getHardwareInfo() const {
    HardwareInfo info = {};

    // Check RandomX capabilities
    randomx_flags flags = randomx_get_flags();
    info.hasJit = (flags & RANDOMX_FLAG_JIT) != 0;
    info.hasAes = (flags & RANDOMX_FLAG_HARD_AES) != 0;
    info.hasHugePages = (flags & RANDOMX_FLAG_LARGE_PAGES) != 0;

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
void ContextManager::recordHash(uint32_t contextId) {
    totalHashes.fetch_add(1);

    RandomXContext* context = getContext(contextId);
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
