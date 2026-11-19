const iconPaths = {
  back: '<path d="m12 5-7 7 7 7M5 12h14"/>',
  forward: '<path d="m12 5 7 7-7 7M5 12h14"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  menu: '<circle cx="5" cy="12" r=".8"/><circle cx="12" cy="12" r=".8"/><circle cx="19" cy="12" r=".8"/>',
  reload: '<path d="M20 11a8 8 0 1 0-2.35 5.65M20 4v7h-7"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  search: '<circle cx="10.8" cy="10.8" r="5.8"/><path d="m15 15 4.5 4.5"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.2 3.5 5.1 3.5 8.5s-1.1 6.3-3.5 8.5c-2.4-2.2-3.5-5.1-3.5-8.5s1.1-6.3 3.5-8.5Z"/>',
  history: '<path d="M4 12a8 8 0 1 1 2.3 5.7M4 6v6h6m2-4v4l3 2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M10 3h4l.6 2.5 1.5.9 2.5-.7 2 3.5-1.9 1.8v2l1.9 1.8-2 3.5-2.5-.7-1.5.9L14 21h-4l-.6-2.5-1.5-.9-2.5.7-2-3.5L5.3 13v-2L3.4 9.2l2-3.5 2.5.7 1.5-.9Z"/>',
  star: '<path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  palette: '<path d="M20.5 12a8.5 8.5 0 1 0-8.5 8.5h1.3a1.6 1.6 0 0 0 1-2.9 1.7 1.7 0 0 1 1-3.1h2.8a2.4 2.4 0 0 0 2.4-2.5Z"/><path d="M7.5 12h.01M10 7.5h.01M15 7.5h.01" stroke-width="3"/>',
  motion: '<path d="M5 12h3l2-6 4 12 2-6h3"/>',
  user: '<circle cx="12" cy="8" r="3.2"/><path d="M5 20v-1.5a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4V20"/>',
  lock: '<rect x="6" y="10" width="12" height="10" rx="2"/><path d="M9 10V7a3 3 0 0 1 6 0v3"/>',
  key: '<circle cx="8" cy="9" r="4"/><path d="m11 12 8 8m-3-3 2-2m-4 0 2-2"/>',
  puzzle: '<path d="M12 4a2 2 0 1 1 4 0v2h3v4h1a2 2 0 1 1 0 4h-1v5h-5v-1a2 2 0 1 0-4 0v1H5v-5h1a2 2 0 1 0 0-4H5V6h7Z"/>',
  pin: '<path d="m16 3 5 5-3 1-3 3v4l-1 1-7-7 1-1h4l3-3 1-3ZM10.5 13.5 4 20"/>',
  warning: '<path d="m12 4 9 16H3l9-16Zm0 6v4m0 3h.01"/>',
  enter: '<path d="M18 6.5v5a3 3 0 0 1-3 3H6m3.5-3.5L6 14.5 9.5 18"/>',
  mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5.5 11v1a6.5 6.5 0 0 0 13 0v-1M12 18.5V21m-3 0h6"/>',
  chat: '<path d="M12 3.5a8.5 8.5 0 0 0-7.4 12.7L4 20l3.8-.9A8.5 8.5 0 1 0 12 3.5Z"/><path d="M12 7.5c.6 3 1.5 3.9 4.5 4.5-3 .6-3.9 1.5-4.5 4.5-.6-3-1.5-3.9-4.5-4.5 3-.6 3.9-1.5 4.5-4.5Z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.5 2"/>',
  calendar: '<rect x="4" y="6" width="16" height="14" rx="3"/><path d="M8 4v4m8-4v4M4 10h16m-9 4h2v3"/>',
  cloud: '<path d="M6.5 18a4.5 4.5 0 1 1 1.1-8.9 5.4 5.4 0 0 1 10.5 1.1 3.9 3.9 0 0 1-.2 7.8Z"/>',
  music: '<path d="M9 17V6l10-2v11M9 10l10-2"/><ellipse cx="6.5" cy="17" rx="2.5" ry="2"/><ellipse cx="16.5" cy="15" rx="2.5" ry="2"/>',
  play: '<path d="m8 5 11 7-11 7Z"/>',
  rss: '<path d="M5 5a14 14 0 0 1 14 14M5 11a8 8 0 0 1 8 8"/><circle cx="6" cy="18" r="1"/>',
  news: '<rect x="4.5" y="5" width="15" height="14" rx="2"/><path d="M8 9h3v5H8zm6 .5h2m-2 4h2m-8 3h8"/>',
  download: '<path d="M12 4v11m-4-4 4 4 4-4M5 16v4h14v-4"/>',
  move: '<path d="M12 3v18M3 12h18M9 6l3-3 3 3m-6 12 3 3 3-3M6 9l-3 3 3 3m12-6 3 3-3 3"/>',
  resize: '<path d="M6 18 18 6M13 6h5v5M6 13v5h5"/>',
  grid: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 12h16M12 4v16"/>',
  tab: '<rect x="4" y="5" width="16" height="14" rx="2.5"/><path d="M4 10h16"/>',
  check: '<path d="m5 12 4 4 10-10"/>',
  external: '<path d="M14 5h5v5m0-5-8 8m6 0v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h5"/>',
  trash: '<path d="M4 7h16m-14 0 1 13h10l1-13M9 7V4h6v3m-5 3v6m4-6v6"/>',
};

function icon(name) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) {
    element.setAttribute(key, value);
  }
  element.classList.add('glyph');
  element.innerHTML = iconPaths[name];
  return element;
}

function setIcon(element, name) {
  if (element.dataset.renderedIcon === name) return;
  element.replaceChildren(icon(name));
  element.dataset.renderedIcon = name;
}

document.querySelectorAll('[data-icon]').forEach((element) => element.prepend(icon(element.dataset.icon)));
