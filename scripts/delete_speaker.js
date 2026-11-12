#!/usr/bin/env node
// Remove everything one speaker contributed (a withdrawal request).
//   node scripts/delete_speaker.js spk-0123456789
// Stop or restart the app afterwards so its in-memory counts reload.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const id = process.argv[2];
if (!/^spk-[a-f0-9]{10}$/.test(id || '')) { console.error('Usage: node scripts/delete_speaker.js spk-xxxxxxxxxx'); process.exit(1); }
const dir = path.resolve(__dirname, '..', process.env.DATA_DIR || './data');
let removed = 0;
for (const name of ['speakers.jsonl', 'submissions.jsonl']) {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) continue;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const keep = lines.filter((l) => JSON.parse(l).speaker !== id);
  removed += lines.length - keep.length;
  fs.writeFileSync(file, keep.length ? keep.join('\n') + '\n' : '');
}
const audio = path.join(dir, 'audio');
let files = 0;
if (fs.existsSync(audio)) for (const f of fs.readdirSync(audio)) if (f.startsWith(id + '_')) { fs.unlinkSync(path.join(audio, f)); files++; }
console.log(`Removed ${removed} records and ${files} audio files for ${id}. Restart the app.`);
