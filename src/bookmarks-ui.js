const bookmarkPage = byId('bookmarks-page');
const bookmarkFolder = byId('bookmarks-folder');
const bookmarkQuery = byId('bookmarks-query');
const bookmarkList = byId('bookmarks-list');
const bookmarkDialog = byId('bookmarks-dialog');
const bookmarkDelete = byId('bookmarks-delete-dialog');
const bookmarkDestination = byId('bookmarks-destination');
let editedBookmark;
let removedBookmark;
let busyBookmark = false;
let bookmarkTreeSignature;

function bookmarkFolders(items, parent = '', names = [], folders = [{ id: '', name: 'Все закладки', parent: null, children: items }]) {
  for (const item of items) {
    if (item.url) continue;
    const path = [...names, item.name];
    folders.push({ ...item, name: path.join(' / '), parent });
    bookmarkFolders(item.children, item.id, path, folders);
  }
  return folders;
}

function bookmarkOptions(select, folders, id) {
  select.replaceChildren(...folders.map((folder) => new Option(folder.name, folder.id)));
  select.value = folders.some((folder) => folder.id === id) ? id : '';
}

function bookmarkRowsInFolder(items, parent, path, query) {
  return items.flatMap((item, index) => {
    const row = { item, parent, path, index, length: items.length };
    if (!query) return [row];
    const text = [item.name, item.url, path].join(' ').toLowerCase();
    const result = query.every((word) => text.includes(word)) ? [row] : [];
    if (!item.url) result.push(...bookmarkRowsInFolder(item.children, item.id, [path, item.name].filter(Boolean).join(' / '), query));
    return result;
  });
}

function openBookmarkEditor(row) {
  editedBookmark = row?.item;
  const folders = bookmarkFolders(state.bookmarks);
  const excluded = editedBookmark?.children
    ? new Set([editedBookmark.id, ...bookmarkFolders(editedBookmark.children).slice(1).map(({ id }) => id)])
    : new Set();
  bookmarkOptions(bookmarkDestination, folders.filter(({ id }) => !excluded.has(id)), row?.parent ?? bookmarkFolder.value);
  byId('bookmarks-dialog-title').textContent = editedBookmark ? 'Изменить закладку или папку' : 'Новая папка';
  byId('bookmarks-name').value = editedBookmark?.name ?? '';
  const url = byId('bookmarks-url');
  url.required = !byId('bookmarks-url-label').toggleAttribute('hidden', !editedBookmark?.url);
  url.value = editedBookmark?.url ?? '';
  setMessage('bookmarks-form-status');
  bookmarkDialog.showModal();
}

async function changeBookmark(action, value, status = 'bookmarks-status') {
  if (busyBookmark) return false;
  busyBookmark = true;
  byId('bookmarks-save').disabled = true;
  try {
    const response = await window.bro2.editBookmarks(action, value);
    setMessage(status, response.ok ? '' : response.message || 'Действие недоступно.');
    return response.ok;
  } catch {
    setMessage(status, 'Не удалось сохранить закладки.');
    return false;
  } finally {
    busyBookmark = false;
    byId('bookmarks-save').disabled = false;
  }
}

function renderBookmarkManager(items) {
  const folders = bookmarkFolders(items);
  const query = bookmarkQuery.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const selected = bookmarkFolder.value;
  const signature = JSON.stringify([items, selected, query]);
  if (bookmarkTreeSignature === signature) return;
  bookmarkTreeSignature = signature;
  bookmarkOptions(bookmarkFolder, folders, selected);
  const folder = folders.find(({ id }) => id === bookmarkFolder.value);
  const entries = query.length ? bookmarkRowsInFolder(items, '', '', query)
    : bookmarkRowsInFolder(folder.children, folder.id, '', null);
  const focused = document.activeElement?.closest('[data-bookmark-id]');
  const focusIndex = [...bookmarkList.children].indexOf(focused);
  const focusAction = document.activeElement?.dataset.bookmarkAction;
  const rows = entries.map((entry) => {
    const { item, path, index, length } = entry;
    const row = document.createElement('li');
    row.dataset.bookmarkId = item.id;
    const labels = document.createElement('div');
    labels.append(item.url ? openable(item.name, item.url) : actionButton(item.name, () => {
      bookmarkFolder.value = item.id;
      bookmarkQuery.value = '';
      renderBookmarkManager(items);
      bookmarkFolder.focus();
    }, 'action text-action'));
    if (path || item.url) {
      const detail = document.createElement('span');
      detail.className = 'muted visited-address';
      detail.textContent = [path, item.url].filter(Boolean).join(' · ');
      labels.append(detail);
    }
    const actions = document.createElement('div');
    actions.className = 'vault-actions';
    const add = (label, key, handler, disabled = false) => {
      const button = actionButton(label, handler);
      button.dataset.bookmarkAction = key;
      button.setAttribute('aria-label', `${label} «${item.name}»`);
      button.disabled = disabled;
      actions.append(button);
    };
    add('Изменить', 'edit', () => openBookmarkEditor(entry));
    add('Выше', 'up', () => void changeBookmark('reorder', { id: item.id, offset: -1 }), !index);
    add('Ниже', 'down', () => void changeBookmark('reorder', { id: item.id, offset: 1 }), index === length - 1);
    add('Удалить', 'delete', () => {
      removedBookmark = item.id;
      byId('bookmarks-delete-name').textContent = item.url ? item.name : `Папка «${item.name}» со всем её содержимым`;
      bookmarkDelete.returnValue = '';
      bookmarkDelete.showModal();
    });
    row.append(labels, actions);
    return row;
  });
  bookmarkList.replaceChildren(...(rows.length ? rows : [emptyItem(query.length ? 'Совпадений нет.' : 'Папка пуста.')]));
  if (focusIndex >= 0) {
    const row = rows.find(({ dataset }) => dataset.bookmarkId === focused.dataset.bookmarkId);
    const button = [...(row?.querySelectorAll('button:enabled') ?? [])].find(({ dataset }) => dataset.bookmarkAction === focusAction);
    (button ?? row?.querySelector('button') ?? rows[Math.min(focusIndex, rows.length - 1)]?.querySelector('button') ??
      bookmarkFolder).focus({ preventScroll: true });
  }
}

bookmarkFolder.addEventListener('change', () => {
  bookmarkQuery.value = '';
  renderBookmarkManager(state.bookmarks);
});
bookmarkQuery.addEventListener('input', () => renderBookmarkManager(state.bookmarks));
byId('bookmarks-new-folder').addEventListener('click', () => openBookmarkEditor());
byId('bookmarks-cancel').addEventListener('click', () => bookmarkDialog.close());
byId('bookmarks-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await changeBookmark(editedBookmark ? 'edit' : 'create-folder', {
    id: editedBookmark?.id, name: byId('bookmarks-name').value,
    url: byId('bookmarks-url').value, parent: bookmarkDestination.value,
  }, 'bookmarks-form-status');
  if (result && bookmarkDialog.open) bookmarkDialog.close();
});
bookmarkDelete.addEventListener('close', () => {
  if (bookmarkDelete.returnValue === 'confirm') void changeBookmark('delete', { id: removedBookmark });
});
window.bro2.onState((next) => {
  const open = next.toolPage === 'bookmarks';
  const wasOpen = !bookmarkPage.hidden;
  bookmarkPage.hidden = !open;
  if (open) {
    renderBookmarkManager(next.bookmarks);
    if (!wasOpen) bookmarkQuery.focus();
  } else if (wasOpen) {
    bookmarkTreeSignature = undefined;
    bookmarkQuery.value = '';
    if (bookmarkDialog.open) bookmarkDialog.close();
    if (bookmarkDelete.open) bookmarkDelete.close();
  }
});
