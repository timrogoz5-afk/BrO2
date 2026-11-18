const { webURL } = require('./address');

function translationEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  const address = webURL(value);
  if (!address) return null;
  const url = new URL(address);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !loopback) || url.username || url.password || url.search || url.hash) return null;
  return url.href;
}

async function translateArticle(article, config, target, signal) {
  if (!['ru', 'en', 'de', 'es', 'fr'].includes(target)) throw new Error('Выбери язык перевода.');
  const text = [article.title, ...article.blocks.map((block) => block.text)];
  if (text.reduce((total, part) => total + part.length, 0) > 24_000 || text.length > 200 || text.some((part) => part.length > 6000)) {
    throw new Error('Для перевода доступны статьи до 24 000 знаков и 199 фрагментов.');
  }
  const output = [];
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
  for (let offset = 0; offset < text.length;) {
    const batch = [];
    let size = 0;
    while (batch.length < 12 && offset < text.length && (!batch.length || size + text[offset].length <= 4500)) {
      size += text[offset].length;
      batch.push(text[offset++] || ' ');
    }
    const response = await fetch(config.endpoint, {
      method: 'POST', redirect: 'error', credentials: 'omit', signal: deadline,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ q: batch, source: 'auto', target, format: 'text', ...(config.key ? { api_key: config.key } : {}) }),
    });
    if (!response.ok) throw new Error(`Сервис перевода вернул ошибку HTTP ${response.status}.`);
    const chunks = [];
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.byteLength;
      if (received > 750_000) throw new Error('Ответ сервиса перевода слишком большой.');
      chunks.push(chunk);
    }
    const { translatedText } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(translatedText) || translatedText.length !== batch.length ||
        !translatedText.every((value) => typeof value === 'string' && value.length <= 12_000)) {
      throw new Error('Сервис вернул перевод в неожиданном формате.');
    }
    output.push(...translatedText);
  }
  return {
    title: output[0],
    blocks: article.blocks.map((block, index) => ({ ...block, text: output[index + 1] })),
  };
}

module.exports = { translationEndpoint, translateArticle };
