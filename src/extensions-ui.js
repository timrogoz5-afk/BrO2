const extensionReview = byId('extension-review');
const extensionList = byId('extension-list');
const extensionAdd = byId('extension-add');
const extensionStoreButton = byId('extension-store-button');
const extensionStoreForm = byId('extension-store-form');
const extensionStoreURL = byId('extension-store-url');
const extensionStoreSubmit = byId('extension-store-submit');
const permissionLabels = new Map([
  ['<all_urls>', 'Доступ ко всем сайтам'],
  ['activeTab', 'Доступ к активной вкладке после действия пользователя'],
  ['alarms', 'Запланированные действия'],
  ['fontSettings', 'Настройки шрифтов'],
  ['scripting', 'Запуск скриптов и применение стилей'],
  ['storage', 'Хранилище данных расширения'],
  ['tabs', 'Доступ к адресам и заголовкам вкладок'],
]);
let extensionBusy = false;
let reviewedExtension;

const onExtensionsPage = () => state?.toolPage === 'extensions';

function setExtensionBusy(value) {
  extensionBusy = value;
  extensionAdd.disabled = extensionList.inert = value;
  extensionStoreURL.disabled = extensionStoreSubmit.disabled = value;
  byId('extension-cancel').disabled = byId('extension-install').disabled = value;
}

function openExtensionsPage() {
  closeSuggestions();
  window.bro2.send('extensions');
}
const extensionButton = byId('extension-button');
const pinnedExtensions = byId('pinned-extensions');
const pinnedButtons = new Map();

function extensionAnchor(button) {
  const { right, bottom } = button.getBoundingClientRect();
  return { right: Math.max(0, window.innerWidth - right), bottom, id: button.dataset.extensionId,
    allowMotion: motionAllowed.matches, wallpaper: document.documentElement.dataset.wallpaper };
}

function showExtensionPanel(button, id) {
  closeSuggestions();
  window.bro2.send('extension-panel', { anchor: extensionAnchor(button), id });
}

extensionButton.addEventListener('click', () => showExtensionPanel(extensionButton));
extensionStoreButton.addEventListener('click', openExtensionsPage);
window.bro2.onExtensionFocus((id) => (pinnedButtons.get(id) || extensionButton).focus());
document.addEventListener('pointerdown', (event) => {
  if (state?.extensionPanelOpen && !event.target.closest('#extension-button, #pinned-extensions')) {
    window.bro2.send('extension-panel-dismiss');
  }
}, true);

function drawPinnedExtensions(next) {
  const ids = new Set(next.pinnedExtensions.map(({ id }) => id));
  for (const [id, button] of pinnedButtons) {
    if (ids.has(id)) continue;
    pinnedButtons.delete(id);
    button.remove();
  }
  for (const [index, { id, name, image }] of next.pinnedExtensions.entries()) {
    let button = pinnedButtons.get(id);
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'icon';
      button.dataset.extensionId = id;
      button.setAttribute('aria-haspopup', 'dialog');
      button.addEventListener('click', () => showExtensionPanel(button, id));
      pinnedButtons.set(id, button);
    }
    if (button.dataset.image !== (image || '')) {
      button.dataset.image = image || '';
      const glyph = image ? document.createElement('img') : icon('puzzle');
      if (image) { glyph.src = image; glyph.alt = ''; glyph.draggable = false; }
      button.replaceChildren(glyph);
    }
    button.title = name;
    button.setAttribute('aria-label', name);
    button.setAttribute('aria-expanded', String(next.extensionPanelAnchor === id));
    if (pinnedExtensions.children[index] !== button) pinnedExtensions.insertBefore(button, pinnedExtensions.children[index] || null);
  }
  pinnedExtensions.hidden = !ids.size;
  extensionButton.hidden = next.privateMode;
  extensionButton.setAttribute('aria-expanded', String(next.extensionPanelOpen && !ids.has(next.extensionPanelAnchor)));
}

function renderExtensions(entries, focusId = document.activeElement.closest('[data-extension]')?.dataset.extension) {
  const rows = entries.map((entry) => {
    const row = document.createElement('li');
    row.dataset.extension = entry.id;
    const labels = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = entry.name;
    const detail = document.createElement('span');
    detail.className = 'muted';
    detail.textContent = `${entry.version} · ${entry.error ? 'Ошибка загрузки' : entry.enabled ? 'Включено' : 'Отключено'}`;
    labels.append(name, detail);
    if (entry.description || entry.error) {
      const hint = document.createElement('p');
      hint.className = 'muted extension-description';
      hint.textContent = entry.error || entry.description;
      labels.append(hint);
    }
    if (entry.unavailable.length) {
      const hint = document.createElement('p');
      hint.className = 'muted extension-description';
      hint.textContent = `Недоступные API (${entry.unavailable.join(', ')})`;
      labels.append(hint);
    }
    const buttons = document.createElement('div');
    buttons.className = 'vault-actions extension-actions';
    const switchAction = entry.enabled ? 'disable' : 'enable';
    buttons.append(actionButton(entry.enabled ? 'Отключить' : entry.error ? 'Повторить' : 'Включить', () => changeExtension(switchAction, entry.id)));
    if (entry.action) {
      const open = actionButton('Открыть', () => changeExtension('open', entry.id, 'action'));
      open.title = 'Открыть панель расширения';
      buttons.append(open);
    }
    if (entry.options) buttons.append(actionButton('Настроить', () => changeExtension('open', entry.id, 'options')));
    buttons.append(actionButton('Удалить', () => changeExtension('remove', entry.id)));
    row.append(labels, buttons);
    return row;
  });
  extensionList.replaceChildren(...(rows.length ? rows : [emptyItem('Расширений пока нет.')]));
  if (focusId) rows.find((row) => row.dataset.extension === focusId)?.querySelector('button')?.focus({ preventScroll: true });
}

async function refreshExtensions(focusId) {
  const response = await window.bro2.extensions('list');
  if (!onExtensionsPage()) return;
  if (response.ok) renderExtensions(response.result, focusId);
  else setMessage('extension-status', response.message);
}

async function changeExtension(action, id, page) {
  if (extensionBusy) return;
  setExtensionBusy(true);
  const response = await window.bro2.extensions(action, id, page, page === 'action' ? extensionAnchor(extensionButton) : undefined);
  setExtensionBusy(false);
  if (!response.ok) setMessage('extension-status', response.message);
  else if (action === 'disable' || action === 'remove') setMessage('extension-status', 'Обнови открытые страницы, чтобы убрать уже внесённые изменения.');
  else setMessage('extension-status');
  if (action !== 'open') await refreshExtensions(id);
  if (action === 'remove' && onExtensionsPage()) extensionAdd.focus();
}

function accessList(title, values) {
  if (!values.length) return;
  const heading = document.createElement('h3');
  heading.textContent = title;
  const details = document.createElement('ul');
  for (const value of values) {
    const item = document.createElement('li');
    const label = permissionLabels.get(value);
    item.textContent = label ? `${label} (${value})` : value;
    details.append(item);
  }
  byId('extension-access').append(heading, details);
}

async function reviewExtension(action, source, button) {
  if (extensionBusy) return;
  setExtensionBusy(true);
  setMessage('extension-status', action === 'store' ? 'Скачиваем и проверяем пакет…' : '');
  const response = await window.bro2.extensions(action, source);
  setExtensionBusy(false);
  if (!onExtensionsPage()) return;
  setMessage('extension-status', response.message);
  if (!response.ok) return;
  if (!response.result) {
    button.focus();
    return;
  }
  button.focus({ preventScroll: true });
  const item = response.result;
  reviewedExtension = item.id;
  byId('extension-review-name').textContent = `${item.name} · ${item.version}`;
  setMessage('extension-review-description', item.description);
  byId('extension-access').replaceChildren();
  accessList('Запрошенные разрешения', item.grants);
  accessList('Сайты для запуска скриптов', item.sites);
  accessList('Дополнительные разрешения', item.optional);
  accessList('API, недоступные в BrO2', item.unavailable);
  if (!item.grants.length && !item.sites.length && !item.optional.length) {
    const detail = document.createElement('p');
    detail.textContent = 'Расширение не запрашивает дополнительных разрешений.';
    byId('extension-access').append(detail);
  }
  extensionReview.showModal();
}

extensionAdd.addEventListener('click', () => void reviewExtension('choose', undefined, extensionAdd));
extensionStoreForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void reviewExtension('store', extensionStoreURL.value, extensionStoreSubmit);
});

byId('extension-cancel').addEventListener('click', () => extensionReview.close());
extensionReview.addEventListener('cancel', (event) => { if (extensionBusy) event.preventDefault(); });
extensionReview.addEventListener('close', () => {
  if (reviewedExtension) void window.bro2.extensions('cancel');
  reviewedExtension = undefined;
});
byId('extension-install').addEventListener('click', async () => {
  if (extensionBusy || !reviewedExtension) return;
  setExtensionBusy(true);
  const response = await window.bro2.extensions('install', reviewedExtension);
  setExtensionBusy(false);
  if (!response.ok) {
    setMessage('extension-status', response.message);
    reviewedExtension = undefined;
    extensionReview.close();
    return;
  }
  reviewedExtension = undefined;
  if (extensionReview.open) extensionReview.close();
  setMessage('extension-status', 'Расширение добавлено. Для применения к уже открытой странице обнови её.');
  await refreshExtensions();
});
let extensionPageWasOpen = false;
window.bro2.onState((next) => {
  drawPinnedExtensions(next);
  extensionStoreButton.hidden = !next.storeListing;
  const open = next.toolPage === 'extensions';
  if (open && !extensionPageWasOpen) {
    extensionStoreURL.value = next.extensionStoreSource || '';
    void refreshExtensions();
  }
  if (!open && extensionReview.open) {
    reviewedExtension = undefined;
    extensionReview.close();
  }
  extensionPageWasOpen = open;
});
