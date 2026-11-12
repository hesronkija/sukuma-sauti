# Sauti ya Kisukuma

A small website for collecting everyday Sukuma. A speaker sees a Swahili word
or sentence, writes it in Sukuma, and records themselves saying it. Built for
the [sukuma-toolkit](https://github.com/hesronkija/sukuma-toolkit) senior project.

What it collects, per item: the Swahili prompt, the written Sukuma, an audio
clip (up to 40 s), and a speaker code with optional gender, age group and
region. No names, phone numbers or IP addresses are stored.

## Run it locally

```bash
npm install
cp .env.example .env      # set ADMIN_PASSWORD
npm start                 # http://localhost:3000 (runs server.js)
npm test
```

Recording needs HTTPS (or localhost), so phones can only record on the live site.

## Where the data goes

Everything is plain files under `DATA_DIR` (default `./data`, gitignored):

- `speakers.jsonl`: one line per speaker
- `submissions.jsonl`: one line per answer or skip
- `audio/`: the recordings (`.webm` on Android/Chrome, `.m4a` on iPhone)

`/admin` (password from `.env`) shows totals and the latest answers, and
`/admin/recordings.csv` downloads everything in the same columns as the
toolkit's recording kit. Convert audio for training with
`ffmpeg -i in.webm -ar 16000 -ac 1 out.wav`.

To honour a withdrawal request: `node scripts/delete_speaker.js spk-xxxxxxxxxx`, then restart the app.

## Prompts

`prompts.json` holds 172 everyday sentences in 11 topics (greetings, family,
food, market, farming, health, weather and time, travel, school and work,
phone and money, home) and 50 common words. Each speaker starts with three
words as a warm-up; after that the site serves whichever prompts have the
fewest answers so far, so coverage stays even. Add prompts by appending to
the file with a new unique `id`.

## Before sharing the link

- Confirm with your faculty mentor whether collecting recordings needs IRB review.
- Set `CONTACT_EMAIL` so speakers can ask for their recordings to be deleted.
- Have a Sukuma speaker read through the consent text and try the flow on a phone.

## Deploying

Pushing to `main` deploys automatically (`.github/workflows/deploy.yml`): GitHub runs the
tests, connects to the Namecheap server over SSH, moves `~/sukuma-sauti` to the new commit
and runs `deploy.sh`. That script refuses a broken commit (merge-conflict markers, syntax
errors, invalid `prompts.json`) by rolling back to the previous version, installs packages
only when `package.json` changed, and restarts the app. The workflow then checks `/health`.

Repository settings it needs: secrets `NC_HOST`, `NC_USER`, `NC_SSH_KEY`, `NC_APP_DIR`, and
the variable `SITE_URL`. The data folder and `.env` on the server are never touched.
