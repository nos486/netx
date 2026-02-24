const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const forge = require('node-forge');
const { app } = require('electron');

let proxyServer = null;
let sharedDir = null;
let sendLog = null;
const TIMEOUT_SEC = 60;
const POLL_MS = 150;

// CA Storage
let caCertPem = null;
let caPrivateKeyPem = null;

function log(type, msg) {
    if (sendLog) sendLog(type, msg);
}

function makeId() {
    return crypto.randomBytes(6).toString('hex');
}

// ── Shared Folder Logic ───────────────────────────────────────────────────────
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

// ── Certificate Generation (node-forge) ───────────────────────────────────────
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

    log('system', 'Generating new Root CA Certificate (this may take a moment)...');
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
    log('system', 'Generated and saved new Root CA Certificate.');
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

// ── HTTP Handlers ─────────────────────────────────────────────────────────────
async function proxyRequest(req, res, forceHttps = false) {
    let targetUrl = req.url;
    if (!targetUrl.startsWith('http')) {
        const protocol = forceHttps ? 'https://' : 'http://';
        targetUrl = protocol + req.headers.host + targetUrl;
    }

    const method = req.method;
    log('info', `→ ${method} ${targetUrl}`);

    const bodyBuf = await collectBody(req);
    const reqData = {
        method,
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
}

// ── HTTPS MITM CONNECT Handler ───────────────────────────────────────────────
function handleConnect(req, clientSocket, head) {
    const [hostname, port] = req.url.split(':');

    // Acknowledge the CONNECT
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    // Generate fake cert for the requested host
    const { key, cert } = generateHostCert(hostname);

    // Create an internal HTTPS server on-the-fly to handle the decrypted traffic
    const mitmServer = https.createServer({ key, cert }, (mitmReq, mitmRes) => {
        proxyRequest(mitmReq, mitmRes, true); // forceHttps = true
    });

    // We don't listen on a port; we just manually emit a connection event
    mitmServer.emit('connection', clientSocket);
}

// ── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
    start: async (config, logCb) => {
        sendLog = logCb;
        sharedDir = config.folder;
        const port = config.port || 8080;

        if (!sharedDir || !fs.existsSync(sharedDir)) throw new Error('Invalid shared folder path.');

        getOrGenerateCA();

        httpServer = http.createServer((req, res) => proxyRequest(req, res, false)); // Changed from proxyServer
        httpServer.on('connect', handleConnect); // Changed from proxyServer

        return new Promise((resolve, reject) => {
            httpServer.listen(port, '127.0.0.1', () => { // Changed from proxyServer
                log('system', `Client Proxy started on 127.0.0.1:${port}`);
                resolve();
            });
            httpServer.on('error', (e) => reject(e)); // Changed from proxyServer
        });
    },
    stop: async () => {
        if (httpServer) { // Changed from proxyServer
            httpServer.close(); // Changed from proxyServer
            httpServer = null; // Changed from proxyServer
        }
    }
};
