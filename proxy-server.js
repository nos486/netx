const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const url = require('url');

let pollTimer = null;
let sharedDir = null;
let sendLog = null;

// Track active connections
// id -> { socket, req, isClosed, seqClientIn: 0, seqServerOut: 0 }
const activeConnections = new Map();

const POLL_MS = 20;

function log(type, msg) {
    if (sendLog) sendLog(type, msg);
}

function closeConnection(id, errorStr = null) {
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

function writeServerChunk(id, buffer) {
    const conn = activeConnections.get(id);
    if (!conn || conn.isClosed) return;

    try {
        const chunkPath = path.join(sharedDir, `res_${id}_${conn.seqServerOut}.dat`);
        fs.writeFileSync(chunkPath, buffer);
        conn.seqServerOut++;
    } catch (e) {
        log('error', `Failed to write chunk for ${id}`);
        closeConnection(id, 'File write error');
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
        endMaxSeq: 0
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

        const socket = isTls
            ? tls.connect({ host, port, servername: host, rejectUnauthorized: false }, onConnect)
            : net.createConnection({ host, port }, onConnect);

        socket.on('data', (buf) => writeServerChunk(id, buf));
        socket.on('end', () => closeConnection(id));
        socket.on('error', (err) => closeConnection(id, err.message));

        conn.socket = socket;
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

        const req = transport.request(options, (res) => {
            // Write virtual "headers" chunk as the very first message 
            const headerPayload = Buffer.from(JSON.stringify({
                status: res.statusCode,
                headers: res.headers
            }));
            writeServerChunk(id, Buffer.concat([Buffer.from('HEAD\n'), headerPayload]));

            res.on('data', (buf) => writeServerChunk(id, Buffer.concat([Buffer.from('BODY\n'), buf])));
            res.on('end', () => closeConnection(id));
        });

        req.on('error', (err) => closeConnection(id, err.message));

        conn.req = req;
        // Don't call req.end() immediately; it stays open for streaming chunks!
    }
}

function scanForNewRequests() {
    if (!sharedDir) return;

    let files;
    try { files = fs.readdirSync(sharedDir); } catch (e) { return; }

    for (const f of files) {
        if (!f.startsWith('req_') || !f.endsWith('.json')) continue;
        if (f.includes('_end')) continue;

        const id = f.replace(/^req_/, '').replace(/\.json$/, '');
        if (activeConnections.has(id)) continue; // already processing

        const reqPath = path.join(sharedDir, f);
        let reqData;
        try {
            const raw = fs.readFileSync(reqPath, 'utf8');
            reqData = JSON.parse(raw);
        } catch (e) { continue; }

        log('info', `→ New connection ${id} (${reqData.url})`);

        // Remove init file
        try { fs.unlinkSync(reqPath); } catch (_) { }

        handleNewRequest(id, reqData);
    }
}

function poll() {
    scanForNewRequests();
    processIncomingChunks();
}

module.exports = {
    start: async (config, logCb) => {
        sendLog = logCb;
        sharedDir = config.folder;
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

        pollTimer = setInterval(poll, POLL_MS);
        log('system', `Server Proxy started. Watching folder: ${sharedDir}`);
    },
    stop: async () => {
        clearInterval(pollTimer);
        for (const id of activeConnections.keys()) closeConnection(id);
        sharedDir = null;
    }
};
