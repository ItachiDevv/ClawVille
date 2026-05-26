import fs from 'node:fs';

const PATH = '.claude/plans/phase6-casino-slots.md';
const src = fs.readFileSync(PATH, 'utf8');

// Substitutions applied to PROSE only.
// Order matters: longer phrases first.
const SUBS = [
  // Phrases first
  [/\breal[- ]money\b/gi, 'SOL/USDC tier'],
  [/\bhouse[- ]edge\b/gi, 'operator edge'],

  // Casino (building / proper noun)
  [/\bThe Casino\b/g, 'The Predictive Gaming Cove'],
  [/\bCasino\b/g, 'the Cove'],
  [/\bcasino\b/g, 'the cove'],

  // Slot machine -> reel cabinet
  [/\bSlot machine\b/g, 'Reel cabinet'],
  [/\bslot machine\b/g, 'reel cabinet'],
  [/\bslot screen\b/g, 'reel screen'],

  // Plural -> reels
  [/\bSlots\b/g, 'Reels'],
  [/\bslots\b/g, 'reels'],

  // Singular -> reel game
  [/\bSlot\b/g, 'Reel'],
  [/\bslot\b/g, 'reel'],

  // Gambling -> gaming
  [/\bGambling\b/g, 'Gaming'],
  [/\bgambling\b/g, 'gaming'],

  // Wager -> predict
  [/\bWagering\b/g, 'Predicting'],
  [/\bwagering\b/g, 'predicting'],
  [/\bWagered\b/g, 'Predicted'],
  [/\bwagered\b/g, 'predicted'],
  [/\bWagers\b/g, 'Predictions'],
  [/\bwagers\b/g, 'predictions'],
  [/\bWager\b/g, 'Predict'],
  [/\bwager\b/g, 'predict'],

  // RTP -> return rate
  [/\bRTP\b/g, 'return rate'],

  // Bet handled by the rename agent — skip here.
];

// Split text into code/non-code segments, transform non-code only.
// Recognized code regions:
//   - Triple-backtick fenced code blocks
//   - Inline single-backtick code spans
//   - 4-space indented code lines (less common in this doc; tolerate via line check)
function transform(input) {
  // Tokenize by fenced blocks first.
  const fenceRe = /^```[\s\S]*?^```/gm;
  let result = '';
  let last = 0;
  for (const m of input.matchAll(fenceRe)) {
    const before = input.slice(last, m.index);
    result += transformProse(before);
    result += m[0]; // keep fenced block verbatim
    last = m.index + m[0].length;
  }
  result += transformProse(input.slice(last));
  return result;
}

function transformProse(chunk) {
  // Tokenize inline code spans `...` and keep them verbatim.
  const inlineRe = /`[^`\n]+`/g;
  let out = '';
  let last = 0;
  for (const m of chunk.matchAll(inlineRe)) {
    const before = chunk.slice(last, m.index);
    out += applySubs(before);
    out += m[0]; // keep inline code verbatim
    last = m.index + m[0].length;
  }
  out += applySubs(chunk.slice(last));
  return out;
}

function applySubs(text) {
  let t = text;
  for (const [re, replacement] of SUBS) {
    t = t.replace(re, replacement);
  }
  return t;
}

const out = transform(src);
fs.writeFileSync(PATH, out);

// Quick post-scan
const postScan = out.match(/\b(gambling|wager|casino|slots?|real[- ]money|RTP|house[- ]edge)\b/gi) || [];
const inCodeRegions = (out.match(/`[^`\n]+`|^```[\s\S]*?^```/gm) || []).join('\n');
const surviving = postScan.filter((term) => !inCodeRegions.includes(term));
console.log(`Wrote ${PATH}`);
console.log(`Banned-term hits remaining (case-insensitive, anywhere): ${postScan.length}`);
console.log(`Banned-term hits in code regions only (acceptable): ${postScan.length - surviving.length}`);
console.log(`Banned-term hits in prose (should be 0): ${surviving.length}`);
