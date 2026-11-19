const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { devtools, until } = require('./benchmark');

async function run() {
  const temp = await fs.realpath(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(temp, 'bro2-dashboard-'));
  const fixture = createServer(async (request, response) => {
    if (request.url === '/favicon.ico') {
      response.setHeader('Content-Type', 'image/svg+xml');
      return response.end('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="12" fill="teal"/></svg>');
    }
    if (request.url === '/broken') return response.end('<not-closed>');
    if (request.url === '/empty') {
      await delay(250);
      return response.end('<feed/>');
    }
    response.setHeader('Content-Type', 'application/atom+xml');
    response.end('<feed xmlns="http://www.w3.org/2005/Atom"><title>Локальная лента</title><entry><title>Atom в BrO2</title><link href="/article"/><published>2026-11-18T11:22:00Z</published><summary>Подробности записи</summary></entry></feed>');
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const source = 'http://127.0.0.1:' + fixture.address().port;
  await fs.writeFile(path.join(dir, 'preferences.json'), JSON.stringify({
    settings: { theme: 'dark' },
    home: {
      tiles: { feed: { x: 6, y: 7, w: 6, h: 4, enabled: true } },
      feed: source + '/fixture',
    },
    shortcuts: [{ url: source, title: 'Ярлык' }],
  }));
  const extensionId = '2ea54466-f1b4-48db-9d5b-c2355ea3798e';
  const extensionDir = path.join(dir, 'brO2-extensions', extensionId);
  const manifest = JSON.stringify({
    manifest_version: 3, name: 'Popup fixture', version: '1.0', action: { default_popup: 'popup.html' },
  });
  await fs.mkdir(extensionDir, { recursive: true });
  await fs.writeFile(path.join(extensionDir, 'manifest.json'), manifest);
  await fs.writeFile(path.join(extensionDir, 'popup.html'), '<!doctype html><button>Popup fixture</button>');
  await fs.writeFile(path.join(dir, 'extensions.json'), JSON.stringify({ version: 1, entries: [{
    id: extensionId, name: 'Popup fixture', version: '1.0', enabled: true, pinned: true,
    fingerprint: createHash('sha256').update(manifest).digest('hex'),
  }] }));

  let proc;
  let chrome;
  let endpoint;
  const ev = (script) => chrome.eval(script);
  const call = (method, params) => chrome.call(method, params);
  const wait = (script, label) => until(() => ev(script), label, 5000);
  const click = (selector) => ev(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const edit = (selector, value, event = 'change') => ev(`(() => {
    const field = document.querySelector(${JSON.stringify(selector)});
    field.value = ${JSON.stringify(value)};
    field.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true }));
  })()`);
  const clockSelector = '[data-widget="clock"]';
  const point = (selector) => ev(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  const mouse = (type, point, held = false) => call('Input.dispatchMouseEvent', {
    type, ...point, button: type === 'mouseMoved' && !held ? 'none' : 'left', buttons: held ? 1 : 0, clickCount: 1,
  });
  const matrix = (selector) => ev(`(() => {
    const value = getComputedStyle(document.querySelector(${JSON.stringify(selector)})).transform;
    const matrix = new DOMMatrix(value === 'none' ? undefined : value);
    return [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f];
  })()`);
  const themeColors = () => ev(`['main', '#tile-options', '#tile-options input', '.toolbar', '.home-clock', '#search-enter', '.tab-bar'].map((selector) => {
    const s = getComputedStyle(document.querySelector(selector));
    return [s.backgroundColor, s.color, s.borderColor, s.boxShadow, s.backgroundImage];
  })`);

  async function launch() {
    const portFile = path.join(dir, 'DevToolsActivePort');
    await fs.rm(portFile, { force: true });
    const binary = path.join(__dirname, '..', 'BrO2-portable', 'BrO2.exe');
    proc = spawn(binary, ['--user-data-dir=' + dir, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    proc.stderr.on('data', (data) => { errors += data; });
    try {
      const port = await until(async () => (await fs.readFile(portFile, 'utf8')).split('\n')[0], 'Chromium debugging port', 12000);
      endpoint = 'http://127.0.0.1:' + port;
      const target = await until(async () => (await fetch(endpoint + '/json/list').then((r) => r.json()))
        .find(({ url }) => url.endsWith('/src/index.html')), 'BrO2 dashboard', 12000);
      chrome = await devtools(target.webSocketDebuggerUrl);
      await wait('typeof state !== "undefined" && state && document.querySelector("#clock-value").textContent.includes(":")', 'Clock loaded');
    } catch (error) {
      const page = chrome && await ev(`({
        url: location.href, state: typeof state === 'undefined' ? null : !!state, hidden: document.hidden,
        appearance: window.bro2?.appearance, homeModel: !!window.homeModel,
        home: document.querySelector('#home')?.getBoundingClientRect().toJSON(),
        clock: document.querySelector('#clock-value')?.textContent,
        widget: document.querySelector('.home-clock')?.getBoundingClientRect().toJSON(),
        grid: document.querySelector('#home-grid')?.getBoundingClientRect().toJSON()
      })`).catch(() => null);
      throw new Error(error.message + '\n' + JSON.stringify(page) + '\n' + errors);
    }
  }

  async function stop() {
    if (!proc || proc.exitCode !== null) return;
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    const browser = await fetch(endpoint + '/json/version').then((r) => r.json())
      .then((target) => devtools(target.webSocketDebuggerUrl)).catch(() => null);
    if (browser) {
      await Promise.race([browser.call('Browser.close').catch(() => {}), delay(1500)]);
      browser.close();
    }
    chrome?.close();
    await Promise.race([exited, delay(2500)]);
    if (proc.exitCode === null) {
      proc.kill();
      await exited;
    }
  }

  try {
    await launch();
    await wait('document.querySelector("#shortcuts .shortcut-bubble img")?.naturalWidth === 32', 'Existing shortcut gets its favicon');
    assert.equal(await ev('getComputedStyle(document.querySelector("#shortcut-add")).display'), 'none');
    await wait('document.querySelector("#home").getAnimations().every(a => a.playState !== "running")', 'Home entrance finishes');
    const tick = () => ev(`(() => {
      const clock = document.querySelector('#clock-value');
      const { x, y, width, height } = clock.getBoundingClientRect();
      return { text: clock.textContent, x, y, width, height };
    })()`);
    const { text, ...size } = await tick();
    assert.match(text, /^\d{2}:\d{2}:\d{2}$/);
    await wait(`document.querySelector('#clock-value').textContent !== ${JSON.stringify(text)}`, 'Next second');
    const { text: next, ...nextSize } = await tick();
    assert.notEqual(next, text);
    assert.deepEqual(nextSize, size);
    assert.match(await ev('document.querySelector("#clock-date").textContent'), /, /);
    console.log('Clock ticks without shifting');

    const logo = await point('.wordmark-anchor');
    for (const [dx, dy] of [[-74, 0], [74, 0], [0, -32], [0, 32], [-45, -30]]) {
      await mouse('mouseMoved', { x: logo.x + dx, y: logo.y + dy });
      await delay(275);
      const [, , , , x, y] = await matrix('.wordmark');
      if (dx) assert(x * dx < -4, `Logo did not move away horizontally: ${x}`);
      if (dy) assert(y * dy < -4, `Logo did not move away vertically: ${y}`);
    }
    await mouse('mouseMoved', { x: 25, y: 480 });
    await wait('Math.abs(new DOMMatrix(getComputedStyle(document.querySelector(".wordmark")).transform).m41) < 0.1', 'Logo returns');
    console.log('Mouse repels the wordmark from every direction');

    const original = await ev('state.home.tiles.clock');
    await click('#customize');
    assert(await ev('document.querySelector("#shortcut-add").checkVisibility()'));
    const start = await point(clockSelector + ' .tile-move');
    const width = await ev('document.querySelector("#home-grid").clientWidth');
    await mouse('mousePressed', start, true);
    await mouse('mouseMoved', { x: start.x - 97, y: start.y + 33 }, true);
    await wait(`(() => {
      const tile = document.querySelector('${clockSelector}');
      const m = new DOMMatrix(tile.style.transform || undefined);
      return Math.abs(m.a - 1) + Math.abs(m.b) + Math.abs(m.d - 1) > 0.005;
    })()`, 'Elastic deformation');
    await mouse('mouseMoved', { x: start.x - 58, y: start.y + 51 }, true);
    await mouse('mouseReleased', { x: start.x - 58, y: start.y + 51 });
    const coords = await ev(`[parseFloat(document.querySelector('${clockSelector}').style.getPropertyValue('--tile-x')) * 12,
      parseFloat(document.querySelector('${clockSelector}').style.getPropertyValue('--tile-y'))]`);
    assert(Math.abs(coords[0] - (original.x - 58 * 1200 / width)) <= 1, 'Free X: ' + JSON.stringify({ coords, original, width }));
    assert(Math.abs(coords[1] - (original.y + 51)) <= 1, 'Free Y: ' + JSON.stringify({ coords, original }));
    await wait(`getComputedStyle(document.querySelector('${clockSelector}')).transform === 'none'`, 'Rebound settles');
    assert.deepEqual(await matrix(clockSelector), [1, 0, 0, 1, 0, 0]);
    console.log('Elastic drag releases at exact free coordinates');

    await click(clockSelector + ' .tile-options');
    assert(await ev('document.querySelector("#tile-options").matches(":popover-open")'));
    await edit('#tile-options input[type="text"]', 'Часы Москвы', 'input');
    await edit('#tile-options [data-dimension="w"]', '440', 'input');
    await edit('#tile-options [data-dimension="h"]', '220', 'input');
    await edit('#tile-options select', 'mint');
    await edit('[data-home-field="clockFormat"]', '12');
    await click('[data-tile-field="date"]');
    await click('[data-tile-field="seconds"]');
    assert.equal(await ev('document.querySelector("#clock-label span").textContent'), 'Часы Москвы');
    assert.equal(await ev('document.querySelector(".home-clock").dataset.accent'), 'mint');
    assert.equal(await ev('document.querySelector(".home-clock").style.getPropertyValue("--tile-h")'), '220px');
    assert.equal(await ev('document.querySelector(".home-date h2 span").textContent'), 'Дата');
    assert.match(await ev('document.querySelector("#clock-value").textContent'), /^\d{2}:\d{2}$/);
    assert(await ev('document.querySelector("#clock-date").hidden && !document.querySelector("#clock-period").hidden'));
    await click('#tile-options-preview');
    assert(await ev('!document.querySelector("#tile-options").matches(":popover-open") && !document.querySelector("#home").classList.contains("is-editing")'));
    assert.equal(await ev('getComputedStyle(document.querySelector("#shortcut-add")).display'), 'none');
    await click('#home-preview');
    assert(await ev('document.querySelector("#tile-options").matches(":popover-open")'));
    console.log('Per-block settings apply live and survive preview');

    const dark = await themeColors();
    const positionBefore = await ev('getComputedStyle(document.querySelector("main")).backgroundPosition');
    await edit('#home-theme', 'light');
    await wait('document.documentElement.dataset.colorScheme === "light"', 'Light transition starts');
    await delay(120);
    const middle = await themeColors();
    assert.notEqual(await ev('getComputedStyle(document.querySelector("main")).backgroundPosition'), positionBefore);
    await delay(330);
    const light = await themeColors();
    for (let i = 0; i < dark.length; i++) {
      assert.notEqual(middle[i][0], dark[i][0]);
      assert.notEqual(middle[i][0], light[i][0]);
    }
    for (const [row, property] of [[0, 4], [1, 1], [1, 2], [1, 3], [2, 2], [5, 1]]) {
      assert.notEqual(middle[row][property], dark[row][property]);
      assert.notEqual(middle[row][property], light[row][property]);
    }
    assert(await ev('document.querySelector("#tile-options").matches(":popover-open")'));
    await edit('#home-theme', 'dark');
    await wait('document.documentElement.dataset.colorScheme === "dark"', 'Dark transition starts');
    await delay(140);
    const midDark = await themeColors();
    await edit('#home-theme', 'light');
    await wait('document.documentElement.dataset.colorScheme === "light"', 'Rapid switch back to light');
    const immediate = await themeColors();
    assert.notEqual(immediate[1][0], dark[1][0]);
    assert.notEqual(immediate[1][0], light[1][0]);
    assert.notEqual(midDark[1][0], light[1][0]);
    await delay(440);
    assert.deepEqual(await themeColors(), light);
    console.log('Theme colors interpolate with the settings menu open and through a quick reversal');

    await click('#home-options-open');
    const aurora = await themeColors();
    await click('[data-wallpaper="coast"]');
    const animatingPalette = 'document.documentElement.getAnimations().some(a => a.transitionProperty === "--tabbar")';
    await wait(animatingPalette, 'Wallpaper palette transition starts');
    await delay(130);
    const coastMiddle = await themeColors();
    await wait('!(' + animatingPalette + ')', 'Wallpaper palette transition finishes');
    const coast = await themeColors();
    for (const [row, property] of [[0, 0], [0, 4], [3, 0], [4, 0], [6, 0]]) {
      assert.notEqual(coastMiddle[row][property], aurora[row][property]);
      assert.notEqual(coastMiddle[row][property], coast[row][property]);
    }
    await click('#home-options-close');
    await click('#home-snap');
    assert(await ev('document.querySelector("#home-grid").hasAttribute("data-snap")'));
    await click('#home-save');
    await wait('!document.querySelector("#home").classList.contains("is-editing") && state.home.tiles.clock.title === "Часы Москвы"', 'Dashboard saved');
    await stop();
    await launch();
    assert.equal(await ev('window.bro2.appearance.theme'), 'light');
    assert.equal(await ev('window.bro2.appearance.wallpaper'), 'coast');
    assert(await ev('state.home.snapToGrid'));
    const restored = await ev('state.home.tiles.clock');
    assert.equal(restored.title, 'Часы Москвы');
    assert.equal(restored.w, 440);
    assert.equal(restored.h, 220);
    assert(Math.abs(restored.x - coords[0]) < .1);
    assert(Math.abs(restored.y - coords[1]) < .1);
    console.log('Layout and theme survive a full BrO2 restart');

    await call('Emulation.setDeviceMetricsOverride', { width: 560, height: 640, deviceScaleFactor: 1, mobile: false });
    await wait('getComputedStyle(document.querySelector("#home-grid")).display === "flex"', 'Narrow layout');
    await click('#customize');
    await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await ev(`document.querySelector('${clockSelector} .tile-move').scrollIntoView({block:"center",inline:"nearest"})`);
    const touch = await point(clockSelector + ' .tile-move');
    const dispatch = (type, touchPoints) => call('Input.dispatchTouchEvent', { type, touchPoints });
    await dispatch('touchStart', [{ ...touch, id: 1 }]);
    await dispatch('touchMove', [{ x: touch.x - 22, y: touch.y + 19, id: 1 }]);
    await dispatch('touchEnd', []);
    const touchedY = await ev(`parseFloat(document.querySelector('${clockSelector}').style.getPropertyValue('--tile-y'))`);
    assert.equal(touchedY, Math.round((restored.y + 19) / 24) * 24);
    await click(clockSelector + ' .tile-options');
    assert(await ev('document.querySelector("#tile-options").getBoundingClientRect().bottom <= innerHeight'));
    await click('#tile-options-reset');
    assert.equal(await ev('document.querySelector("#clock-label span").textContent'), 'Местное время');
    await click('#home-cancel');
    await call('Emulation.setTouchEmulationEnabled', { enabled: false });
    await call('Emulation.clearDeviceMetricsOverride');
    console.log('Touch drag, block reset and settings access at a narrow viewport');

    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await ev('getComputedStyle(document.querySelector("main")).animationName'), 'none');
    const reducedLogo = await point('.wordmark-anchor');
    await mouse('mouseMoved', { x: reducedLogo.x - 50, y: reducedLogo.y });
    assert.deepEqual(await matrix('.wordmark'), [1, 0, 0, 1, 0, 0]);
    await click('#customize');
    await edit('#home-theme', 'dark');
    await wait('document.documentElement.dataset.colorScheme === "dark"', 'Reduced-motion theme applied');
    assert.equal(await ev('document.documentElement.getAnimations().length'), 0);
    console.log('Reduced motion disables the wallpaper and theme animations and logo movement');

    await click('#home-options-open');
    await click('#home-options-close');
    const feed = '[data-widget="feed"]';
    await ev(`document.querySelector('${feed}').scrollIntoView({block:"center"})`);
    await wait('document.querySelector("#widget-feed").textContent.includes("Atom в BrO2")', 'Atom data loads');
    assert.match(await ev('document.querySelector("#widget-feed").textContent'), /Локальная лента.*Подробности записи/);
    await click(feed + ' .tile-options');
    await edit('[data-home-field="feed"]', source + '/empty');
    await wait('document.querySelector("#widget-feed").dataset.status === "loading"', 'Loading state');
    await wait('document.querySelector("#widget-feed").textContent.includes("нет записей")', 'Empty feed');
    await edit('[data-home-field="feed"]', source + '/broken');
    await wait('document.querySelector("#widget-feed").dataset.status === "error"', 'Broken feed');
    console.log('Feed content, loading state, empty state and error state');

    await click('#home-cancel');
    await ev(`(() => {
      const layout = structuredClone(state.home);
      for (const [id, tile] of Object.entries(layout.tiles)) tile.enabled = ['logo', 'search', 'weather', 'clock'].includes(id);
      Object.assign(layout.tiles.logo, { x: 0, y: 115, w: 1200, h: 300 });
      Object.assign(layout.tiles.search, { x: 0, y: 435, w: 1200, h: 56 });
      Object.assign(layout.tiles.weather, { x: 0, y: 525, w: 630, h: 185 });
      Object.assign(layout.tiles.clock, { x: 645, y: 522, w: 555, h: 185 });
      return window.bro2.home('save', layout);
    })()`);
    await wait('state.home.tiles.logo.y === 115', 'Roomy layout saved');
    const measure = () => ev(`(() => {
      const box = (selector) => document.querySelector(selector).getBoundingClientRect();
      const main = document.querySelector('main');
      const leftEdge = box('main').left + main.clientLeft;
      const insets = (selector) => [box(selector).left - leftEdge, leftEdge + main.clientWidth - box(selector).right];
      return { logo: box('.home-logo').top - box('main').top, search: box('.home-search').top - box('main').top,
        clock: box('.home-clock').top, weather: box('.home-weather').top,
        clockX: box('.home-clock').left, weatherX: box('.home-weather').left,
        searchInsets: insets('#search-form'), cardInsets: [insets('.home-weather')[0], insets('.home-clock')[1]] };
    })()`);
    const view = (width, height) => call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    for (const [width, height] of [[1048, 803], [1240, 510]]) {
      await view(width, height);
      await wait('document.querySelector("#home").hasAttribute("data-compact")', 'Compact layout activates');
      const { logo, search, weather, clock, weatherX, clockX, searchInsets, cardInsets } = await measure();
      assert(logo <= 14 && search < 140);
      assert.equal(clock, weather);
      assert(weatherX < clockX);
      assert([...searchInsets, ...cardInsets].every((inset) => inset >= 30),
        `Compact insets at ${width} × ${height}: ${[...searchInsets, ...cardInsets]}`);
      assert.equal(await ev('state.home.tiles.logo.y'), 115);
    }
    await view(560, 380);
    await wait('getComputedStyle(document.querySelector("#home-grid")).display === "flex"', 'Single column');
    const single = await measure();
    assert.notEqual(single.clock, single.weather);
    assert([...single.searchInsets, ...single.cardInsets].every((inset) => inset >= 18));
    await click('#customize');
    assert.equal(await ev('document.querySelector(".home-logo").style.getPropertyValue("--tile-y")'), '115px');
    assert.equal(await ev('getComputedStyle(document.querySelector(".home-logo")).height'), '300px');
    await click(clockSelector + ' .tile-options');
    assert(await ev('document.querySelector("#tile-options").getBoundingClientRect().bottom <= innerHeight'));
    await click('#home-cancel');
    await call('Emulation.clearDeviceMetricsOverride');
    await wait('!document.querySelector("#home").hasAttribute("data-compact")', 'Wide layout restored');
    assert((await measure()).logo >= 115);
    console.log('Compact layout removes large gaps at 1048 px and in short windows, then restores the free layout');

    await view(1900, 1020);
    await click('#customize');
    assert(await ev('document.querySelector("#home-grid").clientWidth > 1800'));
    assert(await ev('document.querySelector("#home-snap").getAttribute("aria-pressed") === "true"'));
    const arrow = (handle, key) => ev(`document.querySelector('${clockSelector} ${handle}')
      .dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true, cancelable: true }))`);
    const clockGeometry = () => ev(`['x', 'y', 'w', 'h'].map((axis) => {
      const value = parseFloat(document.querySelector('${clockSelector}').style.getPropertyValue('--tile-' + axis));
      return axis === 'x' || axis === 'w' ? value * 12 : value;
    })`);
    await arrow('.tile-move', 'ArrowLeft');
    await arrow('.tile-move', 'ArrowDown');
    await arrow('.tile-size', 'ArrowLeft');
    const snapped = await clockGeometry();
    for (const value of [snapped[0], snapped[1], snapped[0] + snapped[2]]) {
      assert(Math.abs(value / 24 - Math.round(value / 24)) < .001);
    }
    await click('#home-snap');
    await arrow('.tile-move', 'ArrowDown');
    assert.equal((await clockGeometry())[1], snapped[1] + 1);
    await click('#home-options-open');
    await click('[data-wallpaper="dawn"]');
    await click('#home-options-close');
    await click('#home-cancel');
    assert.equal(await ev('document.documentElement.dataset.wallpaper'), 'coast');
    assert(await ev('state.home.snapToGrid'));
    await call('Emulation.clearDeviceMetricsOverride');
    console.log('The editor uses the full width and grid mode snaps movement and resize');

    const targets = () => fetch(endpoint + '/json/list').then((response) => response.json());
    const checkPopup = async (button, suffix) => {
      await click(button);
      const popup = await until(async () => (await targets()).find(({ url }) => url.endsWith(suffix)), 'Extension popup opens');
      const panel = await devtools(popup.webSocketDebuggerUrl);
      try {
        await until(() => panel.eval('document.hasFocus() && !!document.querySelector("button")'), 'Extension popup receives focus');
        if (suffix === '/extension-menu.html') {
          await until(() => panel.eval('document.body.hasAttribute("data-ready")'), 'Extension menu was drawn');
          assert.equal(await panel.eval('getComputedStyle(document.body).animationName'), 'menu-in');
        }
        await delay(250);
        await click(button);
        await wait('!state.extensionPanelOpen', 'Popup reports closed');
        await until(async () => !(await targets()).some(({ id }) => id === popup.id), 'Extension popup view is disposed');
      } finally { panel.close(); }
    };
    await call('Emulation.setEmulatedMedia', { features: [] });
    await checkPopup('#extension-button', '/extension-menu.html');
    await checkPopup('#pinned-extensions button', '/popup.html');
    console.log('The extensions menu and an installed extension popup open, receive focus and close');
  } finally {
    await stop();
    await new Promise((resolve) => fixture.close(resolve));
    assert.equal(path.dirname(await fs.realpath(dir)), temp);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 4 });
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
