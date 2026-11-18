const byId = (id) => document.getElementById(id);
const address = byId('address');
const tabBar = byId('tabs');
const template = byId('tab-template');
const reload = byId('reload');
const suggestions = byId('suggestions');
const shortcutDialog = byId('shortcut-dialog');
const motionAllowed = matchMedia('(prefers-reduced-motion: no-preference)');
const tabElements = new Map();
const tabIcons = new WeakMap();
const selectedTabs = new Set();
const groupLabels = new Map();
const pressAnimations = new Map();
const addressScope = /^@(tabs|bookmarks|history)(?:\s+|$)/i;
const tabDragType = 'application/x-bro2-tab';
let state;
let editingAddress = false;
let choices = [];
let choiceIndex = -1;
let lastDropdownHeight = 0;
let shortcutSignature;
let customSearchSignature;
let tabSignature;
const moving = (settings = state?.settings) => Boolean(settings && ['normal', 'expressive'].includes(settings.motion) && motionAllowed.matches);
const duration = (kind) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--motion-${kind}`)) || 0;

byId('new').addEventListener('click', () => window.bro2.send('new'));
for (const [id, movement] of [
  ['back', 'translateX(-4px)'],
  ['forward', 'translateX(4px)'],
  ['reload', 'rotate(24deg)'],
]) {
  const button = byId(id);
  if (id === 'back' || id === 'forward') {
    button.title += ' · Контекстное меню показывает переходы';
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const { left, bottom } = button.getBoundingClientRect();
      window.bro2.send('navigation-menu', { forward: id === 'forward', x: left, y: bottom });
    });
  }
  button.addEventListener('click', () => {
    const stopping = id === 'reload' && state?.loading;
    if (moving()) {
      pressAnimations.get(button)?.cancel();
      const animation = button.animate([
        { transform: `${stopping ? '' : movement} scale(.82)`, backgroundColor: 'var(--accent-fill)' },
        { transform: 'scale(1.05)', offset: .63 },
        { transform: 'scale(1)' },
      ], { duration: duration('base'), easing: 'cubic-bezier(.2, .75, .25, 1)' });
      pressAnimations.set(button, animation);
      animation.addEventListener('finish', () => {
        if (pressAnimations.get(button) === animation) pressAnimations.delete(button);
      }, { once: true });
    }
    window.bro2.send(stopping ? 'stop' : id);
  });
}
function cancelPressAnimations() {
  pressAnimations.forEach((animation) => animation.cancel());
  pressAnimations.clear();
}
motionAllowed.addEventListener('change', () => {
  if (!moving()) stopMotion();
  updateMotion(state?.settings);
});
byId('retry').addEventListener('click', () => window.bro2.send('reload'));
for (const id of ['settings', 'settings-close']) {
  byId(id).addEventListener('click', () => {
    closeSuggestions();
    window.bro2.send('settings');
  });
}
byId('clear-history').addEventListener('click', () => window.bro2.send('clear-history'));
document.addEventListener('keydown', (event) => {
  if (state?.settingsOpen && event.key === 'Escape' && !event.defaultPrevented &&
      !event.isComposing && !document.querySelector('dialog[open]')) window.bro2.send('settings');
});
byId('accents').addEventListener('click', (event) => {
  const button = event.target.closest('.swatch');
  if (button) window.bro2.send('preference', { key: 'accent', value: button.value });
});
for (const action of ['google-sign-in', 'google-sign-out', 'google-cancel', 'google-import', 'google-setup']) {
  byId(action).addEventListener('click', () => window.bro2.send(action));
}
for (const [id, key] of [['theme', 'theme'], ['accent', 'accent'], ['search-engine', 'search'], ['motion', 'motion']]) {
  byId(id).addEventListener('change', ({ target }) => {
    window.bro2.send('preference', { key, value: target.type === 'checkbox' ? target.checked : target.value });
  });
}

for (const id of ['address', 'search']) {
  byId(`${id}-form`).addEventListener('submit', (event) => {
    event.preventDefault();
    const input = byId(id);
    if (!input.value.trim()) return;
    const selected = id === 'address' && !suggestions.hidden ? choices[choiceIndex] : null;
    if (!selected && id === 'address' && addressScope.test(input.value.trim())) return;
    editingAddress = false;
    closeSuggestions();
    activateSuggestion(selected ?? { url: input.value });
    if (id === 'search') input.value = '';
  });
}

function setDropdownHeight(height) {
  if (height === lastDropdownHeight) return;
  lastDropdownHeight = height;
  window.bro2.send('dropdown', height);
}

function closeSuggestions() {
  suggestions.hidden = true;
  address.setAttribute('aria-expanded', 'false');
  address.removeAttribute('aria-activedescendant');
  choices = [];
  choiceIndex = -1;
  setDropdownHeight(0);
}

function choose(index) {
  choiceIndex = index;
  Array.from(suggestions.children).forEach((row, i) => row.setAttribute('aria-selected', String(i === index)));
  if (index >= 0) address.setAttribute('aria-activedescendant', `suggestion-${index}`);
  else address.removeAttribute('aria-activedescendant');
}

function activateSuggestion(entry) {
  if (entry.kind === 'tab') window.bro2.send('switch-tab', { id: entry.id, windowId: entry.windowId });
  else window.bro2.send('go', entry.url);
}

function matchingLinks(query, entries) {
  const words = query.toLowerCase().trim().split(/\s+/);
  return entries.filter(({ title, url }) => {
    const text = `${title} ${url}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

function allBookmarks(items, links = []) {
  for (const item of items) {
    if (item.url) links.push({ title: item.name, url: item.url, kind: 'bookmark' });
    else allBookmarks(item.children, links);
  }
  return links;
}

function suggest() {
  const input = address.value.trim();
  if (!input || !state) return closeSuggestions();
  const scope = addressScope.exec(input);
  const query = scope ? input.slice(scope[0].length) : input;
  const kind = scope?.[1]?.toLowerCase();
  const open = state.openTabs.filter(({ id, windowId, url }) => (kind || url) && (id !== state.active || windowId !== state.windowId));
  const visited = [...new Map(state.history.slice().reverse().map((entry) => [entry.url, entry])).values()].reverse();
  const providers = {
    tabs: () => matchingLinks(query, open).map((entry) => ({ ...entry, kind: 'tab' })),
    bookmarks: () => [...new Map(matchingLinks(query, allBookmarks(state.bookmarks)).map((entry) => [entry.url, entry])).values()],
    history: () => matchingLinks(query, visited).map((entry) => ({ ...entry, kind: 'history' })),
  };
  if (kind) choices = providers[kind]().slice(0, 6);
  else choices = [{ title: input, url: input, kind: 'search' }, ...providers.tabs().slice(0, 2),
    ...providers.bookmarks().slice(0, 2), ...providers.history().slice(0, 2)];
  if (!choices.length) return closeSuggestions();
  const oldRows = new Map([...suggestions.children].map((row) => [row.dataset.key, row]));
  const rows = choices.map(({ title, url, kind, id, windowId }, index) => {
    const key = kind === 'tab' ? `tab:${windowId}:${id}` : kind === 'search' ? 'search' : `${kind}:${url}`;
    const existing = oldRows.get(key);
    if (existing) {
      existing.id = `suggestion-${index}`;
      existing.dataset.url = url;
      existing.querySelector('span').textContent = title;
      existing.querySelector('small').textContent = kind === 'tab' ? 'Переключиться на вкладку' : kind === 'search' ? 'Поиск или переход' : url;
      return existing;
    }
    const row = document.createElement('div');
    const label = document.createElement('span');
    const detail = document.createElement('small');
    row.id = `suggestion-${index}`;
    row.className = 'suggestion';
    row.dataset.key = key;
    row.dataset.url = url;
    row.setAttribute('role', 'option');
    label.textContent = title;
    detail.textContent = kind === 'tab' ? 'Переключиться на вкладку' : kind === 'search' ? 'Поиск или переход' : url;
    row.append(icon(kind === 'bookmark' ? 'star' : kind), label, detail);
    row.addEventListener('pointerdown', (event) => event.preventDefault());
    row.addEventListener('click', () => {
      const choice = choices.find((_entry, position) => row.id === `suggestion-${position}`);
      editingAddress = false;
      closeSuggestions();
      if (choice) activateSuggestion(choice);
    });
    return row;
  });
  rows.forEach((row, index) => {
    if (suggestions.children[index] !== row) suggestions.insertBefore(row, suggestions.children[index] || null);
  });
  while (suggestions.children.length > rows.length) suggestions.lastElementChild.remove();
  suggestions.hidden = false;
  address.setAttribute('aria-expanded', 'true');
  choose(kind ? 0 : -1);
  const header = document.querySelector('header');
  setDropdownHeight(Math.ceil(suggestions.getBoundingClientRect().bottom - header.offsetHeight + 12));
}

address.addEventListener('input', () => {
  editingAddress = true;
  suggest();
});
address.addEventListener('blur', () => {
  if (editingAddress && state) address.value = state.url;
  editingAddress = false;
  closeSuggestions();
});
address.addEventListener('keydown', (event) => {
  if (event.isComposing) return;
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !suggestions.hidden) {
    event.preventDefault();
    const offset = event.key === 'ArrowDown' ? 1 : -1;
    choose(choiceIndex === -1 && offset === -1 ? choices.length - 1 : (choiceIndex + offset + choices.length) % choices.length);
  }
  if (event.key === 'Escape' && state) {
    address.value = state.url;
    editingAddress = false;
    closeSuggestions();
    address.select();
  }
});
window.bro2.onFocus(() => {
  address.focus();
  address.select();
});

function revealTab(tab) {
  if (!tab) return;
  const viewport = tabBar.getBoundingClientRect();
  const bounds = tab.getBoundingClientRect();
  const vertical = document.body.classList.contains('vertical-tabs');
  const [start, end, scroll] = vertical ? ['top', 'bottom', 'scrollTop'] : ['left', 'right', 'scrollLeft'];
  if (bounds[start] < viewport[start] + 2) tabBar[scroll] -= Math.ceil(viewport[start] + 2 - bounds[start]);
  else if (bounds[end] > viewport[end] - 2) tabBar[scroll] += Math.ceil(bounds[end] - viewport[end] + 2);
}

new ResizeObserver(() => revealTab(tabElements.get(state?.active))).observe(tabBar);
tabBar.addEventListener('focusin', (event) => revealTab(event.target.closest('.tab')));
tabBar.addEventListener('wheel', (event) => {
  if (state?.verticalTabs || event.ctrlKey || !event.deltaY || Math.abs(event.deltaX) >= Math.abs(event.deltaY) ||
      tabBar.scrollWidth <= tabBar.clientWidth) return;
  const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 24 :
    event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? tabBar.clientWidth : 1;
  event.preventDefault();
  tabBar.scrollLeft += event.deltaY * scale;
}, { passive: false });

function drawTabIcon(slot, tab) {
  const favicon = tab.favicon || '';
  const fallback = tab.tool === 'extensions' ? 'puzzle' : tab.url ? 'globe' : 'tab';
  const previous = tabIcons.get(slot);
  if (previous?.favicon === favicon && previous.fallback === fallback) return;
  const current = { favicon, fallback };
  tabIcons.set(slot, current);
  slot.replaceChildren(icon(fallback));
  if (!favicon) return;
  const image = document.createElement('img');
  image.alt = '';
  image.draggable = false;
  image.src = favicon;
  image.decode().then(() => {
    if (tabIcons.get(slot) === current) slot.replaceChildren(image);
  }, () => {});
}

function beginTabDrag(event, element, target) {
  const token = crypto.randomUUID();
  event.dataTransfer.setData(tabDragType, token);
  event.dataTransfer.effectAllowed = 'move';
  element.dataset.dragToken = token;
  element.classList.add('dragging-tab');
  window.bro2.send('tab-drag-start', { ...target, token });
}

function endTabDrag(element) {
  window.bro2.send('tab-drag-end', element.dataset.dragToken);
  element.classList.remove('dragging-tab');
  delete element.dataset.dragToken;
  tabBar.querySelector('.tab-drop-target')?.classList.remove('tab-drop-target');
}

function animateTabRemoval(element) {
  if (!moving() || document.hidden || document.querySelectorAll('.tab-leaving').length >= 3) return;
  const rect = element.getBoundingClientRect();
  const bar = tabBar.getBoundingClientRect();
  if (rect.bottom < bar.top || rect.top > bar.bottom || rect.right < bar.left || rect.left > bar.right) return;
  const copy = element.cloneNode(true);
  copy.inert = true;
  copy.classList.add('tab-leaving');
  copy.style.setProperty('--leave-top', rect.top + 'px');
  copy.style.setProperty('--leave-left', rect.left + 'px');
  copy.style.setProperty('--leave-width', rect.width + 'px');
  document.body.append(copy);
  copy.addEventListener('animationend', () => copy.remove(), { once: true });
  setTimeout(() => copy.remove(), 350);
}

function drawTabs(next) {
  document.body.classList.toggle('vertical-tabs', Boolean(next.verticalTabs));
  const ordered = [];
  const visibleGroups = new Set();
  let previousGroup;
  for (const tab of next.tabs) {
    const group = tab.group;
    if (group && group.id !== previousGroup) {
      visibleGroups.add(tab.id);
      let label = groupLabels.get(tab.id);
      if (!label) {
        label = document.createElement('button');
        label.type = 'button';
        label.className = 'tab-group-label';
        label.addEventListener('click', () => window.bro2.send('toggle-group', Number(label.dataset.groupId)));
        label.draggable = true;
        label.addEventListener('dragstart', (event) => beginTabDrag(event, label, { groupId: Number(label.dataset.groupId) }));
        label.addEventListener('dragend', () => endTabDrag(label));
        function showMenu(x, y) {
          window.bro2.send('group-menu', { id: Number(label.dataset.groupId), x, y });
        }
        label.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          showMenu(event.clientX, event.clientY);
        });
        label.addEventListener('keydown', (event) => {
          if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
          event.preventDefault();
          const { left, bottom } = label.getBoundingClientRect();
          showMenu(left, bottom);
        });
        groupLabels.set(tab.id, label);
      }
      label.dataset.groupId = group.id;
      label.style.setProperty('--group-color', group.color);
      label.textContent = label.title = group.title;
      label.setAttribute('aria-expanded', String(!group.collapsed));
      ordered.push(label);
    }
    previousGroup = group?.id;
    if (group?.collapsed && tab.id !== next.active) continue;
    let element = tabElements.get(tab.id);
    if (!element) {
      element = template.content.firstElementChild.cloneNode(true);
      element.dataset.tabId = tab.id;
      element.draggable = true;
      element.addEventListener('dragstart', (event) => beginTabDrag(event, element, { id: tab.id }));
      element.addEventListener('dragend', () => endTabDrag(element));
      function markTab(event) {
        if (event.shiftKey) {
          const order = state.tabs.map(({ id }) => id);
          const [first, last] = [order.indexOf(state.active), order.indexOf(tab.id)].sort((a, b) => a - b);
          selectedTabs.clear();
          for (const id of order.slice(first, last + 1)) selectedTabs.add(id);
        } else if (selectedTabs.has(tab.id)) selectedTabs.delete(tab.id);
        else selectedTabs.add(tab.id);
        drawTabs(state);
      }
      element.firstElementChild.addEventListener('keydown', (event) => {
        if (!event.shiftKey && !(event.ctrlKey && event.code === 'Space')) return;
        if (event.code !== 'Space' || event.repeat || event.isComposing) return;
        event.preventDefault();
        markTab(event);
      });
      element.firstElementChild.addEventListener('click', (event) => {
        if (event.ctrlKey || event.shiftKey) { markTab(event); return; }
        selectedTabs.clear();
        closeSuggestions();
        window.bro2.send('select', tab.id);
      });
      element.lastElementChild.addEventListener('click', () => window.bro2.send('close', tab.id));
      element.addEventListener('auxclick', (event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        window.bro2.send('close', tab.id);
      });
      element.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        window.bro2.send('tab-menu', { id: tab.id, x: event.clientX, y: event.clientY, selected: [...selectedTabs] });
      });
      element.lastElementChild.textContent = '×';
      tabElements.set(tab.id, element);
    }
    ordered.push(element);
    const selected = tab.id === next.active;
    element.classList.toggle('active', selected);
    element.classList.toggle('tab-selected', selectedTabs.has(tab.id));
    element.classList.toggle('loading', tab.loading);
    element.classList.toggle('suspended', tab.suspended);
    element.classList.toggle('pinned', Boolean(tab.pinned));
    element.classList.toggle('grouped', Boolean(group));
    if (group) element.style.setProperty('--group-color', group.color);
    else element.style.removeProperty('--group-color');
    drawTabIcon(element.querySelector('.tab-icon'), tab);
    element.querySelector('.tab-label').textContent = tab.title;
    element.firstElementChild.title = tab.suspended ? `${tab.title} · Выгружена из памяти` : tab.title;
    element.firstElementChild.setAttribute('aria-label', element.firstElementChild.title);
    element.firstElementChild.setAttribute('aria-current', String(selected));
    element.firstElementChild.setAttribute('aria-pressed', String(selectedTabs.has(tab.id)));
    const close = element.lastElementChild;
    close.title = selected ? 'Закрыть вкладку (Ctrl+W)' : 'Закрыть вкладку';
    close.setAttribute('aria-label', `Закрыть вкладку «${tab.title}»`);
    if (selected) close.setAttribute('aria-keyshortcuts', 'Control+W');
    else close.removeAttribute('aria-keyshortcuts');
  }
  const present = new Set(next.tabs.filter(({ group, id }) => !group?.collapsed || id === next.active).map(({ id }) => id));
  for (const id of selectedTabs) if (!present.has(id)) selectedTabs.delete(id);
  for (const [id, element] of tabElements) {
    if (present.has(id)) continue;
    tabElements.delete(id);
    animateTabRemoval(element);
    element.remove();
  }
  for (const [id, label] of groupLabels) {
    if (visibleGroups.has(id)) continue;
    groupLabels.delete(id);
    label.remove();
  }
  const reordered = ordered.some((element, index) => tabBar.children[index] !== element);
  if (reordered) {
    for (const [index, element] of ordered.entries()) {
      if (tabBar.children[index] !== element) tabBar.insertBefore(element, tabBar.children[index] || null);
    }
  }
  if (reordered || state?.active !== next.active || state?.verticalTabs !== next.verticalTabs ||
      state?.tabs.length !== next.tabs.length) revealTab(tabElements.get(next.active));
}

tabBar.addEventListener('dragover', (event) => {
  if (!event.dataTransfer.types.includes(tabDragType)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  const target = event.target.closest('[data-tab-id],[data-group-id]');
  const previous = tabBar.querySelector('.tab-drop-target');
  if (previous !== target) previous?.classList.remove('tab-drop-target');
  target?.classList.add('tab-drop-target');
});

tabBar.addEventListener('dragleave', (event) => {
  if (!tabBar.contains(event.relatedTarget)) tabBar.querySelector('.tab-drop-target')?.classList.remove('tab-drop-target');
});

tabBar.addEventListener('drop', (event) => {
  const token = event.dataTransfer.getData(tabDragType);
  if (!token) return;
  event.preventDefault();
  tabBar.querySelector('.tab-drop-target')?.classList.remove('tab-drop-target');
  const over = event.target.closest('[data-tab-id],[data-group-id]');
  const target = over || [...tabBar.querySelectorAll('[data-tab-id],[data-group-id]')].at(-1);
  if (!target) return;
  const bounds = target.getBoundingClientRect();
  const ratio = state.verticalTabs ? (event.clientY - bounds.top) / bounds.height : (event.clientX - bounds.left) / bounds.width;
  window.bro2.send('tab-drop', { token, targetId: Number(target.dataset.tabId), targetGroupId: Number(target.dataset.groupId),
    after: !over || ratio >= .5, combine: Boolean(over && ratio > .29 && ratio < .71) });
});

function shortcutAddress(input) {
  const value = input.trim();
  if (!value || /\s|\\/.test(value)) return null;
  try {
    if (!/^https?:\/\//i.test(value) && !/^(?:localhost|\[[\da-f:]+\]|[^/:?#]+\.[^/:?#]+)(?:[:/?#]|$)/i.test(value)) return null;
    const local = /^(?:localhost|127\.|\[::1\])/i.test(value);
    const url = new URL(/^https?:\/\//i.test(value) ? value : `${local ? 'http' : 'https'}://${value}`);
    return url.username || url.password ? null : url.href;
  } catch { return null; }
}

byId('pin').addEventListener('click', () => {
  if (!state?.url) return;
  const saved = state.shortcuts.some((item) => item.url === state.url);
  const title = state.tabs.find(({ id }) => id === state.active)?.title || new URL(state.url).hostname;
  window.bro2.send('shortcut', { url: state.url, title: saved ? '' : title });
});

byId('shortcut-cancel').addEventListener('click', () => shortcutDialog.close());
byId('shortcut-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const url = shortcutAddress(byId('shortcut-url').value);
  const title = byId('shortcut-name').value.trim();
  byId('shortcut-error').hidden = Boolean(url && title);
  if (!url || !title) return;
  window.bro2.send('shortcut', { url, title });
  shortcutDialog.close();
});

function drawShortcuts(shortcuts) {
  const signature = JSON.stringify(shortcuts);
  if (signature === shortcutSignature) return;
  shortcutSignature = signature;
  const elements = shortcuts.map(({ url, title }) => {
    const item = document.createElement('div');
    const open = document.createElement('button');
    const bubble = document.createElement('span');
    const label = document.createElement('span');
    const remove = document.createElement('button');
    item.className = 'shortcut';
    open.type = remove.type = 'button';
    open.className = 'shortcut-open';
    item.dataset.url = url;
    open.title = `${title} · ${url}`;
    open.setAttribute('aria-label', title);
    bubble.className = 'shortcut-bubble';
    const hostname = new URL(url).hostname.replace(/^www\./i, '');
    bubble.textContent = Array.from(hostname)[0]?.toLocaleUpperCase() || '↗';
    bubble.setAttribute('aria-hidden', 'true');
    label.className = 'shortcut-label';
    label.textContent = title;
    open.append(bubble, label);
    open.addEventListener('click', () => window.bro2.send('go', url));
    remove.className = 'icon shortcut-remove';
    remove.title = 'Удалить ярлык';
    remove.setAttribute('aria-label', `Удалить ярлык ${title}`);
    remove.append(icon('close'));
    remove.addEventListener('click', () => window.bro2.send('shortcut', { url, title: '' }));
    item.append(open, remove);
    return item;
  });
  if (shortcuts.length < 12) {
    const add = document.createElement('button');
    const bubble = document.createElement('span');
    const label = document.createElement('span');
    add.type = 'button';
    add.className = 'shortcut shortcut-open';
    bubble.className = 'shortcut-bubble';
    bubble.append(icon('plus'));
    label.textContent = 'Добавить';
    add.setAttribute('aria-label', 'Добавить ярлык');
    add.title = 'Добавить ярлык';
    add.append(bubble, label);
    add.addEventListener('click', () => {
      byId('shortcut-form').reset();
      byId('shortcut-error').hidden = true;
      shortcutDialog.showModal();
    });
    elements.push(add);
  }
  byId('shortcuts').replaceChildren(...elements);
}

const wordmark = document.querySelector('.wordmark');
let animationFrame = 0;
let x = 0;
let y = 0;
let targetX = 0;
let targetY = 0;
function animateWordmark() {
  x += (targetX - x) * .17;
  y += (targetY - y) * .17;
  if (Math.abs(targetX - x) + Math.abs(targetY - y) < .05) { x = targetX; y = targetY; }
  wordmark.style.transform = `perspective(740px) translate3d(${x}px, ${y}px, 0) rotateX(${-y * .42}deg) rotateY(${x * .42}deg)`;
  animationFrame = x === targetX && y === targetY ? 0 : requestAnimationFrame(animateWordmark);
}
function resetWordmark() {
  targetX = targetY = 0;
  if (!animationFrame && (x || y)) animationFrame = requestAnimationFrame(animateWordmark);
}
const wordmarkArea = wordmark.parentElement;
wordmarkArea.addEventListener('pointermove', (event) => {
  if (!moving() || byId('home').hidden || event.pointerType === 'touch') return;
  const { width, height, left, top } = wordmarkArea.getBoundingClientRect();
  targetX = ((event.clientX - left) / width - .5) * 22;
  targetY = ((event.clientY - top) / height - .5) * 16;
  if (!animationFrame) animationFrame = requestAnimationFrame(animateWordmark);
});
wordmarkArea.addEventListener('pointerleave', resetWordmark);
function stopWordmark() {
  cancelAnimationFrame(animationFrame);
  animationFrame = x = y = targetX = targetY = 0;
  wordmark.style.removeProperty('transform');
}
function stopMotion() {
  cancelPressAnimations();
  stopWordmark();
}
window.addEventListener('blur', stopWordmark);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopMotion();
});
function updateMotion(settings) {
  if (!settings) return;
  document.documentElement.dataset.motion = settings.motion;
  byId('motion-system').hidden = motionAllowed.matches;
  byId('motion-preview').disabled = !motionAllowed.matches || settings.motion === 'off';
}
byId('motion-preview').addEventListener('click', ({ currentTarget }) => {
  pressAnimations.get(currentTarget)?.cancel();
  if (!motionAllowed.matches || state.settings.motion === 'off') return;
  const frames = [{ backgroundColor: 'var(--accent-fill)' }, { backgroundColor: 'var(--field)' }];
  if (moving()) {
    frames[0].transform = 'translateY(-3px)';
    frames[1].transform = 'translateY(0)';
  }
  pressAnimations.set(currentTarget, currentTarget.animate(frames, { duration: duration('base') * 2, easing: 'ease-out' }));
});

function drawSettings(next) {
  const { settings, settingsOpen, account, status } = next;
  if (!moving(settings)) stopMotion();
  document.documentElement.dataset.theme = settings.theme;
  updateMotion(settings);
  document.documentElement.style.setProperty('--theme-accent', settings.accent);
  byId('accent').value = settings.accent;
  document.querySelectorAll('.swatch').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.value.toLowerCase() === settings.accent.toLowerCase()));
  });
  byId('settings-panel').hidden = !settingsOpen;
  byId('settings').setAttribute('aria-expanded', String(settingsOpen));
  byId('theme').value = settings.theme;
  const engineSelect = byId('search-engine');
  const engineSignature = JSON.stringify(next.searchEngines);
  if (customSearchSignature !== engineSignature) {
    customSearchSignature = engineSignature;
    for (const option of engineSelect.querySelectorAll('option[value^="custom:"]')) option.remove();
    for (const { keyword, name } of next.searchEngines) engineSelect.add(new Option(name, `custom:${keyword}`));
  }
  engineSelect.value = settings.search;
  byId('motion').value = settings.motion;
  const engine = engineSelect.selectedOptions[0]?.textContent || 'Google';
  byId('search').placeholder = `Поиск · ${engine} или адрес сайта`;
  const { configured, profile, busy, signingIn } = account;
  byId('account-description').hidden = Boolean(profile);
  byId('account-description').textContent = configured
    ? 'Вход откроется в браузере Windows.'
    : 'Для входа подключи JSON клиента Google OAuth типа «Приложение для компьютера».';
  byId('account-name').hidden = !profile;
  byId('account-name').textContent = profile?.name ?? '';
  byId('account-email').hidden = !profile;
  byId('account-email').textContent = profile?.email ?? '';
  byId('google-sign-in').hidden = !configured || Boolean(profile) || signingIn;
  byId('google-sign-in').disabled = busy;
  byId('google-sign-out').hidden = !profile;
  byId('google-sign-out').disabled = busy;
  byId('google-cancel').hidden = !signingIn;
  byId('google-import').hidden = Boolean(profile) || signingIn;
  byId('google-import').disabled = busy;
  byId('google-import').querySelector('span').textContent = configured ? 'Заменить OAuth-клиент' : 'Подключить OAuth-клиент';
  byId('google-setup').hidden = configured;
  byId('settings-status').hidden = !status;
  byId('settings-status').textContent = status;
  if (settingsOpen && !state?.settingsOpen) byId('settings-close').focus();
  if (!settingsOpen && state?.settingsOpen && document.activeElement === document.body) byId('settings').focus();
}

window.bro2.onState((next) => {
  drawSettings(next);
  const tabs = JSON.stringify([next.active, next.verticalTabs, next.tabs]);
  if (tabs !== tabSignature) {
    tabSignature = tabs;
    drawTabs(next);
  }
  drawShortcuts(next.shortcuts);
  if (state?.active !== next.active || (state?.settingsOpen !== next.settingsOpen)) {
    editingAddress = false;
    closeSuggestions();
  }
  const shownAddress = next.settingsOpen ? 'bro2://settings' : next.url;
  if (!editingAddress && address.value !== shownAddress) address.value = shownAddress;
  byId('back').disabled = !next.back;
  byId('forward').disabled = !next.forward;
  reload.disabled = !next.url && !next.loading;
  setIcon(reload, next.loading ? 'stop' : 'reload');
  reload.title = next.loading ? 'Остановить загрузку (Esc)' : 'Обновить (Ctrl+R или F5)';
  reload.setAttribute('aria-label', next.loading ? 'Остановить загрузку' : 'Обновить');
  reload.setAttribute('aria-keyshortcuts', next.loading ? 'Escape' : 'Control+R F5');
  byId('home').hidden = next.settingsOpen || Boolean(next.toolPage || next.url || next.error);
  byId('failure').hidden = next.settingsOpen || Boolean(next.toolPage) || !next.error;
  document.body.classList.toggle('site', !next.settingsOpen && !next.toolPage && Boolean(next.url) && !next.error);
  setIcon(byId('address-icon'), next.error ? 'warning' : next.url.startsWith('chrome-extension:') ? 'puzzle' :
    next.url.startsWith('https:') ? 'lock' : next.url ? 'globe' : 'search');
  const pinned = next.shortcuts.some((entry) => entry.url === next.url);
  const pin = byId('pin');
  pin.hidden = next.privateMode || !/^https?:/.test(next.url) || next.error || next.settingsOpen ||
    Boolean(next.toolPage) || (!pinned && next.shortcuts.length >= 12);
  pin.setAttribute('aria-pressed', String(pinned));
  pin.title = pinned ? 'Удалить ярлык' : 'Добавить ярлык';
  pin.setAttribute('aria-label', pin.title);
  if (byId('home').hidden || !moving(next.settings)) stopWordmark();
  byId('error').textContent = next.error;
  state = next;
});
