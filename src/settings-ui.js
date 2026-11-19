(() => {
  const panel = byId('settings-panel');
  const nav = byId('settings-nav');
  const query = byId('settings-query');
  const categoryHeading = byId('settings-category');
  const results = byId('settings-results');
  const list = byId('settings-result-list');
  const sections = [
    ['profiles', 'Профили', 'user', ['local-profile-settings', '.account']],
    ['appearance', 'Внешний вид', 'palette', ['appearance-settings']],
    ['new-tab', 'Новая вкладка', 'tab', ['new-tab-settings']],
    ['search', 'Поисковая система', 'search', ['search-settings', 'custom-search-settings']],
    ['startup', 'Запуск', 'enter', ['startup-settings', 'windows-settings']],
    ['performance', 'Производительность', 'motion', ['memory-settings']],
    ['privacy', 'Конфиденциальность', 'lock', ['privacy-settings']],
    ['passwords', 'Пароли и импорт', 'key', ['password-settings', 'chrome-import']],
    ['downloads', 'Загрузки', 'download', ['download-settings']],
    ['extensions', 'Расширения', 'puzzle', ['extension-settings']],
    ['languages', 'Языки', 'globe', ['spell-settings', 'translation-settings']],
    ['about', 'О браузере', 'settings', ['#about-title']],
  ].map(([id, title, glyph, selectors]) => ({
    id, title, glyph, groups: selectors.map((name) => (byId(name) || panel.querySelector(name)).closest('.settings-group')),
  }));
  const descriptions = {
    theme: 'Светлая, тёмная или системная тема Windows.',
    motion: 'Интенсивность эффектов и переходов интерфейса.',
    accents: 'Цвет активных вкладок, кнопок и элементов управления.',
    'search-engine': 'Поисковая система для адресной строки и новой вкладки.',
    'memory-saver': 'Освобождать память при длительном простое фоновых вкладок.',
    'memory-idle': 'Сколько времени фоновая вкладка может оставаться без внимания.',
    'memory-exceptions': 'Домены и поддомены, которые BrO2 оставляет в памяти.',
    'startup-mode': 'Новая вкладка, предыдущий сеанс или выбранные страницы.',
    'download-prompt': 'Показывать выбор места перед сохранением файла.',
    'password-offers': 'Предлагать сохранить пароль после входа на сайт.',
    'spell-enable': 'Подчёркивать опечатки при вводе текста на сайтах.',
    'settings-site-permissions': 'Управлять доступом к камере, микрофону, уведомлениям и местоположению.',
    'settings-clear-data': 'Выбрать период и типы данных для удаления.',
    'settings-history': 'Найти посещённые страницы или удалить отдельные записи.',
  };
  let section = 'appearance';
  let privateMode;
  let highlighted;
  let transition = [];
  function stopTransition() {
    transition.forEach((animation) => animation.cancel());
    transition = [];
  }
  motionAllowed.addEventListener('change', stopTransition);
  const searchable = [];
  for (const category of sections) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'settings-nav-item';
    button.dataset.category = category.id;
    button.append(icon(category.glyph), category.title);
    button.addEventListener('click', () => open(category.id));
    nav.append(button);
    for (const group of category.groups) {
      group.dataset.category = category.id;
      const heading = group.querySelector(':scope > :is(h2, summary)');
      let targets = [...group.querySelectorAll(':scope > .setting-row, :scope > form > label, :scope > .vault-actions > button, :scope > button')];
      if (!targets.length || group.tagName === 'DETAILS') targets.unshift(heading);
      for (const target of targets.filter(Boolean)) {
        const labels = target.querySelector(':scope > span');
        const title = (labels?.textContent || [...target.childNodes].filter(({ nodeType }) => nodeType === Node.TEXT_NODE)
          .map(({ textContent }) => textContent.trim()).filter(Boolean).join(' ') || target.textContent).trim();
        const control = target.control || target.querySelector('button, select, input, #accents');
        const description = descriptions[control?.id] ?? '';
        if (description && labels) {
          const subtitle = document.createElement('small');
          subtitle.className = 'setting-description';
          subtitle.textContent = description;
          labels.append(subtitle);
        }
        searchable.push({ category, group, target, title, description, words: (title + ' ' + description + ' ' +
          (target === heading ? group.querySelector(':scope > p')?.textContent || '' : '')).toLocaleLowerCase('ru') });
      }
    }
  }

  function available(category) { return category.groups.some((group) => !group.hidden); }
  function update() {
    const searching = Boolean(query.value.trim());
    results.hidden = !searching;
    categoryHeading.textContent = searching ? 'Результаты поиска' : sections.find(({ id }) => id === section).title;
    for (const category of sections) {
      const selected = category.id === section && !searching;
      const button = nav.querySelector('[data-category="' + category.id + '"]');
      button.hidden = !available(category);
      if (selected) button.setAttribute('aria-current','page');
      else button.removeAttribute('aria-current');
      for (const group of category.groups) group.classList.toggle('filtered-setting', !selected);
    }
  }

  function open(id, entry) {
    const changed = id !== section || !results.hidden;
    query.value = '';
    section = id;
    highlighted?.classList.remove('setting-highlight');
    highlighted = undefined;
    update();
    panel.parentElement.scrollTop = 0;
    if (changed) {
      stopTransition();
      if (!panel.hidden && moving()) {
        const cards = sections.find((category) => category.id === id).groups.filter((group) => !group.hidden);
        transition = [categoryHeading, ...cards].map((element, index) => element.animate([
          { opacity: 0, translate: `0 ${state.settings.motion === 'expressive' ? 11 : 6}px` },
          { opacity: 1, translate: '0 0' },
        ], { duration: duration('base'), delay: Math.min(index, 3) * 24,
          easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'backwards' }));
      }
    }
    if (!entry) return;
    if (entry.group.tagName === 'DETAILS') entry.group.open = true;
    highlighted = entry.target;
    highlighted.classList.add('setting-highlight');
    highlighted.scrollIntoView({ block: 'nearest' });
    const focus = highlighted.matches('summary,button') ? highlighted : highlighted.querySelector('input,select,button');
    if (focus) focus.focus({ preventScroll: true });
    else {
      highlighted.tabIndex = -1;
      highlighted.focus({ preventScroll: true });
    }
  }

  query.addEventListener('input', () => {
    stopTransition();
    const words = query.value.trim().toLocaleLowerCase('ru').split(/\s+/).filter(Boolean);
    const entries = words.length ? searchable.filter(({ group, words: haystack }) => !group.hidden &&
      words.every((word) => haystack.includes(word))) : [];
    list.replaceChildren(...entries.map((entry) => {
      const row = document.createElement('li');
      const button = document.createElement('button');
      button.className = 'settings-result';
      button.type = 'button';
      const text = document.createElement('span');
      text.textContent = entry.title;
      const sub = document.createElement('small');
      sub.textContent = entry.description || entry.category.title;
      text.append(sub);
      button.append(icon(entry.category.glyph), text, icon('forward'));
      button.addEventListener('click', () => open(entry.category.id, entry));
      row.append(button);
      return row;
    }));
    byId('settings-no-results').hidden = entries.length > 0;
    update();
  });
  query.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      const first = list.querySelector('button');
      if (first) { event.preventDefault(); first.focus(); }
    }
    if (event.key === 'Enter' && !event.isComposing && !results.hidden) list.querySelector('button')?.click();
  });
  list.addEventListener('keydown', (event) => {
    if (!['ArrowUp','ArrowDown'].includes(event.key)) return;
    const current = event.target.closest('li');
    const next = event.key === 'ArrowUp' ? current?.previousElementSibling : current?.nextElementSibling;
    if (current && (next || event.key === 'ArrowUp')) {
      event.preventDefault();
      (next?.querySelector('button') || query).focus();
    }
  });
  for (const button of panel.querySelectorAll('[data-setting-tool]')) button.addEventListener('click', () =>
    window.bro2.send('settings-tool', button.dataset.settingTool));
  byId('settings-customize-home').addEventListener('click', () => window.bro2.send('settings-customize-home'));
  window.bro2.onState((next) => {
    if (!next.settingsOpen || !moving(next.settings)) stopTransition();
    byId('new-tab-settings').hidden = byId('extension-settings').hidden = next.privateMode;
    if (privateMode !== next.privateMode || next.settingsOpen && panel.dataset.open !== 'true') {
      privateMode = next.privateMode;
      if (!available(sections.find(({ id }) => id === section))) section = 'appearance';
      open(section);
    }
    panel.dataset.open = String(next.settingsOpen);
  });
})();
