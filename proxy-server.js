const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const url = require('url');
const { app } = require('electron');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { SocksClient } = require('socks');

let pollTimer = null;
let scanTimer = null;
let sweepTimer = null;
let activeProtocol = 'v2';
const inProgress = new Set();

let sharedDir = null;
let sendLog = null;
let socksProxyUrl = null;

// Track active connections
// id -> { socket, req, isClosed, seqClientIn: 0, seqServerOut: 0 }
const activeConnections = new Map();

const POLL_MS = 20;

function log(type, msg) {
    if (sendLog) sendLog(type, msg);
}

function closeConnection(id, errorStr = null) {
    flushServerBuffer(id);
    const conn = activeConnections.get(id);
    if (!conn) return;

    if (errorStr) {
        log('error', `Connection ${id} error: ${errorStr}`);
    } else {
        log('system', `Connection ${id} closed`);
    }

    conn.isClosed = true;
    if (conn.socket && !conn.socket.destroyed) conn.socket.destroy();
    if (conn.req && !conn.req.destroyed) conn.req.destroy();

    try {
        fs.writeFileSync(path.join(sharedDir, `res_${id}_end.json`), JSON.stringify({ error: errorStr, maxSeq: conn.seqServerOut }), 'utf8');
    } catch (e) { }

    activeConnections.delete(id);
}

function processIncomingChunks() {
    if (!sharedDir) return;

    for (const [id, conn] of activeConnections.entries()) {
        if (conn.isClosed) continue;

        if (!conn.pendingEnd) {
            const endPath = path.join(sharedDir, `req_${id}_end.json`);
            if (fs.existsSync(endPath)) {
                try {
                    const data = JSON.parse(fs.readFileSync(endPath, 'utf8'));
                    conn.pendingEnd = true;
                    conn.endError = data.error;
                    conn.endMaxSeq = data.maxSeq || 0;
                    fs.unlinkSync(endPath);
                } catch (_) { }
            }
        }

        // Read all available contiguous chunks from client
        while (true) {
            const chunkPath = path.join(sharedDir, `req_${id}_${conn.seqClientIn}.dat`);
            if (!fs.existsSync(chunkPath)) break;

            try {
                const data = fs.readFileSync(chunkPath);

                if (conn.socket) {
                    conn.socket.write(data);
                } else if (conn.req) {
                    if (data.toString('utf8') === 'EOF_REQ_BODY') {
                        conn.req.end();
                    } else {
                        conn.req.write(data);
                    }
                }

                fs.unlinkSync(chunkPath);
                conn.seqClientIn++;
            } catch (e) {
                break; // could be locked, read next time
            }
        }

        if (conn.pendingEnd && conn.seqClientIn >= conn.endMaxSeq) {
            closeConnection(id, conn.endError);
        }
    }
}

function flushServerBuffer(id) {
    const conn = activeConnections.get(id);
    if (!conn || conn.isClosed || conn.outBuffer.length === 0) return;

    const buffer = Buffer.concat(conn.outBuffer);
    conn.outBuffer = [];
    conn.outBufferLen = 0;

    const seq = conn.seqServerOut++;
    const tmpPath = path.join(sharedDir, `res_${id}_${seq}.tmp`);
    const chunkPath = path.join(sharedDir, `res_${id}_${seq}.dat`);
    try {
        fs.writeFileSync(tmpPath, buffer);
        fs.renameSync(tmpPath, chunkPath);
    } catch (err) {
        log('error', `Failed to write chunk for ${id}`);
        closeConnection(id, 'File write error');
    }
}

function writeServerChunk(id, buffer, isolate = false) {
    const conn = activeConnections.get(id);
    if (!conn || conn.isClosed) return;

    if (isolate) {
        flushServerBuffer(id);
        conn.outBuffer.push(buffer);
        conn.outBufferLen += buffer.length;
        flushServerBuffer(id);
    } else {
        conn.outBuffer.push(buffer);
        conn.outBufferLen += buffer.length;
        if (conn.outBufferLen >= 128 * 1024) flushServerBuffer(id);
    }
}

function handleNewRequest(id, reqData) {
    activeConnections.set(id, {
        socket: null,
        req: null,
        isClosed: false,
        seqClientIn: 0,
        seqServerOut: 0,
        pendingEnd: false,
        endError: null,
        endMaxSeq: 0,
        outBuffer: [],
        outBufferLen: 0
    });

    const conn = activeConnections.get(id);

    // Write ACK so client can start streaming
    try {
        fs.writeFileSync(path.join(sharedDir, `ack_${id}.json`), JSON.stringify({ status: 200 }), 'utf8');
    } catch (e) {
        return closeConnection(id, 'Failed to ACK');
    }

    if (reqData.method === 'TUNNEL') {
        const isTls = reqData.url.startsWith('tls-tunnel://');
        const target = reqData.url.replace(isTls ? 'tls-tunnel://' : 'tunnel://', '');
        const [host, portStr] = target.split(':');
        const port = parseInt(portStr || (isTls ? '443' : '80'), 10);

        const onConnect = () => { /* connected */ };

        const bindSocketEvents = (socket) => {
            socket.on('data', (buf) => writeServerChunk(id, buf));
            socket.on('end', () => closeConnection(id));
            socket.on('error', (err) => closeConnection(id, err.message));
            conn.socket = socket;
        };

        if (socksProxyUrl) {
            const parsedSocks = url.parse(socksProxyUrl);
            const proxyOptions = {
                proxy: {
                    host: parsedSocks.hostname,
                    port: parseInt(parsedSocks.port, 10),
                    type: 5
                },
                command: 'connect',
                destination: { host, port }
            };

            SocksClient.createConnection(proxyOptions).then(info => {
                let socket = info.socket;
                if (isTls) {
                    socket = tls.connect({ socket, host, servername: host, rejectUnauthorized: false }, onConnect);
                }
                bindSocketEvents(socket);
            }).catch(err => {
                closeConnection(id, `SOCKS5 Tunnel Error: ${err.message}`);
            });
        } else {
            const socket = isTls
                ? tls.connect({ host, port, servername: host, rejectUnauthorized: false }, onConnect)
                : net.createConnection({ host, port }, onConnect);
            bindSocketEvents(socket);
        }
    } else {
        const parsed = url.parse(reqData.url);
        const transport = parsed.protocol === 'https:' ? https : http;

        const skipHeaders = new Set([
            'host', 'connection', 'proxy-connection', 'keep-alive',
            'proxy-authenticate', 'proxy-authorization', 'te', 'trailers',
            'transfer-encoding', 'upgrade',
        ]);

        const headers = {};
        for (const [k, v] of Object.entries(reqData.headers || {})) {
            if (!skipHeaders.has(k.toLowerCase())) headers[k] = v;
        }

        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: (parsed.path || '/'),
            method: reqData.method || 'GET',
            headers,
            rejectUnauthorized: false,
        };

        if (socksProxyUrl) {
            options.agent = new SocksProxyAgent(socksProxyUrl);
        }

        const req = transport.request(options, (res) => {
            // Write virtual "headers" chunk as the very first message 
            const headerPayload = Buffer.from(JSON.stringify({
                status: res.statusCode,
                headers: res.headers
            }));
            writeServerChunk(id, Buffer.concat([Buffer.from('HEAD\n'), headerPayload]), true);

            res.on('data', (buf) => writeServerChunk(id, buf));
            res.on('end', () => closeConnection(id));
        });

        req.on('error', (err) => closeConnection(id, err.message));

        conn.req = req;
        // Don't call req.end() immediately; it stays open for streaming chunks!
    }
}

let isScanning = false;
function scanForNewRequests() {
    if (!sharedDir || isScanning) return;
    isScanning = true;

    fs.readdir(sharedDir, (err, files) => {
        isScanning = false;
        if (err || !files) return;

        for (const f of files) {
            if (!f.startsWith('req_') || !f.endsWith('.json')) continue;
            if (f.includes('_end')) continue;

            const id = f.replace(/^req_/, '').replace(/\.json$/, '');
            if (activeConnections.has(id)) continue; // already processing

            const reqPath = path.join(sharedDir, f);

            fs.readFile(reqPath, 'utf8', (err2, raw) => {
                if (err2) return;
                let reqData;
                try { reqData = JSON.parse(raw); } catch (e) { return; }

                log('info', `→ New connection ${id} (${reqData.url})`);

                fs.unlink(reqPath, () => { });
                handleNewRequest(id, reqData);
            });
        }
    });
}

function poll() {
    for (const [id, conn] of activeConnections.entries()) {
        if (!conn.isClosed && conn.outBuffer.length > 0) {
            flushServerBuffer(id);
        }
    }
    processIncomingChunks();
}

let isSweeping = false;
const seenOrphans = new Map();

function sweepGarbage() {
    if (!sharedDir || isSweeping) return;
    isSweeping = true;
    fs.readdir(sharedDir, (err, files) => {
        if (err || !files) { isSweeping = false; return; }

        const currentFiles = new Set(files);
        const now = Date.now();

        for (const f of files) {
            const match = f.match(/^(?:req|res|ack)_([a-f0-9]+)/);
            if (!match) continue;
            const id = match[1];

            if (activeConnections.has(id)) {
                seenOrphans.delete(f);
                continue;
            }

            if (!seenOrphans.has(f)) {
                seenOrphans.set(f, now);
            } else {
                if (now - seenOrphans.get(f) > 15000) {
                    fs.unlink(path.join(sharedDir, f), () => { });
                    seenOrphans.delete(f);
                }
            }
        }

        for (const f of seenOrphans.keys()) {
            if (!currentFiles.has(f)) seenOrphans.delete(f);
        }

        isSweeping = false;
    });
}

// ── V1 Specific Functions ──
function doTunnelV1(reqData) {
    return new Promise((resolve) => {
        const target = reqData.url.replace('tunnel://', '');
        const [host, portStr] = target.split(':');
        const port = parseInt(portStr || '443', 10);
        const bodyBuf = reqData.body ? Buffer.from(reqData.body, 'base64') : Buffer.alloc(0);

        const socket = net.createConnection({ host, port }, () => {
            socket.write(bodyBuf);
        });

        const resChunks = [];
        let isDone = false;

        const end = (status, error = null) => {
            if (isDone) return;
            isDone = true;
            socket.destroy();
            resolve({ id: reqData.id, status, headers: {}, body: Buffer.concat(resChunks).toString('base64'), error });
        };

        const timer = setTimeout(() => end(200), 3000); // 3s buffer collection

        socket.on('data', (c) => resChunks.push(c));
        socket.on('end', () => { clearTimeout(timer); end(200); });
        socket.on('error', (err) => { clearTimeout(timer); end(502, err.message); });
        socket.setTimeout(10000, () => { clearTimeout(timer); end(200); });
    });
}

function doFetchV1(reqData) {
    if (reqData.method === 'TUNNEL') return doTunnelV1(reqData);

    return new Promise((resolve) => {
        const parsed = url.parse(reqData.url);
        const isHttps = parsed.protocol === 'https:';
        const transport = isHttps ? https : http;

        const bodyBuf = reqData.body ? Buffer.from(reqData.body, 'base64') : null;

        const skipHeaders = new Set(['host', 'connection', 'proxy-connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade']);
        const headers = {};
        for (const [k, v] of Object.entries(reqData.headers || {})) {
            if (!skipHeaders.has(k.toLowerCase())) headers[k] = v;
        }
        if (bodyBuf) headers['content-length'] = bodyBuf.length;

        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: (parsed.path || '/'),
            method: reqData.method || 'GET',
            headers,
            rejectUnauthorized: false,
            timeout: 30000
        };

        if (socksProxyUrl) options.agent = new SocksProxyAgent(socksProxyUrl);

        const req = transport.request(options, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                resolve({ id: reqData.id, status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('base64'), error: null });
            });
        });

        req.on('timeout', () => { req.destroy(); resolve({ id: reqData.id, status: 504, headers: {}, body: '', error: 'Timeout' }); });
        req.on('error', (err) => resolve({ id: reqData.id, status: 502, headers: {}, body: '', error: err.message }));

        if (bodyBuf) req.write(bodyBuf);
        req.end();
    });
}

async function processRequestV1(reqFile) {
    const reqPath = path.join(sharedDir, reqFile);
    const id = reqFile.replace(/^req_/, '').replace(/\.json$/, '');
    const resPath = path.join(sharedDir, `res_${id}.json`);

    let reqData;
    try { reqData = JSON.parse(fs.readFileSync(reqPath, 'utf8')); } catch (e) { return; }

    log('info', `→ ${reqData.method} ${reqData.url}`);
    const resData = await doFetchV1(reqData);

    try { fs.writeFileSync(resPath, JSON.stringify(resData), 'utf8'); } catch (e) { }
    try { fs.unlinkSync(reqPath); } catch (_) { }

    if (resData.error) log('error', `← ERROR: ${resData.error} (${id})`);
    else log('success', `← ${resData.status} OK (${id})`);
}

function pollV1() {
    if (!sharedDir) return;
    let files;
    try { files = fs.readdirSync(sharedDir); } catch (e) { return; }

    for (const f of files) {
        if (!f.startsWith('req_') || !f.endsWith('.json')) continue;
        if (inProgress.has(f)) continue;

        inProgress.add(f);
        processRequestV1(f).finally(() => inProgress.delete(f));
    }
}

module.exports = {
    start: async (config, logCb) => {
        sendLog = logCb;
        sharedDir = config.folder;
        socksProxyUrl = config.socks || null;
        activeProtocol = config.protocol || 'v2';
        if (!sharedDir || !fs.existsSync(sharedDir)) throw new Error('Invalid shared folder path.');

        // Clean up any zombie files from previous crashes
        try {
            const files = fs.readdirSync(sharedDir);
            let deleted = 0;
            for (const f of files) {
                if (f.startsWith('req_') || f.startsWith('res_') || f.startsWith('ack_')) {
                    try { fs.unlinkSync(path.join(sharedDir, f)); deleted++; } catch (_) { }
                }
            }
            if (deleted > 0) log('system', `Cleaned up ${deleted} zombie files on startup.`);
        } catch (e) {
            log('error', `Failed to cleanup folder: ${e.message}`);
        }

        if (activeProtocol === 'v1') {
            pollTimer = setInterval(pollV1, 200);
            log('system', `Server Proxy started in V1 Performance mode`);
        } else {
            pollTimer = setInterval(poll, 10);
            scanTimer = setInterval(scanForNewRequests, 200);
            log('system', `Server Proxy started in V2 Compatibility mode`);
        }

        sweepTimer = setInterval(sweepGarbage, 5000);
    },
    stop: async () => {
        clearInterval(pollTimer);
        clearInterval(scanTimer);
        clearInterval(sweepTimer);
        seenOrphans.clear();
        inProgress.clear();
        for (const id of activeConnections.keys()) closeConnection(id);
        sharedDir = null;
    }
};
