const passwordButton = byId('password-button');
const passwordEditor = byId('password-editor');
const passwordRemoval = byId('password-remove');
const importPreview = byId('import-preview');
let vaultEntries = [];
let vaultExceptions = [];
let editId;
let removeId;
let importId;
let importKind;
let editBusy = false;

function actionButton(label, action, className = 'action') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}

function setMessage(id, message) {
  const element = byId(id);
  element.textContent = message || '';
  element.hidden = !message;
}

const sendPanel = (action, value) => window.bro2.passwordPanel(action, value);
passwordButton.addEventListener('click', () => {
  closeSuggestions();
  sendPanel('open');
});
address.addEventListener('focus', () => sendPanel('hide'));


window.bro2.onPasswordExpanded((expanded) => passwordButton.setAttribute('aria-expanded', String(expanded)));
document.addEventListener('keydown', (event) => {
  if (event.altKey && event.key === 'ArrowDown' && !state?.settingsOpen && state?.url) {
    event.preventDefault();
    closeSuggestions();
    sendPanel('open');
  }
});
async function passwordSetting(action, value, status = 'password-status') {
  const response = await window.bro2.passwordSettings(action, value);
  if (!response.ok && response.message) setMessage(status, response.message);
  return response;
}

function emptyItem(text) {
  const item = document.createElement('li');
  item.className = 'muted';
  item.textContent = text;
  return item;
}

function drawVault() {
  const query = byId('password-search').value.toLowerCase().trim();
  const rows = vaultEntries.filter(({ origin, username }) =>
    origin.toLowerCase().includes(query) || username.toLowerCase().includes(query));
  byId('password-entries').replaceChildren(...rows.map((entry) => {
    const row = document.createElement('li');
    const labels = document.createElement('div');
    const origin = document.createElement('strong');
    origin.textContent = entry.origin;
    labels.append(origin, document.createTextNode(entry.username || 'Без логина'));
    row.append(labels,
      actionButton('Изменить', () => edit(entry)),
      actionButton('Копировать', async () => {
        if ((await passwordSetting('copy', entry.id)).ok) setMessage('password-status', 'Пароль скопирован.');
      }),
      actionButton('Удалить', () => {
        removeId = entry.id;
        byId('password-remove-label').textContent = `${entry.origin} · ${entry.username || 'Без логина'}`;
        passwordRemoval.showModal();
      }));
    return row;
  }));
  if (!rows.length) byId('password-entries').append(emptyItem(query ? 'Совпадений нет.' : 'Сохранённых паролей пока нет.'));
  byId('password-exceptions').replaceChildren(...vaultExceptions.map((origin) => {
    const row = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = origin;
    row.append(name, actionButton('Убрать из исключений', async () => {
      if ((await passwordSetting('exception', origin)).ok) await refreshVault();
    }));
    return row;
  }));
  if (!vaultExceptions.length) byId('password-exceptions').append(emptyItem('Исключений пока нет.'));
}

async function refreshVault() {
  const response = await passwordSetting('list');
  if (!response.ok || !state?.settingsOpen) return;
  ({ entries: vaultEntries, exceptions: vaultExceptions } = response.result);
  drawVault();
}

function edit(entry) {
  editId = entry?.id;
  byId('password-editor-title').textContent = entry ? 'Изменить пароль' : 'Новый пароль';
  byId('password-form').reset();
  byId('password-origin').value = entry?.origin || '';
  byId('password-username').value = entry?.username || '';
  setMessage('password-editor-status');
  passwordEditor.showModal();
  if (entry) byId('password-secret').focus();
}

byId('password-settings').addEventListener('toggle', () => {
  if (byId('password-settings').open && state?.settingsOpen) void refreshVault();
});
byId('password-search').addEventListener('input', drawVault);
byId('password-add').addEventListener('click', () => edit());
byId('password-editor-cancel').addEventListener('click', () => passwordEditor.close());
byId('password-remove-cancel').addEventListener('click', () => passwordRemoval.close());
passwordEditor.addEventListener('close', () => byId('password-form').reset());
byId('password-remove-confirm').addEventListener('click', async () => {
  const button = byId('password-remove-confirm');
  button.disabled = true;
  try {
    if ((await passwordSetting('remove', removeId)).ok) {
      passwordRemoval.close();
      setMessage('password-status', 'Запись удалена.');
      await refreshVault();
      byId('password-search').focus();
    }
  } finally { button.disabled = false; }
});
byId('password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (editBusy) return;
  editBusy = byId('password-editor-save').disabled = true;
  try {
    const response = await passwordSetting('save', { id: editId, origin: byId('password-origin').value,
      username: byId('password-username').value, password: byId('password-secret').value }, 'password-editor-status');
    if (!response.ok) return;
    passwordEditor.close();
    setMessage('password-status', 'Пароль сохранён.');
    await refreshVault();
  } finally { editBusy = byId('password-editor-save').disabled = false; }
});
byId('password-offers').addEventListener('change', ({ target }) => {
  window.bro2.send('preference', { key: 'passwordOffers', value: target.checked });
});

function bookmarkRows(items) {
  return items.map((item) => {
    const row = document.createElement('li');
    if (item.url) {
      const open = actionButton(item.name, () => window.bro2.send('go', item.url), 'action text-action');
      open.title = item.url;
      row.append(open);
    } else {
      const folder = document.createElement('details');
      const name = document.createElement('summary');
      name.textContent = item.name;
      const list = document.createElement('ul');
      list.className = 'vault-list';
      list.append(...bookmarkRows(item.children));
      folder.append(name, list);
      row.append(folder);
    }
    return row;
  });
}

async function refreshBookmarks() {
  const response = await passwordSetting('bookmarks', undefined, 'import-status');
  if (!response.ok || !state?.settingsOpen) return;
  byId('bookmark-list').replaceChildren(...(response.result.length ? bookmarkRows(response.result) : [emptyItem('Закладок пока нет.')]));
}

byId('bookmark-library').addEventListener('toggle', () => {
  if (byId('bookmark-library').open && state?.settingsOpen) void refreshBookmarks();
});
byId('export-bookmarks').addEventListener('click', async () => {
  const button = byId('export-bookmarks');
  button.disabled = true;
  try {
    const response = await passwordSetting('export-bookmarks', undefined, 'import-status');
    if (response.ok && response.result) setMessage('import-status', 'Закладки экспортированы.');
  } finally { button.disabled = false; }
});
for (const action of ['import-passwords', 'import-bookmarks']) {
  byId(action).addEventListener('click', async () => {
    setMessage('import-status');
    const response = await passwordSetting(action, undefined, 'import-status');
    if (!response.ok || !response.result || !state?.settingsOpen) return;
    const result = response.result;
    importId = result.id;
    importKind = result.kind;
    const csv = importKind === 'passwords';
    byId('import-preview-title').textContent = csv ? 'Импорт паролей' : 'Импорт закладок';
    byId('import-counts').textContent = csv ?
      `Новых ${result.fresh} · конфликтов ${result.conflicts} · пропущено ${result.skipped + result.unchanged}` :
      `Закладок в файле ${result.count} · пропущено ${result.skipped}`;
    const lines = result.errors?.slice(0, 30) || [];
    setMessage('import-errors', lines.length ? `Проверь строки ${lines.join(', ')}${result.errors.length > lines.length ? ' и последующие' : ''}.` : '');
    const folders = byId('import-folders');
    folders.hidden = !result.folders?.length;
    folders.replaceChildren(...(result.folders || []).slice(0, 100).map(emptyItem));
    if (result.folders?.length > 100) folders.append(emptyItem(`Ещё папок ${result.folders.length - 100}`));
    byId('import-replace').checked = false;
    byId('import-replace-label').hidden = !csv || !result.conflicts;
    importPreview.showModal();
  });
}
byId('import-cancel').addEventListener('click', () => importPreview.close());
importPreview.addEventListener('close', () => {
  if (importId) void window.bro2.passwordSettings('cancel-import');
  importId = undefined;
});
byId('import-confirm').addEventListener('click', async () => {
  const button = byId('import-confirm');
  button.disabled = true;
  const response = await passwordSetting('confirm-import', { id: importId, replace: byId('import-replace').checked }, 'import-status');
  button.disabled = false;
  importId = undefined;
  importPreview.close();
  if (!response.ok) return;
  if (importKind === 'passwords') {
    setMessage('import-status', `Сохранено записей: ${response.result}. CSV содержит открытые пароли. Его можно удалить после импорта.`);
    if (byId('password-settings').open) await refreshVault();
  } else {
    setMessage('import-status', `Добавлено закладок: ${response.result}. Ярлыки новой вкладки можно настроить отдельно.`);
    if (byId('bookmark-library').open) await refreshBookmarks();
  }
});

let passwordSettingsOpen = false;
window.bro2.onState((next) => {
  passwordButton.hidden = next.privateMode || next.settingsOpen || !/^https?:/.test(next.url) ||
    Boolean(next.toolPage || next.error);
  byId('password-offers').checked = next.settings.passwordOffers;
  if (next.settingsOpen && !passwordSettingsOpen) {
    if (byId('password-settings').open) void refreshVault();
    if (byId('bookmark-library').open) void refreshBookmarks();
  }
  if (!next.settingsOpen && passwordSettingsOpen) {
    for (const dialog of [passwordEditor, passwordRemoval, importPreview]) {
      if (dialog.open) dialog.close();
    }
    byId('password-form').reset();
    vaultEntries = [];
    vaultExceptions = [];
    byId('password-entries').replaceChildren();
    byId('password-exceptions').replaceChildren();
  }
  passwordSettingsOpen = next.settingsOpen;
});

