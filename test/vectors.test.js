/**
 * Known-answer tests: upstream RandomX vectors (deps/randomx/src/tests/tests.cpp, "Hash test 1a-1f"
 * and "Commitment test") for rx/0 and rx/2, in every execution path we ship:
 * light/fast × interpreter/JIT, with reserved, transparent and no huge pages.
 *
 * Upstream keys are not 32 bytes, so this goes through the native binding directly.
 * A wrong vector means consensus-breaking hashes: never "fix" the expected values.
 */

const assert = require('assert');
const os = require('os');
const native = require('../build/Release/randomx');

const vectors = [
    {
        key: 'test key 000', input: 'This is a test',
        'rx/0': '639183aae1bf4c9a35884cb46b09cad9175f04efd7684e7262a0ac1c2f0b4e3f',
        'rx/2': '22ec6b861b3eb23686b2efbad69513c967ecfce80983df66c9c5b4fbfb4cdb6f',
        commitment: '133be717399046b03ae82ce8ddd9d1ee4d3ea7fca03a50dec09b6848cbb98e18'
    },
    {
        key: 'test key 000', input: 'Lorem ipsum dolor sit amet',
        'rx/0': '300a0adb47603dedb42228ccb2b211104f4da45af709cd7547cd049e9489c969',
        'rx/2': '9e2c772c12fd48f93c14c97fdc89d556264d9100597023f44d9163e279012ecf'
    },
    {
        key: 'test key 000', input: 'sed do eiusmod tempor incididunt ut labore et dolore magna aliqua',
        'rx/0': 'c36d4ed4191e617309867ed66a443be4075014e2b061bcdaf9ce7b721d2b77a8',
        'rx/2': '4d6b063a1a603751d525f18a171336a4002f2f06df6c17e4b25fe17e17796e42'
    },
    {
        key: 'test key 001', input: 'sed do eiusmod tempor incididunt ut labore et dolore magna aliqua',
        'rx/0': 'e9ff4503201c0c2cca26d285c93ae883f9b1d30c9eb240b820756f2d5a7905fc',
        'rx/2': '97024134686ce27d362ea8d86d8ef16483ac272abdabd46ef13359400777fe5e'
    },
    {
        key: 'test key 001',
        inputHex: '0b0b98bea7e805e0010a2126d287a2a0cc833d312cb786385a7c2f9de69d25537f584a9bc9977b00000000666fd8753bf61a8631f12984e3fd44f4014eca629276817b56f32e9b68bd82f416',
        'rx/0': 'c56414121acda1713c2f2a819d8ae38aed7c80c35c2a769298d34f03833cd5f1',
        'rx/2': 'c8e92c5f7c1946fecf06bc382b92e3111da38ee3e6a5ad90704e1a9d8aaf6e76'
    },
    {
        // ISUB_R edge case; 31-byte key (upstream drops the trailing byte)
        keyHex: '7797373ea4633194640bf8d8c3b66724d6aa7bd2dc20e009df2f8f1710abe8',
        inputHex: '1010e1eaf8cf067b37b5f0ee031ab23ed1755e090a3af4415830145853e2be3e1f6821fed84dae58d00e00da5214d6c1f2d0622e0abd51f9373d04e0b0f8e6d6514d90689721c4aac5a9bb0d',
        'rx/0': '78af2a1864c42abce36d2e8983e13df99b2af0ce1362999af09fab004d4435a8'
    }
];

const keyOf = (v) => (v.keyHex ? Buffer.from(v.keyHex, 'hex') : Buffer.from(v.key));
const inputOf = (v) => (v.inputHex ? Buffer.from(v.inputHex, 'hex') : Buffer.from(v.input));

const configs = [
    { name: 'light+interp', options: { mode: 'light', enableJit: false } },
    { name: 'light+jit', options: { mode: 'light' } },
    { name: 'light+jit thp', options: { mode: 'light', enableHugePages: 'thp' } },
    { name: 'light+jit nohuge', options: { mode: 'light', enableHugePages: false } },
    { name: 'fast+interp', options: { mode: 'fast', threads: Math.max(1, os.cpus().length), enableJit: false } },
    { name: 'fast+jit', options: { mode: 'fast', threads: Math.max(1, os.cpus().length) } },
    { name: 'fast+jit thp', options: { mode: 'fast', threads: Math.max(1, os.cpus().length), enableHugePages: 'thp' } },
    { name: 'fast+jit nohuge', options: { mode: 'fast', threads: Math.max(1, os.cpus().length), enableHugePages: false } }
];

let checks = 0;
for (const config of configs) {
    const started = Date.now();
    const contexts = new Map();
    const contextFor = (key) => {
        const hex = key.toString('hex');
        if (!contexts.has(hex)) {
            contexts.set(hex, native.initContext(key, { vmPoolSize: 1, ...config.options }));
        }
        return contexts.get(hex);
    };

    for (const v of vectors) {
        const id = contextFor(keyOf(v));
        const input = inputOf(v);
        for (const variant of ['rx/0', 'rx/2']) {
            if (!v[variant]) {
                continue;
            }
            const label = `${config.name} ${variant} ${(v.input || v.inputHex).slice(0, 24)}`;
            assert.strictEqual(native.hash(id, input, variant).toString('hex'), v[variant], label);
            const { hash, pow } = native.pow(id, input, variant);
            assert.strictEqual(hash.toString('hex'), v[variant], `${label} (pow.hash)`);
            const expectedPow = variant === 'rx/2' ? native.commitment(input, hash) : hash;
            assert.ok(pow.equals(expectedPow), `${label} (pow)`);
            if (variant === 'rx/2' && v.commitment) {
                assert.strictEqual(pow.toString('hex'), v.commitment, `${label} (commitment)`);
            }
            checks++;
        }
    }

    const memory = native.getContextInfo(contexts.values().next().value).memory;
    if (config.options.mode === 'fast') {
        assert.strictEqual(memory.cache, null, `${config.name}: fast mode must free the cache`);
    }
    for (const id of contexts.values()) {
        native.releaseContext(id);
    }
    console.log(`✓ ${config.name.padEnd(18)} dataset=${memory.dataset} cache=${memory.cache} (${Date.now() - started} ms)`);
}

// Variant must be explicit and valid; never silently fall back.
const id = native.initContext(Buffer.from('test key 000'), { mode: 'light' });
assert.throws(() => native.hash(id, Buffer.from('x'), 'rx/1'), /Variant/);
assert.throws(() => native.hash(id, Buffer.from('x'), 2), /Variant/);
assert.strictEqual(
    native.hash(id, Buffer.from(vectors[0].input)).toString('hex'), vectors[0]['rx/0'], 'default variant is rx/0');
native.releaseContext(id);

console.log(`\nAll ${checks} vector checks passed`);
