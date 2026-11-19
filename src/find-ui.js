const field = document.getElementById('find-text');
const count = document.getElementById('find-count');
const previous = document.getElementById('find-previous');
const next = document.getElementById('find-next');
let matches = 0;
let ordinal = 0;

function updateCount() {
  count.textContent = matches ? `${Math.max(1, ordinal)} из ${matches}` : '0 из 0';
  previous.disabled = next.disabled = !matches;
}

function search(direction) {
  window.findPage.search(field.value, direction);
}

field.addEventListener('input', (event) => {
  if (event.isComposing) return;
  matches = ordinal = 0;
  updateCount();
  search(1);
});
field.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.isComposing) return;
  event.preventDefault();
  search(event.shiftKey ? -1 : 1);
});
next.addEventListener('click', () => search(1));
previous.addEventListener('click', () => search(-1));
document.getElementById('find-close').addEventListener('click', () => window.findPage.close());

window.findPage.onFocus((settings, fresh) => {
  window.applyTheme(settings);
  if (fresh) {
    field.value = '';
    matches = ordinal = 0;
    updateCount();
  }
  field.focus();
  field.select();
});
window.findPage.onResult((result) => {
  if (!field.value) return;
  if (result.matches >= 0) matches = result.matches;
  if (result.activeMatchOrdinal >= 0) ordinal = result.activeMatchOrdinal;
  updateCount();
});
