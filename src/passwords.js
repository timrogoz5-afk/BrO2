const { randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { ipcMain, dialog, clipboard } = require('electron');
const { credential, httpsOrigin, parseChromePasswords } = require('./password-vault');
const { parseBookmarks, bookmarkStats, bookmarkHTML, importTicket } = require('./bookmarks');

const lifetime = 30_000;
const scriptRequestWindow = 5000;
const withoutFragment = (url) => url.split('#')[0];

function passwords({ vault, library, window, chrome, passwordPopup, browsingSession, active, settings, resize, shellURL, passwordURL, privateMode }) {
  let panel;
  let panelTimer;
  let claim;
  let panelRequest = 0;
  let importing = false;
  let settingsEpoch = 0;
  let ticket;
  let ticketTimer;
  let disposed = false;
  const handlers = [];
  const siteTabs = new Map();

  function on(channel, listener) {
    if (privateMode) return;
    ipcMain.on(channel, listener);
    handlers.push([channel, listener]);
  }

  function context(tab = active()) {
    if (privateMode || !tab || tab !== active() || !settings().site || tab.error) return null;
    const contents = tab.view.webContents;
    const state = tab.password;
    if (contents.isDestroyed() || contents.session !== browsingSession || state.navigating || !state.documentId) return null;
    const frame = contents.mainFrame;
    const origin = httpsOrigin(frame.url);
    if (!origin || frame.detached || origin !== httpsOrigin(contents.getURL()) || withoutFragment(frame.url) !== withoutFragment(tab.url)) return null;
    return { tab, frame, origin, documentId: state.documentId, form: state.form };
  }

  function sender(event, id) {
    const current = context();
    return current && event.sender === current.tab.view.webContents && event.senderFrame === current.frame &&
      id === current.documentId ? current : null;
  }

  function isChrome(event) {
    return !disposed && event.sender === chrome && event.senderFrame === chrome.mainFrame && event.senderFrame?.url === shellURL;
  }

  function sameContext(snapshot, requireForm = false) {
    const current = context(snapshot.tab);
    return current && current.frame === snapshot.frame && current.documentId === snapshot.documentId &&
      current.origin === snapshot.origin && (!requireForm || (snapshot.form && current.form === snapshot.form));
  }

  function suggest() {
    const snapshot = context();
    if (snapshot) snapshot.frame.send('password:suggest', snapshot.documentId);
  }

  function show(next, focus = false) {
    if (disposed) return;
    clearTimeout(panelTimer);
    if (next && !panel) resize(249);
    panel = next;
    passwordPopup.setVisible(Boolean(next));
    passwordPopup.webContents.send('password:panel', next?.public ?? null, focus, settings().style);
    chrome.send('password:expanded', Boolean(next));
    if (focus) passwordPopup.webContents.focus();
    if (next?.public.type === 'save') panelTimer = setTimeout(() => dismiss(), 60_000);
    if (!next) resize(0);
  }

  function dismiss(restore = false) {
    panelRequest++;
    claim = null;
    if (!panel) return;
    const old = panel;
    show(null);
    if (restore && sameContext(old.snapshot)) {
      const { frame, documentId, form, tab } = old.snapshot;
      tab.view.webContents.focus();
      if (form) frame.send('password:restore', documentId, form.id);
    }
  }

  function expire(tab) {
    const state = tab.password;
    clearTimeout(state.timer);
    state.attempt = null;
    state.timer = null;
  }

  function reset(tab) {
    dismiss();
    if (!tab) return;
    expire(tab);
    tab.password.form = undefined;
    tab.password.step = null;
  }

  function flash(snapshot, message) {
    if (sameContext(snapshot)) show({ snapshot, public: { type: 'message', origin: snapshot.origin, message } }, true);
  }

  async function list(snapshot, focus, replace = true) {
    if (!sameContext(snapshot, true) || (!replace && (claim || panel?.public.type === 'save'))) return;
    const request = ++panelRequest;
    try {
      const { entries } = await vault.list();
      if (request !== panelRequest || !sameContext(snapshot, true) || (!replace && (claim || panel?.public.type === 'save'))) return;
      const { kind, username } = snapshot.form;
      const generation = kind === 'registration' || kind === 'change';
      const matches = entries.filter((entry) => entry.origin === snapshot.origin);
      if (!generation && !matches.length && !focus) return;
      show({
        snapshot,
        public: {
          type: 'fill', origin: snapshot.origin, generation, username,
          entries: generation ? [] : matches.map(({ id, username }) => ({ id, username })),
        },
      }, focus);
    } catch {
      if (focus && request === panelRequest) flash(snapshot, 'Не удалось открыть хранилище паролей.');
    }
  }

  on('password:document', (event, id) => {
    const tab = siteTabs.get(event.sender.id);
    if (!tab || typeof id !== 'string' || tab.password.navigating ||
        event.senderFrame !== event.sender.mainFrame || !httpsOrigin(event.senderFrame?.url)) return;
    tab.password.documentId = id;
    if (tab === active()) suggest();
  });

  on('password:form', (event, data) => {
    const snapshot = sender(event, data?.documentId);
    if (!snapshot) return;
    const state = snapshot.tab.password;
    if (!data.id) {
      state.form = undefined;
      if (panel?.public.type === 'fill') dismiss();
      return;
    }
    if (!['login', 'registration', 'change', 'username'].includes(data.kind) || typeof data.username !== 'string' ||
        data.username.length > 1024 || typeof data.id !== 'string') return;
    if (state.form?.id !== data.id || state.form.username !== data.username) {
      if (panel?.public.type === 'fill' && state.form?.id !== data.id) dismiss();
      state.form = { id: data.id, kind: data.kind, username: data.username };
    }
    const next = { ...snapshot, form: state.form };
    if (data.open || panel?.public.type === 'fill') void list(next, data.focus === true, data.focus === true);
  });

  on('password:no-form', (event, id) => {
    const snapshot = sender(event, id);
    if (snapshot) flash(snapshot, 'Сфокусируй поле подходящей формы входа на этой странице.');
  });
  on('password:dismiss', (event, id) => {
    if (sender(event, id)) dismiss();
  });

  on('password:submitted', (event, submission) => {
    event.returnValue = true;
    const snapshot = sender(event, submission?.documentId);
    if (!snapshot) return;
    const { tab, origin } = snapshot;
    expire(tab);
    dismiss();
    const { kind, target, username, password, submissionId } = submission;
    if (!settings().offers || typeof target !== 'string' || target.length > 8192 || httpsOrigin(target) !== origin ||
        typeof submissionId !== 'string' || submissionId.length !== 36 ||
        !['username', 'login', 'change', 'registration'].includes(kind)) return;
    const { step } = tab.password;
    tab.password.step = null;
    const effectiveUser = username || (step?.origin === origin && step.until > Date.now() ? step.username : '');
    const entry = credential({ origin, username: effectiveUser, password });
    if (kind === 'username' ? typeof username !== 'string' || !username || username.length > 1024 : !entry) return;
    const attempt = { kind, entry, username, target, origin, documentId: snapshot.documentId, submissionId,
      time: Date.now(), started: false, post: false };
    tab.password.attempt = attempt;
    tab.password.timer = setTimeout(() => expire(tab), lifetime);
  });

  on('password:result', async (event, result) => {
    const snapshot = sender(event, result?.documentId);
    const state = snapshot?.tab.password;
    const attempt = state?.attempt;
    if (!attempt) return;
    const script = result.submissionId !== undefined;
    if (script ? !attempt.scriptOK || result.submissionId !== attempt.submissionId ||
        snapshot.documentId !== attempt.documentId : !state.result || !attempt.post) return;
    state.result = false;
    expire(snapshot.tab);
    if (attempt.time + lifetime <= Date.now() || result.errorVisible || result.codeVisible) return;
    if (attempt.kind === 'username') {
      state.step = { origin: snapshot.origin, username: attempt.username, until: Date.now() + lifetime };
      return;
    }
    if (result.passwordVisible || !settings().offers) return;
    try {
      const { entries, exceptions } = await vault.list();
      if (exceptions.includes(snapshot.origin) || !sameContext(snapshot) || !settings().offers || state.attempt) return;
      const alternatives = entries.filter((entry) => entry.origin === snapshot.origin);
      const exact = alternatives.find((entry) => entry.username === attempt.entry.username);
      if (exact && (await vault.get(exact.id, snapshot.origin))?.password === attempt.entry.password) return;
      if (!sameContext(snapshot) || state.attempt || !settings().offers) return;
      show({ snapshot, entry: attempt.entry, public: {
        type: 'save', origin: snapshot.origin, username: attempt.entry.username,
        entries: alternatives, selected: exact?.id || '',
      } });
    } catch {
      flash(snapshot, 'Не удалось проверить сохранённые записи. Повтори попытку в настройках.');
    }
  });

  async function claimPassword(event, request) {
    const snapshot = sender(event, request?.documentId);
    const selected = claim;
    if (!snapshot || !selected || request.nonce !== selected.nonce || request.formId !== snapshot.form?.id ||
        selected.used || selected.until < Date.now() || !sameContext(selected.snapshot, true)) return null;
    selected.used = true;
    try {
      let entry;
      if (selected.generation) entry = { password: randomBytes(18).toString('base64url') + 'aA1!' };
      else if (snapshot.form.kind === 'username') entry = { username: selected.username };
      else entry = await vault.get(selected.id, snapshot.origin);
      if (!entry || claim !== selected || !sameContext(selected.snapshot, true) || selected.until < Date.now() ||
          (snapshot.form.username && !selected.generation && snapshot.form.username !== entry.username)) return null;
      return { username: entry.username, password: entry.password };
    } catch {
      if (claim === selected) {
        claim = null;
        flash(snapshot, 'Не удалось расшифровать пароль. Запись сохранена для повторной попытки.');
      }
      return null;
    }
  }

  on('password:filled', (event, id, nonce, ok) => {
    const snapshot = sender(event, id);
    if (!snapshot || claim?.nonce !== nonce) return;
    claim = null;
    if (ok) dismiss(true);
    else flash(snapshot, 'Форма или её поля изменились. Проверь введённые значения и открой список снова.');
  });

  async function panelAction(action, value) {
    const snapshot = context();
    if (action === 'open') {
      if (!snapshot) {
        if (active()?.url) {
          show({ snapshot: { tab: active() }, public: { type: 'message', origin: '',
            message: 'Заполнение доступно в подходящей форме на HTTPS-сайте.' } }, true);
        }
        return;
      }
      if (panel && ['save', 'fill'].includes(panel.public.type)) {
        show(panel, true);
        return;
      }
      snapshot.frame.send('password:inspect');
      return;
    }
    if (action === 'size') {
      resize(panel ? Math.max(0, Math.min(249, Number(value) || 0)) : 0);
      return;
    }
    if (action === 'close' || action === 'hide') return dismiss(action === 'close');
    const current = panel;
    if (!current || !sameContext(current.snapshot)) return;
    if (current.public.type === 'fill' && ['fill', 'generate'].includes(action)) {
      const generation = action === 'generate';
      const entry = current.public.entries.find(({ id }) => id === value);
      if (claim || !sameContext(current.snapshot, true) || (generation ? !current.public.generation : !entry)) return;
      const selected = { snapshot: current.snapshot, nonce: randomUUID(), generation, id: entry?.id, username: entry?.username,
        until: Date.now() + 5000 };
      claim = selected;
      setTimeout(() => {
        if (claim !== selected) return;
        claim = null;
        flash(selected.snapshot, 'Форма больше недоступна. Открой список заново.');
      }, 5000).unref();
      snapshot.frame.send('password:claim', { nonce: selected.nonce, documentId: snapshot.documentId,
        formId: current.snapshot.form.id, generation });
    }
    if (current.public.type !== 'save' || !['save', 'never'].includes(action)) return;
    const id = typeof value === 'string' && current.public.entries.some((entry) => entry.id === value) ? value : undefined;
    dismiss();
    try {
      if (action === 'never') await vault.except(snapshot.origin, true);
      else await vault.save(current.entry, id);
      flash(snapshot, action === 'never' ? 'Для этого сайта предложения отключены.' : 'Пароль сохранён.');
    } catch (error) {
      if (sameContext(snapshot)) show({ ...current, public: { ...current.public, message: error.message } }, true);
    }
  }

  on('password:panel', (event, action, value) => {
    if (privateMode) return;
    const popup = passwordPopup.webContents;
    const shellAction = isChrome(event) && (action === 'open' || action === 'hide');
    const popupAction = !disposed && event.sender === popup && event.senderFrame === popup.mainFrame &&
      event.senderFrame?.url === passwordURL;
    if (shellAction || popupAction) void panelAction(action, value);
  });

  function clearTicket() {
    clearTimeout(ticketTimer);
    ticket = null;
  }

  async function openImport(kind) {
    if (importing) return null;
    clearTicket();
    importing = true;
    const epoch = settingsEpoch;
    const csv = kind === 'passwords';
    try {
      const result = await dialog.showOpenDialog(window, {
        title: csv ? 'Выбери CSV с паролями' : 'Выбери HTML с закладками',
        properties: ['openFile'],
        filters: [{ name: csv ? 'Пароли Chrome' : 'Закладки браузера', extensions: csv ? ['csv'] : ['html', 'htm'] }],
      });
      if (result.canceled || !settings().open || epoch !== settingsEpoch) return null;
      let source;
      try {
        const file = await fs.open(result.filePaths[0], 'r');
        try {
          const buffer = Buffer.alloc(8 * 1024 * 1024 + 1);
          let bytesRead = 0;
          while (bytesRead < buffer.length) {
            const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
            if (!chunk.bytesRead) break;
            bytesRead += chunk.bytesRead;
          }
          if (bytesRead === buffer.length) throw new Error();
          source = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
        } finally { await file.close(); }
      } catch { throw new Error('Не удалось прочитать файл. Нужен UTF-8 размером до 8 МБ.'); }

      const data = csv ? parseChromePasswords(source) : parseBookmarks(source);
      const summary = csv ? { ...await vault.preview(data.entries), skipped: data.skipped, errors: data.errors }
        : { ...bookmarkStats(data.roots), skipped: data.skipped };
      if (!settings().open || disposed || epoch !== settingsEpoch) return null;
      ticket = importTicket(kind, data, summary);
      ticketTimer = setTimeout(clearTicket, ticket.expires - Date.now());
      const { revision, ...publicSummary } = summary;
      return { id: ticket.id, kind, ...publicSummary };
    } finally { importing = false; }
  }

  chrome.ipc.handle('password:settings', async (event, action, value) => {
    if (privateMode || !isChrome(event) || !settings().open) return { ok: false };
    try {
      let result;
      switch (action) {
        case 'list': result = await vault.list(); break;
        case 'save': await vault.save(value, typeof value?.id === 'string' && value.id || undefined); break;
        case 'remove': if (typeof value === 'string') await vault.remove(value); break;
        case 'exception': await vault.except(httpsOrigin(value), false); break;
        case 'copy': {
          if (typeof value !== 'string') break;
          const epoch = settingsEpoch;
          const entry = await vault.get(value);
          if (!settings().open || disposed || epoch !== settingsEpoch) return { ok: false };
          if (!entry) throw new Error('Запись уже удалена.');
          clipboard.writeText(entry.password);
          break;
        }
        case 'bookmarks': result = await library.list(); break;
        case 'import-passwords': result = await openImport('passwords'); break;
        case 'import-bookmarks': result = await openImport('bookmarks'); break;
        case 'cancel-import': clearTicket(); break;
        case 'confirm-import': {
          const pending = ticket;
          if (!pending || value?.id !== pending.id || pending.expires < Date.now()) throw new Error('Выбери файл снова.');
          clearTicket();
          result = pending.kind === 'passwords'
            ? await vault.import(pending.data.entries, pending.summary, value.replace === true)
            : await library.import(pending.data.roots);
          break;
        }
        case 'export-bookmarks': {
          const items = await library.list();
          if (!settings().open || disposed) return { ok: false };
          const { canceled, filePath } = await dialog.showSaveDialog(window, {
            title: 'Сохранить закладки BrO2', defaultPath: 'BrO2-bookmarks.html',
            filters: [{ name: 'HTML', extensions: ['html'] }],
          });
          if (!canceled && settings().open && !disposed) {
            try { await fs.writeFile(filePath, bookmarkHTML(items), 'utf8'); }
            catch { throw new Error('Не удалось сохранить HTML-файл.'); }
          }
          result = !canceled;
          break;
        }
        default: return { ok: false };
      }
      return { ok: true, result };
    } catch (error) { return { ok: false, message: error.message }; }
  });

  function observePost(details) {
    const tab = active();
    const attempt = tab?.password.attempt;
    if (!attempt || details.webContentsId !== tab.view.webContents.id || details.method !== 'POST') return;
    if (details.resourceType === 'mainFrame' && withoutFragment(details.url) === attempt.target) attempt.post = true;
    if (details.resourceType === 'xhr' && !attempt.started && attempt.requestId === undefined &&
        Date.now() - attempt.time < scriptRequestWindow && httpsOrigin(details.url) === attempt.origin &&
        details.frame === tab.view.webContents.mainFrame) attempt.requestId = details.id;
  }

  function observeResponse(details) {
    if (details.resourceType !== 'xhr') return;
    const snapshot = context();
    const attempt = snapshot?.tab.password.attempt;
    if (!attempt || attempt.started || details.id !== attempt.requestId ||
        snapshot.documentId !== attempt.documentId || httpsOrigin(details.url) !== attempt.origin ||
        !Number.isInteger(details.statusCode) || details.statusCode < 200 || details.statusCode >= 300) return;
    attempt.scriptOK = true;
    snapshot.frame.send('password:result-check', snapshot.documentId, attempt.submissionId);
  }

  function attach(tab) {
    const contents = tab.view.webContents;
    if (privateMode || tab.extension || tab.source) {
      tab.password = {};
      return;
    }
    contents.ipc.handle('password:claim', claimPassword);
    const contentsId = contents.id;
    siteTabs.set(contentsId, tab);
    const state = tab.password = { navigating: true };
    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame) return;
      if (tab === active()) dismiss();
      state.form = undefined;
      state.result = false;
      const attempt = state.attempt;
      if (details.isSameDocument) return;
      if (!attempt || attempt.started || withoutFragment(details.url) !== attempt.target) expire(tab);
      else attempt.started = true;
      state.navigating = true;
      state.documentId = undefined;
      state.step = null;
    });
    contents.on('will-redirect', (details) => {
      if (!details.isMainFrame || !state.attempt) return;
      if (httpsOrigin(details.url) !== state.attempt.origin) expire(tab);
    });
    contents.on('did-navigate', (_event, url, code) => {
      state.navigating = false;
      const attempt = state.attempt;
      if (!attempt || !attempt.started || httpsOrigin(url) !== attempt.origin || code < 200 || code >= 300) expire(tab);
      else state.result = true;
    });
    contents.on('did-finish-load', () => {
      if (state.result && state.documentId) contents.mainFrame.send('password:result-check', state.documentId);
    });
    const fail = () => {
      if (tab === active()) dismiss();
      state.documentId = undefined;
      state.form = undefined;
      state.step = null;
      state.result = false;
      expire(tab);
    };
    contents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (mainFrame && code !== -3) fail();
    });
    contents.on('certificate-error', fail);
    contents.on('render-process-gone', fail);
    contents.on('destroyed', () => {
      siteTabs.delete(contentsId);
      fail();
    });
  }

  return {
    attach,
    observePost,
    observeResponse,
    suggest,
    dismiss,
    reset,
    leaveSettings() { settingsEpoch++; clearTicket(); },
    close() {
      disposed = true;
      claim = panel = null;
      clearTimeout(panelTimer);
      clearTicket();
      for (const [channel, listener] of handlers) ipcMain.removeListener(channel, listener);
      chrome.ipc.removeHandler('password:settings');
    },
  };
}

module.exports = { passwords };


