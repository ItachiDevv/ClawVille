#!/usr/bin/env node
// Voiceover lines -> one WAV per line with OpenAI TTS (gpt-4o-mini-tts).
//   OPENAI_API_KEY=... node tts.mjs <vo-lines.json> [outDir] [id ...]
// vo-lines.json: { "voice": "coral", "model": "gpt-4o-mini-tts", "instructions": "...",
//                  "lines": [ { "id": "01-hook", "beat": "hook", "text": "..." }, ... ] }
// Only the ids given on the command line are regenerated (all when none). The key is read from
// the env and never printed. Next step: vo-prep.py (trim, speed, measure).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const [cfgPath = 'vo-lines.json', outArg, ...only] = process.argv.slice(2);
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const out = outArg || dirname(cfgPath);
mkdirSync(out, { recursive: true });
if (!process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY is not set'); process.exit(1); }
for (const l of cfg.lines) {
  if (only.length && !only.includes(l.id)) continue;
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, voice: cfg.voice, input: l.text, instructions: cfg.instructions, response_format: 'wav' }),
  });
  if (!res.ok) { console.log(l.id, 'HTTP', res.status, (await res.text()).slice(0, 200)); continue; }
  writeFileSync(join(out, `${l.id}.wav`), Buffer.from(await res.arrayBuffer()));
  console.log(l.id, 'ok');
}
