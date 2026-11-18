const names = {
  camera: 'камере',
  microphone: 'микрофону',
  notifications: 'уведомлениям',
  geolocation: 'местоположению',
  popups: 'всплывающим окнам',
};

function siteOrigin(value, secure = true) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || (!secure && url.protocol === 'http:')) && !url.username && !url.password
      ? url.origin : null;
  } catch { return null; }
}

function permissionTypes(permission, details) {
  if (permission === 'media') {
    const capabilities = { audio: 'microphone', video: 'camera' };
    const requested = details?.mediaTypes ?? (details?.mediaType ? [details.mediaType] : []);
    if (!Array.isArray(requested) || !requested.length || !requested.every((type) => Object.hasOwn(capabilities, type))) return [];
    return [...new Set(requested.map((type) => capabilities[type]))];
  }
  if (permission === 'geolocation-approximate') return ['geolocation'];
  if (['notifications', 'geolocation', 'fullscreen'].includes(permission)) return [permission];
  return [];
}

function permissionContext(contents, claimed, details, secure) {
  if (!contents || contents.isDestroyed() || details?.isMainFrame !== true) return null;
  const active = siteOrigin(contents.getURL(), secure);
  const requester = siteOrigin(claimed, secure);
  if (!requester || requester !== active) return null;
  if (details.embeddingOrigin && siteOrigin(details.embeddingOrigin, secure) !== active) return null;
  if (details.securityOrigin && siteOrigin(details.securityOrigin, secure) !== active) return null;
  return active;
}

function siteRules(raw) {
  const rules = {};
  for (const [origin, permissions] of Object.entries(raw ?? {}).slice(0, 1000)) {
    if (siteOrigin(origin, false) !== origin || !permissions || typeof permissions !== 'object') continue;
    const clean = Object.fromEntries(Object.entries(permissions).filter(([type, decision]) => Object.hasOwn(names, type) &&
      ['allow', 'block'].includes(decision) && (type === 'popups' || Boolean(siteOrigin(origin)))));
    if (Object.keys(clean).length) rules[origin] = clean;
  }
  return rules;
}

function updateSiteRules(rules, origin, types, decision) {
  const next = { ...rules };
  const entry = { ...next[origin] };
  for (const type of types) {
    if (decision === 'ask') delete entry[type];
    else entry[type] = decision;
  }
  if (Object.keys(entry).length) next[origin] = entry;
  else delete next[origin];
  return siteRules(next);
}

module.exports = { permissionNames: names, siteOrigin, permissionTypes, permissionContext, siteRules, updateSiteRules };
