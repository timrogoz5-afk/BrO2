const { ipcRenderer } = require('electron');

if (/^https?:$/.test(location.protocol)) {
  let recordedEdit = false;
  function recordEdit() {
    if (recordedEdit) return;
    recordedEdit = true;
    ipcRenderer.send('browser:site-edited');
  }
  document.addEventListener('change', (event) => {
    if (event.isTrusted && event.target instanceof HTMLInputElement && event.target.type === 'file') recordEdit();
  }, true);
  document.addEventListener('drop', (event) => {
    if (event.isTrusted && event.dataTransfer?.types.includes('Files')) recordEdit();
  }, true);
  document.addEventListener('input', (event) => {
    if (recordedEdit || !event.isTrusted || !event.composedPath().some((node) =>
      node instanceof HTMLElement && (node.isContentEditable || node.matches('input,textarea,select,[role=textbox]')))) return;
    recordEdit();
  }, true);
}

if (process.isMainFrame && /^https?:$/.test(location.protocol)) {
  window.addEventListener('keydown', (event) => {
    if (!event.isTrusted || event.defaultPrevented || event.isComposing || event.repeat ||
        event.ctrlKey || event.altKey || event.metaKey || !['Backspace', 'Escape'].includes(event.key)) return;
    if (event.key === 'Backspace' && (document.designMode === 'on' || event.composedPath().some((node) =>
      node instanceof HTMLElement && (node.isContentEditable || node.matches('input,textarea,select,[role=textbox]'))))) return;
    ipcRenderer.send('browser:site-key', event.key, event.shiftKey);
  });
}
