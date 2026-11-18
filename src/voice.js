const { spawn } = require('node:child_process');
const path = require('node:path');

const directory = path.join(__dirname, 'assets', 'speech');
const maxWaveBytes = 44 + 16_000 * 2 * 10;

function recognizeRussian(input, signal) {
  if (process.platform !== 'win32' || process.arch !== 'x64') return Promise.resolve({ status: 'unsupported' });
  if (!(input instanceof Uint8Array) || input.byteLength <= 44 || input.byteLength > maxWaveBytes) {
    return Promise.resolve({ status: 'empty' });
  }
  const wave = Buffer.from(input);
  if (wave.toString('ascii', 0, 4) !== 'RIFF' || wave.toString('ascii', 8, 12) !== 'WAVE') {
    return Promise.resolve({ status: 'failed' });
  }
  return new Promise((resolve) => {
    const child = spawn(path.join(directory, 'whisper-cli.exe'),
      ['-m', 'ggml-base-q5_1.bin', '-l', 'ru', '-t', '4', '-ng', '-np', '-nt', '-of', 'brO2-transcript', '-f', '-'], {
        cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
        signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
      });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (output.length < 8192) output += chunk;
    });
    child.stdin.on('error', () => {});
    child.stdin.end(wave);
    child.once('error', () => resolve({ status: signal.aborted ? 'cancelled' : 'failed' }));
    child.once('close', (code) => {
      const text = output.replace(/\[[^\]]*\]|\([^)]*\)/g, '').trim().replace(/\s+/g, ' ').slice(0, 512);
      resolve(signal.aborted ? { status: 'cancelled' } : code !== 0 ? { status: 'failed' }
        : text && /[\p{L}\p{N}]/u.test(text) ? { status: 'ok', text } : { status: 'empty' });
    });
  });
}

module.exports = { recognizeRussian };
