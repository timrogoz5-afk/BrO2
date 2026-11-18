const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const run = promisify(execFile);

function registration(executable) {
  const progId = 'BrO2.Url';
  const classes = `HKCU\\Software\\Classes\\${progId}`;
  const client = 'Software\\Clients\\StartMenuInternet\\BrO2';
  const capabilities = `HKCU\\${client}\\Capabilities`;
  return [
    [classes, '/ve', 'BrO2 URL'],
    [classes, '/v', 'URL Protocol', ''],
    [`${classes}\\DefaultIcon`, '/ve', `"${executable}",0`],
    [`${classes}\\shell\\open\\command`, '/ve', `"${executable}" -- "%1"`],
    [`HKCU\\${client}`, '/ve', 'BrO2'],
    [`${capabilities}`, '/v', 'ApplicationName', 'BrO2'],
    [`${capabilities}`, '/v', 'ApplicationDescription', 'Браузер BrO2 для Windows'],
    [`${capabilities}`, '/v', 'ApplicationIcon', `"${executable}",0`],
    [`${capabilities}\\URLAssociations`, '/v', 'http', progId],
    [`${capabilities}\\URLAssociations`, '/v', 'https', progId],
    ['HKCU\\Software\\RegisteredApplications', '/v', 'BrO2', `${client}\\Capabilities`],
  ];
}

async function openDefaultBrowserSettings(executable, shell) {
  if (process.platform !== 'win32' || path.basename(executable).toLowerCase() !== 'bro2.exe') {
    throw new Error('Регистрация доступна при запуске BrO2.exe из portable-сборки.');
  }
  const registry = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  for (const [key, ...options] of registration(executable)) {
    const value = options.pop();
    await run(registry, ['add', key, ...options, '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true });
  }
  try { await shell.openExternal('ms-settings:defaultapps?registeredAppUser=BrO2'); }
  catch { await shell.openExternal('ms-settings:defaultapps'); }
}

module.exports = { registration, openDefaultBrowserSettings };
