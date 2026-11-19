const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('extensionMenu', {
  send: (action, id) => ipcRenderer.send('extension-menu:action', action, id),
  onState: (callback) => ipcRenderer.on('extension-menu:state', (_event, entries, settings, error) => callback(entries, settings, error)),
  onError: (callback) => ipcRenderer.on('extension-menu:error', (_event, message) => callback(message)),
});
