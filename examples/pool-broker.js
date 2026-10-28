/**
 * Example: shared RandomX broker for Node.js pool workers (broker protocol 2).
 *
 * Why this pattern exists:
 * - A RandomX fast dataset is expensive in RAM (~2 GB per seed).
 * - Pool workers do not need their own dataset copies: a few broker processes hold the
 *   dataset(s), and pool workers send hash requests over a local socket.
 * - One dataset per seed serves both rx/0 and rx/2; each variant gets its own VM pool, created
 *   on first use (`vmPoolSize` VMs per variant at most).
 *
 * Frames are length-prefixed `v8.serialize` objects. Requests carry an `id`; replies echo it with
 * `ok: true` plus a result, or `ok: false` plus `error`.
 *
 *   op       request fields               reply fields
 *   hello    -                            protocol, capabilities, mode
 *   warm     seed                         memory      (backing the seed got; see memory-backing.js)
 *   hash     seed, input, variant?        hash
 *   pow      seed, input, variant?        hash, pow   (pow = value compared with the target)
 *   stats    -                            stats, seeds (per seed: VMs per variant, memory backing)
 *
 * `variant` is 'rx/0' (default) or 'rx/2'; anything else is an error, never a fallback.
 *
 * Rolling upgrades: a protocol 1 broker answers `hello` with "unsupported op" and **ignores**
 * `variant`, so it would return an rx/0 hash for an rx/2 request. The client therefore sends
 * `hello` on every (re)connect and refuses rx/2 work on a peer that did not report protocol >= 2
 * with 'rx/2' in `capabilities.variants`.
 *
 * Run broker:       node examples/pool-broker.js broker [--light]
 * Run demo client:  node examples/pool-broker.js client
 */

'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const v8 = require('v8');
const randomx = require('../index');

const PROTOCOL = 2;
const SOCKET_PATH = process.platform === 'win32'
    ? '\\\\.\\pipe\\randomx-pool-broker'
    : path.resolve('./randomx-pool-broker.sock');

function encodeFrame(message) {
    const payload = v8.serialize(message);
    const frame = Buffer.allocUnsafe(4 + payload.length);
    frame.writeUInt32BE(payload.length, 0);
    payload.copy(frame, 4);
    return frame;
}

function createFrameDecoder(onMessage) {
    let buffer = Buffer.alloc(0);

    return function decode(chunk) {
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;

        while (buffer.length >= 4) {
            const payloadLength = buffer.readUInt32BE(0);
            if (buffer.length < 4 + payloadLength) {
                return;
            }

            const payload = buffer.subarray(4, 4 + payloadLength);
            buffer = buffer.subarray(4 + payloadLength);
            onMessage(v8.deserialize(payload));
        }
    };
}

/** Normalize v8-deserialized byte arrays (Uint8Array) back to Buffers. */
function asBuffer(value) {
    return Buffer.isBuffer(value) ? value : value instanceof Uint8Array ? Buffer.from(value) : value;
}

function startBroker() {
    const mode = process.argv.includes('--light') ? 'light' : 'fast';
    const rxCache = randomx.createPoolSeedPool({
        maxSeeds: 2,
        vmPoolSize: 2,
        mode,
        idleEvictMs: 60000
    });

    const handlers = {
        hello: () => ({ protocol: PROTOCOL, capabilities: randomx.capabilities(), mode }),
        warm: async (m) => {
            const seed = asBuffer(m.seed);
            await rxCache.warmSeedAsync(seed);
            return { memory: rxCache.getMemoryInfo(seed) };
        },
        hash: async (m) => ({
            hash: await rxCache.hashAsync(asBuffer(m.seed), asBuffer(m.input), { variant: m.variant })
        }),
        pow: (m) => rxCache.powAsync(asBuffer(m.seed), asBuffer(m.input), { variant: m.variant }),
        stats: () => ({ stats: randomx.getStats(), seeds: rxCache.getSnapshot().seeds })
    };

    const server = net.createServer((socket) => {
        socket.setNoDelay(true);
        const reply = (message) => {
            if (!socket.destroyed && socket.writable) {
                socket.write(encodeFrame(message));
            }
        };

        socket.on('data', createFrameDecoder(async (message) => {
            const id = message && message.id;
            const handler = message && Object.prototype.hasOwnProperty.call(handlers, message.op) && handlers[message.op];
            if (!handler) {
                reply({ id, ok: false, error: 'unsupported op' });
                return;
            }
            try {
                // Variant errors throw synchronously; the try covers both.
                reply({ id, ok: true, ...(await handler(message)) });
            } catch (error) {
                reply({ id, ok: false, error: error && error.message ? error.message : String(error) });
            }
        }));
        socket.on('error', () => {});
    });

    function cleanupSocketFile() {
        if (process.platform === 'win32') {
            return;
        }
        try {
            fs.unlinkSync(SOCKET_PATH);
        } catch (error) {
            if (!error || error.code !== 'ENOENT') {
                throw error;
            }
        }
    }

    function shutdown() {
        server.close(() => {
            cleanupSocketFile();
            rxCache.releaseAll();
            process.exit(0);
        });
    }

    cleanupSocketFile();

    server.listen(SOCKET_PATH, () => {
        console.log(`RandomX broker (protocol ${PROTOCOL}) listening on ${SOCKET_PATH}`);
        console.log('Config:', { maxSeeds: 2, vmPoolSize: 2, mode, capabilities: randomx.capabilities() });
    });

    // Report what each seed actually got (recorded once at allocation; reading it is free).
    setInterval(() => {
        const stats = randomx.getStats();
        console.log('RandomX stats:', {
            totalHashes: stats.totalHashes,
            activeVMs: stats.activeVMs,
            averageHashTime: Number(stats.averageHashTime || 0).toFixed(3),
            variants: stats.variants,
            seeds: rxCache.getSnapshot().seeds.map((s) => ({ seed: s.seed, vms: s.vms, memory: s.memory }))
        });
    }, 30000).unref();

    process.on('exit', cleanupSocketFile);
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

class BrokerClient {
    constructor(socketPath) {
        this.socket = net.createConnection(socketPath);
        this.socket.setNoDelay(true);
        this.nextId = 0;
        this.pending = new Map();
        this.peer = null; // hello reply, or { protocol: 1 } for an old broker

        this.socket.on('data', createFrameDecoder((message) => {
            const request = this.pending.get(message.id);
            if (!request) {
                return;
            }
            this.pending.delete(message.id);
            if (message.ok) {
                request.resolve(message);
            } else {
                request.reject(new Error(message.error || 'broker error'));
            }
        }));
        this.socket.on('close', () => {
            for (const request of this.pending.values()) {
                request.reject(new Error('broker disconnected'));
            }
            this.pending.clear();
        });
    }

    request(op, fields = {}) {
        return new Promise((resolve, reject) => {
            const id = ++this.nextId;
            this.pending.set(id, { resolve, reject });
            this.socket.write(encodeFrame({ id, op, ...fields }));
        });
    }

    /** Call on every (re)connect, before sending work. */
    async handshake() {
        try {
            this.peer = await this.request('hello');
        } catch (error) {
            if (!/unsupported op/.test(error.message)) {
                throw error;
            }
            this.peer = { protocol: 1, capabilities: { variants: ['rx/0'] } };
        }
        return this.peer;
    }

    /** Whether this peer can serve `pow` (and `variant`). Protocol 1 peers only serve rx/0 `hash`. */
    supports(variant) {
        return !!this.peer && this.peer.protocol >= PROTOCOL && this.peer.capabilities.variants.includes(variant);
    }

    /** @returns {Promise<{ hash: Buffer, pow: Buffer }>} */
    async pow(seed, input, variant = 'rx/0') {
        if (!this.supports(variant)) {
            // Never send a variant to a peer that may ignore it.
            throw new Error(`broker peer does not support ${variant} (protocol ${this.peer && this.peer.protocol})`);
        }
        const reply = await this.request('pow', { seed, input, variant });
        return { hash: asBuffer(reply.hash), pow: asBuffer(reply.pow) };
    }

    close() {
        this.socket.end();
    }
}

async function runClient() {
    const client = new BrokerClient(SOCKET_PATH);
    await new Promise((resolve, reject) => {
        client.socket.once('connect', resolve);
        client.socket.once('error', reject);
    });

    try {
        const peer = await client.handshake();
        console.log(`Connected to ${SOCKET_PATH}: protocol ${peer.protocol}`, peer.capabilities);

        const seed = Buffer.alloc(32, 7);
        const { memory } = await client.request('warm', { seed });
        console.log('Seed ready:', memory);

        const blobs = Array.from({ length: 12 }, (_, i) => Buffer.alloc(76, i));
        for (const variant of ['rx/0', 'rx/2']) {
            const started = Date.now();
            const results = await Promise.all(blobs.map((blob) => client.pow(seed, blob, variant)));
            const r = results[0];
            console.log(`${variant}: ${results.length} requests in ${Date.now() - started} ms;`,
                `hash ${r.hash.toString('hex').slice(0, 16)}…`,
                `pow ${r.pow.toString('hex').slice(0, 16)}…`,
                // rx/2 PoW is the commitment, which the pool can recompute without a VM.
                `pow check ${r.pow.equals(variant === 'rx/2' ? randomx.commitment(blobs[0], r.hash) : r.hash) ? 'ok' : 'MISMATCH'}`);
        }

        await client.request('pow', { seed, input: blobs[0], variant: 'rx/1' })
            .catch((error) => console.log('Unknown variant rejected:', error.message));

        const { seeds } = await client.request('stats');
        console.log('Broker seeds:', JSON.stringify(seeds, null, 2));
    } finally {
        client.close();
    }
}

if (require.main === module) {
    const mode = process.argv[2];
    if (mode === 'broker') {
        startBroker();
    } else if (mode === 'client') {
        runClient().catch((error) => {
            console.error(error.message);
            process.exitCode = 1;
        });
    } else {
        console.log('Usage: node examples/pool-broker.js <broker [--light]|client>');
        process.exitCode = 1;
    }
}

module.exports = { PROTOCOL, BrokerClient, encodeFrame, createFrameDecoder };
