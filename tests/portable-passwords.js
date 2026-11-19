const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { X509Certificate, createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const { createServer } = require('node:https');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const oldSecret = 'bro2-synthetic-before-8444';
const newSecret = 'bro2-synthetic-after-9149';
const profile = { name: 'Тестовый профиль', email: 'fixture@example.test' };
const login = (action = '/login', attributes = '', username = true) => `
  <form method="post" action="${action}" ${attributes}>
  ${username ? '<label>Login <input id="login" name="login" autocomplete="username"></label>' : ''}
  <label>Password <input id="secret" name="secret" type="password" autocomplete="current-password"></label>
  <button id="submit">Sign in</button></form>`;
const registration = (action = '/register', fields = '') => `
  <form method="post" action="${action}">
  <label>Login <input id="login" name="login" autocomplete="username"></label>
  ${fields}<label>New password <input id="secret" name="secret" type="password" autocomplete="new-password"></label>
  <label>Confirm password <input id="confirm" name="confirm" type="password" autocomplete="new-password"></label>
  <button id="submit">Save</button></form>`;
const page = (body) => '<!doctype html><meta charset="utf-8"><title>BrO2 HTTPS fixture</title>' +
  '<style>body{margin:300px 55px 0;font:16px sans-serif} form{display:grid;gap:15px;justify-items:start} iframe{height:440px;width:500px}</style>' + body;

async function until(operation, description, timeout = 6500) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const result = await operation();
      if (result) return result;
    } catch (error) { last = error.message; }
    await delay(95);
  }
  throw new Error(description + (last ? ` (${last})` : ''));
}

async function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function devtools(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  ws.addEventListener('message', ({ data }) => {
    const reply = JSON.parse(data);
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    if (reply.error) request.reject(new Error(reply.error.message));
    else request.resolve(reply.result);
  });
  ws.addEventListener('close', () => {
    for (const request of pending.values()) request.reject(new Error('DevTools target closed'));
    pending.clear();
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('Could not connect to local DevTools')), { once: true });
  });
  void opened.catch(() => {});
  async function call(method, params) {
    await opened;
    return new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  return {
    close: () => ws.close(),
    call,
    async evaluate(expression) {
      const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    },
    async click(selector) {
      if (target.url.endsWith('/src/index.html')) {
        await this.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
        return;
      }
      const point = await this.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        element.scrollIntoView({ block: 'nearest' });
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x: x + width / 2, y: y + height / 2 };
      })()`);
      await call('Input.dispatchMouseEvent', { ...point, type: 'mousePressed', button: 'left', clickCount: 1 });
      await call('Input.dispatchMouseEvent', { ...point, type: 'mouseReleased', button: 'left', clickCount: 1 });
    },
    async key(key, code, windowsVirtualKeyCode, modifiers = 0) {
      const params = { key, code, windowsVirtualKeyCode, modifiers };
      await call('Input.dispatchKeyEvent', { ...params, type: 'keyDown', ...(key === 'Enter' ? { text: '\r' } : {}) });
      await call('Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
    },
  };
}

async function run() {
  const temp = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temp, 'bro2-e2e-'));
  const userData = path.join(directory, 'profile');
  const connections = [];
  const servers = [];
  let processHandle;
  let logs = '';
  let submissionCount = 0;
  let origin;
  let otherOrigin;
  let pdfContents;
  let translationInput;
  let phase = 'setup';
  try {
    execFileSync('pwsh.exe', ['-NoProfile', '-File', path.join(__dirname, 'new-test-certificate.ps1'), directory], { windowsHide: true });
    const pfx = await fs.readFile(path.join(directory, 'fixture.pfx'));
    const publicKey = new X509Certificate(await fs.readFile(path.join(directory, 'fixture.cer'))).publicKey;
    const spki = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    const serve = async (request, response) => {
      const url = new URL(request.url, 'https://fixture.test');
      const send = (body, code = 200) => {
        response.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(page(body));
      };
      const redirect = (location) => {
        response.writeHead(303, { Location: location });
        response.end();
      };
      const route = url.pathname;
      if (route === '/reader-fixture') {
        return send('<article><h1>Fixture headline</h1><p>' + 'Readable fixture paragraph. '.repeat(10) + '</p></article>');
      }
      if (route === '/inline.pdf' && pdfContents) {
        response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline' });
        return response.end(pdfContents);
      }
      if (route === '/translate-fixture' && request.method === 'POST') {
        let body = '';
        for await (const chunk of request) body += chunk;
        translationInput = JSON.parse(body);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        return response.end(JSON.stringify({ translatedText: translationInput.q.map((chunk) => 'Traduit ' + chunk) }));
      }
      if (route === '/download-fixture') {
        response.writeHead(200, { 'Content-Disposition': 'attachment; filename=fixture.txt', 'Content-Type': 'text/plain' });
        return response.end('BrO2 download fixture');
      }
      if (route === '/slow-fixture') {
        setTimeout(() => { if (!response.destroyed) send(login()); }, 3500).unref();
        return;
      }
      if (request.method === 'POST') {
        let body = '';
        for await (const chunk of request) body += chunk;
        const values = new URLSearchParams(body);
        submissionCount++;
        if (route === '/script-auth') {
          response.writeHead(values.get('secret') === 'rejected' ? 401 : 204);
          return response.end();
        }
        if (route === '/direct') return send('<h1 id="account">Account</h1>');
        if (route === '/step-one') return redirect('/step-two');
        if (route === '/otp') return redirect('/code');
        if (values.get('secret') === 'rejected') return redirect('/wrong');
        return redirect('/account');
      }
      if (route === '/account') return send('<h1 id="account">Account</h1>');
      if (route === '/direct') return send(login('/direct'));
      if (route === '/script-login') return send(login().replace('method="post"', '') + `<script>
        document.querySelector('form').addEventListener('submit', async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const response = await fetch('/script-auth', { method: 'POST', body: new URLSearchParams(new FormData(form)) });
          if (!response.ok) {
            const error = document.createElement('p');
            error.role = 'alert';
            error.textContent = 'Wrong password';
            form.append(error);
            return;
          }
          form.replaceWith(Object.assign(document.createElement('h1'), { id: 'account', textContent: 'Account' }));
          history.replaceState(null, '', '/script-account');
        });
      </script>`);
      if (route === '/wrong') return send('<p role="alert">Wrong password</p>' + login());
      if (route === '/registration') return send(registration());
      if (route === '/change') return send(registration('/change', '<input type="password" autocomplete="current-password" name="old">'));
      if (route === '/cross') return send(login(otherOrigin + '/login'));
      if (route === '/override') return send(login().replace('id="submit"', `id="submit" formaction="${otherOrigin}/login"`));
      if (route === '/frame') return send('<iframe src="/login"></iframe>');
      if (route === '/step-one') return send('<form action="/step-one" method="post"><input id="login" name="login" autocomplete="username"><button id="submit">Next</button></form>');
      if (route === '/step-two') return send(login('/login', '', false));
      if (route === '/otp') return send(login('/otp'));
      if (route === '/code') return send('<form method="post"><input id="code" autocomplete="one-time-code" type="password"><button>Send</button></form>');
      if (route === '/dynamic') return send(`<button id="show" onclick="document.querySelector('template').replaceWith(document.querySelector('template').content)">Show</button><template>${login()}</template>`);
      return send(login());
    };
    const secure = createServer({ pfx, passphrase: 'bro2-test' }, serve);
    const second = createServer({ pfx, passphrase: 'bro2-test' }, serve);
    const untrusted = createServer({ pfx: await fs.readFile(path.join(directory, 'untrusted.pfx')), passphrase: 'bro2-test' }, serve);
    const plain = http.createServer(serve);
    servers.push(secure, second, untrusted, plain);
    origin = `https://localhost:${await listen(secure)}`;
    otherOrigin = `https://localhost:${await listen(second)}`;
    const invalidOrigin = `https://localhost:${await listen(untrusted)}`;
    const httpOrigin = `http://localhost:${await listen(plain)}`;
    const featureTest = process.env.BRO2_TEST_FEATURES === '1';
    const extensionFolder = path.join(directory, 'test-extension');
    if (featureTest) {
      await fs.mkdir(extensionFolder);
      await fs.writeFile(path.join(extensionFolder, 'manifest.json'), JSON.stringify({
        manifest_version: 3, name: '__MSG_extensionName__', default_locale: 'en', version: '1.0',
        description: 'Synthetic local extension',
        content_scripts: [{ matches: ['https://localhost/*'], js: ['script.js'], css: ['theme.css'] }],
        action: { default_popup: 'page.html' },
      }));
      await fs.mkdir(path.join(extensionFolder, '_locales', 'en'), { recursive: true });
      await fs.writeFile(path.join(extensionFolder, '_locales', 'en', 'messages.json'),
        JSON.stringify({ extensionName: { message: 'BrO2 Fixture Extension' } }));
      await fs.writeFile(path.join(extensionFolder, 'script.js'), "document.body.dataset.bro2Extension = 'on';");
      await fs.writeFile(path.join(extensionFolder, 'theme.css'), 'body { background-color: rgb(20, 24, 31); color: white; }');
      await fs.writeFile(path.join(extensionFolder, 'page.html'), page('<h1 id="extension-page">Fixture extension UI</h1>'));
    }
    await fs.mkdir(userData);
    await fs.writeFile(path.join(userData, 'preferences.json'), JSON.stringify({
      settings: { motion: false, theme: 'light' }, profile,
      shortcuts: [{ url: origin + '/', title: 'Тестовый ярлык' }],
    }));

    let endpoint;
    let browser;
    let popup;
    let inspector;
    let site;
    async function start() {
      await fs.rm(path.join(userData, 'DevToolsActivePort'), { force: true });
      processHandle = spawn(path.join(__dirname, '..', 'BrO2-portable', 'BrO2.exe'), [
        `--user-data-dir=${userData}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
        '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
        `--ignore-certificate-errors-spki-list=${spki}`,
        ...(featureTest ? ['--inspect=127.0.0.1:0', '--use-fake-device-for-media-stream'] : []),
      ]);
      processHandle.on('error', (error) => { logs += error.message; });
      let inspectURL;
      let inspectLog = '';
      processHandle.stderr.on('data', (chunk) => {
        logs += chunk;
        inspectLog = (inspectLog + chunk).slice(-4000);
        inspectURL ||= /Debugger listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/.exec(inspectLog)?.[1];
      });
      const port = await until(async () => (await fs.readFile(path.join(userData, 'DevToolsActivePort'), 'utf8')).split('\n')[0], 'Electron did not start', 12000);
      endpoint = `http://127.0.0.1:${port}`;
      const list = () => fetch(endpoint + '/json/list').then((response) => response.json());
      browser = devtools(await until(async () => (await list()).find((target) => target.url.endsWith('/src/index.html')), 'BrO2 chrome did not open'));
      popup = devtools(await until(async () => (await list()).find((target) => target.url.endsWith('/src/password-panel.html')), 'BrO2 password panel did not load'));
      connections.push(browser, popup);
      await until(() => browser.evaluate('typeof state === "object"'), 'BrO2 chrome did not initialize');
      if (featureTest) {
        inspector = devtools({ webSocketDebuggerUrl: await until(() => inspectURL, 'Main test inspector unavailable'), url: '' });
        connections.push(inspector);
        await inspector.call('Runtime.enable');
      }
      site = undefined;
    }
    async function stop() {
      const version = await fetch(endpoint + '/json/version').then((response) => response.json());
      const control = devtools(version);
      const exited = new Promise((resolve) => processHandle.once('exit', resolve));
      inspector?.close();
      void control.call('Browser.close').catch(() => {});
      await Promise.race([exited, delay(4000)]);
      control.close();
      if (processHandle.exitCode === null) processHandle.kill();
      await exited;
    }
    async function go(url, selector = '#submit') {
      await browser.evaluate(`bro2.send('go', ${JSON.stringify(url)})`);
      if (!selector) return;
      await until(() => browser.evaluate(`state.url === ${JSON.stringify(url)} && !state.loading`), 'Fixture navigation did not finish');
      const target = await until(async () => {
        const targets = await fetch(endpoint + '/json/list').then((response) => response.json());
        return targets.find((item) => item.url === url);
      }, 'Could not open fixture route: ' + url);
      site?.close();
      site = devtools(target);
      connections.push(site);
      await until(() => site.evaluate(`document.readyState === 'complete' && Boolean(document.querySelector(${JSON.stringify(selector)}))`), 'Fixture page did not become ready');
      await site.call('Page.bringToFront', {});
    }
    async function offered() {
      return popup.evaluate('!document.querySelector("#password-panel").hidden');
    }
    async function waitPanel(text) {
      await until(() => popup.evaluate(`!document.querySelector('#password-panel').hidden &&
        document.querySelector('#password-panel').textContent.includes(${JSON.stringify(text)})`), 'Missing panel: ' + text);
      await until(() => popup.evaluate('document.querySelector("#password-panel").offsetHeight <= innerHeight'), 'The password panel is clipped');
    }
    async function noPanel() {
      await delay(330);
      assert.equal(await offered(), false, 'Unexpected password panel');
    }
    async function screenshot(target, name) {
      const destination = process.env.BRO2_TEST_SCREENSHOTS;
      if (!destination) return;
      await fs.mkdir(destination, { recursive: true });
      const { data } = await target.call('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(path.join(destination, name + '.png'), Buffer.from(data, 'base64'));
    }
    async function submit(username, password, withEnter = false) {
      const before = submissionCount;
      await site.evaluate(`(() => { const username = document.querySelector('#login');
        if (username) username.value = ${JSON.stringify(username)};
        const password = document.querySelector('#secret');
        if (password) password.value = ${JSON.stringify(password)};
      })()`);
      if (withEnter) {
        await site.click('#secret');
        await site.evaluate('document.querySelector("#secret").focus()');
        await until(() => site.evaluate('document.activeElement.id === "secret"'), 'Click did not focus the password field');
        await site.key('Enter', 'Enter', 13);
        await delay(280);
        if (submissionCount === before) await site.key('Enter', 'Enter', 13);
      } else await site.click('#submit');
      if (before === submissionCount) {
        try { await until(() => submissionCount > before, 'Waiting for the fixture to receive the input', 500); }
        catch {
          // Embedded views can miss CDP input when Windows changes the foreground window.
          await site.call('Runtime.evaluate', {
            expression: 'document.querySelector("form").requestSubmit(document.querySelector("#submit"))',
            userGesture: true,
          });
        }
      }
      await until(() => submissionCount > before, 'The fixture did not receive a form submission');
    }
    async function chooseSave() {
      await popup.click('#password-panel .primary');
      await waitPanel('Пароль сохранён');
      await popup.key('Escape', 'Escape', 27);
      await noPanel();
    }
    async function fill(first, expected) {
      const prior = submissionCount;
      await site.evaluate('document.querySelector("#secret").focus()');
      await waitPanel(first);
      await site.key('ArrowDown', 'ArrowDown', 40, 1);
      await until(() => popup.evaluate('document.activeElement.classList.contains("password-login")'), 'Keyboard focus did not move to the saved login');
      await popup.key('Enter', 'Enter', 13);
      await until(() => site.evaluate(`document.querySelector('#secret').value === ${JSON.stringify(expected)}`), 'Filled password did not match');
      await until(() => site.evaluate('document.activeElement.id === "secret"'), 'Focus did not return to the form');
      assert.equal(submissionCount, prior, 'Fill submitted the form');
    }

    phase = 'start and migrate old profile';
    await start();
    assert.equal(await browser.evaluate('state.settings.motion'), 'off');
    assert.deepEqual(await browser.evaluate('state.account.profile'), profile);
    assert.equal(await browser.evaluate('state.shortcuts[0].title'), 'Тестовый ярлык');
    await screenshot(browser, 'home-light');
    if (featureTest) {
      phase = 'install a local MV3 extension and run its content script';
      await inspector.evaluate(`(() => {
        const { dialog } = process.mainModule.require('electron');
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(extensionFolder)}] });
      })()`);
      const siteTab = await browser.evaluate('state.active');
      await browser.click('#extension-button');
      await until(() => browser.evaluate('state.toolPage === "extensions" && !document.querySelector("#extension-page").hidden'), 'Extensions tab did not open');
      assert.notEqual(await browser.evaluate('state.active'), siteTab, 'Extensions reused the open page tab');
      await browser.click('#extension-add');
      await until(() => browser.evaluate('document.querySelector("#extension-review").open'), 'Extension review did not open');
      assert(await browser.evaluate('document.querySelector("#extension-review-name").textContent.includes("BrO2 Fixture Extension")'));
      assert(await browser.evaluate('document.querySelector("#extension-access").textContent.includes("https://localhost/*")'));
      await browser.click('#extension-cancel');
      await until(() => browser.evaluate('!document.querySelector("#extension-review").open && document.activeElement.id === "extension-add"'), 'Closing review did not return focus');
      assert.equal(await inspector.evaluate(`process.mainModule.require('electron').session
        .fromPartition('persist:bro2-web').extensions.getAllExtensions().length`), 0, 'Extension loaded before confirmation');
      await browser.click('#extension-add');
      await until(() => browser.evaluate('document.querySelector("#extension-review").open'), 'Extension review did not reopen');
      assert.equal(await fs.readFile(path.join(extensionFolder, 'script.js'), 'utf8'), "document.body.dataset.bro2Extension = 'on';");
      await browser.click('#extension-install');
      await until(() => browser.evaluate('document.querySelector("#extension-list").textContent.includes("Включено")'), 'The extension did not activate');
      await go(origin + '/extension-first');
      await until(() => site.evaluate('document.body.dataset.bro2Extension === "on"'), 'Extension content script did not run');
      assert.equal(await site.evaluate('getComputedStyle(document.body).backgroundColor'), 'rgb(20, 24, 31)');
    }

    phase = 'login on Enter, save, and check disk';
    await go(origin + '/login');
    await submit('first', oldSecret, true);
    await waitPanel('Сохранить пароль?');
    await screenshot(popup, 'save-light');
    await chooseSave();
    const vaultFile = path.join(userData, 'passwords.json');
    const encrypted = await fs.readFile(vaultFile, 'utf8');
    assert(!encrypted.includes(oldSecret));
    assert(!String(await fs.readFile(path.join(userData, 'preferences.json'))).includes(oldSecret));
    assert.equal(JSON.parse(encrypted).entries.length, 1);

    phase = 'restart and fill with keyboard';
    await stop();
    await start();
    await go(origin + '/login');
    if (featureTest) await until(() => site.evaluate('document.body.dataset.bro2Extension === "on"'), 'Extension did not restore after restart');
    await waitPanel('first');
    assert.equal(await site.evaluate('document.querySelector("#secret").value'), '');
    await fill('first', oldSecret);
    assert.equal(await site.evaluate('document.querySelector("#login").value'), 'first');

    phase = 'rejected login does not replace old password';
    await go(origin + '/login');
    await submit('first', 'rejected');
    await until(() => site.evaluate('location.pathname === "/wrong"'), 'Denial fixture did not load');
    await noPanel();
    assert.equal(await fs.readFile(vaultFile, 'utf8'), encrypted);

    phase = 'update the same login and add a second login';
    await go(origin + '/login');
    await submit('first', newSecret);
    await waitPanel('Обновить пароль?');
    await chooseSave();
    await go(origin + '/login');
    await submit('second', oldSecret);
    await waitPanel('Сохранить пароль?');
    await chooseSave();
    assert.equal(JSON.parse(await fs.readFile(vaultFile, 'utf8')).entries.length, 2);
    await go(origin + '/login');
    await site.evaluate('document.querySelector("#login").value = "first"');
    await fill('first', newSecret);

    phase = 'direct and scripted submissions';
    await go(origin + '/direct');
    await submit('direct-user', oldSecret);
    await waitPanel('direct-user');
    await popup.key('Escape', 'Escape', 27);
    await go(origin + '/script-login');
    await submit('script-user', 'rejected');
    await until(() => site.evaluate('document.querySelector("[role=alert]")?.textContent'), 'Scripted denial did not appear');
    await noPanel();
    await go(origin + '/script-login?retry');
    await submit('script-user', oldSecret);
    await waitPanel('script-user');
    await popup.key('Escape', 'Escape', 27);

    phase = 'two-step and one-time code';
    await go(origin + '/step-one');
    await site.evaluate('document.querySelector("#login").value = "step-user"');
    await site.click('#submit');
    await until(() => site.evaluate('location.pathname === "/step-two"'), 'Second step did not load');
    await submit('', oldSecret);
    await waitPanel('step-user');
    await chooseSave();
    await go(origin + '/otp');
    await submit('first', 'pending-otp');
    await until(() => site.evaluate('location.pathname === "/code"'), 'One-time code form did not load');
    await site.click('#code');
    await noPanel();

    phase = 'dynamic fields and Escape';
    await go(origin + '/dynamic', '#show');
    await site.click('#show');
    await site.evaluate('document.querySelector("#secret").focus()');
    await waitPanel('first');
    await site.key('ArrowDown', 'ArrowDown', 40, 1);
    await popup.key('Escape', 'Escape', 27);
    await noPanel();
    assert.equal(await site.evaluate('document.activeElement.id'), 'secret');
    await site.key('ArrowDown', 'ArrowDown', 40, 1);
    await waitPanel('first');
    await site.evaluate('document.querySelector("#secret").replaceWith(document.querySelector("#secret").cloneNode())');
    await noPanel();

    phase = 'registration and change password generation';
    await go(origin + '/registration');
    await site.evaluate('document.querySelector("#secret").focus()');
    await waitPanel('Создать надёжный пароль');
    await site.key('ArrowDown', 'ArrowDown', 40, 1);
    await popup.key('Enter', 'Enter', 13);
    await until(() => site.evaluate('document.querySelector("#secret").value.length >= 24 && document.querySelector("#secret").value === document.querySelector("#confirm").value'), 'Generated passwords did not match');
    await site.evaluate('document.querySelector("#login").value="registered"');
    await site.click('#submit');
    await waitPanel('registered');
    await chooseSave();
    await go(origin + '/change');
    await site.evaluate('document.querySelector("#secret").focus()');
    await waitPanel('Создать надёжный пароль');
    await popup.key('Escape', 'Escape', 27);
    await noPanel();

    phase = 'exact origin, HTTP, iframe, action, and certificate';
    for (const address of [otherOrigin + '/login', origin.replace('localhost', '127.0.0.1') + '/login',
      httpOrigin + '/login', origin + '/cross', origin + '/override']) {
      await go(address);
      await site.evaluate('document.querySelector("#secret").focus()');
      await noPanel();
    }
    await go(origin + '/frame', 'iframe');
    await until(() => site.evaluate('document.querySelector("iframe").contentDocument.querySelector("#secret") !== null'), 'Iframe did not load');
    await site.evaluate('document.querySelector("iframe").contentDocument.querySelector("#secret").focus()');
    await noPanel();
    await go(invalidOrigin + '/login', null);
    await until(() => browser.evaluate('!document.querySelector("#failure").hidden'), 'Invalid certificate did not show an error');
    assert.equal(await browser.evaluate('document.querySelector("#password-button").hidden'), true);
    await screenshot(browser, 'certificate-light');

    phase = 'navigation before password selection';
    await go(origin + '/login');
    await site.evaluate('document.querySelector("#secret").focus();');
    await waitPanel('first');
    await go(otherOrigin + '/login');
    await noPanel();
    assert.equal(await site.evaluate('document.querySelector("#secret").value'), '');

    phase = 'tab change and settings';
    await go(origin + '/login');
    await site.evaluate('document.querySelector("#secret").focus()');
    await waitPanel('first');
    await browser.click('#new');
    await noPanel();
    await browser.click('#settings');
    await until(() => browser.evaluate('state.settingsOpen'), 'Settings not opened');
    await browser.evaluate('document.querySelector("#password-settings").open = true');
    await until(() => browser.evaluate('document.querySelector("#password-entries").textContent.includes("step-user")'), 'Vault settings unavailable');
    await browser.evaluate('document.querySelector("#password-search").value = "registered"; document.querySelector("#password-search").dispatchEvent(new Event("input"))');
    assert.equal(await browser.evaluate('document.querySelectorAll("#password-entries li").length'), 1);
    await browser.click('#password-entries li button');
    await until(() => browser.evaluate('document.querySelector("#password-editor").open'), 'Password editor did not open');
    await browser.key('Escape', 'Escape', 27);
    assert.equal(await browser.evaluate('state.settingsOpen && !document.querySelector("#password-editor").open'), true);

    phase = 'manual add, edit, and delete';
    await browser.click('#password-add');
    await browser.evaluate(`document.querySelector('#password-origin').value = ${JSON.stringify(otherOrigin)};
      document.querySelector('#password-username').value = "manual";
      document.querySelector('#password-secret').value = ${JSON.stringify(oldSecret)};`);
    await browser.click('#password-editor-save');
    await until(() => browser.evaluate('!document.querySelector("#password-editor").open'), 'Could not add a password manually');
    await browser.evaluate('document.querySelector("#password-search").value = "manual"; document.querySelector("#password-search").dispatchEvent(new Event("input"))');
    await until(() => browser.evaluate('document.querySelector("#password-entries").textContent.includes("manual")'), 'Manual record not found');
    await browser.click('#password-entries li button');
    await browser.evaluate(`document.querySelector('#password-secret').value = ${JSON.stringify(newSecret)};`);
    await browser.click('#password-editor-save');
    await until(() => browser.evaluate('!document.querySelector("#password-editor").open'), 'Could not edit the manual password');
    await browser.click('#password-entries li button:last-child');
    await browser.click('#password-remove-confirm');
    await until(() => browser.evaluate('document.querySelector("#password-entries").textContent.includes("Совпадений нет")'), 'Deleted entry stayed in settings');

    phase = 'exception and regular tab controls';
    await browser.key('Escape', 'Escape', 27);
    await until(() => browser.evaluate('!state.settingsOpen'), 'Escape did not close settings');
    await go(otherOrigin + '/login');
    await submit('never', 'test-exception');
    await waitPanel('Сохранить пароль?');
    await popup.click('#password-panel .vault-actions button:last-child');
    await waitPanel('предложения отключены');
    await popup.key('Escape', 'Escape', 27);
    await go(otherOrigin + '/login');
    await submit('never', 'test-exception');
    await until(() => site.evaluate('location.pathname === "/account"'), 'Exception fixture did not load');
    await noPanel();
    await browser.click('#new');
    await until(() => browser.evaluate('!state.url && state.tabs.length === 3'), 'New tab did not open');
    await browser.click('.tab.active .close');
    await until(() => browser.evaluate('state.tabs.length === 2'), 'Tab did not close');
    await browser.click('#settings');
    await until(() => browser.evaluate('state.settingsOpen && document.querySelector("#password-exceptions").textContent.includes("localhost")'), 'Exception not shown in settings');

    phase = 'dark mode and reduced motion';
    await browser.evaluate("bro2.send('preference', {key:'theme',value:'dark'}); bro2.send('preference', {key:'motion',value:'expressive'})");
    await until(() => browser.evaluate('state.settings.motion === "expressive" && state.settings.theme === "dark"'), 'Settings did not persist');
    await browser.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await until(() => browser.evaluate('!document.querySelector("#motion-system").hidden && document.querySelector("#motion-preview").disabled'), 'System reduced motion did not override the preset');
    assert(await browser.evaluate('document.querySelector("#motion").getBoundingClientRect().width >= 130'));
    await browser.evaluate('window.scrollTo(0, 0)');
    await screenshot(browser, 'settings-dark');
    await browser.key('Escape', 'Escape', 27);
    await until(() => browser.evaluate('!state.settingsOpen'), 'Escape did not close settings');
    await go(origin + '/login');
    await popup.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await site.evaluate('document.querySelector("#secret").focus();');
    await waitPanel('first');
    assert.equal(await popup.evaluate('getComputedStyle(document.querySelector("#password-panel")).animationName'), 'none');
    assert.equal(await popup.evaluate('document.documentElement.dataset.theme'), 'dark');
    await screenshot(popup, 'logins-dark');
    if (featureTest) {
      phase = 'extension action, disable, enable and remove';
      await browser.click('#extension-button');
      await until(() => browser.evaluate('state.toolPage === "extensions" && document.querySelector("#extension-list").textContent.includes("Включено")'), 'Restored extension not listed');
      await browser.evaluate('Array.from(document.querySelectorAll("#extension-list button")).find(b => b.textContent === "Открыть").click()');
      await until(() => browser.evaluate('state.url.startsWith("chrome-extension:")'), 'Extension page did not open');
      const extensionTarget = await until(async () => (await fetch(endpoint + '/json/list').then((response) => response.json()))
        .find((target) => target.url.startsWith('chrome-extension:') && target.url.endsWith('/page.html')), 'Extension tab missing');
      const extensionTab = devtools(extensionTarget);
      connections.push(extensionTab);
      assert.equal(await extensionTab.evaluate('document.querySelector("#extension-page").textContent'), 'Fixture extension UI');
      await browser.click('#extension-button');
      await until(() => browser.evaluate('state.toolPage === "extensions"'), 'Extensions tab did not reopen');
      await browser.click('#extension-list li button');
      await until(() => browser.evaluate('!state.tabs.some(tab => tab.url.startsWith("chrome-extension:"))'), 'Disabled extension retained open pages');
      await go(origin + '/extension-disabled');
      await delay(350);
      assert.equal(await site.evaluate('document.body.dataset.bro2Extension'), undefined);
      assert.notEqual(await site.evaluate('getComputedStyle(document.body).backgroundColor'), 'rgb(20, 24, 31)');
      await site.evaluate('document.cookie = "bro2Fixture=regular; Secure; Path=/"');
      await browser.click('#extension-button');
      await until(() => browser.evaluate('state.toolPage === "extensions" && document.querySelector("#extension-list").textContent.includes("Отключено")'), 'Disabled state not shown');
      await browser.click('#extension-list li button');
      await until(() => browser.evaluate('document.querySelector("#extension-list").textContent.includes("Включено")'), 'Extension did not re-enable');

      phase = 'private window is isolated from regular extension and history';
      const known = new Set((await fetch(endpoint + '/json/list').then((response) => response.json())).map((target) => target.id));
      const key = (letter, modifiers = 2) => browser.key(letter, 'Key' + letter.toUpperCase(), letter.toUpperCase().charCodeAt(0), modifiers);
      await key('n', 10);
      const privateTarget = await until(async () => (await fetch(endpoint + '/json/list').then((response) => response.json()))
        .find((target) => !known.has(target.id) && target.url.endsWith('/src/index.html')), 'Ctrl+Shift+N did not open another window');
      const privateBrowser = devtools(privateTarget);
      connections.push(privateBrowser);
      await until(() => privateBrowser.evaluate('state?.privateMode'), 'Window is not in incognito mode');
      assert(await privateBrowser.evaluate('document.querySelector("#extension-button").hidden'));
      await privateBrowser.evaluate(`bro2.send('go', ${JSON.stringify(origin + '/extension-private')})`);
      const privateSite = devtools(await until(async () => (await fetch(endpoint + '/json/list').then((response) => response.json()))
        .find((target) => target.url === origin + '/extension-private'), 'Private page did not open'));
      connections.push(privateSite);
      await until(() => privateSite.evaluate('document.querySelector("#submit")'), 'Private fixture did not render');
      assert.equal(await privateSite.evaluate('document.body.dataset.bro2Extension'), undefined);
      assert.equal(await privateSite.evaluate('document.cookie.includes("bro2Fixture")'), false);
      assert.equal(await privateBrowser.evaluate('state.history.length'), 0);
      assert(await privateBrowser.evaluate('document.querySelector("#password-button").hidden'));
      await inspector.evaluate("process.mainModule.require('electron').BaseWindow.getAllWindows().find(w => w.getTitle().includes('Инкогнито')).close()");
      await browser.evaluate('Array.from(document.querySelectorAll("#extension-list button")).find(b => b.textContent === "Удалить").click()');
      await until(() => browser.evaluate('document.querySelector("#extension-list").textContent.includes("Расширений пока нет")'), 'Extension was not removed');

      phase = 'shortcuts for tabs, home, find, zoom, bookmark, history, downloads and tasks';
      await go(origin + '/keys');
      const count = await browser.evaluate('state.tabs.length');
      await key('t');
      await until(() => browser.evaluate(`state.tabs.length === ${count + 1} && !state.url`), 'Ctrl+T failed');
      await go(origin + '/restore-key');
      await key('w');
      await until(() => browser.evaluate(`state.tabs.length === ${count}`), 'Ctrl+W failed');
      await key('t', 10);
      await until(() => browser.evaluate(`state.url.endsWith('/restore-key') && state.tabs.length === ${count + 1}`), 'Ctrl+Shift+T failed');
      await browser.key('1', 'Digit1', 49, 2);
      await until(() => browser.evaluate('state.active === state.tabs[0].id'), 'Ctrl+1 failed');
      await browser.key('9', 'Digit9', 57, 2);
      await until(() => browser.evaluate('state.active === state.tabs.at(-1).id'), 'Ctrl+9 failed');
      await browser.key('PageUp', 'PageUp', 33, 2);
      await until(() => browser.evaluate('state.active === state.tabs.at(-2).id'), 'Ctrl+PageUp failed');
      await go(origin + '/find-fixture');
      await site.click('#login');
      await until(() => site.evaluate('document.activeElement.id === "login"'), 'Find fixture input did not get focus');
      await key('f');
      await until(() => browser.evaluate('state.find'), 'Ctrl+F failed');
      const find = devtools(await until(async () => (await fetch(endpoint + '/json/list').then((response) => response.json()))
        .find((target) => target.url.endsWith('/src/find.html')), 'Find popup did not open'));
      connections.push(find);
      await until(() => find.evaluate('document.activeElement.id === "find-text"'), 'Find did not focus its field');
      await find.evaluate('field.value = "Password"; field.dispatchEvent(new Event("input"));');
      await until(() => find.evaluate('document.querySelector("#find-count").textContent === "1 из 1"'), 'Find results not reported');
      await find.evaluate('field.value = "missing text"; field.dispatchEvent(new Event("input"));');
      await until(() => find.evaluate('document.querySelector("#find-count").textContent === "0 из 0"'), 'Find empty results not reported');
      await browser.key('Escape', 'Escape', 27);
      await until(() => browser.evaluate('!state.find'), 'Escape did not close find');
      await until(() => site.evaluate('document.hasFocus()'), 'Escape did not return focus to the page');
      const initialWidth = await site.evaluate('innerWidth');
      await browser.key('+', 'Equal', 187, 10);
      await until(() => site.evaluate(`innerWidth < ${initialWidth}`), 'Zoom in failed');
      await until(() => browser.evaluate('!document.querySelector("#zoom-level").hidden'), 'Zoom percentage did not appear');
      await browser.key('0', 'Digit0', 48, 2);
      await until(() => site.evaluate(`innerWidth === ${initialWidth}`), 'Zoom reset failed');
      await until(() => browser.evaluate('document.querySelector("#zoom-level").textContent === "100%"'), 'Zoom reset did not show 100%');
      await key('d');
      await key('b', 10);
      await until(() => browser.evaluate('state.bookmarkBar && document.querySelector("#bookmarks-bar button")'), 'Bookmark bar did not show the new bookmark');
      await key('h');
      await until(() => browser.evaluate('state.toolPage === "history" && document.querySelector("#tool-entries").textContent.includes("/find-fixture")'), 'Ctrl+H failed');
      assert(!await browser.evaluate('document.querySelector("#tool-entries").textContent.includes("/extension-private")'));
      await key('j');
      await until(() => browser.evaluate('state.toolPage === "downloads"'), 'Ctrl+J failed');
      await browser.key('Escape', 'Escape', 27, 8);
      await until(() => browser.evaluate('state.toolPage === "tasks" && document.querySelector("#tool-entries").textContent.includes("PID")'), 'Shift+Escape failed');
      await browser.key('Escape', 'Escape', 27);
      await until(() => browser.evaluate('!state.toolPage'), 'Escape did not close task view');
      await browser.key('Home', 'Home', 36, 1);
      await until(() => browser.evaluate('!state.url && !document.querySelector("#home").hidden'), 'Alt+Home failed');
      await until(() => browser.evaluate('document.querySelector("#browser-notice").hidden'), 'Status notice did not clear');
      await screenshot(browser, 'tab-redesign');

      phase = 'navigation shortcuts and ordinary window';
      await go(origin + '/keys-last-a');
      await go(origin + '/keys-last-b');
      await site.evaluate('document.querySelector("#login").focus(); document.querySelector("#login").value = "xy";');
      await site.key('Backspace', 'Backspace', 8);
      assert.equal(await site.evaluate('location.pathname'), '/keys-last-b');
      await site.evaluate('document.querySelector("#login").blur()');
      await site.key('Backspace', 'Backspace', 8);
      await until(() => browser.evaluate('state.url.endsWith("/keys-last-a")'), 'Backspace did not go back');
      await site.key('Backspace', 'Backspace', 8, 8);
      await until(() => browser.evaluate('state.url.endsWith("/keys-last-b")'), 'Shift+Backspace did not go forward');
      await browser.key('F6', 'F6', 117);
      await until(() => browser.evaluate('document.activeElement.id === "address" && document.querySelector("#address").selectionStart === 0'), 'F6 did not focus the address');
      const existingWindows = await inspector.evaluate("process.mainModule.require('electron').BaseWindow.getAllWindows().map(w=>w.id)");
      await key('n');
      const normalWindow = await until(() => inspector.evaluate(`process.mainModule.require('electron').BaseWindow.getAllWindows()
        .find(w => !${JSON.stringify(existingWindows)}.includes(w.id) && w.getTitle() === 'BrO2')?.id`), 'Ctrl+N did not open a regular window');
      await inspector.evaluate(`process.mainModule.require('electron').BaseWindow.fromId(${normalWindow}).close()`);

      phase = 'page source, saving, download and print dispatch';
      await go(origin + '/keys-extra');
      await key('u');
      await until(() => browser.evaluate('state.url.startsWith("view-source:")'), 'Ctrl+U did not open the page source');
      await until(() => inspector.evaluate(`(() => {
        const contents = process.mainModule.require('electron').webContents.getAllWebContents()
          .find(w => w.getURL().startsWith('view-source:'));
        return contents?.executeJavaScript(
          'Boolean(document.querySelector(".line-content")) && document.body.textContent.includes("<form")');
      })()`), 'Chromium did not render the original page source');
      await browser.key('F4', 'F4', 115, 2);
      await until(() => browser.evaluate('!state.tabs.some(tab => tab.url.startsWith("view-source:"))'), 'Ctrl+F4 did not close the source tab');
      await go(origin + '/actions-fixture');
      const pageCopy = path.join(directory, 'page.mhtml');
      const downloaded = path.join(directory, 'fixture.txt');
      await inspector.evaluate(`(() => {
        const electron = process.mainModule.require('electron');
        const contents = electron.webContents.getAllWebContents().find(w => w.getURL().endsWith('/actions-fixture'));
        electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath: ${JSON.stringify(pageCopy)} });
        contents.print = (_options, done) => { globalThis.bro2PrintCalled = true; done(true); };
        contents.session.once('will-download', (_event, item) => item.setSavePath(${JSON.stringify(downloaded)}));
      })()`);
      await key('p');
      await until(() => inspector.evaluate('Boolean(globalThis.bro2PrintCalled)'), 'Ctrl+P did not dispatch print');
      await key('s');
      await until(async () => (await fs.readFile(pageCopy, 'utf8')).includes('multipart/related'), 'Ctrl+S did not save an MHTML archive');
      await browser.evaluate(`bro2.send('go', ${JSON.stringify(origin + '/download-fixture')})`);
      await until(async () => (await fs.readFile(downloaded, 'utf8')) === 'BrO2 download fixture', 'Download file was not written');
      await key('j');
      await until(() => browser.evaluate('state.toolPage === "downloads" && document.querySelector("#tool-entries").textContent.includes("fixture.txt")'), 'Download was not listed');
      await browser.key('Escape', 'Escape', 27);

      phase = 'fullscreen, developer tools, hard refresh and stop loading';
      const mainWindow = "process.mainModule.require('electron').BaseWindow.getAllWindows().find(w => w.getTitle() === 'BrO2')";
      await browser.key('F11', 'F11', 122);
      await until(() => inspector.evaluate(mainWindow + '.isFullScreen()'), 'F11 did not enter fullscreen');
      await browser.key('F11', 'F11', 122);
      await until(async () => !await inspector.evaluate(mainWindow + '.isFullScreen()'), 'F11 did not exit fullscreen');
      const actualPage = "process.mainModule.require('electron').webContents.getAllWebContents().find(w => w.getURL().endsWith('/actions-fixture'))";
      await browser.key('F12', 'F12', 123);
      await until(() => inspector.evaluate(actualPage + '?.isDevToolsOpened()'), 'F12 did not open developer tools');
      await inspector.evaluate(actualPage + '?.closeDevTools()');
      await inspector.evaluate(`(() => {
        const contents = ${actualPage};
        const original = contents.reloadIgnoringCache.bind(contents);
        contents.reloadIgnoringCache = () => { globalThis.bro2HardReload = true; original(); };
      })()`);
      await key('r', 10);
      await until(() => inspector.evaluate('Boolean(globalThis.bro2HardReload)'), 'Ctrl+Shift+R did not bypass cache');
      await until(() => browser.evaluate('!state.loading'), 'Hard refresh did not finish');
      await browser.evaluate(`bro2.send('go', ${JSON.stringify(origin + '/slow-fixture')})`);
      await until(() => browser.evaluate('state.loading'), 'Slow fixture did not start loading');
      await browser.key('Escape', 'Escape', 27);
      await until(() => browser.evaluate('!state.loading && state.url.endsWith("/actions-fixture")'), 'Escape did not cancel navigation');
      console.log('Extensions, tab shortcuts, windows, incognito, navigation, zoom, fullscreen, find, bookmarks, downloads, tasks, source, save, developer tools and print command passed.');

      phase = 'search tabs, manage bookmark folders and delete individual visits';
      await go(origin + '/managed-bookmark');
      await key('d');
      await key('o', 10);
      await until(() => browser.evaluate('state.toolPage === "bookmarks" && document.querySelector("#bookmarks-list").textContent.includes("/managed-bookmark")'), 'Bookmark manager did not open');
      await browser.click('#bookmarks-new-folder');
      await browser.evaluate('document.querySelector("#bookmarks-name").value = "Fixture folder"; document.querySelector("#bookmarks-form").requestSubmit()');
      await until(() => browser.evaluate('!document.querySelector("#bookmarks-dialog").open && state.bookmarks.some(item => item.name === "Fixture folder")'), 'Bookmark folder did not save');
      await browser.evaluate(`[...document.querySelectorAll('#bookmarks-list li')].find(row => row.textContent.includes('/managed-bookmark'))
        .querySelector('[data-bookmark-action="edit"]').click()`);
      await browser.evaluate(`document.querySelector('#bookmarks-destination').value = state.bookmarks.find(item => item.name === 'Fixture folder').id;
        document.querySelector('#bookmarks-form').requestSubmit()`);
      await until(() => browser.evaluate('state.bookmarks.find(item => item.name === "Fixture folder").children[0]?.url.endsWith("/managed-bookmark")'), 'Bookmark did not move');
      await browser.key('Escape', 'Escape', 27);
      await key('t');
      await go(origin + '/tab-search-fixture');
      await key('a', 10);
      await until(() => browser.evaluate('state.toolPage === "tab-search"'), 'Ctrl+Shift+A did not open tab search');
      await browser.evaluate(`document.querySelector('#tab-query').value = 'managed-bookmark';
        document.querySelector('#tab-query').dispatchEvent(new Event('input'));
        document.querySelector('#tool-entries button').click()`);
      await until(() => browser.evaluate('state.url.endsWith("/managed-bookmark") && !state.toolPage'), 'Tab search did not switch tabs');
      await key('h');
      await until(() => browser.evaluate('state.toolPage === "history" && document.querySelector("#tool-entries").textContent.includes("/tab-search-fixture")'), 'History visit missing');
      await browser.evaluate(`[...document.querySelectorAll('#tool-entries li')].find(row => row.textContent.includes('/tab-search-fixture')).lastElementChild.click()`);
      await until(() => browser.evaluate('!state.history.some(visit => visit.url.endsWith("/tab-search-fixture"))'), 'Individual visit remained in history');

      phase = 'site permission prompt, cookie clearing, and permission persistence';
      await go(origin + '/site-permissions-fixture');
      await inspector.evaluate(`(() => {
        const { dialog, BaseWindow } = process.mainModule.require('electron');
        globalThis.originalMessageBox = dialog.showMessageBox;
        dialog.showMessageBox = async (_window, options) => { globalThis.fixturePrompt = options.message; return { response: 0 }; };
        BaseWindow.getAllWindows().find(w => w.getTitle() === 'BrO2').focus();
      })()`);
      assert.equal(await site.evaluate('Notification.requestPermission()'), 'granted');
      assert((await inspector.evaluate('globalThis.fixturePrompt')).includes(origin));
      assert.equal(await site.evaluate(`navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then(stream => {
        const tracks = stream.getTracks();
        tracks.forEach(track => track.stop());
        return tracks.length;
      })`), 2);
      assert((await inspector.evaluate('globalThis.fixturePrompt')).includes('камере'));
      await inspector.evaluate("process.mainModule.require('electron').dialog.showMessageBox = globalThis.originalMessageBox");
      await site.evaluate('document.cookie = "bro2ClearSite=fixture; Secure; Path=/"');
      assert(await site.evaluate('document.cookie.includes("bro2ClearSite")'));
      await browser.click('#address-icon');
      await until(() => browser.evaluate('state.toolPage === "site-settings" && document.querySelector("[data-site-rule=notifications]").value === "allow"'), 'Site permission was not shown');
      await browser.click('#site-clear-open');
      await browser.click('#site-clear-dialog button[value=confirm]');
      await until(async () => !await site.evaluate('document.cookie.includes("bro2ClearSite")'), 'Site cookie did not clear');

      phase = 'reader translation, explicit provider action, and PDF export';
      await go(origin + '/reader-fixture', 'article');
      await browser.click('#settings');
      await until(() => browser.evaluate('state.settingsOpen'), 'Translation settings did not open');
      await browser.evaluate(`document.querySelector('#translation-settings').open = true;
        document.querySelector('#translation-endpoint').value = ${JSON.stringify(httpOrigin + '/translate-fixture')};
        document.querySelector('#translation-form').requestSubmit()`);
      await until(() => browser.evaluate('Boolean(state.translation)'), 'Translation configuration did not save');
      await browser.click('#settings');
      const chooseMenuItem = async (label) => {
        await inspector.evaluate(`(() => {
          const { Menu } = process.mainModule.require('electron');
          const original = Menu.prototype.popup;
          globalThis.bro2MenuChosen = false;
          const find = (items) => items.flatMap(item => [item, ...find(item.submenu?.items || [])]);
          Menu.prototype.popup = function(options) {
            Menu.prototype.popup = original;
            const choice = find(this.items).find(item => item.label === ${JSON.stringify(label)});
            options.callback?.();
            if (choice?.enabled) {
              globalThis.bro2MenuChosen = true;
              choice.click({}, options.window);
            }
          };
        })()`);
        await browser.click('#browser-menu');
        await until(() => inspector.evaluate('globalThis.bro2MenuChosen'), 'Browser menu action unavailable: ' + label);
      };
      await chooseMenuItem('Режим чтения');
      await until(() => browser.evaluate('state.toolPage === "reader" && document.querySelector("#reader-page").textContent.includes("Fixture headline")'), 'Reader did not open');
      assert.equal(translationInput, undefined);
      await browser.click('#reader-translate');
      await until(() => browser.evaluate('document.querySelector("#reader-page").textContent.includes("Traduit Fixture headline")'), 'Translated text did not render');
      assert.equal(translationInput.target, 'ru');
      assert(translationInput.q.some((part) => part.includes('Readable fixture paragraph')));
      const originalText = await browser.evaluate('document.querySelector("#reader-page").textContent');
      assert(!originalText.includes('<article'));
      await browser.click('#reader-original');
      await until(() => browser.evaluate('!document.querySelector("#reader-page").textContent.includes("Traduit")'), 'Original text did not return');
      await browser.key('Escape', 'Escape', 27);
      const pdfPath = path.join(directory, 'reader-fixture.pdf');
      await inspector.evaluate(`process.mainModule.require('electron').dialog.showSaveDialog =
        async () => ({ canceled: false, filePath: ${JSON.stringify(pdfPath)} })`);
      await chooseMenuItem('Сохранить страницу в PDF…');
      await until(async () => (pdfContents = await fs.readFile(pdfPath)).subarray(0, 5).toString() === '%PDF-', 'PDF export did not produce a file');
      await go(origin + '/inline.pdf', null);
      const pdfTarget = devtools(await until(async () => (await fetch(endpoint + '/json/list').then((response) => response.json()))
        .find((target) => target.url === origin + '/inline.pdf'), 'Inline PDF target did not appear'));
      connections.push(pdfTarget);
      await until(async () => {
        if (await pdfTarget.evaluate('Boolean(document.querySelector("embed[type*=pdf]"))')) return true;
        // Recent Chromium versions host the viewer and PDF stream in separate frame targets.
        const targets = await fetch(endpoint + '/json/list').then((response) => response.json());
        return targets.some(({ type, url }) => type === 'iframe' && url === origin + '/inline.pdf') &&
          targets.some(({ type, url }) => type === 'iframe' && url === 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html');
      }, 'Chromium PDF viewer did not attach');

      phase = 'local profile isolation';
      await go(origin + '/primary-profile');
      await site.evaluate('document.cookie = "bro2ProfileFixture=primary; Secure; Path=/"');
      await browser.click('#settings');
      await until(() => browser.evaluate('state.settingsOpen'), 'Settings did not open for profile creation');
      const profileTargets = new Set((await fetch(endpoint + '/json/list').then((response) => response.json())).map(({ id }) => id));
      await browser.click('#local-profile-create');
      await browser.evaluate('document.querySelector("#local-profile-name").value = "Fixture alt"; document.querySelector("#local-profile-form").requestSubmit()');
      const alternate = devtools(await until(async () => (await fetch(endpoint + '/json/list').then((response) => response.json()))
        .find((target) => !profileTargets.has(target.id) && target.url.endsWith('/src/index.html')), 'Local profile did not open'));
      connections.push(alternate);
      await until(() => alternate.evaluate('state?.localProfileId && state.localProfileId !== "default"'), 'Alternate profile ID unavailable');
      assert.deepEqual(await alternate.evaluate('[state.history.length, state.bookmarks.length, state.account.profile]'), [0, 0, null]);
      phase = 'alternate profile does not see the primary cookie';
      await alternate.evaluate(`bro2.send('go', ${JSON.stringify(origin + '/alternate-profile')})`);
      await until(() => alternate.evaluate('state.url.endsWith("/alternate-profile") && !state.loading'), 'Alternate profile did not finish loading');
      const alternateSite = devtools(await until(async () => (await fetch(endpoint + '/json/list').then((response) => response.json()))
        .find((target) => target.url === origin + '/alternate-profile'), 'Alternate profile page did not open'));
      connections.push(alternateSite);
      assert.equal(await alternateSite.evaluate('document.cookie.includes("bro2ProfileFixture")'), false);
      phase = 'switch back to the primary profile';
      await alternate.click('#settings');
      await until(() => alternate.evaluate('state.settingsOpen'), 'Alternate profile settings did not open');
      await alternate.evaluate(`document.querySelector('#local-profile-choice').value = 'default';
        document.querySelector('#local-profile-choice').dispatchEvent(new Event('change'));
        document.querySelector('#local-profile-open').click()`);
      await until(async () => JSON.parse(await fs.readFile(path.join(userData, 'profiles.json'), 'utf8')).selected === 'default', 'Primary profile did not become selected');
      await inspector.evaluate("process.mainModule.require('electron').BaseWindow.getAllWindows().find(w => w.getTitle().includes('Fixture alt')).close()");

      phase = 'restart restores multiple windows and ordinary navigation history';
      await go(origin + '/before-session');
      await go(origin + '/active-session');
      await browser.click('#settings');
      await until(() => browser.evaluate('state.settingsOpen'), 'Startup settings did not open');
      await browser.evaluate(`document.querySelector('#startup-mode').value = 'restore';
        document.querySelector('#startup-mode').dispatchEvent(new Event('change'))`);
      await until(() => browser.evaluate('state.settings.startup === "restore"'), 'Startup selection did not save');
      await key('n');
      const extraWindow = devtools(await until(async () => (await fetch(endpoint + '/json/list').then((response) => response.json()))
        .find((target) => !profileTargets.has(target.id) && target.url.endsWith('/src/index.html')), 'Second window did not open'));
      connections.push(extraWindow);
      await until(() => extraWindow.evaluate('state?.localProfileId === "default"'), 'Second window has the wrong profile');
      await extraWindow.evaluate(`bro2.send('go', ${JSON.stringify(origin + '/second-session')})`);
      await until(() => extraWindow.evaluate('state.url.endsWith("/second-session") && !state.loading'), 'Second window did not finish loading');
      await stop();
      await start();
      await until(async () => {
        const urls = (await fetch(endpoint + '/json/list').then((response) => response.json())).map(({ url }) => url);
        return urls.includes(origin + '/active-session') && urls.includes(origin + '/second-session');
      }, 'Startup did not restore both ordinary windows');
      assert(await inspector.evaluate(`process.mainModule.require('electron').webContents.getAllWebContents()
        .find(w => w.getURL().endsWith('/active-session')).navigationHistory.canGoBack()`));
      console.log('Bookmark folders, tab search, visit deletion, site permissions, site data, local profile isolation and multi-window session restore passed.');
      phase = 'HTTP link forwarded from Windows launch arguments';
      const external = spawn(path.join(__dirname, '..', 'BrO2-portable', 'BrO2.exe'),
        [`--user-data-dir=${userData}`, '--', origin + '/external-launch'], { windowsHide: true });
      await new Promise((resolve, reject) => { external.once('error', reject); external.once('exit', resolve); });
      await until(async () => (await fetch(endpoint + '/json/list').then((response) => response.json()))
        .some((target) => target.url === origin + '/external-launch'), 'External URL was not forwarded into BrO2');
    }
    assert(!logs.includes(oldSecret) && !logs.includes(newSecret));
    await stop();
    console.log('Portable Electron: automatic suggestions, secure restart and fill, native and scripted sign-in, updates, two-step forms, OTP, TLS, iframe isolation, navigation, settings, themes, and reduced motion passed.');
  } catch (error) {
    console.error(`Portable check failed in phase "${phase}" after ${submissionCount} form submissions: ${error.message}`);
    console.error(logs.slice(-4000));
    process.exitCode = 1;
  } finally {
    if (processHandle?.exitCode === null) processHandle.kill();
    connections.forEach((connection) => connection.close());
    servers.forEach((server) => { server.close(); server.closeAllConnections(); });
    assert.equal(path.dirname(await fs.realpath(directory)), temp);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

