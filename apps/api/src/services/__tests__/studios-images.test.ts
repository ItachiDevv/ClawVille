import { describe, expect, it } from 'bun:test';
import { decodeImage } from '../studios-images';
import { STUDIOS_KEY_PATTERN } from '../vendor-credentials';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)]);

describe('decodeImage', () => {
  it('accepts png, jpeg and webp by their magic bytes', () => {
    expect(decodeImage(PNG.toString('base64'))?.mime).toBe('image/png');
    expect(decodeImage(JPEG.toString('base64'))?.mime).toBe('image/jpeg');
    expect(decodeImage(WEBP.toString('base64'))?.mime).toBe('image/webp');
  });
  it('refuses anything else, and empty or oversized data', () => {
    expect(decodeImage(Buffer.from('<svg onload=alert(1)>').toString('base64'))).toBeNull();
    expect(decodeImage(Buffer.from('<html>').toString('base64'))).toBeNull();
    expect(decodeImage('')).toBeNull();
    expect(decodeImage(Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)]).toString('base64'))).toBeNull();
  });
});

describe('STUDIOS_KEY_PATTERN', () => {
  it('accepts a chk_ key and refuses others', () => {
    expect(STUDIOS_KEY_PATTERN.test('chk_abcdefghijklmnop1234')).toBe(true);
    for (const bad of ['chk_short', 'sk_abcdefghijklmnop1234', 'chk_abc def ghijklmnop1234', '']) {
      expect(STUDIOS_KEY_PATTERN.test(bad)).toBe(false);
    }
  });
});
