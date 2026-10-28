/**
 * Share Verifier Header
 * RandomX hash / PoW computation and share checks
 */

#ifndef SHARE_VERIFIER_H
#define SHARE_VERIFIER_H

#include <cstddef>
#include <cstdint>
#include <memory>

#include "context_manager.h"

/**
 * Share verification result structure
 */
struct ShareVerificationResult {
    bool valid;
    double difficulty;
    uint8_t hash[32];  // raw RandomX hash
    uint8_t pow[32];   // value compared with the target: hash for rx/0, commitment for rx/2
    double hashTime;   // Time in milliseconds
};

class ShareVerifier {
public:
    /**
     * Compute the RandomX hash and PoW of `input` on any idle VM of the context's variant pool.
     * @param pow optional; receives the commitment for rx/2 and a copy of the hash for rx/0
     * @return false if no VM could be created
     */
    static bool compute(
        const std::shared_ptr<RandomXContext>& context,
        RandomXVariant variant,
        const uint8_t* input,
        size_t inputLength,
        uint8_t* hash,
        uint8_t* pow
    );

    /**
     * Verify a share: pow <= target, and pow == expected when `expected` is given (miners submit
     * the PoW as `result`).
     */
    static bool verifyShare(
        const std::shared_ptr<RandomXContext>& context,
        RandomXVariant variant,
        const uint8_t* input,
        size_t inputLength,
        const uint8_t* target,
        const uint8_t* expected,
        ShareVerificationResult& result
    );

    /** Difficulty of a PoW value: 2^256 / pow, pow read as a little-endian 256-bit number. */
    static double calculateDifficulty(const uint8_t* pow);

    /** pow <= target, both little-endian 256-bit numbers. */
    static bool meetsTarget(const uint8_t* pow, const uint8_t* target);
};

#endif // SHARE_VERIFIER_H
