const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { atomicJSON } = require('./password-vault');
const { download, storeListing, unpackStorePackage } = require('./extension-store');

const localId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const chromeId = /^[a-p]{32}$/;
const unavailablePermissions = ['contextMenus', 'cookies', 'fontSettings', 'gcm', 'identity', 'notifications', 'sidePanel', 'tts'];
const within = (root, item) => {
  const relative = path.relative(root, item);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};
const strings = (list) => Array.isArray(list) ? list.filter((item) => typeof item === 'string') : [];

function unavailableAPIs(manifest) {
  const permissions = [...strings(manifest.permissions), ...strings(manifest.optional_permissions)];
  const unavailable = unavailablePermissions.filter((permission) => permissions.includes(permission))
    .map((permission) => `chrome.${permission}`);
  if (manifest.commands && Object.keys(manifest.commands).length) unavailable.push('chrome.commands');
  return unavailable;
}

async function manifestLabels(directory, manifest) {
  const name = manifest.name;
  const description = typeof manifest.description === 'string' ? manifest.description : '';
  const locale = manifest.default_locale;
  if ((!name.includes('__MSG_') && !description.includes('__MSG_')) ||
      typeof locale !== 'string' || !/^[a-z]{2,3}(?:_[a-zA-Z0-9]+)*$/.test(locale)) return { name, description };

  try {
    const root = await fs.realpath(directory);
    const filename = path.join(root, '_locales', locale, 'messages.json');
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.size > 1024 * 1024 || !within(root, await fs.realpath(filename))) {
      return { name, description };
    }
    const messages = Object.entries(JSON.parse((await fs.readFile(filename, 'utf8')).replace(/^\uFEFF/, '')));
    const byKey = new Map(messages.map(([key, value]) => [key.toLowerCase(), value?.message]));
    const translate = (text) => text.replace(/__MSG_([a-zA-Z0-9_@]+)__/g, (token, key) => {
      const message = byKey.get(key.toLowerCase());
      return typeof message === 'string' ? message : token;
    });
    return { name: translate(name), description: translate(description) };
  } catch { return { name, description }; }
}

function extensionPage(id, value) {
  if (!chromeId.test(id) || typeof value !== 'string' || !value || /[\\\r\n\t]/.test(value)) return null;
  try {
    const url = new URL(value, `chrome-extension://${id}/`);
    if (url.protocol === 'chrome-extension:' && url.host === id && !url.username && !url.password &&
        /\.html?$/i.test(url.pathname)) return url.href;
  } catch {}
  return null;
}

async function readManifest(directory) {
  const filename = path.join(directory, 'manifest.json');
  let manifest;
  let bytes;
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error();
    bytes = await fs.readFile(filename);
    manifest = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch { throw new Error('В папке нужен корректный файл manifest.json.'); }
  if (![2, 3].includes(manifest?.manifest_version) || typeof manifest.name !== 'string' || !manifest.name.trim() ||
      typeof manifest.version !== 'string' || !/^\d+(\.\d+){0,3}$/.test(manifest.version)) {
    throw new Error('Проверь название, версию и формат манифеста расширения.');
  }

  // Chromium uses the public key, when supplied, to identify unpacked extensions.
  const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');
  const publicKey = typeof manifest.key === 'string' && Buffer.from(manifest.key.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''), 'base64');
  const id = publicKey?.length ? digest(publicKey).slice(0, 32).replace(/[0-9a-f]/g, (char) => String.fromCharCode(97 + parseInt(char, 16))) : null;
  const grants = [...strings(manifest.permissions), ...strings(manifest.host_permissions)];
  const optional = [...strings(manifest.optional_permissions), ...strings(manifest.optional_host_permissions)];
  const scripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  const sites = scripts.flatMap((entry) => strings(entry?.matches));
  return {
    fingerprint: digest(bytes), chromeId: id, version: manifest.version, ...await manifestLabels(directory, manifest),
    grants: [...new Set(grants)], optional: [...new Set(optional)], sites: [...new Set(sites)],
    unavailable: unavailableAPIs(manifest),
  };
}

async function snapshot(source, target) {
  let files = 0;
  let bytes = 0;
  await fs.cp(source, target, {
    recursive: true, force: false, errorOnExist: true,
    async filter(from) {
      const stat = await fs.lstat(from);
      if (!stat.isDirectory() && !stat.isFile()) throw new Error('В папке расширения обнаружена ссылка или специальный файл.');
      if (!within(source, await fs.realpath(from))) throw new Error('Файл расширения находится за пределами выбранной папки.');
      files++;
      bytes += stat.size;
      if (files > 20_000 || bytes > 256 * 1024 * 1024) throw new Error('Папка расширения слишком большая.');
      return true;
    },
  });
}

async function extensionIcon(extension) {
  const icons = extension.manifest.action?.default_icon ?? extension.manifest.browser_action?.default_icon ??
    extension.manifest.icons;
  const candidates = typeof icons === 'string' ? [icons] :
    Object.entries(icons || {}).sort(([a], [b]) => Math.abs(Number(a) - 32) - Math.abs(Number(b) - 32)).map(([, value]) => value);
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.toLowerCase().endsWith('.png')) continue;
    try {
      const file = await fs.realpath(path.resolve(extension.path, candidate));
      if (!within(extension.path, file)) continue;
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size < 24 || stat.size > 64 * 1024) continue;
      const data = await fs.readFile(file);
      if (data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || data.length < 24 ||
          data.readUInt32BE(16) > 512 || data.readUInt32BE(20) > 512) continue;
      return 'data:image/png;base64,' + data.toString('base64');
    } catch { /* Optional icon. */ }
  }
  return '';
}

function extensionManager(profile, api, closePages) {
  const root = path.join(profile, 'brO2-extensions');
  const registry = path.join(profile, 'extensions.json');
  const errors = new Map();
  const images = new Map();
  let entries = [];
  let pending;
  let timer;
  let tail = Promise.resolve();
  let broken;

  const folder = (id) => path.join(root, id);
  const runtime = (id) => api.getAllExtensions().find((entry) => path.relative(entry.path, folder(id)) === '');
  const removeFolder = (id) => fs.rm(folder(id), { recursive: true, force: true });
  function enqueue(task) {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  }

  function discard(owner) {
    if (pending && pending.owner !== owner) return;
    clearTimeout(timer);
    const id = pending?.id;
    pending = undefined;
    if (id) return removeFolder(id).catch(() => {});
  }

  async function save(next) {
    try { await atomicJSON(registry, { version: 1, entries: next }); }
    catch { throw new Error('Не удалось сохранить список расширений.'); }
    entries = next;
  }

  function open(record) {
    const options = { allowFileAccess: false };
    return api.loadExtension(folder(record.id), options).catch((error) => {
      const reason = String(error?.message || '').replaceAll(folder(record.id), '').trim().slice(0, 420);
      throw new Error(reason ? `Electron не смог загрузить расширение. ${reason}` : 'Electron не смог загрузить расширение.');
    });
  }

  async function load(record) {
    const box = await fs.realpath(root);
    const installed = await fs.realpath(folder(record.id));
    if (path.relative(path.join(box, record.id), installed) !== '') throw new Error('Папка расширения перемещена.');
    const current = await readManifest(installed);
    if (current.fingerprint !== record.fingerprint) throw new Error('Манифест изменился. Удали расширение и добавь его снова.');
    if (current.chromeId && api.getExtension(current.chromeId)) throw new Error('Расширение с таким идентификатором уже загружено.');
    const live = await open(record);
    images.set(record.id, await extensionIcon(live));
    return live;
  }

  function unload(id) {
    images.delete(id);
    const item = runtime(id);
    if (!item) return;
    api.removeExtension(item.id);
    closePages(item.id);
  }

  function pages(id) {
    const item = runtime(id);
    if (!item) return {};
    return {
      action: extensionPage(item.id, item.manifest.action?.default_popup ?? item.manifest.browser_action?.default_popup),
      options: extensionPage(item.id, item.manifest.options_ui?.page ?? item.manifest.options_page),
    };
  }

  function view() {
    return entries.map(({ id, name, version, description, pinned }) => {
      const live = runtime(id);
      const declaredPages = pages(id);
      return {
        id, name: live?.name || name, version, description: live?.manifest.description || description,
        enabled: Boolean(live), error: errors.get(id), action: Boolean(declaredPages.action),
        pinned: pinned === true, image: images.get(id), options: Boolean(declaredPages.options),
        unavailable: live ? unavailableAPIs(live.manifest) : [],
      };
    });
  }

  function stage(owner, valid, prepare, copyError) {
    return enqueue(async () => {
      if (broken) throw broken;
      if (!valid()) return null;
      if (pending && pending.owner !== owner) throw new Error('Заверши добавление расширения в другом окне.');
      await discard(owner);
      const id = randomUUID();
      try {
        await fs.mkdir(root, { recursive: true });
        await prepare(folder(id));
        const { fingerprint, chromeId: declared, ...details } = await readManifest(folder(id));
        if (entries.some((item) => item.fingerprint === fingerprint || (declared && item.chromeId === declared))) {
          throw new Error('Это расширение уже добавлено.');
        }
        if (!valid()) {
          await removeFolder(id);
          return null;
        }
        pending = { id, owner, fingerprint, chromeId: declared, ...details };
        timer = setTimeout(() => void enqueue(() => { if (pending?.id === id) return discard(owner); }), 5 * 60_000);
        timer.unref();
        return { id, ...details };
      } catch (error) {
        await removeFolder(id).catch(() => {});
        if (!valid()) return null;
        if (error.code) throw new Error(copyError);
        throw error;
      }
    });
  }

  return {
    restore: () => enqueue(async () => {
      try {
        const stored = JSON.parse(await fs.readFile(registry, 'utf8'));
        if (stored?.version !== 1 || !Array.isArray(stored.entries) || !stored.entries.every((item) =>
          item && typeof item.id === 'string' && localId.test(item.id) && typeof item.enabled === 'boolean' &&
          typeof item.name === 'string' && typeof item.version === 'string' && typeof item.fingerprint === 'string') ||
          new Set(stored.entries.map((item) => item.id)).size !== stored.entries.length) throw new Error();
        entries = stored.entries;
      } catch (error) {
        if (error.code === 'ENOENT') return;
        broken = new Error('Файл списка расширений повреждён. Сохранённые файлы остались в профиле.');
        throw broken;
      }
      for (const record of entries) {
        if (!record.enabled) continue;
        try { await load(record); }
        catch (error) {
          errors.set(record.id, error.code === 'ENOENT' ? 'Файлы расширения отсутствуют.' : error.message);
        }
      }
    }),
    list: () => enqueue(() => {
      if (broken) throw broken;
      return view();
    }),
    pinned: () => entries.filter(({ pinned }) => pinned === true).flatMap(({ id, name }) => {
      const live = runtime(id);
      return live && (live.manifest.action?.default_popup || live.manifest.browser_action?.default_popup)
        ? [{ id, name: live.name || name, image: images.get(id) }] : [];
    }),
    togglePin: (id, valid) => enqueue(async () => {
      const record = entries.find((item) => item.id === id);
      if (!record || !valid() || !pages(id).action) return;
      await save(entries.map((item) => item === record ? { ...item, pinned: !item.pinned } : item));
    }),
    preview: (directory, owner, valid) => stage(owner, valid, async (target) => {
      let source;
      try { source = await fs.realpath(directory); }
      catch { throw new Error('Не удалось открыть выбранную папку.'); }
      if (within(source, root) || within(root, source)) throw new Error('Выбери распакованное расширение вне хранилища BrO2.');
      await readManifest(source);
      await snapshot(source, target);
    }, 'Не удалось скопировать выбранную папку.'),
    async previewStore(url, owner, valid, signal) {
      const id = storeListing(url);
      if (!id) throw new Error('Вставь ссылку на страницу расширения в Chrome Web Store.');
      const conflict = await enqueue(() => {
        if (broken) throw broken;
        return entries.some((entry) => entry.chromeId === id);
      });
      if (conflict) throw new Error('Это расширение уже добавлено.');
      if (!valid()) return null;
      const crx = await download(id, process.versions.chrome, signal);
      return stage(owner, valid, (target) => unpackStorePackage(crx, id, target, signal),
        'Не удалось сохранить файлы расширения.');
    },
    cancel: (owner) => enqueue(() => discard(owner)),
    install: (id, owner, valid) => enqueue(async () => {
      if (typeof id !== 'string' || id !== pending?.id || owner !== pending.owner || !valid()) {
        throw new Error('Выбери папку расширения снова.');
      }
      const { owner: _owner, grants, optional, sites, unavailable, ...record } = pending;
      pending = undefined;
      clearTimeout(timer);
      try {
        await load(record);
        if (!valid()) {
          unload(id);
          await removeFolder(id);
          return;
        }
        await save([...entries, { ...record, enabled: true }]);
      } catch (error) {
        unload(id);
        await removeFolder(id).catch(() => {});
        throw error;
      }
    }),
    change: (id, action, valid) => enqueue(async () => {
      const record = entries.find((item) => item.id === id);
      if (!record || !valid()) throw new Error('Расширение больше недоступно.');
      if (action === 'enable') {
        if (runtime(id)) return;
        try {
          await load(record);
          await save(entries.map((item) => item === record ? { ...item, enabled: true } : item));
        } catch (error) {
          unload(id);
          errors.set(id, error.code === 'ENOENT' ? 'Файлы расширения отсутствуют.' : error.message);
          throw new Error(errors.get(id));
        }
      } else {
        await save(action === 'remove' ? entries.filter((item) => item !== record)
          : entries.map((item) => item === record ? { ...item, enabled: false } : item));
        unload(id);
        if (action === 'remove') await removeFolder(id).catch(() => {});
      }
      errors.delete(id);
    }),
    page: (id, key) => ['action', 'options'].includes(key) ? pages(id)[key] : null,
    isPage(url, id) {
      try {
        const target = new URL(url);
        return target.protocol === 'chrome-extension:' && target.host === id && Boolean(api.getExtension(id));
      } catch { return false; }
    },
  };
}

module.exports = { extensionManager, extensionPage, readManifest };
