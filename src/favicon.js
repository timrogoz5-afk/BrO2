const imageTypes = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml',
  'image/x-icon', 'image/vnd.microsoft.icon',
]);
const maxIconBytes = 64 * 1024;

async function readFavicon(session, candidates, signal) {
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(3500)]);
  for (const candidate of candidates.slice(0, 8)) {
    if (timeout.aborted) break;
    try {
      const url = new URL(candidate);
      if (!['http:', 'https:', 'data:'].includes(url.protocol) || url.username || url.password) continue;
      if (url.protocol === 'data:' && candidate.length > maxIconBytes * 2) continue;
      const response = await session.fetch(url.href, { signal: timeout, credentials: 'omit' });
      if (!response.body) continue;
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      const reader = response.body.getReader();
      try {
        if (!response.ok || !imageTypes.has(type) || Number(response.headers.get('content-length')) > maxIconBytes) continue;
        const chunks = [];
        let size = 0;
        while (size <= maxIconBytes) {
          const { value, done } = await reader.read();
          if (done) {
            if (size) return `data:${type};base64,${Buffer.concat(chunks, size).toString('base64')}`;
            break;
          }
          size += value.length;
          chunks.push(Buffer.from(value));
        }
      } finally {
        void reader.cancel().catch(() => {});
      }
    } catch {
      // A site may provide more than one icon. Continue with the next candidate.
    }
  }
  return '';
}

module.exports = { readFavicon };
