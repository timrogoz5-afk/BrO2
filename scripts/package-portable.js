const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const destination = path.join(root, 'BrO2-portable', 'resources', 'app');
const manifest = require('../package.json');
const installed = fs.readFileSync(path.join(destination, '..', '..', 'version'), 'utf8').trim().replace(/^v/, '');
if (manifest.devDependencies.electron !== installed) throw new Error('Portable Electron version differs from package.json.');

function files(directory) {
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true }).map((entry) => {
    if (entry.isDirectory()) return null;
    if (!entry.isFile()) throw new Error(`Unexpected entry in ${directory}: ${entry.name}`);
    return path.relative(directory, path.join(entry.parentPath, entry.name));
  }).filter(Boolean).sort();
}

const source = path.join(root, 'src');
const packaged = path.join(destination, 'src');
const expected = files(source);
for (const file of files(packaged)) {
  if (!expected.includes(file)) throw new Error(`Remove stale file from portable app: ${file}`);
}
for (const file of ['package.json', ...expected.map((file) => path.join('src', file))]) {
  const target = path.join(destination, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, file), target);
  const hash = (filename) => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
  if (hash(path.join(root, file)) !== hash(target)) throw new Error(`Portable file differs: ${file}`);
}
console.log(`BrO2 ${manifest.version}: ${expected.length + 1} files verified, Electron ${installed}.`);
