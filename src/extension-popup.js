const { WebContentsView } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { webURL } = require('./address');
const { wallpaperNames } = require('./home-layout');

const menuFile = path.join(__dirname, 'extension-menu.html');
const menuURL = pathToFileURL(menuFile).href;

function extensionPopup({ window, extensions, browsingSession, isolated, appearance, dismissOverlays,
  redraw, layout, focusButton, publish, changed, manage, openTab, shortcut, report }) {
  let current;
  let exiting;

  function dispose({ view }) {
    if (!window.isDestroyed()) window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
  }

  function finishExit() {
    if (!exiting) return;
    const popup = exiting;
    exiting = undefined;
    clearTimeout(popup.exitTimer);
    dispose(popup);
  }

  function duration(anchor) {
    if (anchor.allowMotion !== true) return 0;
    const { motion } = appearance();
    return motion === 'expressive' ? 240 : motion === 'normal' ? 180 : 0;
  }

  function close(restoreFocus = false, animate = false) {
    finishExit();
    if (!current) return;
    const popup = current;
    const { view, anchor, bounds } = popup;
    current = undefined;
    const time = animate && popup.ready && !window.isDestroyed() && !view.webContents.isDestroyed()
      ? Math.round(duration(anchor) * .65) : 0;
    if (time) {
      exiting = popup;
      view.webContents.on('before-mouse-event', (event) => event.preventDefault());
      view.setBounds({ ...bounds, y: Math.max(0, bounds.y - 10) }, { animate: { duration: time, easing: 'ease-in' } });
      popup.exitTimer = setTimeout(finishExit, time);
    } else dispose(popup);
    publish();
    if (restoreFocus) focusButton(anchor.id);
  }

  function resize(width, height) {
    if (!current) return;
    const margin = 8;
    const xMax = width - margin;
    const popupWidth = Math.min(current.width, Math.max(1, width - 2 * margin));
    const right = Math.min(xMax, Math.max(margin + popupWidth, width - current.right));
    const y = Math.min(current.y, height - 1);
    const bounds = { x: right - popupWidth, y, width: popupWidth,
      height: Math.min(current.height, Math.max(1, height - y - margin)) };
    if (current.bounds && Object.keys(bounds).every((key) => bounds[key] === current.bounds[key])) return;
    current.bounds = bounds;
    const remaining = Math.ceil(current.entranceEnd - performance.now());
    if (remaining > 0) {
      current.view.setBounds(bounds, { animate: { duration: remaining, easing: 'ease-out' } });
    } else current.view.setBounds(bounds);
  }

  async function rows(popup) {
    const settings = { ...appearance(), animateMenu: duration(popup.anchor) > 0 };
    if (Object.hasOwn(wallpaperNames, popup.anchor.wallpaper)) settings.wallpaper = popup.anchor.wallpaper;
    try {
      const entries = await extensions.list();
      if (current !== popup) return;
      popup.height = Math.min(490, 108 + Math.max(1, entries.length) * 44);
      layout();
      popup.view.webContents.send('extension-menu:state', entries, settings);
    } catch (error) {
      if (current === popup) popup.view.webContents.send('extension-menu:state', [], settings, error.message);
    }
  }

  async function show(anchor, id) {
    const { right, bottom } = anchor ?? {};
    if (!Number.isFinite(right) || !Number.isFinite(bottom) || right < 0 || bottom < 0 || bottom > 96) return;
    if (current && current.id === id) { close(true, true); return; }
    const url = id === undefined ? menuURL : extensions.page(id, 'action');
    if (!url) { report('Панель расширения недоступна.'); return; }
    const extensionId = id === undefined ? undefined : new URL(url).host;
    close();
    dismissOverlays();
    const view = new WebContentsView({
      webPreferences: { ...isolated, ...(extensionId ? { session: browsingSession, enablePreferredSizeMode: true }
        : { partition: 'bro2-interface', preload: path.join(__dirname, 'extension-menu-preload.js') }) },
    });
    const contents = view.webContents;
    const popup = { view, id, extensionId, anchor, right, y: Math.round(bottom + 5),
      width: extensionId ? 360 : 338, height: extensionId ? 250 : 152, ready: false, entranceEnd: 0 };
    current = popup;
    view.setBackgroundColor(extensionId ? '#ffffff' : '#00000000');
    view.setBorderRadius(12);
    view.setVisible(false);
    contents.on('will-navigate', (event) => {
      if (extensionId && extensions.isPage(event.url, extensionId)) return;
      event.preventDefault();
      const target = extensionId && webURL(event.url);
      if (target && current === popup) {
        close();
        openTab(target, true);
      }
    });
    contents.on('will-redirect', (event) => {
      if (event.isMainFrame && (!extensionId || !extensions.isPage(event.url, extensionId))) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('content-bounds-updated', (event) => event.preventDefault());
    contents.on('before-input-event', (event, input) => {
      if (current !== popup) event.preventDefault();
      else if (input.type === 'keyDown' && input.key === 'Escape' && !input.isComposing) {
        event.preventDefault();
        close(true, true);
      } else shortcut(event, input);
    });
    contents.on('render-process-gone', () => { if (current === popup) close(true); });
    contents.once('destroyed', () => { if (current === popup) close(true); });
    contents.setWindowOpenHandler(({ url: target, disposition }) => {
      if (extensionId && current === popup) {
        const page = webURL(target);
        const local = extensions.isPage(target, extensionId);
        if (page || local) {
          close();
          openTab(page || target, disposition !== 'background-tab', local ? extensionId : undefined);
        }
      }
      return { action: 'deny' };
    });
    if (extensionId) {
      contents.on('preferred-size-changed', (_event, size) => {
        if (current !== popup) return;
        popup.width = Math.min(640, Math.max(170, size.width));
        popup.height = Math.min(600, Math.max(80, size.height));
        layout();
      });
    } else {
      contents.ipc.on('extension-menu:action', async (event, action, selectedId) => {
        if (current !== popup || event.senderFrame !== contents.mainFrame || event.senderFrame?.url !== menuURL) return;
        if (action === 'close') close(true, true);
        else if (action === 'manage') { close(); manage(); }
        else if (action === 'open' && typeof selectedId === 'string' && extensions.page(selectedId, 'action')) {
          void show(anchor, selectedId);
        } else if (action === 'options' && typeof selectedId === 'string') {
          const target = extensions.page(selectedId, 'options');
          if (target) { close(); openTab(target, true, new URL(target).host); }
        } else if (action === 'pin' && typeof selectedId === 'string') {
          try {
            await extensions.togglePin(selectedId, () => current === popup);
            changed();
          } catch (error) {
            if (current === popup) contents.send('extension-menu:error', error.message);
          }
        }
      });
    }
    redraw();
    try {
      await contents.loadURL(url);
      if (current !== popup) return;
      if (!extensionId) await rows(popup);
      if (current !== popup) return;
      popup.ready = true;
      const time = extensionId ? duration(anchor) : 0;
      const { bounds } = popup;
      if (time) view.setBounds({ ...bounds, y: Math.max(0, bounds.y - 12) });
      view.setVisible(true);
      if (time) {
        popup.entranceEnd = performance.now() + time;
        view.setBounds(bounds, { animate: { duration: time, easing: 'ease-out' } });
      }
      contents.focus();
    } catch {
      if (current !== popup) return;
      close(true);
      report('Не удалось открыть панель расширения.');
    }
  }

  return {
    show, close, resize,
    get view() { return (current || exiting)?.view; },
    get open() { return Boolean(current); },
    get anchorId() { return current?.anchor.id; },
    closeExtension(id) { if (current?.extensionId === id || exiting?.extensionId === id) close(); },
    refresh() { if (current?.ready && current.id === undefined) void rows(current); },
  };
}

module.exports = { extensionPopup };
