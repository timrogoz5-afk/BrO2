const fs = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const root = join(__dirname, '..');
for (const directory of ['src', 'scripts', 'tests']) {
  for (const name of fs.readdirSync(join(root, directory))) {
    if (!name.endsWith('.js')) continue;
    const result = spawnSync(process.execPath, ['--check', join(root, directory, name)], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
