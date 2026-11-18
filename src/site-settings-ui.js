const siteOriginSelection = byId('site-settings-origin');
const siteRulesForm = [...document.querySelectorAll('[data-site-rule]')];
const siteClearDialog = byId('site-clear-dialog');
const clearData = byId('clear-data-page');
const clearPeriod = byId('clear-data-range');
let siteOptionsSignature;

byId('address-icon').addEventListener('click', () => window.bro2.send('current-site-settings'));
siteOriginSelection.addEventListener('change', () => window.bro2.send('select-site-settings', siteOriginSelection.value));
for (const select of siteRulesForm) {
  const initial = select.dataset.siteRule === 'popups' ? 'По умолчанию (блокировать)' : 'Спрашивать';
  select.append(new Option(initial, 'ask'), new Option('Разрешить', 'allow'), new Option('Заблокировать', 'block'));
  select.addEventListener('change', () => window.bro2.send('set-site-rule', { type: select.dataset.siteRule, decision: select.value }));
}
byId('site-clear-open').addEventListener('click', () => {
  siteClearDialog.returnValue = '';
  siteClearDialog.showModal();
});
siteClearDialog.addEventListener('close', () => {
  if (siteClearDialog.returnValue === 'confirm') window.bro2.send('clear-site-data');
});

function renderDataControls(next) {
  for (const field of clearData.querySelectorAll('input[name="categories"]')) {
    const history = field.value === 'history';
    field.closest('label').hidden = history && next.privateMode;
    field.disabled = next.clearingData || (history && next.privateMode) ||
      (clearPeriod.value !== 'all' && !['history', 'downloads'].includes(field.value));
  }
  clearPeriod.disabled = next.clearingData;
  byId('clear-data-submit').disabled = next.clearingData || !clearData.querySelector('input:enabled:checked');
}

clearData.addEventListener('change', () => renderDataControls(state));
clearData.addEventListener('submit', (event) => {
  event.preventDefault();
  const categories = new FormData(clearData).getAll('categories');
  if (categories.length) window.bro2.send('clear-browsing-data', { period: clearPeriod.value, categories });
});

window.bro2.onState((next) => {
  const settings = next.siteSettings;
  const origin = settings?.origin || '';
  byId('address-icon').disabled = !next.pageVisible || !/^https?:\/\//.test(next.url);
  byId('site-settings-page').hidden = !settings;
  byId('site-settings-empty').hidden = Boolean(origin);
  byId('site-settings-selection').hidden = !origin;
  if (!settings && siteClearDialog.open) siteClearDialog.close();
  if (settings) {
    const choices = [...new Set([...Object.keys(settings.rules), ...(origin ? [origin] : [])])].sort();
    const signature = JSON.stringify(choices);
    if (siteOptionsSignature !== signature) {
      siteOptionsSignature = signature;
      siteOriginSelection.replaceChildren(new Option('Выбери сайт', ''), ...choices.map((candidate) => new Option(candidate, candidate)));
    }
    siteOriginSelection.value = origin;
    const secure = origin.startsWith('https:');
    byId('site-connection').textContent = secure ? 'Соединение по HTTPS' : 'Соединение по HTTP без шифрования';
    const geolocation = byId('site-geolocation');
    geolocation.hidden = !secure;
    geolocation.textContent = settings.geolocationEnabled
      ? 'При разрешении Electron может передать сведения о сети в Google, а сайт получит координаты.'
      : 'Для геолокации нужен ключ Google Geolocation API.';
    for (const select of siteRulesForm) {
      const type = select.dataset.siteRule;
      select.value = settings.rules[origin]?.[type] ?? 'ask';
      select.disabled = type !== 'popups' && (!secure || (type === 'geolocation' && !settings.geolocationEnabled));
    }
    byId('site-clear-open').disabled = settings.clearing;
  }
  const clearOpen = next.toolPage === 'clear-data';
  if (clearOpen && clearData.hidden) clearData.reset();
  clearData.hidden = !clearOpen;
  if (clearOpen) renderDataControls(next);
});
