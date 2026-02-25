const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const forge = require('node-forge');
const crypto = require('crypto');
const { app } = require('electron');

let httpServer = null;
let sharedDir = null;
let sendLog = null;
let pollTimer = null;
let sweepTimer = null;
let activeProtocol = 'v2';

const TIMEOUT_SEC = 60;
const POLL_MS = 150;

// Track active connections
// id -> { res, clientSocket, isClosed, seqClientOut: 0, seqServerIn: 0 }
const activeConnections = new Map();

// CA Storage
let caCertPem = null;
let caPrivateKeyPem = null;

function log(type, msg) {
    if (sendLog) sendLog(type, msg);
}

function makeId() {
    return crypto.randomBytes(6).toString('hex');
}

function closeConnection(id, errorStr = null) {
    flushClientBuffer(id);
    const conn = activeConnections.get(id);
    if (!conn) return;

    conn.isClosed = true;

    // HTTP connection end
    if (conn.res && !conn.res.headersSent) {
        conn.res.writeHead(502);
        conn.res.end(errorStr || 'Connection closed');
    } else if (conn.res && !conn.res.writableEnded) {
        conn.res.end();
    }

    // TCP/WebSocket connection end
    if (conn.clientSocket && !conn.clientSocket.destroyed) {
        conn.clientSocket.destroy();
    }

    try {
        fs.writeFileSync(path.join(sharedDir, `req_${id}_end.json`), JSON.stringify({ error: errorStr, maxSeq: conn.seqClientOut }), 'utf8');
    } catch (e) { }

    activeConnections.delete(id);
}

function flushClientBuffer(id) {
    const conn = activeConnections.get(id);
    if (!conn || conn.isClosed || conn.outBuffer.length === 0) return;

    const buffer = Buffer.concat(conn.outBuffer);
    conn.outBuffer = [];
    conn.outBufferLen = 0;

    const seq = conn.seqClientOut++;
    const tmpPath = path.join(sharedDir, `req_${id}_${seq}.tmp`);
    const chunkPath = path.join(sharedDir, `req_${id}_${seq}.dat`);
    try {
        fs.writeFileSync(tmpPath, buffer);
        fs.renameSync(tmpPath, chunkPath);
    } catch (err) {
        log('error', `Failed to write client chunk for ${id}`);
        closeConnection(id, 'File write error');
    }
}

function writeClientChunk(id, buffer, isolate = false) {
    const conn = activeConnections.get(id);
    if (!conn || conn.isClosed) return;

    if (isolate) {
        flushClientBuffer(id);
        conn.outBuffer.push(buffer);
        conn.outBufferLen += buffer.length;
        flushClientBuffer(id);
    } else {
        conn.outBuffer.push(buffer);
        conn.outBufferLen += buffer.length;
        if (conn.outBufferLen >= 512 * 1024) flushClientBuffer(id);
    }
}

function processIncomingChunks() {
    if (!sharedDir) return;

    for (const [id, conn] of activeConnections.entries()) {
        if (conn.isClosed) continue;

        // Check for end signal from server
        if (!conn.pendingEnd) {
            const endPath = path.join(sharedDir, `res_${id}_end.json`);
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

        // Read all available contiguous chunks from server
        while (true) {
            const chunkPath = path.join(sharedDir, `res_${id}_${conn.seqServerIn}.dat`);
            if (!fs.existsSync(chunkPath)) break;

            try {
                const data = fs.readFileSync(chunkPath);

                if (conn.clientSocket) {
                    conn.clientSocket.write(data);
                } else if (conn.res) {
                    // For HTTP proxy responses, the very first server chunk is the header payload
                    const strData = data.toString('utf8');
                    if (!conn.headersSent && strData.startsWith('HEAD\n')) {
                        const payloadStr = strData.substring(5);
                        try {
                            const { status, headers } = JSON.parse(payloadStr);
                            conn.res.writeHead(status, headers || {});
                            conn.headersSent = true;
                        } catch (e) {
                            log('error', `Failed to parse headers: ${e.message}`);
                        }
                    } else if (conn.headersSent) {
                        conn.res.write(data);
                    }
                }

                fs.unlinkSync(chunkPath);
                conn.seqServerIn++;
            } catch (e) {
                // Ignore read errors, can be locked by writer
                break;
            }
        }

        if (conn.pendingEnd && conn.seqServerIn >= conn.endMaxSeq) {
            closeConnection(id, conn.endError);
        }
    }
}

function poll() {
    for (const [id, conn] of activeConnections.entries()) {
        if (!conn.isClosed && conn.outBuffer.length > 0) {
            flushClientBuffer(id);
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

// ── Connection Init ───────────────────────────────────────────────────────────
async function openTunnel(reqData, res = null, clientSocket = null) {
    const id = makeId();
    const reqPath = path.join(sharedDir, `req_${id}.json`);
    const ackPath = path.join(sharedDir, `ack_${id}.json`);

    reqData.id = id;

    // Track the new connection immediately
    activeConnections.set(id, {
        res,
        clientSocket,
        isClosed: false,
        seqClientOut: 0,
        seqServerIn: 0,
        headersSent: false,
        pendingEnd: false,
        endError: null,
        endMaxSeq: 0,
        outBuffer: [],
        outBufferLen: 0
    });

    try {
        fs.writeFileSync(reqPath, JSON.stringify(reqData), 'utf8');
        log('info', `Waiting for ACK on ${id} (${reqData.url})`);
    } catch (e) {
        closeConnection(id, `Cannot write Init file: ${e.message}`);
        return null;
    }

    // Wait for the ACK
    return new Promise((resolve) => {
        const timer = setInterval(() => {
            if (!activeConnections.has(id) || activeConnections.get(id).isClosed) {
                clearInterval(timer);
                return resolve(null); // closed while waiting
            }

            if (fs.existsSync(ackPath)) {
                clearInterval(timer);
                try { fs.unlinkSync(ackPath); } catch (_) { }
                resolve(id);
            }
        }, POLL_MS);

        // 30s connection timeout
        setTimeout(() => {
            if (activeConnections.has(id) && !fs.existsSync(ackPath)) {
                clearInterval(timer);
                closeConnection(id, 'Tunnel connection timeout');
                resolve(null);
            }
        }, 30000);
    });
}

// ── Shared Forge / Headers code ──────────────────────────────────────────────
function sendViaFiles(reqData) {
    return new Promise((resolve, reject) => {
        const id = makeId();
        const reqPath = path.join(sharedDir, `req_${id}.json`);
        const resPath = path.join(sharedDir, `res_${id}.json`);

        reqData.id = id;

        try { fs.writeFileSync(reqPath, JSON.stringify(reqData), 'utf8'); }
        catch (e) { return reject(new Error(`Cannot write request: ${e.message}`)); }

        const deadline = Date.now() + TIMEOUT_SEC * 1000;
        const timer = setInterval(() => {
            if (!fs.existsSync(resPath)) {
                if (Date.now() > deadline) {
                    clearInterval(timer);
                    try { fs.unlinkSync(reqPath); } catch (_) { }
                    reject(new Error('Timeout waiting for server'));
                }
                return;
            }
            clearInterval(timer);
            let resData;
            try {
                const raw = fs.readFileSync(resPath, 'utf8');
                resData = JSON.parse(raw);
            } catch (e) {
                return reject(new Error(`Bad response file: ${e.message}`));
            }
            try { fs.unlinkSync(resPath); } catch (_) { }
            resolve(resData);
        }, POLL_MS);
    });
}

function collectBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', () => resolve(Buffer.alloc(0)));
    });
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade', 'proxy-connection']);
function filterHeaders(headers) {
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
    }
    return out;
}

function getOrGenerateCA() {
    const certsDir = path.join(app.getPath('userData'), 'certs');
    if (!fs.existsSync(certsDir)) fs.mkdirSync(certsDir, { recursive: true });

    const certPath = path.join(certsDir, 'netx-ca.crt');
    const keyPath = path.join(certsDir, 'netx-ca.key');

    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        caCertPem = fs.readFileSync(certPath, 'utf8');
        caPrivateKeyPem = fs.readFileSync(keyPath, 'utf8');
        log('system', 'Loaded existing Root CA Certificate.');
        return;
    }

    log('system', 'Generating new Root CA Certificate...');
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

    const attrs = [
        { name: 'commonName', value: 'NetX Local Root CA' },
        { name: 'organizationName', value: 'NetX Desktop Proxy' }
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([{ name: 'basicConstraints', cA: true }]);

    cert.sign(keys.privateKey, forge.md.sha256.create());

    caCertPem = forge.pki.certificateToPem(cert);
    caPrivateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);

    fs.writeFileSync(certPath, caCertPem, 'utf8');
    fs.writeFileSync(keyPath, caPrivateKeyPem, 'utf8');
    log('system', 'Generated new Root CA Certificate.');
}

const hostCertCache = {};
function generateHostCert(hostname) {
    if (hostCertCache[hostname]) return hostCertCache[hostname];

    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = Math.floor(Math.random() * 100000).toString() + '';
    cert.validity.notBefore = new Date();
    cert.validity.notBefore.setDate(cert.validity.notBefore.getDate() - 1);
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

    const attrs = [{ name: 'commonName', value: hostname }];
    cert.setSubject(attrs);

    const caCert = forge.pki.certificateFromPem(caCertPem);
    cert.setIssuer(caCert.subject.attributes);
    cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] }]);

    const caKey = forge.pki.privateKeyFromPem(caPrivateKeyPem);
    cert.sign(caKey, forge.md.sha256.create());

    const certPem = forge.pki.certificateToPem(cert);
    const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

    hostCertCache[hostname] = { key: keyPem, cert: certPem };
    return hostCertCache[hostname];
}

// ── Handlers ─────────────────────────────────────────────────────────────────
async function proxyRequest(req, res, forceHttps = false) {
    let targetUrl = req.url;
    if (!targetUrl.startsWith('http')) {
        const protocol = forceHttps ? 'https://' : 'http://';
        targetUrl = protocol + req.headers.host + targetUrl;
    }

    log('info', `→ ${req.method} ${targetUrl}`);

    if (activeProtocol === 'v1') {
        const bodyBuf = await collectBody(req);
        const reqData = {
            method: req.method,
            url: targetUrl,
            headers: filterHeaders(req.headers),
            body: bodyBuf.length > 0 ? bodyBuf.toString('base64') : null,
        };

        let resData;
        try {
            resData = await sendViaFiles(reqData);
        } catch (e) {
            log('error', `Proxy error for ${targetUrl}: ${e.message}`);
            if (!res.headersSent) {
                res.writeHead(502);
                res.end(`NetX Proxy Error: ${e.message}`);
            }
            return;
        }

        if (resData.error) log('warning', `Server error: ${resData.error}`);
        else log('success', `← ${resData.status} ${targetUrl}`);

        if (!res.headersSent) {
            res.writeHead(resData.status || 200, filterHeaders(resData.headers || {}));
            if (resData.body) res.end(Buffer.from(resData.body, 'base64'));
            else res.end();
        }
        return; // End V1 processing
    }

    const reqData = {
        method: req.method,
        url: targetUrl,
        headers: filterHeaders(req.headers)
    };

    const id = await openTunnel(reqData, res, null);
    if (!id) return; // connection failed or timed out

    // Stream body up
    req.on('data', (c) => writeClientChunk(id, c));
    req.on('end', () => {
        writeClientChunk(id, Buffer.from('EOF_REQ_BODY'), true);
    });
    req.on('error', () => closeConnection(id));
    res.on('close', () => closeConnection(id)); // If browser drops while we are downloading
}

async function handleConnect(req, clientSocket, head) {
    const [hostname, port] = req.url.split(':');

    // Is it a direct TCP WebSocket upgrade or true HTTP Connect?
    // We will just do full TLS MITM for everything to read the target URL correctly.
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    const { key, cert } = generateHostCert(hostname);

    // We use a custom TLS server to decrypt the HTTPS traffic
    const mitmServer = https.createServer({ key, cert });

    mitmServer.on('request', (mitmReq, mitmRes) => {
        proxyRequest(mitmReq, mitmRes, true);
    });

    // ── WebSocket Upgrade Support ──
    mitmServer.on('upgrade', async (mitmReq, mitmSocket, mitmHead) => {
        log('info', `→ WS Upgrade: ${mitmReq.url}`);

        const reqData = {
            method: 'TUNNEL', // We tell server to open a raw TCP or TLS tunnel
            url: (parseInt(port, 10) === 443) ? `tls-tunnel://${hostname}:${port}` : `tunnel://${hostname}:${port}`
        };

        const id = await openTunnel(reqData, null, mitmSocket);
        if (!id) return;

        // The WebSocket handshake must be forwarded as exact bytes, but we must
        // translate the URL back to a relative path and ensure Origin/Host match
        const parsedUrl = url.parse(mitmReq.url);
        const relativePath = parsedUrl.path || '/';

        const reqLines = [`${mitmReq.method} ${relativePath} HTTP/${mitmReq.httpVersion}`];
        for (let i = 0; i < mitmReq.rawHeaders.length; i += 2) {
            let key = mitmReq.rawHeaders[i];
            let val = mitmReq.rawHeaders[i + 1];

            // VMware Horizon requires Origin to match the Host exactly
            if (key.toLowerCase() === 'origin') {
                val = (parseInt(port, 10) === 443 ? 'https://' : 'http://') + hostname;
            }
            if (key.toLowerCase() === 'host') {
                val = hostname;
            }

            reqLines.push(`${key}: ${val}`);
        }
        reqLines.push('\r\n');

        writeClientChunk(id, Buffer.from(reqLines.join('\r\n')));
        if (mitmHead && mitmHead.length > 0) writeClientChunk(id, mitmHead);

        mitmSocket.on('data', (buf) => writeClientChunk(id, buf));
        mitmSocket.on('end', () => closeConnection(id));
        mitmSocket.on('error', () => closeConnection(id));
    });

    mitmServer.emit('connection', clientSocket);
}

// ── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
    start: async (config, logCb) => {
        sendLog = logCb;
        sharedDir = config.folder;
        activeProtocol = config.protocol || 'v2';
        const port = config.port || 8080;

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

        getOrGenerateCA();

        httpServer = http.createServer((req, res) => proxyRequest(req, res, false));
        httpServer.on('connect', handleConnect);

        pollTimer = setInterval(poll, 10);
        sweepTimer = setInterval(sweepGarbage, 5000);

        return new Promise((resolve, reject) => {
            httpServer.listen(port, '127.0.0.1', () => {
                log('system', `Client Proxy started on 127.0.0.1:${port}`);
                resolve();
            });
            httpServer.on('error', (e) => reject(e));
        });
    },
    stop: async () => {
        clearInterval(pollTimer);
        clearInterval(sweepTimer);
        seenOrphans.clear();
        for (const id of activeConnections.keys()) closeConnection(id);

        if (httpServer) {
            httpServer.close();
            httpServer = null;
        }
    }
};
