const passwordPanel = document.getElementById('password-panel');
const sendPanel = (action, value) => window.bro2Panel.send(action, value);
function actionButton(label, action, className = 'action') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}

function panelButton(label, action, value, primary = false) {
  return actionButton(label, () => sendPanel(action, value), primary ? 'action primary' : 'action');
}

window.bro2Panel.onPanel((panel, focus, style) => {
  window.applyTheme(style);
  passwordPanel.hidden = !panel;
  if (!panel) {
    passwordPanel.replaceChildren();
    return;
  }
  const focused = document.activeElement;
  const selectedIndex = [...passwordPanel.querySelectorAll('button,select')].indexOf(focused);
  const heading = document.createElement('h2');
  const names = { fill: panel.generation ? 'Новый пароль' : 'Сохранённые логины',
    save: panel.selected ? 'Обновить пароль?' : 'Сохранить пароль?', message: 'Пароли' };
  heading.textContent = names[panel.type];
  const header = document.createElement('div');
  header.className = 'password-heading';
  const close = actionButton('×', () => sendPanel('close'), 'icon password-panel-close');
  close.setAttribute('aria-label', 'Закрыть');
  header.append(heading, close);
  const origin = document.createElement('p');
  origin.className = 'muted password-origin';
  origin.textContent = panel.origin;
  origin.title = panel.origin;
  passwordPanel.replaceChildren(header);
  if (panel.origin) passwordPanel.append(origin);
  if (panel.message) {
    const message = document.createElement('p');
    message.setAttribute('role', panel.type === 'message' ? 'status' : 'alert');
    message.textContent = panel.message;
    passwordPanel.append(message);
  }
  let initial = close;
  if (panel.type === 'fill') {
    const list = document.createElement('div');
    list.className = 'password-logins';
    if (panel.generation) {
      initial = panelButton('Создать надёжный пароль', 'generate', null, true);
      list.append(initial);
    } else if (panel.entries.length) {
      const ordered = [...panel.entries].sort((a, b) => Number(b.username === panel.username) - Number(a.username === panel.username));
      for (const entry of ordered) {
        const match = Boolean(panel.username && entry.username === panel.username);
        const row = panelButton(entry.username || 'Без логина', 'fill', entry.id, match);
        row.classList.add('password-login');
        row.title = entry.username || 'Без логина';
        row.disabled = Boolean(panel.username && !match);
        row.prepend(icon('user'));
        if (!row.disabled && initial === close) initial = row;
        list.append(row);
      }
      if (initial === close) {
        const hint = document.createElement('p');
        hint.textContent = 'Для введённого логина нет записи. Очисти поле, чтобы выбрать другой логин.';
        list.prepend(hint);
      }
    } else {
      const empty = document.createElement('p');
      empty.textContent = 'Для этого сайта ещё нет сохранённых логинов.';
      list.append(empty);
    }
    passwordPanel.append(list);
  }
  if (panel.type === 'save') {
    const name = document.createElement('p');
    name.className = 'password-save-name';
    name.textContent = panel.username || 'Без логина';
    name.prepend(icon('user'));
    passwordPanel.append(name);
    let select;
    if (panel.entries.length) {
      select = document.createElement('select');
      select.setAttribute('aria-label', 'Запись для сохранения');
      select.append(new Option('Новая запись', ''));
      for (const entry of panel.entries) select.append(new Option(`Обновить · ${entry.username || 'Без логина'}`, entry.id));
      select.value = panel.selected;
      passwordPanel.append(select);
    }
    const actions = document.createElement('div');
    actions.className = 'vault-actions';
    initial = actionButton('Сохранить', () => sendPanel('save', select?.value), 'action primary');
    actions.append(initial, panelButton('Не сейчас', 'close'), panelButton('Никогда для этого сайта', 'never'));
    passwordPanel.append(actions);
  }
  if (focus) initial.focus();
  else if (selectedIndex >= 0) passwordPanel.querySelectorAll('button,select')[selectedIndex]?.focus();
  const height = Math.ceil(passwordPanel.getBoundingClientRect().height);
  sendPanel('size', height);
});

passwordPanel.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const rows = [...passwordPanel.querySelectorAll('.password-logins button:enabled')];
  if (!rows.length) return;
  event.preventDefault();
  const offset = event.key === 'ArrowDown' ? 1 : -1;
  const index = rows.indexOf(document.activeElement);
  rows[(index + offset + rows.length) % rows.length].focus();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !passwordPanel.hidden && !event.isComposing) {
    event.preventDefault();
    sendPanel('close');
  }
});
