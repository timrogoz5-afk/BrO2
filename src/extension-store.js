const { createHash, createPublicKey, createVerify } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify, TextDecoder } = require('node:util');
const { inflateRaw } = require('node:zlib');

const inflate = promisify(inflateRaw);
const maxDownload = 64 * 1024 * 1024;
const maxUnpacked = 256 * 1024 * 1024;
// Chromium's production Chrome Web Store signing key (SHA-256 of DER SPKI).
const publisherHash = '61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf';
const decoder = new TextDecoder('utf-8', { fatal: true });

function storeListing(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.origin !== 'https://chromewebstore.google.com' || url.username || url.password) return null;
    return /^\/detail\/(?:[^/]+\/)?([a-p]{32})\/?$/.exec(url.pathname)?.[1] || null;
  } catch { return null; }
}

async function download(id, chromeVersion, signal) {
  const url = new URL('https://clients2.google.com/service/update2/crx');
  url.search = new URLSearchParams({
    response: 'redirect', prodversion: chromeVersion, acceptformat: 'crx3', x: `id=${id}&installsource=ondemand&uc`,
  });
  try {
    let target = url;
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    for (let redirects = 0; redirects <= 4; redirects++) {
      if (!['https://clients2.google.com', 'https://clients2.googleusercontent.com'].includes(target.origin) ||
          target.username || target.password) break;
      const response = await fetch(target, { redirect: 'manual', signal: timeout });
      if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.has('location')) {
        await response.body?.cancel();
        target = new URL(response.headers.get('location'), target);
        continue;
      }
      if (response.status !== 200 || !response.body || Number(response.headers.get('content-length')) > maxDownload) {
        await response.body?.cancel();
        break;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxDownload) throw new Error();
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, size);
    }
  } catch {}
  throw new Error('Не удалось скачать пакет из Chrome Web Store.');
}

// CRX3 uses length-delimited protobuf fields for keys, signatures and the signed ID.
function fields(buffer) {
  const result = new Map();
  let offset = 0;
  function varint() {
    let value = 0;
    for (let shift = 0; shift <= 28 && offset < buffer.length; shift += 7) {
      const byte = buffer[offset++];
      value += (byte & 127) * 2 ** shift;
      if (value > 0xffffffff) break;
      if (byte < 128) return value;
    }
    throw new Error();
  }
  while (offset < buffer.length) {
    const tag = varint();
    if (!tag || (tag & 7) !== 2) throw new Error();
    const length = varint();
    const end = offset + length;
    if (end > buffer.length) throw new Error();
    const number = tag >>> 3;
    if (!result.has(number)) result.set(number, []);
    result.get(number).push(buffer.subarray(offset, end));
    offset = end;
  }
  return result;
}

function verifyPackage(crx, id) {
  try {
    if (crx.toString('ascii', 0, 4) !== 'Cr24' || crx.readUInt32LE(4) !== 3) throw new Error();
    const headerSize = crx.readUInt32LE(8);
    if (headerSize > 256 * 1024 || headerSize + 12 >= crx.length) throw new Error();
    const header = fields(crx.subarray(12, 12 + headerSize));
    const archive = crx.subarray(12 + headerSize);
    const [signed] = header.get(10000);
    const [signedId] = fields(signed).get(1);
    const expectedId = Buffer.from(id.replace(/[a-p]/g, (letter) => (letter.charCodeAt(0) - 97).toString(16)), 'hex');
    if (!signedId.equals(expectedId)) throw new Error();
    const signedSize = Buffer.alloc(4);
    signedSize.writeUInt32LE(signed.length);
    let developerKey;
    let publisherVerified = false;
    for (const [field, keyType] of [[2, 'rsa'], [3, 'ec']]) {
      for (const proof of header.get(field) || []) {
        const data = fields(proof);
        const [key] = data.get(1);
        const [signature] = data.get(2);
        const hash = createHash('sha256').update(key).digest();
        const publicKey = createPublicKey({ key, format: 'der', type: 'spki' });
        if (publicKey.asymmetricKeyType !== keyType || !createVerify('sha256').update('CRX3 SignedData\0')
          .update(signedSize).update(signed).update(archive).verify(publicKey, signature)) throw new Error();
        if (hash.subarray(0, 16).equals(expectedId)) developerKey = key;
        if (hash.toString('hex') === publisherHash) publisherVerified = true;
      }
    }
    if (!developerKey || !publisherVerified) throw new Error();
    return { archive, key: developerKey.toString('base64') };
  } catch {
    throw new Error('Подпись Chrome Web Store или идентификатор расширения не прошли проверку.');
  }
}

async function unpack(archive, target, signal) {
  const end = archive.lastIndexOf(Buffer.from('504b0506', 'hex'));
  if (end < 0 || end + 22 > archive.length || archive.readUInt32LE(end + 4) !== 0 ||
      end + 22 + archive.readUInt16LE(end + 20) !== archive.length) throw new Error();
  const count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  const centralStart = offset;
  if (count > 20_000 || count !== archive.readUInt16LE(end + 8) ||
      offset + archive.readUInt32LE(end + 12) !== end) throw new Error();

  let total = 0;
  const seen = new Set();
  for (let index = 0; index < count; index++) {
    signal.throwIfAborted();
    if (offset + 46 > end || archive.readUInt32LE(offset) !== 0x02014b50) throw new Error();
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const size = archive.readUInt32LE(offset + 24);
    const nameSize = archive.readUInt16LE(offset + 28);
    const extraSize = archive.readUInt16LE(offset + 30);
    const commentSize = archive.readUInt16LE(offset + 32);
    const disk = archive.readUInt16LE(offset + 34);
    const entryType = (archive.readUInt32LE(offset + 38) >>> 28);
    const local = archive.readUInt32LE(offset + 42);
    const nameBytes = archive.subarray(offset + 46, offset + 46 + nameSize);
    offset += 46 + nameSize + extraSize + commentSize;
    total += size;
    if (offset > end || !nameSize || disk || (flags & ~0x080e) || ![0, 4, 8].includes(entryType) ||
        ![0, 8].includes(method) || total > maxUnpacked) throw new Error();

    const name = decoder.decode(nameBytes);
    const directory = name.endsWith('/');
    const parts = (directory ? name.slice(0, -1) : name).split('/');
    if (parts.some((part) => !part || /[<>:"\\|?*\x00-\x1f]|[ .]$/u.test(part) ||
      /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[0-9¹²³])(?:\.|$)/i.test(part))) throw new Error();
    const relative = parts.join('/').toLowerCase();
    if (seen.has(relative)) throw new Error();
    seen.add(relative);
    if (parts[0] === '_metadata') continue; // Chrome-managed signature metadata.
    const filename = path.join(target, ...parts);
    if (directory) {
      await fs.mkdir(filename, { recursive: true });
      continue;
    }

    if (local + 30 > centralStart || archive.readUInt32LE(local) !== 0x04034b50 ||
        archive.readUInt16LE(local + 8) !== method || archive.readUInt16LE(local + 26) !== nameSize ||
        !archive.subarray(local + 30, local + 30 + nameSize).equals(nameBytes)) throw new Error();
    const start = local + 30 + nameSize + archive.readUInt16LE(local + 28);
    if (start + compressedSize > centralStart) throw new Error();
    const compressed = archive.subarray(start, start + compressedSize);
    const bytes = method === 0 ? compressed : await inflate(compressed, { maxOutputLength: Math.max(size, 1) });
    if (bytes.length !== size) throw new Error();
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, bytes, { flag: 'wx' });
  }
  if (offset !== end) throw new Error();
}

async function unpackStorePackage(crx, id, target, signal) {
  const { archive, key } = verifyPackage(crx, id);
  try {
    await fs.mkdir(target);
    await unpack(archive, target, signal);
    const filename = path.join(target, 'manifest.json');
    if ((await fs.stat(filename)).size > 1024 * 1024) throw new Error();
    const manifest = JSON.parse((await fs.readFile(filename, 'utf8')).replace(/^\uFEFF/, ''));
    await fs.writeFile(filename, JSON.stringify({ ...manifest, key }, null, 2));
  } catch {
    if (signal.aborted) signal.throwIfAborted();
    throw new Error('Не удалось распаковать расширение из Chrome Web Store.');
  }
}

module.exports = { storeListing, download, unpackStorePackage };
