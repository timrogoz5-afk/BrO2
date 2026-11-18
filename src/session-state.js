const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { webURL } = require('./address');

function sessionURL(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  const address = webURL(value);
  if (!address) return null;
  const { username, password } = new URL(address);
  return username || password ? null : address;
}

function savedTab(tab) {
  const url = sessionURL(tab?.url) ?? '';
  const index = tab?.history?.index;
  const previous = tab?.history?.entries;
  let history;
  if (url && Number.isInteger(index) && Array.isArray(previous) && sessionURL(previous[index]?.url) === url) {
    const entries = [];
    let activeIndex;
    for (let position = Math.max(0, index - 24); position < Math.min(previous.length, index + 16); position++) {
      const safe = sessionURL(previous[position]?.url);
      if (!safe) continue;
      if (index === position) activeIndex = entries.length;
      const title = typeof previous[position].title === 'string' ? previous[position].title.slice(0, 512) : '';
      entries.push({ url: safe, title });
    }
    if (activeIndex !== undefined) history = { entries, index: activeIndex };
  }
  const zoom = Number.isFinite(tab?.zoom) && tab.zoom >= .25 && tab.zoom <= 5 ? tab.zoom : 1;
  const group = Number.isInteger(tab?.group?.id) && tab.group.id >= 0 &&
    typeof tab.group.title === 'string' && /^#[0-9a-f]{6}$/i.test(tab.group.color)
    ? { id: tab.group.id, title: tab.group.title.slice(0, 64), color: tab.group.color, collapsed: Boolean(tab.group.collapsed) }
    : undefined;
  const title = typeof tab?.title === 'string' ? tab.title.slice(0, 512) : undefined;
  return { url, zoom, title, pinned: Boolean(tab?.pinned), muted: Boolean(tab?.muted), group, history };
}

function savedWindow(value) {
  if (!Array.isArray(value?.tabs) || !value.tabs.length) return null;
  const start = Number.isInteger(value.active) ? Math.max(0, Math.min(value.active, value.tabs.length - 1) - 80) : 0;
  const tabs = value.tabs.slice(start, start + 160).map(savedTab);
  const active = Number.isInteger(value.active) ? Math.min(tabs.length - 1, Math.max(0, value.active - start)) : 0;
  return { tabs, active, verticalTabs: Boolean(value.verticalTabs) };
}

function savedSession(data) {
  return {
    clean: data?.clean !== false,
    windows: (Array.isArray(data?.windows) ? data.windows : []).slice(0, 20).map(savedWindow).filter(Boolean),
    recent: (Array.isArray(data?.recent) ? data.recent : []).slice(0, 25).flatMap((item) => {
      if (item?.type === 'window') {
        const window = savedWindow(item.window);
        return window ? [{ type: 'window', window }] : [];
      }
      if (item?.type === 'tab' && item.tab) {
        const position = Number.isInteger(item.position) && item.position >= 0 ? item.position : 0;
        return [{ type: 'tab', tab: savedTab(item.tab), position }];
      }
      return [];
    }),
  };
}

function sessionState(directory) {
  const file = path.join(directory, 'session.json');
  let previous;
  try {
    previous = savedSession(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    previous = savedSession();
  }
  let serialized;
  return {
    previous,
    save(data) {
      const next = JSON.stringify(savedSession(data));
      if (next === serialized) return;
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(temporary, next, { flag: 'wx' });
        fs.renameSync(temporary, file);
        serialized = next;
      } finally { fs.rmSync(temporary, { force: true }); }
    },
  };
}

module.exports = { savedTab, savedWindow, sessionState, sessionURL };
