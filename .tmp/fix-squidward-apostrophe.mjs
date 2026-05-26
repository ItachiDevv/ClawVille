import { readFileSync, writeFileSync } from 'fs';

const CURLY = '’';   // RIGHT SINGLE QUOTATION MARK
const STRAIGHT = '''; // APOSTROPHE

const filePath = 'apps/web/src/lib/three/arena-buildings.tsx';
let content = readFileSync(filePath, 'utf8');

const lines = content.split('\n');
let changed = 0;
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  // Only fix the actual data lines (not comments which start with //)
  if ((l.includes('childScaleOverrides') || l.includes('bodyAnchorChild')) &&
      l.includes('Squidward') && !l.trim().startsWith('//')) {
    const newLine = l.split(CURLY).join(STRAIGHT);
    if (newLine !== l) {
      console.log('Fixed line', i + 1, ':', JSON.stringify(newLine.trim().slice(0, 80)));
      lines[i] = newLine;
      changed++;
    }
  }
}
if (changed > 0) {
  writeFileSync(filePath, lines.join('\n'), 'utf8');
  console.log('Written', changed, 'line(s)');
} else {
  console.log('No curly apostrophes found in data lines. Current codepoints:');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.includes('bodyAnchorChild') && l.includes('Squidward') && !l.trim().startsWith('//')) {
      const idx = l.indexOf('Squidward');
      console.log('line', i + 1, 'cp after Squidward:', l.charCodeAt(idx + 9).toString(16));
    }
  }
}
