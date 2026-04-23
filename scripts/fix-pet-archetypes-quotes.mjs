import { readFileSync, writeFileSync } from 'fs';

const path = 'packages/shared/src/constants/pet-archetypes.ts';
let src = readFileSync(path, 'utf8');

const namesPattern = /Sandy's Treedome|Patrick's Rock|Squidward's House/;
const lines = src.split(/\r?\n/);
let fixed = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!namesPattern.test(line)) continue;

  // Match lines of shape:  <prefix>'<inner>'<suffix>   where outer delimiter is single quote
  const m = line.match(/^(\s*[^']*?)'(.*)'([,;\s]*)$/);
  if (!m) continue;

  const [, prefix, inner, suffix] = m;

  // Un-escape \' into bare ' (no longer need escape in double-quoted literal)
  let newInner = inner.replace(/\\'/g, "'");
  // Escape any unescaped " characters
  newInner = newInner.replace(/(^|[^\\])"/g, '$1\\"');

  lines[i] = `${prefix}"${newInner}"${suffix}`;
  fixed++;
}

writeFileSync(path, lines.join('\n'));
console.log('fixed lines:', fixed);
