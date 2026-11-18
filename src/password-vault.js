const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function httpsOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

function credential(value) {
  const origin = typeof value?.origin === 'string' && httpsOrigin(value.origin.trim());
  if (!origin || typeof value.username !== 'string' || value.username.length > 1024 ||
      typeof value.password !== 'string' || !value.password || value.password.length > 8192 ||
      value.username.includes('\0') || value.password.includes('\0')) return null;
  return { origin, username: value.username, password: value.password };
}

function readCSV(source) {
  const rows = [];
  let cells = [];
  let field = '';
  let state = 'start';
  let invalid = false;
  let line = 1;
  let start = 1;
  source = source.replace(/^\uFEFF/, '');
  for (let index = 0; index <= source.length; index++) {
    const char = source[index];
    if (state === 'quoted' && char !== undefined) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') state = 'closed';
      else {
        field += char;
        if (char === '\n' || (char === '\r' && source[index + 1] !== '\n')) line++;
      }
      continue;
    }
    if (char === ',' || char === '\n' || char === '\r' || char === undefined) {
      cells.push(field);
      invalid ||= state === 'quoted';
      field = '';
      state = 'start';
      if (char === ',') continue;
      if (cells.some(Boolean) || cells.length > 1 || invalid) rows.push({ cells, line: start, invalid });
      if (char === '\r' && source[index + 1] === '\n') index++;
      start = ++line;
      cells = [];
      invalid = false;
      continue;
    }
    if (char === '"' && state === 'start') state = 'quoted';
    else {
      invalid ||= char === '"' || state === 'closed';
      field += char;
      state = 'plain';
    }
  }
  return rows;
}

const identity = ({ origin, username }) => JSON.stringify([origin, username]);

function parseChromePasswords(source) {
  const [header, ...rows] = readCSV(source);
  const columns = header?.cells.map((cell) => cell.trim().toLowerCase()) ?? [];
  const required = ['url', 'username', 'password'];
  if (!header || header.invalid || required.some((name) => columns.filter((column) => column === name).length !== 1)) {
    throw new Error('В первой строке CSV нужны колонки url, username и password.');
  }
  const [url, user, pass] = required.map((name) => columns.indexOf(name));
  const records = new Map();
  const errors = [];
  let skipped = 0;
  for (const row of rows) {
    const entry = credential({ origin: row.cells[url], username: row.cells[user], password: row.cells[pass] });
    if (!entry || row.invalid || row.cells.length !== columns.length) {
      errors.push(row.line);
      skipped++;
      continue;
    }
    const key = identity(entry);
    if (records.has(key)) {
      if (records.get(key).password !== entry.password) errors.push(row.line);
      skipped++;
    } else records.set(key, entry);
  }
  return { entries: [...records.values()], errors, skipped };
}

async function atomicJSON(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(temp, JSON.stringify(data), { flag: 'wx', flush: true });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

const unavailable = () => new Error('Хранилище паролей недоступно. Проверь учётную запись Windows и повтори попытку.');

function passwordVault(directory, storage) {
  const file = path.join(directory, 'passwords.json');
  let tail = Promise.resolve();
  let data;
  let revision = 0;

  async function load() {
    if (data) return data;
    try {
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      const valid = saved?.version === 1 && Array.isArray(saved.entries) && Array.isArray(saved.exceptions) &&
        saved.exceptions.every((entry) => httpsOrigin(entry) === entry) &&
        saved.entries.every((entry) => entry && typeof entry.id === 'string' && httpsOrigin(entry.origin) === entry.origin &&
          typeof entry.username === 'string' && typeof entry.secret === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(entry.secret));
      if (!valid) throw unavailable();
      data = saved;
    } catch (error) {
      if (error.code !== 'ENOENT') throw unavailable();
      data = { version: 1, entries: [], exceptions: [] };
    }
    return data;
  }

  function transact(operation) {
    const run = tail.then(async () => operation(await load()));
    tail = run.catch(() => {});
    return run;
  }

  async function commit(next) {
    try {
      await atomicJSON(file, next);
      data = next;
      revision++;
    } catch { throw new Error('Не удалось записать хранилище паролей.'); }
  }

  async function seal({ password, ...entry }, id = randomUUID()) {
    try {
      if (!await storage.isAsyncEncryptionAvailable()) throw unavailable();
      return { ...entry, id, secret: (await storage.encryptStringAsync(password)).toString('base64') };
    } catch { throw unavailable(); }
  }

  async function unseal(entry) {
    try {
      if (!await storage.isAsyncEncryptionAvailable()) throw unavailable();
      let decrypted = await storage.decryptStringAsync(Buffer.from(entry.secret, 'base64'));
      if (decrypted.shouldReEncrypt) decrypted = await storage.decryptStringAsync(Buffer.from(entry.secret, 'base64'));
      if (typeof decrypted.result !== 'string' || !decrypted.result) throw unavailable();
      return decrypted.result;
    } catch { throw unavailable(); }
  }

  async function compare(current, entries) {
    const existing = new Map(current.entries.map((entry) => [identity(entry), entry]));
    const result = { fresh: [], conflicts: [], unchanged: 0 };
    for (const entry of entries) {
      const old = existing.get(identity(entry));
      if (!old) result.fresh.push(entry);
      else if (await unseal(old) === entry.password) result.unchanged++;
      else result.conflicts.push({ id: old.id, entry });
    }
    return result;
  }

  return {
    list: () => transact(({ entries, exceptions }) => ({
      entries: entries.map(({ id, origin, username }) => ({ id, origin, username })),
      exceptions,
    })),
    get: (id, origin) => transact(async (current) => {
      const entry = current.entries.find((item) => item.id === id && (!origin || item.origin === origin));
      if (!entry) return null;
      return { origin: entry.origin, username: entry.username, password: await unseal(entry) };
    }),
    save: (value, id) => transact(async (current) => {
      const entry = credential(value);
      if (!entry) throw new Error('Введи HTTPS-адрес и непустой пароль.');
      const selected = current.entries.find((item) => item.id === id);
      if (id && !selected) throw new Error('Эта запись уже удалена.');
      if (current.entries.some((item) => item.id !== id && identity(item) === identity(entry))) {
        throw new Error('Такой логин уже есть. Выбери его для обновления.');
      }
      if (selected) await unseal(selected);
      const encrypted = await seal(entry, id);
      const entries = selected ? current.entries.map((item) => item.id === id ? encrypted : item)
        : [...current.entries, encrypted];
      await commit({ ...current, entries });
    }),
    remove: (id) => transact((current) => commit({ ...current, entries: current.entries.filter((entry) => entry.id !== id) })),
    except: (origin, add) => transact((current) => {
      if (!origin || httpsOrigin(origin) !== origin) return;
      const remaining = current.exceptions.filter((entry) => entry !== origin);
      return commit({ ...current, exceptions: add ? [...remaining, origin] : remaining });
    }),
    preview: (entries) => transact(async (current) => {
      const result = await compare(current, entries);
      return { fresh: result.fresh.length, conflicts: result.conflicts.length, unchanged: result.unchanged, revision };
    }),
    import: (entries, preview, replace) => transact(async (current) => {
      if (revision !== preview.revision) throw new Error('Список паролей изменился. Выбери CSV снова.');
      const result = await compare(current, entries);
      const additions = [];
      for (const entry of result.fresh) additions.push(await seal(entry));
      const updates = new Map();
      if (replace) {
        for (const { id, entry } of result.conflicts) updates.set(id, await seal(entry, id));
      }
      if (additions.length || updates.size) {
        await commit({ ...current, entries: [...current.entries.map((entry) => updates.get(entry.id) ?? entry), ...additions] });
      }
      return additions.length + updates.size;
    }),
  };
}

module.exports = { atomicJSON, credential, httpsOrigin, parseChromePasswords, passwordVault };
