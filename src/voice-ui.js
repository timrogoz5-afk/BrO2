(() => {
  const voice = byId('home-microphone');
  const status = byId('home-voice-status');
  const search = byId('search');
  let running;

  function show(message) {
    status.textContent = message;
    status.hidden = !message;
  }

  function audioError(error) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return 'denied';
    if (['NotFoundError', 'DevicesNotFoundError', 'NotReadableError', 'TrackStartError'].includes(error.name)) return 'microphone';
    return 'failed';
  }

  async function toWave(context, data) {
    const audio = await context.decodeAudioData(await data.arrayBuffer());
    const frames = Math.min(160_000, Math.ceil(audio.duration * 16_000));
    const offline = new OfflineAudioContext(1, frames, 16_000);
    const sample = offline.createBufferSource();
    sample.buffer = audio;
    sample.connect(offline.destination);
    sample.start();
    const channel = (await offline.startRendering()).getChannelData(0);
    const wave = new Uint8Array(44 + frames * 2);
    const view = new DataView(wave.buffer);
    for (const [offset, tag] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']]) {
      wave.set(new TextEncoder().encode(tag), offset);
    }
    view.setUint32(4, wave.length - 8, true);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16_000, true);
    view.setUint32(28, 32_000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    view.setUint32(40, frames * 2, true);
    for (let index = 0; index < frames; index++) {
      const sample = Math.max(-1, Math.min(1, channel[index]));
      view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    }
    return wave;
  }

  async function record(request, context) {
    let stream;
    let timer;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (request.signal.aborted) return undefined;
      await context.resume();
      if (request.signal.aborted) return undefined;
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      const recorder = new MediaRecorder(stream);
      const chunks = [];
      const samples = new Float32Array(analyser.fftSize);
      let lastSound = 0;
      const start = performance.now();
      show('Запись… Говори по-русски. Нажми на микрофон ещё раз для отмены.');
      recorder.start();
      const blob = await new Promise((resolve, reject) => {
        request.stop = () => { if (recorder.state !== 'inactive') recorder.stop(); };
        recorder.ondataavailable = ({ data }) => { if (data.size) chunks.push(data); };
        recorder.onerror = ({ error }) => reject(error);
        recorder.onstop = () => resolve(chunks.length && lastSound ? new Blob(chunks, { type: recorder.mimeType }) : undefined);
        timer = setInterval(() => {
          const now = performance.now();
          analyser.getFloatTimeDomainData(samples);
          const energy = samples.reduce((sum, value) => sum + value * value, 0);
          if (Math.sqrt(energy / samples.length) > .013) lastSound = now;
          if (request.signal.aborted || now - start >= (lastSound ? 9200 : 5100) || lastSound && now - lastSound > 1100) request.stop();
        }, 80);
      });
      stream.getTracks().forEach((track) => track.stop());
      if (!blob || request.signal.aborted) return undefined;
      return await toWave(context, blob);
    } finally {
      clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
      await context.close().catch(() => {});
    }
  }

  function cancel() {
    if (!running) return;
    running.controller.abort();
    running.stop?.();
    void window.bro2.home('voice-cancel');
    done(running, 'cancelled');
  }

  function done(request, code) {
    if (running !== request) return;
    running = undefined;
    voice.setAttribute('aria-pressed', 'false');
    voice.title = voice.ariaLabel = 'Голосовой ввод · на устройстве';
    show(({ cancelled: 'Голосовой ввод отменён.', denied: 'Windows не разрешила доступ к микрофону.',
      microphone: 'Микрофон недоступен. Проверь входное устройство в Windows.',
      empty: 'Речь не распознана. Попробуй ещё раз.', unsupported: 'Голосовой ввод доступен в 64-разрядной сборке для Windows.',
      failed: 'Не удалось запустить голосовой ввод.' })[code] || 'Текст вставлен. Его можно поправить перед поиском.');
  }

  voice.addEventListener('click', async () => {
    if (running) return cancel();
    if (!navigator.mediaDevices || typeof MediaRecorder !== 'function') {
      show('Микрофон недоступен. Проверь входное устройство в Windows.');
      return;
    }
    const controller = new AbortController();
    const request = { controller, signal: controller.signal };
    running = request;
    voice.setAttribute('aria-pressed', 'true');
    voice.title = voice.ariaLabel = 'Отменить голосовой ввод';
    show('Подключение к микрофону… Распознавание выполняется на устройстве.');
    try {
      const wave = await record(request, new AudioContext());
      if (request.signal.aborted) return;
      if (!wave) return done(request, 'empty');
      show('Распознавание на устройстве…');
      const result = await window.bro2.home('voice', wave);
      if (running !== request) return;
      if (result.status === 'ok' && !byId('home').hidden) {
        search.setRangeText(result.text, search.selectionStart, search.selectionEnd, 'end');
        search.focus();
      }
      done(request, result.status || 'failed');
    } catch (error) { done(request, audioError(error)); }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && running) { event.preventDefault(); cancel(); }
  });
  let active;
  window.bro2.onState((next) => {
    if (active !== next.active || byId('home').hidden || next.loading) {
      cancel();
      show('');
    }
    active = next.active;
  });
})();
