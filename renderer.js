// Elements
const btnModeServer = document.getElementById('btn-mode-server');
const btnModeClient = document.getElementById('btn-mode-client');
const clientSettings = document.getElementById('client-settings');
const serverSettings = document.getElementById('server-settings');

const inputFolder = document.getElementById('input-folder');
const btnBrowse = document.getElementById('btn-browse');
const inputPort = document.getElementById('input-port');
const inputSocks = document.getElementById('input-socks');

const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');
const btnToggle = document.getElementById('btn-toggle');

const viewLogs = document.getElementById('view-logs');
const viewBrowser = document.getElementById('view-browser');
const logContainer = document.getElementById('log-container');
const btnClear = document.getElementById('btn-clear');

const btnLaunchChrome = document.getElementById('btn-launch-chrome');

// State
let isRunning = false;
let currentMode = 'server'; // 'server' | 'client'

// Mode Switching
function setMode(mode) {
    if (isRunning) return; // Cannot switch mode while running
    currentMode = mode;
    localStorage.setItem('netx-mode', mode);

    if (mode === 'server') {
        btnModeServer.className = 'flex-1 py-2 text-sm font-medium rounded-md bg-blue-600 text-white shadow-sm transition-colors';
        btnModeClient.className = 'flex-1 py-2 text-sm font-medium rounded-md text-slate-400 hover:text-slate-200 transition-colors';
        clientSettings.classList.add('hidden');
        serverSettings.classList.remove('hidden');
        viewLogs.classList.remove('hidden');
        viewBrowser.classList.add('hidden');
    } else {
        btnModeClient.className = 'flex-1 py-2 text-sm font-medium rounded-md bg-blue-600 text-white shadow-sm transition-colors';
        btnModeServer.className = 'flex-1 py-2 text-sm font-medium rounded-md text-slate-400 hover:text-slate-200 transition-colors';
        clientSettings.classList.remove('hidden');
        serverSettings.classList.add('hidden');
        // Don't show browser view until running
        viewLogs.classList.remove('hidden');
        viewBrowser.classList.add('hidden');
    }
}

// Initial setup to handle the fresh startup state
const savedMode = localStorage.getItem('netx-mode') || 'server';
const savedFolder = localStorage.getItem('netx-folder') || '';
const savedPort = localStorage.getItem('netx-port') || '8080';
const savedSocks = localStorage.getItem('netx-socks') || '';

inputFolder.value = savedFolder;
inputPort.value = savedPort;
inputSocks.value = savedSocks;
if (savedFolder) btnToggle.disabled = false;

setMode(savedMode);

btnModeServer.addEventListener('click', () => setMode('server'));
btnModeClient.addEventListener('click', () => setMode('client'));

// Folder Selection
btnBrowse.addEventListener('click', async () => {
    const folder = await window.electronAPI.selectFolder();
    if (folder) {
        inputFolder.value = folder;
        localStorage.setItem('netx-folder', folder);
        btnToggle.disabled = false;
    }
});

// Port/Socks saving
inputPort.addEventListener('change', () => localStorage.setItem('netx-port', inputPort.value));
inputSocks.addEventListener('change', () => localStorage.setItem('netx-socks', inputSocks.value));

// Start / Stop
btnToggle.addEventListener('click', async () => {
    const config = {
        mode: currentMode,
        folder: inputFolder.value,
        port: parseInt(inputPort.value, 10) || 8080,
        socks: inputSocks.value.trim()
    };

    if (!isRunning) {
        // START
        btnToggle.disabled = true;
        btnToggle.innerText = 'Starting...';
        logContainer.innerHTML = ''; // Auto-clear logs on start

        const result = await window.electronAPI.startProxy(config);
        if (result.success) {
            isRunning = true;
            btnToggle.innerText = 'Stop Proxy';
            btnToggle.className = 'bg-red-600 hover:bg-red-500 px-8 py-2.5 rounded-lg font-semibold shadow-lg shadow-red-500/20 transition-all';
            statusIndicator.className = 'w-3 h-3 rounded-full bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)] animate-pulse';
            statusText.innerText = 'Running';
            statusText.className = 'text-sm font-medium text-emerald-400';

            // If client, swap to browser view and auto-launch
            if (currentMode === 'client') {
                viewLogs.classList.add('hidden');
                viewBrowser.classList.remove('hidden');
                btnLaunchChrome.click();
            }
        } else {
            appendLog('error', 'Failed to start: ' + result.error);
            btnToggle.innerText = 'Start Proxy';
        }
        btnToggle.disabled = false;
    } else {
        // STOP
        btnToggle.disabled = true;
        btnToggle.innerText = 'Stopping...';

        await window.electronAPI.stopProxy(config);

        isRunning = false;
        btnToggle.innerText = 'Start Proxy';
        btnToggle.className = 'bg-blue-600 hover:bg-blue-500 px-8 py-2.5 rounded-lg font-semibold shadow-lg shadow-blue-500/20 transition-all';
        statusIndicator.className = 'w-3 h-3 rounded-full bg-slate-600 shadow-[0_0_10px_rgba(71,85,105,0.5)]';
        statusText.innerText = 'Stopped';
        statusText.className = 'text-sm font-medium text-slate-400';
        btnToggle.disabled = false;
        appendLog('system', 'Service stopped.');

        // If client, revert to logs view
        if (currentMode === 'client') {
            viewBrowser.classList.add('hidden');
            viewLogs.classList.remove('hidden');
        }
    }
});

// Logs
function appendLog(type, message, time = new Date().toLocaleTimeString()) {
    const div = document.createElement('div');
    div.className = 'flex gap-3 hover:bg-white/5 px-2 py-0.5 rounded transition-colors break-all';

    let colorClass = 'text-slate-300';
    if (type === 'error') colorClass = 'text-red-400';
    if (type === 'system') colorClass = 'text-blue-400';
    if (type === 'success') colorClass = 'text-emerald-400';
    if (type === 'warning') colorClass = 'text-amber-400';

    div.innerHTML = `
    <span class="text-slate-600 shrink-0">[${time}]</span>
    <span class="${colorClass}">${message}</span>
  `;

    logContainer.appendChild(div);

    // Keep max 500 logs
    if (logContainer.children.length > 500) {
        logContainer.removeChild(logContainer.firstChild);
    }

    // Always auto-scroll to latest log
    requestAnimationFrame(() => {
        logContainer.scrollTop = logContainer.scrollHeight + 100;
    });
}

btnClear.addEventListener('click', () => {
    logContainer.innerHTML = '';
});

// Listen for logs from main process
window.electronAPI.onLogMessage((log) => {
    appendLog(log.type, log.message, log.time);
});

// Launch Chrome
btnLaunchChrome.addEventListener('click', async () => {
    const port = parseInt(inputPort.value, 10) || 8080;
    const oldHtml = btnLaunchChrome.innerHTML;
    btnLaunchChrome.disabled = true;
    btnLaunchChrome.innerText = 'Launching...';

    await window.electronAPI.launchBrowser(port);

    btnLaunchChrome.innerHTML = oldHtml;
    btnLaunchChrome.disabled = false;
});
