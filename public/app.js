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
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(timer);
      seconds = (Date.now() - startedAt) / 1000;
      blob = new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' });
      $('rec-play').src = URL.createObjectURL(blob);
      $('rec-play').hidden = false;
      $('rec-btn-text').textContent = 'Rekodi tena';
      $('rec-btn').setAttribute('aria-pressed', 'false');
      $('rec-btn').classList.remove('on');
      $('rec-status').textContent = seconds < 0.7 ? 'Rekodi ni fupi mno. Jaribu tena.' : 'Imerekodiwa. Sikiliza, kisha tuma.';
      if (seconds < 0.7) blob = null;
    };
    recorder.start();
    startedAt = Date.now();
    $('rec-btn-text').textContent = 'Simamisha';
    $('rec-btn').setAttribute('aria-pressed', 'true');
    $('rec-btn').classList.add('on');
    $('rec-status').textContent = 'Inarekodi. Soma sentensi yako ya Kisukuma.';
    timer = setInterval(() => {
      const s = (Date.now() - startedAt) / 1000;
      $('rec-time').textContent = fmt(s);
      if (s >= MAX_SECONDS) recorder.stop();
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
