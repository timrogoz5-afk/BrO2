const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { shortcutCommand } = require('../src/shortcuts');
const { extensionPage } = require('../src/extensions');
const { downloads } = require('../src/browser-tools');
const { sessionState } = require('../src/session-state');
const { permissionContext, permissionTypes, updateSiteRules } = require('../src/site-permissions');
const { preferences } = require('../src/preferences');

test('shortcut modifiers route to distinct browser commands and preserve typing and scroll keys', () => {
  for (const [code, modifiers, action] of [
    ['KeyT', {}, 'new'], ['KeyT', { shift: true }, 'restore'], ['F4', {}, 'close'],
    ['Tab', { shift: true }, 'cycle'], ['PageDown', {}, 'cycle'], ['Digit8', {}, 'tab-number'],
    ['KeyN', {}, 'window'], ['KeyN', { shift: true }, 'private'],
    ['F5', {}, 'hard-reload'], ['KeyR', { shift: true }, 'hard-reload'],
    ['Equal', { shift: true, key: '+' }, 'zoom'], ['Numpad0', {}, 'zoom'],
    ['KeyB', { shift: true }, 'bookmarks-bar'], ['KeyI', { shift: true }, 'devtools'],
    ['KeyF', {}, 'find'], ['KeyH', {}, 'history'], ['KeyJ', {}, 'downloads'],
    ['KeyD', {}, 'bookmark'], ['KeyP', {}, 'print'], ['KeyS', {}, 'save'], ['KeyU', {}, 'source'],
  ]) assert.equal(shortcutCommand({ code, control: true, ...modifiers })[0], action, code);
  assert.deepEqual(shortcutCommand({ code: 'Tab', control: true, shift: true }), ['cycle', -1]);
  assert.deepEqual(shortcutCommand({ code: 'PageDown', control: true }), ['cycle', 1]);
  assert.deepEqual(shortcutCommand({ code: 'Digit9', control: true }), ['tab-number', 9]);
  assert.deepEqual(shortcutCommand({ code: 'Escape', shift: true }), ['tasks']);
  assert.deepEqual(shortcutCommand({ code: 'Home', alt: true }), ['home']);
  assert.deepEqual(shortcutCommand({ code: 'F6' }), ['address']);
  assert.deepEqual(shortcutCommand({ code: 'F11' }), ['fullscreen']);
  assert.deepEqual(shortcutCommand({ code: 'F12' }), ['devtools']);
  for (const code of ['Space', 'Home', 'End', 'PageUp', 'PageDown', 'Backspace', 'KeyT']) {
    assert.equal(shortcutCommand({ code }), null, code);
  }
  assert.equal(shortcutCommand({ code: 'KeyT', control: true, isComposing: true }), null);
  assert.equal(shortcutCommand({ code: 'KeyN', control: true, alt: true }), null);
});

test('extension manifest pages remain inside the owning extension scheme and host', () => {
  const id = 'a'.repeat(32);
  assert.equal(extensionPage(id, 'popup.html?theme=dark#options'), `chrome-extension://${id}/popup.html?theme=dark#options`);
  for (const value of ['file:///C:/secret.html', 'https://example.test/page.html', 'data:text/html,Hello',
    '//different-id/x.html', 'script.js', '../test.json']) assert.equal(extensionPage(id, value), null, value);
});

test('downloads preserve existing files and reserve distinct names across sessions', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2-download-'));
  const existingPath = path.join(directory, 'report.txt');
  const finalPath = path.join(directory, 'report (1).txt');
  fs.writeFileSync(existingPath, 'keep');
  const session = new EventEmitter();
  const privateSession = new EventEmitter();
  const regular = downloads(null, session, () => {}, directory);
  const privateDownloads = downloads(null, privateSession, () => {}, directory);
  t.after(() => {
    regular.close();
    privateDownloads.close();
    fs.rmSync(existingPath, { force: true });
    fs.rmSync(finalPath, { force: true });
    fs.rmdirSync(directory);
  });

  function start(target) {
    const item = new EventEmitter();
    let savePath;
    Object.assign(item, {
      getFilename: () => '..\\report.txt',
      getTotalBytes: () => 25,
      getReceivedBytes: () => 12,
      getSavePath: () => savePath,
      setSavePath: (filename) => { savePath = filename; },
      isPaused: () => false,
      canResume: () => true,
      cancel: () => item.emit('done', {}, 'cancelled'),
    });
    target.emit('will-download', { preventDefault: () => assert.fail('Download was denied') }, item);
    return item;
  }

  const first = start(session);
  const second = start(privateSession);
  assert.equal(first.getSavePath(), finalPath);
  assert.equal(second.getSavePath(), path.join(directory, 'report (2).txt'));
  assert.equal(fs.readFileSync(existingPath, 'utf8'), 'keep');
  const [entry] = regular.list();
  assert.equal(entry.state, 'progressing');
  assert.equal(entry.transferred, 12);
  assert.equal(entry.canCancel, true);

  privateDownloads.act(privateDownloads.list()[0].id, 'stop');
  assert.equal(privateDownloads.list()[0].state, 'cancelled');
  assert.equal(privateDownloads.list()[0].canCancel, false);

  fs.writeFileSync(finalPath, 'result');
  first.emit('done', {}, 'completed');
  assert.equal(regular.list()[0].exists, true);
  regular.act(entry.id, 'folder', { showItemInFolder: (filename) => assert.equal(filename, finalPath) });
  await regular.act(entry.id, 'open', { openPath: async (filename) => {
    assert.equal(filename, finalPath);
    return '';
  } });
  regular.act(entry.id, 'forget');
  assert.equal(regular.list().length, 0);
  assert.equal(fs.readFileSync(finalPath, 'utf8'), 'result');
});

test('session journal holds multiple windows without persistent form state or privileged URLs', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2-session-'));
  const file = path.join(directory, 'session.json');
  t.after(() => { fs.unlinkSync(file); fs.rmdirSync(directory); });
  const example = 'https://example.test/';
  const tab = { url: example, pinned: true, history: { index: 2, entries: [
    { url: 'file:///C:/private.txt', title: 'File', pageState: 'fixture file state' },
    { url: 'https://before.test/', title: 'Earlier', pageState: 'fixture previous state' },
    { url: example, title: 'Active', pageState: 'fixture password text' },
  ] } };
  sessionState(directory).save({
    clean: false,
    windows: [{ tabs: [{ url: '' }, tab], active: 1 }, { tabs: [{ url: 'http://localhost:39712/' }], active: 0 }],
    recent: [{ type: 'tab', tab: { url: 'https://user:secret@example.test/' }, position: 4 }],
  });
  const read = sessionState(directory).previous;
  assert.equal(read.clean, false);
  assert.equal(read.windows.length, 2);
  assert.equal(read.windows[0].active, 1);
  assert.equal(read.windows[0].tabs[1].pinned, true);
  assert.deepEqual(read.windows[0].tabs[1].history, { index: 1, entries: [
    { url: 'https://before.test/', title: 'Earlier' }, { url: example, title: 'Active' },
  ] });
  assert.equal(read.recent[0].tab.url, '');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /secret|pageState|file:/);
});

test('site permission decisions apply only to the expected secure top-level origin', () => {
  const getURL = () => 'https://site.test:9443/page';
  const contents = { getURL, isDestroyed: () => false };
  const main = { isMainFrame: true };
  const origin = 'https://site.test:9443';
  assert.equal(permissionContext(contents, origin, main, true), origin);
  assert.equal(permissionContext(contents, 'https://site.test', main, true), null);
  assert.equal(permissionContext(contents, origin, { ...main, embeddingOrigin: 'https://other.test' }, true), null);
  assert.equal(permissionContext(contents, origin, { isMainFrame: false }, true), null);
  assert.equal(permissionContext(null, origin, main, true), null);
  assert.deepEqual(permissionTypes('media', { mediaTypes: ['audio', 'video'] }), ['microphone', 'camera']);
  assert.deepEqual(permissionTypes('media', { mediaType: 'unknown' }), []);
  assert.deepEqual(permissionTypes('display-capture', main), []);
  let rules = updateSiteRules({}, origin, ['microphone'], 'allow');
  rules = updateSiteRules(rules, 'http://site.test', ['popups', 'camera'], 'allow');
  assert.deepEqual(rules, { [origin]: { microphone: 'allow' }, 'http://site.test': { popups: 'allow' } });
  assert.deepEqual(updateSiteRules(rules, origin, ['microphone'], 'ask'), { 'http://site.test': { popups: 'allow' } });
});

test('reading list persists links independently of history and de-duplicates canonical addresses', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2-reading-list-'));
  t.after(() => {
    fs.rmSync(path.join(directory, 'preferences.json'), { force: true });
    fs.rmdirSync(directory);
  });
  const prefs = preferences(directory);
  assert.equal(prefs.addReadingList('https://example.test', 'Article'), true);
  assert.equal(prefs.addReadingList('https://example.test/', 'Duplicate'), false);
  assert.equal(prefs.addReadingList('https://name:password@example.test/article', 'Private link'), false);
  prefs.clearHistory();
  const reopened = preferences(directory);
  assert.deepEqual(reopened.current.readingList.map(({ url, title }) => [url, title]), [['https://example.test/', 'Article']]);
  assert.equal(reopened.removeReadingList('https://example.test/'), true);
  assert.deepEqual(preferences(directory).current.readingList, []);
});
