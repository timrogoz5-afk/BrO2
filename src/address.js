const explicitWeb = /^https?:\/\//i;
const hostLike = /^(?:localhost|\[[\da-f:.]+\]|[^\s/.:?#]+(?:\.[^\s/.:?#]+)+)(?::\d+)?(?:[/?#].*)?$/iu;
const localWithPort = /^[a-z][a-z0-9-]*:\d{1,5}(?:[/?#].*)?$/i;
const searchToken = '{searchTerms}';

function webURL(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
  } catch {
    return null;
  }
  return null;
}

const searchEngines = {
  google: ['https://www.google.com/search', 'q'],
  yandex: ['https://yandex.ru/search/', 'text'],
  duckduckgo: ['https://duckduckgo.com/', 'q'],
  bing: ['https://www.bing.com/search', 'q'],
  perplexity: ['https://www.perplexity.ai/search', 'q'],
};

function customSearchEngine(entry) {
  if (typeof entry?.keyword !== 'string' || typeof entry.name !== 'string' || typeof entry.template !== 'string') return null;
  const keyword = entry.keyword.trim().toLowerCase();
  const name = entry.name.trim().slice(0, 64);
  const template = entry.template.trim();
  if (!/^[\p{L}\d][\p{L}\d_-]{0,23}$/u.test(keyword) || !name || template.length > 2048 ||
      template.split(searchToken).length !== 2) return null;
  const marker = 'Bro2SearchTermsMarker';
  try {
    const parsed = new URL(template.replace(searchToken, marker));
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hostname.toLowerCase().includes(marker.toLowerCase()) ||
        (!parsed.pathname.includes(marker) && !parsed.search.includes(marker))) return null;
  } catch { return null; }
  return { keyword, name, template };
}

function resolveAddress(input, engine = 'google', searchOnly = false, custom = []) {
  const value = input.trim();
  if (!value) return null;
  if (!searchOnly) {
    const [keyword, ...rest] = value.split(/\s+/);
    const shortcut = rest.length && custom.find((entry) => entry.keyword === keyword.toLowerCase());
    if (shortcut) return webURL(shortcut.template.replace(searchToken, () => encodeURIComponent(rest.join(' '))));
  }
  if (!searchOnly && explicitWeb.test(value)) return webURL(value);
  if (!searchOnly && /^[a-z][a-z\d+.-]*:\/\//i.test(value)) return null;
  if (!searchOnly && (hostLike.test(value) || localWithPort.test(value))) {
    const local = /^(?:localhost|127\.|\[::1\])(?:[:/?#]|\d|$)/i.test(value) || localWithPort.test(value);
    const address = webURL(`${local ? 'http' : 'https'}://${value}`);
    if (address) return address;
  }
  const selected = custom.find((entry) => `custom:${entry.keyword}` === engine);
  if (selected) return webURL(selected.template.replace(searchToken, () => encodeURIComponent(value)));
  const [endpoint, parameter] = Object.hasOwn(searchEngines, engine) ? searchEngines[engine] : searchEngines.google;
  const search = new URL(endpoint);
  search.searchParams.set(parameter, value);
  return search.href;
}

module.exports = { resolveAddress, webURL, customSearchEngine };
