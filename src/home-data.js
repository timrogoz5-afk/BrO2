const { feedURL } = require('./home-layout');
const feeds = { technology: 'https://feeds.bbci.co.uk/news/technology/rss.xml', world: 'https://feeds.bbci.co.uk/news/world/rss.xml' };

async function download(raw, signal, maxBytes) {
  const url = feedURL(raw);
  if (!url) throw new Error('Укажи адрес HTTP или HTTPS.');
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(9000)]), credentials: 'omit' });
  if (!response.ok || !response.body) throw new Error('Источник недоступен.');
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error('Слишком большой ответ источника.');
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return { text: Buffer.concat(parts).toString('utf8'), url: response.url };
}

function homeData() {
  const cache = new Map();
  const pending = new Map();
  const controller = new AbortController();
  async function load(kind, value) {
    const key = JSON.stringify([kind, value]);
    const previous = cache.get(key);
    if (previous?.until > Date.now()) return previous.data;
    if (pending.has(key)) return pending.get(key);
    const request = (async () => {
      try {
        const data = kind === 'weather' ? await weather(value, controller.signal) :
          await download(kind === 'news' ? feeds[value] : value, controller.signal, 512 * 1024);
        if (cache.size >= 32) cache.delete(cache.keys().next().value);
        cache.set(key, { data, until: Date.now() + 15 * 60_000 });
        return data;
      } catch (error) {
        if (previous) return { ...previous.data, stale: true };
        throw error;
      } finally { pending.delete(key); }
    })();
    pending.set(key, request);
    return request;
  }
  return { load, close: () => controller.abort() };
}

async function weather(city, signal) {
  const search = new URL('https://geocoding-api.open-meteo.com/v1/search');
  search.search = new URLSearchParams({ name: city, count: 1, language: 'ru' });
  const location = JSON.parse((await download(search.href, signal, 64 * 1024)).text).results?.[0];
  if (!location) throw new Error('Город не найден.');
  const forecast = new URL('https://api.open-meteo.com/v1/forecast');
  forecast.search = new URLSearchParams({ latitude: location.latitude, longitude: location.longitude, timezone: 'auto',
    current: 'temperature_2m,weather_code,precipitation,apparent_temperature,wind_speed_10m,relative_humidity_2m' });
  const result = JSON.parse((await download(forecast.href, signal, 64 * 1024)).text).current;
  if (!Number.isFinite(result?.temperature_2m)) throw new Error('Температура пока неизвестна.');
  const rounded = (value) => Number.isFinite(value) ? Math.round(value) : null;
  return {
    city: [location.name, location.country].filter(Boolean).join(', '),
    temperature: rounded(result.temperature_2m),
    code: result.weather_code,
    precipitation: result.precipitation,
    feelsLike: rounded(result.apparent_temperature),
    wind: rounded(result.wind_speed_10m),
    humidity: rounded(result.relative_humidity_2m),
    updated: typeof result.time === 'string' ? result.time.match(/T(\d{2}:\d{2})/)?.[1] : null,
  };
}
module.exports = { homeData };
