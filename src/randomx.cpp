/**
 * RandomX N-API Addon Main Module
 * High-performance share verification for mining pools
 */

#include <napi.h>
#include "context_manager.h"
#include "share_verifier.h"
#include <array>
#include <cmath>
#include <memory>
#include <string>
#include <vector>

/** Bumped on incompatible native API changes; checked by the JS layer. */
static constexpr uint32_t kAbiVersion = 2;
static constexpr size_t kMaxSeedLength = 64;

static const char* modeToString(RandomXMode mode) {
    return mode == RandomXMode::FAST ? "fast" : "light";
}

static const char* variantToString(RandomXVariant variant) {
    return variant == RandomXVariant::RX2 ? "rx/2" : "rx/0";
}

static const char* backingToString(MemoryBacking backing) {
    switch (backing) {
        case MemoryBacking::HUGETLB: return "hugetlb";
        case MemoryBacking::THP: return "thp";
        case MemoryBacking::NORMAL: return "normal";
        default: return nullptr;
    }
}

static const char* hugePagesToString(HugePageMode mode) {
    switch (mode) {
        case HugePageMode::ALL: return "all";
        case HugePageMode::THP: return "thp";
        default: return "off";
    }
}

static Napi::Value backingValue(Napi::Env env, MemoryBacking backing) {
    const char* name = backingToString(backing);
    return name ? Napi::String::New(env, name) : env.Null();
}

static bool throwType(Napi::Env env, const char* message) {
    Napi::TypeError::New(env, message).ThrowAsJavaScriptException();
    return false;
}

static bool readBool(Napi::Env env, const Napi::Object& options, const char* name, bool& out) {
    if (!options.Has(name) || options.Get(name).IsUndefined()) {
        return true;
    }
    Napi::Value value = options.Get(name);
    if (!value.IsBoolean()) {
        return throwType(env, (std::string(name) + " must be a boolean").c_str());
    }
    out = value.As<Napi::Boolean>().Value();
    return true;
}

/** Positive integer option. Garbage (NaN, ±Infinity, fractions, < 1) throws; values above `max` are capped. */
static bool readCount(Napi::Env env, const Napi::Object& options, const char* name, uint32_t max, uint32_t& out) {
    if (!options.Has(name) || options.Get(name).IsUndefined()) {
        return true;
    }
    Napi::Value value = options.Get(name);
    if (!value.IsNumber()) {
        return throwType(env, (std::string(name) + " must be a number").c_str());
    }
    const double number = value.As<Napi::Number>().DoubleValue();
    if (!std::isfinite(number) || number < 1 || std::floor(number) != number) {
        Napi::RangeError::New(env, std::string(name) + " must be a positive integer").ThrowAsJavaScriptException();
        return false;
    }
    out = number > max ? max : static_cast<uint32_t>(number);
    return true;
}

/** Context id from a JS number; anything that isn't an exact uint32 maps to 0, which is never issued. */
static uint32_t readContextId(const Napi::Value& value) {
    const double number = value.As<Napi::Number>().DoubleValue();
    if (!std::isfinite(number) || number < 1 || number > 4294967295.0 || std::floor(number) != number) {
        return 0;
    }
    return static_cast<uint32_t>(number);
}

static bool parseConfig(Napi::Env env, const Napi::Value& value, RandomXConfig& config) {
    config = {};
    config.enableJit = true;
    config.enableAes = true;
    config.hugePages = HugePageMode::ALL;
    config.threads = 1;
    config.vmPoolSize = 1;
    config.mode = RandomXMode::LIGHT;

    if (value.IsUndefined() || value.IsNull()) {
        return true;
    }
    if (!value.IsObject()) {
        return throwType(env, "Options must be an object");
    }

    Napi::Object options = value.As<Napi::Object>();
    if (!readBool(env, options, "enableJit", config.enableJit) ||
        !readBool(env, options, "enableAes", config.enableAes) ||
        !readCount(env, options, "threads", 256, config.threads) ||
        !readCount(env, options, "vmPoolSize", 1024, config.vmPoolSize)) {
        return false;
    }
    if (options.Has("enableHugePages") && !options.Get("enableHugePages").IsUndefined()) {
        Napi::Value value = options.Get("enableHugePages");
        if (value.IsBoolean()) {
            config.hugePages = value.As<Napi::Boolean>().Value() ? HugePageMode::ALL : HugePageMode::OFF;
        } else if (value.IsString() && value.As<Napi::String>().Utf8Value() == "thp") {
            config.hugePages = HugePageMode::THP;
        } else {
            return throwType(env, "enableHugePages must be true, false or \"thp\"");
        }
    }
    if (options.Has("mode") && !options.Get("mode").IsUndefined()) {
        Napi::Value mode = options.Get("mode");
        const std::string name = mode.IsString() ? mode.As<Napi::String>().Utf8Value() : "";
        if (name == "fast") {
            config.mode = RandomXMode::FAST;
        } else if (name != "light") {
            return throwType(env, "Mode must be \"fast\" or \"light\"");
        }
    }
    return true;
}

static bool parseVariant(Napi::Env env, const Napi::Value& value, RandomXVariant& variant) {
    variant = RandomXVariant::RX0;
    if (value.IsUndefined() || value.IsNull()) {
        return true;
    }
    const std::string name = value.IsString() ? value.As<Napi::String>().Utf8Value() : "";
    if (name == "rx/2") {
        variant = RandomXVariant::RX2;
    } else if (name != "rx/0") {
        return throwType(env, "Variant must be \"rx/0\" or \"rx/2\"");
    }
    return true;
}

static bool parseSeed(Napi::Env env, const Napi::CallbackInfo& info, Napi::Buffer<uint8_t>& seed) {
    if (info.Length() < 1 || !info[0].IsBuffer()) {
        return throwType(env, "First argument must be a seed Buffer");
    }
    seed = info[0].As<Napi::Buffer<uint8_t>>();
    if (seed.Length() < 1 || seed.Length() > kMaxSeedLength) {
        return throwType(env, "Seed must be 1-64 bytes");
    }
    return true;
}

/** Common (contextId, input, variant) arguments of hash/pow calls. */
struct ComputeArgs {
    std::shared_ptr<RandomXContext> context;
    Napi::Buffer<uint8_t> input;
    RandomXVariant variant;
};

static bool parseComputeArgs(Napi::Env env, const Napi::CallbackInfo& info, size_t variantIndex, ComputeArgs& args) {
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsBuffer()) {
        return throwType(env, "Expected contextId (number) and input (Buffer)");
    }
    if (!parseVariant(env, info.Length() > variantIndex ? info[variantIndex] : env.Undefined(), args.variant)) {
        return false;
    }
    args.context = ContextManager::getInstance().getContext(readContextId(info[0]));
    if (!args.context) {
        Napi::Error::New(env, "Invalid context").ThrowAsJavaScriptException();
        return false;
    }
    args.input = info[1].As<Napi::Buffer<uint8_t>>();
    return true;
}

static Napi::Object powObject(Napi::Env env, const uint8_t* hash, const uint8_t* pow) {
    Napi::Object result = Napi::Object::New(env);
    result.Set("hash", Napi::Buffer<uint8_t>::Copy(env, hash, RANDOMX_HASH_SIZE));
    result.Set("pow", Napi::Buffer<uint8_t>::Copy(env, pow, RANDOMX_HASH_SIZE));
    return result;
}

class InitContextAsyncWorker : public Napi::AsyncWorker {
public:
    InitContextAsyncWorker(Napi::Env env, const uint8_t* seed, size_t seedLength, const RandomXConfig& config)
        : Napi::AsyncWorker(env),
          deferred(Napi::Promise::Deferred::New(env)),
          seed(seed, seed + seedLength),
          config(config) {}

    void Execute() override {
        contextId = ContextManager::getInstance().createContext(seed.data(), seed.size(), config);
        if (contextId == 0) {
            SetError("Failed to initialize RandomX context");
        }
    }

    void OnOK() override { deferred.Resolve(Napi::Number::New(Env(), contextId)); }
    void OnError(const Napi::Error& error) override { deferred.Reject(error.Value()); }
    Napi::Promise GetPromise() const { return deferred.Promise(); }

private:
    Napi::Promise::Deferred deferred;
    std::vector<uint8_t> seed;
    RandomXConfig config;
    uint32_t contextId = 0;
};

/**
 * Hash (or hash + PoW) on the libuv worker pool.
 */
class ComputeAsyncWorker : public Napi::AsyncWorker {
public:
    ComputeAsyncWorker(Napi::Env env, ComputeArgs& args, bool withPow)
        : Napi::AsyncWorker(env),
          deferred(Napi::Promise::Deferred::New(env)),
          context(std::move(args.context)),
          variant(args.variant),
          input(args.input.Data(), args.input.Data() + args.input.Length()),
          withPow(withPow) {}

    void Execute() override {
        if (!ShareVerifier::compute(context, variant, input.data(), input.size(), hash.data(), withPow ? pow.data() : nullptr)) {
            SetError("Failed to create RandomX VM");
        }
    }

    void OnOK() override {
        Napi::Env env = Env();
        if (withPow) {
            deferred.Resolve(powObject(env, hash.data(), pow.data()));
        } else {
            deferred.Resolve(Napi::Buffer<uint8_t>::Copy(env, hash.data(), hash.size()));
        }
    }

    void OnError(const Napi::Error& error) override { deferred.Reject(error.Value()); }
    Napi::Promise GetPromise() const { return deferred.Promise(); }

private:
    Napi::Promise::Deferred deferred;
    std::shared_ptr<RandomXContext> context;
    RandomXVariant variant;
    std::vector<uint8_t> input;
    bool withPow;
    std::array<uint8_t, RANDOMX_HASH_SIZE> hash = {};
    std::array<uint8_t, RANDOMX_HASH_SIZE> pow = {};
};

/**
 * initContext(seed, options) -> contextId
 */
Napi::Value InitContext(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Buffer<uint8_t> seed;
    RandomXConfig config;
    if (!parseSeed(env, info, seed) || !parseConfig(env, info.Length() > 1 ? info[1] : env.Undefined(), config)) {
        return env.Null();
    }

    const uint32_t contextId = ContextManager::getInstance().createContext(seed.Data(), seed.Length(), config);
    if (contextId == 0) {
        Napi::Error::New(env, "Failed to initialize RandomX context").ThrowAsJavaScriptException();
        return env.Null();
    }
    return Napi::Number::New(env, contextId);
}

/**
 * initContextAsync(seed, options) -> Promise<contextId>
 */
Napi::Value InitContextAsync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Buffer<uint8_t> seed;
    RandomXConfig config;
    if (!parseSeed(env, info, seed) || !parseConfig(env, info.Length() > 1 ? info[1] : env.Undefined(), config)) {
        return env.Null();
    }

    auto* worker = new InitContextAsyncWorker(env, seed.Data(), seed.Length(), config);
    auto promise = worker->GetPromise();
    worker->Queue();
    return promise;
}

/**
 * hash(contextId, input, variant?) -> Buffer (raw RandomX hash)
 */
Napi::Value Hash(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    ComputeArgs args;
    if (!parseComputeArgs(env, info, 2, args)) {
        return env.Null();
    }

    std::array<uint8_t, RANDOMX_HASH_SIZE> hash;
    if (!ShareVerifier::compute(args.context, args.variant, args.input.Data(), args.input.Length(), hash.data(), nullptr)) {
        Napi::Error::New(env, "Failed to create RandomX VM").ThrowAsJavaScriptException();
        return env.Null();
    }
    return Napi::Buffer<uint8_t>::Copy(env, hash.data(), hash.size());
}

/**
 * pow(contextId, input, variant?) -> { hash, pow }
 */
Napi::Value Pow(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    ComputeArgs args;
    if (!parseComputeArgs(env, info, 2, args)) {
        return env.Null();
    }

    std::array<uint8_t, RANDOMX_HASH_SIZE> hash;
    std::array<uint8_t, RANDOMX_HASH_SIZE> pow;
    if (!ShareVerifier::compute(args.context, args.variant, args.input.Data(), args.input.Length(), hash.data(), pow.data())) {
        Napi::Error::New(env, "Failed to create RandomX VM").ThrowAsJavaScriptException();
        return env.Null();
    }
    return powObject(env, hash.data(), pow.data());
}

static Napi::Value QueueCompute(const Napi::CallbackInfo& info, bool withPow) {
    Napi::Env env = info.Env();
    ComputeArgs args;
    if (!parseComputeArgs(env, info, 2, args)) {
        return env.Null();
    }

    auto* worker = new ComputeAsyncWorker(env, args, withPow);
    auto promise = worker->GetPromise();
    worker->Queue();
    return promise;
}

/** hashAsync(contextId, input, variant?) -> Promise<Buffer> */
Napi::Value HashAsync(const Napi::CallbackInfo& info) { return QueueCompute(info, false); }

/** powAsync(contextId, input, variant?) -> Promise<{ hash, pow }> */
Napi::Value PowAsync(const Napi::CallbackInfo& info) { return QueueCompute(info, true); }

/**
 * commitment(input, hash) -> Buffer: Blake2b-256(input || hash), the rx/2 PoW of `hash`.
 */
Napi::Value Commitment(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsBuffer() || !info[1].IsBuffer()) {
        throwType(env, "Expected input (Buffer) and hash (Buffer)");
        return env.Null();
    }
    Napi::Buffer<uint8_t> input = info[0].As<Napi::Buffer<uint8_t>>();
    Napi::Buffer<uint8_t> hash = info[1].As<Napi::Buffer<uint8_t>>();
    if (hash.Length() != RANDOMX_HASH_SIZE) {
        throwType(env, "Hash must be 32 bytes");
        return env.Null();
    }

    std::array<uint8_t, RANDOMX_HASH_SIZE> out;
    randomx_calculate_commitment(input.Data(), input.Length(), hash.Data(), out.data());
    return Napi::Buffer<uint8_t>::Copy(env, out.data(), out.size());
}

/**
 * verifyShare(contextId, input, target, expectedPow?, variant?)
 */
Napi::Value VerifyShare(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    ComputeArgs args;
    if (!parseComputeArgs(env, info, 4, args)) {
        return env.Null();
    }
    if (info.Length() < 3 || !info[2].IsBuffer() || info[2].As<Napi::Buffer<uint8_t>>().Length() != RANDOMX_HASH_SIZE) {
        throwType(env, "Target must be a 32-byte Buffer");
        return env.Null();
    }
    const uint8_t* expected = nullptr;
    if (info.Length() > 3 && !info[3].IsBuffer() && !info[3].IsNull() && !info[3].IsUndefined()) {
        throwType(env, "Expected PoW must be a 32-byte Buffer");
        return env.Null();
    }
    if (info.Length() > 3 && info[3].IsBuffer()) {
        Napi::Buffer<uint8_t> expectedBuffer = info[3].As<Napi::Buffer<uint8_t>>();
        if (expectedBuffer.Length() != RANDOMX_HASH_SIZE) {
            throwType(env, "Expected PoW must be 32 bytes");
            return env.Null();
        }
        expected = expectedBuffer.Data();
    }

    ShareVerificationResult result;
    if (!ShareVerifier::verifyShare(args.context, args.variant, args.input.Data(), args.input.Length(),
                                    info[2].As<Napi::Buffer<uint8_t>>().Data(), expected, result)) {
        Napi::Error::New(env, "Failed to create RandomX VM").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Object resultObj = powObject(env, result.hash, result.pow);
    resultObj.Set("valid", Napi::Boolean::New(env, result.valid));
    resultObj.Set("difficulty", Napi::Number::New(env, result.difficulty));
    resultObj.Set("hashTime", Napi::Number::New(env, result.hashTime));
    return resultObj;
}

/**
 * releaseContext(contextId) -> true
 */
Napi::Value ReleaseContext(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        throwType(env, "Expected contextId (number)");
        return env.Null();
    }
    if (!ContextManager::getInstance().releaseContext(readContextId(info[0]))) {
        Napi::Error::New(env, "Failed to release context: invalid context ID").ThrowAsJavaScriptException();
        return env.Null();
    }
    return Napi::Boolean::New(env, true);
}

static Napi::Object backingCounts(Napi::Env env, const uint32_t (&counts)[kBackingCount]) {
    Napi::Object o = Napi::Object::New(env);
    for (MemoryBacking backing : {MemoryBacking::HUGETLB, MemoryBacking::THP, MemoryBacking::NORMAL}) {
        o.Set(backingToString(backing), Napi::Number::New(env, counts[static_cast<size_t>(backing)]));
    }
    return o;
}

/**
 * getStats()
 */
Napi::Value GetStats(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    const auto stats = ContextManager::getInstance().getStats();

    Napi::Object statsObj = Napi::Object::New(env);
    statsObj.Set("totalHashes", Napi::Number::New(env, static_cast<double>(stats.totalHashes)));
    statsObj.Set("totalVerifications", Napi::Number::New(env, static_cast<double>(stats.totalVerifications)));
    statsObj.Set("activeContexts", Napi::Number::New(env, stats.activeContexts));
    statsObj.Set("activeVMs", Napi::Number::New(env, stats.activeVMs));
    statsObj.Set("activeSeeds", Napi::Number::New(env, stats.activeSeeds));
    statsObj.Set("averageHashTime", Napi::Number::New(env, stats.averageHashTime));
    statsObj.Set("cacheHits", Napi::Number::New(env, static_cast<double>(stats.cacheHits)));
    statsObj.Set("cacheMisses", Napi::Number::New(env, static_cast<double>(stats.cacheMisses)));

    Napi::Object variants = Napi::Object::New(env);
    for (size_t i = 0; i < kVariantCount; i++) {
        Napi::Object v = Napi::Object::New(env);
        v.Set("totalHashes", Napi::Number::New(env, static_cast<double>(stats.variants[i].totalHashes)));
        v.Set("averageHashTime", Napi::Number::New(env, stats.variants[i].averageHashTime));
        variants.Set(variantToString(static_cast<RandomXVariant>(i)), v);
    }
    statsObj.Set("variants", variants);

    Napi::Object memory = Napi::Object::New(env);
    memory.Set("dataset", backingCounts(env, stats.datasetBackings));
    memory.Set("cache", backingCounts(env, stats.cacheBackings));
    statsObj.Set("memory", memory);
    return statsObj;
}

/**
 * getContextInfo(contextId) -> { mode, enableHugePages, hugePages, vmPoolSize, vms, memory } | null
 */
Napi::Value GetContextInfo(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        throwType(env, "Expected contextId (number)");
        return env.Null();
    }

    ContextInfo ci;
    if (!ContextManager::getInstance().getContextInfo(readContextId(info[0]), ci)) {
        return env.Null();
    }

    Napi::Object vms = Napi::Object::New(env);
    uint32_t totalVms = 0;
    for (size_t i = 0; i < kVariantCount; i++) {
        vms.Set(variantToString(static_cast<RandomXVariant>(i)), Napi::Number::New(env, ci.vms[i]));
        totalVms += ci.vms[i];
    }

    Napi::Object scratchpad = Napi::Object::New(env);
    scratchpad.Set("hugetlb", Napi::Number::New(env, ci.hugetlbScratchpads));
    scratchpad.Set("normal", Napi::Number::New(env, totalVms - ci.hugetlbScratchpads));

    Napi::Object memory = Napi::Object::New(env);
    memory.Set("dataset", backingValue(env, ci.datasetBacking));
    memory.Set("cache", backingValue(env, ci.cacheBacking));
    memory.Set("scratchpad", scratchpad);

    Napi::Object o = Napi::Object::New(env);
    o.Set("mode", Napi::String::New(env, modeToString(ci.mode)));
    o.Set("enableHugePages", Napi::Boolean::New(env, ci.hugePages != HugePageMode::OFF));
    o.Set("hugePages", Napi::String::New(env, hugePagesToString(ci.hugePages)));
    o.Set("vmPoolSize", Napi::Number::New(env, ci.vmPoolSize));
    o.Set("vms", vms);
    o.Set("memory", memory);
    return o;
}

/**
 * getHardwareInfo()
 */
Napi::Value GetHardwareInfo(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    const auto hw = ContextManager::getInstance().getHardwareInfo();

    Napi::Object hugePages = Napi::Object::New(env);
    hugePages.Set("pageSizeKB", Napi::Number::New(env, static_cast<double>(hw.hugePages.pageSizeKB)));
    hugePages.Set("total", Napi::Number::New(env, static_cast<double>(hw.hugePages.total)));
    hugePages.Set("free", Napi::Number::New(env, static_cast<double>(hw.hugePages.free)));
    hugePages.Set("reserved", Napi::Number::New(env, static_cast<double>(hw.hugePages.reserved)));
    hugePages.Set("available", Napi::Number::New(env, static_cast<double>(hw.hugePages.available)));

    Napi::Object thp = Napi::Object::New(env);
    thp.Set("enabled", Napi::String::New(env, hw.thpEnabled));
    thp.Set("defrag", Napi::String::New(env, hw.thpDefrag));

    Napi::Object infoObj = Napi::Object::New(env);
    infoObj.Set("hasJit", Napi::Boolean::New(env, hw.hasJit));
    infoObj.Set("hasAes", Napi::Boolean::New(env, hw.hasAes));
    infoObj.Set("hasHugePages", Napi::Boolean::New(env, hw.hasHugePages));
    infoObj.Set("cpuCores", Napi::Number::New(env, hw.cpuCores));
    infoObj.Set("totalMemory", Napi::Number::New(env, static_cast<double>(hw.totalMemory)));
    infoObj.Set("hugePagesAvailable", Napi::Number::New(env, static_cast<double>(hw.hugePages.available)));
    infoObj.Set("hugePages", hugePages);
    infoObj.Set("transparentHugePages", thp);
    return infoObj;
}

/**
 * capabilities() -> { abi, variants, commitment, randomx }
 * `randomx` is the upstream RandomX commit compiled in (package.json `randomx.commit` at build time).
 */
#ifndef RANDOMX_COMMIT
#define RANDOMX_COMMIT "unknown"
#endif

Napi::Value Capabilities(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array variants = Napi::Array::New(env, kVariantCount);
    for (size_t i = 0; i < kVariantCount; i++) {
        variants.Set(static_cast<uint32_t>(i), Napi::String::New(env, variantToString(static_cast<RandomXVariant>(i))));
    }

    Napi::Object o = Napi::Object::New(env);
    o.Set("abi", Napi::Number::New(env, kAbiVersion));
    o.Set("variants", variants);
    o.Set("commitment", Napi::Boolean::New(env, true));
    o.Set("randomx", Napi::String::New(env, RANDOMX_COMMIT));
    return o;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("initContext", Napi::Function::New(env, InitContext));
    exports.Set("initContextAsync", Napi::Function::New(env, InitContextAsync));
    exports.Set("hash", Napi::Function::New(env, Hash));
    exports.Set("hashAsync", Napi::Function::New(env, HashAsync));
    exports.Set("pow", Napi::Function::New(env, Pow));
    exports.Set("powAsync", Napi::Function::New(env, PowAsync));
    exports.Set("commitment", Napi::Function::New(env, Commitment));
    exports.Set("verifyShare", Napi::Function::New(env, VerifyShare));
    exports.Set("releaseContext", Napi::Function::New(env, ReleaseContext));
    exports.Set("getStats", Napi::Function::New(env, GetStats));
    exports.Set("getHardwareInfo", Napi::Function::New(env, GetHardwareInfo));
    exports.Set("getContextInfo", Napi::Function::New(env, GetContextInfo));
    exports.Set("capabilities", Napi::Function::New(env, Capabilities));
    return exports;
}

NODE_API_MODULE(randomx, Init)
