function shortcutCommand(input) {
  if (input.isComposing || input.isAutoRepeat || input.meta) return null;
  const { code, key, control, alt, shift } = input;
  if (control && !alt) {
    if (/^(?:Digit|Numpad)[1-9]$/.test(code) && !shift) return ['tab-number', Number(code.at(-1))];
    if (code === 'KeyT') return [shift ? 'restore' : 'new'];
    if (code === 'KeyN') return [shift ? 'private' : 'window'];
    if (code === 'KeyW') return [shift ? 'close-window' : 'close'];
    if (code === 'Tab') return ['cycle', shift ? -1 : 1];
    if (code === 'KeyR') return [shift ? 'hard-reload' : 'reload'];
    if (code === 'KeyB' && shift) return ['bookmarks-bar'];
    if (code === 'KeyO' && shift) return ['bookmarks'];
    if (code === 'KeyA' && shift) return ['tab-search'];
    if (code === 'Comma' && shift) return ['vertical-tabs'];
    if (code === 'BracketRight' && shift) return ['pip'];
    if (code === 'Delete' && shift) return ['clear-data'];
    if (code === 'KeyI' && shift) return ['devtools'];
    if (code === 'F5' && !shift) return ['hard-reload'];
    if (key === '+' || code === 'NumpadAdd') return ['zoom', 1];
    if (shift) return null;
    const commands = {
      F4: 'close', PageDown: 'cycle', PageUp: 'cycle', KeyL: 'address', KeyK: 'address', KeyE: 'address',
      Comma: 'settings', KeyF: 'find', KeyH: 'history', KeyJ: 'downloads', KeyD: 'bookmark',
      KeyP: 'print', KeyS: 'save', KeyU: 'source',
    };
    if (commands[code]) return [commands[code], code === 'PageDown' ? 1 : code === 'PageUp' ? -1 : undefined];
    if (code === 'Equal') return ['zoom', 1];
    if (['Minus', 'NumpadSubtract'].includes(code)) return ['zoom', -1];
    if (['Digit0', 'Numpad0'].includes(code)) return ['zoom', 0];
  }
  if (!control && alt && !shift) {
    const commands = { KeyD: 'address', KeyF: 'menu', ArrowLeft: 'back', ArrowRight: 'forward', Home: 'home' };
    return commands[code] ? [commands[code]] : null;
  }
  if (control || alt) return null;
  if (code === 'F3') return ['find-step', shift ? -1 : 1];
  if (code === 'Escape' && shift) return ['tasks'];
  if (shift) return null;
  const commands = { F5: 'reload', F6: 'address', F11: 'fullscreen', F12: 'devtools' };
  return commands[code] ? [commands[code]] : null;
}

if (typeof module !== 'undefined') module.exports = { shortcutCommand };
