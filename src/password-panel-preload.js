const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bro2Panel', {
  send: (action, value) => ipcRenderer.send('password:panel', action, value),
  onPanel: (callback) => ipcRenderer.on('password:panel', (_event, panel, focus, style) => {
    document.documentElement.dataset.theme = style.theme;
    document.documentElement.dataset.motion = style.motion;
    document.documentElement.style.setProperty('--theme-accent', style.accent);
    callback(panel, focus);
  }),
});
