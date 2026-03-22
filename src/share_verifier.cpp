/**
 * Share Verifier Implementation
 * High-performance mining share verification
 */

#include "share_verifier.h"
#include "context_manager.h"
#include <cstring>
#include <cmath>
#include <limits>

extern "C" {
    #include "randomx.h"
}

/**
 * Verify a mining share
 */
bool ShareVerifier::verifyShare(
    uint32_t contextId,
    const uint8_t* input,
    size_t inputLength,
    const uint8_t* target,
    const uint8_t* expectedHash,
    ShareVerificationResult& result
) {
    result = {};
    auto startTime = std::chrono::high_resolution_clock::now();

    // Get RandomX context
    RandomXContext* context = ContextManager::getInstance().getContext(contextId);
    if (!context || !context->vm) {
        return false;
    }

    // Calculate hash
    if (!calculateHash(contextId, input, inputLength, result.hash)) {
        return false;
    }

    // Record timing
    auto endTime = std::chrono::high_resolution_clock::now();
    result.hashTime = std::chrono::duration_cast<std::chrono::microseconds>(
        endTime - startTime).count() / 1000.0;

    // Calculate difficulty
    result.difficulty = calculateDifficulty(result.hash);

    // Check if hash meets target
    result.valid = meetsTarget(result.hash, target);

    // Verify against expected hash if provided
    if (expectedHash && result.valid) {
        result.valid = (memcmp(result.hash, expectedHash, 32) == 0);
    }

    // Record verification for performance tracking
    ContextManager::getInstance().recordVerification(contextId);

    return true;
}

/**
 * Calculate RandomX hash
 */
bool ShareVerifier::calculateHash(
    uint32_t contextId,
    const uint8_t* input,
    size_t inputLength,
    uint8_t* output
) {
    // Get RandomX context
    RandomXContext* context = ContextManager::getInstance().getContext(contextId);
    if (!context || !context->vm) {
        return false;
    }

    // Calculate hash using RandomX VM
    randomx_calculate_hash(context->vm, input, inputLength, output);

    // Record hash operation for performance tracking
    ContextManager::getInstance().recordHash(contextId);

    return true;
}

/**
 * Calculate difficulty from hash
 */
double ShareVerifier::calculateDifficulty(const uint8_t* hash) {
    // Convert hash to big integer for calculation
    uint8_t hashBigInt[32];
    hashToBigInt(hash, hashBigInt);

    // Find the most significant non-zero byte
    int msbIndex = -1;
    for (int i = 0; i < 32; ++i) {
        if (hashBigInt[i] != 0) {
            msbIndex = i;
            break;
        }
    }

    if (msbIndex == -1) {
        // Hash is zero, maximum difficulty
        return std::numeric_limits<double>::infinity();
    }

    // Calculate difficulty based on leading zeros and MSB value
    int leadingZeros = msbIndex * 8;
    uint8_t msbValue = hashBigInt[msbIndex];

    // Count leading zeros in the MSB
    int msbLeadingZeros = 0;
    for (int i = 7; i >= 0; --i) {
        if ((msbValue >> i) & 1) {
            break;
        }
        msbLeadingZeros++;
    }

    leadingZeros += msbLeadingZeros;

    // Calculate difficulty: 2^(256 - leading_zeros) / (remaining_bits)
    double difficulty = std::pow(2.0, 256 - leadingZeros);

    // Adjust for remaining bits precision
    if (msbLeadingZeros < 8) {
        uint16_t remainingBits = msbValue << msbLeadingZeros;
        if (msbIndex + 1 < 32) {
            remainingBits |= (hashBigInt[msbIndex + 1] >> (8 - msbLeadingZeros));
        }
        difficulty /= (remainingBits + 1);
    }

    return difficulty;
}

/**
 * Check if hash meets target difficulty
 */
bool ShareVerifier::meetsTarget(const uint8_t* hash, const uint8_t* target) {
    // Convert both hash and target to big integers
    uint8_t hashBigInt[32];
    uint8_t targetBigInt[32];

    hashToBigInt(hash, hashBigInt);
    hashToBigInt(target, targetBigInt);

    // Compare: hash should be <= target
    return compareBigInt(hashBigInt, targetBigInt) <= 0;
}

/**
 * Convert hash to big integer (little-endian to big-endian)
 */
void ShareVerifier::hashToBigInt(const uint8_t* hash, uint8_t* result) {
    // RandomX produces little-endian hash, convert to big-endian for comparison
    for (int i = 0; i < 32; ++i) {
        result[i] = hash[31 - i];
    }
}

/**
 * Compare two big integers (big-endian)
 */
int ShareVerifier::compareBigInt(const uint8_t* a, const uint8_t* b) {
    for (int i = 0; i < 32; ++i) {
        if (a[i] < b[i]) {
            return -1;
        } else if (a[i] > b[i]) {
            return 1;
        }
    }
    return 0; // Equal
}
