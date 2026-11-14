// Copy texture images, slot by slot, from one GLB into another with the same
// materials. Geometry, samplers and texture settings of <into> stay as they are.
// Usage: node scripts/models/glb-copy-textures.mjs <from.glb> <into.glb> <out.glb> [--except slotA,slotB]
// Slots are matched by material name and glTF slot name, including extension
// slots (e.g. specularTexture). --except takes slot names to leave alone, e.g.
// --except metallicRoughnessTexture,occlusionTexture
// Check every output with glb-compare.mjs before it ships.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRTextureBasisu } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const ei = args.indexOf('--except');
const except = new Set(ei >= 0 ? args.splice(ei, 2)[1].split(',') : []);
const [fromFile, intoFile, outFile] = args;
if (!fromFile || !intoFile || !outFile) { console.error('usage: glb-copy-textures.mjs <from.glb> <into.glb> <out.glb> [--except a,b]'); process.exit(2); }
const json = (f) => { const b = readFileSync(f); return JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8')); };
const imageOf = (j, ti) => { const t = j.textures[ti]; return t.source ?? t.extensions?.KHR_texture_basisu?.source ?? t.extensions?.EXT_texture_webp?.source ?? t.extensions?.EXT_texture_avif?.source; };
const slots = (j, m) => {
  const out = new Map();
  const walk = (o, path) => { for (const [k, v] of Object.entries(o ?? {})) { if (!v || typeof v !== 'object') continue; if (/Texture$/.test(k) && typeof v.index === 'number') out.set(`${path}${k}`, { slot: k, image: imageOf(j, v.index) }); else walk(v, `${path}${k}.`); } };
  walk(m, ''); return out;
};
await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const [jf, ji] = [json(fromFile), json(intoFile)];
const [df, di] = [await io.read(fromFile), await io.read(intoFile)];
const tf = df.getRoot().listTextures(), ti = di.getRoot().listTextures();
const fromByName = new Map((jf.materials ?? []).map((m) => [m.name, m]));
const map = new Map(); let copied = 0;
for (const m of ji.materials ?? []) {
  const f = fromByName.get(m.name); if (!f) throw new Error(`no source material "${m.name}"`);
  const sf = slots(jf, f);
  for (const [path, s] of slots(ji, m)) {
    if (except.has(s.slot)) continue;
    const src = sf.get(path); if (!src) throw new Error(`source has no ${path} on "${m.name}"`);
    if (map.has(s.image) && map.get(s.image) !== src.image) throw new Error(`image ${s.image} would take two sources`);
    map.set(s.image, src.image);
  }
}
for (const [i, f] of map) { ti[i].setImage(tf[f].getImage().slice()).setMimeType(tf[f].getMimeType()); copied++; }
if ([...map.values()].some((f) => tf[f].getMimeType() === 'image/ktx2')) di.createExtension(KHRTextureBasisu).setRequired(true);
await io.write(outFile, di);
console.log(`copied ${copied} images (except: ${[...except].join(', ') || 'none'})`);
