const startupMode = byId('startup-mode');
const homePage = byId('home-page');
const startupPages = byId('startup-pages');
const profileChoice = byId('local-profile-choice');
const profileDialog = byId('local-profile-dialog');
const profileSave = byId('local-profile-save');
const profileName = byId('local-profile-name');
let startupEditing = false;
let profileAction;
let profileSignature;
byId('default-browser').addEventListener('click', () => window.bro2.send('default-browser'));
byId('spell-enable').addEventListener('change', ({ target }) => window.bro2.send('preference', { key: 'spellcheck', value: target.checked }));
byId('spell-languages').addEventListener('change', ({ target }) => window.bro2.send('preference', { key: 'spellLanguages', value: target.value }));
byId('memory-saver').addEventListener('change', ({ target }) => window.bro2.send('preference', { key: 'memorySaver', value: target.checked }));
byId('memory-idle').addEventListener('change', ({ target }) => window.bro2.send('preference', { key: 'memoryIdle', value: Number(target.value) }));
byId('memory-exceptions-form').addEventListener('submit', (event) => {
  event.preventDefault();
  window.bro2.send('preference', { key: 'memoryExceptions', value: byId('memory-exceptions').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) });
});

function editProfile(action) {
  profileAction = action;
  byId('local-profile-dialog-title').textContent = action === 'create' ? 'Новый локальный профиль' : 'Переименовать профиль';
  profileName.value = action === 'rename' ? state.localProfiles.find(({ id }) => id === state.localProfileId).name : '';
  setMessage('local-profile-form-status');
  profileDialog.showModal();
}

for (const action of ['create', 'rename']) byId('local-profile-' + action).addEventListener('click', () => editProfile(action));
byId('local-profile-cancel').addEventListener('click', () => profileDialog.close());
function syncProfileOpen() { byId('local-profile-open').disabled = !profileChoice.value || profileChoice.value === state?.localProfileId; }
profileChoice.addEventListener('change', syncProfileOpen);
byId('local-profile-open').addEventListener('click', async () => {
  const response = await window.bro2.localProfiles('open', profileChoice.value);
  setMessage('local-profile-status', response.message);
});
byId('local-profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (profileSave.disabled) return;
  profileSave.disabled = true;
  try {
    const response = await window.bro2.localProfiles(profileAction, profileName.value);
    if (response.ok) profileDialog.close();
    else setMessage('local-profile-form-status', response.message);
  } catch { setMessage('local-profile-form-status', 'Не удалось сохранить профиль.'); }
  finally { profileSave.disabled = false; }
});

startupMode.addEventListener('change', () => window.bro2.send('preference', { key: 'startup', value: startupMode.value }));
for (const field of [homePage, startupPages]) {
  field.addEventListener('input', () => {
    startupEditing = true;
    setMessage('startup-status');
  });
}
byId('startup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const response = await window.bro2.startupPages(homePage.value.trim(), startupPages.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  if (response.ok) startupEditing = false;
  setMessage('startup-status', response.message);
});
window.bro2.onState((next) => {
  byId('startup-settings').hidden = next.privateMode;
  byId('local-profile-settings').hidden = next.privateMode;
  byId('windows-settings').hidden = next.privateMode;
  byId('spell-settings').hidden = next.privateMode;
  byId('memory-settings').hidden = next.privateMode;
  byId('memory-saver').checked = next.settings.memorySaver;
  byId('memory-idle').value = next.settings.memoryIdle;
  if (document.activeElement !== byId('memory-exceptions')) byId('memory-exceptions').value = next.settings.memoryExceptions.join('\n');
  byId('spell-enable').checked = next.settings.spellcheck;
  byId('spell-languages').value = next.settings.spellLanguages;
  byId('spell-languages').disabled = !next.settings.spellcheck;
  const { browser, electron, chromium } = next.versions;
  byId('about-versions').textContent = `BrO2 ${browser} · Chromium ${chromium} · Electron ${electron}`;
  if (!next.settingsOpen && profileDialog.open) profileDialog.close();
  const signature = JSON.stringify(next.localProfiles);
  if (signature !== profileSignature) {
    profileSignature = signature;
    const selected = profileChoice.value || next.localProfileId;
    profileChoice.replaceChildren(...next.localProfiles.map(({ id, name }) =>
      new Option(id === next.localProfileId ? `${name} (текущий)` : name, id)));
    profileChoice.value = selected;
    syncProfileOpen();
  }
  startupMode.value = next.settings.startup;
  if (!next.settingsOpen) {
    startupEditing = false;
    setMessage('startup-status');
  }
  if (!startupEditing) {
    homePage.value = next.settings.homePage;
    startupPages.value = next.settings.startupPages.join('\n');
  }
});

const customSearch = byId('custom-search-settings');
const translationSettings = byId('translation-settings');
const translationEndpointField = byId('translation-endpoint');
const translationKeyField = byId('translation-key');
const translationDisable = byId('translation-disable');
let translationSignature;

async function changeTranslation(value) {
  try {
    const result = await window.bro2.translationSettings(value);
    if (result.ok) translationKeyField.value = '';
    setMessage('translation-status', result.ok ? 'Настройки сохранены.' : result.message || 'Действие недоступно.');
  } catch { setMessage('translation-status', 'Не удалось сохранить настройки перевода.'); }
}

byId('translation-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void changeTranslation({ endpoint: translationEndpointField.value.trim(), key: translationKeyField.value });
});
translationDisable.addEventListener('click', () => void changeTranslation({ disable: true }));
window.bro2.onState((next) => {
  translationSettings.hidden = next.privateMode;
  const endpoint = next.translation?.endpoint || '';
  const signature = JSON.stringify([endpoint, next.translation?.keyConfigured]);
  if (translationSignature === signature) return;
  translationSignature = signature;
  translationEndpointField.value = endpoint;
  translationKeyField.placeholder = next.translation?.keyConfigured ? 'Ключ сохранён' : '';
  translationDisable.hidden = !endpoint;
});

const searchEngineForm = byId('custom-search-form');
const searchEngineName = byId('custom-search-name');
const searchEngineKeyword = byId('custom-search-keyword');
const searchEngineTemplate = byId('custom-search-template');
let enginesSignature;
let changingSearch = false;

async function changeSearch(action, value) {
  if (changingSearch) return false;
  changingSearch = true;
  try {
    const result = await window.bro2.searchEngine(action, value);
    setMessage('custom-search-status', result.ok ? 'Сохранено.' : result.message || 'Действие недоступно.');
    return result.ok;
  } catch {
    setMessage('custom-search-status', 'Не удалось сохранить поисковую систему.');
    return false;
  } finally { changingSearch = false; }
}

searchEngineForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (await changeSearch('save', {
    name: searchEngineName.value, keyword: searchEngineKeyword.value, template: searchEngineTemplate.value,
  })) searchEngineForm.reset();
});
window.bro2.onState((next) => {
  customSearch.hidden = next.privateMode;
  const signature = JSON.stringify(next.searchEngines);
  if (signature === enginesSignature) return;
  enginesSignature = signature;
  const rows = next.searchEngines.map(({ name, keyword, template }) => {
    const row = document.createElement('li');
    const label = document.createElement('strong');
    label.textContent = `${name} (${keyword})`;
    const actions = document.createElement('div');
    actions.className = 'vault-actions';
    actions.append(actionButton('Изменить', () => {
      searchEngineName.value = name;
      searchEngineKeyword.value = keyword;
      searchEngineTemplate.value = template;
      searchEngineName.focus();
    }), actionButton('Удалить', () => { void changeSearch('remove', keyword); }));
    row.append(label, actions);
    return row;
  });
  byId('custom-search-list').replaceChildren(...(rows.length ? rows : [emptyItem('Нет добавленных поисковых систем.')]));
});
