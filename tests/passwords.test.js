const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { preferences } = require('../src/preferences');
const { parseChromePasswords, passwordVault } = require('../src/password-vault');
const { parseBookmarks, bookmarkStats, bookmarkHTML, bookmarks } = require('../src/bookmarks');

async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bro2-unit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('Chrome CSV preserves quoted data and reports physical line numbers without secrets', () => {
  const source = '\ufeffname,url,username,password,note\r\n' +
    'Банк,https://site.test/вход,"имя,фамилия","a""b\r\nc",Примечание\r\n' +
    'dup,https://site.test/other,"имя,фамилия","a""b\r\nc",\r\n' +
    'conflict,https://site.test,"имя,фамилия",different,\r\n' +
    'invalid,http://site.test,a,p,\r\nnew,https://site.test:443,,p,\r\n' +
    'empty,https://site.test,b,,\r\nmalformed,https://site.test,b,"secret"x,';
  const result = parseChromePasswords(source);
  assert.deepEqual(result, {
    entries: [
      { origin: 'https://site.test', username: 'имя,фамилия', password: 'a"b\r\nc' },
      { origin: 'https://site.test', username: '', password: 'p' },
    ],
    errors: [6, 7, 9, 10],
    skipped: 5,
  });
  assert.throws(() => parseChromePasswords('url,username,wrong\nhttps://site.test,person,password'), /колонки/);
});

test('vault preserves encrypted data through storage failures and serializes writes', async (t) => {
  const dir = await directory(t);
  let available = true;
  let failSeal = false;
  let failOpen = false;
  const storage = {
    isAsyncEncryptionAvailable: async () => available,
    encryptStringAsync: async (secret) => {
      if (secret === 'seal-failure' && failSeal) throw new Error();
      return Buffer.from([...Buffer.from(secret)].map((byte) => byte ^ 42));
    },
    decryptStringAsync: async (buffer) => {
      if (failOpen) throw new Error();
      return { result: Buffer.from([...buffer].map((byte) => byte ^ 42)).toString() };
    },
  };
  const vault = passwordVault(dir, storage);
  const entry = { origin: 'https://a.test', username: 'first', password: 'synthetic-secret' };
  await Promise.all([vault.save(entry), vault.save({ ...entry, username: 'second' })]);
  const file = path.join(dir, 'passwords.json');
  const baseline = await fs.readFile(file, 'utf8');
  assert(!baseline.includes(entry.password));
  const [[first], persisted] = [(await vault.list()).entries, passwordVault(dir, storage)];
  for (const origin of ['http://a.test', 'https://a.test.evil.test', 'https://sub.a.test', 'https://a.test:8443']) {
    assert.equal(await persisted.get(first.id, origin), null);
  }
  assert.equal((await persisted.get(first.id, entry.origin)).password, entry.password);
  available = false;
  await assert.rejects(persisted.save({ ...entry, password: 'x' }, first.id), /недоступно/);
  await assert.rejects(persisted.get(first.id), /недоступно/);
  available = true;
  failOpen = true;
  await assert.rejects(persisted.save({ ...entry, password: 'x' }, first.id), /недоступно/);
  failOpen = false;
  const pending = [{ ...entry, password: 'replace' }, { ...entry, username: 'pending', password: 'seal-failure' }];
  const preview = await persisted.preview(pending);
  assert.deepEqual(preview, { fresh: 1, conflicts: 1, unchanged: 0, revision: 0 });
  failSeal = true;
  await assert.rejects(persisted.import(pending, preview, true), /недоступно/);
  assert.equal(await fs.readFile(file, 'utf8'), baseline);
  failSeal = false;
  assert.equal(await persisted.import(pending, preview, false), 1);
  assert.equal((await persisted.get(first.id)).password, entry.password);
  await assert.rejects(persisted.import(pending, preview, true), /изменился/);
  assert.equal(await persisted.import(pending, await persisted.preview(pending), true), 1);
  assert.equal((await persisted.get(first.id)).password, 'replace');
});

test('bookmark HTML preserves folders and repeated imports deduplicate within each folder', async (t) => {
  const dir = await directory(t);
  const { roots, skipped } = parseBookmarks('<DL><p><DT><H3>Работа &amp; учёба</H3><DL><p>' +
    '<DT><A HREF="https://example.com/?a=1&amp;b=2">Дела</A>' +
    '<DT><A HREF="javascript:alert(1)">Опасный адрес</A>' +
    '<DT><H3>Вложенная</H3><DL><p><DT><A HREF="https://example.com">Сайт</A></DL></DL></DL>');
  assert.equal(skipped, 1);
  assert.deepEqual(bookmarkStats(roots), { count: 2, folders: ['Работа & учёба', 'Работа & учёба / Вложенная'] });
  assert.deepEqual(parseBookmarks(bookmarkHTML(roots)).roots, roots);
  const library = bookmarks(dir);
  assert.equal(await library.import(roots), 2);
  assert.equal(await library.import(roots), 0);
  assert.deepEqual(await library.list(), roots);
});

test('old preferences carry profile, shortcuts and the motion setting across saves', async (t) => {
  const dir = await directory(t);
  const profile = { name: 'Проверка', email: 'person@example.test' };
  const shortcuts = [{ url: 'https://example.test/', title: 'Сайт' }];
  await fs.writeFile(path.join(dir, 'preferences.json'),
    JSON.stringify({ settings: { motion: false, theme: 'light' }, profile, googleClient: 'fixture', shortcuts }));
  const prefs = preferences(dir);
  assert.equal(prefs.current.settings.motion, 'off');
  prefs.setSetting('passwordOffers', false);
  const saved = preferences(dir).current;
  assert.equal(saved.settings.motion, 'off');
  assert.equal(saved.settings.passwordOffers, false);
  assert.equal(saved.settings.theme, 'light');
  assert.equal(saved.googleClient, 'fixture');
  assert.deepEqual(saved.profile, profile);
  assert.deepEqual(saved.shortcuts, shortcuts);
});

test('old and repeated visits can be removed independently and cleared by date', async (t) => {
  const dir = await directory(t);
  const url = 'https://example.test/';
  await fs.writeFile(path.join(dir, 'preferences.json'), JSON.stringify({
    history: [{ url, title: 'Давнее посещение', time: 1000 }, { url, title: 'Без даты' }],
  }));
  const prefs = preferences(dir);
  const oldId = prefs.current.history[0].id;
  assert.equal(typeof oldId, 'string');
  prefs.visit(url, 'Сайт');
  prefs.visit(url, 'Сайт');
  assert.equal(new Set(prefs.current.history.map(({ id }) => id)).size, 4);
  const [latest, previous] = prefs.current.history;
  prefs.removeVisit(latest.id);
  const reopened = preferences(dir);
  assert.equal(reopened.current.history[0].id, previous.id);
  reopened.clearHistory(2000);
  assert.deepEqual(preferences(dir).current.history.map(({ title }) => title), ['Давнее посещение', 'Без даты']);
  reopened.removeVisit(oldId);
  assert.equal(preferences(dir).current.history[0].title, 'Без даты');
});

test('legacy bookmark identities survive reorder, import and simultaneous edits', async (t) => {
  const dir = await directory(t);
  await fs.writeFile(path.join(dir, 'bookmarks.json'), JSON.stringify({ version: 1, items: [
    { name: 'Входящие', children: [{ name: 'Сайт', url: 'https://example.test/' }] },
    { name: 'Архив', children: [] },
  ] }));
  const library = bookmarks(dir);
  const [inbox, archive] = await library.tree();
  const [link] = inbox.children;
  await Promise.all([
    library.edit('reorder', { id: archive.id, offset: -1 }),
    library.edit('edit', { id: link.id, parent: archive.id, name: 'Ссылка', url: link.url }),
    library.import([{ name: 'Новая', url: 'https://other.example/' }]),
  ]);
  const tree = await bookmarks(dir).tree();
  assert.equal(tree[0].id, archive.id);
  assert.equal(tree[1].id, inbox.id);
  assert.equal(tree[0].children[0].id, link.id);
  assert.equal(tree[0].children[0].name, 'Ссылка');
  assert.equal(new Set([...tree, ...tree[0].children].map(({ id }) => id)).size, 4);
  await assert.rejects(library.edit('edit', { id: archive.id, parent: archive.id, name: 'Цикл' }), /вне этой папки/);
  assert.deepEqual(await library.tree(), tree);
  await library.edit('delete', { id: link.id });
  assert.equal((await library.tree())[0].children.length, 0);
});
