/**
 * Share Verifier Header
 * High-performance mining share verification
 */

#ifndef SHARE_VERIFIER_H
#define SHARE_VERIFIER_H

#include <cstdint>
#include <chrono>
#include <memory>

struct RandomXContext;

/**
 * Share verification result structure
 */
struct ShareVerificationResult {
    bool valid;
    double difficulty;
    uint8_t hash[32];
    double hashTime; // Time in milliseconds
};

/**
 * Share Verifier - High-performance share verification functions
 */
class ShareVerifier {
public:
        /**
     * Verify a mining share
     * @param contextId RandomX context ID
     * @param input Input data to hash
     * @param inputLength Length of input data
     * @param target Target difficulty (32 bytes, little-endian)
     * @param expectedHash Expected hash result (optional, 32 bytes)
     * @param result Output verification result
     * @return True if successful, false on error
     */
    static bool verifyShare(
        uint32_t contextId,
        const uint8_t* input,
        size_t inputLength,
        const uint8_t* target,
        const uint8_t* expectedHash,
        ShareVerificationResult& result
    );

    /**
     * Calculate RandomX hash
     * @param contextId RandomX context ID
     * @param input Input data to hash
     * @param inputLength Length of input data
     * @param output Output buffer (32 bytes)
     * @return True if successful, false on error
     */
    static bool calculateHash(
        uint32_t contextId,
        const uint8_t* input,
        size_t inputLength,
        uint8_t* output
    );

    static bool calculateHash(
        const std::shared_ptr<RandomXContext>& context,
        uint32_t contextId,
        const uint8_t* input,
        size_t inputLength,
        uint8_t* output
    );

    /**
     * Calculate difficulty from hash
     * @param hash Hash to analyze (32 bytes)
     * @return Difficulty value
     */
    static double calculateDifficulty(const uint8_t* hash);

    /**
     * Check if hash meets target difficulty
     * @param hash Hash to check (32 bytes)
     * @param target Target to compare against (32 bytes, little-endian)
     * @return True if hash meets target
     */
    static bool meetsTarget(const uint8_t* hash, const uint8_t* target);

private:
    /**
     * Convert hash to big integer for comparison
     * @param hash Input hash (32 bytes)
     * @param result Output big integer (32 bytes, big-endian)
     */
    static void hashToBigInt(const uint8_t* hash, uint8_t* result);

    /**
     * Compare two big integers
     * @param a First integer (32 bytes, big-endian)
     * @param b Second integer (32 bytes, big-endian)
     * @return -1 if a < b, 0 if a == b, 1 if a > b
     */
    static int compareBigInt(const uint8_t* a, const uint8_t* b);
};

#endif // SHARE_VERIFIER_H
