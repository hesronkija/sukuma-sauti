// Front end for Sauti ya Kisukuma. No frameworks; works on low-end Android phones.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const MAX_SECONDS = 40; // speech models take clips up to 40 s
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: keep going in memory */ } },
  };
  let speaker = store.get('sukuma_speaker');
  let prompt = null;
  let recorder = null, chunks = [], blob = null, stream = null, timer = null, startedAt = 0, seconds = 0;
  // Microphone level meter: catches recordings where no sound reached the microphone.
  const QUIET = 0.02; // peak below this (about -34 dB) means nothing was heard
  let meter = null, quietTries = 0, hitCap = false;
  function startMeter() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 4096;
      ctx.createMediaStreamSource(stream).connect(analyser);
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const buf = new Float32Array(analyser.fftSize);
      meter = { ctx, peak: 0, reads: 0 };
      meter.timer = setInterval(() => {
        if (ctx.state !== 'running') return; // cannot measure: never blame the speaker
        analyser.getFloatTimeDomainData(buf);
        let m = 0;
        for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > m) m = v; }
        if (m > meter.peak) meter.peak = m;
        meter.reads++;
      }, 80);
    } catch { meter = null; }
  }
  // true = heard nothing, false = heard sound, null = could not measure
  function stopMeter() {
    if (!meter) return null;
    clearInterval(meter.timer);
    const m = meter; meter = null;
    m.ctx.close().catch(() => {});
    return m.reads >= 5 ? m.peak < QUIET : null;
  }

  const views = ['welcome', 'about', 'task', 'done'];
  function show(name) {
    for (const v of views) $('view-' + v).hidden = v !== name;
    window.scrollTo(0, 0);
    const h = $('view-' + name).querySelector('h1, .prompt');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  }
  async function api(path, body) {
    const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'http_' + res.status), { status: res.status });
    return data;
  }
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  function error(msg) { const e = $('form-error'); e.textContent = msg || ''; e.hidden = !msg; }

  // ---- consent and profile ----
  let consent = null;
  $('consent-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!$('c-adult').checked || !$('c-consent').checked) return;
    consent = { adult: true, consent: true };
    show('about');
  });
  $('about-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const r = await api('/api/speaker', { ...consent, gender: $('gender').value, age_group: $('age').value, region: $('region').value, district: $('district').value });
      speaker = r.speaker;
      store.set('sukuma_speaker', speaker);
      await next();
    } catch { alertLine(btn, 'Imeshindikana kuunganisha. Angalia mtandao kisha jaribu tena.'); }
    btn.disabled = false;
  });
  function alertLine(after, msg) {
    let p = after.parentNode.querySelector('.error');
    if (!p) { p = document.createElement('p'); p.className = 'error'; p.setAttribute('role', 'alert'); after.after(p); }
    p.textContent = msg;
  }

  // ---- task ----
  async function next() {
    let r;
    try { r = await api('/api/next?speaker=' + encodeURIComponent(speaker)); }
    catch (err) {
      if (err.status === 404) { speaker = null; store.set('sukuma_speaker', ''); return show('welcome'); }
      show('task'); return error('Imeshindikana kuunganisha. Angalia mtandao kisha jaribu tena.');
    }
    $('progress').hidden = false;
    $('progress').textContent = `${r.done} / ${r.total}`;
    $('speaker-code').textContent = $('speaker-code-done').textContent = speaker;
    if (!r.prompt) return show('done');
    prompt = r.prompt;
    $('prompt-kind').textContent = prompt.type === 'word' ? 'Neno la Kiswahili' : 'Sentensi ya Kiswahili';
    $('prompt-text').textContent = prompt.sw;
    $('sukuma').value = '';
    resetRecording();
    error('');
    show('task');
  }

  function resetRecording() {
    blob = null; seconds = 0; chunks = [];
    $('rec-play').hidden = true; $('rec-play').removeAttribute('src');
    $('rec-time').textContent = '0:00';
    $('rec-btn-text').textContent = 'Rekodi';
    $('rec-btn').setAttribute('aria-pressed', 'false');
    $('rec-btn').classList.remove('on');
    $('rec-status').textContent = '';
  }
  function pickType() {
    if (!window.MediaRecorder) return null;
    return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }
  async function startRecording() {
    const type = pickType();
    if (type === null || !navigator.mediaDevices?.getUserMedia) {
      $('rec-status').textContent = 'Simu hii haiwezi kurekodi kwenye kivinjari hiki. Unaweza kutuma maandishi tu.';
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false } });
    } catch {
      $('rec-status').textContent = 'Tafadhali ruhusu matumizi ya kipaza sauti, kisha bonyeza Rekodi tena.';
      return;
    }
    resetRecording();
    recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 48000 } : undefined);
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      const quiet = stopMeter();
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(timer);
      seconds = (Date.now() - startedAt) / 1000;
      blob = new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' });
      $('rec-play').src = URL.createObjectURL(blob);
      $('rec-play').hidden = false;
      $('rec-btn-text').textContent = 'Rekodi tena';
      $('rec-btn').setAttribute('aria-pressed', 'false');
      $('rec-btn').classList.remove('on');
      if (seconds < 0.7) {
        blob = null;
        $('rec-status').textContent = 'Rekodi ni fupi mno. Jaribu tena.';
      } else if (quiet === true && ++quietTries < 3) {
        // Nothing was heard. Do not accept it (after three tries we stop insisting, in case the meter is wrong).
        blob = null;
        $('rec-play').hidden = true;
        $('rec-status').textContent = 'Hatukusikia sauti yoyote. Angalia kipaza sauti cha simu yako, sogeza simu karibu na mdomo, kisha rekodi tena.';
      } else {
        if (quiet === false) quietTries = 0;
        $('rec-status').textContent = hitCap
          ? 'Rekodi imesimama yenyewe baada ya sekunde 40. Sikiliza: kama ina maneno mengine, rekodi tena na ubonyeze Simamisha ukimaliza.'
          : 'Imerekodiwa. Sikiliza, kisha tuma.';
      }
    };
    recorder.start();
    startMeter();
    hitCap = false;
    startedAt = Date.now();
    $('rec-btn-text').textContent = 'Simamisha';
    $('rec-btn').setAttribute('aria-pressed', 'true');
    $('rec-btn').classList.add('on');
    $('rec-status').textContent = 'Inarekodi. Soma sentensi yako ya Kisukuma.';
    timer = setInterval(() => {
      const s = (Date.now() - startedAt) / 1000;
      $('rec-time').textContent = fmt(s);
      if (s >= MAX_SECONDS && recorder.state === 'recording') { hitCap = true; recorder.stop(); }
    }, 250);
  }
  $('rec-btn').addEventListener('click', () => {
    if (recorder && recorder.state === 'recording') recorder.stop(); else startRecording();
  });

  const toBase64 = (b) => new Promise((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1]);
    r.onerror = bad;
    r.readAsDataURL(b);
  });

  async function send(body) {
    const btns = [$('send-btn'), $('skip-btn')];
    btns.forEach((b) => (b.disabled = true));
    try { await api('/api/submit', { speaker, prompt: prompt.id, ...body }); await next(); }
    catch { error('Haikutumwa. Angalia mtandao kisha bonyeza Tuma tena. Kazi yako haijapotea.'); }
    btns.forEach((b) => (b.disabled = false));
  }
  $('task-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (recorder && recorder.state === 'recording') return error('Simamisha kurekodi kwanza.');
    const text = $('sukuma').value.trim();
    if (!text) { $('sukuma').focus(); return error('Tafadhali andika sentensi kwa Kisukuma.'); }
    const body = { sukuma: text };
    if (blob) Object.assign(body, { audio: await toBase64(blob), audio_type: blob.type, seconds: Math.round(seconds * 10) / 10 });
    else if (!$('task-form').dataset.warned) {
      $('task-form').dataset.warned = '1';
      return error('Hujarekodi sauti. Sauti ndiyo msaada mkubwa zaidi. Bonyeza Rekodi, au bonyeza Tuma tena kutuma maandishi tu.');
    }
    delete $('task-form').dataset.warned;
    send(body);
  });
  $('skip-btn').addEventListener('click', () => {
    if (recorder && recorder.state === 'recording') recorder.stop();
    send({ skip: true });
  });

  // ---- start ----
  api('/api/config').then((c) => {
    if (c.contact) $('contact-line').textContent = ' kwa ' + c.contact;
  }).catch(() => {});
  if (speaker) next(); else show('welcome');
})();
