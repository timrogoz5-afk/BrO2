const historyQuery = byId('history-query');
const tabQuery = byId('tab-query');
const toolEntries = byId('tool-entries');
const bookmarkStrip = byId('bookmarks-bar');
let toolName = '';
let noticeTimer;
let zoomTimer;
let bookmarksSignature;
let historySignature;
let historyLimit = 100;
let tabSearchSignature;
const groupSettingsPage = byId('group-settings-page');
const groupSettingsName = byId('group-settings-name');
const readerPage = byId('reader-page');
const readerToolbar = byId('reader-toolbar');
byId('reader-translate').addEventListener('click', () => window.bro2.send('reader-translate', byId('reader-language').value));
byId('reader-translation-cancel').addEventListener('click', () => window.bro2.send('reader-translation-cancel'));
byId('reader-original').addEventListener('click', () => window.bro2.send('reader-original'));
let renderedReader;
groupSettingsPage.addEventListener('submit', (event) => {
  event.preventDefault();
  if (groupSettingsName.value.trim()) window.bro2.send('rename-group', {
    title: groupSettingsName.value, color: byId('group-settings-color').value,
  });
});
const historyClear = byId('history-clear-dialog');
const downloadsQuery = byId('downloads-query');
let downloadItems = [];
for (const id of ['download-directory', 'download-directory-reset']) {
  byId(id).addEventListener('click', () => window.bro2.send(id));
}
byId('download-prompt').addEventListener('change', ({ target }) => window.bro2.send('preference', {
  key: 'promptDownloads', value: target.checked,
}));
byId('downloads-clear').addEventListener('click', () => window.bro2.send('clear-downloads'));
downloadsQuery.addEventListener('input', () => drawDownloads(downloadItems));
byId('history-clear-open').addEventListener('click', () => {
  historyClear.returnValue = '';
  historyClear.showModal();
});
historyClear.addEventListener('close', () => {
  if (historyClear.returnValue === 'confirm') window.bro2.send('history-clear-range', byId('history-clear-range').value);
});

byId('tools-close').addEventListener('click', () => window.bro2.send('close-tool'));
byId('tasks-update').addEventListener('click', () => window.bro2.send('refresh-tasks'));
byId('browser-menu').addEventListener('click', () => window.bro2.send('menu'));
window.bro2.onMenuState((open) => byId('browser-menu').setAttribute('aria-expanded', String(open)));
window.bro2.onZoom((level) => {
  clearTimeout(zoomTimer);
  setMessage('zoom-level', `${level}%`);
  zoomTimer = setTimeout(() => setMessage('zoom-level'), 1600);
});
window.bro2.onNotice((message) => {
  clearTimeout(noticeTimer);
  setMessage('browser-notice', message);
  noticeTimer = setTimeout(() => setMessage('browser-notice'), 3200);
});

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.isComposing || document.querySelector('dialog[open]')) return;
  const command = shortcutCommand({
    code: event.code, key: event.key, control: event.ctrlKey, alt: event.altKey, shift: event.shiftKey,
    meta: event.metaKey, isAutoRepeat: event.repeat,
  });
  if (command) {
    event.preventDefault();
    window.bro2.send('shortcut-key', { code: event.code, key: event.key, control: event.ctrlKey,
      alt: event.altKey, shift: event.shiftKey, meta: event.metaKey });
  } else if (event.key === 'Escape' && !state?.settingsOpen) {
    window.bro2.send('escape');
  } else if (event.key === 'Backspace' && !event.ctrlKey && !event.altKey && !event.metaKey &&
      !event.target.closest('input,textarea,select,[contenteditable]') && !state?.settingsOpen && !state?.toolPage) {
    event.preventDefault();
    window.bro2.send(event.shiftKey ? 'forward' : 'back');
  }
});

function openable(title, url) {
  const button = actionButton(title || url, () => window.bro2.send('go', url), 'action text-action');
  button.title = url;
  return button;
}

function setToolsRows(rows, empty) {
  toolEntries.replaceChildren(...(rows.length ? rows : [emptyItem(empty)]));
}

function drawReader(article) {
  readerPage.hidden = !article;
  if (renderedReader === JSON.stringify(article)) return;
  renderedReader = JSON.stringify(article);
  readerPage.replaceChildren();
  if (!article) return;
  const heading = document.createElement('h2');
  heading.textContent = article.title;
  const allowed = { h1: 'h3', h2: 'h3', h3: 'h4', h4: 'h4', p: 'p', blockquote: 'blockquote', li: 'p', pre: 'pre' };
  const fragment = document.createDocumentFragment();
  fragment.append(heading);
  for (const { kind, text } of article.blocks) {
    if (kind === 'h1' && text === article.title) continue;
    const element = document.createElement(Object.hasOwn(allowed, kind) ? allowed[kind] : 'p');
    element.textContent = kind === 'li' ? '• ' + text : text;
    fragment.append(element);
  }
  readerPage.append(fragment);
}

function drawTabSearch(next) {
  const results = matchingLinks(tabQuery.value, next.openTabs);
  const signature = JSON.stringify(results);
  if (tabSearchSignature === signature) return;
  tabSearchSignature = signature;
  const focused = document.activeElement?.closest('[data-tab-reference]')?.dataset.tabReference;
  const rows = results.map((entry) => {
    const row = document.createElement('li');
    row.dataset.tabReference = `${entry.windowId}:${entry.id}`;
    const labels = document.createElement('div');
    const button = actionButton(entry.title, () => activateSuggestion({ ...entry, kind: 'tab' }), 'action text-action');
    const address = document.createElement('span');
    address.className = 'muted visited-address';
    address.textContent = entry.url;
    labels.append(button, address);
    row.append(labels);
    return row;
  });
  setToolsRows(rows, 'Вкладки не найдены.');
  if (focused) (rows.find((row) => row.dataset.tabReference === focused)?.querySelector('button') ?? tabQuery).focus();
}

tabQuery.addEventListener('input', () => drawTabSearch(state));
tabQuery.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing) toolEntries.querySelector('button')?.click();
  if (event.key === 'ArrowDown') toolEntries.querySelector('button')?.focus();
});

function drawHistory(next) {
  const query = historyQuery.value.toLowerCase().trim();
  const results = next.history.filter(({ title, url }) => query.split(/\s+/).every((word) =>
    title.toLowerCase().includes(word) || url.toLowerCase().includes(word)));
  const signature = JSON.stringify([query, historyLimit, results.map(({ id }) => id)]);
  if (historySignature === signature) return;
  historySignature = signature;
  const focused = document.activeElement?.closest('[data-visit-id]');
  const position = [...toolEntries.children].indexOf(focused);
  const rows = results.slice(0, historyLimit).map(({ id, title, url, time }) => {
    const row = document.createElement('li');
    row.dataset.visitId = id;
    const labels = document.createElement('div');
    const address = document.createElement('span');
    address.className = 'muted visited-address';
    address.textContent = url;
    labels.append(openable(title, url), address);
    const timeLabel = document.createElement('small');
    timeLabel.className = 'muted';
    timeLabel.textContent = Number.isFinite(time) ? new Date(time).toLocaleString('ru') : 'Дата неизвестна';
    const remove = actionButton('Удалить', () => window.bro2.send('history-remove', id));
    remove.setAttribute('aria-label', `Удалить посещение «${title || url}»`);
    row.append(labels, timeLabel, remove);
    return row;
  });
  if (results.length > historyLimit) {
    const more = document.createElement('li');
    more.append(actionButton('Показать ещё', () => {
      const firstNew = historyLimit;
      historyLimit += 100;
      drawHistory(state);
      toolEntries.children[firstNew]?.querySelector('button').focus();
    }));
    rows.push(more);
  }
  setToolsRows(rows, next.privateMode ? 'Посещения в инкогнито не сохраняются.' : query ? 'Совпадений нет.' : 'История пока пуста.');
  if (position >= 0) {
    const same = rows.find((row) => row.dataset.visitId === focused.dataset.visitId);
    (same?.lastElementChild || rows[Math.min(position, rows.length - 1)]?.lastElementChild || historyQuery).focus({ preventScroll: true });
  }
}
historyQuery.addEventListener('input', () => {
  historyLimit = 100;
  if (state?.toolPage === 'history') drawHistory(state);
});

function sizeLabel(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 Б';
  if (bytes < 1024) return `${bytes} Б`;
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  const power = Math.min(units.length, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** power).toLocaleString('ru', { maximumFractionDigits: 1 })} ${units[power - 1]}`;
}

function drawDownloads(items) {
  if (state?.toolPage !== 'downloads') return;
  const query = downloadsQuery.value.trim().toLowerCase();
  byId('downloads-clear').disabled = !items.some(({ canCancel }) => !canCancel);
  const focused = document.activeElement;
  const focusedDownload = focused?.closest('[data-download-id]')?.dataset.downloadId;
  const focusedAction = focused?.dataset.downloadAction;
  const stateLabels = { progressing: 'Загружается', completed: 'Завершена', paused: 'На паузе',
    cancelled: 'Отменена', interrupted: 'Прервана' };
  const rows = items.filter(({ name }) => name.toLowerCase().includes(query)).map((item) => {
    const row = document.createElement('li');
    row.dataset.downloadId = item.id;
    row.tabIndex = -1;
    const labels = document.createElement('div');
    const text = document.createElement('strong');
    const details = document.createElement('span');
    details.className = 'muted';
    text.textContent = item.name;
    details.textContent = item.state === 'completed' && !item.exists ? 'Файл перемещён или удалён' :
      `${stateLabels[item.state] || stateLabels.interrupted} · ${sizeLabel(item.transferred)}${item.size > 0 ? ' / ' + sizeLabel(item.size) : ''}`;
    labels.append(text, details);
    if (item.canCancel) {
      const progress = document.createElement('progress');
      progress.setAttribute('aria-label', `Загрузка файла ${item.name}`);
      if (item.size > 0) {
        progress.max = item.size;
        progress.value = item.transferred;
      }
      labels.append(progress);
    }
    row.append(labels);
    const actions = document.createElement('div');
    actions.className = 'vault-actions download-actions';
    const add = (label, action) => {
      const button = actionButton(label, () => window.bro2.send('download-action', { id: item.id, action }));
      button.dataset.downloadAction = action;
      actions.append(button);
    };
    if (item.state === 'progressing') add('Пауза', 'pause');
    if (item.canResume && ['paused', 'interrupted'].includes(item.state)) add('Продолжить', 'resume');
    if (item.canCancel) add('Отменить', 'stop');
    if (item.exists) {
      add('Открыть', 'open');
      add('Показать в папке', 'folder');
    }
    if (!item.canCancel) add('Убрать из списка', 'forget');
    if (actions.childElementCount) row.append(actions);
    return row;
  });
  setToolsRows(rows, query ? 'Совпадений нет.' : 'Загрузок пока нет.');
  const focusRow = rows.find((row) => row.dataset.downloadId === focusedDownload);
  if (focusRow) {
    const button = [...focusRow.querySelectorAll('button')].find((action) => action.dataset.downloadAction === focusedAction);
    (button || focusRow.querySelector('button') || focusRow).focus({ preventScroll: true });
  } else if (focusedDownload) downloadsQuery.focus({ preventScroll: true });
}

window.bro2.onDownloads((items) => {
  downloadItems = items;
  drawDownloads(items);
});

window.bro2.onTasks((tasks) => {
  if (state?.toolPage !== 'tasks') return;
  setToolsRows(tasks.map(({ pid, titles, cpu, memory }) => {
    const row = document.createElement('li');
    const labels = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = titles.join(' · ');
    labels.append(title, document.createTextNode(`PID ${pid} · ЦП ${cpu.toFixed(1)}% · ${Math.round(memory / 1024)} МБ`));
    row.append(labels, actionButton('Закрыть вкладки', () => window.bro2.send('close-tasks', pid)));
    return row;
  }), 'Нет данных о процессах вкладок.');
});

window.bro2.onState((next) => {
  byId('download-settings').hidden = next.privateMode;
  byId('download-directory-value').textContent = next.downloadDirectory;
  byId('download-prompt').checked = next.settings.promptDownloads;
  byId('private-label').hidden = !next.privateMode;
  document.body.classList.toggle('private', next.privateMode);
  byId('extension-button').hidden = next.privateMode;
  for (const id of ['password-settings', 'chrome-import', 'clear-history']) byId(id).hidden = next.privateMode;
  document.querySelector('.account').hidden = next.privateMode;
  if (!next.pageVisible) setMessage('zoom-level');
  bookmarkStrip.hidden = !next.bookmarkBar;
  const signature = JSON.stringify(next.bookmarkBar ? next.bookmarks : []);
  if (signature !== bookmarksSignature) {
    bookmarksSignature = signature;
    bookmarkStrip.replaceChildren();
    if (next.bookmarkBar) for (const item of next.bookmarks) {
      if (item.url) bookmarkStrip.append(openable(item.name, item.url));
      else {
        const folder = actionButton(item.name + ' ▾', () => {
          const { left, bottom } = folder.getBoundingClientRect();
          window.bro2.send('bookmark-folder-menu', { id: item.id, x: left, y: bottom });
        }, 'action text-action');
        folder.setAttribute('aria-haspopup', 'menu');
        bookmarkStrip.append(folder);
      }
    }
    if (next.bookmarkBar && !next.bookmarks.length) {
      const empty = document.createElement('span');
      empty.textContent = 'Добавь закладку через Ctrl+D';
      bookmarkStrip.append(empty);
    }
  }
  byId('tools-panel').hidden = !next.toolPage;
  byId('standard-tools').hidden = ['extensions', 'bookmarks', 'site-settings', 'clear-data', 'group-settings', 'reader', 'saved-groups'].includes(next.toolPage);
  drawReader(next.reader);
  readerToolbar.hidden = !next.reader || !next.translation;
  if (!readerToolbar.hidden) {
    const { endpoint, busy, translated } = next.translation;
    byId('reader-translation-destination').textContent = `Заголовок и текст статьи будут отправлены на ${new URL(endpoint).origin}.`;
    byId('reader-language').disabled = busy;
    byId('reader-translate').disabled = busy;
    byId('reader-translation-cancel').hidden = !busy;
    byId('reader-original').hidden = !translated;
  }
  groupSettingsPage.hidden = next.toolPage !== 'group-settings';
  byId('saved-groups-page').hidden = next.toolPage !== 'saved-groups';
  if (next.toolPage === 'saved-groups') drawSavedGroups(next.savedGroups);
  byId('extension-page').hidden = next.toolPage !== 'extensions';
  const titles = { history: 'История', downloads: 'Загрузки', tasks: 'Диспетчер задач',
    extensions: 'Расширения', bookmarks: 'Закладки', 'reading-list': 'Список для чтения',
    'site-settings': 'Разрешения и данные сайтов', 'clear-data': 'Удаление данных браузера', 'tab-search': 'Поиск по вкладкам',
    'group-settings': 'Группа вкладок', 'saved-groups': 'Сохранённые группы', reader: 'Режим чтения' };
  if (next.toolPage !== toolName) {
    toolEntries.replaceChildren();
    byId('tools-title').textContent = titles[next.toolPage] || '';
    historyQuery.hidden = next.toolPage !== 'history';
    tabQuery.hidden = next.toolPage !== 'tab-search';
    byId('history-clear-open').hidden = next.toolPage !== 'history' || next.privateMode;
    downloadsQuery.hidden = next.toolPage !== 'downloads';
    byId('downloads-clear').hidden = next.toolPage !== 'downloads';
    byId('tasks-update').hidden = next.toolPage !== 'tasks';
    if (next.toolPage === 'history') {
      historySignature = undefined;
      historyLimit = 100;
      historyQuery.value = '';
      historyQuery.focus();
    } else {
      if (historyClear.open) historyClear.close();
      if (next.toolPage === 'group-settings') {
        groupSettingsName.value = next.groupSettings?.title || '';
        byId('group-settings-color').value = next.groupSettings?.color || '#83acf8';
        groupSettingsName.focus();
        groupSettingsName.select();
      } else if (next.toolPage === 'tab-search') {
        tabSearchSignature = undefined;
        tabQuery.value = '';
        tabQuery.focus();
      } else if (next.toolPage === 'downloads') {
        downloadsQuery.value = '';
        downloadsQuery.focus();
      } else if (next.toolPage) byId('tools-close').focus();
    }
    toolName = next.toolPage;
  }
  if (next.toolPage === 'history') drawHistory(next);
  if (next.toolPage === 'tab-search') drawTabSearch(next);
});

let savedGroupsSignature;
function drawSavedGroups(groups) {
  const signature = JSON.stringify(groups);
  if (signature === savedGroupsSignature) return;
  savedGroupsSignature = signature;
  const rows = groups.map(({ id, title, color, count }) => {
    const row = document.createElement('li');
    const text = document.createElement('strong');
    const colorMark = document.createElement('span');
    colorMark.className = 'saved-group-color';
    colorMark.style.backgroundColor = color;
    text.append(colorMark, title + ' · ' + count);
    const actions = document.createElement('div');
    actions.className = 'vault-actions';
    for (const [action, label] of [['open', 'Открыть'], ['window', 'В новом окне'], ['delete', 'Удалить']]) {
      const button = actionButton(label, () => window.bro2.send('saved-group', { action, id }));
      button.setAttribute('aria-label', label + ' ' + title);
      actions.append(button);
    }
    row.append(text, actions);
    return row;
  });
  byId('saved-groups-list').replaceChildren(...(rows.length ? rows : [emptyItem('Сохранённых групп пока нет.')]));
}

let readingListSignature;
window.bro2.onState((next) => {
  if (next.toolPage !== 'reading-list') {
    readingListSignature = undefined;
    return;
  }
  const entries = next.readingList ?? [];
  const signature = JSON.stringify(entries);
  if (signature === readingListSignature) return;
  readingListSignature = signature;
  const focused = document.activeElement?.closest('[data-reading-url]');
  const focusIndex = [...toolEntries.children].indexOf(focused);
  const rows = entries.map(({ title, url }) => {
    const row = document.createElement('li');
    row.dataset.readingUrl = url;
    const labels = document.createElement('div');
    const address = document.createElement('span');
    address.className = 'muted visited-address';
    address.textContent = url;
    labels.append(openable(title, url), address);
    const remove = actionButton('Удалить', () => window.bro2.send('reading-remove', url));
    remove.setAttribute('aria-label', `Удалить «${title}» из списка для чтения`);
    row.append(labels, remove);
    return row;
  });
  setToolsRows(rows, 'Список для чтения пока пуст.');
  if (focusIndex >= 0) {
    const neighbor = rows[Math.min(focusIndex, rows.length - 1)]?.lastElementChild;
    (neighbor || byId('tools-close')).focus({ preventScroll: true });
  }
});
