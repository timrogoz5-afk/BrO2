(() => {
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');
  const appearance = window.bro2?.appearance;
  const setCaption = window.bro2?.setCaption;
  let captionFrame;
  let captionColors;
  let colorContext;

  function hexColor(value) {
    colorContext ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    colorContext.fillStyle = value;
    const normalized = colorContext.fillStyle;
    if (normalized.startsWith('#')) return normalized;
    colorContext.fillRect(0, 0, 1, 1);
    const [r, g, b] = colorContext.getImageData(0, 0, 1, 1).data;
    return '#' + [r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('');
  }

  function updateCaption() {
    captionFrame = undefined;
    const style = getComputedStyle(root);
    const colors = [hexColor(style.getPropertyValue('--tabbar')), hexColor(style.getPropertyValue('--color-text'))];
    if (colors.join() !== captionColors) {
      captionColors = colors.join();
      setCaption(...colors);
    }
    if (root.getAnimations().some(({ transitionProperty, playState }) =>
      playState === 'running' && ['--tabbar', '--color-text'].includes(transitionProperty))) {
      captionFrame = requestAnimationFrame(updateCaption);
    }
  }

  function scheduleCaption() {
    if (setCaption) captionFrame ??= requestAnimationFrame(updateCaption);
  }

  function resolveScheme() {
    const theme = root.dataset.theme;
    const dark = theme === 'system' ? system.matches : theme !== 'light';
    const scheme = dark ? 'dark' : 'light';
    if (root.dataset.colorScheme === scheme) return;
    root.dataset.colorScheme = scheme;
    if (root.hasAttribute('data-theme-ready')) scheduleCaption();
  }

  window.applyWallpaper = (wallpaper) => {
    if (root.dataset.wallpaper === wallpaper) return;
    root.dataset.wallpaper = wallpaper;
    if (root.hasAttribute('data-theme-ready')) scheduleCaption();
  };

  window.applyTheme = ({ theme, accent, motion, wallpaper }) => {
    root.dataset.theme = theme;
    root.dataset.motion = motion;
    root.style.setProperty('--theme-accent', accent);
    resolveScheme();
    if (wallpaper) window.applyWallpaper(wallpaper);
  };

  if (appearance) window.applyTheme(appearance);
  system.addEventListener('change', resolveScheme);
  window.addEventListener('DOMContentLoaded', () => {
    scheduleCaption();
    requestAnimationFrame(() => requestAnimationFrame(() => { root.dataset.themeReady = ''; }));
  }, { once: true });
})();
