(() => {
  const { clamp, canvasWidth, gridStep, maxY, minimum, maxHeight } = window.homeModel;
  const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const edgeSpeed = (point, start, end) => clamp((point - end + 44) / 44, 0, 1) * 17 -
    clamp((start + 44 - point) / 44, 0, 1) * 17;

  const identity = [1, 0, 0, 1, 0, 0];
  const transform = (matrix) => `matrix(${matrix.join(',')})`;
  const mix = (from, to, amount) => from.map((value, i) => value + (to[i] - value) * amount);

  function setupTileDrag({ grid, viewport, main, editing, snap, read, place, raise, finish }) {
    let drag;
    let frame;
    const effects = new Map();
    const scale = () => grid.clientWidth / canvasWidth;

    function change(id, mode, start, dx, dy) {
      const tile = { ...start };
      const snapped = snap();
      const align = (value, min, max) => {
        if (snapped && value > min && value < max) value = Math.round(value / gridStep) * gridStep;
        return clamp(value, min, max);
      };
      if (mode === 'move') {
        if (dx) tile.x = align(start.x + dx, 0, canvasWidth - tile.w);
        if (dy) tile.y = align(start.y + dy, 0, Math.min(maxY, grid.clientHeight - tile.h));
      } else {
        if (dx) tile.w = align(tile.x + start.w + dx, tile.x + minimum[id][0], canvasWidth) - tile.x;
        if (dy) tile.h = align(tile.y + start.h + dy, tile.y + minimum[id][1],
          Math.min(tile.y + maxHeight, grid.clientHeight)) - tile.y;
      }
      place(id, tile);
      return tile;
    }

    function geometry(current) {
      const area = grid.getBoundingClientRect();
      const factor = scale();
      return change(current.id, current.mode, current.start,
        (current.x - area.left) / factor - current.grabX, current.y - area.top - current.grabY);
    }

    function squash(rect, vx, vy) {
      const speed = Math.hypot(vx, vy) || 1;
      const x = vx / speed;
      const y = vy / speed;
      const stretch = Math.min(speed * .048, .067);
      const sx = stretch * (x * x - .45 * y * y);
      const sy = stretch * (y * y - .45 * x * x);
      const shear = 1.45 * stretch * x * y;
      const lagX = clamp(-vx * 8, -14, 14);
      const lagY = clamp(-vy * 8, -14, 14);
      const factor = scale();
      const expandX = (Math.max(sx, -.2 * sx) * rect.w * factor + Math.abs(shear) * rect.h) / 2;
      const expandY = (Math.max(sy, -.2 * sy) * rect.h + Math.abs(shear) * rect.w * factor) / 2;
      const space = (room, overflow) => overflow > 0 ? Math.max(0, room) / overflow : 1;
      const amount = Math.min(1,
        space(rect.x * factor, expandX + Math.max(0, -lagX)),
        space((canvasWidth - rect.w - rect.x) * factor, expandX + Math.max(0, lagX)),
        space(rect.y, expandY + Math.max(0, -lagY)),
        space(grid.clientHeight - rect.y - rect.h, expandY + Math.max(0, lagY)));
      return mix(identity, [1 + sx, shear, shear, 1 + sy, lagX, lagY], amount);
    }

    function animate(now) {
      if (!drag) return;
      const { x, y, lastX, lastY, time, mode, element } = drag;
      const dt = clamp(now - time, 1, 50);
      const mainBox = main.getBoundingClientRect();
      const viewportBox = viewport.getBoundingClientRect();
      main.scrollTop += edgeSpeed(y, Math.max(viewportBox.top, mainBox.top), mainBox.bottom);
      viewport.scrollLeft += edgeSpeed(x, viewportBox.left, viewportBox.right);
      const rect = geometry(drag);
      if (mode === 'move' && moving()) {
        const smoothing = 1 - Math.exp(-dt / 48);
        drag.vx += ((x - lastX) / dt - drag.vx) * smoothing;
        drag.vy += ((y - lastY) / dt - drag.vy) * smoothing;
        drag.matrix = squash(rect, drag.vx, drag.vy);
        element.style.transform = transform(drag.matrix);
      } else {
        drag.matrix = identity;
        element.style.removeProperty('transform');
      }
      Object.assign(drag, { lastX: x, lastY: y, time: now });
      frame = requestAnimationFrame(animate);
    }

    function end(event) {
      if (!drag || (event && drag.pointer !== event.pointerId)) return;
      const current = drag;
      drag = undefined;
      cancelAnimationFrame(frame);
      const { id, element, handle, pointer, matrix } = current;
      let releaseShape;
      if (event?.type === 'pointerup' && editing()) {
        current.x = event.clientX;
        current.y = event.clientY;
        const rect = geometry(current);
        if (matrix !== identity) releaseShape = squash(rect, current.vx, current.vy).slice(0, 4).concat(0, 0);
      }
      element.classList.remove('tile-dragging');
      element.style.removeProperty('transform');
      if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
      if (releaseShape && moving()) {
        // Rebound around the final coordinates. Translation is applied only during the drag.
        const animation = element.animate([releaseShape, mix(identity, releaseShape, -.2), mix(identity, releaseShape, .06), identity]
          .map((value, i) => ({ transform: transform(value), offset: [0, .45, .72, 1][i] })),
        { duration: 280, easing: 'ease-out' });
        effects.set(element, animation);
        animation.finished.catch(() => {}).finally(() => {
          if (effects.get(element) === animation) effects.delete(element);
        });
      }
      finish(id);
    }

    function attach(handle, element, id, mode) {
      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || !event.isPrimary || !editing() || drag) return;
        event.preventDefault();
        handle.focus({ preventScroll: true });
        effects.get(element)?.cancel();
        const start = { ...read(id) };
        raise(id);
        handle.setPointerCapture(event.pointerId);
        const area = grid.getBoundingClientRect();
        const { clientX: x, clientY: y } = event;
        drag = { id, mode, element, handle, pointer: event.pointerId, start, x, y, lastX: x, lastY: y,
          grabX: (x - area.left) / scale(), grabY: y - area.top, vx: 0, vy: 0,
          time: performance.now(), matrix: identity };
        element.classList.add('tile-dragging');
        frame = requestAnimationFrame(animate);
      });
      handle.addEventListener('pointermove', (event) => {
        if (!drag || drag.pointer !== event.pointerId) return;
        drag.x = event.clientX;
        drag.y = event.clientY;
      });
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, end);
      handle.addEventListener('keydown', (event) => {
        const direction = directions[event.key];
        if (!direction || !editing() || drag) return;
        event.preventDefault();
        const snapped = snap();
        const step = snapped ? gridStep * (event.shiftKey ? 4 : 1) : event.shiftKey ? 16 : 1;
        const [dx, dy] = direction.map((value) => value * step);
        raise(id);
        change(id, mode, read(id), snapped ? dx : dx / scale(), dy);
        finish(id);
        handle.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
    }

    window.addEventListener('blur', () => end());
    motionAllowed.addEventListener('change', () => { if (!moving()) effects.forEach((animation) => animation.cancel()); });
    return { attach, cancel: () => end() };
  }

  window.setupTileDrag = setupTileDrag;
})();
