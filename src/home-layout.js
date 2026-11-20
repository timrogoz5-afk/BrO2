(() => {
  const canvasWidth = 1200;
  const gridStep = 24;
  const maxY = 4000;
  const legacyGrid = {
    logo: [0, 0, 12, 2], search: [0, 2, 12, 1], shortcuts: [0, 3, 7, 4],
    clock: [7, 3, 5, 3], date: [7, 6, 5, 1], weather: [0, 7, 4, 3],
    media: [4, 7, 8, 3], news: [0, 10, 6, 4], feed: [6, 10, 6, 4],
  };
  const names = {
    logo: 'BrO2', search: 'Поиск', shortcuts: 'Ярлыки', clock: 'Местное время', date: 'Дата',
    weather: 'Погода', media: 'Медиаплеер', news: 'Новости BBC News', feed: 'RSS и Atom',
  };
  const wallpaperNames = { aurora: 'Северное сияние', dawn: 'Рассвет', coast: 'Побережье', solid: 'Однотонные' };
  const accents = { default: 'Авто', violet: 'Фиолетовый', blue: 'Синий', mint: 'Мятный', rose: 'Розовый', amber: 'Янтарный' };
  const fields = {
    logo: { title: 'Подпись под логотипом' },
    search: { title: 'Заголовок над строкой', microphone: 'Голосовой ввод', chat: 'Кнопка ChatGPT' },
    shortcuts: { count: 'Количество ярлыков' },
    clock: { seconds: 'Секунды', date: 'Дата и день недели', zone: 'Часовой пояс' },
    date: { weekday: 'День недели', year: 'Год' },
    weather: { conditions: 'Облачность и осадки', updated: 'Время наблюдения', details: 'Ощущается как, ветер и влажность' },
    media: { source: 'Сайт', status: 'Статус воспроизведения', open: 'Кнопка перехода к вкладке' },
    news: { published: 'Время публикации', source: 'Раздел', summary: 'Краткое описание' },
    feed: { published: 'Время публикации', source: 'Название источника', summary: 'Краткое описание' },
  };
  const offByDefault = {
    logo: ['title'], search: ['title'], shortcuts: [], clock: ['zone'], date: [],
    weather: [], media: [], news: [], feed: [],
  };
  const minimum = {
    logo: [260, 88], search: [390, 56], shortcuts: [260, 110], clock: [305, 120], date: [255, 56],
    weather: [290, 118], media: [340, 147], news: [345, 118], feed: [345, 118],
  };
  const maxHeight = 650;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const limit = (value, fallback, min, max) => Number.isFinite(value) ? clamp(value, min, max) : fallback;
  const choice = (value, options) => options.includes(value) ? value : options[0];

  function feedURL(value) {
    if (typeof value !== 'string' || value.length > 2048) return '';
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  }

  function legacyPositions(value) {
    const cells = Object.entries(legacyGrid).map(([id, [x, y, w, h]]) => {
      const item = value?.tiles?.[id];
      const legacy = (key) => Number.isInteger(item?.[key]) ? item[key] : undefined;
      const width = limit(legacy('w'), w, Math.ceil((minimum[id][0] + 10) / (1210 / 12)), 12);
      return { id, w: width, x: limit(legacy('x'), x, 0, 12 - width), y: limit(legacy('y'), y, 0, 39),
        h: limit(legacy('h'), h, Math.ceil((minimum[id][1] + 10) / 66), 8),
        enabled: typeof item?.enabled === 'boolean' ? item.enabled : y < 7 };
    });
    const placed = [];
    for (const tile of cells.filter((item) => item.enabled).sort((a, b) => a.y - b.y || a.x - b.x)) {
      while (placed.some((other) => tile.x < other.x + other.w && other.x < tile.x + tile.w &&
        tile.y < other.y + other.h && other.y < tile.y + tile.h)) tile.y++;
      placed.push(tile);
    }
    return Object.fromEntries(cells.map(({ id, x, y, w, h, enabled }) =>
      [id, { x: x * 101 - x / 6, y: y * 66, w: w * (1210 / 12) - 10, h: h * 66 - 10, enabled }]));
  }

  const defaultPositions = {
    logo: { x: 166, y: 0, w: 868, h: 158, enabled: true },
    search: { x: 166, y: 158, w: 868, h: 56, enabled: true },
    weather: { x: 158, y: 230, w: 292, h: 192, enabled: true },
    clock: { x: 456, y: 230, w: 306, h: 192, enabled: true },
    shortcuts: { x: 769, y: 230, w: 286, h: 192, enabled: true },
    date: { x: 158, y: 434, w: 292, h: 62, enabled: false },
    media: { x: 456, y: 434, w: 599, h: 192, enabled: false },
    news: { x: 158, y: 638, w: 443, h: 254, enabled: false },
    feed: { x: 612, y: 638, w: 443, h: 254, enabled: false },
  };
  function homeLayout(value) {
    const free = value?.version === 2;
    const legacy = !free && Boolean(value?.tiles);
    const geometry = legacy ? legacyPositions(value) : value?.tiles;
    const tiles = {};
    for (const [id, defaults] of Object.entries(defaultPositions)) {
      const item = value?.tiles?.[id];
      const rect = geometry?.[id];
      const [minWidth, minHeight] = minimum[id];
      const w = limit(rect?.w, defaults.w, minWidth, canvasWidth);
      const enabled = typeof rect?.enabled === 'boolean' ? rect.enabled : defaults.enabled;
      const title = typeof item?.title === 'string' ? item.title.trim().slice(0, 64) : '';
      tiles[id] = {
        x: limit(rect?.x, Math.min(defaults.x, canvasWidth - w), 0, canvasWidth - w),
        y: limit(rect?.y, defaults.y, 0, maxY), w,
        h: limit(rect?.h, defaults.h, minHeight, maxHeight), enabled,
        title: title || names[id], accent: choice(item?.accent, Object.keys(accents)),
        fields: Object.fromEntries(Object.keys(fields[id]).map((key) => [key,
          typeof item?.fields?.[key] === 'boolean' ? item.fields[key] : !offByDefault[id].includes(key)])),
      };
    }
    if (legacy) {
      const savedFields = value.tiles.clock?.fields;
      if (tiles.date.enabled && typeof savedFields?.date !== 'boolean') tiles.clock.fields.date = false;
      if (typeof savedFields?.zone !== 'boolean') tiles.clock.fields.zone = true;
    }
    const order = Array.isArray(value?.order) ? value.order.filter((id) => Object.hasOwn(tiles, id)) : [];
    return { version: 2, tiles, order: [...new Set([...order, ...Object.keys(tiles)])], snapToGrid: value?.snapToGrid === true,
      wallpaper: choice(value?.wallpaper, Object.keys(wallpaperNames)),
      clock: choice(value?.clock ?? (legacy ? 'digital' : 'analog-dial'), ['digital', 'digital-compact', 'analog', 'analog-dial']),
      clockFormat: choice(value?.clockFormat, ['24', '12']),
      city: typeof value?.city === 'string' ? value.city.trim().slice(0, 100) : '',
      feed: feedURL(value?.feed), news: choice(value?.news, ['technology', 'world']),
      shortcutSize: choice(value?.shortcutSize ?? (legacy ? 'medium' : 'large'), ['medium', 'small', 'large']),
      shortcutShape: choice(value?.shortcutShape, ['soft', 'circle', 'square']),
      shortcutIcon: value?.shortcutIcon !== false,
      shortcutTitle: typeof value?.shortcutTitle === 'boolean' ? value.shortcutTitle : legacy,
      shortcutOrder: Array.isArray(value?.shortcutOrder) ? [...new Set(value.shortcutOrder.filter((url) =>
        typeof url === 'string' && url.length <= 8192))].slice(0, 12) : [],
    };
  }
  const api = { homeLayout, names, wallpaperNames, accents, fields, minimum, maxHeight, canvasWidth, gridStep, maxY, clamp, feedURL };
  if (typeof module === 'object') module.exports = api;
  else window.homeModel = api;
})();
