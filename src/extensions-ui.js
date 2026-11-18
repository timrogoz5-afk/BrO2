const extensionReview = byId('extension-review');
const extensionList = byId('extension-list');
const extensionAdd = byId('extension-add');
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
  byId('extension-cancel').disabled = byId('extension-install').disabled = value;
}

byId('extension-button').addEventListener('click', () => {
  closeSuggestions();
  window.bro2.send('extensions');
});

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
  const response = await window.bro2.extensions(action, id, page);
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

extensionAdd.addEventListener('click', async () => {
  if (extensionBusy) return;
  setExtensionBusy(true);
  setMessage('extension-status');
  const response = await window.bro2.extensions('choose');
  setExtensionBusy(false);
  if (!response.ok) return setMessage('extension-status', response.message);
  if (!onExtensionsPage()) return;
  if (!response.result) {
    extensionAdd.focus();
    return;
  }
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
});

byId('extension-cancel').addEventListener('click', () => extensionReview.close());
extensionReview.addEventListener('cancel', (event) => { if (extensionBusy) event.preventDefault(); });
extensionReview.addEventListener('close', () => {
  if (onExtensionsPage() && !extensionAdd.disabled) extensionAdd.focus({ preventScroll: true });
  if (reviewedExtension) void window.bro2.extensions('cancel');
  reviewedExtension = undefined;
  if (onExtensionsPage()) extensionAdd.focus();
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
  const open = next.toolPage === 'extensions';
  if (open && !extensionPageWasOpen) void refreshExtensions();
  if (!open && extensionReview.open) {
    reviewedExtension = undefined;
    extensionReview.close();
  }
  extensionPageWasOpen = open;
});
