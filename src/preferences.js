const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { webURL, customSearchEngine } = require('./address');
const { sessionURL, savedTab } = require('./session-state');
const { homeLayout } = require('./home-layout');
const { siteOrigin, siteRules, updateSiteRules } = require('./site-permissions');
const { translationEndpoint } = require('./translation');
const { faviconData } = require('./favicon');

const historyLimit = 5000;
const defaults = { theme: 'dark', search: 'google', motion: 'normal', accent: '#a8bfff', passwordOffers: true, bookmarkBar: false,
  promptDownloads: false, startup: 'new', homePage: '', startupPages: [], spellcheck: true, spellLanguages: 'system', memorySaver: false,
  memoryIdle: 30, memoryExceptions: [] };
const rules = {
  theme: (value) => ['dark', 'light', 'system'].includes(value),
  search: (value) => ['google', 'yandex', 'duckduckgo', 'bing', 'perplexity'].includes(value) ||
    (typeof value === 'string' && value.startsWith('custom:')),
  motion: (value) => ['off', 'minimal', 'normal', 'expressive'].includes(value),
  passwordOffers: (value) => typeof value === 'boolean',
  bookmarkBar: (value) => typeof value === 'boolean',
  promptDownloads: (value) => typeof value === 'boolean',
  startup: (value) => ['new', 'restore', 'pages'].includes(value),
  homePage: (value) => value === '' || Boolean(sessionURL(value)),
  startupPages: (value) => Array.isArray(value) && value.length <= 20 && value.every(sessionURL),
  spellcheck: (value) => typeof value === 'boolean',
  spellLanguages: (value) => ['system', 'ru', 'en-US', 'ru,en-US'].includes(value),
  memorySaver: (value) => typeof value === 'boolean',
  memoryIdle: (value) => [1, 5, 15, 30, 60, 120].includes(value),
  memoryExceptions: (value) => Array.isArray(value) && value.length <= 100 && value.every((host) => host === exceptionHost(host)), 
  accent: (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value),
};

function exceptionHost(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 255) return null;
  const input = value.trim().replace(/^\*\./, '');
  try {
    const url = new URL(input.includes('://') ? input : 'https://' + input);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.hostname.replace(/\.$/, '');
  } catch { return null; }
}

function savedGroups(value) {
  return (Array.isArray(value) ? value : []).slice(0, 40).flatMap((group) => {
    if (typeof group?.id !== 'string' || typeof group.title !== 'string' || !group.title.trim() ||
        !/^#[\dA-F]{6}$/i.test(group.color) || !Array.isArray(group.tabs)) return [];
    const tabs = group.tabs.slice(0, 160).map(savedTab);
    return tabs.length ? [{ id: group.id, title: group.title.trim().slice(0, 64), color: group.color, tabs }] : [];
  });
}

function links(value, limit = Infinity) {
  return (Array.isArray(value) ? value : []).filter((item) =>
    typeof item?.title === 'string' && typeof item.url === 'string' && webURL(item.url),
  ).slice(0, limit);
}

function preferences(directory) {
  const file = path.join(directory, 'preferences.json');
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }

  let data = {
    settings: { ...defaults }, googleClient: null, profile: null,
    siteRules: siteRules(saved.siteRules),
    siteZoom: Object.fromEntries(Object.entries(saved.siteZoom ?? {}).slice(0, 500).filter(([origin, level]) =>
      siteOrigin(origin, false) === origin && Number.isFinite(level) && level >= 25 && level <= 500)),
    searchEngines: (Array.isArray(saved.searchEngines) ? saved.searchEngines : []).slice(0, 30).map(customSearchEngine).filter(Boolean),
    history: links(saved.history, historyLimit).map(({ id, title, url, time }) => ({
      id: typeof id === 'string' ? id : randomUUID(), title, url, time,
    })), shortcuts: links(saved.shortcuts, 12).map(({ url, title, favicon }) => {
      const icon = faviconData(favicon);
      return icon ? { url, title, favicon: icon } : { url, title };
    }),
    readingList: links(saved.readingList),
    home: homeLayout(saved.home), savedGroups: savedGroups(saved.savedGroups),
  };
  for (const [key, valid] of Object.entries(rules)) {
    const value = saved.settings?.[key];
    if (valid(value)) data.settings[key] = value;
  }
  if (typeof saved.settings?.motion === 'boolean') data.settings.motion = saved.settings.motion ? 'normal' : 'off';
  if (data.settings.search.startsWith('custom:') && !data.searchEngines.some(({ keyword }) => `custom:${keyword}` === data.settings.search)) {
    data.settings.search = 'google';
  }
  if (typeof saved.googleClient === 'string') data.googleClient = saved.googleClient;
  if (translationEndpoint(saved.translation?.endpoint)) {
    data.translation = { endpoint: translationEndpoint(saved.translation.endpoint),
      key: typeof saved.translation.key === 'string' ? saved.translation.key : '' };
  }
  if (typeof saved.downloadDirectory === 'string' && path.isAbsolute(saved.downloadDirectory)) {
    data.downloadDirectory = saved.downloadDirectory;
  }
  if (typeof saved.profile?.email === 'string' && typeof saved.profile.name === 'string') {
    data.profile = { name: saved.profile.name, email: saved.profile.email };
  }

  function save(next) {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(next, null, 2), { flag: 'wx' });
      fs.renameSync(temp, file);
      data = next;
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  return {
    get current() { return data; },
    setSetting(key, value) {
      if (key === 'memoryExceptions') {
        if (!Array.isArray(value) || value.length > 100) throw new Error('Можно сохранить до 100 исключений.');
        value = [...new Set(value.map((host) => {
          const normalized = exceptionHost(host);
          if (!normalized) throw new Error('Проверь адреса исключений.');
          return normalized;
        }))];
      }
      if (!Object.hasOwn(rules, key) || !rules[key](value)) return;
      if (key === 'search' && value.startsWith('custom:') && !data.searchEngines.some(({ keyword }) => `custom:${keyword}` === value)) return;
      save({ ...data, settings: { ...data.settings, [key]: value } });
    },
    setHome(value) { save({ ...data, home: homeLayout(value) }); },
    setSavedGroups(groups) { save({ ...data, savedGroups: savedGroups(groups) }); },
    setStartupPages(homePage, startupPages) {
      save({ ...data, settings: { ...data.settings, homePage, startupPages } });
    },
    setGoogleClient(googleClient) { save({ ...data, googleClient, profile: null }); },
    setProfile(profile) { save({ ...data, profile }); },
    setTranslation(translation) { save({ ...data, translation }); },
    setDownloadDirectory(downloadDirectory) { save({ ...data, downloadDirectory }); },
    setSiteRule(origin, types, decision) {
      save({ ...data, siteRules: updateSiteRules(data.siteRules, origin, types, decision) });
    },
    clearSiteRules() { save({ ...data, siteRules: {} }); },
    setSiteZoom(origin, level) {
      const siteZoom = { ...data.siteZoom };
      delete siteZoom[origin];
      if (level !== 100) siteZoom[origin] = level;
      save({ ...data, siteZoom: Object.fromEntries(Object.entries(siteZoom).slice(-500)) });
    },
    changeSearchEngine(action, value) {
      const entry = action === 'save' ? customSearchEngine(value) : null;
      if (action === 'save' && !entry) throw new Error('Укажи имя, ключевое слово и HTTPS-адрес с {searchTerms} в пути или запросе.');
      const keyword = entry?.keyword ?? value;
      const searchEngines = data.searchEngines.filter((engine) => engine.keyword !== keyword);
      if (entry) {
        if (searchEngines.length >= 30) throw new Error('Можно сохранить до 30 поисковых систем.');
        searchEngines.push(entry);
      }
      const search = !entry && data.settings.search === `custom:${keyword}` ? 'google' : data.settings.search;
      save({ ...data, searchEngines, settings: { ...data.settings, search } });
    },
    visit(url, title) {
      const entry = { id: randomUUID(), url, title, time: Date.now() };
      save({ ...data, history: [entry, ...data.history].slice(0, historyLimit) });
    },
    setShortcut(url, title) {
      const remaining = data.shortcuts.filter((item) => item.url !== url);
      const origin = new URL(url).origin;
      const favicon = data.shortcuts.find((item) => item.favicon && new URL(item.url).origin === origin)?.favicon;
      const shortcut = favicon ? { url, title, favicon } : { url, title };
      const shortcuts = title ? [...remaining, shortcut].slice(0, 12) : remaining;
      save({ ...data, shortcuts });
    },
    setShortcutIcon(origin, value) {
      const favicon = faviconData(value);
      if (!favicon || !data.shortcuts.some((item) => !item.favicon && new URL(item.url).origin === origin)) return false;
      const shortcuts = data.shortcuts.map((item) =>
        !item.favicon && new URL(item.url).origin === origin ? { ...item, favicon } : item);
      save({ ...data, shortcuts });
      return true;
    },
    addReadingList(url, title) {
      const address = webURL(url);
      if (!address || data.readingList.some((item) => item.url === address)) return false;
      const { username, password } = new URL(address);
      if (username || password) return false;
      const name = typeof title === 'string' && title.trim() ? title.trim().slice(0, 240) : address;
      save({ ...data, readingList: [{ url: address, title: name, time: Date.now() }, ...data.readingList] });
      return true;
    },
    removeReadingList(url) {
      const readingList = data.readingList.filter((item) => item.url !== url);
      if (readingList.length === data.readingList.length) return false;
      save({ ...data, readingList });
      return true;
    },
    removeVisit(id) { save({ ...data, history: data.history.filter((item) => item.id !== id) }); },
    clearHistory(since = 0) {
      const history = since ? data.history.filter(({ time }) => !Number.isFinite(time) || time < since) : [];
      save({ ...data, history });
    },
  };
}

module.exports = { preferences };
