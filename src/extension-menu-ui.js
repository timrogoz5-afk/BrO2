const list = document.getElementById('extensions');
const status = document.getElementById('status');
const manage = document.getElementById('manage');
const closeButton = document.getElementById('close');

function showMessage(message) {
  status.hidden = !message;
  status.textContent = message || '';
}

function control(glyph, label, action, id) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(icon(glyph));
  button.addEventListener('click', () => window.extensionMenu.send(action, id));
  button.dataset.action = action;
  return button;
}

window.extensionMenu.onState((entries, settings, error) => {
  window.applyTheme(settings);
  const focused = document.activeElement;
  let restore;
  const rows = entries.map(({ id, name, action, options, pinned, image, enabled, error: loadError }) => {
    const row = document.createElement('li');
    row.dataset.id = id;
    const open = control('puzzle', name, 'open', id);
    const glyph = open.firstChild;
    if (image) {
      const logo = document.createElement('img');
      logo.alt = '';
      logo.src = image;
      glyph.replaceWith(logo);
    }
    const label = document.createElement('span');
    label.textContent = name;
    open.classList.add('extension-open');
    open.append(label);
    open.disabled = !action;
    if (!action) {
      open.title = name + (loadError ? ' · Ошибка загрузки' : enabled ? ' · Нет панели расширения' : ' · Отключено');
      if (!enabled) open.classList.add('inactive-extension');
      open.setAttribute('aria-label', open.title);
    }
    row.append(open);
    if (action) {
      const pin = control('pin', 'Закрепить ' + name, 'pin', id);
      pin.title = pinned ? 'Открепить' : 'Закрепить';
      pin.setAttribute('aria-pressed', String(pinned));
      row.append(pin);
    }
    if (options) row.append(control('settings', 'Настройки ' + name, 'options', id));
    if (focused.closest('li')?.dataset.id === id) restore = [...row.children].find((button) => button.dataset.action === focused.dataset.action);
    return row;
  });
  list.hidden = !rows.length;
  list.replaceChildren(...rows);
  showMessage(error || (!rows.length ? 'Расширений пока нет.' : ''));
  if (!document.body.hasAttribute('data-ready')) {
    document.body.toggleAttribute('data-animate', settings.animateMenu === true);
    document.body.setAttribute('data-ready', '');
  }
  if (restore) restore.focus({ preventScroll: true });
});
window.extensionMenu.onError(showMessage);
closeButton.addEventListener('click', () => window.extensionMenu.send('close'));
manage.addEventListener('click', () => window.extensionMenu.send('manage'));
