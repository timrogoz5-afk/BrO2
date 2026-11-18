const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { atomicJSON } = require('./password-vault');

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
const decode = (text) => text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, name) => {
  if (!name.startsWith('#')) return Object.hasOwn(entities, name) ? entities[name] : match;
  const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
});
const escape = (text) => text.replace(/[&<>"']/g, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const label = (text) => decode(text.replace(/<[^>]*>/g, '')).trim().slice(0, 512);

function bookmarkURL(text) {
  try {
    const url = new URL(text);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function parseBookmarks(html) {
  if (!/<DL\b/i.test(html)) throw new Error('Выбери HTML-файл закладок, экспортированный из браузера.');
  const roots = [];
  const stack = [];
  let pending;
  let skipped = 0;
  let ignoredDepth = 0;
  const tokens = /<H3\b[^>]*>([\s\S]*?)<\/H3\s*>|<A\b((?:[^"'>]|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/A\s*>|<(\/?)DL\b[^>]*>/gi;
  for (const match of html.matchAll(tokens)) {
    if (ignoredDepth) {
      if (match[4] !== undefined) ignoredDepth += match[4] ? -1 : 1;
      else if (match[2] !== undefined) skipped++;
      continue;
    }
    const folder = stack.at(-1) ?? roots;
    if (match[1] !== undefined) {
      const name = label(match[1]);
      pending = name ? { name, children: [] } : null;
      if (pending && stack.length < 32) folder.push(pending);
    } else if (match[2] !== undefined) {
      pending = null;
      const href = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/i.exec(match[2]);
      const url = href && bookmarkURL(decode(href[1] ?? href[2] ?? href[3]));
      if (url) folder.push({ name: label(match[3]) || url, url });
      else skipped++;
    } else if (match[4]) {
      stack.pop();
      pending = null;
    } else {
      if (stack.length < 32) stack.push(pending?.children ?? folder);
      else ignoredDepth = 1;
      pending = null;
    }
  }
  return { roots, skipped };
}

function merge(target, source) {
  let added = 0;
  const folders = new Map(target.filter((item) => !item.url).map((item) => [item.name, item.children]));
  const links = new Set(target.filter((item) => item.url).map((item) => item.url));
  for (const item of source) {
    if (item.url) {
      if (!links.has(item.url)) {
        target.push(item);
        links.add(item.url);
        added++;
      }
    } else {
      if (!folders.has(item.name)) {
        const children = [];
        target.push({ name: item.name, children });
        folders.set(item.name, children);
      }
      added += merge(folders.get(item.name), item.children);
    }
  }
  return added;
}

function bookmarkStats(items, trail = [], result = { count: 0, folders: [] }) {
  for (const item of items) {
    if (item.url) result.count++;
    else {
      const names = [...trail, item.name];
      result.folders.push(names.join(' / '));
      bookmarkStats(item.children, names, result);
    }
  }
  return result;
}

function bookmarkHTML(items) {
  const lines = ['<!DOCTYPE NETSCAPE-Bookmark-file-1>', '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>BrO2</TITLE>', '<H1>BrO2</H1>'];
  function render(children, indent) {
    lines.push(indent + '<DL><p>');
    for (const item of children) {
      const name = escape(item.name);
      if (item.url) lines.push(indent + `    <DT><A HREF="${escape(item.url)}">${name}</A>`);
      else {
        lines.push(indent + `    <DT><H3>${name}</H3>`);
        render(item.children, indent + '    ');
      }
    }
    lines.push(indent + '</DL><p>');
  }
  render(items, '');
  return lines.join('\r\n');
}

function bookmarks(directory) {
  const file = path.join(directory, 'bookmarks.json');
  let tail = Promise.resolve();
  function valid(items, depth = 0) {
    return Array.isArray(items) && depth < 34 && items.every((item) =>
      typeof item?.name === 'string' && (item.url ? bookmarkURL(item.url) === item.url : valid(item.children, depth + 1)));
  }
  async function list() {
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (data?.version === 1 && valid(data.items)) return data.items;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
    }
    throw new Error('Не удалось открыть хранилище закладок.');
  }

  function indexTree(items, nodes = new Map(), prefix = '') {
    items.forEach((item, index) => {
      const position = `${prefix}.${index}`;
      item.id ??= `legacy${position}`;
      nodes.set(item.id, { item, siblings: items });
      if (!item.url) indexTree(item.children, nodes, position);
    });
    return nodes;
  }

  function withoutIds(items) {
    return items.map(({ name, url, children }) => url ? { name, url } : { name, children: withoutIds(children) });
  }

  function assignNewIds(items) {
    for (const item of items) {
      item.id ??= randomUUID();
      if (!item.url) assignNewIds(item.children);
    }
  }

  function change(update) {
    const run = tail.then(async () => {
      const target = await list();
      const result = update(target);
      if (!valid(target)) throw new Error('Вложенность папок слишком велика.');
      await atomicJSON(file, { version: 1, items: target }).catch(() => {
        throw new Error('Не удалось сохранить закладки.');
      });
      return result;
    });
    tail = run.catch(() => {});
    return run;
  }

  return {
    list: () => tail.then(list).then(withoutIds),
    tree: () => tail.then(list).then((items) => { indexTree(items); return items; }),
    add(name, url) {
      const address = bookmarkURL(url);
      if (!address) return Promise.resolve(0);
      return this.import([{ name: name.slice(0, 512) || address, url: address }]);
    },
    import(items) {
      return change((target) => {
        indexTree(target);
        const added = merge(target, structuredClone(items));
        assignNewIds(target);
        return added;
      });
    },
    edit(action, value) {
      return change((items) => {
        const nodes = indexTree(items);
        const destination = () => {
          if (value.parent === '') return items;
          const folder = nodes.get(value.parent)?.item;
          if (!folder?.children) throw new Error('Выбранная папка больше недоступна.');
          return folder.children;
        };
        const name = typeof value.name === 'string' ? value.name.trim().slice(0, 512) : '';
        if (action === 'create-folder') {
          if (!name) throw new Error('Введи название папки.');
          destination().push({ id: randomUUID(), name, children: [] });
          return;
        }
        const node = nodes.get(value.id);
        if (!node) throw new Error('Запись уже удалена.');
        const { item, siblings } = node;
        const index = siblings.indexOf(item);
        if (action === 'delete') {
          siblings.splice(index, 1);
          return;
        }
        if (action === 'reorder') {
          const next = index + value.offset;
          if ([-1, 1].includes(value.offset) && next >= 0 && next < siblings.length) {
            [siblings[index], siblings[next]] = [siblings[next], siblings[index]];
          }
          return;
        }
        if (action !== 'edit' || !name) throw new Error('Введи название.');
        const url = item.url && typeof value.url === 'string' && bookmarkURL(value.url.trim());
        if (item.url && !url) throw new Error('Введи адрес HTTP или HTTPS.');
        const target = destination();
        function contains(children) {
          return children === target || children.some((child) => child.children && contains(child.children));
        }
        if (item.children && contains(item.children)) throw new Error('Выбери папку вне этой папки.');
        item.name = name;
        if (url) item.url = url;
        if (target !== siblings) {
          siblings.splice(index, 1);
          target.push(item);
        }
      });
    },
  };
}

function importTicket(kind, data, summary) {
  return { kind, data, summary, id: randomUUID(), expires: Date.now() + 5 * 60_000 };
}

module.exports = { parseBookmarks, bookmarkStats, bookmarkHTML, bookmarks, importTicket };
