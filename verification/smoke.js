const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const os = require('node:os');
const { devtools, until } = require('./benchmark');

const server = createServer((request, response) => {
  if (request.url === '/feed.xml') {
    response.setHeader('Content-Type', 'application/atom+xml');
    return response.end('<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom в BrO2</title><link href="/article"/></entry></feed>');
  }
  response.end('<!doctype html><title>BrO2 fixture</title><input id="draft"><p>Fixture</p>');
});

let phase;
async function run() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bro2-redesign-'));
  await fs.writeFile(path.join(dir, 'preferences.json'), JSON.stringify({
    settings: { motion: false, startup: 'restore', theme: 'dark' },
    shortcuts: [{ url: origin, title: 'Тестовый сайт' }, { url: origin + '/other', title: 'Второй сайт' }],
  }));
  async function launch(...flags) {
    await fs.rm(path.join(dir, 'DevToolsActivePort'), { force: true });
    const proc = spawn(path.join(__dirname, '..', 'BrO2-portable', 'BrO2.exe'), [
      '--user-data-dir=' + dir, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--inspect=127.0.0.1:0', ...flags,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const finished = new Promise((resolve) => proc.once('exit', resolve));
    let stderr = '';
    proc.stderr.on('data', (data) => { stderr = (stderr + data).slice(-8000); });
    const links = [];
    try {
      const port = await until(async () => (await fs.readFile(path.join(dir, 'DevToolsActivePort'), 'utf8')).split('\n')[0], 'DevTools port');
      const endpoint = 'http://127.0.0.1:' + port;
      const targets = () => fetch(endpoint + '/json/list').then((reply) => reply.json());
      const attach = async (target) => {
        const connection = await devtools(target.webSocketDebuggerUrl);
        links.push(connection);
        return connection;
      };
      const chrome = await attach(await until(async () => (await targets()).find(({ url }) => url.endsWith('/src/index.html')), 'Browser shell'));
      const inspector = await attach({ webSocketDebuggerUrl: await until(() => /Debugger listening on (ws:\/\/[^\s]+)/.exec(stderr)?.[1], 'Main debugger') });
      const ready = (expression, label, timeout) => until(() => chrome.eval(expression), label, timeout);
      await ready('typeof state !== "undefined" && state && window.homeModel', 'Browser home ready');
      return { chrome, inspector, targets, attach, ready, async stop() {
        const browser = await attach(await fetch(endpoint + '/json/version').then((reply) => reply.json()));
        inspector.close();
        await Promise.race([browser.call('Browser.close').catch(() => {}), delay(2000)]);
        await Promise.race([finished, delay(5000)]);
        for (const connection of links) connection.close();
        if (proc.exitCode === null) proc.kill();
      } };
    } catch (error) {
      for (const connection of links) connection.close();
      proc.kill();
      throw new Error(error.message + '\n' + stderr);
    }
  }

  let app = await launch('--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + path.join(__dirname, 'russian-fixture.wav') + '%noloop');
  const evaluate = (expression) => app.chrome.eval(expression);
  const wait = (expression, label, timeout) => app.ready(expression, label, timeout);
  const click = (selector) => evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()');
  const send = (action, value) => evaluate('window.bro2.send(' + JSON.stringify(action) + ', ' + JSON.stringify(value) + ')');
  const main = (expression) => app.inspector.eval(expression);
  const geometry = () => evaluate(`(() => {
    const field = document.querySelector('#search-form'); const button = document.querySelector('#search-enter');
    const outer=field.getBoundingClientRect(), inner=button.getBoundingClientRect();
    return { h:outer.height, w:inner.width, height:inner.height, top:inner.top-outer.top,
      bottom:outer.bottom-inner.bottom, right:outer.right-inner.right, radius:getComputedStyle(button).borderRadius };
  })()`);
  const mouse = async (selector, type, button = 'left') => {
    const point = await evaluate(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x:r.x+r.width/2, y:r.y+r.height/2 }; })()`);
    await app.chrome.call('Input.dispatchMouseEvent', { ...point, type, button, clickCount:1 });
  };
  async function screenshot(name, selector) {
    let clip;
    if (selector) clip = await evaluate(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return {x: r.right - 125, y: r.top - 15, width: 142, height: r.height + 30, scale: 2.5}; })()`);
    await delay(100);
    const image = await app.chrome.call('Page.captureScreenshot', { format:'png', ...(clip && {clip}) });
    await fs.writeFile(path.join(__dirname,name+'.png'), Buffer.from(image.data,'base64'));
  }

  try {
    phase = 'appearance and Enter';
    await wait('!document.querySelector("#home").hidden && document.querySelector("#clock-value").textContent !== "—"', 'Rendered home');
    assert.equal(await evaluate('document.querySelector(".shortcut-open").getAttribute("aria-label")'), 'Тестовый сайт');
    await screenshot('new-tab');
    const normal = await geometry();
    assert.equal(normal.radius, '50%');
    assert.equal(normal.w, normal.height);
    assert.equal(normal.top, normal.bottom);
    assert.equal(normal.right, normal.bottom);
    await mouse('#search-enter','mouseMoved','none');
    assert.deepEqual(await geometry(), normal);
    await screenshot('enter', '#search-form');
    await evaluate('document.querySelector("#search-enter").focus()');
    assert.deepEqual(await geometry(), normal);
    await mouse('#search-enter','mousePressed');
    assert.deepEqual(await geometry(), normal);
    await mouse('#search-enter','mouseReleased');
    console.log('Enter box: '+JSON.stringify(normal));

    phase = 'Russian speech and ChatGPT';
    await mouse('#home-microphone','mousePressed');
    await mouse('#home-microphone','mouseReleased');
    try {
      await wait('/картофел/i.test(document.querySelector("#search").value)', 'Russian voice transcript', 34000);
      console.log('Windows portable speech (synthetic Russian audio): ' + await evaluate('document.querySelector("#search").value'));
    } catch (error) {
      console.log('Windows portable speech: ' + await evaluate('document.querySelector("#home-voice-status").textContent'));
      throw error;
    }
    const homeId = await evaluate('state.active');
    await evaluate('document.querySelector("#search").value = "сохранить запрос";');
    await click('#home-chatgpt');
    await wait('state.active !== '+homeId+' && state.tabs.length === 2', 'ChatGPT in a new tab');
    await wait('state.tabs.some(tab=>tab.url.startsWith("https://chatgpt.com/"))', 'ChatGPT destination', 24000);
    console.log('ChatGPT opens a new tab and retains the search text.');
    await send('select', homeId);
    await wait('state.active === '+homeId, 'Home tab selected');
    assert.equal(await evaluate('document.querySelector("#search").value'), 'сохранить запрос');
    await evaluate('document.querySelector("#search").value = "";');

    phase = 'settings and responsive appearance';
    await click('#settings');
    await wait('state.settingsOpen', 'Settings shown');
    await click('[data-category="privacy"]');
    await screenshot('settings');
    await evaluate('const q = document.querySelector("#settings-query"); q.value="домены и поддомены"; q.dispatchEvent(new Event("input"));');
    await wait('document.querySelector("#settings-result-list button")', 'Setting by description');
    await click('#settings-result-list button');
    assert(await evaluate('document.querySelector("#memory-exceptions").parentElement.classList.contains("setting-highlight")'));
    await send('preference', { key: 'theme', value: 'light' });
    await wait('state.settings.theme === "light"', 'Light theme');
    await screenshot('settings-light');
    await click('#settings-close');
    await wait('!state.settingsOpen', 'Settings back');
    await screenshot('new-tab-light');
    await app.chrome.call('Emulation.setDeviceMetricsOverride',{width:560,height:640,deviceScaleFactor:1.5,mobile:false});
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#home-grid")).display'), 'flex');
    const narrow = await geometry();
    assert.equal(narrow.top, narrow.right);
    assert.equal(narrow.w, narrow.height);
    await screenshot('new-tab-narrow');
    await app.chrome.call('Emulation.clearDeviceMetricsOverride');

    phase = 'home layout, keyboard, preview and Atom';
    await click('#customize');
    assert(await evaluate('document.querySelector("#home").classList.contains("is-editing")'));
    await evaluate(`document.querySelector('[data-widget=search] .tile-move')
      .dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown',bubbles:true}))`);
    const moved = await evaluate('document.querySelector("[data-widget=search]").style.getPropertyValue("--tile-row")');
    assert.equal(moved, '4 / span 1');
    await click('#home-options-open');
    await click('[data-wallpaper="coast"]');
    await click('[data-home-toggle="feed"]');
    await evaluate(`const f=document.querySelector('[data-home-field=feed]'); f.value=${JSON.stringify(origin+'/feed.xml')}; f.dispatchEvent(new Event('change'));`);
    await click('[data-home-field="shortcutIcon"]');
    await click('[data-home-field="shortcutTitle"]');
    await click('#home-options-close');
    await click('#home-preview');
    assert.equal(await evaluate('document.querySelector("#home").classList.contains("is-editing")'), false);
    await click('#home-save');
    await wait('state.home.wallpaper === "coast" && !state.home.shortcutIcon && !state.home.shortcutTitle && state.home.tiles.search.y === 3', 'Saved home customization');
    assert(await evaluate('document.querySelector(".shortcut-open").getAttribute("aria-label")'));
    await evaluate('document.querySelector("[data-widget=feed]").scrollIntoView()');
    await wait('document.querySelector("#widget-feed").textContent.includes("Atom в BrO2")', 'Local Atom feed');

    phase = 'group drag, name, color, vertical tabs and saved groups';
    await send('new');
    await wait('!state.url && state.active !== '+homeId, 'Fixture tab created');
    await send('go', origin+'/first');
    await wait('state.url.endsWith("/first")', 'First grouped page');
    const first = await evaluate('state.active');
    await send('new');
    await wait('!state.url && state.active !== '+first, 'Second fixture tab created');
    await send('go', origin+'/second');
    await wait('state.url.endsWith("/second")', 'Second grouped page');
    const second = await evaluate('state.active');
    const token = require('node:crypto').randomUUID();
    await send('tab-drag-start', { id: second, token });
    await send('tab-drop', { targetId:first, token, combine:true });
    await wait('state.tabs.filter(t=>t.group).length === 2', 'Group made with tab drag');
    const group = await evaluate('state.tabs.find(t=>t.group).group.id');
    await main(`(() => {const {Menu} = process.mainModule.require('electron');
      Menu.prototype.popup=function(){globalThis.checkedMenu=this};})()`);
    await send('group-menu', {id:group,x:10,y:20});
    await until(() => main('Boolean(globalThis.checkedMenu)'), 'Native group context menu');
    await main('checkedMenu.items.find(i=>i.label==="Имя и цвет группы").click()');
    await wait('state.toolPage === "group-settings"', 'Group editor');
    await evaluate('document.querySelector("#group-settings-name").value="Проект";document.querySelector("#group-settings-color").value="#5dca91";document.querySelector("#group-settings-page").requestSubmit()');
    await wait('state.tabs.find(t=>t.group)?.group.title === "Проект"', 'Group name and color saved');
    await send('toggle-group', group);
    await wait('state.tabs.find(t=>t.group).group.collapsed', 'Collapsed group');
    assert.equal(await evaluate('document.querySelectorAll(".tab.grouped").length'), 1);
    await app.chrome.call('Input.dispatchKeyEvent',{ type:'keyDown', key:',', code:'Comma', windowsVirtualKeyCode:188, modifiers:10 });
    await wait('state.verticalTabs', 'Vertical tabs mode');
    await main('checkedMenu.items.find(i=>i.label==="Сохранить и закрыть группу").click()');
    await wait('state.tabs.every(t=>!t.group)', 'Group saved and closed');
    await send('show-saved-groups');
    await wait('state.savedGroups.length === 1', 'Saved groups list');

    phase = 'restart, migration and lazy reload';
    await app.stop();
    app = await launch('--force-device-scale-factor=1.25');
    await wait('state.home.wallpaper === "coast" && state.shortcuts.length === 2 && state.verticalTabs', 'Profile reused after restart');
    await send('show-saved-groups');
    await wait('state.savedGroups[0]?.title === "Проект"', 'Group available after restart');
    await click('#saved-groups-list button');
    await wait('state.tabs.filter(t=>t.group).length === 2 && state.url.endsWith("/first")', 'Saved group opened after restart');
    const groupTabs = await evaluate('state.tabs.filter(t=>t.group).map(t=>[t.url,t.suspended,t.group.color])');
    assert.deepEqual(groupTabs, [[origin+'/first',false,'#5dca91'],[origin+'/second',true,'#5dca91']]);
    await send('select', await evaluate('state.tabs.find(t=>t.url.endsWith("/second")).id'));
    await wait('state.url.endsWith("/second") && state.tabs.find(t=>t.id===state.active).suspended === false', 'Deferred tab restored on selection');
    console.log('Settings search, legacy shortcuts, layout and group persistence, simulated 150% and launch at 125%, Atom and restoration passed.');

    phase = 'automatic discard, domain exceptions and dirty forms';
    const site = await app.attach(await until(async () => (await app.targets()).find(({ url }) => url === origin+'/second'), 'Web page'));
    await site.eval('document.querySelector("#draft").focus()');
    await site.call('Input.insertText', { text: 'черновик' });
    await until(() => site.eval('document.querySelector("#draft").value === "черновик"'), 'Unsaved input present');
    const exception = origin.replace('127.0.0.1', 'localhost') + '/exception';
    await send('new');
    await wait('!state.url && !state.loading', 'New tab for exception');
    await send('go', exception);
    await wait('state.url === ' + JSON.stringify(exception) + ' && !state.loading', 'Exception loaded');
    await send('new');
    await wait('!state.url && !state.loading', 'Home foreground');
    await click('#settings');
    await wait('state.settingsOpen', 'Memory settings open');
    await send('preference', {key:'memoryIdle',value:1});
    await send('preference', {key:'memoryExceptions',value:['http://localhost']});
    await send('preference', {key:'memorySaver',value:true});
    await wait('state.settings.memorySaver && state.settings.memoryIdle===1 && state.settings.memoryExceptions[0]==="localhost"', 'Memory preferences persisted');
    await click('#settings-close');
    await main('globalThis.originalNow = Date.now; Date.now = () => originalNow()+125000');
    try {
      await wait('state.tabs.find(tab=>tab.url.endsWith("/first")).suspended', 'Inactive tab automatically discarded', 18000);
      assert(await evaluate('!state.tabs.find(tab=>tab.url.endsWith("/second")).suspended'));
      assert(await evaluate('!state.tabs.find(tab=>tab.url.endsWith("/exception")).suspended'));
    } finally { await main('Date.now = originalNow'); }
    await send('select', await evaluate('state.tabs.find(tab=>tab.url.endsWith("/first")).id'));
    await wait('state.url.endsWith("/first") && !state.tabs.find(tab=>tab.id===state.active).suspended', 'Discarded tab reloads');
    console.log('Automatic discarding, domain exceptions, protection of unsaved input and reload verified.');

    phase = 'private groups and home';
    const known = new Set((await app.targets()).map(({id}) => id));
    await app.chrome.call('Input.dispatchKeyEvent',{type:'keyDown',key:'n',code:'KeyN',windowsVirtualKeyCode:78,modifiers:10});
    const privateChrome = await app.attach(await until(async () => (await app.targets()).find(({ id, url }) =>
      !known.has(id) && url.endsWith('/src/index.html')), 'Incognito window'));
    await until(() => privateChrome.eval('typeof state !== "undefined" && state?.privateMode'), 'Incognito state');
    assert.equal(await privateChrome.eval('state.home'), undefined);
    assert.equal(await privateChrome.eval('state.shortcuts.length'), 0);
    await privateChrome.eval('window.bro2.send("show-saved-groups")');
    await delay(200);
    assert.equal(await privateChrome.eval('state.toolPage'), '');
    console.log('Saved groups, wallpaper and shortcuts stayed private to the regular profile.');
  } finally {
    await app.stop().catch(() => {});
  }
}
run().catch((error) => { console.error(phase + ': ' + error.stack); process.exitCode = 1; })
  .finally(() => { server.closeAllConnections(); server.close(); });
