(() => {
  const { homeLayout, names, wallpaperNames, minWidths, minHeights } = window.homeModel;
  const home = byId('home');
  const dialog = byId('home-options');
  const grid = byId('home-grid');
  const mainArea = home.parentElement;
  const tiles = new Map([...grid.children].map((tile) => [tile.dataset.widget, tile]));
  const stage = byId('home-editor');
  const wallPicker = byId('home-wallpapers');
  const widgetPicker = byId('home-widgets');
  let saved = homeLayout();
  let draft;
  let preview = false;
  let drag;
  let clockTimer;
  let dataTimer;
  let visible = new Set();
  let nextState;
  let signature;
  const widgetData = new Map();
  const compact = () => grid.clientWidth < 670;
  const editing = () => Boolean(draft && !preview);
  const config = () => draft || saved;
  const dateFormat = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  const timeFormat = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

  for (const [id, title] of Object.entries(names)) {
    const tile = tiles.get(id);
    const controls = document.createElement('div');
    controls.className = 'tile-controls';
    for (const mode of ['move', 'size']) {
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'icon tile-' + mode;
      handle.title = (mode === 'move' ? 'Переместить' : 'Изменить размер') + ' · ' + title + ' · Клавиши со стрелками';
      handle.setAttribute('aria-label', handle.title);
      handle.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown ArrowLeft ArrowRight');
      handle.append(icon(mode === 'move' ? 'move' : 'resize'));
      handle.addEventListener('pointerdown', (event) => startDrag(event, id, mode));
      handle.addEventListener('pointermove', moveDrag);
      for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(event, endDrag);
      handle.addEventListener('keydown', (event) => {
        const delta = { ArrowLeft: [-1,0], ArrowRight: [1,0], ArrowUp: [0,-1], ArrowDown: [0,1] }[event.key];
        if (!delta || !editing()) return;
        event.preventDefault();
        change(id, mode, { ...draft.tiles[id] }, ...delta, true);
      });
      controls.append(handle);
    }
    tile.append(controls);
    const label = document.createElement('label');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.dataset.homeToggle = id;
    check.addEventListener('change', () => { draft.tiles[id].enabled = check.checked; render(); });
    label.append(check, title);
    widgetPicker.append(label);
  }

  for (const [key, name] of Object.entries(wallpaperNames)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'wallpaper-choice';
    button.dataset.wallpaper = key;
    const sample = document.createElement('span');
    sample.className = 'wallpaper-sample';
    button.append(sample, name);
    button.addEventListener('click', () => { draft.wallpaper = key; render(); });
    wallPicker.append(button);
  }

  function packed(layout) {
    const placed = [];
    const ordered = Object.keys(names).filter((id) => layout.tiles[id].enabled).sort((a,b) =>
      layout.tiles[a].y - layout.tiles[b].y || layout.tiles[a].x - layout.tiles[b].x);
    const collides = (a,b) => a.x < b.x+b.w && b.x < a.x+a.w && a.y < b.y+b.h && b.y < a.y+a.h;
    for (const id of ordered) {
      const tile = { id, ...layout.tiles[id] };
      while (placed.some((other) => collides(tile, other))) tile.y++;
      placed.push(tile);
    }
    return placed;
  }

  function layoutTiles() {
    const layout = config();
    for (const [id, tile] of tiles) tile.hidden = !layout.tiles[id].enabled;
    const packedTiles = packed(layout);
    for (const [index, { id, x, y, w, h }] of packedTiles.entries()) {
      const tile = tiles.get(id);
      tile.style.setProperty('--tile-column', x + 1 + ' / span ' + w);
      tile.style.setProperty('--tile-row', y + 1 + ' / span ' + h);
      tile.style.order = index;
      tile.style.setProperty('--tile-compact-size', (h * 33 + 45) + 'px');
      if (drag) continue;
      // Keep the focus order aligned with the responsive visual order.
      const prior = tiles.get(packedTiles[index - 1]?.id);
      if (prior && tile.previousElementSibling !== prior) prior.after(tile);
      else if (!prior && tile !== grid.firstElementChild) grid.prepend(tile);
    }
    mainArea.dataset.homeWallpaper = layout.wallpaper;
    byId('clock-face').dataset.clock = layout.clock;
    const shortcuts = byId('shortcuts');
    shortcuts.dataset.size = layout.shortcutSize;
    shortcuts.dataset.shape = layout.shortcutShape;
    shortcuts.dataset.title = String(layout.shortcutTitle);
    shortcuts.dataset.icon = String(layout.shortcutIcon);
    const ranks = new Map(layout.shortcutOrder.map((url, index) => [url, index]));
    for (const entry of shortcuts.querySelectorAll('[data-url]')) entry.style.order = ranks.get(entry.dataset.url) ?? 20;
  }

  function render() {
    if (!home.hidden) layoutTiles();
    home.classList.toggle('is-editing', editing());
    stage.hidden = !draft;
    byId('home-preview').textContent = preview ? 'Вернуться к редактированию' : 'Предпросмотр';
    byId('home-options-open').hidden = !editing();
    byId('customize').hidden = home.hidden || Boolean(nextState?.privateMode) || Boolean(draft);
    if (dialog.open) {
      const layout = config();
      for (const field of dialog.querySelectorAll('[data-home-field]')) {
        if (field === document.activeElement) continue;
        const value = layout[field.dataset.homeField];
        if (field.type === 'checkbox') field.checked = value;
        else field.value = value;
      }
      for (const checkbox of widgetPicker.querySelectorAll('input')) checkbox.checked = layout.tiles[checkbox.dataset.homeToggle].enabled;
      for (const button of wallPicker.children) button.setAttribute('aria-pressed', String(button.dataset.wallpaper === layout.wallpaper));
      drawShortcutOrder();
    }
    updateVisible();
  }

  function change(id, mode, start, dx, dy, spoken) {
    const before = spoken && moving() ? tiles.get(id).getBoundingClientRect() : null;
    const rect = { ...start };
    if (mode === 'move') {
      rect.x = Math.max(0, Math.min(12 - rect.w, start.x + dx));
      rect.y = Math.max(0, Math.min(39, start.y + dy));
    } else {
      rect.w = Math.max(minWidths[id], Math.min(12 - rect.x, start.w + dx));
      rect.h = Math.max(minHeights[id], Math.min(8, start.h + dy));
    }
    const old = draft.tiles[id];
    if (old.x === rect.x && old.y === rect.y && old.w === rect.w && old.h === rect.h) return;
    draft.tiles[id] = rect;
    const focused = document.activeElement;
    layoutTiles();
    if (spoken && document.activeElement !== focused) focused.focus({ preventScroll: true });
    if (before) {
      const tile = tiles.get(id);
      const after = tile.getBoundingClientRect();
      tile.getAnimations().forEach((animation) => animation.cancel());
      tile.animate([{ transform: 'translate(' + (before.left-after.left) + 'px,' + (before.top-after.top) + 'px)' },
        { transform: 'translate(0,0)' }], { duration: duration('base'), easing: 'cubic-bezier(.2,.85,.3,1.12)' });
    }
    if (spoken) {
      const displayed = packed(draft).find((item) => item.id === id);
      byId('home-announcement').textContent = names[id] + ' · Строка ' + (displayed.y + 1) + ', столбец ' + (displayed.x + 1)
        + ', размер ' + rect.w + ' × ' + rect.h;
    }
  }

  function startDrag(event, id, mode) {
    if (event.button !== 0 || !editing() || drag) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag = { id, mode, pointer: event.pointerId, x: event.clientX,
      y: event.clientY + mainArea.scrollTop, tile: { ...draft.tiles[id] } };
    tiles.get(id).classList.add('tile-dragging');
  }

  function moveDrag(event) {
    if (!drag || drag.pointer !== event.pointerId) return;
    const cell = (grid.clientWidth + 10) / 12;
    const dx = compact() ? 0 : Math.round((event.clientX - drag.x) / cell);
    const dy = Math.round((event.clientY + mainArea.scrollTop - drag.y) / (compact() ? 32 : 66));
    change(drag.id, drag.mode, drag.tile, dx, dy, false);
  }

  function endDrag(event) {
    if (!drag || drag.pointer !== event.pointerId) return;
    tiles.get(drag.id).classList.remove('tile-dragging');
    drag = undefined;
    if (editing() && !home.hidden) layoutTiles();
  }

  function edit() {
    if (nextState?.privateMode || home.hidden) return;
    draft = homeLayout(saved);
    preview = false;
    render();
    byId('home-options-open').focus();
  }

  byId('customize').addEventListener('click', edit);
  window.bro2.onCustomizeHome(edit);
  byId('home-options-open').addEventListener('click', () => { dialog.showModal(); render(); });
  byId('home-options-close').addEventListener('click', () => dialog.close());
  byId('home-reset').addEventListener('click', () => { draft = homeLayout(); render(); });
  byId('home-preview').addEventListener('click', () => { preview = !preview; render(); });
  byId('home-cancel').addEventListener('click', () => { draft = undefined; render(); byId('customize').focus(); });
  byId('home-save').addEventListener('click', async () => {
    const button = byId('home-save');
    button.disabled = true;
    try {
      const result = await window.bro2.home('save', draft);
      if (!result.ok) { byId('home-announcement').textContent = result.message; return; }
      saved = homeLayout(result.layout);
      draft = undefined;
      render();
      byId('customize').focus();
    } catch { byId('home-announcement').textContent = 'Не удалось сохранить раскладку.'; }
    finally { button.disabled = false; }
  });

  for (const field of dialog.querySelectorAll('[data-home-field]')) {
    field.addEventListener('change', () => {
      const key = field.dataset.homeField;
      if (key === 'feed' && field.value && !window.homeModel.feedURL(field.value)) {
        field.setCustomValidity('Укажи полный адрес RSS или Atom, начиная с http:// или https://.');
        field.reportValidity();
        return;
      }
      field.setCustomValidity('');
      draft[key] = field.type === 'checkbox' ? field.checked : field.value.trim();
      render();
    });
  }

  function drawShortcutOrder() {
    const order = draft.shortcutOrder.filter((url) => nextState.shortcuts.some((entry) => entry.url === url));
    for (const { url } of nextState.shortcuts) if (!order.includes(url)) order.push(url);
    const container = byId('home-shortcut-order');
    const current = JSON.stringify(order);
    if (container.dataset.order === current) return;
    container.dataset.order = current;
    container.replaceChildren(...order.map((url, index) => {
      const title = nextState.shortcuts.find((entry) => entry.url === url).title;
      const row = document.createElement('li');
      const text = document.createElement('span');
      text.textContent = title;
      row.append(text);
      for (const delta of [-1, 1]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'icon';
        button.setAttribute('aria-label', (delta < 0 ? 'Поднять ' : 'Опустить ') + title);
        button.disabled = !order[index + delta];
        button.append(icon(delta < 0 ? 'up' : 'down'));
        button.addEventListener('click', () => {
          [order[index], order[index+delta]] = [order[index+delta], order[index]];
          draft.shortcutOrder = order;
          render();
          const moved = container.children[index+delta];
          (moved.querySelector('button:enabled') || dialog).focus();
        });
        row.append(button);
      }
      return row;
    }));
  }

  function tickClock() {
    clearTimeout(clockTimer);
    if (document.hidden || home.hidden || !(visible.has('clock') || visible.has('date'))) return;
    const now = new Date();
    byId('clock-value').textContent = timeFormat.format(now);
    byId('date-value').textContent = dateFormat.format(now);
    const face = byId('clock-face');
    face.style.setProperty('--hour', ((now.getHours() % 12) * 30 + now.getMinutes() / 2) + 'deg');
    face.style.setProperty('--minute', (now.getMinutes() * 6) + 'deg');
    clockTimer = setTimeout(tickClock, 60_030 - (now.getSeconds() * 1000 + now.getMilliseconds()));
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const key = entry.target.dataset.widget;
      if (entry.isIntersecting) visible.add(key);
      else visible.delete(key);
    }
    updateVisible();
  }, { root: mainArea });
  for (const [id, tile] of tiles) if (!['logo','search','shortcuts'].includes(id)) observer.observe(tile);
  document.addEventListener('visibilitychange', updateVisible);
  window.addEventListener('online', () => { widgetData.clear(); updateVisible(); });
  window.addEventListener('offline', updateVisible);

  function entriesFromFeed(xml, source) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Источник вернул некорректную ленту.');
    return [...doc.querySelectorAll('item, entry')].slice(0, 12).flatMap((item) => {
      const title = item.querySelector('title')?.textContent.trim().slice(0, 240);
      const node = item.querySelector('link[rel="alternate"],link:not([rel])');
      const raw = node?.getAttribute('href') || node?.textContent.trim();
      if (!title || !raw) return [];
      try {
        const url = window.homeModel.feedURL(new URL(raw, source).href);
        return url ? [{ title, url }] : [];
      } catch { return []; }
    }).slice(0, 7);
  }

  function presentData(kind, data) {
    const output = byId('widget-' + kind);
    if (kind === 'weather') {
      const weatherDescription = data.code === 0 ? 'Ясно' : data.code <= 3 ? 'Облачно' : data.code <= 48 ? 'Туман' :
        data.code <= 67 ? 'Осадки' : data.code <= 77 ? 'Снег' : data.code <= 86 ? 'Ливень' : 'Гроза';
      const strong = document.createElement('strong');
      strong.textContent = data.temperature + '°';
      const details = document.createElement('span');
      details.textContent = [data.city, weatherDescription, data.stale && 'Последние данные'].filter(Boolean).join(' · ');
      output.replaceChildren(strong, details);
      return;
    }
    const links = entriesFromFeed(data.text, data.url).map(({ title, url }) => {
      const link = document.createElement('button');
      link.className = 'home-feed-link';
      link.type = 'button';
      link.textContent = link.title = title;
      link.addEventListener('click', () => window.bro2.send('open-widget-link', url));
      return link;
    });
    output.replaceChildren(...(data.stale ? ['Последние сохранённые данные', ...links] :
      links.length ? links : ['В ленте пока нет записей.']));
  }

  function updateVisible() {
    tickClock();
    clearTimeout(dataTimer);
    if (document.hidden || home.hidden || nextState?.privateMode) return;
    let refreshAt = Infinity;
    for (const kind of ['weather','news','feed']) {
      if (!visible.has(kind) || !config().tiles[kind].enabled) continue;
      const value = config()[kind === 'weather' ? 'city' : kind];
      const output = byId('widget-' + kind);
      const previous = widgetData.get(kind);
      if (previous?.value === value && previous.until > Date.now()) {
        refreshAt = Math.min(refreshAt, previous.until);
        continue;
      }
      if (!value) {
        output.textContent = kind === 'weather' ? 'Выбери город в настройках виджета.' : 'Добавь адрес RSS или Atom в настройках виджета.';
        widgetData.delete(kind);
        continue;
      }
      if (!navigator.onLine) {
        if (!previous?.ready) output.textContent = 'Нет подключения к интернету.';
        continue;
      }
      const request = { value, until: Date.now() + 60_000 };
      widgetData.set(kind, request);
      if (!previous?.ready || previous.value !== value) output.textContent = 'Загрузка…';
      void window.bro2.home('data', { kind, value }).then((result) => {
        if (widgetData.get(kind) !== request) return;
        if (!result.ok) throw new Error(result.message);
        presentData(kind, result.data);
        request.ready = true;
        request.until = Date.now() + 15 * 60_000;
      }).catch((error) => {
        if (widgetData.get(kind) === request) output.textContent = error.message || 'Источник недоступен.';
      }).finally(updateVisible);
    }
    if (Number.isFinite(refreshAt)) dataTimer = setTimeout(updateVisible, Math.max(100, refreshAt - Date.now()));
  }

  for (const button of document.querySelectorAll('[data-home-media]')) button.addEventListener('click', async () => {
    const result = await window.bro2.home('media', button.dataset.homeMedia);
    byId('widget-media').textContent = result.title || result.message;
  });
  byId('home-chatgpt').addEventListener('click', () => window.bro2.send('open-chatgpt'));
  window.bro2.onState((next) => {
    const changed = nextState?.active !== next.active || nextState?.privateMode !== next.privateMode;
    nextState = next;
    byId('customize').hidden = home.hidden || next.privateMode || Boolean(draft);
    const current = JSON.stringify([next.home, next.shortcuts, home.hidden, next.privateMode]);
    if (home.hidden || changed) {
      if (dialog.open) dialog.close();
      draft = undefined;
    }
    if (signature !== current || changed) {
      signature = current;
      saved = homeLayout(next.home);
      render();
    }
  });
})();
