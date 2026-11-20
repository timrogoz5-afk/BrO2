(() => {
  const { homeLayout, names, wallpaperNames, accents, fields, minimum, maxHeight, canvasWidth, gridStep, maxY, clamp, feedURL } = window.homeModel;
  const defaults = homeLayout();
  const home = byId('home');
  const grid = byId('home-grid');
  const viewport = byId('home-viewport');
  const main = home.parentElement;
  const stage = byId('home-editor');
  const dialog = byId('home-options');
  const wallPicker = byId('home-wallpapers');
  const widgetPicker = byId('home-widgets');
  const panel = byId('tile-options');
  const settings = byId('tile-options-fields');
  const themeControl = byId('home-theme');
  const snapControl = byId('home-snap');
  const tiles = new Map([...grid.children].map((tile) => [tile.dataset.widget, tile]));
  grid.style.setProperty('--grid-cell-width', (gridStep / canvasWidth * 100) + '%');
  grid.style.setProperty('--grid-cell-height', gridStep + 'px');
  const wideTile = 900;
  let saved = defaults;
  let draft;
  let preview = false;
  let selected;
  let nextState;
  let signature;

  const config = () => draft || saved;
  const editing = () => Boolean(draft && !preview);
  const settingsOpen = () => panel.matches(':popover-open');
  const widgets = window.setupHomeWidgets({ home, main, tiles, config, getState: () => nextState });

  function position(id, { x, y, w, h }) {
    const element = tiles.get(id);
    element.toggleAttribute('data-wide', w >= wideTile);
    element.style.setProperty('--tile-x', (x / canvasWidth * 100) + '%');
    element.style.setProperty('--tile-y', y + 'px');
    element.style.setProperty('--tile-w', (w / canvasWidth * 100) + '%');
    element.style.setProperty('--tile-h', h + 'px');
  }

  function boardHeight() {
    const layout = config();
    const bottom = Math.max(0, ...Object.values(layout.tiles).filter((tile) => tile.enabled).map(({ y, h }) => y + h));
    let editorRoom = bottom;
    if (editing()) {
      const { paddingTop, paddingBottom } = getComputedStyle(main);
      const available = main.clientHeight - parseFloat(paddingTop) - parseFloat(paddingBottom) -
        stage.offsetHeight - parseFloat(getComputedStyle(stage).marginBottom);
      editorRoom = Math.max(bottom + 145, available, 390);
    }
    grid.style.setProperty('--board-height', Math.min(editorRoom, maxY + maxHeight) + 'px');
  }

  function updateDensity() {
    home.toggleAttribute('data-compact', main.offsetWidth <= 1100 || main.offsetHeight <= 620);
  }

  function raise(id) {
    const order = draft.order;
    if (order.at(-1) === id) return;
    draft.order = [...order.filter((item) => item !== id), id];
    setLayers();
  }

  function setLayers() {
    config().order.forEach((id, i) => tiles.get(id).style.zIndex = i + 1);
  }

  const drag = window.setupTileDrag({
    grid, viewport, main, editing, snap: () => draft.snapToGrid, read: (id) => draft.tiles[id], raise,
    place(id, { x, y, w, h }) {
      const tile = draft.tiles[id];
      Object.assign(tile, { x, y, w, h });
      position(id, tile);
    },
    finish(id) {
      boardHeight();
      if (!draft) return;
      const { x, y, w, h, title } = draft.tiles[id];
      if (selected === id && settingsOpen()) {
        for (const field of settings.querySelectorAll('[data-dimension]')) field.value = Math.round(draft.tiles[id][field.dataset.dimension]);
      }
      byId('home-announcement').textContent = `${title} · ${Math.round(x)}, ${Math.round(y)} · ${Math.round(w)} × ${Math.round(h)}`;
    },
  });

  for (const [id, name] of Object.entries(names)) {
    const tile = tiles.get(id);
    const controls = document.createElement('div');
    controls.className = 'tile-controls';
    for (const [mode, label, glyph] of [
      ['move', 'Переместить', 'move'], ['size', 'Изменить размер', 'resize'], ['options', 'Настройки блока', 'settings'],
    ]) {
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'icon tile-' + mode;
      handle.dataset.label = label;
      handle.setAttribute('aria-label', label + ' · ' + name);
      handle.title = label + ' · ' + name;
      handle.append(icon(glyph));
      if (mode === 'options') {
        handle.setAttribute('aria-haspopup', 'dialog');
        handle.setAttribute('aria-controls', panel.id);
        handle.addEventListener('click', () => openSettings(id));
      } else {
        handle.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown ArrowLeft ArrowRight');
        drag.attach(handle, tile, id, mode);
      }
      controls.append(handle);
    }
    tile.append(controls);

    const entry = document.createElement('div');
    const label = document.createElement('label');
    const check = document.createElement('input');
    const title = document.createElement('span');
    const options = document.createElement('button');
    check.type = 'checkbox';
    check.dataset.homeToggle = id;
    title.textContent = name;
    options.type = 'button';
    options.className = 'icon';
    options.title = 'Настройки блока · ' + name;
    options.setAttribute('aria-label', options.title);
    options.append(icon('settings'));
    check.addEventListener('change', () => {
      draft.tiles[id].enabled = check.checked;
      render();
    });
    options.addEventListener('click', () => {
      dialog.close();
      openSettings(id);
    });
    label.append(check, title);
    entry.className = 'widget-picker-entry';
    entry.append(label, options);
    widgetPicker.append(entry);
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

  function renderTile(id) {
    const el = tiles.get(id);
    const tile = config().tiles[id];
    el.hidden = !tile.enabled;
    el.dataset.accent = tile.accent;
    const title = el.querySelector('[data-tile-title]');
    title.textContent = tile.title || names[id];
    if (id === 'logo' || id === 'search') title.hidden = !tile.fields.title;
    if (id === 'date') el.setAttribute('aria-label', title.textContent);
    for (const button of el.querySelectorAll('.tile-controls button')) {
      const label = button.dataset.label + ' · ' + title.textContent;
      button.title = label;
      button.setAttribute('aria-label', label);
      if (button.matches('.tile-options')) button.setAttribute('aria-expanded', String(selected === id && settingsOpen()));
    }
    position(id, tile);
  }

  function readingOrder(layout) {
    const cards = [...tiles.keys()].filter((id) => id !== 'logo' && id !== 'search' && layout.tiles[id].enabled)
      .sort((a, b) => layout.tiles[a].y - layout.tiles[b].y || layout.tiles[a].x - layout.tiles[b].x);
    for (let i = 0; i + 1 < cards.length; i++) {
      const first = layout.tiles[cards[i]];
      const second = layout.tiles[cards[i + 1]];
      if (first.w >= wideTile || second.w >= wideTile) continue;
      if (second.y < first.y + first.h && second.x < first.x) [cards[i], cards[i + 1]] = [cards[i + 1], cards[i]];
      i++;
    }
    return cards;
  }

  function render() {
    const layout = config();
    updateDensity();
    home.classList.toggle('is-editing', editing());
    if (!home.hidden) {
      home.toggleAttribute('data-default-layout', Object.entries(defaults.tiles).every(([id, tile]) => {
        const current = layout.tiles[id];
        return current.enabled === tile.enabled && (!tile.enabled ||
          ['x', 'y', 'w', 'h'].every((key) => current[key] === tile[key]));
      }));
      for (const id of tiles.keys()) renderTile(id);
      readingOrder(layout).forEach((id, i) => tiles.get(id).style.setProperty('--tile-order', i));
      setLayers();
    }
    window.applyWallpaper(layout.wallpaper);
    stage.hidden = !draft;
    boardHeight();
    byId('home-preview').textContent = preview ? 'Вернуться к редактированию' : 'Предпросмотр';
    byId('home-options-open').hidden = !editing();
    snapControl.hidden = !editing();
    snapControl.setAttribute('aria-pressed', String(layout.snapToGrid));
    grid.toggleAttribute('data-snap', editing() && layout.snapToGrid);
    byId('customize').hidden = home.hidden || Boolean(nextState?.privateMode) || Boolean(draft);
    if (dialog.open) {
      for (const checkbox of widgetPicker.querySelectorAll('input')) {
        const tile = layout.tiles[checkbox.dataset.homeToggle];
        checkbox.checked = tile.enabled;
        const entry = checkbox.closest('.widget-picker-entry');
        entry.querySelector('label span').textContent = tile.title;
        entry.querySelector('button').disabled = !tile.enabled;
      }
      for (const button of wallPicker.children) button.setAttribute('aria-pressed', String(button.dataset.wallpaper === layout.wallpaper));
    }
    widgets.render();
  }

  const extraOptions = {
    clock: [
      ['clockFormat', 'Формат времени', { 24: '24 часа', 12: '12 часов' }],
      ['clock', 'Стиль часов', { digital: 'Цифровые', 'digital-compact': 'Цифровые компактные', analog: 'Со стрелками', 'analog-dial': 'Со стрелками и делениями' }],
    ],
    shortcuts: [
      ['shortcutSize', 'Размер ярлыков', { small: 'Маленький', medium: 'Средний', large: 'Большой' }],
      ['shortcutShape', 'Форма ярлыков', { soft: 'Скруглённая', circle: 'Круглая', square: 'Квадратная' }],
      ['shortcutIcon', 'Значки ярлыков', 'checkbox'],
      ['shortcutTitle', 'Названия ярлыков', 'checkbox'],
    ],
    weather: [['city', 'Город', 'text', 'Москва', 100]],
    news: [['news', 'Раздел BBC News', { technology: 'Технологии', world: 'Мир' }]],
    feed: [['feed', 'Адрес RSS или Atom', 'url', 'https://example.com/feed.xml', 2048]],
  };

  function control(label, value, type, update, event = 'change') {
    const row = document.createElement('label');
    const caption = document.createElement('span');
    caption.textContent = label;
    let input;
    if (typeof type === 'object') {
      input = document.createElement('select');
      for (const [key, title] of Object.entries(type)) input.add(new Option(title, key));
    } else {
      input = document.createElement('input');
      input.type = type;
    }
    if (type === 'checkbox') {
      row.className = 'tile-switch';
      input.setAttribute('role', 'switch');
      input.checked = value;
    } else input.value = value;
    input.addEventListener(event, () => update(type === 'checkbox' ? input.checked : input.value, input));
    row.append(caption, input);
    return { row, input };
  }

  function drawShortcutOrder(container) {
    const shortcuts = nextState?.shortcuts || [];
    const items = new Map(shortcuts.map((entry) => [entry.url, entry.title]));
    const ordered = [...new Set([...draft.shortcutOrder.filter((url) => items.has(url)), ...items.keys()])];
    if (ordered.length < 2) return;
    const list = document.createElement('ol');
    list.id = 'home-shortcut-order';
    list.className = 'vault-list';
    list.setAttribute('aria-label', 'Порядок ярлыков');
    for (const [index, url] of ordered.entries()) {
      const item = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = items.get(url);
      item.append(span);
      for (const delta of [-1, 1]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'icon';
        button.setAttribute('aria-label', (delta < 0 ? 'Поднять · ' : 'Опустить · ') + span.textContent);
        button.disabled = !ordered[index + delta];
        button.append(icon(delta < 0 ? 'up' : 'down'));
        button.addEventListener('click', () => {
          [ordered[index], ordered[index + delta]] = [ordered[index + delta], ordered[index]];
          draft.shortcutOrder = ordered;
          list.remove();
          drawShortcutOrder(container);
          byId(list.id).children[index + delta].querySelector('button:enabled')?.focus();
          widgets.render();
        });
        item.append(button);
      }
      list.append(item);
    }
    container.append(list);
  }

  function drawSettings(id) {
    const tile = draft.tiles[id];
    function updateTitle() { byId('tile-options-title').textContent = tile.title || names[id]; }
    updateTitle();
    const title = control('Название', tile.title, 'text', (value) => {
      tile.title = value;
      if ((id === 'logo' || id === 'search') && !tile.fields.title && value.trim() !== names[id]) {
        tile.fields.title = true;
        settings.querySelector('[data-tile-field="title"]').checked = true;
      }
      updateTitle();
      renderTile(id);
    }, 'input');
    title.input.maxLength = 64;
    title.input.placeholder = names[id];
    title.input.addEventListener('change', () => { tile.title = title.input.value = title.input.value.trim() || names[id]; updateTitle(); renderTile(id); });
    title.input.autofocus = true;
    const dimensions = document.createElement('div');
    dimensions.className = 'tile-dimensions';
    for (const [key, label, min, max] of [
      ['w', 'Ширина (px)', minimum[id][0], canvasWidth], ['h', 'Высота (px)', minimum[id][1], maxHeight],
    ]) {
      const applySize = (value) => {
        tile[key] = clamp(value, min, max);
        tile.x = Math.min(tile.x, canvasWidth - tile.w);
        position(id, tile);
        boardHeight();
      };
      const { row, input } = control(label, Math.round(tile[key]), 'number', (value, field) => {
        if (field.validity.valid && value !== '') applySize(field.valueAsNumber);
      }, 'input');
      input.dataset.dimension = key;
      input.min = min;
      input.max = max;
      input.required = true;
      input.addEventListener('change', () => {
        if (Number.isFinite(input.valueAsNumber)) applySize(input.valueAsNumber);
        input.value = Math.round(tile[key]);
      });
      dimensions.append(row);
    }
    const accent = control('Цветовой акцент', tile.accent, accents, (value) => { tile.accent = value; renderTile(id); });
    const details = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = 'Отображаемые поля';
    details.append(legend);
    for (const [key, label] of Object.entries(fields[id])) {
      const { row, input } = control(label, tile.fields[key], 'checkbox', (value) => {
        tile.fields[key] = value;
        renderTile(id);
        widgets.render();
      });
      input.dataset.tileField = key;
      details.append(row);
    }
    settings.replaceChildren(title.row, dimensions, accent.row, details);
    for (const [key, label, type, placeholder, maxLength] of extraOptions[id] || []) {
      const { row, input } = control(label, draft[key], type, (value, field) => {
        if (key === 'feed' && value.trim() && !feedURL(value.trim())) {
          field.setCustomValidity('Введите полный адрес ленты, начиная с http:// или https://.');
          field.reportValidity();
          return;
        }
        field.setCustomValidity('');
        draft[key] = typeof value === 'string' ? value.trim() : value;
        widgets.render();
      });
      input.dataset.homeField = key;
      if (placeholder) input.placeholder = placeholder;
      if (maxLength) input.maxLength = maxLength;
      input.addEventListener('input', () => input.setCustomValidity(''));
      settings.append(row);
    }
    if (id === 'shortcuts') drawShortcutOrder(settings);
  }

  function positionPanel() {
    const top = Math.max(8, stage.getBoundingClientRect().bottom + 8);
    const tile = tiles.get(selected).getBoundingClientRect();
    const onRight = tile.left + tile.width / 2 > innerWidth / 2;
    panel.style.top = top + 'px';
    panel.style.left = onRight ? '12px' : 'auto';
    panel.style.right = onRight ? 'auto' : '12px';
    panel.style.maxHeight = Math.max(100, innerHeight - top - 12) + 'px';
  }

  function openSettings(id) {
    if (!editing() || !draft.tiles[id].enabled) return;
    selected = id;
    raise(id);
    drawSettings(id);
    positionPanel();
    if (!settingsOpen()) panel.showPopover();
    settings.querySelector('input').focus({ preventScroll: true });
    for (const key of tiles.keys()) renderTile(key);
  }

  function closeSettings(returnFocus = false) {
    const id = selected;
    selected = undefined;
    if (settingsOpen()) panel.hidePopover();
    if (id) {
      renderTile(id);
      if (returnFocus) tiles.get(id).querySelector('.tile-options').focus();
    }
  }

  function togglePreview() {
    const id = selected;
    if (preview) {
      preview = false;
      render();
      if (id) openSettings(id);
    } else {
      drag.cancel();
      closeSettings();
      selected = id;
      preview = true;
      render();
      byId('home-preview').focus();
    }
  }

  function stopEditing() {
    drag.cancel();
    closeSettings();
    if (dialog.open) dialog.close();
    draft = undefined;
    preview = false;
    render();
  }

  function edit() {
    if (nextState?.privateMode || home.hidden || draft) return;
    draft = homeLayout(saved);
    window.dispatchEvent(new Event('home-edit'));
    render();
    byId('home-options-open').focus({ preventScroll: true });
  }

  byId('customize').addEventListener('click', edit);
  window.bro2.onCustomizeHome(edit);
  themeControl.addEventListener('change', () => window.bro2.send('preference', { key: 'theme', value: themeControl.value }));
  snapControl.addEventListener('click', () => {
    if (!editing()) return;
    draft.snapToGrid = !draft.snapToGrid;
    render();
  });
  byId('home-options-open').addEventListener('click', () => { closeSettings(); dialog.showModal(); render(); });
  byId('home-options-close').addEventListener('click', () => dialog.close());
  byId('home-reset').addEventListener('click', () => { closeSettings(); draft = homeLayout(); render(); });
  byId('home-preview').addEventListener('click', togglePreview);
  byId('tile-options-preview').addEventListener('click', togglePreview);
  byId('tile-options-close').addEventListener('click', () => closeSettings(true));
  byId('tile-options-reset').addEventListener('click', () => {
    const id = selected;
    const { x, y, enabled } = draft.tiles[id];
    const tile = homeLayout().tiles[id];
    draft.tiles[id] = { ...tile, x: Math.min(x, canvasWidth - tile.w), y, enabled };
    for (const [key] of extraOptions[id] || []) draft[key] = defaults[key];
    if (id === 'shortcuts') draft.shortcutOrder = [];
    drawSettings(id);
    render();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !settingsOpen() || dialog.open) return;
    event.preventDefault();
    closeSettings(true);
  });
  const stageObserver = new ResizeObserver(() => {
    updateDensity();
    boardHeight();
    if (settingsOpen()) positionPanel();
  });
  stageObserver.observe(stage);
  stageObserver.observe(main);

  byId('home-cancel').addEventListener('click', () => { stopEditing(); byId('customize').focus(); });
  byId('home-save').addEventListener('click', async () => {
    const button = byId('home-save');
    button.disabled = true;
    try {
      const result = await window.bro2.home('save', draft);
      if (!result.ok) throw new Error(result.message);
      saved = homeLayout(result.layout);
      stopEditing();
      byId('customize').focus();
    } catch { byId('home-announcement').textContent = 'Не удалось сохранить раскладку.'; }
    finally { button.disabled = false; }
  });

  byId('home-chatgpt').addEventListener('click', () => window.bro2.send('open-chatgpt'));
  window.bro2.onState((next) => {
    const changed = nextState?.active !== next.active || nextState?.privateMode !== next.privateMode;
    nextState = next;
    themeControl.value = next.settings.theme;
    if ((home.hidden || changed) && draft) stopEditing();
    const current = JSON.stringify([next.home, next.shortcuts, home.hidden, next.privateMode]);
    if (signature !== current || changed) {
      signature = current;
      saved = homeLayout(next.home);
      render();
    }
    widgets.updateMedia(next.homeMedia);
  });
})();
