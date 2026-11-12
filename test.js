'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauti-'));
process.env.DATA_DIR = dir;
process.env.ADMIN_USER = 'a';
process.env.ADMIN_PASSWORD = 'secret-pass';
const { app } = require('./app.js');
let server, base;
before(() => new Promise((ok) => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; ok(); }); }));
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('consent is required to become a speaker', async () => {
  assert.strictEqual((await post('/api/speaker', { consent: true })).status, 400);
  assert.strictEqual((await post('/api/speaker', { adult: true })).status, 400);
});

test('full flow: speaker, prompt, submit with audio, skip, export', async () => {
  const { speaker } = await (await post('/api/speaker', { consent: true, adult: true, gender: 'Female', age_group: '26-35', region: 'Mwanza', district: '<b>Magu</b>' })).json();
  assert.match(speaker, /^spk-[a-f0-9]{10}$/);
  let n = await (await fetch(`${base}/api/next?speaker=${speaker}`)).json();
  assert.strictEqual(n.done, 0);
  assert.strictEqual(n.prompt.type, 'word'); // warm-up
  const audio = Buffer.from('fake-webm-bytes').toString('base64');
  assert.strictEqual((await post('/api/submit', { speaker, prompt: n.prompt.id, sukuma: '  minzi\u0000 ', audio, audio_type: 'audio/webm;codecs=opus', seconds: 2.5 })).status, 200);
  const first = n.prompt.id;
  n = await (await fetch(`${base}/api/next?speaker=${speaker}`)).json();
  assert.strictEqual(n.done, 1);
  assert.notStrictEqual(n.prompt.id, first);
  assert.strictEqual((await post('/api/submit', { speaker, prompt: n.prompt.id, skip: true })).status, 200);
  assert.strictEqual((await post('/api/submit', { speaker, prompt: n.prompt.id, sukuma: '' })).status, 400);
  assert.strictEqual((await post('/api/submit', { speaker, prompt: 'nope', sukuma: 'x' })).status, 400);
  assert.strictEqual((await post('/api/submit', { speaker, prompt: first, sukuma: 'x', audio, audio_type: 'text/html' })).status, 400);
  assert.strictEqual((await post('/api/submit', { speaker: 'spk-0000000000', prompt: first, sukuma: 'x' })).status, 404);

  assert.strictEqual((await fetch(base + '/admin')).status, 401);
  const auth = { headers: { Authorization: 'Basic ' + Buffer.from('a:secret-pass').toString('base64') } };
  const csv = await (await fetch(base + '/admin/recordings.csv', auth)).text();
  const row = csv.trim().split('\n')[1];
  assert.match(row, /"minzi"/);
  assert.match(row, /"Female","26-35","Mwanza","<b>Magu<\/b>"/);
  const file = row.split(',')[0].replace(/"/g, '').replace(/^audio\//, '');
  assert.strictEqual(await (await fetch(`${base}/admin/audio/${file}`, auth)).text(), 'fake-webm-bytes');

  // The zip holds the CSV and the audio, and a real unzip tool accepts it.
  assert.strictEqual((await fetch(base + '/admin/export.zip')).status, 401);
  const zip = Buffer.from(await (await fetch(base + '/admin/export.zip', auth)).arrayBuffer());
  assert.strictEqual(zip.readUInt32LE(0), 0x04034b50);
  assert.strictEqual(zip.readUInt16LE(zip.length - 12), 2); // recordings.csv + one audio file
  const zpath = path.join(dir, 'export.zip');
  fs.writeFileSync(zpath, zip);
  const { execFileSync } = require('node:child_process');
  try {
    execFileSync('unzip', ['-tq', zpath]);
    assert.strictEqual(execFileSync('unzip', ['-p', zpath, `audio/${file}`]).toString(), 'fake-webm-bytes');
    assert.match(execFileSync('unzip', ['-p', zpath, 'recordings.csv']).toString(), /"minzi"/);
  } catch (e) { if (e.code !== 'ENOENT') throw e; } // no unzip installed: the byte checks above still ran
  assert.strictEqual((await fetch(`${base}/admin/audio/..%2F..%2Fapp.js`, auth)).status, 400);
  const page = await (await fetch(base + '/admin', auth)).text();
  assert.ok(page.includes('1</b> sentences') && !page.includes('<b>Magu'));
});

test('wrong admin password is refused', async () => {
  const r = await fetch(base + '/admin', { headers: { Authorization: 'Basic ' + Buffer.from('a:wrong').toString('base64') } });
  assert.strictEqual(r.status, 401);
});

test('prompts are unique and every speaker can finish', () => {
  const prompts = require('./prompts.json');
  assert.strictEqual(new Set(prompts.map((p) => p.id)).size, prompts.length);
  assert.ok(prompts.every((p) => p.sw && !p.sw.includes('—')));
});
