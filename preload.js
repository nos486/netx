const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
    startProxy: (config) => ipcRenderer.invoke('netx:start', config),
    stopProxy: (config) => ipcRenderer.invoke('netx:stop', config),
    launchBrowser: (port) => ipcRenderer.invoke('netx:launchBrowser', port),
    openCAFolder: () => ipcRenderer.send('netx:openCA'),
    onLogMessage: (callback) => ipcRenderer.on('netx:log', (_event, value) => callback(value))
});
