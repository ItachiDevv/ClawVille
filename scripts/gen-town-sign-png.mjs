#!/usr/bin/env bun
// Generates apps/web/public/town-directory-sign.png with the TOWN CENTER
// directory text baked in. Re-run whenever the sign text changes.
//
// Requires: bun add -d canvas
import { createCanvas } from 'canvas';
import { writeFileSync } from 'fs';

const W = 1024, H = 512;
const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

// Wood base
ctx.fillStyle = '#7c4a1b';
ctx.fillRect(0, 0, W, H);

// Subtle horizontal grain stripes
ctx.fillStyle = 'rgba(60, 35, 15, 0.18)';
for (let y = 30; y < H; y += 60) ctx.fillRect(0, y, W, 6);

// Dark border (inset)
ctx.strokeStyle = '#3c230f';
ctx.lineWidth = 16;
ctx.strokeRect(8, 8, W - 16, H - 16);

// Text
ctx.textAlign = 'center';
ctx.textBaseline = 'middle';
ctx.fillStyle = '#f5e6c8';

ctx.font = 'bold 100px serif';
ctx.fillText('TOWN CENTER', W / 2, 110);

// Divider
ctx.strokeStyle = '#f5e6c8';
ctx.lineWidth = 4;
ctx.beginPath();
ctx.moveTo(W / 2 - 220, 180);
ctx.lineTo(W / 2 + 220, 180);
ctx.stroke();

ctx.font = '60px serif';
ctx.fillText('Auction', W / 2, 260);
ctx.fillText('Bazaar', W / 2, 340);
ctx.fillText('Marketplace', W / 2, 420);

const out = 'apps/web/public/town-directory-sign.png';
writeFileSync(out, canvas.toBuffer('image/png'));
console.log('wrote', out);
