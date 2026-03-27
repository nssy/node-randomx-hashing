/**
 * RandomX N-API Addon Main Module
 * High-performance share verification for mining pools
 */

#include <napi.h>
#include "context_manager.h"
#include "share_verifier.h"
#include <string>
#include <memory>
#include <array>
#include <vector>

static const char* randomModeToString(RandomXMode mode) {
    switch (mode) {
        case RandomXMode::FAST:
            return "fast";
        case RandomXMode::LIGHT:
            return "light";
        default:
            return "unknown";
    }
}

class HashAsyncWorker : public Napi::AsyncWorker {
public:
    HashAsyncWorker(
        Napi::Env env,
        std::shared_ptr<RandomXContext> context,
        uint32_t contextId,
        const uint8_t* input,
        size_t inputLength
    )
        : Napi::AsyncWorker(env),
          deferred(Napi::Promise::Deferred::New(env)),
          context(std::move(context)),
          contextId(contextId),
          input(input, input + inputLength) {}

    void Execute() override {
        if (!context || !context->vm) {
            SetError("Hash calculation failed: invalid context");
            return;
        }

        auto t0 = std::chrono::high_resolution_clock::now();
        {
            std::lock_guard<std::mutex> lock(context->hashMutex);
            randomx_calculate_hash(context->vm, input.data(), input.size(), output.data());
        }
        auto t1 = std::chrono::high_resolution_clock::now();
        const uint64_t micros = static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count());
        ContextManager::getInstance().recordHash(contextId, micros);
    }

    void OnOK() override {
        deferred.Resolve(Napi::Buffer<uint8_t>::Copy(Env(), output.data(), output.size()));
    }

    void OnError(const Napi::Error& error) override {
        deferred.Reject(error.Value());
    }

    Napi::Promise GetPromise() const {
        return deferred.Promise();
    }

private:
    Napi::Promise::Deferred deferred;
    std::shared_ptr<RandomXContext> context;
    uint32_t contextId;
    std::vector<uint8_t> input;
    std::array<uint8_t, 32> output = {};
};

/**
 * Initialize RandomX context with specified configuration
 */
Napi::Value InitContext(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsBuffer()) {
        Napi::TypeError::New(env, "First argument must be a 32-byte seed Buffer").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Buffer<uint8_t> seedBuffer = info[0].As<Napi::Buffer<uint8_t>>();
    if (seedBuffer.Length() != 32) {
        Napi::TypeError::New(env, "Seed must be exactly 32 bytes").ThrowAsJavaScriptException();
        return env.Null();
    }

    // Parse configuration options
    RandomXConfig config = {};
    config.enableJit = true;
    config.enableAes = true;
    config.enableHugePages = false;  // Default to false for light mode
    config.threads = 1;
    config.mode = RandomXMode::LIGHT;  // Default to light mode for verification

    if (info.Length() > 1 && info[1].IsObject()) {
        Napi::Object options = info[1].As<Napi::Object>();

        if (options.Has("enableJit")) {
            config.enableJit = options.Get("enableJit").As<Napi::Boolean>().Value();
        }
        if (options.Has("enableAes")) {
            config.enableAes = options.Get("enableAes").As<Napi::Boolean>().Value();
        }
        if (options.Has("enableHugePages")) {
            config.enableHugePages = options.Get("enableHugePages").As<Napi::Boolean>().Value();
        }
        if (options.Has("threads")) {
            config.threads = options.Get("threads").As<Napi::Number>().Uint32Value();
        }
        if (options.Has("mode")) {
            std::string mode = options.Get("mode").As<Napi::String>().Utf8Value();
            if (mode == "fast") {
                config.mode = RandomXMode::FAST;
            } else if (mode == "light") {
                config.mode = RandomXMode::LIGHT;
            }
        }
    }

    uint32_t contextId = ContextManager::getInstance().createContext(seedBuffer.Data(), config);
    if (contextId == 0) {
        Napi::Error::New(env, "Failed to initialize RandomX context").ThrowAsJavaScriptException();
        return env.Null();
    }
    return Napi::Number::New(env, contextId);
}

/**
 * Verify a mining share
 */
Napi::Value VerifyShare(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 3) {
        Napi::TypeError::New(env, "Expected at least 3 arguments").ThrowAsJavaScriptException();
        return env.Null();
    }

    if (!info[0].IsNumber() || !info[1].IsBuffer() || !info[2].IsBuffer()) {
        Napi::TypeError::New(env, "Invalid argument types").ThrowAsJavaScriptException();
        return env.Null();
    }

    uint32_t contextId = info[0].As<Napi::Number>().Uint32Value();
    Napi::Buffer<uint8_t> input = info[1].As<Napi::Buffer<uint8_t>>();
    Napi::Buffer<uint8_t> target = info[2].As<Napi::Buffer<uint8_t>>();

    if (target.Length() != 32) {
        Napi::TypeError::New(env, "Target must be 32 bytes").ThrowAsJavaScriptException();
        return env.Null();
    }

    uint8_t* expectedHash = nullptr;
    if (info.Length() > 3 && info[3].IsBuffer()) {
        Napi::Buffer<uint8_t> expectedBuffer = info[3].As<Napi::Buffer<uint8_t>>();
        if (expectedBuffer.Length() != 32) {
            Napi::TypeError::New(env, "Expected hash must be 32 bytes").ThrowAsJavaScriptException();
            return env.Null();
        }
        expectedHash = expectedBuffer.Data();
    }

    ShareVerificationResult result = {};
    bool success = ShareVerifier::verifyShare(
        contextId,
        input.Data(),
        input.Length(),
        target.Data(),
        expectedHash,
        result
    );

    if (!success) {
        Napi::Error::New(env, "Share verification failed: invalid context or parameters").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Object resultObj = Napi::Object::New(env);
    resultObj.Set("valid", Napi::Boolean::New(env, result.valid));
    resultObj.Set("difficulty", Napi::Number::New(env, result.difficulty));
    resultObj.Set("hashTime", Napi::Number::New(env, result.hashTime));

    Napi::Buffer<uint8_t> hashBuffer = Napi::Buffer<uint8_t>::Copy(env, result.hash, 32);
    resultObj.Set("hash", hashBuffer);

    return resultObj;
}

/**
 * Calculate RandomX hash
 */
Napi::Value Hash(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsBuffer()) {
        Napi::TypeError::New(env, "Expected contextId (number) and input (Buffer)").ThrowAsJavaScriptException();
        return env.Null();
    }

    uint32_t contextId = info[0].As<Napi::Number>().Uint32Value();
    Napi::Buffer<uint8_t> input = info[1].As<Napi::Buffer<uint8_t>>();

    uint8_t hash[32];
    bool success = ShareVerifier::calculateHash(contextId, input.Data(), input.Length(), hash);

    if (!success) {
        Napi::Error::New(env, "Hash calculation failed: invalid context").ThrowAsJavaScriptException();
        return env.Null();
    }

    return Napi::Buffer<uint8_t>::Copy(env, hash, 32);
}

/**
 * Calculate RandomX hash asynchronously on the libuv worker pool.
 */
Napi::Value HashAsync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsBuffer()) {
        Napi::TypeError::New(env, "Expected contextId (number) and input (Buffer)").ThrowAsJavaScriptException();
        return env.Null();
    }

    uint32_t contextId = info[0].As<Napi::Number>().Uint32Value();
    Napi::Buffer<uint8_t> input = info[1].As<Napi::Buffer<uint8_t>>();
    auto context = ContextManager::getInstance().getContext(contextId);
    if (!context || !context->vm) {
        Napi::Error::New(env, "Hash calculation failed: invalid context").ThrowAsJavaScriptException();
        return env.Null();
    }

    auto* worker = new HashAsyncWorker(env, std::move(context), contextId, input.Data(), input.Length());
    auto promise = worker->GetPromise();
    worker->Queue();
    return promise;
}

/**
 * Release a RandomX context
 */
Napi::Value ReleaseContext(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected contextId (number)").ThrowAsJavaScriptException();
        return env.Null();
    }

    uint32_t contextId = info[0].As<Napi::Number>().Uint32Value();

    bool success = ContextManager::getInstance().releaseContext(contextId);
    if (!success) {
        Napi::Error::New(env, "Failed to release context: invalid context ID").ThrowAsJavaScriptException();
        return env.Null();
    }
    return Napi::Boolean::New(env, true);
}

/**
 * Get performance statistics
 */
Napi::Value GetStats(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    auto stats = ContextManager::getInstance().getStats();

    Napi::Object statsObj = Napi::Object::New(env);
    statsObj.Set("totalHashes", Napi::Number::New(env, stats.totalHashes));
    statsObj.Set("totalVerifications", Napi::Number::New(env, stats.totalVerifications));
    statsObj.Set("activeContexts", Napi::Number::New(env, stats.activeContexts));
    statsObj.Set("activeSeeds", Napi::Number::New(env, stats.activeSeeds));
    statsObj.Set("averageHashTime", Napi::Number::New(env, stats.averageHashTime));
    statsObj.Set("cacheHits", Napi::Number::New(env, stats.cacheHits));
    statsObj.Set("cacheMisses", Napi::Number::New(env, stats.cacheMisses));

    return statsObj;
}

/**
 * Per-context runtime metadata (mode, large-page usage)
 */
Napi::Value GetContextInfo(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected contextId (number)").ThrowAsJavaScriptException();
        return env.Null();
    }

    uint32_t contextId = info[0].As<Napi::Number>().Uint32Value();
    bool usedLargePages = false;
    bool requestedLargePages = false;
    RandomXMode mode = RandomXMode::LIGHT;

    if (!ContextManager::getInstance().getContextInfo(contextId, usedLargePages, requestedLargePages, mode)) {
        return env.Null();
    }

    Napi::Object o = Napi::Object::New(env);
    o.Set("mode", Napi::String::New(env, randomModeToString(mode)));
    o.Set("enableHugePages", Napi::Boolean::New(env, requestedLargePages));
    o.Set("usedLargePages", Napi::Boolean::New(env, usedLargePages));
    return o;
}

/**
 * Get hardware capability information
 */
Napi::Value GetHardwareInfo(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    auto hwInfo = ContextManager::getInstance().getHardwareInfo();

    Napi::Object infoObj = Napi::Object::New(env);
    infoObj.Set("hasJit", Napi::Boolean::New(env, hwInfo.hasJit));
    infoObj.Set("hasAes", Napi::Boolean::New(env, hwInfo.hasAes));
    infoObj.Set("hasHugePages", Napi::Boolean::New(env, hwInfo.hasHugePages));
    infoObj.Set("cpuCores", Napi::Number::New(env, hwInfo.cpuCores));
    infoObj.Set("totalMemory", Napi::Number::New(env, hwInfo.totalMemory));
    infoObj.Set("hugePagesAvailable", Napi::Number::New(env, hwInfo.hugePagesAvailable));

    return infoObj;
}

/**
 * Module initialization
 */
Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("initContext", Napi::Function::New(env, InitContext));
    exports.Set("verifyShare", Napi::Function::New(env, VerifyShare));
    exports.Set("hash", Napi::Function::New(env, Hash));
    exports.Set("hashAsync", Napi::Function::New(env, HashAsync));
    exports.Set("releaseContext", Napi::Function::New(env, ReleaseContext));
    exports.Set("getStats", Napi::Function::New(env, GetStats));
    exports.Set("getHardwareInfo", Napi::Function::New(env, GetHardwareInfo));
    exports.Set("getContextInfo", Napi::Function::New(env, GetContextInfo));

    return exports;
}

NODE_API_MODULE(randomx, Init)
