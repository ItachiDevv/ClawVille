#!/usr/bin/env bun
// One-shot generator for apps/web/public/town-directory-sign.png
// Requires the `canvas` npm dep (dev).
import { createCanvas } from 'canvas';
import { writeFileSync } from 'fs';

const W = 1024, H = 512;
const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

ctx.fillStyle = '#7c4a1b';
ctx.fillRect(0, 0, W, H);

ctx.fillStyle = 'rgba(60, 35, 15, 0.18)';
for (let y = 30; y < H; y += 60) ctx.fillRect(0, y, W, 6);

ctx.strokeStyle = '#3c230f';
ctx.lineWidth = 16;
ctx.strokeRect(8, 8, W - 16, H - 16);

ctx.textAlign = 'center';
ctx.textBaseline = 'middle';
ctx.fillStyle = '#f5e6c8';

ctx.font = 'bold 140px serif';
ctx.fillText('TOWN CENTER', W / 2, 130);

ctx.strokeStyle = '#f5e6c8';
ctx.lineWidth = 4;
ctx.beginPath();
ctx.moveTo(W / 2 - 260, 210);
ctx.lineTo(W / 2 + 260, 210);
ctx.stroke();

ctx.font = '80px serif';
ctx.fillText('Auction', W / 2, 290);
ctx.fillText('Bazaar', W / 2, 370);
ctx.fillText('Marketplace', W / 2, 450);

const out = 'apps/web/public/town-directory-sign.png';
writeFileSync(out, canvas.toBuffer('image/png'));
console.log('wrote', out);
