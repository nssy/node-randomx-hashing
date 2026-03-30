/**
 * Example: shared RandomX broker for Node.js pool workers.
 *
 * Why this pattern exists:
 * - A RandomX fast dataset is expensive in RAM.
 * - Pool workers usually do not need their own separate dataset copies.
 * - A small number of broker processes can hold the dataset(s), while pool workers
 *   send hash requests over a local socket.
 *
 * This example mirrors the pool-side architecture:
 * - one broker process
 * - one seed cache (`maxSeeds`: current + previous seed_hash)
 * - optional VM pool per seed (`vmPoolSize`) for parallel hashing
 * - simple length-prefixed socket frames using `v8.serialize`
 *
 * Run broker:
 *   node examples/pool-broker.js broker
 *
 * Run demo client:
 *   node examples/pool-broker.js client
 */

'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const v8 = require('v8');
const randomx = require('../index');

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

function startBroker() {
    const rxCache = randomx.createPoolSeedPool({
        maxSeeds: 2,
        vmPoolSize: 2,
        mode: 'fast',
        threads: Math.max(1, os.cpus().length),
        enableHugePages: false,
        idleEvictMs: 60000
    });

    const server = net.createServer((socket) => {
        socket.setNoDelay(true);

        socket.on('data', createFrameDecoder(async (message) => {
            if (!message || message.op !== 'hash') {
                socket.write(encodeFrame({ id: message && message.id, ok: false, error: 'unsupported op' }));
                return;
            }

            try {
                const hash = await rxCache.hashAsync(message.seed, message.input);
                socket.write(encodeFrame({ id: message.id, ok: true, hash }));
            } catch (error) {
                socket.write(encodeFrame({
                    id: message.id,
                    ok: false,
                    error: error && error.message ? error.message : String(error)
                }));
            }
        }));
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
        console.log(`RandomX broker listening on ${SOCKET_PATH}`);
        console.log('Config:', {
            maxSeeds: 2,
            vmPoolSize: 2,
            mode: 'fast'
        });
    });

    setInterval(() => {
        const stats = randomx.getStats();
        console.log('RandomX stats:', {
            totalHashes: stats.totalHashes,
            activeVMs: stats.activeVMs,
            activeSeeds: stats.activeSeeds,
            averageHashTime: Number(stats.averageHashTime || 0).toFixed(3),
            cacheSnapshot: rxCache.getSnapshot()
        });
    }, 30000);

    process.on('exit', cleanupSocketFile);
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

function runClient() {
    let nextId = 0;
    const pending = new Map();

    const socket = net.createConnection(SOCKET_PATH);
    socket.setNoDelay(true);

    socket.on('data', createFrameDecoder((message) => {
        const request = pending.get(message.id);
        if (!request) {
            return;
        }
        pending.delete(message.id);
        if (message.ok) {
            request.resolve(message.hash);
        } else {
            request.reject(new Error(message.error || 'broker error'));
        }
    }));

    function hash(seed, input) {
        return new Promise((resolve, reject) => {
            const id = ++nextId;
            pending.set(id, { resolve, reject });
            socket.write(encodeFrame({ id, op: 'hash', seed, input }));
        });
    }

    socket.on('connect', async () => {
        console.log(`Connected to ${SOCKET_PATH}`);

        const seed = Buffer.alloc(32, 7);
        const totalRequests = 12;
        const concurrency = 3;
        let completed = 0;
        let totalMs = 0;

        try {
            async function runOne(index) {
                const input = Buffer.alloc(76, index & 0xff);
                const startedAt = Date.now();
                const result = await hash(seed, input);
                totalMs += Date.now() - startedAt;
                completed++;
                return result;
            }

            let nextIndex = 0;
            const sampleHashes = [];
            const workers = Array.from({ length: concurrency }, async () => {
                while (nextIndex < totalRequests) {
                    const index = nextIndex++;
                    const result = await runOne(index);
                    if (sampleHashes.length < 2) {
                        sampleHashes.push(result);
                    }
                }
            });

            await Promise.all(workers);

            console.log('Client summary:', {
                totalRequests,
                concurrency,
                completed,
                avgMs: Number(totalMs / completed).toFixed(3),
                sampleHashPrefix: sampleHashes[0].toString('hex').slice(0, 16) + '…'
            });
        } catch (error) {
            console.error(error.message);
        } finally {
            socket.end();
        }
    });
}

if (require.main === module) {
    const mode = process.argv[2];
    if (mode === 'broker') {
        startBroker();
    } else if (mode === 'client') {
        runClient();
    } else {
        console.log('Usage: node examples/pool-broker.js <broker|client>');
        process.exitCode = 1;
    }
}
