/**
 * Share Verifier Implementation
 * RandomX hash / PoW computation and share checks
 */

#include "share_verifier.h"
#include <chrono>
#include <cmath>
#include <cstring>
#include <limits>

bool ShareVerifier::compute(
    const std::shared_ptr<RandomXContext>& context,
    RandomXVariant variant,
    const uint8_t* input,
    size_t inputLength,
    uint8_t* hash,
    uint8_t* pow
) {
    // Never let an exception (bad_alloc creating the pool) escape into N-API or a libuv worker.
    std::shared_ptr<RandomXVmPool> pool;
    try {
        pool = context->pool(variant);
    } catch (const std::exception&) {
        return false;
    }
    RandomXVmLease lease(std::move(pool));
    if (!lease.get()) {
        return false;
    }

    const auto t0 = std::chrono::steady_clock::now();
    randomx_calculate_hash(lease.get(), input, inputLength, hash);
    const auto t1 = std::chrono::steady_clock::now();
    ContextManager::getInstance().recordHash(
        variant, static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count()));

    if (pow) {
        if (variant == RandomXVariant::RX2) {
            randomx_calculate_commitment(input, inputLength, hash, pow);
        } else {
            std::memcpy(pow, hash, RANDOMX_HASH_SIZE);
        }
    }
    return true;
}

bool ShareVerifier::verifyShare(
    const std::shared_ptr<RandomXContext>& context,
    RandomXVariant variant,
    const uint8_t* input,
    size_t inputLength,
    const uint8_t* target,
    const uint8_t* expected,
    ShareVerificationResult& result
) {
    result = {};

    const auto startTime = std::chrono::steady_clock::now();
    if (!compute(context, variant, input, inputLength, result.hash, result.pow)) {
        return false;
    }
    result.hashTime = std::chrono::duration_cast<std::chrono::microseconds>(
        std::chrono::steady_clock::now() - startTime).count() / 1000.0;

    result.difficulty = calculateDifficulty(result.pow);
    result.valid = meetsTarget(result.pow, target) &&
        (!expected || std::memcmp(result.pow, expected, RANDOMX_HASH_SIZE) == 0);

    ContextManager::getInstance().recordVerification();
    return true;
}

double ShareVerifier::calculateDifficulty(const uint8_t* pow) {
    double value = 0.0;
    for (int i = RANDOMX_HASH_SIZE - 1; i >= 0; --i) {
        value = value * 256.0 + pow[i];
    }
    return value == 0.0 ? std::numeric_limits<double>::infinity() : std::ldexp(1.0, 256) / value;
}

bool ShareVerifier::meetsTarget(const uint8_t* pow, const uint8_t* target) {
    for (int i = RANDOMX_HASH_SIZE - 1; i >= 0; --i) {
        if (pow[i] != target[i]) {
            return pow[i] < target[i];
        }
    }
    return true;
}
