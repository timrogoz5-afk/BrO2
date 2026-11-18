const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { atomicJSON } = require('./password-vault');

const reservedDownloadPaths = new Set();
const pathKey = (filename) => process.platform === 'win32' ? filename.toLowerCase() : filename;

function downloadPath(directory, suggestedName) {
  let name = path.win32.basename(suggestedName).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || 'download';
  const firstPart = name.split('.', 1)[0].trimEnd();
  if (/^(?:con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(firstPart)) name = '_' + name;
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  let candidate = path.join(directory, name);
  for (let index = 1; reservedDownloadPaths.has(pathKey(candidate)) ||
      fs.lstatSync(candidate, { throwIfNoEntry: false }) ||
      fs.lstatSync(candidate + '.crdownload', { throwIfNoEntry: false }); index++) {
    candidate = path.join(directory, `${base} (${index})${ext}`);
  }
  return candidate;
}

function downloads(directory, session, changed, downloadDirectory) {
  const file = directory && path.join(directory, 'downloads.json');
  let records = [];
  let saving = Promise.resolve();
  const items = new Map();
  const sources = new Map();
  let disposed = false;
  let updateTimer;
  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(saved)) records = saved.slice(0, 150).filter((entry) =>
        typeof entry?.id === 'string' && typeof entry.name === 'string' && typeof entry.path === 'string')
        .map((entry) => ({ ...entry, state: ['completed', 'cancelled', 'interrupted'].includes(entry.state) ? entry.state : 'interrupted' }));
    } catch {}
  }

  function store() {
    if (!file || disposed) return;
    const snapshot = records.slice(0, 150).map((entry) => ({ ...entry }));
    saving = saving.then(() => atomicJSON(file, snapshot)).catch(() => {});
  }

  function notify() {
    if (disposed || updateTimer) return;
    updateTimer = setTimeout(() => {
      updateTimer = undefined;
      changed();
    }, 140);
  }

  const onDownload = (event, item, contents) => {
    const entry = { id: randomUUID(), name: item.getFilename(), path: '', state: 'progressing',
      transferred: item.getReceivedBytes(), size: item.getTotalBytes(), time: Date.now() };
    records = [entry, ...records].filter((entry, index) => index < 150 || items.has(entry.id));
    let reservedPath;
    const options = typeof downloadDirectory === 'function' ? downloadDirectory() : { directory: downloadDirectory };
    const { directory, prompt } = options;
    if (directory) {
      try {
        const suggestedPath = downloadPath(directory, entry.name);
        if (prompt) item.setSaveDialogOptions({ defaultPath: suggestedPath });
        else {
          item.setSavePath(suggestedPath);
          entry.path = suggestedPath;
          entry.name = path.basename(entry.path);
          reservedPath = pathKey(entry.path);
          reservedDownloadPaths.add(reservedPath);
        }
      } catch {
        event.preventDefault();
        entry.state = 'interrupted';
        entry.path = '';
        store();
        changed();
        return;
      }
    }
    items.set(entry.id, item);
    if (contents) sources.set(entry.id, contents.id);
    const update = (state) => {
      entry.transferred = item.getReceivedBytes();
      entry.size = item.getTotalBytes();
      const savePath = item.getSavePath();
      if (savePath) {
        entry.path = savePath;
        entry.name = path.basename(savePath);
      }
      entry.state = state === 'progressing' && item.isPaused() ? 'paused' : state;
    };
    item.on('updated', (_event, state) => {
      update(state);
      notify();
    });
    item.once('done', (_event, state) => {
      update(state);
      if (reservedPath) reservedDownloadPaths.delete(reservedPath);
      items.delete(entry.id);
      sources.delete(entry.id);
      store();
      if (!disposed) changed();
    });
    store();
    changed();
  };
  session.on('will-download', onDownload);

  return {
    list: () => records.map(({ path, ...entry }) => ({
      ...entry, exists: Boolean(path && entry.state === 'completed' && fs.existsSync(path)),
      canCancel: items.has(entry.id),
      canResume: items.get(entry.id)?.canResume() ?? false,
    })),
    hasActive(contentsId) { return [...sources.values()].includes(contentsId); },
    clear(since = 0) {
      records = records.filter(({ id, time }) => items.has(id) || (since && (!Number.isFinite(time) || time < since)));
      store();
      changed();
    },
    act(id, action, shell) {
      const item = items.get(id);
      const record = records.find((element) => element.id === id);
      if (!record) return;
      if (action === 'forget' && !item) {
        records = records.filter((element) => element !== record);
        store();
        changed();
      }
      if (action === 'stop') item?.cancel();
      if (action === 'pause' && item && record.state === 'progressing') {
        item.pause();
        record.state = 'paused';
        changed();
      }
      if (action === 'resume' && item?.canResume()) item.resume();
      if ((action === 'open' || action === 'folder') && record.state === 'completed') {
        if (!record.path || !fs.existsSync(record.path)) throw new Error('Файл перемещён или удалён.');
        if (action === 'folder') shell.showItemInFolder(record.path);
        else return shell.openPath(record.path).then((error) => {
          if (error) throw new Error('Не удалось открыть файл.');
        });
      }
    },
    close() {
      disposed = true;
      clearTimeout(updateTimer);
      session.removeListener('will-download', onDownload);
      for (const item of [...items.values()]) item.cancel();
      records = [];
    },
  };
}

function taskList(app, tabs) {
  const metrics = new Map(app.getAppMetrics().map((metric) => [metric.pid, metric]));
  const tasks = new Map();
  for (const tab of tabs) {
    if (!tab.view) continue;
    const pid = tab.view.webContents.getOSProcessId();
    const metric = metrics.get(pid);
    if (!pid || !metric) continue;
    if (!tasks.has(pid)) tasks.set(pid, { pid, titles: [], cpu: metric.cpu?.percentCPUUsage ?? 0,
      memory: metric.memory?.workingSetSize ?? 0 });
    tasks.get(pid).titles.push(tab.title);
  }
  return [...tasks.values()];
}

module.exports = { downloads, taskList };
