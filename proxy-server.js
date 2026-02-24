const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const url = require('url');

let pollTimer = null;
let sharedDir = null;
let sendLog = null;
const inProgress = new Set();
const POLL_MS = 200;

function log(type, msg) {
    if (sendLog) sendLog(type, msg);
}

// ── Main fetch function ───────────────────────────────────────────────────────
function doTunnel(reqData) {
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
        socket.on('end', () => {
            clearTimeout(timer);
            end(200);
        });
        socket.on('error', (err) => {
            clearTimeout(timer);
            end(502, err.message);
        });
        socket.setTimeout(10000, () => {
            clearTimeout(timer);
            end(200);
        });
    });
}

function doFetch(reqData) {
    if (reqData.method === 'TUNNEL') return doTunnel(reqData);

    return new Promise((resolve) => {
        const parsed = url.parse(reqData.url);
        const isHttps = parsed.protocol === 'https:';
        const transport = isHttps ? https : http;

        const bodyBuf = reqData.body ? Buffer.from(reqData.body, 'base64') : null;

        const skipHeaders = new Set([
            'host', 'connection', 'proxy-connection', 'keep-alive',
            'proxy-authenticate', 'proxy-authorization', 'te', 'trailers',
            'transfer-encoding', 'upgrade',
        ]);

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
            rejectUnauthorized: false, // allow self-signed on target
            timeout: 30000,
        };

        const req = transport.request(options, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                resolve({
                    id: reqData.id,
                    status: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks).toString('base64'),
                    error: null,
                });
            });
        });

        req.on('timeout', () => {
            req.destroy();
            resolve({ id: reqData.id, status: 504, headers: {}, body: '', error: 'Request/Response Timeout' });
        });

        req.on('error', (err) => {
            resolve({ id: reqData.id, status: 502, headers: {}, body: '', error: err.message });
        });

        if (bodyBuf) req.write(bodyBuf);
        req.end();
    });
}

// ── File Watcher ─────────────────────────────────────────────────────────────
async function processRequest(reqFile) {
    const reqPath = path.join(sharedDir, reqFile);
    const id = reqFile.replace(/^req_/, '').replace(/\.json$/, '');
    const resPath = path.join(sharedDir, `res_${id}.json`);

    let reqData;
    try {
        const raw = fs.readFileSync(reqPath, 'utf8');
        reqData = JSON.parse(raw);
    } catch (e) {
        return; // File might be incomplete, retry next poll
    }

    log('info', `→ ${reqData.method} ${reqData.url}`);

    const resData = await doFetch(reqData);

    try { fs.writeFileSync(resPath, JSON.stringify(resData), 'utf8'); } catch (e) { }
    try { fs.unlinkSync(reqPath); } catch (_) { }

    if (resData.error) {
        log('error', `← ERROR: ${resData.error} (${id})`);
    } else {
        log('success', `← ${resData.status} OK (${id})`);
    }
}

function poll() {
    if (!sharedDir) return;

    let files;
    try { files = fs.readdirSync(sharedDir); }
    catch (e) { log('error', `Cannot read folder: ${e.message}`); return; }

    for (const f of files) {
        if (!f.startsWith('req_') || !f.endsWith('.json')) continue;
        if (inProgress.has(f)) continue;

        inProgress.add(f);
        processRequest(f).finally(() => inProgress.delete(f));
    }
}

module.exports = {
    start: async (config, logCb) => {
        sendLog = logCb;
        sharedDir = config.folder;
        if (!sharedDir || !fs.existsSync(sharedDir)) throw new Error('Invalid shared folder path.');

        pollTimer = setInterval(poll, POLL_MS);
        log('system', `Server Proxy started. Watching folder: ${sharedDir}`);
    },
    stop: async () => {
        clearInterval(pollTimer);
        sharedDir = null;
        inProgress.clear();
    }
};
