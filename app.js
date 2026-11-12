// Sauti ya Kisukuma: a small data-collection site.
// A speaker sees a Swahili sentence, writes it in Sukuma, and records themselves saying it.
// Storage is plain files (JSON lines + audio) under DATA_DIR, so there is no database to manage.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

// Minimal .env loader (no dependency): KEY=value lines, # comments.
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const DATA_DIR = path.resolve(__dirname, process.env.DATA_DIR || './data');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const SPEAKERS = path.join(DATA_DIR, 'speakers.jsonl');
const SUBMISSIONS = path.join(DATA_DIR, 'submissions.jsonl');
const MAX_AUDIO_BYTES = 4 * 1024 * 1024; // 40 s of phone audio is well under this
const MAX_TEXT = 600;
const AUDIO_TYPES = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav' };
const GENDERS = ['Female', 'Male', ''];
const AGES = ['18-25', '26-35', '36-50', '51-65', '65+', ''];

const prompts = JSON.parse(fs.readFileSync(path.join(__dirname, 'prompts.json'), 'utf8'));
const promptById = new Map(prompts.map((p) => [p.id, p]));

fs.mkdirSync(AUDIO_DIR, { recursive: true });

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function append(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

// In-memory index, rebuilt from the files at start.
const speakers = new Map(); // id -> record
const doneBySpeaker = new Map(); // id -> Set(promptId), includes skips
const countByPrompt = new Map(); // promptId -> number of real submissions
for (const s of readJsonl(SPEAKERS)) speakers.set(s.speaker, s);
for (const r of readJsonl(SUBMISSIONS)) index(r);

function index(r) {
  if (!doneBySpeaker.has(r.speaker)) doneBySpeaker.set(r.speaker, new Set());
  doneBySpeaker.get(r.speaker).add(r.prompt);
  if (!r.skipped) countByPrompt.set(r.prompt, (countByPrompt.get(r.prompt) || 0) + 1);
}

// Next prompt for a speaker: one they have not seen, preferring prompts with the fewest
// submissions so coverage stays even. The first three are single words, as a warm-up.
function nextPrompt(speaker) {
  const done = doneBySpeaker.get(speaker) || new Set();
  let pool = prompts.filter((p) => !done.has(p.id));
  if (!pool.length) return null;
  const warm = pool.filter((p) => p.type === 'word');
  if (done.size < 3 && warm.length) pool = warm;
  else if (pool.some((p) => p.type === 'sentence') && done.size % 5 !== 4) pool = pool.filter((p) => p.type === 'sentence');
  const min = Math.min(...pool.map((p) => countByPrompt.get(p.id) || 0));
  const least = pool.filter((p) => (countByPrompt.get(p.id) || 0) === min);
  return least[crypto.randomInt(least.length)];
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'microphone=(self)',
    'Content-Security-Policy': "default-src 'self'; media-src 'self' blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
  });
  next();
});

// Simple per-address limit, in memory. Addresses are never written to disk.
const hits = new Map();
setInterval(() => hits.clear(), 60 * 60 * 1000).unref();
function limit(max) {
  return (req, res, next) => {
    const n = (hits.get(req.ip) || 0) + 1;
    hits.set(req.ip, n);
    if (n > max) return res.status(429).json({ error: 'too_many' });
    next();
  };
}

app.get('/health', (req, res) => res.json({ ok: true, prompts: prompts.length }));
app.get('/api/config', (req, res) => res.json({ contact: process.env.CONTACT_EMAIL || '', total: prompts.length }));

const json = express.json({ limit: '7mb' });
const clean = (v, max = 80) => String(v ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const validSpeaker = (id) => typeof id === 'string' && /^spk-[a-f0-9]{10}$/.test(id) && speakers.has(id);

app.post('/api/speaker', limit(600), json, (req, res) => {
  const b = req.body || {};
  if (b.consent !== true || b.adult !== true) return res.status(400).json({ error: 'consent_required' });
  const rec = {
    speaker: 'spk-' + crypto.randomBytes(5).toString('hex'),
    created: new Date().toISOString(),
    consent_version: 1,
    gender: GENDERS.includes(b.gender) ? b.gender : '',
    age_group: AGES.includes(b.age_group) ? b.age_group : '',
    region: clean(b.region, 40),
    district: clean(b.district, 40),
  };
  append(SPEAKERS, rec);
  speakers.set(rec.speaker, rec);
  res.json({ speaker: rec.speaker });
});

app.get('/api/next', limit(2000), (req, res) => {
  const speaker = req.query.speaker;
  if (!validSpeaker(speaker)) return res.status(404).json({ error: 'unknown_speaker' });
  const p = nextPrompt(speaker);
  const done = [...(doneBySpeaker.get(speaker) || [])].length;
  res.json({ prompt: p && { id: p.id, type: p.type, sw: p.sw }, done, total: prompts.length });
});

app.post('/api/submit', limit(2000), json, (req, res) => {
  const b = req.body || {};
  if (!validSpeaker(b.speaker)) return res.status(404).json({ error: 'unknown_speaker' });
  const prompt = promptById.get(b.prompt);
  if (!prompt) return res.status(400).json({ error: 'unknown_prompt' });
  const rec = { speaker: b.speaker, prompt: prompt.id, sw: prompt.sw, time: new Date().toISOString() };
  if (b.skip === true) {
    rec.skipped = true;
  } else {
    rec.sukuma = clean(b.sukuma, MAX_TEXT);
    if (!rec.sukuma) return res.status(400).json({ error: 'text_required' });
    if (b.audio) {
      const type = String(b.audio_type || '').split(';')[0].trim().toLowerCase();
      const ext = AUDIO_TYPES[type];
      if (!ext) return res.status(400).json({ error: 'audio_type' });
      const buf = Buffer.from(String(b.audio), 'base64');
      if (!buf.length || buf.length > MAX_AUDIO_BYTES) return res.status(400).json({ error: 'audio_size' });
      rec.audio = `${rec.speaker}_${prompt.id}_${Date.now()}.${ext}`;
      rec.seconds = Math.max(0, Math.min(60, Number(b.seconds) || 0));
      fs.writeFileSync(path.join(AUDIO_DIR, rec.audio), buf);
    }
  }
  append(SUBMISSIONS, rec);
  index(rec);
  res.json({ ok: true });
});

// ---- Admin (HTTP Basic auth; password lives only in .env on the server) ----
function admin(req, res, next) {
  const pass = process.env.ADMIN_PASSWORD;
  const user = process.env.ADMIN_USER || 'admin';
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  const given = scheme === 'Basic' ? Buffer.from(token || '', 'base64').toString() : '';
  const want = `${user}:${pass}`;
  const ok = pass && pass !== 'change-me-on-the-server' && given.length === want.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));
  if (ok) return next();
  res.set('WWW-Authenticate', 'Basic realm="Sukuma admin"').status(401).send('Sign in required');
}

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
function recordingsCsv() {
  const head = ['file', 'transcript', 'swahili', 'speaker', 'gender', 'age_group', 'region', 'district', 'prompt', 'seconds', 'time'];
  const rows = readJsonl(SUBMISSIONS).filter((r) => !r.skipped).map((r) => {
    const s = speakers.get(r.speaker) || {};
    return [r.audio ? `audio/${r.audio}` : '', r.sukuma, r.sw, r.speaker, s.gender, s.age_group, s.region, s.district, r.prompt, r.seconds || '', r.time];
  });
  return '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}
app.get('/admin/recordings.csv', limit(600), admin, (req, res) => {
  res.type('text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="recordings.csv"').send(recordingsCsv());
});

// Everything in one file: recordings.csv plus audio/<file> for every recording.
// A plain stored (uncompressed) zip: phone audio is already compressed, and this
// needs no zip program on the server. One audio file is in memory at a time.
app.get('/admin/export.zip', limit(60), admin, async (req, res) => {
  const { crc32 } = require('node:zlib');
  const name = `kisukuma-${new Date().toISOString().slice(0, 10)}.zip`;
  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}"` });
  const entries = [];
  let offset = 0;
  const write = (buf) => new Promise((ok) => { offset += buf.length; res.write(buf) ? ok() : res.once('drain', ok); });
  const dos = (d) => [((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff,
    (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff];
  async function add(path_, data, when) {
    const fname = Buffer.from(path_, 'utf8');
    const crc = crc32(data);
    const [time, date] = dos(when);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fname.length, 26); local.writeUInt16LE(0, 28);
    entries.push({ fname, crc, size: data.length, time, date, at: offset });
    await write(local); await write(fname); await write(data);
  }
  try {
    const now = new Date();
    await add('recordings.csv', Buffer.from(recordingsCsv(), 'utf8'), now);
    for (const r of readJsonl(SUBMISSIONS)) {
      if (r.skipped || !r.audio || !/^[\w.-]+$/.test(r.audio)) continue;
      const file = path.join(AUDIO_DIR, r.audio);
      if (!fs.existsSync(file)) continue;
      await add(`audio/${r.audio}`, fs.readFileSync(file), fs.statSync(file).mtime);
    }
    const start = offset;
    for (const e of entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(0, 10); c.writeUInt16LE(e.time, 12); c.writeUInt16LE(e.date, 14); c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.size, 20); c.writeUInt32LE(e.size, 24); c.writeUInt16LE(e.fname.length, 28);
      c.writeUInt32LE(e.at, 42);
      await write(c); await write(e.fname);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(offset - start, 12); end.writeUInt32LE(start, 16);
    await write(end);
    res.end();
  } catch (err) {
    console.error('export failed', err);
    res.destroy(err);
  }
});
app.get('/admin/audio/:file', limit(5000), admin, (req, res) => {
  if (!/^spk-[a-f0-9]{10}_[\w-]+_\d+\.(webm|m4a|ogg|wav)$/.test(req.params.file)) return res.sendStatus(400);
  res.sendFile(path.join(AUDIO_DIR, req.params.file), (err) => err && !res.headersSent && res.sendStatus(404));
});
app.get('/admin', limit(600), admin, (req, res) => {
  const subs = readJsonl(SUBMISSIONS).filter((r) => !r.skipped);
  const secs = subs.reduce((a, r) => a + (r.seconds || 0), 0);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const last = subs.slice(-30).reverse().map((r) => `<tr><td>${esc(r.time.slice(0, 16))}</td><td>${esc(r.speaker)}</td><td>${esc(r.sw)}</td><td>${esc(r.sukuma)}</td><td>${r.audio ? `<a href="/admin/audio/${esc(r.audio)}">play</a>` : ''}</td></tr>`).join('');
  res.send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sukuma admin</title>
<link rel="stylesheet" href="/style.css?v=1"><main class="admin"><h1>Collected so far</h1>
<p><b>${speakers.size}</b> speakers · <b>${subs.length}</b> sentences · <b>${subs.filter((r) => r.audio).length}</b> with audio · <b>${(secs / 60).toFixed(1)}</b> minutes of speech</p>
<p><a href="/admin/export.zip"><b>Download everything (.zip)</b></a>: recordings.csv plus every audio file, ready for the toolkit. Or <a href="/admin/recordings.csv">just the CSV</a>.</p>
<table><thead><tr><th>Time (UTC)</th><th>Speaker</th><th>Swahili</th><th>Sukuma</th><th>Audio</th></tr></thead><tbody>${last}</tbody></table></main></html>`);
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '30d', setHeaders: (res, p) => p.endsWith('.html') && res.set('Cache-Control', 'no-cache') }));
app.use((req, res) => res.status(404).send('Not found'));

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Sauti ya Kisukuma listening on ${port}; data in ${DATA_DIR}`));
}
module.exports = { app, nextPrompt };
