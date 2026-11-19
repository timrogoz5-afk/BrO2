const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bro2Panel', {
  send: (action, value) => ipcRenderer.send('password:panel', action, value),
  onPanel: (callback) => ipcRenderer.on('password:panel', (_event, panel, focus, style) => callback(panel, focus, style)),
});
