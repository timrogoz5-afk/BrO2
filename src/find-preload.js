const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('findPage', {
  search: (text, direction) => ipcRenderer.send('browser:find-text', text, direction),
  close: () => ipcRenderer.send('browser:close-find'),
  onFocus: (callback) => ipcRenderer.on('browser:find-focus', (_event, settings, fresh) => callback(settings, fresh)),
  onResult: (callback) => ipcRenderer.on('browser:find-result', (_event, result) => callback(result)),
});
