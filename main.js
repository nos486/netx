const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('node:path');
const chromeLauncher = require('chrome-launcher');

app.commandLine.appendSwitch('ignore-certificate-errors');

// These two modules will be created next
let proxyServer, proxyClient;
try {
    proxyServer = require('./proxy-server');
    proxyClient = require('./proxy-client');
} catch (e) {
    // If they don't exist yet, we mock them for UI dev
}

let mainWindow;

const createWindow = () => {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 700,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
        },
        titleBarStyle: 'hiddenInset',
        backgroundColor: '#0f172a',
    });

    mainWindow.loadFile('index.html');
};

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// ── IPC Handlers ────────────────────────────────────────────────────────────

// 1. Select Folder
ipcMain.handle('dialog:selectFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory']
    });
    return result.filePaths[0] || null;
});

// 2. Start Proxy
ipcMain.handle('netx:start', async (event, config) => {
    try {
        if (config.mode === 'server') {
            if (proxyServer) await proxyServer.start(config, sendLog);
        } else {
            if (proxyClient) await proxyClient.start(config, sendLog);
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 3. Stop Proxy
ipcMain.handle('netx:stop', async (event, config) => {
    try {
        if (config.mode === 'server') {
            if (proxyServer) await proxyServer.stop();
        } else {
            if (proxyClient) await proxyClient.stop();
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 4. Launch isolated Real Browser
ipcMain.handle('netx:launchBrowser', async (event, port) => {
    try {
        const profilePath = path.join(app.getPath('userData'), 'chrome-netx-profile');
        await chromeLauncher.launch({
            startingUrl: 'https://google.com',
            chromeFlags: [
                `--proxy-server=http=127.0.0.1:${port};https=127.0.0.1:${port}`,
                '--ignore-certificate-errors',
                `--user-data-dir=${profilePath}`,
                '--no-first-run'
            ]
        });
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 5. Open Cert Folder (Client only, to install CA)
ipcMain.on('netx:openCA', () => {
    const certPath = path.join(app.getPath('userData'), 'certs');
    shell.openPath(certPath);
});

// Helper to push logs to UI
function sendLog(type, message) {
    if (mainWindow) {
        mainWindow.webContents.send('netx:log', { type, message, time: new Date().toLocaleTimeString() });
    }
}
