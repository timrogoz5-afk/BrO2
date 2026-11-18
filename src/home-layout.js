(() => {
  const positions = {
    logo: [0, 0, 12, 2], search: [0, 2, 12, 1], shortcuts: [0, 3, 7, 4],
    clock: [7, 3, 5, 3], date: [7, 6, 5, 1], weather: [0, 7, 4, 3],
    media: [4, 7, 8, 3], news: [0, 10, 6, 4], feed: [6, 10, 6, 4],
  };
  const names = {
    logo: 'Логотип BrO2', search: 'Поиск', shortcuts: 'Ярлыки', clock: 'Часы', date: 'Дата',
    weather: 'Погода', media: 'Медиаплеер', news: 'Новости', feed: 'RSS и Atom',
  };
  const wallpaperNames = { aurora: 'Северное сияние', dawn: 'Рассвет', coast: 'Побережье', solid: 'Однотонные' };
  const minWidths = { logo: 3, search: 5, shortcuts: 4, clock: 3, date: 4, weather: 3, media: 4, news: 4, feed: 4 };
  const minHeights = { logo: 1, search: 1, shortcuts: 2, clock: 3, date: 1, weather: 2, media: 2, news: 3, feed: 3 };
  const limit = (value, fallback, min, max) => Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
  const choice = (value, options) => options.includes(value) ? value : options[0];
  function feedURL(value) {
    if (typeof value !== 'string' || value.length > 2048) return '';
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  }
  function homeLayout(value) {
    const tiles = {};
    for (const [id, [x, y, w, h]] of Object.entries(positions)) {
      const item = value?.tiles?.[id];
      const width = limit(item?.w, w, minWidths[id], 12);
      tiles[id] = { x: Math.min(12 - width, limit(item?.x, x, 0, 11)), y: limit(item?.y, y, 0, 39),
        w: width, h: limit(item?.h, h, minHeights[id], 8),
        enabled: typeof item?.enabled === 'boolean' ? item.enabled : y < 7 };
    }
    return { tiles, wallpaper: choice(value?.wallpaper, Object.keys(wallpaperNames)),
      clock: choice(value?.clock, ['digital', 'digital-compact', 'analog', 'analog-dial']),
      city: typeof value?.city === 'string' ? value.city.trim().slice(0, 100) : '',
      feed: feedURL(value?.feed), news: choice(value?.news, ['technology', 'world']),
      shortcutSize: choice(value?.shortcutSize, ['medium', 'small', 'large']),
      shortcutShape: choice(value?.shortcutShape, ['soft', 'circle', 'square']),
      shortcutIcon: value?.shortcutIcon !== false, shortcutTitle: value?.shortcutTitle !== false,
      shortcutOrder: Array.isArray(value?.shortcutOrder) ? [...new Set(value.shortcutOrder.filter((url) =>
        typeof url === 'string' && url.length <= 8192))].slice(0, 12) : [],
    };
  }
  const api = { homeLayout, names, wallpaperNames, minWidths, minHeights, feedURL };
  if (typeof module === 'object') module.exports = api;
  else window.homeModel = api;
})();
