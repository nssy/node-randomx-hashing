/**
 * RandomX Context Manager Header
 * Efficient context reuse and memory management
 */

#ifndef CONTEXT_MANAGER_H
#define CONTEXT_MANAGER_H

#include <cstdint>
#include <memory>
#include <unordered_map>
#include <mutex>
#include <atomic>
#include <cstring>

extern "C" {
    #include "randomx.h"
}

/**
 * RandomX mode enumeration
 */
enum class RandomXMode {
    AUTO,   // Automatically choose based on usage
    FAST,   // Full memory mode (~2GB) - for mining
    LIGHT   // Light mode (~256MB) - for verification
};

/**
 * RandomX configuration structure
 */
struct RandomXConfig {
    bool enableJit;
    bool enableAes;
    bool enableHugePages;
    uint32_t threads;
    RandomXMode mode;
};

/**
 * RandomX context wrapper
 */
struct RandomXContext {
    randomx_dataset* dataset;
    randomx_cache* cache;
    randomx_vm* vm;
    uint8_t seed[32];
    RandomXConfig config;
    std::atomic<uint64_t> hashCount;
    std::atomic<uint64_t> lastUsed;
    /** Set at creation: RANDOMX_FLAG_LARGE_PAGES was included in alloc flags. */
    bool usedLargePages;
    /** randomx_vm is not thread-safe; serialize hashing like p2pool's per-VM mutex. */
    std::mutex hashMutex;

    RandomXContext()
        : dataset(nullptr),
          cache(nullptr),
          vm(nullptr),
          hashCount(0),
          lastUsed(0),
          usedLargePages(false) {
        memset(seed, 0, 32);
    }

    ~RandomXContext();
};

/**
 * Performance statistics
 */
struct PerformanceStats {
    uint64_t totalHashes;
    uint64_t totalVerifications;
    uint32_t activeContexts;
    double averageHashTime;
    uint64_t cacheHits;
    uint64_t cacheMisses;
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
    uint32_t hugePagesAvailable;
};

/**
 * Context Manager - Singleton for efficient context reuse
 */
class ContextManager {
private:
    static std::unique_ptr<ContextManager> instance;
    static std::mutex instanceMutex;

    std::unordered_map<uint32_t, std::unique_ptr<RandomXContext>> contexts;
    std::mutex contextsMutex;
    std::atomic<uint32_t> nextContextId;

    // Performance tracking
    std::atomic<uint64_t> totalHashes;
    std::atomic<uint64_t> totalHashTimeMicros;
    std::atomic<uint64_t> totalVerifications;
    std::atomic<uint64_t> cacheHits;
    std::atomic<uint64_t> cacheMisses;

    ContextManager();

    // Hardware setup functions
    void setupHugePages();
    void optimizeHardware();
    randomx_flags getOptimalFlags(const RandomXConfig& config);

public:
    static ContextManager& getInstance();

    ~ContextManager();

    // Context management
    uint32_t createContext(const uint8_t* seed, const RandomXConfig& config);
    bool releaseContext(uint32_t contextId);
    /** @param updateLastUsed if false, do not touch lastUsed (e.g. getContextInfo introspection). */
    RandomXContext* getContext(uint32_t contextId, bool updateLastUsed = true);

    /** Snapshot metadata for a context (invalid id => false). */
    bool getContextInfo(uint32_t contextId, bool& outUsedLargePages, bool& outRequestedLargePages, RandomXMode& outMode);

    // Statistics and info
    PerformanceStats getStats() const;
    HardwareInfo getHardwareInfo() const;

    // Performance tracking
    void recordHash(uint32_t contextId, uint64_t elapsedMicros);
    void recordVerification(uint32_t contextId);
};

#endif // CONTEXT_MANAGER_H
