function readingText() {
  const paragraphs = 'h1,h2,h3,h4,p,blockquote,li,pre';
  const excluded = 'nav,footer,aside,form,dialog,button,[hidden],[aria-hidden="true"],[contenteditable],script,style';
  const valid = (node) => !node.closest(excluded) && node.getClientRects().length > 0;
  const clean = (node) => node.innerText?.replace(/\n{3,}/g, '\n\n').trim() || '';
  const candidates = [...document.querySelectorAll('article,main,[role="main"]'), document.body].filter(Boolean);
  let best = { title: '', blocks: [] };
  let score = 0;
  for (const candidate of candidates.slice(0, 25)) {
    let total = 0;
    const blocks = [];
    for (const node of candidate.querySelectorAll(paragraphs)) {
      if (!valid(node) || node.parentElement?.closest('blockquote,li')) continue;
      const text = clean(node).slice(0, 6000);
      if (!text) continue;
      blocks.push({ kind: node.tagName.toLowerCase(), text });
      total += text.length;
      if (blocks.length >= 500 || total >= 160_000) break;
    }
    const bodyScore = blocks.filter(({ kind }) => kind === 'p').reduce((sum, block) => sum + Math.min(block.text.length, 400), 0);
    const weightedScore = candidate === document.body ? bodyScore * .6 : bodyScore;
    if (weightedScore <= score) continue;
    score = weightedScore;
    const title = [...candidate.querySelectorAll('h1')].find(valid);
    best = { title: (title && clean(title) || document.title).slice(0, 512), blocks };
  }
  return score >= 120 ? best : null;
}

async function mediaAction(action) {
  const elements = [...document.querySelectorAll(action === 'pip' ? 'video' : 'audio,video')]
    .filter((element) => element.readyState > 0);
  if (action === 'pip' && document.pictureInPictureElement) {
    await document.exitPictureInPicture();
    return true;
  }
  const available = elements.filter((element) => action !== 'pip' ||
    (!element.disablePictureInPicture && element.videoWidth > 0 && element.getClientRects().length));
  const player = available.find((element) => !element.paused) || available[0];
  if (!player) return false;
  if (action === 'pip') await player.requestPictureInPicture();
  else if (player.paused) await player.play();
  else player.pause();
  if (action === 'home-toggle') return { playing: !player.paused };
  return true;
}

module.exports = { readingText, mediaAction };
