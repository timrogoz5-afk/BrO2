const { ipcRenderer } = require('electron');

if (process.isMainFrame && location.protocol === 'https:') {
  const documentId = crypto.randomUUID();
  const tokens = (field) => (field.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
  const has = (field, token) => tokens(field).includes(token);
  const isCode = (field) => has(field, 'one-time-code');
  const inputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const visible = (element) => element.isConnected && !element.matches(':disabled,[readonly]') &&
    !element.closest('[inert],[hidden]') && element.getClientRects().length > 0 && element.checkVisibility({
      visibilityProperty: true, opacityProperty: true, contentVisibilityAuto: true,
    });

  let current;
  let lastField;
  let dismissed = '';
  let chosen = false;
  let observer;

  function destination(form, submitter) {
    const action = submitter?.hasAttribute('formaction') ? submitter.formAction : form.action;
    const target = submitter?.getAttribute('formtarget') ?? form.getAttribute('target') ??
      document.querySelector('base[target]')?.target ?? '';
    const method = submitter?.hasAttribute('formmethod') ? submitter.formMethod : form.method;
    try {
      const url = new URL(action);
      if (url.origin !== location.origin || url.username || url.password || !['', '_self'].includes(target.toLowerCase())) return null;
      url.hash = '';
      return { url: url.href, method };
    } catch { return null; }
  }

  function identify(form) {
    if (!(form instanceof HTMLFormElement) || !form.isConnected) return null;
    const elements = [...form.elements];
    const action = destination(form);
    if (!action || action.method !== 'post') return null;
    const images = [...document.querySelectorAll('input[type=image]')].filter((element) => element.form === form);
    const submitActions = [];
    for (const element of [...elements, ...images]) {
      if (!['submit', 'image'].includes(element.type) || element.matches(':disabled')) continue;
      const result = destination(form, element);
      if (!result || result.method !== 'post') return null;
      submitActions.push(result.url);
    }

    const fields = elements.filter((element) => element instanceof HTMLInputElement && visible(element));
    const passwordFields = fields.filter((field) => field.type === 'password' && !isCode(field));
    const newFields = passwordFields.filter((field) => has(field, 'new-password'));
    const oldFields = passwordFields.filter((field) => has(field, 'current-password'));
    let kind;
    if (newFields.length) {
      if (newFields.length > 2 || oldFields.length > 1 || newFields.length + oldFields.length !== passwordFields.length) return null;
      kind = oldFields.length ? 'change' : 'registration';
    } else if (passwordFields.length === 1) kind = 'login';
    else if (passwordFields.length === 0 && !fields.some(isCode)) kind = 'username';
    else return null;

    const textFields = fields.filter((field) => ['text', 'email', 'tel'].includes(field.type) && !isCode(field));
    const explicit = textFields.filter((field) => has(field, 'username'));
    if (explicit.length > 1) return null;
    const username = explicit[0] || (kind !== 'username' && textFields.length === 1 ? textFields[0] : null);
    if (kind === 'username' && !username) return null;
    const password = oldFields[0] || (kind === 'login' ? passwordFields[0] : null);
    return { form, action, submitActions, kind, username, password, newFields };
  }

  function sameForm(a, b) {
    return a && b && a.form === b.form && a.action.url === b.action.url && a.kind === b.kind &&
      a.submitActions.length === b.submitActions.length && a.submitActions.every((url, index) => url === b.submitActions[index]) &&
      a.username === b.username && a.password === b.password && a.newFields.length === b.newFields.length &&
      a.newFields.every((field, index) => field === b.newFields[index]);
  }

  function clear() {
    if (current) ipcRenderer.send('password:form', { documentId });
    current = undefined;
    dismissed = '';
    observer?.disconnect();
  }

  function inspect(field, open = false, focus = false) {
    const found = field instanceof HTMLInputElement && identify(field.form);
    if (!found || (field !== found.username && field !== found.password && !found.newFields.includes(field))) {
      clear();
      return;
    }
    lastField = field;
    const username = found.username?.value || '';
    if (!sameForm(current, found) || (current.field !== field && open)) {
      current = { ...found, id: crypto.randomUUID(), field };
    }
    current.userValue = username;
    current.passwordValue = found.password?.value;
    current.newValues = found.newFields.map((element) => element.value);
    if (open) dismissed = '';
    ipcRenderer.send('password:form', { documentId, id: current.id, kind: found.kind, username: username.slice(0, 1024),
      open: open && current.id !== dismissed, focus });
    observer ??= new MutationObserver(() => {
      if (current && !sameForm(current, identify(current.form))) clear();
    });
    observer.observe(document, { subtree: true, childList: true });
    observer.observe(found.form, { subtree: true, attributes: true,
      attributeFilter: ['action', 'method', 'target', 'formaction', 'formmethod', 'formtarget',
        'autocomplete', 'type', 'hidden', 'disabled', 'readonly', 'inert'] });
  }

  function inspectCurrentField(force, focus) {
    const field = document.hasFocus() ? document.activeElement : lastField;
    if (field instanceof HTMLInputElement) {
      inspect(field, force, focus);
      if (current) return;
    }
    const forms = [...document.forms].map(identify).filter(Boolean);
    if (forms.length === 1) {
      const form = forms[0];
      inspect(form.password || form.newFields[0] || form.username, force, focus);
    } else ipcRenderer.send('password:no-form', documentId);
  }

  function reportDocument() {
    const passwordVisible = [...document.querySelectorAll('input[type=password]')].some(visible);
    const codeVisible = [...document.querySelectorAll('input[autocomplete]')].some((field) => isCode(field) && visible(field));
    const errorVisible = [...document.querySelectorAll('[role=alert], [aria-invalid=true]')]
      .some((element) => visible(element) && (element.matches('input') || element.textContent.trim()));
    ipcRenderer.send('password:result', { documentId, passwordVisible, codeVisible, errorVisible });
  }

  document.addEventListener('focusin', (event) => {
    if (!chosen) inspect(event.target, true);
  }, true);
  document.addEventListener('input', (event) => {
    if (!chosen && event.isTrusted && event.target === current?.field) inspect(event.target);
  }, true);
  document.addEventListener('keydown', (event) => {
    if (!event.isTrusted || event.isComposing) return;
    if (event.altKey && event.key === 'ArrowDown') {
      event.preventDefault();
      inspectCurrentField(true, true);
    } else if (event.key === 'Escape') ipcRenderer.send('password:dismiss', documentId);
  }, true);
  document.addEventListener('submit', (event) => {
    const form = identify(event.target);
    if (!event.isTrusted || !navigator.userActivation.isActive || !form) return;
    const target = destination(form.form, event.submitter);
    if (target?.method !== 'post') return;
    const username = form.username?.value || '';
    const password = (form.newFields[0] || form.password)?.value || '';
    if ((!password && form.kind !== 'username') || (form.kind === 'username' && !username) ||
        form.newFields.some((field) => field.value !== password)) return;
    ipcRenderer.sendSync('password:submitted', { documentId, kind: form.kind, username, password, target: target.url });
  }, true);
  window.addEventListener('pagehide', clear);
  window.addEventListener('DOMContentLoaded', () => ipcRenderer.send('password:document', documentId), { once: true });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) ipcRenderer.send('password:document', documentId);
  });
  ipcRenderer.on('password:result-check', (_event, id) => {
    if (id === documentId) reportDocument();
  });
  ipcRenderer.on('password:inspect', () => inspectCurrentField(true, true));
  ipcRenderer.on('password:restore', (_event, id, formId) => {
    if (id !== documentId || formId !== current?.id) return;
    dismissed = formId;
    chosen = true;
    if (visible(current.field)) current.field.focus();
    chosen = false;
  });

  function eligible(snapshot, generation) {
    if (!snapshot || current !== snapshot || !sameForm(snapshot, identify(snapshot.form))) return false;
    if (document.hasFocus() && document.activeElement !== snapshot.field) return false;
    if (snapshot.username && snapshot.username.value !== snapshot.userValue) return false;
    if (generation) return snapshot.newFields.length && snapshot.newFields.every((field, index) =>
      !field.value && field.value === snapshot.newValues[index]);
    return snapshot.password?.value === snapshot.passwordValue && !snapshot.passwordValue;
  }

  ipcRenderer.on('password:claim', async (_event, request) => {
    const snapshot = current;
    const { documentId: id, formId, nonce, generation } = request;
    if (id !== documentId || formId !== current?.id || !eligible(snapshot, generation)) {
      ipcRenderer.send('password:filled', documentId, nonce, false);
      return;
    }
    let entry;
    try { entry = await ipcRenderer.invoke('password:claim', { documentId, formId, nonce }); }
    catch { return; }
    if (!entry || !eligible(snapshot, generation) ||
        (!generation && snapshot.userValue && snapshot.userValue !== entry.username)) {
      ipcRenderer.send('password:filled', documentId, nonce, false);
      return;
    }
    const values = generation ? snapshot.newFields.map((field) => [field, entry.password]) : [];
    if (!generation && snapshot.username && !snapshot.userValue) values.push([snapshot.username, entry.username]);
    if (!generation && snapshot.password) values.push([snapshot.password, entry.password]);
    if (!values.length && snapshot.kind !== 'username') return;
    if (values.some(([field, value]) => field.maxLength >= 0 && value.length > field.maxLength)) {
      ipcRenderer.send('password:filled', documentId, nonce, false);
      return;
    }
    chosen = true;
    const original = values.map(([field]) => field.value);
    for (const [field, value] of values) inputValue.set.call(field, value);
    if (values.some(([field, value]) => field.value !== value)) {
      values.forEach(([field], index) => inputValue.set.call(field, original[index]));
      chosen = false;
      ipcRenderer.send('password:filled', documentId, nonce, false);
      return;
    }
    for (const [field] of values) {
      field.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    }
    dismissed = formId;
    chosen = false;
    ipcRenderer.send('password:filled', documentId, nonce, true);
  });
}

