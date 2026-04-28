/**
 * bake-vrm-hair.mjs
 *
 * Converts Hairmodel and Hatmodel from plain Meshes (children of Head node, no skinning)
 * to SkinnedMeshes fully weighted to mixamorig:Head (joint 29).
 *
 * ROOT CAUSE: Hairmodel/Hatmodel are plain Meshes parented to the Head scene node.
 * three-vrm drives the skeleton via Mixamo retarget, but the Head scene-node's
 * position does NOT track the animated bone — only the skinning matrices do.
 * So the hair stays at its bind-pose scene-node position while the head moves,
 * causing the 24.5wu bald-spot gap.
 *
 * FIX: Convert them to SkinnedMeshes with all vertices weighted to joint 29 (Head).
 *  1. Compute full transform: skinSpace = inv(IBM_head) * HairNodeTRS
 *     (IBM_head = inverseBindMatrix for joint 29; inv gives bindMatrix = Head_worldBind)
 *  2. Apply that transform to vertex positions and normals
 *  3. Add JOINTS_0 (all verts → joint 29) and WEIGHTS_0 (all verts → 1.0)
 *  4. Assign the Body's skin to these nodes
 *  5. Clear node TRS to identity (verts are now in skin space, not Head-local)
 *
 * WHY inv(IBM) IS NEEDED:
 *  Hairmodel TRS is in Head-local space (parented to Head node).
 *  Skinned mesh vertices must be in skin/model space (= Body vertex space).
 *  The bind matrix inv(IBM_head) = HeadWorldMatrix_at_rest converts Head-local → skin space.
 *  So: v_skin = inv(IBM_head) * HairNodeTRS * v_local
 *
 * VERIFIED: Body head verts (joint 29) are at Y≈0.62 in skin space.
 *           After transform, hair vert[0] lands at Y≈1.02 (above head). ✓
 *
 * Usage:
 *   bun scripts/bake-vrm-hair.mjs 1
 *     → writes .tmp/milady-vrm-bake/milady-official-1.vrm
 *   bun scripts/bake-vrm-hair.mjs
 *     → writes fixed copies for all 1-8 under .tmp/milady-vrm-bake/
 *   bun scripts/bake-vrm-hair.mjs --apply
 *     → overwrites apps/web/public/avatars/milady-official-{1..8}.vrm
 */

import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, EXTTextureWebP, KHRMeshQuantization } from '@gltf-transform/extensions';
import { dedup, weld, meshopt } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AVATARS_DIR = path.join(__dirname, '..', 'apps', 'web', 'public', 'avatars');

const HAIR_NODE_NAMES = ['Hairmodel', 'Hatmodel', 'Sketchfab_model', 'Object_1003', 'Object_1003_1'];
const HEAD_JOINT_INDEX = 29; // mixamorig:Head in both skins (verified)
const BODY_NODE_NAME = 'Body';

async function bakeVRMHair(vrmNumber, options) {
    const filePath = path.join(AVATARS_DIR, `milady-official-${vrmNumber}.vrm`);
    const outPath = options.apply
        ? filePath
        : path.join(options.outDir, `milady-official-${vrmNumber}.vrm`);
    console.log(`\n=== milady-official-${vrmNumber}.vrm ===`);
    console.log(`  Input:  ${filePath}`);
    console.log(`  Output: ${outPath}`);

    await MeshoptDecoder.ready;
    await MeshoptEncoder.ready;

    const io = new NodeIO()
        .registerExtensions([EXTMeshoptCompression, EXTTextureWebP, KHRMeshQuantization])
        .registerDependencies({
            'meshopt.decoder': MeshoptDecoder,
            'meshopt.encoder': MeshoptEncoder,
        });

    const document = await io.read(filePath);
    const root = document.getRoot();

    // Find Body node to borrow its skin
    let bodySkin = null;
    for (const node of root.listNodes()) {
        if (node.getName() === BODY_NODE_NAME) {
            bodySkin = node.getSkin();
            break;
        }
    }
    if (!bodySkin) throw new Error('Body node with skin not found');

    // Verify Head joint
    const headJoint = bodySkin.listJoints()[HEAD_JOINT_INDEX];
    if (!headJoint || !headJoint.getName().includes('Head')) {
        throw new Error(`Joint ${HEAD_JOINT_INDEX} = ${headJoint?.getName()} — expected Head`);
    }
    console.log(`  Skin ok. Joint ${HEAD_JOINT_INDEX} = ${headJoint.getName()}`);

    // Get inv(IBM_head) = bindMatrix for Head = HeadWorldMatrix_at_rest
    // This converts Head-local space → skin space
    const ibmAccessor = bodySkin.getInverseBindMatrices();
    if (!ibmAccessor) throw new Error('No inverseBindMatrices on skin');
    const ibm29 = ibmAccessor.getElement(HEAD_JOINT_INDEX, new Array(16).fill(0));
    const headBindMat = invertMat4(ibm29);
    if (!headBindMat) throw new Error('IBM for Head is not invertible');

    // Sanity: head origin in skin space should be ~Y=0.615 (matches Body head verts)
    const headOriginY = headBindMat[13];
    console.log(`  Head origin in skin space: Y=${headOriginY.toFixed(4)} (expected ~0.6)`);
    if (Math.abs(headOriginY - 0.6) > 0.2) {
        console.log(`  WARNING: head origin Y=${headOriginY.toFixed(4)} seems off. Check VRM structure.`);
    }

    for (const hairName of HAIR_NODE_NAMES) {
        let hairNode = null;
        for (const node of root.listNodes()) {
            if (node.getName() === hairName) { hairNode = node; break; }
        }
        if (!hairNode) {
            console.log(`  ${hairName}: not found — skipping`);
            continue;
        }

        const mesh = hairNode.getMesh();
        if (!mesh) {
            console.log(`  ${hairName}: no mesh — skipping`);
            continue;
        }

        const parentName = hairNode.getParentNode()?.getName() ?? '(none)';
        console.log(`  ${hairName}: parent=${parentName}, mesh=${mesh.getName()}`);

        // Node TRS (Hairmodel-local → Head-local)
        const t = hairNode.getTranslation();
        const r = hairNode.getRotation();
        const s = hairNode.getScale();
        console.log(`    t=[${t.map(v=>v.toFixed(4)).join(',')}] s=[${s.map(v=>v.toFixed(4)).join(',')}]`);

        // Full transform: Hair-local → Head-local → skin space
        // fullMat = headBindMat * hairTRS
        const hairTRS = trsToMat4(t, r, s);
        const fullMat = mul4x4(headBindMat, hairTRS);
        const normalMat3 = upperLeft3x3NormalMatrix(fullMat);

        const prims = mesh.listPrimitives();
        let totalVerts = 0;

        for (let pi = 0; pi < prims.length; pi++) {
            const prim = prims[pi];
            const posAcc = prim.getAttribute('POSITION');
            if (!posAcc) { console.log(`    prim ${pi}: no POSITION`); continue; }

            const count = posAcc.getCount();
            totalVerts += count;

            // Bake positions into skin space
            const baked = new Float32Array(count * 3);
            for (let i = 0; i < count; i++) {
                const p = posAcc.getElement(i, []);
                baked[i*3+0] = fullMat[0]*p[0] + fullMat[4]*p[1] + fullMat[8] *p[2] + fullMat[12];
                baked[i*3+1] = fullMat[1]*p[0] + fullMat[5]*p[1] + fullMat[9] *p[2] + fullMat[13];
                baked[i*3+2] = fullMat[2]*p[0] + fullMat[6]*p[1] + fullMat[10]*p[2] + fullMat[14];
            }
            prim.setAttribute('POSITION', document.createAccessor()
                .setType('VEC3').setArray(baked).setNormalized(false));

            // Bake normals
            const normAcc = prim.getAttribute('NORMAL');
            if (normAcc) {
                const bakedN = new Float32Array(count * 3);
                for (let i = 0; i < count; i++) {
                    const n = normAcc.getElement(i, []);
                    let nx = normalMat3[0]*n[0] + normalMat3[3]*n[1] + normalMat3[6]*n[2];
                    let ny = normalMat3[1]*n[0] + normalMat3[4]*n[1] + normalMat3[7]*n[2];
                    let nz = normalMat3[2]*n[0] + normalMat3[5]*n[1] + normalMat3[8]*n[2];
                    const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
                    bakedN[i*3+0] = nx/len; bakedN[i*3+1] = ny/len; bakedN[i*3+2] = nz/len;
                }
                prim.setAttribute('NORMAL', document.createAccessor()
                    .setType('VEC3').setArray(bakedN).setNormalized(false));
            }

            // Add JOINTS_0: all verts → joint HEAD_JOINT_INDEX
            const joints = new Uint8Array(count * 4);
            for (let i = 0; i < count; i++) {
                joints[i*4+0] = HEAD_JOINT_INDEX;
                // [1],[2],[3] = 0 (unused joints)
            }
            prim.setAttribute('JOINTS_0', document.createAccessor()
                .setType('VEC4').setArray(joints).setNormalized(false));

            // Add WEIGHTS_0: [1, 0, 0, 0] for all verts
            const weights = new Float32Array(count * 4);
            for (let i = 0; i < count; i++) {
                weights[i*4+0] = 1.0;
                // [1],[2],[3] = 0.0
            }
            prim.setAttribute('WEIGHTS_0', document.createAccessor()
                .setType('VEC4').setArray(weights).setNormalized(false));

            console.log(`    prim ${pi}: baked ${count} verts → skin space`);
        }

        // Assign the Body's skin to this node
        hairNode.setSkin(bodySkin);

        // Clear local transform — vertices are now in skin space
        hairNode.setTranslation([0, 0, 0]);
        hairNode.setScale([1, 1, 1]);
        hairNode.setRotation([0, 0, 0, 1]);

        // Re-parent to scene root (same level as Body) so the node's
        // parent transform doesn't interfere with skinning.
        // three-vrm expects skinned mesh nodes to be at scene root or body-level.
        const parentNode = hairNode.getParentNode();
        if (parentNode) {
            parentNode.removeChild(hairNode);
        }
        // Add to each scene as a root child
        for (const scene of root.listScenes()) {
            scene.addChild(hairNode);
        }

        console.log(`  ${hairName}: done (${totalVerts} total verts)`);
    }

    // gltf-transform drops the VRM extension (it's unregistered/unknown).
    // Strategy: write GLB to temp, extract JSON from both original and temp,
    // splice original's extensions block back into the output JSON, rewrite GLB.
    mkdirSync(path.dirname(outPath), { recursive: true });
    await document.transform(
        dedup(),
        weld({ tolerance: 0.0001 }),
        meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
    );

    const tmpPath = outPath.replace(/\.vrm$/, '.tmp.glb');
    await io.write(tmpPath, document);

    // Read original VRM extension JSON from the source file. Using source instead
    // of `.bak` keeps this usable for all 8 avatars; only official-1 currently
    // has a checked-in .bak.
    const origJson = readGlbJsonChunk(filePath);
    const vrmExt = origJson.extensions?.VRM;
    if (!vrmExt) {
        console.log('  WARNING: original had no VRM extension — skipping extension merge');
    }

    // Read output GLB JSON chunk
    const outJson = readGlbJsonChunk(tmpPath);

    // Merge: splice original extensions into output
    if (vrmExt) {
        if (!outJson.extensions) outJson.extensions = {};
        outJson.extensions.VRM = vrmExt;
        if (!outJson.extensionsUsed) outJson.extensionsUsed = [];
        if (!outJson.extensionsUsed.includes('VRM')) outJson.extensionsUsed.push('VRM');
        console.log('  Merged VRM extension from original');
    }

    // Write merged GLB back
    rewriteGlbJsonChunk(tmpPath, outPath, outJson);
    // Clean up temp file
    try { unlinkSync(tmpPath); } catch {}
    console.log(`  Saved → ${outPath} (binary GLB with VRM extension)`);
}

// --- Matrix helpers ---

/** Build 4x4 column-major matrix from translation, quaternion rotation, scale. */
function trsToMat4(t, q, s) {
    const [qx, qy, qz, qw] = q;
    const [sx, sy, sz] = s;
    const [tx, ty, tz] = t;
    return [
        (1-2*(qy*qy+qz*qz))*sx,  (2*(qx*qy+qz*qw))*sx,  (2*(qx*qz-qy*qw))*sx, 0,
        (2*(qx*qy-qz*qw))*sy,    (1-2*(qx*qx+qz*qz))*sy,(2*(qy*qz+qx*qw))*sy, 0,
        (2*(qx*qz+qy*qw))*sz,    (2*(qy*qz-qx*qw))*sz,  (1-2*(qx*qx+qy*qy))*sz,0,
        tx, ty, tz, 1,
    ];
}

/** Multiply two 4x4 column-major matrices: C = A * B. */
function mul4x4(A, B) {
    const C = new Array(16).fill(0);
    for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
            for (let k = 0; k < 4; k++) {
                C[col*4+row] += A[k*4+row] * B[col*4+k];
            }
        }
    }
    return C;
}

/**
 * Upper-left 3x3 inverse-transpose (normal matrix) of a 4x4 column-major matrix.
 * Returns a 9-element column-major array: col0=[0,1,2], col1=[3,4,5], col2=[6,7,8].
 */
function upperLeft3x3NormalMatrix(m) {
    const a=m[0],b=m[1],c=m[2], d=m[4],e=m[5],f=m[6], g=m[8],h=m[9],k=m[10];
    const det = a*(e*k-f*h) - d*(b*k-c*h) + g*(b*f-c*e);
    if (Math.abs(det) < 1e-10) return [1,0,0,0,1,0,0,0,1];
    const inv = [
         (e*k-f*h)/det, -(b*k-c*h)/det,  (b*f-c*e)/det,
        -(d*k-f*g)/det,  (a*k-c*g)/det, -(a*f-c*d)/det,
         (d*h-e*g)/det, -(a*h-b*g)/det,  (a*e-b*d)/det,
    ];
    // Transpose
    return [inv[0],inv[3],inv[6], inv[1],inv[4],inv[7], inv[2],inv[5],inv[8]];
}

/** Invert a 4x4 column-major matrix. Returns null if singular. */
function invertMat4(m) {
    const a00=m[0],a01=m[1],a02=m[2],a03=m[3];
    const a10=m[4],a11=m[5],a12=m[6],a13=m[7];
    const a20=m[8],a21=m[9],a22=m[10],a23=m[11];
    const a30=m[12],a31=m[13],a32=m[14],a33=m[15];
    const b00=a00*a11-a01*a10,b01=a00*a12-a02*a10,b02=a00*a13-a03*a10;
    const b03=a01*a12-a02*a11,b04=a01*a13-a03*a11,b05=a02*a13-a03*a12;
    const b06=a20*a31-a21*a30,b07=a20*a32-a22*a30,b08=a20*a33-a23*a30;
    const b09=a21*a32-a22*a31,b10=a21*a33-a23*a31,b11=a22*a33-a23*a32;
    let det=b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06;
    if (!det) return null;
    det = 1/det;
    return [
        (a11*b11-a12*b10+a13*b09)*det, (a02*b10-a01*b11-a03*b09)*det,
        (a31*b05-a32*b04+a33*b03)*det, (a22*b04-a21*b05-a23*b03)*det,
        (a12*b08-a10*b11-a13*b07)*det, (a00*b11-a02*b08+a03*b07)*det,
        (a32*b02-a30*b05-a33*b01)*det, (a20*b05-a22*b02+a23*b01)*det,
        (a10*b10-a11*b08+a13*b06)*det, (a01*b08-a00*b10-a03*b06)*det,
        (a30*b04-a31*b02+a33*b00)*det, (a21*b02-a20*b04-a23*b00)*det,
        (a11*b07-a10*b09-a12*b06)*det, (a00*b09-a01*b07+a02*b06)*det,
        (a31*b01-a30*b03-a32*b00)*det, (a20*b03-a21*b01+a22*b00)*det,
    ];
}

// --- GLB binary helpers ---

/** Read the JSON chunk from a GLB file. */
function readGlbJsonChunk(filePath) {
    const buf = readFileSync(filePath);
    // GLB header: magic(4) + version(4) + length(4) = 12 bytes
    // Chunk 0: chunkLength(4) + chunkType(4) + chunkData
    const chunk0Len = buf.readUInt32LE(12);
    // chunkType at offset 16, data starts at 20
    const jsonStr = buf.slice(20, 20 + chunk0Len).toString('utf8');
    return JSON.parse(jsonStr);
}

/**
 * Read a GLB file, replace its JSON chunk with newJson, write to outPath.
 * Preserves the binary data chunk exactly.
 */
function rewriteGlbJsonChunk(inPath, outPath, newJson) {
    const inBuf = readFileSync(inPath);

    // Parse original header
    const chunk0Len = inBuf.readUInt32LE(12);
    // Binary chunk starts after JSON chunk header+data. Copy ONLY the BIN
    // payload, not the old BIN chunk header. The previous script copied from
    // `binaryOffset`, which nested the old BIN header inside the new BIN data
    // and produced malformed buffer data in GLTFLoader/three-vrm.
    const binaryChunkOffset = 12 + 8 + chunk0Len;
    let binaryData = Buffer.alloc(0);
    if (binaryChunkOffset + 8 <= inBuf.length) {
        const binLen = inBuf.readUInt32LE(binaryChunkOffset);
        const binType = inBuf.slice(binaryChunkOffset + 4, binaryChunkOffset + 8).toString('ascii');
        if (binType !== 'BIN\0') {
            throw new Error(`Unexpected GLB chunk type "${binType}" in ${inPath}`);
        }
        binaryData = inBuf.slice(binaryChunkOffset + 8, binaryChunkOffset + 8 + binLen);
    }

    // Serialize new JSON, padded to 4-byte alignment with spaces
    let jsonStr = JSON.stringify(newJson);
    while (jsonStr.length % 4 !== 0) jsonStr += ' ';
    const jsonBuf = Buffer.from(jsonStr, 'utf8');

    // Build output
    // Binary chunk needs 4-byte aligned length (fill with 0)
    let binBuf = binaryData;
    if (binBuf.length > 0) {
        const binPad = (4 - (binBuf.length % 4)) % 4;
        if (binPad > 0) binBuf = Buffer.concat([binBuf, Buffer.alloc(binPad, 0)]);
    }

    const totalLen = 12 + 8 + jsonBuf.length + (binBuf.length > 0 ? 8 + binBuf.length : 0);
    const out = Buffer.alloc(totalLen);

    // GLB header
    out.write('glTF', 0, 'ascii');
    out.writeUInt32LE(2, 4);          // version
    out.writeUInt32LE(totalLen, 8);   // total length

    // JSON chunk
    out.writeUInt32LE(jsonBuf.length, 12);
    out.write('JSON', 16, 'ascii');
    jsonBuf.copy(out, 20);

    // Binary chunk (if any)
    if (binBuf.length > 0) {
        const binChunkOffset = 20 + jsonBuf.length;
        out.writeUInt32LE(binBuf.length, binChunkOffset);
        out.write('BIN\0', binChunkOffset + 4, 'ascii');
        binBuf.copy(out, binChunkOffset + 8);
    }

    writeFileSync(outPath, out);
}

// --- Entry point ---
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const outDirIndex = args.indexOf('--out-dir');
const outDir = outDirIndex >= 0 && args[outDirIndex + 1]
    ? path.resolve(args[outDirIndex + 1])
    : path.join(__dirname, '..', '.tmp', 'milady-vrm-bake');
const numericArgs = args.filter((a) => /^\d+$/.test(a));
const indices = numericArgs.length > 0 ? numericArgs.map((n) => parseInt(n, 10)) : [1,2,3,4,5,6,7,8];

(async () => {
    for (const i of indices) await bakeVRMHair(i, { apply, outDir });
    console.log(`\nAll done. ${apply ? 'Applied in-place.' : `Wrote outputs to ${outDir}`}`);
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
