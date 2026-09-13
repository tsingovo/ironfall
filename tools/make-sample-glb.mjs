// ==== tools/make-sample-glb.mjs — 生成示例 GLB 与导入清单 ====
// 目的：验证"外部模型导入通道"端到端可用（GLB 解析 → 渲染 → 可选碰撞盒）。
// 生成的模型是一个工业储罐（圆柱）+ 底座（方盒）的低模占位资源。
// 用法: node tools/make-sample-glb.mjs

import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

// ---------------------------------------------------------------- 网格生成

function cylinder(r, h, segs, yOffset) {
  const positions = [];
  const normals = [];
  const indices = [];
  const hh = h / 2;
  // 侧面
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const cx = Math.cos(a), sz = Math.sin(a);
    positions.push(cx * r, yOffset - hh, sz * r);
    normals.push(cx, 0, sz);
    positions.push(cx * r, yOffset + hh, sz * r);
    normals.push(cx, 0, sz);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
    indices.push(a, c, d, a, d, b);
  }
  // 顶盖
  const topCenter = positions.length / 3;
  positions.push(0, yOffset + hh, 0);
  normals.push(0, 1, 0);
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    positions.push(Math.cos(a) * r, yOffset + hh, Math.sin(a) * r);
    normals.push(0, 1, 0);
  }
  for (let i = 0; i < segs; i++) {
    indices.push(topCenter, topCenter + 1 + i, topCenter + 2 + i);
  }
  // 底盖
  const botCenter = positions.length / 3;
  positions.push(0, yOffset - hh, 0);
  normals.push(0, -1, 0);
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    positions.push(Math.cos(a) * r, yOffset - hh, Math.sin(a) * r);
    normals.push(0, -1, 0);
  }
  for (let i = 0; i < segs; i++) {
    indices.push(botCenter, botCenter + 2 + i, botCenter + 1 + i);
  }
  return { positions, normals, indices };
}

function box(w, h, d, yOffset) {
  const x = w / 2, y = h / 2, z = d / 2;
  const faces = [
    { n: [0, 0, 1], v: [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]] },
    { n: [0, 0, -1], v: [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]] },
    { n: [1, 0, 0], v: [[x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z]] },
    { n: [-1, 0, 0], v: [[-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z]] },
    { n: [0, 1, 0], v: [[-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z]] },
    { n: [0, -1, 0], v: [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]] },
  ];
  const positions = [];
  const normals = [];
  const indices = [];
  for (const f of faces) {
    const base = positions.length / 3;
    for (const v of f.v) {
      positions.push(v[0], v[1] + yOffset, v[2]);
      normals.push(f.n[0], f.n[1], f.n[2]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, normals, indices };
}

// ---------------------------------------------------------------- GLB 打包

function pad4(n) { return (4 - (n % 4)) % 4; }

/**
 * 把若干图元打包成一个 GLB。
 * 所有图元共用同一个 buffer，但各自有独立 accessor（演示 byteOffset 用法）。
 */
function buildGLB(prims, materialColor) {
  const chunks = [];
  const accessors = [];
  const bufferViews = [];
  const gltfPrims = [];
  let byteOffset = 0;

  for (const p of prims) {
    const posArr = new Float32Array(p.positions);
    const nrmArr = new Float32Array(p.normals);
    const idxArr = new Uint32Array(p.indices);

    const posBytes = posArr.byteLength;
    const nrmBytes = nrmArr.byteLength;
    const idxBytes = idxArr.byteLength;

    // POSITION
    const posView = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: posBytes, target: 34962 });
    accessors.push({
      bufferView: posView, componentType: 5126, count: posArr.length / 3, type: 'VEC3',
      min: minOf(posArr, 3), max: maxOf(posArr, 3),
    });
    const posAccessor = accessors.length - 1;
    chunks.push(Buffer.from(posArr.buffer, posArr.byteOffset, posBytes));
    byteOffset += posBytes + pad4(byteOffset + posBytes);

    // NORMAL
    const nrmView = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: nrmBytes, target: 34962 });
    accessors.push({ bufferView: nrmView, componentType: 5126, count: nrmArr.length / 3, type: 'VEC3' });
    const nrmAccessor = accessors.length - 1;
    chunks.push(Buffer.from(nrmArr.buffer, nrmArr.byteOffset, nrmBytes));
    byteOffset += nrmBytes + pad4(byteOffset + nrmBytes);

    // indices (UNSIGNED_INT)
    const idxView = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: idxBytes, target: 34963 });
    accessors.push({ bufferView: idxView, componentType: 5125, count: idxArr.length, type: 'SCALAR' });
    const idxAccessor = accessors.length - 1;
    chunks.push(Buffer.from(idxArr.buffer, idxArr.byteOffset, idxBytes));
    byteOffset += idxBytes + pad4(byteOffset + idxBytes);

    gltfPrims.push({ attributes: { POSITION: posAccessor, NORMAL: nrmAccessor }, indices: idxAccessor, material: 0 });
  }

  const bin = Buffer.concat(chunks);
  const gltf = {
    asset: { version: '2.0', generator: 'IRONFALL sample generator' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'sample_structure', mesh: 0 }],
    meshes: [{ name: 'sample', primitives: gltfPrims }],
    materials: [{
      name: 'industrial_plate',
      pbrMetallicRoughness: {
        baseColorFactor: materialColor,
        metallicFactor: 0.85,
        roughnessFactor: 0.55,
      },
    }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }],
  };

  const jsonStr = JSON.stringify(gltf);
  const jsonBuf = Buffer.from(jsonStr, 'utf8');
  const jsonPad = Buffer.alloc(pad4(jsonBuf.length), 0x20);
  const jsonChunk = Buffer.concat([jsonBuf, jsonPad]);
  const binPad = Buffer.alloc(pad4(bin.length), 0);
  const binChunk = Buffer.concat([bin, binPad]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546C67, 0);   // 'glTF'
  header.writeUInt32LE(2, 4);            // version
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4E4F534A, 4); // 'JSON'

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  binHeader.writeUInt32LE(0x004E4942, 4);  // 'BIN\0'

  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);
}

function minOf(arr, stride) {
  const out = new Array(stride).fill(Infinity);
  for (let i = 0; i < arr.length; i += stride) {
    for (let k = 0; k < stride; k++) out[k] = Math.min(out[k], arr[i + k]);
  }
  return out;
}
function maxOf(arr, stride) {
  const out = new Array(stride).fill(-Infinity);
  for (let i = 0; i < arr.length; i += stride) {
    for (let k = 0; k < stride; k++) out[k] = Math.max(out[k], arr[i + k]);
  }
  return out;
}

// ---------------------------------------------------------------- 主流程

const tank = cylinder(1.6, 5.0, 16, 2.5);
const base = box(4.4, 0.9, 4.4, 0.45);
const glb = buildGLB([tank, base], [0.34, 0.37, 0.40, 1.0]);

const outDir = resolve(ROOT, 'public/models');
await mkdir(outDir, { recursive: true });
const glbPath = resolve(outDir, 'tank_cluster.glb');
await writeFile(glbPath, glb);

const manifest = {
  $comment: '外部模型导入清单。把 .glb 放到 public/models/ 并在此登记即可在场景中显示。',
  version: 1,
  visuals: [
    {
      id: 'tank_cluster',
      file: 'tank_cluster.glb',
      category: 'structure',
      $note: 'collision.mode: none=纯装饰 / box=用模型包围盒生成碰撞 / aabbPerNode=每个网格节点一个盒',
      collision: { mode: 'box' },
      placements: [
        { pos: [-18, 0, -18], yaw: 0.4, scale: 1.0 },
        { pos: [18, 0, -22], yaw: -0.9, scale: 1.15 },
        { pos: [-22, 0, 20], yaw: 2.1, scale: 0.9 },
      ],
    },
  ],
  replace: {
    $comment: '把某个程序化道具替换成高模：键为程序化 ID，值为文件名。',
  },
};

await writeFile(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

process.stdout.write(`已生成 ${glbPath} (${glb.length} 字节)\n`);
process.stdout.write(`已生成 ${resolve(outDir, 'manifest.json')}\n`);
process.stdout.write(`三角形数: ${(tank.indices.length + base.indices.length) / 3}\n`);
