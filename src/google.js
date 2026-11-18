const http = require('node:http');
const { createHash, randomBytes } = require('node:crypto');

const loopback = '127.0.0.1';
const callbackPath = '/oauth/google';
const successPage = '<!doctype html><meta charset="utf-8"><title>BrO2</title><h1>Вернись в BrO2</h1><p>Результат входа появится в настройках браузера.</p>';

function desktopClient(json) {
  const client = json?.installed;
  if (typeof client?.client_id !== 'string' || !/^[\w-]+\.apps\.googleusercontent\.com$/.test(client.client_id)) {
    throw new Error('Выбери JSON клиента Google OAuth типа «Приложение для компьютера».');
  }
  const { client_id, client_secret } = client;
  return { client_id, ...(typeof client_secret === 'string' && client_secret ? { client_secret } : {}) };
}

async function googleSignIn(client, openExternal, signal) {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
  const server = http.createServer();
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, loopback, resolve);
    });
    const host = `${loopback}:${server.address().port}`;
    const redirect = `http://${host}${callbackPath}`;
    const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorization.search = new URLSearchParams({
      client_id: client.client_id, redirect_uri: redirect, response_type: 'code',
      scope: 'openid email profile', state, code_challenge: challenge,
      code_challenge_method: 'S256', prompt: 'select_account',
    });

    const code = await new Promise((resolve, reject) => {
      const abort = () => reject(requestSignal.reason);
      requestSignal.addEventListener('abort', abort, { once: true });
      server.once('close', () => requestSignal.removeEventListener('abort', abort));
      server.on('request', (request, response) => {
        const url = new URL(`http://${host}${request.url.startsWith('/') ? request.url : '/'}`);
        const valid = request.method === 'GET' && request.headers.host === host &&
          url.pathname === callbackPath && url.searchParams.get('state') === state;
        if (!valid) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'", 'Referrer-Policy': 'no-referrer',
          Connection: 'close',
        }).end(successPage, () => {
          const code = url.searchParams.get('code');
          if (code && !url.searchParams.has('error')) resolve(code);
          else reject(new Error('Google не подтвердил вход. Попробуй ещё раз.'));
        });
      });
      if (requestSignal.aborted) abort();
      else Promise.resolve().then(() => openExternal(authorization.href)).catch(reject);
    });

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', redirect: 'error', signal: requestSignal,
      body: new URLSearchParams({ ...client, code, code_verifier: verifier,
        grant_type: 'authorization_code', redirect_uri: redirect }),
    });
    if (!tokenResponse.ok) throw new Error('Google не принял код входа. Проверь настройки OAuth-клиента.');
    const { access_token } = await tokenResponse.json();
    if (!access_token) throw new Error('Google не выдал доступ к профилю.');
    const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` }, redirect: 'error', signal: requestSignal,
    });
    if (!profileResponse.ok) throw new Error('Не удалось получить профиль Google.');
    const { sub, name, email, email_verified } = await profileResponse.json();
    if (!sub || typeof email !== 'string' || email_verified !== true) {
      throw new Error('Google не вернул подтверждённый адрес аккаунта.');
    }
    return { name: typeof name === 'string' ? name : email, email };
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

module.exports = { desktopClient, googleSignIn };
