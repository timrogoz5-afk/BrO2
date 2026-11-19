const { app, BaseWindow, Menu, WebContentsView, clipboard, dialog, nativeTheme, safeStorage, session, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { resolveAddress, webURL } = require('./address');
const { preferences } = require('./preferences');
const { desktopClient, googleSignIn } = require('./google');
const { passwords } = require('./passwords');
const { extensionManager } = require('./extensions');
const { extensionPopup } = require('./extension-popup');
const { storeListing } = require('./extension-store');
const { passwordVault } = require('./password-vault');
const { bookmarks } = require('./bookmarks');
const { shortcutCommand } = require('./shortcuts');
const { downloads, taskList } = require('./browser-tools');
const { readFavicon } = require('./favicon');
const { sessionState, savedTab, savedWindow, sessionURL } = require('./session-state');
const { permissionNames, permissionTypes, permissionContext, siteOrigin, updateSiteRules } = require('./site-permissions');
const { localProfiles, defaultId } = require('./local-profiles');
const { openDefaultBrowserSettings } = require('./windows-browser');
const { readingText, mediaAction } = require('./page-actions');
const { translationEndpoint, translateArticle } = require('./translation');
const { feedURL, homeLayout } = require('./home-layout');
const { homeData } = require('./home-data');
const { recognizeRussian } = require('./voice');

const toolbarHeight = 96;
const titleHeight = 44;
const browsingPartition = 'persist:bro2-web';
const isolated = { sandbox: true, contextIsolation: true, nodeIntegration: false };
const shellFile = path.join(__dirname, 'index.html');
const passwordFile = path.join(__dirname, 'password-panel.html');
const findFile = path.join(__dirname, 'find.html');
const shellURL = pathToFileURL(shellFile).href;
const passwordURL = pathToFileURL(passwordFile).href;
const findURL = pathToFileURL(findFile).href;
const zoomStops = [25, 33, 50, 67, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];
const groupColors = ['#83acf8', '#72be9d', '#d99be9', '#eca97a', '#e38693'];
const sidebarWidth = 206;
const clearHours = { hour: 1, day: 24, week: 168, month: 720, all: 0 };
const siteStorageTypes = ['cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'cache', 'fileSystems', 'webSQL', 'backgroundFetch'];
const shellMicrophones = new Map();

if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const interfaceSession = session.fromPartition('bro2-interface');
  const isShell = (contents, details) => Boolean(contents && !contents.isDestroyed() && contents.getURL() === shellURL &&
    details?.isMainFrame === true && shellMicrophones.get(contents.id)?.());
  interfaceSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    permission === 'media' && details?.mediaType !== 'video' && isShell(contents, details));
  interfaceSession.setPermissionRequestHandler((contents, permission, answer, details) =>
    answer(permission === 'media' && details?.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio' && isShell(contents, details)));
  const registry = localProfiles(app.getPath('userData'));
  const profiles = new Map();
  const updateProfileWindows = () => { for (const runtime of profiles.values()) runtime.refresh(); };
  const launchURL = (args) => args.find((arg) => /^https?:\/\//i.test(arg) && sessionURL(arg));
  function openProfile(id, url) {
    registry.select(id);
    if (!profiles.has(id)) profiles.set(id, profileRuntime(id, registry, openProfile, updateProfileWindows));
    profiles.get(id).open(sessionURL(url));
    updateProfileWindows();
  }
  app.on('second-instance', (_event, args) => openProfile(registry.selected, launchURL(args.slice(1))));
  app.on('before-quit', () => { for (const runtime of profiles.values()) runtime.beforeQuit(); });
  openProfile(registry.selected, launchURL(process.argv.slice(1)));
});

function profileRuntime(profileId, registry, openProfile, updateProfileWindows) {
  const profileDirectory = registry.directory(profileId);
  const prefs = preferences(profileDirectory);
  const widgets = homeData();
  const vault = passwordVault(profileDirectory, safeStorage);
  const library = bookmarks(profileDirectory);
  const windows = new Set();
  const siteOwners = new Map();
  const geolocationEnabled = Boolean(process.env.GOOGLE_API_KEY?.trim());
  const sessionArchive = sessionState(profileDirectory);
  const previous = sessionArchive.previous;
  const recent = previous.recent;
  let lastRegularWindows = previous.windows;
  let sessionSaveTimer;
  let quitting = false;
  let launched = false;
  let tabDrag;

  function saveSession(clean = false) {
    clearTimeout(sessionSaveTimer);
    sessionSaveTimer = undefined;
    const current = [...windows].filter((owner) => !owner.privateMode).map((owner) => owner.snapshot()).filter(Boolean);
    if (current.length) lastRegularWindows = current;
    try { sessionArchive.save({ clean, windows: lastRegularWindows, recent }); }
    catch (error) { console.warn('Could not save browsing session:', error.code); }
  }

  function scheduleSessionSave() {
    if (!quitting && !sessionSaveTimer) sessionSaveTimer = setTimeout(saveSession, 180);
  }

  function rememberClosed(entry) {
    recent.unshift(entry);
    recent.length = Math.min(25, recent.length);
    scheduleSessionSave();
  }

  function caption() {
    const theme = prefs.current.settings.theme;
    const dark = theme === 'system' ? nativeTheme.shouldUseDarkColors : theme === 'dark';
    return { height: titleHeight, color: dark ? '#1e1926' : '#ece7f4', symbolColor: dark ? '#f5edfa' : '#261c32' };
  }
  const windowTitle = () => profileId === defaultId ? 'BrO2' : `BrO2 · ${registry.get(profileId).name}`;
  function updateSpelling(target) {
    const { spellcheck, spellLanguages } = prefs.current.settings;
    target.setSpellCheckerEnabled(spellcheck);
    if (!spellcheck) return;
    const supported = target.availableSpellCheckerLanguages;
    const language = app.getLocale();
    const system = supported.includes(language) ? language :
      supported.find((code) => code.split('-')[0] === language.split('-')[0]) || 'en-US';
    const selected = spellLanguages === 'system' ? [system] : spellLanguages.split(',');
    const enabled = selected.filter((code) => supported.includes(code));
    if (enabled.length) target.setSpellCheckerLanguages(enabled);
  }
  function configureSession(target) {
    updateSpelling(target);
    function resolve(contents, permission, claimedURL, details) {
      const source = contents && siteOwners.get(contents.id);
      const origin = permissionContext(contents, claimedURL, details, permission !== 'fullscreen');
      const types = permissionTypes(permission, details);
      if (!source || !origin || !types.length || source.tab.error ||
          (!geolocationEnabled && types.includes('geolocation'))) return null;
      return { ...source, origin, types };
    }
    target.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
      const request = resolve(contents, permission, requestingOrigin, details);
      const allowed = Boolean(request && (permission === 'fullscreen' ? request.owner.visible(request.tab) :
        request.types.every((type) => request.owner.siteRules()[request.origin]?.[type] === 'allow')));
      if (allowed && request.types.some((type) => type === 'microphone' || type === 'camera')) request.tab.capturedMedia = true;
      return allowed;
    });
    target.setPermissionRequestHandler((contents, permission, respond, details) => {
      const request = resolve(contents, permission, details?.requestingUrl, details);
      if (!request) return respond(false);
      if (permission === 'fullscreen') return respond(request.owner.visible(request.tab));
      request.owner.askPermission(request).then((allowed) => {
        if (allowed && request.types.some((type) => type === 'microphone' || type === 'camera')) request.tab.capturedMedia = true;
        respond(allowed);
      }, () => respond(false));
    });
    target.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'site-keys.js'),
      matches: ['http://*/*', 'https://*/*'] });
  }
  const regularSession = session.fromPartition(profileId === defaultId ? browsingPartition : `persist:bro2-profile-${profileId}`);
  configureSession(regularSession);
  const shortcutIconRequests = new Map();
  const shortcutIcons = new AbortController();

  function rememberShortcutIcon(url, favicon) {
    const origin = siteOrigin(url, false);
    if (quitting || !favicon || !origin) return;
    try {
      if (prefs.setShortcutIcon(origin, favicon)) for (const owner of windows) owner.historyChanged();
    } catch { /* The shortcut still works without an icon. */ }
  }

  function loadShortcutIcons() {
    const missing = new Set(prefs.current.shortcuts.filter(({ favicon }) => !favicon)
      .map(({ url }) => siteOrigin(url, false)).filter(Boolean));
    for (const origin of shortcutIconRequests.keys()) {
      if (!missing.has(origin)) shortcutIconRequests.delete(origin);
    }
    for (const origin of missing) {
      if (shortcutIconRequests.get(origin) > Date.now()) continue;
      shortcutIconRequests.set(origin, Date.now() + 60_000);
      void readFavicon(regularSession, [origin + '/favicon.ico'], shortcutIcons.signal)
        .then((favicon) => rememberShortcutIcon(origin, favicon));
    }
  }

  const regularDownloads = downloads(profileDirectory, regularSession, () => {
    for (const owner of windows) owner.downloadsChanged();
  }, () => ({
    directory: prefs.current.downloadDirectory || app.getPath('downloads'),
    prompt: prefs.current.settings.promptDownloads,
  }));
  const extensions = extensionManager(profileDirectory, regularSession.extensions, (id) => {
    for (const owner of windows) owner.closeExtension(id);
  });
  const restored = extensions.restore().catch(() => {});
  const uploads = new Map();
  const webRequests = { urls: ['http://*/*', 'https://*/*'] };
  regularSession.webRequest.onBeforeRequest(webRequests, (details, callback) => {
    const source = siteOwners.get(details.webContentsId);
    const tab = source?.tab;
    if (tab && details.uploadData?.length && !uploads.has(details.id)) {
      tab.uploadCount = (tab.uploadCount || 0) + 1;
      uploads.set(details.id, tab);
    }
    if (details.url.startsWith('https:')) source?.owner.credentials.observePost(details);
    callback({});
  });
  function finishUpload({ id }) {
    const tab = uploads.get(id);
    if (tab) tab.uploadCount--;
    uploads.delete(id);
  }
  regularSession.webRequest.onCompleted(webRequests, (details) => {
    finishUpload(details);
    siteOwners.get(details.webContentsId)?.owner.credentials.observeResponse(details);
  });
  regularSession.webRequest.onErrorOccurred(webRequests, finishUpload);
  function open(url) {
    loadShortcutIcons();
    const owner = [...windows].find(({ privateMode }) => !privateMode);
    if (owner) {
      if (owner.window.isMinimized()) owner.window.restore();
      owner.window.focus();
      if (url) owner.openLink(url);
      return;
    }
    if (launched) { createWindow(false, { url }); return; }
    launched = true;
    const settings = prefs.current.settings;
    const resume = previous.windows.length && (!previous.clean || settings.startup === 'restore');
    if (resume) {
      if (recent[0]?.type === 'window' && JSON.stringify(recent[0].window) === JSON.stringify(previous.windows[0])) recent.shift();
      for (const [index, saved] of previous.windows.entries()) {
        const owner = createWindow(false, undefined, saved);
        if (index === 0 && url) owner.openLink(url);
      }
    } else if (settings.startup === 'pages' && settings.startupPages.length) {
      const owner = createWindow(false, undefined, { tabs: settings.startupPages.map((url) => ({ url })), active: 0 });
      if (url) owner.openLink(url);
    } else createWindow(false, { url });
    saveSession();
  }

  function createWindow(privateMode = false, initialTab, initialWindow) {
    const appearance = () => {
      const { settings: { theme, accent, motion }, home } = prefs.current;
      return { theme, accent, motion, wallpaper: privateMode ? 'aurora' : home.wallpaper };
    };
    const browsingSession = privateMode ? session.fromPartition(`bro2-private-${randomUUID()}`) : regularSession;
    if (privateMode) configureSession(browsingSession);
    const windowDownloads = privateMode ? downloads(null, browsingSession, downloadsChanged, app.getPath('downloads')) : regularDownloads;

    const window = new BaseWindow({
      title: privateMode ? 'BrO2 · Инкогнито' : windowTitle(), width: 1240, height: 820, minWidth: 560, minHeight: 380,
      backgroundColor: caption().color, icon: path.join(__dirname, 'assets', 'icon.png'),
      titleBarStyle: 'hidden', titleBarOverlay: caption(),
    });
    const chrome = new WebContentsView({
      webPreferences: { ...isolated, partition: 'bro2-interface', preload: path.join(__dirname, 'preload.js') },
    });
    const passwordPopup = new WebContentsView({
      webPreferences: { ...isolated, partition: 'bro2-interface', preload: path.join(__dirname, 'password-panel-preload.js') },
    });
    let findPopup;
    let findReady;
    chrome.setBackgroundColor('#00000000');
    passwordPopup.setBackgroundColor('#00000000');
    passwordPopup.setVisible(false);
    window.contentView.addChildView(chrome);
    window.contentView.addChildView(passwordPopup);
    const tabs = new Map();
    const pendingLinks = [];
    let active;
    let nextId = 1;
    let closed = false;
    let settingsOpen = false;
    let siteSettingsOrigin = '';
    let groupSettingsId;
    let readerDocument;
    let originalReader;
    let readerTranslation;
    let permissionPrompt = false;
    let privateRules = {};
    const privateZoom = new Map();
    let clearingData = false;
    let status = '';
    let importing = false;
    let login;
    let dropdownHeight = 0;
    let voice;
    let queuedPublish;
    let mediaTabId;
    let memoryTimer;
    let passwordHeight = 0;
    let extensionEpoch = 0;
    let choosingExtension = false;
    let extensionDownload;
    let extensionStoreSource = '';
    let toolPage = '';
    let find;
    let browserMenu;
    let tabMenu;
    let split;
    let splitDirection = 'auto';
    let verticalTabs = Boolean(initialWindow?.verticalTabs);
    let nextGroupId = 1;
    let bookmarkItems = [];
    const closedTabs = [];
    const credentials = passwords({
      vault, library, window, chrome: chrome.webContents, passwordPopup, browsingSession,
      active: () => active, shellURL, passwordURL, privateMode,
      settings: () => ({ open: settingsOpen, site: showingSite(), offers: prefs.current.settings.passwordOffers, style: appearance() }),
      resize(height) { passwordHeight = height; layout(); },
    });
    const extensionPanel = extensionPopup({
      window, extensions, browsingSession, isolated, appearance,
      dismissOverlays() { credentials.dismiss(); closeFind(false); dropdownHeight = 0; },
      redraw, layout, publish, report: pageStatus, manage: openExtensions, shortcut: handleShortcut,
      openTab(url, focus, id) { createTab(url, focus, id); },
      focusButton(id) {
        chrome.webContents.focus();
        chrome.webContents.send('browser:extension-focus', id);
      },
      changed() { for (const other of windows) other.extensionsChanged(); },
    });
    const owner = { window, privateMode, credentials, downloadsChanged() { if (!privateMode) downloadsChanged(); },
      extensionsChanged() { publish(); extensionPanel.refresh(); },
      closeExtension(id) {
        extensionPanel.closeExtension(id);
        for (const tab of tabs.values()) if (tab.extension === id) closeTab(tab.id, false);
      },
      bookmarksChanged: refreshBookmarks,
      historyChanged() {
        if (!privateMode) {
          window.setTitle(windowTitle());
          publish();
        }
      },
      readingListChanged() { if (!privateMode) publish(); },
      siteRules: currentSiteRules,
      askPermission,
      visible: (tab) => tab === active && !closed && showingSite(),
      zoomChanged(origin, level) {
        if (privateMode) return;
        for (const tab of tabs.values()) {
          if (siteOrigin(tab.url, false) === origin) tab.view?.webContents.setZoomFactor(level / 100);
        }
      },
      listedTabs: () => [...tabs.values()].filter((tab) => !tab.extension && !tab.source && !tab.tool)
        .map(({ id, url, title }) => ({ id, url, title, windowId: window.id })),
      switchTo(id) {
        if (!tabs.has(id)) return;
        if (window.isMinimized()) window.restore();
        window.focus();
        selectTab(tabs.get(id));
      },
      transferTab: (id) => {
        const tab = tabs.get(id);
        if (!tab || tab.tool || tab.extension || tab.source || privateMode) return null;
        return { snapshot: { ...copyTab(tab), group: undefined }, remove: () => closeTab(id, false) };
      },
      receiveTab(snapshot, targetId, after = true) {
        const target = tabs.get(targetId);
        const created = createTab(snapshot.url, true, undefined, false, tabs.size, snapshot);
        if (target) reorderTab(created, target, after);
      },
      openLink(url) {
        if (active) createTab(url);
        else pendingLinks.push(url);
      },
      snapshot() {
        if (!active) return initialWindow || (initialTab ? { tabs: [initialTab], active: 0 } : null);
        const regular = [...tabs.values()].filter((tab) => !tab.extension && !tab.source && !tab.tool);
        return savedWindow({
          active: Math.max(0, regular.indexOf(active)),
          tabs: regular.map(copyTab),
          verticalTabs,
        });
      },
    };
    windows.add(owner);
    const chromeId = chrome.webContents.id;
    shellMicrophones.set(chromeId, () => !closed && window.isFocused() && showingHome());
    owner.updateMemoryTimer = updateMemoryTimer;

    function showingSite() {
      return !settingsOpen && !toolPage && Boolean(active?.url) && !active.error;
    }

    function currentSiteRules() {
      return privateMode ? privateRules : prefs.current.siteRules;
    }

    function setSiteRule(origin, types, decision) {
      if (privateMode) privateRules = updateSiteRules(privateRules, origin, types, decision);
      else prefs.setSiteRule(origin, types, decision);
      publish();
    }

    async function askPermission({ origin, types, tab }) {
      const rule = currentSiteRules()[origin];
      if (types.every((type) => rule?.[type] === 'allow')) return true;
      if (types.some((type) => rule?.[type] === 'block') || permissionPrompt || !owner.visible(tab) || !window.isFocused()) return false;
      const contents = tab.view.webContents;
      const address = contents.getURL();
      const frame = contents.mainFrame;
      permissionPrompt = true;
      const requested = types.filter((type) => rule?.[type] !== 'allow');
      try {
        const { response } = await dialog.showMessageBox(window, {
          type: 'question', title: 'Разрешение для сайта',
          message: `${origin} запрашивает доступ к ${requested.map((type) => permissionNames[type]).join(' и ')}.`,
          detail: requested.includes('geolocation')
            ? 'Для определения местоположения Electron может отправить информацию о сети в Google. Сайт получит координаты.'
            : privateMode ? 'Выбор действует до закрытия окна инкогнито.' : 'Выбор можно изменить по кнопке слева от адреса.',
          buttons: ['Разрешить', 'Заблокировать', 'Отмена'], defaultId: 2, cancelId: 2, noLink: true,
        });
        if (response === 2 || !owner.visible(tab) || contents.isDestroyed() ||
            contents.getURL() !== address || contents.mainFrame !== frame) return false;
        if (requested.some((type) => currentSiteRules()[origin]?.[type] !== rule?.[type])) {
          return types.every((type) => currentSiteRules()[origin]?.[type] === 'allow');
        }
        setSiteRule(origin, requested, response === 0 ? 'allow' : 'block');
        return response === 0;
      } finally { permissionPrompt = false; }
    }

    const bookmarkBar = () => !privateMode && prefs.current.settings.bookmarkBar;
    const topHeight = () => toolbarHeight + (bookmarkBar() ? 35 : 0);

    function publish() {
      if (closed || !active) return;
      if (!privateMode) scheduleSessionSave();
      const history = active.view.webContents.navigationHistory;
      if (voice && !showingHome()) voice.abort();
      chrome.webContents.send('browser:state', {
        tabs: [...tabs.values()].map(({ id, title, loading, url, favicon, tool, pinned, group, muted, suspended }) =>
          ({ id, title, loading, url, favicon, tool, pinned, group, muted, suspended: Boolean(suspended) })),
        openTabs: (privateMode ? [owner] : [...windows].filter((other) => !other.privateMode))
          .flatMap((other) => other.listedTabs()),
        windowId: window.id,
        localProfiles: privateMode ? [] : registry.list(),
        localProfileId: privateMode ? '' : profileId,
        groupSettings: toolPage === 'group-settings' ? findGroup(groupSettingsId) : null,
        savedGroups: !privateMode && toolPage === 'saved-groups' ? prefs.current.savedGroups.map(({ id, title, color, tabs }) =>
          ({ id, title, color, count: tabs.length })) : [],
        reader: toolPage === 'reader' ? readerDocument : null,
        translation: !privateMode && prefs.current.translation ? {
          endpoint: prefs.current.translation.endpoint, busy: Boolean(readerTranslation),
          translated: Boolean(originalReader && readerDocument !== originalReader),
          keyConfigured: Boolean(prefs.current.translation.key),
        } : null,
        active: active.id,
        url: active.url,
        error: active.error,
        loading: active.loading,
        back: history.canGoBack(),
        forward: history.canGoForward(),
        settingsOpen,
        settings: prefs.current.settings,
        searchEngines: prefs.current.searchEngines,
        versions: { browser: app.getVersion(), electron: process.versions.electron, chromium: process.versions.chrome },
        downloadDirectory: privateMode ? '' : prefs.current.downloadDirectory || app.getPath('downloads'),
        siteSettings: toolPage === 'site-settings' ? {
          origin: siteSettingsOrigin, rules: currentSiteRules(), geolocationEnabled, clearing: clearingData,
        } : null,
        clearingData,
        history: privateMode ? [] : toolPage === 'history' ? prefs.current.history : prefs.current.history.slice(0, 160),
        shortcuts: privateMode ? [] : prefs.current.shortcuts,
        home: privateMode ? undefined : prefs.current.home,
        homeMedia: !privateMode && showingHome() ? describeMedia(currentMedia()) : null,
        readingList: privateMode ? [] : prefs.current.readingList,
        privateMode, toolPage, find: Boolean(find), bookmarks: bookmarkItems, bookmarkBar: bookmarkBar(),
        storeListing: !privateMode && !settingsOpen && Boolean(storeListing(active.url)),
        extensionStoreSource: toolPage === 'extensions' ? extensionStoreSource : '',
        extensionPanelOpen: extensionPanel.open,
        extensionPanelAnchor: extensionPanel.anchorId,
        pinnedExtensions: privateMode ? [] : extensions.pinned(),
        pageVisible: showingSite(), verticalTabs,
        account: {
          configured: !privateMode && Boolean(prefs.current.googleClient),
          profile: privateMode ? null : prefs.current.profile,
          busy: importing || Boolean(login),
          signingIn: Boolean(login),
        },
        status,
      });
    }

    function showingHome() {
      return active && !active.url && !active.error && !active.loading && !settingsOpen && !toolPage;
    }

    function queuePublish() {
      if (queuedPublish) return;
      queuedPublish = setImmediate(() => {
        queuedPublish = undefined;
        publish();
      });
    }

    function visibleTabs() {
      if (!showingSite()) return [];
      if (split?.includes(active.id)) {
        const pair = split.map((id) => tabs.get(id));
        if (pair.every((tab) => tab?.view && tab.url && !tab.error)) return pair;
      }
      return [active];
    }

    function layout(pages = visibleTabs()) {
      const { width, height } = window.getContentBounds();
      const top = topHeight();
      const chromeHeight = pages.length && !verticalTabs ? Math.min(height, top + dropdownHeight) : height;
      chrome.setBounds({ x: 0, y: 0, width, height: chromeHeight });
      const popupWidth = Math.min(420, width - 24);
      passwordPopup.setBounds({ x: width - popupWidth - 12, y: top, width: popupWidth,
        height: Math.min(Math.max(0, height - top), passwordHeight) });
      const findWidth = Math.min(380, width - 16);
      findPopup?.setBounds({ x: width - findWidth - 8, y: top + 6, width: findWidth, height: 48 });
      extensionPanel.resize(width, height);
      const x = verticalTabs ? sidebarWidth : 0;
      const y = Math.min(height, top + (verticalTabs ? dropdownHeight : 0));
      const area = { x, y, width: Math.max(0, width - x), height: height - y };
      if (pages.length === 1) pages[0].view.setBounds(area);
      if (pages.length !== 2) return;
      if (splitDirection === 'horizontal' || splitDirection === 'auto' && area.width >= 640) {
        const half = Math.floor(area.width / 2);
        pages[0].view.setBounds({ ...area, width: half - 1 });
        pages[1].view.setBounds({ ...area, x: area.x + half + 1, width: area.width - half - 1 });
      } else {
        const half = Math.floor(area.height / 2);
        pages[0].view.setBounds({ ...area, height: Math.max(0, half - 1) });
        pages[1].view.setBounds({ ...area, y: area.y + half + 1, height: Math.max(0, area.height - half - 1) });
      }
    }

    function redraw() {
      const pages = visibleTabs();
      const pageViews = pages.map(({ view }) => view);
      const desired = (verticalTabs ? [chrome, ...pageViews, findPopup, passwordPopup, extensionPanel.view]
        : [...pageViews, findPopup, chrome, passwordPopup, extensionPanel.view]).filter(Boolean);
      const current = window.contentView.children;
      if (current.length !== desired.length || current.some((view, index) => view !== desired[index])) {
        for (const view of current) if (!desired.includes(view)) window.contentView.removeChildView(view);
        const retained = window.contentView.children;
        if (desired.filter((view) => retained.includes(view)).every((view, index) => retained[index] === view)) {
          for (const [index, view] of desired.entries()) {
            if (!retained.includes(view)) window.contentView.addChildView(view, index);
          }
        } else {
          for (const view of desired) window.contentView.addChildView(view);
        }
      }
      for (const view of pageViews) view.setVisible(true);
      layout(pages);
      publish();
    }

    function toggleSettings() {
      extensionPanel.close();
      credentials.reset(active);
      closeFind(false);
      if (settingsOpen) credentials.leaveSettings();
      settingsOpen = !settingsOpen;
      setToolPage(settingsOpen ? '' : active.tool);
      dropdownHeight = 0;
      redraw();
      chrome.webContents.focus();
    }

    function setToolPage(page = '') {
      if (toolPage === 'extensions' && page !== toolPage) {
        extensionEpoch++;
        extensionDownload?.abort();
        extensionStoreSource = '';
        void extensions.cancel(owner);
      }
      if (page !== 'reader') {
        readerTranslation?.abort();
        readerDocument = originalReader = undefined;
      }
      toolPage = page;
    }

    function focusAddress() {
      if (settingsOpen) toggleSettings();
      if (toolPage && toolPage !== active.tool) closeTool();
      credentials.dismiss();
      chrome.webContents.focus();
      chrome.webContents.send('browser:focus');
    }

    function selectTab(tab, focus = true) {
      if (!tab) return;
      extensionPanel.close();
      if (tab.suspended) tab = wakeTab(tab);
      closeFind(false);
      setToolPage(tab.tool);
      credentials.reset(active);
      const switched = active !== tab;
      if (settingsOpen) credentials.leaveSettings();
      settingsOpen = false;
      if (active && active !== tab) active.lastActive = Date.now();
      active = tab;
      tab.lastActive = Date.now();
      dropdownHeight = 0;
      redraw();
      if (focus) {
        if (showingSite()) tab.view.webContents.focus();
        else if (tab.tool) chrome.webContents.focus();
        else focusAddress();
      }
      if (switched) credentials.suggest();
    }

    function navigate(tab, url, loadOptions) {
      if (tab === active) extensionPanel.close();
      if (!url) return;
      if (tab === active) {
        closeFind(false);
        credentials.reset(tab);
      }
      if (tab === active && dropdownHeight) {
        dropdownHeight = 0;
        layout();
      }
      const contents = tab.view.webContents;
      if (tab.source) {
        tab.url = url;
        tab.title = 'Исходный код';
        tab.error = '';
        if (tab === active) redraw();
      }
      tab.loading = true;
      if (tab === active) publish();
      contents.loadURL(url, loadOptions).catch(() => {
        // Page failures are handled by did-fail-load, including Chromium's error code.
      });
    }

    function recordVisit(tab) {
      if (!tab.pendingVisit) return;
      tab.pendingVisit = false;
      if (privateMode || !webURL(tab.url) || tab.error) return;
      const { username, password } = new URL(tab.url);
      if (username || password) return;
      try {
        prefs.visit(tab.url, tab.title.slice(0, 240));
        for (const other of windows) if (other !== owner) other.historyChanged();
      }
      catch (error) { console.warn('Could not save browsing history:', error.code); }
    }

    function createTab(url, focus = true, extension, source = false, position = tabs.size,
      { tool, loadOptions, zoom = 1, muted = false, pinned = false, history, group, reusedId, title, favicon = '' } = {}) {
      const view = new WebContentsView({
        webPreferences: { ...isolated, session: browsingSession, plugins: !extension && !source && !tool,
          preload: privateMode || extension || source ? undefined : path.join(__dirname, 'site-passwords.js') },
      });
      view.setVisible(false);
      const contents = view.webContents;
      contents.setZoomMode('isolated');
      if (zoom !== 1) contents.setZoomFactor(zoom);
      if (muted) contents.setAudioMuted(true);
      const tab = { id: reusedId ?? nextId++, view, extension, source, tool, muted, pinned, group, initialURL: url,
        lastActive: Date.now(),
        title: title || (tool === 'extensions' ? 'Расширения' : 'Новая вкладка'), url: '', favicon, loading: false, error: '' };
      if (!extension && !source && !tool) {
        const contentsId = contents.id;
        siteOwners.set(contentsId, { owner, tab });
        contents.once('destroyed', () => siteOwners.delete(contentsId));
      }
      const order = [...tabs.values()];
      const pinnedCount = order.filter((item) => item.pinned).length;
      order.splice(pinned ? Math.min(position, pinnedCount) : Math.max(position, pinnedCount), 0, tab);
      orderTabs(order);
      credentials.attach(tab);

      const allowedURL = (location) => extension ? extensions.isPage(location, extension)
        : source ? location === url : webURL(location);
      const expectedSource = (location) => source && webURL(location) === url.slice('view-source:'.length);
      const restrictNavigation = (event) => {
        if (event.isMainFrame && !allowedURL(event.url)) event.preventDefault();
      };
      contents.on('will-navigate', restrictNavigation);
      contents.on('will-redirect', restrictNavigation);
      contents.setWindowOpenHandler(({ url, disposition, referrer, postBody, features }) => {
        const target = webURL(url);
        if (target) {
          const popup = disposition === 'other' || /(?:^|,)\s*(?:popup|width|height|top|left)\s*(?:=|,|$)/i.test(features);
          if (popup && currentSiteRules()[siteOrigin(tab.url, false)]?.popups !== 'allow') {
            if (tab === active) pageStatus('Всплывающее окно заблокировано. Разрешения доступны слева от адреса.');
            return { action: 'deny' };
          }
          const loadOptions = { httpReferrer: referrer };
          if (postBody) {
            loadOptions.postData = postBody.data;
            const boundary = postBody.boundary ? `; boundary=${postBody.boundary}` : '';
            loadOptions.extraHeaders = `Content-Type: ${postBody.contentType}${boundary}`;
          }
          if (popup || disposition === 'new-window') createWindow(privateMode, { url: target, loadOptions });
          else createTab(target, disposition !== 'background-tab', undefined, false, tabs.size, { loadOptions });
        }
        else if (extension && allowedURL(url)) createTab(url, disposition !== 'background-tab', extension);
        return { action: 'deny' };
      });
      contents.on('content-bounds-updated', (event) => event.preventDefault());
      contents.on('context-menu', (_event, details) => pageContext(tab, details));
      contents.on('enter-html-full-screen', () => { if (owner.visible(tab)) window.setFullScreen(true); });
      contents.on('leave-html-full-screen', () => { if (tab === active && window.isFullScreen()) window.setFullScreen(false); });
      contents.on('did-navigate', (_event, url) => {
        if (tab === active) extensionPanel.close();
        const hadFind = tab === active && Boolean(find);
        if (hadFind) closeFind(false);
        if (!webURL(url) || !webURL(tab.url) || new URL(url).origin !== new URL(tab.url).origin) {
          tab.faviconFetch?.abort();
          tab.favicon = '';
        }
        if (expectedSource(url)) {
          if (tab === active && showingSite()) {
            if (hadFind) redraw();
            contents.focus();
          }
          return;
        }
        if (url !== 'about:blank' && !allowedURL(url)) return;
        tab.url = url === 'about:blank' ? '' : url;
        tab.initialURL = '';
        tab.dirty = false;
        tab.playedMedia = false;
        tab.playingMedia = false;
        tab.capturedMedia = false;
        const zoomOrigin = siteOrigin(tab.url, false);
        if (zoomOrigin) {
          const storedZoom = privateMode ? privateZoom.get(zoomOrigin) : prefs.current.siteZoom[zoomOrigin];
          contents.setZoomFactor((storedZoom ?? 100) / 100);
        }
        tab.title = tab.url ? (source ? 'Исходный код' : new URL(url).hostname) : 'Новая вкладка';
        tab.error = '';
        tab.pendingVisit = Boolean(tab.url);
        if (tab === active) {
          redraw();
          if (showingSite() && !dropdownHeight) contents.focus();
          else if (!tab.url && !settingsOpen && !toolPage) focusAddress();
        } else if (split?.includes(tab.id)) redraw();
        else queuePublish();
      });
      contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
        if (!isMainFrame || !allowedURL(url)) return;
        recordVisit(tab);
        tab.url = url;
        tab.pendingVisit = true;
        recordVisit(tab);
        publish();
      });
      contents.on('page-title-updated', (_event, title) => {
        if (title) tab.title = title;
        queuePublish();
      });
      contents.on('page-favicon-updated', async (_event, urls) => {
        if (!webURL(tab.url) || tab.error) return;
        tab.faviconFetch?.abort();
        const request = new AbortController();
        tab.faviconFetch = request;
        const favicon = await readFavicon(browsingSession, urls, request.signal);
        if (request.signal.aborted || closed || tab.favicon === favicon) return;
        tab.favicon = favicon;
        if (!privateMode) rememberShortcutIcon(tab.url, favicon);
        queuePublish();
      });
      contents.on('did-start-loading', () => {
        tab.loading = true;
        queuePublish();
      });
      contents.on('did-stop-loading', () => {
        tab.loading = false;
        recordVisit(tab);
        queuePublish();
      });
      contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
        if (code === -3 || !isMainFrame || (!allowedURL(url) && !expectedSource(url))) return;
        tab.faviconFetch?.abort();
        tab.favicon = '';
        if (!tab.source) {
          tab.url = url;
          tab.title = new URL(url).hostname;
        }
        tab.error = description;
        if (tab === active) {
          closeFind(false);
          redraw();
        } else if (split?.includes(tab.id)) redraw();
        else publish();
      });
      contents.on('render-process-gone', () => {
        tab.error = 'Страница перестала отвечать';
        tab.loading = false;
        if (tab === active) {
          closeFind(false);
          redraw();
        } else if (split?.includes(tab.id)) redraw();
        else publish();
      });
      contents.on('before-input-event', handleShortcut);
      contents.on('focus', () => {
        if (visibleTabs().includes(tab)) extensionPanel.close();
        if (tab !== active && visibleTabs().includes(tab)) selectTab(tab, false);
      });
      contents.on('zoom-changed', (_event, direction) => {
        if (tab === active && showingSite()) changeZoom(direction === 'in' ? 1 : -1);
      });
      contents.on('found-in-page', (_event, result) => {
        if (tab === active && find?.request === result.requestId) findPopup?.webContents.send('browser:find-result', result);
      });
      contents.on('media-started-playing', () => {
        tab.playedMedia = true;
        tab.playingMedia = true;
        mediaTabId = tab.id;
        if (showingHome()) queuePublish();
      });
      contents.on('media-paused', () => {
        tab.playingMedia = false;
        if (showingHome()) queuePublish();
      });
      contents.ipc.on('browser:site-edited', (event) => {
        if (event.senderFrame?.top === contents.mainFrame) tab.dirty = true;
      });
      contents.ipc.on('browser:site-key', (event, key, shifted) => {
        if (tab !== active || !showingSite() || event.senderFrame !== contents.mainFrame) return;
        if (key === 'Backspace') runCommand(shifted ? 'forward' : 'back');
        if (key === 'Escape' && !shifted) runCommand('escape');
      });

      if (focus) selectTab(tab, !url);
      if (history?.entries.length) {
        contents.navigationHistory.restore(history).catch(() => {
          if (url && !contents.isDestroyed() && !tab.url) navigate(tab, url);
        });
      } else if (url) navigate(tab, url, loadOptions);
      publish();
      return tab;
    }

    function orderTabs(order) {
      tabs.clear();
      for (const tab of order) tabs.set(tab.id, tab);
    }

    function findGroup(id) {
      return [...tabs.values()].find((tab) => tab.group?.id === id)?.group;
    }

    function placeTabs(items, target, after) {
      const order = [...tabs.values()].filter((item) => !items.includes(item));
      const nearby = target.group && items[0].group !== target.group
        ? (after ? order.findLastIndex((item) => item.group === target.group) : order.findIndex((item) => item.group === target.group))
        : order.indexOf(target);
      if (nearby < 0) return;
      order.splice(nearby + Number(after), 0, ...items);
      orderTabs(order);
      publish();
    }

    function reorderTab(tab, target, after) {
      if (!tab || !target || tab === target || tab.pinned !== target.pinned) return;
      if (tab.group !== target.group) tab.group = undefined;
      placeTabs([tab], target, after);
    }

    function moveGroup(group, target, after) {
      if (!group || !target || target.group === group || target.pinned) return;
      placeTabs([...tabs.values()].filter((tab) => tab.group === group), target, after);
    }

    function removeFromGroup(tab) {
      if (!tab.group) return;
      const last = [...tabs.values()].findLast((item) => item.group === tab.group);
      tab.group = undefined;
      if (last === tab) publish();
      else placeTabs([tab], last, true);
    }

    function editGroup(group) {
      groupSettingsId = group.id;
      openTool('group-settings');
    }

    function newGroup(members, edit = false) {
      if (!members.length) return;
      const id = nextGroupId++;
      const group = { id, title: 'Группа ' + id, color: groupColors[(id - 1) % groupColors.length] };
      const order = [...tabs.values()];
      const anchor = members[0];
      const boundary = anchor.group ? order.findLastIndex((tab) => tab.group === anchor.group) : order.indexOf(anchor);
      const selected = new Set(members);
      const position = order.slice(0, boundary).filter((tab) => !selected.has(tab)).length;
      const remaining = order.filter((tab) => !selected.has(tab));
      for (const tab of members) tab.group = group;
      remaining.splice(position + Number(!selected.has(order[boundary])), 0, ...members);
      orderTabs(remaining);
      publish();
      if (edit) editGroup(group);
    }

    function saveAndCloseGroup(group) {
      if (privateMode) return;
      const members = [...tabs.values()].filter((tab) => tab.group === group);
      if (!members.length || members.some((tab) => tab.extension || tab.source || tab.tool)) return;
      const record = { id: randomUUID(), title: group.title, color: group.color,
        tabs: members.map((tab) => ({ ...copyTab(tab), group: undefined })) };
      try {
        if (prefs.current.savedGroups.length >= 40) return pageStatus('Сохранено 40 групп. Удали одну, чтобы сохранить новую.');
        if (members.length > 160) return pageStatus('В одной сохранённой группе может быть до 160 вкладок.');
        prefs.setSavedGroups([record, ...prefs.current.savedGroups]);
      } catch { return pageStatus('Не удалось сохранить группу.'); }
      for (const tab of members) if (tab !== active) closeTab(tab.id, false);
      if (members.includes(active)) closeTab(active.id, false);
      pageStatus('Группа сохранена. Её можно открыть через меню браузера.');
      for (const owner of windows) owner.historyChanged();
    }

    function reopenGroup(record, inNewWindow = false) {
      if (inNewWindow) {
        const group = { id: 1, title: record.title, color: record.color, collapsed: false };
        createWindow(false, undefined, { active: 0, verticalTabs, tabs: record.tabs.map((tab) => ({ ...tab, pinned: false, group })) });
        return;
      }
      const group = { id: nextGroupId++, title: record.title, color: record.color, collapsed: false };
      const deferred = record.tabs.map((tab) => deferTab({ ...tab, pinned: false, group }));
      selectTab(deferred[0]);
    }

    function transferTo(other, id, targetId, after) {
      const transfer = owner.transferTab(id);
      if (!transfer || !other || other === owner || other.privateMode) return;
      other.receiveTab(transfer.snapshot, targetId, after);
      transfer.remove();
      other.window.focus();
    }

    function copyTab(tab) {
      if (tab.suspended) return { ...tab.suspended, pinned: tab.pinned, muted: tab.muted, group: tab.group };
      const contents = tab.view.webContents;
      const history = contents.navigationHistory;
      return { url: tab.url || tab.initialURL, title: tab.title, zoom: contents.getZoomFactor(), muted: tab.muted, pinned: tab.pinned, group: tab.group,
        history: { entries: history.getAllEntries(), index: history.getActiveIndex() } };
    }

    function canSuspend(tab) {
      return tab !== active && !tab.pinned && !tab.loading && !tab.error && !tab.suspended &&
        !split?.includes(tab.id) && !tab.extension && !tab.source && Boolean(sessionURL(tab.url)) &&
        !tab.view.webContents.isCurrentlyAudible() && !tab.dirty && !tab.capturedMedia && !tab.playedMedia &&
        !tab.uploadCount && !windowDownloads.hasActive(tab.view.webContents.id);
    }

    function isMemoryException(url) {
      const hostname = new URL(url).hostname.replace(/\.$/, '');
      return prefs.current.settings.memoryExceptions.some((domain) => hostname === domain || hostname.endsWith('.' + domain));
    }

    function deferTab(record) {
      const tab = { id: nextId++, url: record.url, title: record.title || (record.url ? new URL(record.url).hostname : 'Новая вкладка'),
        pinned: record.pinned, muted: record.muted, group: record.group, suspended: record, lastActive: Date.now() };
      tabs.set(tab.id, tab);
      return tab;
    }

    function suspendTab(tab) {
      if (!canSuspend(tab)) return;
      const record = savedTab(copyTab(tab));
      tabs.set(tab.id, { ...tab, suspended: record, view: undefined });
      tab.faviconFetch?.abort();
      tab.view.webContents.close({ waitForBeforeUnload: false });
      publish();
    }

    function wakeTab(tab) {
      const position = [...tabs.keys()].indexOf(tab.id);
      tabs.delete(tab.id);
      return createTab(tab.url, false, undefined, false, position, { ...copyTab(tab), favicon: tab.favicon, reusedId: tab.id });
    }

    function pinTab(tab) {
      const others = [...tabs.values()].filter((item) => item !== tab);
      const pinnedCount = others.filter((item) => item.pinned).length;
      tab.pinned = !tab.pinned;
      tab.group = undefined;
      others.splice(pinnedCount, 0, tab);
      orderTabs(others);
      publish();
    }

    function addToGroup(tab, group) {
      if (tab.group === group) return;
      const order = [...tabs.values()].filter((item) => item !== tab);
      const lastMember = order.findLastIndex((item) => item.group?.id === group.id);
      if (lastMember >= 0) {
        order.splice(lastMember + 1, 0, tab);
        orderTabs(order);
      }
      tab.group = group;
      publish();
    }

    function closeTab(id, remember = true, keepTool = false) {
      const tab = tabs.get(id);
      if (!tab) return;
      const order = [...tabs.values()];
      const index = order.indexOf(tab);
      if (tab === active) closeFind(false);
      const wasSplit = split?.includes(id);
      if (wasSplit) split = undefined;
      if (remember && !tab.extension && !tab.source && !tab.tool) {
        const recentlyClosed = { type: 'tab', tab: savedTab(copyTab(tab)), position: index };
        if (privateMode) {
          closedTabs.unshift(recentlyClosed);
          closedTabs.length = Math.min(25, closedTabs.length);
        } else rememberClosed(recentlyClosed);
      }
      tabs.delete(id);
      if (active === tab) {
        const previousTool = keepTool ? toolPage : '';
        credentials.reset(tab);
        window.contentView.removeChildView(tab.view);
        active = undefined;
        const neighbor = order[index + 1] || order[index - 1];
        if (neighbor) selectTab(neighbor);
        else createTab();
        if (previousTool) openTool(previousTool);
      } else if (wasSplit) redraw();
      tab.faviconFetch?.abort();
      tab.view?.webContents.close();
      publish();
    }

    function reload(hard = false) {
      if (settingsOpen || toolPage) return;
      reloadTab(active, hard);
    }

    function reloadTab(tab, hard = false) {
      if (tab.suspended) { wakeTab(tab); return; }
      if (tab.error) navigate(tab, tab.url);
      else if (tab.url) {
        if (hard) tab.view.webContents.reloadIgnoringCache();
        else tab.view.webContents.reload();
      }
    }

    function pageStatus(message) {
      if (!closed) chrome.webContents.send('browser:notice', message);
    }

    function openSiteSettings(current = true) {
      siteSettingsOrigin = current ? siteOrigin(active.url, false) || '' : '';
      openTool('site-settings');
    }

    function bookmarkFolderMenu({ id, x, y } = {}) {
      if (!bookmarkBar() || typeof id !== 'string' || !Number.isFinite(x) || !Number.isFinite(y)) return;
      const folder = bookmarkItems.find((item) => item.id === id && item.children);
      if (!folder) return;
      const tab = active;
      const template = (children) => children.slice(0, 300).map((item) => item.url ? {
        label: item.name, click: () => { if (!closed && tab === active) openAddress(item.url); },
      } : { label: item.name, submenu: item.children.length ? template(item.children) : [{ label: 'Папка пуста', enabled: false }] });
      const items = folder.children.length ? template(folder.children) : [{ label: 'Папка пуста', enabled: false }];
      items.push({ type: 'separator' }, { label: 'Управление закладками', click: () => { if (!closed) openTool('bookmarks'); } });
      const { width, height } = window.getContentBounds();
      Menu.buildFromTemplate(items).popup({ window, x: Math.round(Math.max(0, Math.min(x, width))),
        y: Math.round(Math.max(0, Math.min(y, height))) });
    }

    function navigationMenu({ forward, x, y } = {}) {
      if (!showingSite() || !Number.isFinite(x) || !Number.isFinite(y)) return;
      const tab = active;
      const history = tab.view.webContents.navigationHistory;
      const current = history.getActiveIndex();
      const entries = history.getAllEntries();
      const start = Math.max(0, current - 20);
      const indexes = forward ? entries.slice(current + 1, current + 21).map((_entry, index) => current + index + 1)
        : entries.slice(start, current).map((_entry, index) => start + index).reverse();
      const items = indexes.map((index) => ({
        label: (entries[index].title || entries[index].url).slice(0, 120),
        click: () => {
          if (!closed && tab === active && history.getEntryAtIndex(index)?.url === entries[index].url) history.goToIndex(index);
        },
      }));
      if (!items.length) return;
      const { width, height } = window.getContentBounds();
      Menu.buildFromTemplate(items).popup({ window, x: Math.round(Math.max(0, Math.min(x, width))),
        y: Math.round(Math.max(0, Math.min(y, height))) });
    }

    function openAddress(value) {
      const url = resolveAddress(value, prefs.current.settings.search, false, prefs.current.searchEngines);
      if (!url) { pageStatus('Не удалось открыть адрес. Поддерживаются ссылки HTTP и HTTPS.'); return; }
      if (settingsOpen) toggleSettings();
      if (toolPage && toolPage !== active.tool) closeTool();
      if (active.extension || active.source || active.tool) createTab(url);
      else navigate(active, url);
    }

    async function openReader(tab) {
      const contents = tab.view.webContents;
      const url = contents.getURL();
      try {
        const article = await contents.executeJavaScriptInIsolatedWorld(2, [{ code: `(${readingText.toString()})()` }]);
        if (closed || active !== tab || contents.isDestroyed() || contents.getURL() !== url || !owner.visible(tab)) return;
        if (!article) return pageStatus('Не удалось выделить текст статьи на этой странице.');
        readerDocument = article;
        originalReader = article;
        openTool('reader');
      } catch { pageStatus('Не удалось открыть режим чтения.'); }
    }

    async function translateReader(target) {
      const settings = prefs.current.translation;
      if (privateMode || !settings || !originalReader || readerTranslation || toolPage !== 'reader') return;
      const original = originalReader;
      const operation = new AbortController();
      readerTranslation = operation;
      publish();
      try {
        const key = settings.key && safeStorage.decryptString(Buffer.from(settings.key, 'base64'));
        const result = await translateArticle(original, { endpoint: settings.endpoint, key }, target, operation.signal);
        if (toolPage === 'reader' && originalReader === original && !closed) {
          readerDocument = result;
          pageStatus('Перевод готов.');
        }
      } catch (error) {
        if (!operation.signal.aborted) pageStatus(error instanceof TypeError || error.name === 'TimeoutError'
          ? 'Не удалось связаться с сервисом перевода.' : error.message);
      } finally {
        if (readerTranslation === operation) readerTranslation = undefined;
        publish();
      }
    }

    async function controlMedia(tab, action) {
      const contents = tab.view.webContents;
      try {
        const changed = await contents.executeJavaScriptInIsolatedWorld(2, [{
          code: `(${mediaAction.toString()})(${JSON.stringify(action)})`,
        }], true);
        if (!changed && action === 'pip') pageStatus('На странице нет видео для отдельного окна.');
        return changed;
      } catch {
        if (action === 'pip') pageStatus('Это видео не удалось открыть в отдельном окне.');
        return false;
      }
    }

    function mediaCandidates() {
      return [...tabs.values()].filter((tab) => tab.view && !tab.error && webURL(tab.url)).sort((a, b) =>
        Number(Boolean(b.playingMedia)) - Number(Boolean(a.playingMedia)) ||
        Number(b.id === mediaTabId) - Number(a.id === mediaTabId) ||
        Number(Boolean(b.playedMedia)) - Number(Boolean(a.playedMedia)) || b.lastActive - a.lastActive);
    }

    function currentMedia() {
      return mediaCandidates().find((tab) => tab.playedMedia);
    }

    function describeMedia(tab) {
      return tab ? { title: tab.title, source: new URL(tab.url).hostname, playing: Boolean(tab.playingMedia) } : null;
    }

    async function homeMedia(action) {
      if (action === 'tab') {
        const chosen = currentMedia();
        if (chosen) { selectTab(chosen); return { ok: true }; }
      } else {
        for (const tab of mediaCandidates()) {
          if (!showingHome() || !tabs.has(tab.id)) break;
          const result = await controlMedia(tab, 'home-toggle');
          if (result && tabs.has(tab.id) && webURL(tab.url)) {
            tab.playedMedia = true;
            tab.playingMedia = result.playing;
            mediaTabId = tab.id;
            queuePublish();
            return { ok: true, media: describeMedia(tab) };
          }
        }
      }
      return { ok: false, message: 'В открытых вкладках нет доступного аудио или видео.' };
    }

    async function clearSiteData() {
      const origin = siteSettingsOrigin;
      if (clearingData || !siteOrigin(origin, false)) return;
      clearingData = true;
      publish();
      try {
        await browsingSession.clearData({ origins: [origin], dataTypes: siteStorageTypes, originMatchingMode: 'origin-in-all-contexts' });
        pageStatus('Данные сайта удалены. Перезагрузи страницу, чтобы применить изменения.');
      } catch { pageStatus('Не удалось полностью удалить данные сайта.'); }
      finally {
        clearingData = false;
        publish();
      }
    }

    async function clearBrowsingData({ period, categories } = {}) {
      if (clearingData || !Object.hasOwn(clearHours, period) || !Array.isArray(categories) || !categories.length ||
          !categories.every((category) => ['history', 'downloads', 'cookies', 'cache', 'permissions'].includes(category))) return;
      if ((period !== 'all' && categories.some((category) => ['cookies', 'cache', 'permissions'].includes(category))) ||
          (privateMode && categories.includes('history'))) return;
      const since = clearHours[period] ? Date.now() - clearHours[period] * 3_600_000 : 0;
      clearingData = true;
      publish();
      const failed = [];
      try {
        const data = new Set();
        if (categories.includes('cookies')) for (const type of siteStorageTypes) if (type !== 'cache') data.add(type);
        if (categories.includes('cache')) data.add('cache');
        if (data.size) {
          await browsingSession.clearData({ dataTypes: [...data] }).catch(() => failed.push('данные сайтов или кеш'));
        }
        if (categories.includes('history')) {
          try { prefs.clearHistory(since); } catch { failed.push('историю'); }
        }
        if (categories.includes('downloads')) windowDownloads.clear(since);
        if (categories.includes('permissions')) {
          try {
            if (privateMode) privateRules = {};
            else prefs.clearSiteRules();
          } catch { failed.push('разрешения'); }
        }
        for (const other of windows) other.historyChanged();
        pageStatus(failed.length ? `Не удалось полностью удалить ${failed.join(', ')}.` : 'Выбранные данные удалены.');
      } finally {
        clearingData = false;
        publish();
      }
    }

    function pageContext(tab, details) {
      if (!visibleTabs().includes(tab)) return;
      const contents = tab.view.webContents;
      const location = contents.getURL();
      const link = webURL(details.linkURL);
      const selected = details.selectionText?.trim().slice(0, 1500);
      const entries = [];
      const item = (label, act, enabled = true) => ({ label, enabled, click() {
        if (!closed && !contents.isDestroyed() && contents.getURL() === location) act();
      } });
      const separator = () => { if (entries.length) entries.push({ type: 'separator' }); };
      const options = details.frameURL ? { httpReferrer: { url: details.frameURL, policy: details.referrerPolicy } } : undefined;
      if (link) {
        entries.push(
          item('Открыть ссылку в новой вкладке', () => createTab(link, false, undefined, false, tabs.size, { loadOptions: options })),
          item('Открыть ссылку в новом окне', () => createWindow(privateMode, { url: link, loadOptions: options })),
          ...(!privateMode ? [item('Открыть ссылку в окне инкогнито', () => createWindow(true, { url: link }))] : []),
          item('Скопировать адрес ссылки', () => clipboard.writeText(link)),
        );
      }
      if (details.isEditable) {
        separator();
        for (const suggestion of details.dictionarySuggestions?.slice(0, 5) || []) {
          entries.push(item(suggestion, () => contents.replaceMisspelling(suggestion)));
        }
        const { canCut, canCopy, canPaste, canSelectAll, canUndo, canRedo } = details.editFlags;
        entries.push(item('Отменить ввод', () => contents.undo(), canUndo), item('Повторить ввод', () => contents.redo(), canRedo),
          item('Вырезать', () => contents.cut(), canCut), item('Копировать', () => contents.copy(), canCopy),
          item('Вставить', () => contents.paste(), canPaste), item('Выделить всё', () => contents.selectAll(), canSelectAll));
      } else if (selected) {
        separator();
        entries.push(item('Скопировать текст', () => contents.copy()));
      }
      if (selected) {
        entries.push(item('Найти выделенный текст', () => {
          createTab(resolveAddress(selected, prefs.current.settings.search, true, prefs.current.searchEngines));
        }));
      }
      separator();
      const nav = contents.navigationHistory;
      entries.push(item('Назад', () => nav.goBack(), nav.canGoBack()), item('Вперёд', () => nav.goForward(), nav.canGoForward()),
        item('Обновить', () => reloadTab(tab)), item('Сохранить страницу в PDF…', () => void savePDF(tab)));
      Menu.buildFromTemplate(entries).popup({ window });
    }

    async function refreshBookmarks() {
      if (privateMode) return;
      try {
        bookmarkItems = await library.tree();
        publish();
      } catch { pageStatus('Не удалось открыть закладки.'); }
    }

    function downloadsChanged() {
      if (!closed && toolPage === 'downloads') chrome.webContents.send('browser:downloads', windowDownloads.list());
    }

    function closeTool() {
      if (!toolPage) return;
      if (toolPage === active.tool) {
        closeTab(active.id, false);
        return;
      }
      setToolPage(active.tool);
      redraw();
      if (showingSite()) active.view.webContents.focus();
    }

    function openTool(page) {
      extensionPanel.close();
      closeFind(false);
      credentials.reset(active);
      if (settingsOpen) credentials.leaveSettings();
      settingsOpen = false;
      setToolPage(page);
      dropdownHeight = 0;
      redraw();
      chrome.webContents.focus();
      downloadsChanged();
      if (page === 'tasks') chrome.webContents.send('browser:tasks', taskList(app, tabs.values()));
    }

    function createFindPopup() {
      const view = new WebContentsView({
        webPreferences: { ...isolated, partition: 'bro2-interface', preload: path.join(__dirname, 'find-preload.js') },
      });
      view.setBackgroundColor('#00000000');
      view.setVisible(false);
      const { webContents } = view;
      secureShellView(webContents);
      const fromFind = (event) => !closed && event.senderFrame === webContents.mainFrame && event.senderFrame?.url === findURL;
      webContents.ipc.on('browser:find-text', (event, text, direction) => {
        if (fromFind(event)) findText(text, direction);
      });
      webContents.ipc.on('browser:close-find', (event) => {
        if (fromFind(event)) closeFind();
      });
      findPopup = view;
      findReady = webContents.loadFile(findFile);
    }

    function openFind() {
      if (!showingSite()) return;
      credentials.dismiss();
      dropdownHeight = 0;
      const fresh = !find;
      const request = find ??= { text: '', request: null };
      if (!findPopup) createFindPopup();
      void findReady.then(() => {
        if (closed || find !== request || !showingSite()) return;
        findPopup.setVisible(true);
        redraw();
        findPopup.webContents.focus();
        findPopup.webContents.send('browser:find-focus', appearance(), fresh);
      }).catch(() => {
        if (closed || !findPopup) return;
        closeFind();
        window.contentView.removeChildView(findPopup);
        findPopup.webContents.close();
        findPopup = findReady = undefined;
        pageStatus('Не удалось открыть поиск на странице.');
      });
    }

    function closeFind(focus = true) {
      if (!find) return;
      find = null;
      findPopup.setVisible(false);
      active.view.webContents.stopFindInPage('clearSelection');
      if (focus) {
        redraw();
        if (showingSite()) active.view.webContents.focus();
      }
    }

    function findText(input, direction) {
      if (!find || !showingSite() || typeof input !== 'string') return;
      const text = input.slice(0, 500);
      const contents = active.view.webContents;
      if (!text) {
        find.text = '';
        find.request = null;
        contents.stopFindInPage('clearSelection');
        return;
      }
      const replace = text !== find.text;
      find.text = text;
      find.request = contents.findInPage(text, { findNext: replace, forward: direction !== -1 });
    }

    function changeZoom(direction) {
      if (!showingSite()) return;
      const contents = active.view.webContents;
      const current = Math.round(contents.getZoomFactor() * 100);
      const level = direction === 0 ? 100 : direction > 0 ? zoomStops.find((stop) => stop > current)
        : zoomStops.findLast((stop) => stop < current);
      if (level !== undefined) {
        contents.setZoomFactor(level / 100);
        const origin = siteOrigin(active.url, false);
        if (origin) {
          try {
            if (privateMode) privateZoom.set(origin, level);
            else {
              prefs.setSiteZoom(origin, level);
              for (const other of windows) other.zoomChanged(origin, level);
            }
          } catch { pageStatus('Не удалось сохранить масштаб сайта.'); }
        }
      }
      chrome.webContents.send('browser:zoom', level ?? current);
    }

    function openExtensions() {
      if (privateMode) return;
      if (storeListing(active.url)) extensionStoreSource = active.url;
      const existing = [...tabs.values()].find((tab) => tab.tool === 'extensions');
      if (existing) selectTab(existing);
      else createTab('', true, undefined, false, tabs.size, { tool: 'extensions' });
    }

    function addReadingList(tab) {
      if (privateMode || !webURL(tab.url)) return;
      try {
        const added = prefs.addReadingList(tab.url, tab.title);
        for (const owner of windows) owner.readingListChanged();
        pageStatus(added ? 'Страница добавлена в список для чтения.' : 'Страница уже в списке для чтения.');
      } catch { pageStatus('Не удалось обновить список для чтения.'); }
    }

    function openTabMenu({ id, x, y, selected } = {}) {
      const tab = tabs.get(id);
      if (!tab || !Number.isFinite(x) || !Number.isFinite(y) || tabMenu || browserMenu) return;
      const order = [...tabs.values()];
      const index = order.indexOf(tab);
      const nextPosition = Math.max(index + 1, order.filter((item) => item.pinned).length);
      const canCopy = !tab.tool && !tab.extension && !tab.source;
      const splitOpen = split?.includes(tab.id) && split.includes(active.id);
      const splitAllowed = tab !== active && showingSite() && !tab.error && Boolean(webURL(tab.url));
      const otherTabs = order.filter((item) => item !== tab && !item.pinned);
      const rightTabs = order.slice(index + 1).filter((item) => !item.pinned);
      const groups = new Map(order.filter((item) => item.group && item.group !== tab.group).map(({ group }) => [group.id, group]));
      const item = (label, click, enabled = true, accelerator) => ({ label, enabled, accelerator,
        click: () => { if (!closed && tabs.has(tab.id)) click(); } });
      const separator = { type: 'separator' };
      const menu = Menu.buildFromTemplate([
        item('Новая вкладка справа', () => createTab('', true, undefined, false, nextPosition, { group: tab.group })),
        item(splitOpen ? 'Закрыть параллельный просмотр' : 'Открыть параллельный просмотр с текущей вкладкой', () => {
          if (splitOpen) {
            split = undefined;
            redraw();
          } else {
            split = [active.id, tab.id];
            selectTab(tab);
          }
        }, splitOpen || splitAllowed),
        item('Добавить вкладку в новую группу', () => {
          const members = Array.isArray(selected) && selected.includes(id)
            ? order.filter((entry) => !entry.pinned && selected.includes(entry.id)) : [tab];
          newGroup(members, true);
        }, !tab.pinned),
        ...(groups.size && !tab.pinned ? [{ label: 'Добавить вкладку в группу', submenu: [...groups.values()].map((group) =>
          item(group.title, () => addToGroup(tab, group))) }] : []),
        ...(tab.group ? [item('Убрать вкладку из группы', () => removeFromGroup(tab)),
          item('Имя и цвет группы', () => editGroup(tab.group)),
          ...(!privateMode ? [item('Сохранить и закрыть группу', () => saveAndCloseGroup(tab.group))] : [])] : []),
        item('Открыть вкладку в новом окне', () => {
          createWindow(privateMode, { ...copyTab(tab), group: undefined });
          closeTab(tab.id, false);
        }, canCopy),
        ...(!privateMode && canCopy && [...windows].some((other) => other !== owner && !other.privateMode) ? [{
          label: 'Переместить в окно', submenu: [...windows].filter((other) => other !== owner && !other.privateMode)
            .map((other) => item(other.listedTabs().find(({ url }) => url)?.title || 'Новая вкладка',
              () => transferTo(other, tab.id))),
        }] : []),
        item(verticalTabs ? 'Переместить выше' : 'Переместить влево', () => reorderTab(tab, order[order.indexOf(tab) - 1], false),
          order[order.indexOf(tab) - 1]?.pinned === tab.pinned),
        item(verticalTabs ? 'Переместить ниже' : 'Переместить вправо', () => reorderTab(tab, order[order.indexOf(tab) + 1], true),
          order[order.indexOf(tab) + 1]?.pinned === tab.pinned),
        separator,
        item('Перезагрузить', () => reloadTab(tab), Boolean(tab.url), 'Ctrl+R'),
        item('Выгрузить вкладку из памяти', () => suspendTab(tab), canSuspend(tab)),
        item('Дублировать', () => createTab(tab.url, true, undefined, false, nextPosition, copyTab(tab)), canCopy),
        item(tab.pinned ? 'Открепить' : 'Закрепить', () => pinTab(tab)),
        item(tab.muted ? 'Включить звук во вкладке' : 'Отключить звук во вкладке', () => {
          tab.muted = !tab.muted;
          tab.view?.webContents.setAudioMuted(tab.muted);
          publish();
        }, Boolean(tab.url)),
        ...(!privateMode ? [separator, item('Добавить вкладку в список для чтения', () => addReadingList(tab), Boolean(webURL(tab.url)))] : []),
        separator,
        item(verticalTabs ? 'Показать вкладки горизонтально' : 'Показать вкладки вертикально', () => {
          verticalTabs = !verticalTabs;
          redraw();
        }),
        separator,
        item('Закрыть', () => closeTab(tab.id), true, 'Ctrl+W'),
        ...(Array.isArray(selected) && selected.includes(id) && selected.length > 1 ? [{
          label: 'Закрыть выбранные вкладки',
          click: () => { if (!closed) for (const tabId of new Set(selected)) closeTab(tabId); },
        }] : []),
        item('Закрыть другие вкладки', () => { for (const other of otherTabs) closeTab(other.id); }, otherTabs.length > 0),
        item('Закрыть вкладки справа', () => { for (const other of rightTabs) closeTab(other.id); }, rightTabs.length > 0),
      ]);
      const { width, height } = window.getContentBounds();
      tabMenu = menu;
      menu.popup({ window, x: Math.round(Math.max(0, Math.min(x, width))), y: Math.round(Math.max(0, Math.min(y, height))),
        callback: () => { if (tabMenu === menu) tabMenu = undefined; } });
    }

    function groupMenu({ id, x, y } = {}) {
      const group = findGroup(id);
      if (!group || tabMenu || browserMenu || !Number.isFinite(x) || !Number.isFinite(y)) return;
      const order = [...tabs.values()];
      const first = order.findIndex((tab) => tab.group === group);
      const last = order.findLastIndex((tab) => tab.group === group);
      const item = (label, click, enabled = true) => ({ label, enabled, click: () => { if (findGroup(id) === group) click(); } });
      const menu = Menu.buildFromTemplate([
        item(group.collapsed ? 'Развернуть группу' : 'Свернуть группу', () => { group.collapsed = !group.collapsed; publish(); }),
        item('Имя и цвет группы', () => editGroup(group)),
        item(verticalTabs ? 'Переместить группу выше' : 'Переместить группу влево', () => moveGroup(group, order[first - 1], false),
          Boolean(order[first - 1] && !order[first - 1].pinned)),
        item(verticalTabs ? 'Переместить группу ниже' : 'Переместить группу вправо', () => moveGroup(group, order[last + 1], true),
          Boolean(order[last + 1])),
        item('Разгруппировать вкладки', () => {
          for (const tab of order) if (tab.group === group) tab.group = undefined;
          publish();
        }),
        ...(!privateMode ? [item('Сохранить и закрыть группу', () => saveAndCloseGroup(group))] : []),
      ]);
      const { width, height } = window.getContentBounds();
      tabMenu = menu;
      menu.popup({ window, x: Math.round(Math.max(0, Math.min(x, width))), y: Math.round(Math.max(0, Math.min(y, height))),
        callback: () => { if (tabMenu === menu) tabMenu = undefined; } });
    }

    function commandMenu() {
      if (browserMenu) return;
      const site = showingSite();
      const item = (label, command, accelerator, enabled = true, argument) => ({
        label, accelerator, enabled, click: () => { if (!closed && active) runCommand(command, argument); },
      });
      const separator = { type: 'separator' };
      const menu = Menu.buildFromTemplate([
        item('Новая вкладка', 'new', 'Ctrl+T'),
        item('Домашняя страница', 'home', 'Alt+Home'),
        item('Поиск по вкладкам', 'tab-search', 'Ctrl+Shift+A'),
        ...(!privateMode ? [item('Сохранённые группы', 'saved-groups')] : []),
        ...(split?.includes(active.id) ? [{ label: 'Расположение разделённого экрана', submenu: [
          item('Автоматически', 'split-direction', undefined, true, 'auto'),
          item('Рядом', 'split-direction', undefined, true, 'horizontal'),
          item('Друг под другом', 'split-direction', undefined, true, 'vertical'),
        ] }] : []),
        item('Восстановить вкладку или окно', 'restore', 'Ctrl+Shift+T', (privateMode ? closedTabs : recent).length > 0),
        item('Новое окно', 'window', 'Ctrl+N'),
        item('Окно инкогнито', 'private', 'Ctrl+Shift+N'),
        separator,
        item('Найти на странице', 'find', 'Ctrl+F', site),
        item('История', 'history', 'Ctrl+H'),
        item('Закладки', 'bookmarks', 'Ctrl+Shift+O', !privateMode),
        item('Загрузки', 'downloads', 'Ctrl+J'),
        item('Разрешения и данные сайтов', 'site-settings'),
        item('Удалить данные браузера…', 'clear-data', 'Ctrl+Shift+Delete'),
        ...(!privateMode ? [item('Список для чтения', 'reading-list'), item('Расширения', 'extensions')] : []),
        { label: 'Масштаб страницы', enabled: site, submenu: [
          item('Увеличить', 'zoom', 'Ctrl+Plus', true, 1),
          item('Уменьшить', 'zoom', 'Ctrl+-', true, -1),
          item('Вернуть 100%', 'zoom', 'Ctrl+0', true, 0),
        ] },
        separator,
        { label: 'Другие действия', submenu: [
          item('Печать', 'print', 'Ctrl+P', site),
          item('Сохранить страницу в PDF…', 'pdf', undefined, site),
          item('Режим чтения', 'reader', undefined, site && Boolean(webURL(active.url))),
          item('Картинка в картинке', 'pip', 'Ctrl+Shift+]', site && Boolean(webURL(active.url))),
          item('Пуск или пауза медиа', 'media-toggle', undefined, site && Boolean(webURL(active.url))),
          item('Снимок видимой части страницы…', 'snapshot', undefined, site),
          item('Сохранить страницу', 'save', 'Ctrl+S', site),
          item('Исходный код страницы', 'source', 'Ctrl+U', site && Boolean(webURL(active.url))),
          item('Инструменты разработчика', 'devtools', 'F12', site),
          item('Диспетчер задач', 'tasks', 'Shift+Esc'),
          item('Полноэкранный режим', 'fullscreen', 'F11'),
          ...(!privateMode ? [item('Добавить закладку', 'bookmark', 'Ctrl+D', site),
            item('Панель закладок', 'bookmarks-bar', 'Ctrl+Shift+B')] : []),
        ] },
        item('Настройки', 'settings', 'Ctrl+,'),
        ...(!privateMode ? [{ label: 'Локальные профили', submenu: registry.list().map((profile) => ({
          label: profile.name, type: 'normal', enabled: profile.id !== profileId,
          click: () => { try { openProfile(profile.id); } catch { pageStatus('Не удалось открыть профиль.'); } },
        })) }] : []),
        item('Закрыть вкладку', 'close', 'Ctrl+W'),
      ]);
      browserMenu = menu;
      chrome.webContents.send('browser:menu-state', true);
      const { width } = window.getContentBounds();
      menu.popup({ window, x: Math.max(0, width - 300), y: toolbarHeight - 6, callback: () => {
        if (browserMenu === menu) browserMenu = undefined;
        if (!closed) chrome.webContents.send('browser:menu-state', false);
      } });
    }

    async function savePage(tab) {
      const contents = tab.view.webContents;
      const address = tab.url;
      const filename = tab.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80).replace(/[ .]+$/, '') || 'BrO2';
      const { canceled, filePath } = await dialog.showSaveDialog(window, { title: 'Сохранить страницу',
        defaultPath: filename + '.mhtml', filters: [{ name: 'Веб-архив', extensions: ['mhtml'] }] });
      if (canceled || closed || contents.isDestroyed() || tab.url !== address) return;
      await contents.savePage(filePath, 'MHTML');
      pageStatus('Страница сохранена.');
    }

    async function savePDF(tab) {
      const contents = tab.view.webContents;
      const address = contents.getURL();
      const filename = tab.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80).replace(/[ .]+$/, '') || 'BrO2';
      try {
        const { canceled, filePath } = await dialog.showSaveDialog(window, {
          title: 'Сохранить страницу в PDF', defaultPath: filename + '.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }],
        });
        if (canceled || closed || contents.isDestroyed() || contents.getURL() !== address) return;
        const pdf = await contents.printToPDF({ printBackground: true });
        if (closed || contents.isDestroyed() || contents.getURL() !== address) return;
        await fs.writeFile(filePath, pdf);
        pageStatus('PDF сохранён.');
      } catch { pageStatus('Не удалось сохранить PDF.'); }
    }

    async function saveSnapshot(tab) {
      const contents = tab.view.webContents;
      const address = contents.getURL();
      try {
        const screenshot = await contents.capturePage();
        if (closed || contents.isDestroyed() || contents.getURL() !== address || screenshot.isEmpty()) return;
        const { canceled, filePath } = await dialog.showSaveDialog(window, {
          title: 'Сохранить снимок страницы', defaultPath: 'BrO2.png', filters: [{ name: 'PNG', extensions: ['png'] }],
        });
        if (canceled || closed) return;
        await fs.writeFile(filePath, screenshot.toPNG());
        pageStatus('Снимок сохранён.');
      } catch { pageStatus('Не удалось сохранить снимок страницы.'); }
    }

    function runCommand(command, argument) {
      const contents = active.view.webContents;
      const order = [...tabs.values()];
      const onPage = () => showingSite();
      const commands = {
        new: () => createTab(),
        close: () => closeTab(active.id),
        restore: () => {
          const item = (privateMode ? closedTabs : recent).shift();
          if (item?.type === 'window') createWindow(false, undefined, item.window);
          if (item?.type === 'tab') {
            const group = item.tab.group && order.find((tab) => tab.group?.id === item.tab.group.id &&
              tab.group.title === item.tab.group.title)?.group;
            createTab(item.tab.url, true, undefined, false, item.position, { ...item.tab, group });
          }
          if (!privateMode) scheduleSessionSave();
        },
        window: () => createWindow(),
        private: () => createWindow(true),
        'close-window': () => window.close(),
        menu: commandMenu,
        cycle: () => selectTab(order[(order.indexOf(active) + argument + order.length) % order.length]),
        'tab-number': () => selectTab(argument === 9 ? order.at(-1) : order[argument - 1]),
        address: focusAddress,
        settings: toggleSettings,
        back: () => { if (onPage() || (!settingsOpen && !toolPage)) contents.navigationHistory.goBack(); },
        forward: () => { if (onPage() || (!settingsOpen && !toolPage)) contents.navigationHistory.goForward(); },
        reload: () => reload(),
        'hard-reload': () => reload(true),
        escape: () => {
          if (find) closeFind();
          else if (toolPage) closeTool();
          else if (active.loading) contents.stop();
        },
        home: () => {
          const home = sessionURL(prefs.current.settings.homePage) || 'about:blank';
          if (settingsOpen) toggleSettings();
          if (toolPage && toolPage !== active.tool) closeTool();
          if (active.tool || active.extension || active.source) createTab(home === 'about:blank' ? '' : home);
          else if (active.url || home !== 'about:blank') navigate(active, home);
          else focusAddress();
        },
        fullscreen: () => window.setFullScreen(!window.isFullScreen()),
        zoom: () => changeZoom(argument),
        find: openFind,
        'find-step': () => { if (find?.text) findText(find.text, argument); else openFind(); },
        history: () => openTool('history'),
        'tab-search': () => openTool('tab-search'),
        'saved-groups': () => { if (!privateMode) openTool('saved-groups'); },
        'vertical-tabs': () => { verticalTabs = !verticalTabs; redraw(); },
        'split-direction': () => { splitDirection = argument; layout(); },
        bookmarks: () => { if (!privateMode) openTool('bookmarks'); },
        downloads: () => openTool('downloads'),
        'site-settings': () => openSiteSettings(false),
        'clear-data': () => openTool('clear-data'),
        pdf: () => { if (onPage()) void savePDF(active); },
        reader: () => { if (onPage() && webURL(active.url)) void openReader(active); },
        pip: () => { if (onPage() && webURL(active.url)) void controlMedia(active, 'pip'); },
        'media-toggle': () => {
          if (onPage() && webURL(active.url)) void controlMedia(active, 'toggle').then((ok) => {
            if (!ok) pageStatus('На странице нет медиа для воспроизведения.');
          });
        },
        snapshot: () => { if (onPage()) void saveSnapshot(active); },
        'reading-list': () => { if (!privateMode) openTool('reading-list'); },
        extensions: openExtensions,
        bookmark: () => {
          if (privateMode || !onPage() || !webURL(active.url)) return;
          void library.add(active.title, active.url).then((added) => {
            for (const owner of windows) void owner.bookmarksChanged();
            pageStatus(added ? 'Закладка добавлена.' : 'Эта страница уже в закладках.');
          }).catch(() => pageStatus('Не удалось сохранить закладку.'));
        },
        'bookmarks-bar': () => {
          if (privateMode) return;
          try {
            prefs.setSetting('bookmarkBar', !bookmarkBar());
            redraw();
            void refreshBookmarks();
          } catch { pageStatus('Не удалось изменить панель закладок.'); }
        },
        print: () => {
          if (onPage()) contents.print({}, (printed, reason) => {
            if (!printed && reason && !/cancel/i.test(reason)) pageStatus('Не удалось распечатать страницу.');
          });
        },
        save: () => { if (onPage()) void savePage(active).catch(() => pageStatus('Не удалось сохранить страницу.')); },
        source: () => {
          if (onPage() && webURL(active.url)) {
            createTab('view-source:' + active.url, true, undefined, true, order.indexOf(active) + 1);
          }
        },
        devtools: () => {
          if (onPage()) {
            if (contents.isDevToolsOpened()) contents.closeDevTools();
            else contents.openDevTools({ mode: 'detach' });
          }
        },
        tasks: () => openTool('tasks'),
      };
      if (Object.hasOwn(commands, command)) commands[command]();
    }

    function handleShortcut(event, input) {
      if (!active || input.type !== 'keyDown') return;
      if (find && input.key === 'Escape' && !input.shift && !input.control && !input.alt && !input.meta && !input.isComposing) {
        event.preventDefault();
        closeFind();
        return;
      }
      const command = shortcutCommand(input);
      if (!command) return;
      event.preventDefault();
      extensionPanel.close();
      runCommand(...command);
    }
    async function importGoogle() {
      if (importing || login) return;
      importing = true;
      status = '';
      publish();
      try {
        const { canceled, filePaths } = await dialog.showOpenDialog(window, {
          title: 'Выбери JSON клиента Google OAuth', properties: ['openFile'],
          filters: [{ name: 'Google OAuth', extensions: ['json'] }],
        });
        if (canceled || closed) return;
        const file = filePaths[0];
        if ((await fs.stat(file)).size > 32_768) throw new Error('Файл OAuth-клиента слишком большой.');
        const client = desktopClient(JSON.parse(await fs.readFile(file, 'utf8')));
        prefs.setGoogleClient(safeStorage.encryptString(JSON.stringify(client)).toString('base64'));
      } catch (error) {
        status = error instanceof SyntaxError ? 'Файл не удалось прочитать как JSON.' : error.message;
      } finally {
        importing = false;
        publish();
      }
    }

    async function chooseDownloadDirectory() {
      try {
        const { canceled, filePaths } = await dialog.showOpenDialog(window, {
          title: 'Папка для загрузок',
          defaultPath: prefs.current.downloadDirectory || app.getPath('downloads'),
          properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
        });
        if (canceled || closed || !settingsOpen || !filePaths[0]) return;
        prefs.setDownloadDirectory(filePaths[0]);
        for (const other of windows) other.historyChanged();
      } catch { pageStatus('Не удалось изменить папку загрузок.'); }
    }

    async function signIn() {
      if (importing || login || !prefs.current.googleClient || prefs.current.profile) return;
      login = new AbortController();
      status = 'Подтверди вход в браузере Windows.';
      publish();
      try {
        const client = JSON.parse(safeStorage.decryptString(Buffer.from(prefs.current.googleClient, 'base64')));
        const profile = await googleSignIn(client, (url) => shell.openExternal(url), login.signal);
        if (!closed && !login.signal.aborted) {
          prefs.setProfile(profile);
          status = '';
        }
      } catch (error) {
        if (login.signal.aborted) status = 'Вход отменён.';
        else if (error.name === 'TimeoutError') status = 'Время ожидания входа истекло.';
        else if (error instanceof TypeError) status = 'Не удалось связаться с Google. Проверь подключение и повтори вход.';
        else status = error.message;
      } finally {
        login = undefined;
        publish();
      }
    }

    function onAction(event, action, value) {
      if (!fromShell(event) || !active) return;
      const contents = active.view.webContents;
      switch (action) {
        case 'new': createTab(); break;
        case 'open-chatgpt':
          if (showingHome()) createTab('https://chatgpt.com/');
          break;
        case 'open-widget-link':
          if (showingHome() && !privateMode && feedURL(value)) createTab(feedURL(value));
          break;
        case 'settings-customize-home':
          if (settingsOpen && !privateMode) {
            if (!active.url && !active.error && !active.tool && !active.loading) toggleSettings();
            else createTab();
            chrome.webContents.send('browser:customize-home');
          }
          break;
        case 'settings-tool':
          if (!settingsOpen) break;
          if (value === 'site-settings') openSiteSettings(false);
          else if (value === 'clear-data' || value === 'history') openTool(value);
          else if (value === 'extensions' && !privateMode) openExtensions();
          break;
        case 'select': selectTab(tabs.get(value)); break;
        case 'switch-tab': {
          if (!Number.isInteger(value?.windowId) || !Number.isInteger(value?.id)) break;
          const target = [...windows].find((other) => other.window.id === value.windowId &&
            (privateMode ? other === owner : !other.privateMode));
          target?.switchTo(value.id);
          break;
        }
        case 'close': closeTab(value); break;
        case 'tab-menu': if (value && typeof value === 'object') openTabMenu(value); break;
        case 'group-menu': if (value && typeof value === 'object') groupMenu(value); break;
        case 'bookmark-folder-menu': if (value && typeof value === 'object') bookmarkFolderMenu(value); break;
        case 'navigation-menu': if (value && typeof value === 'object') navigationMenu(value); break;
        case 'tab-drag-start':
          if (typeof value?.token === 'string' && /^[a-f\d-]{36}$/i.test(value.token) &&
              (tabs.has(value.id) || findGroup(value.groupId))) {
            tabDrag = { owner, id: value.id, groupId: value.groupId, token: value.token };
          }
          break;
        case 'tab-drag-end':
          setTimeout(() => {
            if (tabDrag?.owner === owner && tabDrag.token === value) tabDrag = undefined;
          }, 400);
          break;
        case 'tab-drop': {
          const started = tabDrag;
          if (!started || started.token !== value?.token || (privateMode && started.owner !== owner)) break;
          tabDrag = undefined;
          const group = findGroup(value.targetGroupId);
          const target = group ? [...tabs.values()].find((tab) => tab.group === group) : tabs.get(value.targetId);
          if (started.owner === owner) {
            const tab = tabs.get(started.id);
            if (started.groupId) moveGroup(findGroup(started.groupId), target, Boolean(value.after));
            else if (tab && !tab.pinned && group && value.combine) addToGroup(tab, group);
            else if (value.combine && tab && target && target !== tab && !tab.pinned && !target.pinned) {
              if (target.group) addToGroup(tab, target.group);
              else newGroup([target, tab]);
            } else reorderTab(tab, target, Boolean(value.after));
          } else if (started.id && windows.has(started.owner) && !started.owner.privateMode) {
            const transfer = started.owner.transferTab(started.id);
            if (transfer) {
              owner.receiveTab(transfer.snapshot, target?.id, Boolean(value.after));
              transfer.remove();
            }
          }
          break;
        }
        case 'toggle-group': {
          const group = findGroup(value);
          if (group) { group.collapsed = !group.collapsed; publish(); }
          break;
        }
        case 'rename-group': {
          if (toolPage !== 'group-settings' || typeof value?.title !== 'string') break;
          const group = findGroup(groupSettingsId);
          const title = value.title.trim().slice(0, 64);
          if (title && group && /^#[\da-f]{6}$/i.test(value.color)) {
            group.title = title;
            group.color = value.color;
            closeTool();
          }
          break;
        }
        case 'show-saved-groups': if (!privateMode) openTool('saved-groups'); break;
        case 'saved-group':
          if (!privateMode && toolPage === 'saved-groups') {
            const record = prefs.current.savedGroups.find((item) => item.id === value?.id);
            if (!record) break;
            if (value.action === 'open' || value.action === 'window') reopenGroup(record, value.action === 'window');
            if (value.action === 'delete') {
              try {
                prefs.setSavedGroups(prefs.current.savedGroups.filter((item) => item !== record));
                for (const owner of windows) owner.historyChanged();
              } catch { pageStatus('Не удалось удалить сохранённую группу.'); }
            }
          }
          break;
        case 'go':
          if (typeof value === 'string') openAddress(value);
          break;
        case 'dropdown':
          dropdownHeight = Number.isInteger(value) ? Math.max(0, Math.min(value, 300)) : 0;
          if (dropdownHeight) credentials.dismiss();
          layout();
          break;
        case 'shortcut': {
          if (privateMode) break;
          if (typeof value?.url !== 'string' || typeof value.title !== 'string') break;
          const url = webURL(value.url);
          if (!url) break;
          const { username, password } = new URL(url);
          if (username || password) break;
          try {
            const title = value.title.trim().slice(0, 50);
            prefs.setShortcut(url, title);
            if (title && active.url === url) rememberShortcutIcon(url, active.favicon);
            loadShortcutIcons();
            for (const other of windows) if (other !== owner) other.historyChanged();
          }
          catch { status = 'Не удалось сохранить ярлык.'; }
          publish();
          break;
        }
        case 'clear-history':
          if (!settingsOpen || privateMode) break;
          try {
            prefs.clearHistory();
            status = 'История очищена.';
            for (const other of windows) if (other !== owner) other.historyChanged();
          }
          catch { status = 'Не удалось очистить историю.'; }
          publish();
          break;
        case 'history-remove':
          if (privateMode || toolPage !== 'history' || typeof value !== 'string') break;
          try {
            prefs.removeVisit(value);
            for (const other of windows) other.historyChanged();
          } catch { pageStatus('Не удалось удалить посещение.'); }
          break;
        case 'history-clear-range': {
          if (privateMode || toolPage !== 'history' || typeof value !== 'string' || !Object.hasOwn(clearHours, value)) break;
          try {
            prefs.clearHistory(clearHours[value] ? Date.now() - clearHours[value] * 3_600_000 : 0);
            for (const other of windows) other.historyChanged();
            pageStatus('История за выбранный период удалена.');
          } catch { pageStatus('Не удалось очистить историю.'); }
          break;
        }
        case 'current-site-settings':
          if (showingSite() && siteOrigin(active.url, false)) openSiteSettings();
          break;
        case 'select-site-settings':
          if (toolPage === 'site-settings' && (value === '' || Object.hasOwn(currentSiteRules(), value))) {
            siteSettingsOrigin = value;
            publish();
          }
          break;
        case 'set-site-rule':
          if (toolPage !== 'site-settings' || !siteOrigin(siteSettingsOrigin, false) || !value ||
              !Object.hasOwn(permissionNames, value.type) || !['ask', 'block', 'allow'].includes(value.decision) ||
              (value.type !== 'popups' && !siteOrigin(siteSettingsOrigin)) ||
              (value.type === 'geolocation' && value.decision === 'allow' && !geolocationEnabled)) break;
          try {
            setSiteRule(siteSettingsOrigin, [value.type], value.decision);
            for (const other of windows) if (other !== owner) other.historyChanged();
          } catch { pageStatus('Не удалось сохранить разрешение.'); }
          break;
        case 'clear-site-data':
          if (toolPage === 'site-settings') void clearSiteData();
          break;
        case 'clear-browsing-data':
          if (toolPage === 'clear-data' && value) void clearBrowsingData(value).catch(() => pageStatus('Не удалось удалить данные.'));
          break;
        case 'reader-translate':
          if (toolPage === 'reader') void translateReader(value);
          break;
        case 'reader-translation-cancel':
          if (toolPage === 'reader') readerTranslation?.abort();
          break;
        case 'reader-original':
          if (toolPage === 'reader' && originalReader) {
            readerTranslation?.abort();
            readerDocument = originalReader;
            publish();
          }
          break;
        case 'back': contents.navigationHistory.goBack(); break;
        case 'forward': contents.navigationHistory.goForward(); break;
        case 'reload': reload(); break;
        case 'stop': contents.stop(); break;
        case 'settings': toggleSettings(); break;
        case 'menu': commandMenu(); break;
        case 'site-settings': openSiteSettings(false); break;
        case 'extensions': openExtensions(); break;
        case 'extension-panel':
          if (!privateMode && (value?.id === undefined || typeof value.id === 'string')) {
            void extensionPanel.show(value?.anchor, value?.id);
          }
          break;
        case 'extension-panel-dismiss': extensionPanel.close(false, true); break;
        case 'shortcut-key': {
          if (!value || typeof value.code !== 'string') break;
          const command = shortcutCommand(value);
          if (command) runCommand(...command);
          break;
        }
        case 'escape': runCommand('escape'); break;
        case 'close-tool': closeTool(); break;
        case 'refresh-tasks':
          if (toolPage === 'tasks') chrome.webContents.send('browser:tasks', taskList(app, tabs.values()));
          break;
        case 'close-tasks':
          if (toolPage === 'tasks' && Number.isInteger(value) && value > 0) {
            for (const tab of [...tabs.values()]) {
              if (tab.view?.webContents.getOSProcessId() === value) closeTab(tab.id, true, true);
            }
            chrome.webContents.send('browser:tasks', taskList(app, tabs.values()));
          }
          break;
        case 'download-action':
          if (toolPage === 'downloads' && ['stop', 'pause', 'resume', 'open', 'folder', 'forget'].includes(value?.action)) {
            Promise.resolve().then(() => windowDownloads.act(value.id, value.action, shell))
              .catch((error) => pageStatus(error.message));
          }
          break;
        case 'clear-downloads':
          if (toolPage === 'downloads') windowDownloads.clear();
          break;
        case 'download-directory':
          if (settingsOpen && !privateMode) void chooseDownloadDirectory();
          break;
        case 'download-directory-reset':
          if (!settingsOpen || privateMode) break;
          try {
            prefs.setDownloadDirectory(undefined);
            for (const other of windows) other.historyChanged();
          } catch { pageStatus('Не удалось вернуть папку загрузок Windows.'); }
          break;
        case 'default-browser':
          if (settingsOpen && !privateMode) {
            void openDefaultBrowserSettings(process.execPath, shell).catch((error) => {
              status = error.code ? 'Не удалось зарегистрировать BrO2 в Windows.' : error.message;
              publish();
            });
          }
          break;
        case 'reading-remove':
          if (toolPage === 'reading-list' && !privateMode && typeof value === 'string') {
            try {
              if (prefs.removeReadingList(value)) for (const owner of windows) owner.readingListChanged();
            } catch { pageStatus('Не удалось обновить список для чтения.'); }
          }
          break;
        case 'preference':
          if (typeof value?.key !== 'string' ||
              (!settingsOpen && !(value.key === 'theme' && showingHome() && !privateMode))) break;
          if (['homePage', 'startupPages'].includes(value.key) ||
              (privateMode && ['promptDownloads', 'startup', 'spellcheck', 'spellLanguages', 'memorySaver', 'memoryIdle', 'memoryExceptions'].includes(value.key))) break;
          try {
            prefs.setSetting(value.key, value.value);
            if (['spellcheck', 'spellLanguages'].includes(value.key)) updateSpelling(regularSession);
            status = '';
          } catch (error) {
            status = value.key === 'memoryExceptions' && !error.code ? error.message : 'Не удалось сохранить настройки.';
          }
          for (const owner of windows) {
            owner.updateMemoryTimer();
            owner.historyChanged();
          }
          if (privateMode) publish();
          break;
        case 'google-import': if (settingsOpen && !privateMode) void importGoogle(); break;
        case 'google-setup':
          if (settingsOpen && !privateMode) shell.openExternal('https://console.cloud.google.com/auth/clients').catch(() => {
            status = 'Не удалось открыть Google Cloud.';
            publish();
          });
          break;
        case 'google-sign-in': if (settingsOpen && !privateMode) void signIn(); break;
        case 'google-cancel': if (settingsOpen) login?.abort(); break;
        case 'google-sign-out':
          if (!settingsOpen || privateMode || importing || login) break;
          try {
            prefs.setProfile(null);
            status = '';
          } catch {
            status = 'Не удалось удалить профиль.';
          }
          publish();
          break;
      }
    }

    function fromShell(event) {
      return !closed && event.sender === chrome.webContents && event.senderFrame === chrome.webContents.mainFrame &&
        event.senderFrame?.url === shellURL;
    }

    chrome.webContents.ipc.on('browser:appearance', (event) => {
      if (!fromShell(event)) { event.returnValue = null; return; }
      event.returnValue = appearance();
    });
    chrome.webContents.ipc.on('browser:caption', (event, color, symbolColor) => {
      const validColor = (value) => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);
      if (fromShell(event) && validColor(color) && validColor(symbolColor)) window.setTitleBarOverlay({ color, symbolColor });
    });

    chrome.webContents.ipc.handle('browser:home', async (event, action, value) => {
      if (!fromShell(event)) return { ok: false };
      if (action === 'voice-cancel') { voice?.abort(); return { ok: true }; }
      if (!showingHome()) return { ok: false, status: 'cancelled' };
      if (action === 'voice') {
        if (voice) return { status: 'failed' };
        const request = new AbortController();
        voice = request;
        try { return await recognizeRussian(value, request.signal); }
        finally { if (voice === request) voice = undefined; }
      }
      if (privateMode) return { ok: false, message: 'Действие недоступно в режиме инкогнито.' };
      if (action === 'save' && value && typeof value === 'object') {
        try {
          prefs.setHome(value);
          for (const owner of windows) owner.historyChanged();
          return { ok: true, layout: prefs.current.home };
        } catch { return { ok: false, message: 'Не удалось сохранить раскладку.' }; }
      }
      if (action === 'media' && ['toggle', 'tab'].includes(value)) return homeMedia(value);
      if (action === 'data' && ['weather', 'feed', 'news'].includes(value?.kind)) {
        const { kind } = value;
        const config = homeLayout({ [kind === 'weather' ? 'city' : kind]: value.value });
        const requested = config[kind === 'weather' ? 'city' : kind];
        if (!requested) return { ok: false, message: 'Укажи источник в настройках виджета.' };
        try { return { ok: true, data: await widgets.load(kind, requested) }; }
        catch (error) {
          return { ok: false, message: error instanceof TypeError || error.name === 'TimeoutError'
            ? 'Нет связи с источником. Проверь подключение к интернету.' : error.message };
        }
      }
      return { ok: false };
    });

    chrome.webContents.ipc.handle('browser:bookmarks', async (event, action, value) => {
      if (!fromShell(event) || privateMode || toolPage !== 'bookmarks' || !value ||
          !['create-folder', 'edit', 'delete', 'reorder'].includes(action)) return { ok: false };
      try {
        await library.edit(action, value);
        for (const other of windows) void other.bookmarksChanged();
        return { ok: true };
      } catch (error) { return { ok: false, message: error.message }; }
    });

    chrome.webContents.ipc.handle('browser:startup-pages', (event, home, pages) => {
      if (!fromShell(event) || privateMode || !settingsOpen) return { ok: false, message: 'Действие недоступно.' };
      if (typeof home !== 'string' || !Array.isArray(pages) || pages.length > 20 ||
          (home && !sessionURL(home)) || !pages.every(sessionURL)) {
        return { ok: false, message: 'Укажи до 20 адресов HTTP или HTTPS без логина и пароля.' };
      }
      try {
        prefs.setStartupPages(home && sessionURL(home), [...new Set(pages.map(sessionURL))]);
        for (const other of windows) other.historyChanged();
        return { ok: true, message: 'Адреса сохранены.' };
      } catch { return { ok: false, message: 'Не удалось сохранить адреса.' }; }
    });

    chrome.webContents.ipc.handle('browser:local-profiles', (event, action, value) => {
      if (!fromShell(event) || privateMode || !settingsOpen) return { ok: false, message: 'Действие недоступно.' };
      try {
        if (action === 'open') openProfile(value);
        else if (action === 'create') openProfile(registry.create(value).id);
        else if (action === 'rename') {
          registry.rename(profileId, value);
          updateProfileWindows();
        } else return { ok: false, message: 'Действие недоступно.' };
        return { ok: true };
      } catch (error) { return { ok: false, message: error.message }; }
    });

    chrome.webContents.ipc.handle('browser:search-engine', (event, action, value) => {
      if (!fromShell(event) || privateMode || !settingsOpen || !['save', 'remove'].includes(action)) return { ok: false };
      try {
        prefs.changeSearchEngine(action, value);
        for (const other of windows) other.historyChanged();
        return { ok: true };
      } catch (error) { return { ok: false, message: error.message }; }
    });

    chrome.webContents.ipc.handle('browser:translation-settings', (event, value) => {
      if (!fromShell(event) || privateMode || !settingsOpen || !value) return { ok: false };
      try {
        if (value.disable === true) prefs.setTranslation(undefined);
        else {
          const endpoint = translationEndpoint(value.endpoint);
          if (!endpoint || typeof value.key !== 'string' || value.key.length > 2048) {
            return { ok: false, message: 'Укажи HTTPS-адрес API /translate или HTTP-адрес на localhost.' };
          }
          const existing = prefs.current.translation;
          const key = value.key ? safeStorage.encryptString(value.key).toString('base64')
            : existing?.endpoint === endpoint ? existing.key : '';
          prefs.setTranslation({ endpoint, key });
        }
        for (const other of windows) other.historyChanged();
        return { ok: true };
      } catch { return { ok: false, message: 'Не удалось сохранить настройки перевода.' }; }
    });

    chrome.webContents.ipc.handle('browser:extensions', async (event, action, id, page, anchor) => {
      if (!fromShell(event) || toolPage !== 'extensions' || privateMode) return { ok: false };
      const epoch = extensionEpoch;
      const valid = () => !closed && toolPage === 'extensions' && epoch === extensionEpoch;
      try {
        let result;
        switch (action) {
          case 'list': result = await extensions.list(); break;
          case 'choose': {
            if (choosingExtension) return { ok: false };
            choosingExtension = true;
            try {
              const chosen = await dialog.showOpenDialog(window, {
                title: 'Выбери папку распакованного расширения', properties: ['openDirectory', 'dontAddToRecent'],
              });
              if (!chosen.canceled && valid()) result = await extensions.preview(chosen.filePaths[0], owner, valid);
            } finally { choosingExtension = false; }
            break;
          }
          case 'store': {
            if (extensionDownload) return { ok: false, message: 'Пакет уже скачивается.' };
            extensionDownload = new AbortController();
            try { result = await extensions.previewStore(id, owner, valid, extensionDownload.signal); }
            finally { extensionDownload = undefined; }
            break;
          }
          case 'cancel': await extensions.cancel(owner); break;
          case 'install': await extensions.install(id, owner, valid); break;
          case 'enable':
          case 'disable':
          case 'remove': await extensions.change(id, action, valid); break;
          case 'open': {
            const url = extensions.page(id, page);
            if (!url) throw new Error('Страница расширения недоступна.');
            if (page === 'action') void extensionPanel.show(anchor, id);
            else createTab(url, true, new URL(url).hostname);
            break;
          }
          default: return { ok: false };
        }
        if (['install', 'enable', 'disable', 'remove'].includes(action)) {
          for (const other of windows) other.extensionsChanged();
        }
        return { ok: true, result };
      } catch (error) {
        if (!valid()) return { ok: true };
        return { ok: false, message: error.message };
      }
    });

    function secureShellView(webContents) {
      webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      webContents.on('will-navigate', (event) => event.preventDefault());
      webContents.on('will-attach-webview', (event) => event.preventDefault());
      webContents.on('before-input-event', handleShortcut);
    }
    for (const { webContents } of [chrome, passwordPopup]) secureShellView(webContents);
    chrome.webContents.ipc.on('browser:action', onAction);
    window.on('resize', () => layout());
    window.on('blur', () => { extensionPanel.close(); credentials.dismiss(); });
    window.on('focus', () => {
      if (!active || closed) return;
      layout();
      publish();
      void refreshBookmarks();
    });
    window.on('close', () => {
      if (privateMode || quitting) return;
      const snapshot = owner.snapshot();
      if (!snapshot) return;
      if (![...windows].some((other) => other !== owner && !other.privateMode)) lastRegularWindows = [snapshot];
      if (snapshot.tabs.some(({ url, pinned }) => url || pinned)) rememberClosed({ type: 'window', window: snapshot });
    });
    function updateMemoryTimer() {
      if (privateMode || !prefs.current.settings.memorySaver) {
        clearInterval(memoryTimer);
        memoryTimer = undefined;
        return;
      }
      memoryTimer ??= setInterval(() => {
        const limit = Date.now() - prefs.current.settings.memoryIdle * 60_000;
        for (const tab of [...tabs.values()]) if (tab.lastActive < limit && canSuspend(tab) && !isMemoryException(tab.url)) suspendTab(tab);
      }, 15_000);
    }
    updateMemoryTimer();
    window.on('closed', () => {
      clearInterval(memoryTimer);
      clearImmediate(queuedPublish);
      voice?.abort();
      shellMicrophones.delete(chromeId);
      closed = true;
      windows.delete(owner);
      extensionPanel.close();
      if (tabDrag?.owner === owner) tabDrag = undefined;
      if (!privateMode && !quitting) saveSession();
      login?.abort();
      readerTranslation?.abort();
      extensionDownload?.abort();
      void extensions.cancel(owner);
      if (privateMode) {
        windowDownloads.close();
        void Promise.allSettled([browsingSession.clearStorageData(), browsingSession.clearCache(), browsingSession.clearAuthCache()]);
      }
      credentials.close();
      chrome.webContents.ipc.removeListener('browser:action', onAction);
      chrome.webContents.ipc.removeHandler('browser:extensions');
      chrome.webContents.ipc.removeHandler('browser:home');
      for (const tab of tabs.values()) {
        tab.faviconFetch?.abort();
        tab.view?.webContents.close();
      }
      passwordPopup.webContents.close();
      findPopup?.webContents.close();
      chrome.webContents.close();
    });
    layout();
    Promise.all([
      chrome.webContents.loadFile(shellFile),
      passwordPopup.webContents.loadFile(passwordFile),
      privateMode ? Promise.resolve() : restored,
    ]).then(() => {
      if (closed) return;
      if (initialWindow?.tabs.length) {
        const groups = new Map();
        const restoredTabs = initialWindow.tabs.map((saved) => {
          const id = saved.group?.id;
          if (id !== undefined && !groups.has(id)) groups.set(id, saved.group);
          return deferTab({ ...saved, group: groups.get(id) });
        });
        nextGroupId = Math.max(0, ...groups.keys()) + 1;
        selectTab(restoredTabs[initialWindow.active] || restoredTabs[0]);
      } else createTab(initialTab?.url, true, undefined, false, tabs.size, initialTab);
      for (const link of pendingLinks.splice(0)) createTab(link);
      void refreshBookmarks();
    }).catch(() => {
      if (!closed) console.error('BrO2 interface could not be loaded.');
    });
    return owner;
  }
  return {
    open,
    refresh() { for (const owner of windows) owner.historyChanged(); },
    beforeQuit() {
      quitting = true;
      widgets.close();
      shortcutIcons.abort();
      saveSession(true);
    },
  };
}

app.on('window-all-closed', () => app.quit());

