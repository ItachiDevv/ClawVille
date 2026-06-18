// Decode meshopt-compressed land-structure GLBs and print per-PRIMITIVE
// world-space bounding boxes. A flat-and-large primitive (one axis ~0, the
// other two large) is the "wall" sweeping through the preview scene.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const FILES = [
  'coastal-cottage/home.glb',
  'coastal-cottage/shop.glb',
  'driftwood-cabin/home.glb',
  'driftwood-cabin/shop.glb',
  'fantasy-cottage/home.glb',
  'fantasy-cottage/shop.glb',
];

const BASE = 'apps/web/public/models/land-structures/';

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

await MeshoptDecoder.ready;

// Multiply a node's accumulated world matrix down the tree, transform each
// primitive's POSITION accessor, and accumulate a bbox.
function mul(a, b) {
  // 4x4 column-major multiply (a*b)
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}
function trs(node) {
  const t = node.getTranslation();
  const q = node.getRotation();
  const s = node.getScale();
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}
function apply(m, p) {
  const [x, y, z] = p;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

for (const f of FILES) {
  const doc = await io.read(BASE + f);
  const root = doc.getRoot();
  const scene = root.listScenes()[0];

  console.log(`\n=== ${f} ===`);

  // overall bbox + per-primitive
  let gmin = [Infinity, Infinity, Infinity];
  let gmax = [-Infinity, -Infinity, -Infinity];
  const prims = [];

  function walk(node, parentMat) {
    const m = mul(parentMat, trs(node));
    const mesh = node.getMesh();
    if (mesh) {
      mesh.listPrimitives().forEach((prim, pi) => {
        const pos = prim.getAttribute('POSITION');
        if (!pos) return;
        const count = pos.getCount();
        let lmin = [Infinity, Infinity, Infinity];
        let lmax = [-Infinity, -Infinity, -Infinity];
        const tmp = [0, 0, 0];
        for (let i = 0; i < count; i++) {
          pos.getElement(i, tmp);
          const w = apply(m, tmp);
          for (let k = 0; k < 3; k++) {
            if (w[k] < lmin[k]) lmin[k] = w[k];
            if (w[k] > lmax[k]) lmax[k] = w[k];
            if (w[k] < gmin[k]) gmin[k] = w[k];
            if (w[k] > gmax[k]) gmax[k] = w[k];
          }
        }
        prims.push({
          name: `${mesh.getName() || 'mesh'}[${pi}]`,
          count,
          size: [lmax[0] - lmin[0], lmax[1] - lmin[1], lmax[2] - lmin[2]],
          min: lmin,
          max: lmax,
        });
      });
    }
    node.listChildren().forEach((ch) => walk(ch, m));
  }
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  scene.listChildren().forEach((n) => walk(n, I));

  const gsize = [gmax[0] - gmin[0], gmax[1] - gmin[1], gmax[2] - gmin[2]];
  console.log(`overall size: ${gsize.map((v) => v.toFixed(2)).join(' x ')}`);
  const maxDim = Math.max(...gsize);
  // Flag primitives that are flat (one axis tiny rel to others) AND large.
  prims
    .sort((a, b) => Math.max(...b.size) - Math.max(...a.size))
    .forEach((p) => {
      const mx = Math.max(...p.size);
      const mn = Math.min(...p.size);
      const flatRatio = mn / (mx || 1);
      const big = mx > maxDim * 0.6;
      const flat = flatRatio < 0.06;
      const flag = flat && big ? '  <== FLAT+LARGE (suspect wall)' : flat ? '  <-- flat' : '';
      console.log(
        `  ${p.name.padEnd(28)} tris~${String(Math.round(p.count / 3)).padStart(6)}  ` +
          `size ${p.size.map((v) => v.toFixed(1)).join(',')}  ratio ${flatRatio.toFixed(3)}${flag}`,
      );
    });
}
