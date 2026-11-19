(() => {
  const { feedURL } = window.homeModel;
  const fullDate = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  const publicationDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const dateFormats = new Map();
  const pad = (value) => String(value).padStart(2, '0');
  const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };

  function node(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  function parseFeed(xml, base) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('В источнике некорректная лента.');
    const channel = doc.querySelector('channel, feed');
    const text = (parent, selector) => parent?.querySelector(selector)?.textContent.trim() || '';
    const source = text(channel, ':scope > title').slice(0, 120) || new URL(base).hostname;
    return [...doc.querySelectorAll('item, entry')].slice(0, 40).flatMap((item) => {
      const title = text(item, 'title').slice(0, 240);
      const link = item.querySelector('link[rel="alternate"], link:not([rel])');
      const href = link?.getAttribute('href') || link?.textContent.trim();
      if (!title || !href) return [];
      let url;
      try { url = feedURL(new URL(href, base).href); } catch { return []; }
      if (!url) return [];
      const published = Date.parse(text(item, 'pubDate, published, updated'));
      const summary = document.createElement('template');
      summary.innerHTML = text(item, 'description, summary, content').slice(0, 4000);
      for (const block of summary.content.querySelectorAll('script, style')) block.remove();
      return [{ title, url, published, summary: summary.content.textContent.replace(/\s+/g, ' ').trim().slice(0, 220) }];
    }).sort((a, b) => (b.published || 0) - (a.published || 0)).slice(0, 7).map((item) => ({ ...item, source }));
  }

  function weatherDescription(code) {
    if (!Number.isFinite(code)) return '';
    if (code === 0) return 'Ясно';
    if (code < 4) return 'Облачно';
    if (code < 49) return 'Туман';
    if (code < 68) return 'Дождь';
    if (code < 80) return 'Снег';
    if (code < 83) return 'Ливень';
    if (code < 95) return 'Снегопад';
    return 'Гроза';
  }

  function renderWeather(data, fields) {
    const temperature = node('strong', 'weather-temperature', String(data.temperature));
    temperature.append(node('small', '', ' °C'));
    const headline = node('div', 'weather-primary');
    const city = node('span', 'tile-primary', data.city);
    city.title = data.city;
    headline.append(temperature, city);
    const conditions = [fields.conditions && weatherDescription(data.code),
      fields.conditions && Number.isFinite(data.precipitation) && data.precipitation > 0 && `${data.precipitation} мм`,
      fields.updated && data.updated && `Данные на ${data.updated}`].filter(Boolean);
    const details = [
      Number.isFinite(data.feelsLike) && `Ощущается как ${data.feelsLike} °C`,
      Number.isFinite(data.wind) && `Ветер ${data.wind} км/ч`,
      Number.isFinite(data.humidity) && `Влажность ${data.humidity}%`,
    ].filter(Boolean);
    const result = [headline];
    if (conditions.length) result.push(node('span', 'tile-secondary', conditions.join(' · ')));
    if (fields.details && details.length) result.push(node('span', 'tile-secondary tile-detail', details.join(' · ')));
    return result;
  }

  function renderEntries(kind, entries, fields, section) {
    if (!entries.length) return [node('span', 'tile-secondary', 'В ленте пока нет записей.')];
    const list = node('ul', 'feed-entries');
    for (const item of entries) {
      const row = node('li', 'feed-entry');
      const link = node('button', 'home-feed-link', item.title);
      link.type = 'button';
      link.title = item.title;
      link.addEventListener('click', () => window.bro2.send('open-widget-link', item.url));
      row.append(link);
      const meta = [fields.source && (kind === 'news' ? (section === 'world' ? 'Мир' : 'Технологии') : item.source),
        fields.published && Number.isFinite(item.published) && publicationDate.format(item.published)].filter(Boolean);
      if (meta.length) row.append(node('small', 'tile-secondary', meta.join(' · ')));
      if (fields.summary && item.summary) row.append(node('p', 'tile-secondary tile-detail', item.summary));
      list.append(row);
    }
    return [list];
  }

  function setupHomeWidgets({ home, main, tiles, config, getState }) {
    const visible = new Set();
    const data = new Map();
    const presented = new Map();
    const mediaTitle = byId('widget-media');
    const mediaDetails = byId('widget-media-details');
    const mediaMessage = byId('widget-media-message');
    const mediaToggle = document.querySelector('[data-home-media="toggle"]');
    const mediaOpen = document.querySelector('[data-home-media="tab"]');
    const face = byId('clock-face');
    const clock = byId('clock-value');
    const period = byId('clock-period');
    const line = clock.parentElement;
    const clockDate = byId('clock-date');
    const zone = byId('clock-zone');
    const date = byId('date-value');
    let clockTimer;
    let dataTimer;
    let media;
    let mediaBusy;

    function tickClock() {
      clearTimeout(clockTimer);
      if (document.hidden || home.hidden) return;
      const layout = config();
      const showClock = layout.tiles.clock.enabled && visible.has('clock');
      const showDate = layout.tiles.date.enabled && visible.has('date');
      if (!showClock && !showDate) return;

      const now = new Date();
      if (showClock) {
        const { seconds, date, zone: showZone } = layout.tiles.clock.fields;
        const twelve = layout.clockFormat === '12';
        const hour = now.getHours();
        const minute = now.getMinutes();
        const second = now.getSeconds();
        const digits = [pad(twelve ? hour % 12 || 12 : hour), pad(minute)];
        if (seconds) digits.push(pad(second));
        setText(clock, digits.join(':'));
        clock.dateTime = now.toISOString();
        line.dataset.seconds = String(seconds);
        period.hidden = !twelve;
        setText(period, hour < 12 ? 'AM' : 'PM');
        clockDate.hidden = !date;
        if (date) setText(clockDate, fullDate.format(now));
        zone.hidden = !showZone;
        if (showZone) setText(zone, fullDate.resolvedOptions().timeZone.replaceAll('_', ' '));
        if (!face.hidden) {
          face.style.setProperty('--hour', (hour % 12 * 30 + minute / 2) + 'deg');
          face.style.setProperty('--minute', (minute * 6 + second / 10) + 'deg');
          face.style.setProperty('--second', second * 6 + 'deg');
        }
      }
      if (showDate) {
        const { weekday, year } = layout.tiles.date.fields;
        const key = JSON.stringify([weekday, year]);
        if (!dateFormats.has(key)) dateFormats.set(key, new Intl.DateTimeFormat('ru-RU', {
          day: 'numeric', month: 'long', weekday: weekday ? 'long' : undefined, year: year ? 'numeric' : undefined,
        }));
        setText(date, dateFormats.get(key).format(now));
        date.dateTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      }
      clockTimer = setTimeout(tickClock, 1005 - now.getMilliseconds());
    }

    function showData(kind, status, payload, layout) {
      const fields = layout.tiles[kind].fields;
      const last = presented.get(kind);
      const signature = JSON.stringify([status, fields, layout.news, navigator.onLine]);
      if (last?.signature === signature && last.payload === payload) return;
      presented.set(kind, { signature, payload });
      const output = byId('widget-' + kind);
      output.dataset.status = status;
      output.setAttribute('aria-busy', String(status === 'loading'));
      if (status !== 'ready') {
        output.replaceChildren(node('span', 'tile-state', payload));
        return;
      }
      const content = kind === 'weather' ? renderWeather(payload, fields) : renderEntries(kind, payload.entries, fields, layout.news);
      if (payload.stale || !navigator.onLine) content.unshift(node('span', 'tile-state', 'Последние сохранённые данные'));
      output.replaceChildren(...content);
    }

    function updateVisible() {
      tickClock();
      clearTimeout(dataTimer);
      if (document.hidden || home.hidden || getState()?.privateMode) return;
      const layout = config();
      let refreshAt = Infinity;
      for (const kind of ['weather', 'news', 'feed']) {
        if (!layout.tiles[kind].enabled || !visible.has(kind)) continue;
        const value = layout[kind === 'weather' ? 'city' : kind];
        const previous = data.get(kind);
        const matching = previous?.value === value ? previous : undefined;
        if (!value) {
          data.delete(kind);
          showData(kind, 'empty', kind === 'weather' ? 'Укажите город в настройках блока.' : 'Добавьте адрес ленты в настройках блока.', layout);
          continue;
        }
        if (!navigator.onLine) {
          if (matching?.status === 'ready') showData(kind, 'ready', matching.payload, layout);
          else showData(kind, 'error', 'Нет подключения к интернету.', layout);
          continue;
        }

        if (matching?.pending || matching?.until > Date.now()) {
          showData(kind, matching.status, matching.payload, layout);
          if (matching.until) refreshAt = Math.min(refreshAt, matching.until);
          continue;
        }
        const state = { value, pending: true, status: matching?.status === 'ready' ? 'ready' : 'loading',
          payload: matching?.status === 'ready' ? matching.payload : 'Загрузка…' };
        data.set(kind, state);
        showData(kind, state.status, state.payload, layout);
        void window.bro2.home('data', { kind, value }).then((result) => {
          if (!result.ok) throw new Error(result.message || 'Источник недоступен.');
          const payload = kind === 'weather' ? result.data :
            { entries: parseFeed(result.data.text, result.data.url), stale: result.data.stale };
          Object.assign(state, { status: 'ready', payload, until: Date.now() + (payload.stale ? 60_000 : 15 * 60_000) });
        }).catch((error) => {
          Object.assign(state, { status: 'error', payload: error.message || 'Источник недоступен.', until: Date.now() + 60_000 });
        }).finally(() => { state.pending = false; updateVisible(); });
      }
      if (Number.isFinite(refreshAt)) dataTimer = setTimeout(updateVisible, Math.max(100, refreshAt - Date.now()));
    }

    const observer = new IntersectionObserver((entries) => {
      for (const { isIntersecting, target } of entries) {
        const key = target.dataset.widget;
        if (isIntersecting) visible.add(key);
        else visible.delete(key);
      }
      updateVisible();
    }, { root: main, rootMargin: '0px 0px 64px' });
    for (const id of ['clock', 'date', 'weather', 'news', 'feed']) observer.observe(tiles.get(id));
    document.addEventListener('visibilitychange', updateVisible);
    window.addEventListener('offline', updateVisible);
    window.addEventListener('online', () => {
      for (const entry of data.values()) if (!entry.pending) entry.until = 0;
      updateVisible();
    });

    function renderMedia() {
      const fields = config().tiles.media.fields;
      setText(mediaTitle, media?.title || 'Нет активного медиа');
      setText(mediaDetails, [fields.status && media && (media.playing ? 'Воспроизводится' : 'На паузе'),
        fields.source && media?.source].filter(Boolean).join(' · '));
      mediaDetails.hidden = !mediaDetails.textContent;
      mediaOpen.hidden = !fields.open;
      mediaOpen.disabled = !media || mediaBusy;
      mediaToggle.disabled = Boolean(mediaBusy);
      setText(mediaToggle.querySelector('span'), media?.playing ? 'Пауза' : 'Воспроизвести');
    }

    for (const button of [mediaToggle, mediaOpen]) button.addEventListener('click', async () => {
      mediaBusy = true;
      mediaMessage.hidden = false;
      mediaMessage.textContent = 'Поиск медиа…';
      renderMedia();
      try {
        const result = await window.bro2.home('media', button.dataset.homeMedia);
        if (!result.ok) throw new Error(result.message || 'Не удалось управлять воспроизведением.');
        if (result.media) media = result.media;
        mediaMessage.hidden = true;
      } catch (error) { mediaMessage.textContent = error.message; }
      finally { mediaBusy = false; renderMedia(); }
    });

    function render() {
      const layout = config();
      const shortcuts = byId('shortcuts');
      const count = byId('shortcut-count');
      const total = getState()?.shortcuts.length || 0;
      count.hidden = !layout.tiles.shortcuts.fields.count;
      setText(count, `${total} из 12`);
      byId('shortcuts-empty').hidden = total > 0;
      shortcuts.dataset.size = layout.shortcutSize;
      shortcuts.dataset.shape = layout.shortcutShape;
      shortcuts.dataset.title = String(layout.shortcutTitle);
      shortcuts.dataset.icon = String(layout.shortcutIcon);
      const ranks = new Map(layout.shortcutOrder.map((url, index) => [url, index]));
      for (const entry of shortcuts.querySelectorAll('[data-url]')) entry.style.order = ranks.get(entry.dataset.url) ?? 20;

      byId('home-microphone').hidden = !layout.tiles.search.fields.microphone;
      byId('home-chatgpt').hidden = !layout.tiles.search.fields.chat;
      const analogue = layout.clock.startsWith('analog');
      face.hidden = !analogue;
      face.dataset.clock = layout.clock;
      face.dataset.seconds = String(layout.tiles.clock.fields.seconds);
      tiles.get('clock').dataset.clock = layout.clock;
      renderMedia();
      updateVisible();
    }

    return { render, updateMedia(next) {
      if (JSON.stringify(media) === JSON.stringify(next)) return;
      media = next;
      if (next && !mediaBusy) mediaMessage.hidden = true;
      renderMedia();
    } };
  }

  window.setupHomeWidgets = setupHomeWidgets;
})();
