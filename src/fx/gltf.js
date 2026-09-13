// ==== fx/gltf.js — 零依赖最小 GLTF 2.0 / GLB 解析器（仅视觉几何，无动画/蒙皮/PBR）【自包含，不 import 任何模块】 ====

// 设计意图：美术资源通道必须与运行时解耦。解析只在加载期发生一次，产出即用的
// Float32Array/Uint32Array，之后渲染路径零分配。所有失败都必须带可 grep 的错误码前缀，
// 便于在控制台与自动化测试里精确定位损坏的模型文件。

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** GLB 容器魔数：小端读作 0x46546C67 === 'glTF'。 */
const GLB_MAGIC = 0x46546c67;
/** 本加载器只接受 GLB 版本 2。 */
const GLB_VERSION = 2;
/** chunk type: 'JSON' */
const CHUNK_JSON = 0x4e4f534a;
/** chunk type: 'BIN\0' */
const CHUNK_BIN = 0x004e4942;

/** accessor.componentType -> { array ctor, bytes, normalized 上限 } */
const COMPONENT_TYPES = {
  5120: { name: 'BYTE', bytes: 1, array: Int8Array, max: 127 },
  5121: { name: 'UNSIGNED_BYTE', bytes: 1, array: Uint8Array, max: 255 },
  5122: { name: 'SHORT', bytes: 2, array: Int16Array, max: 32767 },
  5123: { name: 'UNSIGNED_SHORT', bytes: 2, array: Uint16Array, max: 65535 },
  5125: { name: 'UNSIGNED_INT', bytes: 4, array: Uint32Array, max: 4294967295 },
  5126: { name: 'FLOAT', bytes: 4, array: Float32Array, max: 1 },
};

/** accessor.type -> 分量个数 */
const TYPE_COMPONENTS = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/**
 * 所有失败都走这里。绝不抛无标签的错误。
 * @param {string} code GLTF_ERR_* 前缀
 * @param {string} msg 人类可读细节
 */
function fail(code, msg) {
  throw new Error(code + ': ' + msg);
}

// ---------------------------------------------------------------------------
// 矩阵工具（列主序 Float32Array(16)，与 WebGL 一致；本文件不依赖 core/math.js）
// ---------------------------------------------------------------------------

/** out = a * b（先施加 b，再施加 a） */
function m4Mul(a, b, out) {
  const o = out || new Float32Array(16);
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  for (let i = 0; i < 4; i++) {
    const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
    o[i * 4] = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
    o[i * 4 + 1] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
    o[i * 4 + 2] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
    o[i * 4 + 3] = a03 * b0 + a13 * b1 + a23 * b2 + a33 * b3;
  }
  return o;
}

/** 由 TRS 合成局部矩阵（T * R * S），四元数顺序 (x,y,z,w) */
function m4FromTRS(t, q, s, out) {
  const o = out || new Float32Array(16);
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const sx = s[0], sy = s[1], sz = s[2];
  o[0] = (1 - (yy + zz)) * sx;
  o[1] = (xy + wz) * sx;
  o[2] = (xz - wy) * sx;
  o[3] = 0;
  o[4] = (xy - wz) * sy;
  o[5] = (1 - (xx + zz)) * sy;
  o[6] = (yz + wx) * sy;
  o[7] = 0;
  o[8] = (xz + wy) * sz;
  o[9] = (yz - wx) * sz;
  o[10] = (1 - (xx + yy)) * sz;
  o[11] = 0;
  o[12] = t[0];
  o[13] = t[1];
  o[14] = t[2];
  o[15] = 1;
  return o;
}

// ---------------------------------------------------------------------------
// 字节工具
// ---------------------------------------------------------------------------

function bytesToText(bytes) {
  if (typeof TextDecoder === 'function') {
    return new TextDecoder('utf-8').decode(bytes);
  }
  // 兜底（老环境）：逐字节 UTF-8 解码，避免依赖 Buffer
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  try {
    return decodeURIComponent(escape(s));
  } catch (e) {
    return s;
  }
}

/**
 * 编码 base64 文本 -> Uint8Array。不依赖 atob / Buffer。
 * @param {string} b64
 * @returns {Uint8Array}
 */
function base64ToBytes(b64) {
  const table = base64ToBytes.table || (base64ToBytes.table = buildBase64Table());
  const out = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < b64.length; i++) {
    const v = table[b64.charCodeAt(i)];
    if (v < 0) continue; // 跳过 '='、换行、空白
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function buildBase64Table() {
  const t = new Int16Array(256).fill(-1);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < chars.length; i++) t[chars.charCodeAt(i)] = i;
  return t;
}

/** 解析 data: URI -> Uint8Array（支持 ;base64 与百分号编码两种形式） */
function dataUriToBytes(uri) {
  const comma = uri.indexOf(',');
  if (comma < 0) fail('GLTF_ERR_BUFFER', 'malformed data URI (no comma)');
  const meta = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  if (/;base64/i.test(meta)) {
    try {
      return base64ToBytes(payload);
    } catch (e) {
      fail('GLTF_ERR_BUFFER', 'base64 decode failed: ' + e.message);
    }
  }
  try {
    return new Uint8Array(Buffer.from(decodeURIComponent(payload), 'binary'));
  } catch (e) {
    fail('GLTF_ERR_BUFFER', 'percent-encoded data URI decode failed: ' + e.message);
  }
  return null;
}

/** 相对路径拼接（baseUrl 可为 ''/undefined） */
function joinUrl(baseUrl, uri) {
  if (!baseUrl) return uri;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(uri) || uri.startsWith('//')) return uri;
  if (uri.startsWith('/')) return uri;
  const cut = baseUrl.lastIndexOf('/');
  return cut < 0 ? uri : baseUrl.slice(0, cut + 1) + uri;
}

/** 从宿主环境同步读取外部资源；浏览器/无 fs 环境返回 null，由调用方抛 GLTF_ERR_BUFFER。 */
function readExternalSync(url) {
  try {
    // 动态解析，避免无 fs 的浏览器环境在静态分析阶段报错
    const req = typeof require === 'function' ? require : null;
    if (req) {
      const fs = req('fs');
      return new Uint8Array(fs.readFileSync(url));
    }
  } catch (e) {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// GLB 容器
// ---------------------------------------------------------------------------

/**
 * 拆解 GLB 二进制容器。
 * @returns {{ json: object, bin: Uint8Array|null }}
 */
function parseGLB(buffer) {
  if (!(buffer instanceof ArrayBuffer) && !ArrayBuffer.isView(buffer)) {
    fail('GLTF_ERR_MAGIC', 'expected ArrayBuffer, got ' + typeof buffer);
  }
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < 12) {
    fail('GLTF_ERR_MAGIC', 'file too small for GLB header (' + bytes.byteLength + ' bytes)');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength >= 4) {
    // 手工比对，保证 GLTF_ERR_MAGIC 在任何损坏头部上都先于其它错误触发
    const m0 = bytes[0], m1 = bytes[1], m2 = bytes[2], m3 = bytes[3];
    if (m0 !== 0x67 || m1 !== 0x6c || m2 !== 0x54 || m3 !== 0x46) {
      fail(
        'GLTF_ERR_MAGIC',
        'not a GLB container: magic=' +
          JSON.stringify(String.fromCharCode(m0, m1, m2, m3)) +
          ' expected "glTF"'
      );
    }
  }
  const version = view.getUint32(4, true);
  if (version !== GLB_VERSION) {
    fail('GLTF_ERR_VERSION', 'unsupported GLB container version ' + version + ' (expected 2)');
  }
  const total = view.getUint32(8, true);
  if (total > bytes.byteLength) {
    fail(
      'GLTF_ERR_CHUNK',
      'GLB declared length ' + total + ' exceeds actual byteLength ' + bytes.byteLength
    );
  }
  const end = Math.min(total, bytes.byteLength);
  let json = null;
  let bin = null;
  let off = 12;
  let index = 0;
  while (off + 8 <= end) {
    const chunkLen = view.getUint32(off, true);
    const chunkType = view.getUint32(off + 4, true);
    const dataStart = off + 8;
    if (dataStart + chunkLen > end) {
      fail(
        'GLTF_ERR_CHUNK',
        'chunk #' + index + ' (len=' + chunkLen + ') overruns container at offset ' + off
      );
    }
    const chunk = bytes.subarray(dataStart, dataStart + chunkLen);
    if (chunkType === CHUNK_JSON) {
      if (json) fail('GLTF_ERR_CHUNK', 'duplicate JSON chunk');
      json = JSON.parse(bytesToText(chunk));
    } else if (chunkType === CHUNK_BIN) {
      if (bin) fail('GLTF_ERR_CHUNK', 'duplicate BIN chunk');
      bin = chunk;
    }
    // 未知 chunk 按规范忽略
    off = dataStart + chunkLen;
    index++;
  }
  if (!json) fail('GLTF_ERR_CHUNK', 'GLB contains no JSON chunk');
  return { json, bin };
}

// ---------------------------------------------------------------------------
// 资源解析（buffer / bufferView / accessor）
// ---------------------------------------------------------------------------

/**
 * 取 buffers[i] 的字节。GLB 内嵌 BIN 优先，其次 data URI，最后外部文件。
 * @param {object} json
 * @param {number} i
 * @param {{bin: Uint8Array|null, baseUrl: string, buffers: (Uint8Array|null)[]}} ctx
 */
function getBufferBytes(json, i, ctx) {
  if (ctx.buffers[i]) return ctx.buffers[i];
  const list = json.buffers;
  if (!Array.isArray(list)) fail('GLTF_ERR_BUFFER', 'gltf has no "buffers" array');
  const def = list[i];
  if (!def) fail('GLTF_ERR_BUFFER', 'buffer index ' + i + ' out of range (' + list.length + ')');
  let bytes = null;
  if (typeof def.uri === 'string' && def.uri.length > 0) {
    if (def.uri.startsWith('data:')) {
      bytes = dataUriToBytes(def.uri);
    } else {
      const url = joinUrl(ctx.baseUrl, def.uri);
      bytes = readExternalSync(decodeURIComponent(url));
      if (!bytes) {
        fail(
          'GLTF_ERR_BUFFER',
          'buffer ' + i + ' references external uri "' + def.uri + '" which cannot be read here; ' +
            'pass the bytes in via opts.buffers or use parseGLTF on the .glb'
        );
      }
    }
  } else if (ctx.bin && i === 0) {
    // GLB 规范：无 uri 的 buffer 0 即 BIN chunk
    bytes = ctx.bin;
  } else {
    fail('GLTF_ERR_BUFFER', 'buffer ' + i + ' has no uri and no matching BIN chunk');
  }
  if (def.byteLength != null && bytes.byteLength < def.byteLength) {
    fail(
      'GLTF_ERR_BUFFER',
      'buffer ' + i + ' shorter than declared (' + bytes.byteLength + ' < ' + def.byteLength + ')'
    );
  }
  ctx.buffers[i] = bytes;
  return bytes;
}

/** 取 bufferView 的原始字节区间。 */
function getBufferViewSlice(json, index, ctx) {
  const views = json.bufferViews;
  if (!Array.isArray(views)) fail('GLTF_ERR_ACCESSOR', 'gltf has no "bufferViews" array');
  const bv = views[index];
  if (!bv) {
    fail('GLTF_ERR_ACCESSOR', 'bufferView index ' + index + ' out of range (' + views.length + ')');
  }
  const bytes = getBufferBytes(json, bv.buffer | 0, ctx);
  const byteOffset = bv.byteOffset | 0;
  const byteLength = bv.byteLength | 0;
  if (byteOffset < 0 || byteLength < 0 || byteOffset + byteLength > bytes.byteLength) {
    fail(
      'GLTF_ERR_ACCESSOR',
      'bufferView ' + index + ' [' + byteOffset + ', +' + byteLength + ') exceeds buffer bounds (' +
        bytes.byteLength + ')'
    );
  }
  return { bytes, byteOffset, byteLength, byteStride: bv.byteStride | 0 };
}

/**
 * 读取 accessor 为「扁平化 + 已解交错」的数值副本。
 * 输出分量顺序固定为 (x,y,z,w)，与 glTF 规范一致。
 * @param {object} json
 * @param {number} index
 * @param {object} ctx
 * @param {number} [forceComponents] 期望分量数（用于校验 VEC3 等）
 * @returns {{ data: Float32Array, count: number, components: number, normalized: boolean, componentType: number }}
 */
function readAccessor(json, index, ctx, forceComponents) {
  const list = json.accessors;
  if (!Array.isArray(list)) fail('GLTF_ERR_ACCESSOR', 'gltf has no "accessors" array');
  const acc = list[index];
  if (!acc) {
    fail('GLTF_ERR_ACCESSOR', 'accessor index ' + index + ' out of range (' + list.length + ')');
  }
  const ct = COMPONENT_TYPES[acc.componentType];
  if (!ct) {
    fail('GLTF_ERR_ACCESSOR', 'accessor ' + index + ' has unknown componentType ' + acc.componentType);
  }
  const components = TYPE_COMPONENTS[acc.type];
  if (!components) {
    fail('GLTF_ERR_ACCESSOR', 'accessor ' + index + ' has unknown type "' + acc.type + '"');
  }
  if (forceComponents && components !== forceComponents) {
    fail(
      'GLTF_ERR_ACCESSOR',
      'accessor ' + index + ' is ' + acc.type + ' (' + components + ' comps), expected ' + forceComponents
    );
  }
  const count = acc.count | 0;
  if (!(count >= 0)) fail('GLTF_ERR_ACCESSOR', 'accessor ' + index + ' has invalid count ' + acc.count);
  if (acc.sparse) {
    ctx.warnings.push(
      'GLTF_ERR_ACCESSOR: sparse override on accessor ' + index + ' ignored (using base bufferView)'
    );
  }
  const out = new Float32Array(count * components);
  if (acc.bufferView == null) {
    // 规范允许：无 bufferView 表示全 0（随后由 sparse 填补）。我们忽略 sparse，故全 0。
    return { data: out, count, components, normalized: !!acc.normalized, componentType: acc.componentType };
  }
  const bvIndex = acc.bufferView | 0;
  const { bytes, byteOffset, byteStride } = getBufferViewSlice(json, bvIndex, ctx);
  const elemSize = ct.bytes * components;
  const stride = byteStride > 0 ? byteStride : elemSize;
  if (stride < elemSize) {
    fail(
      'GLTF_ERR_ACCESSOR',
      'accessor ' + index + ' byteStride ' + stride + ' smaller than element size ' + elemSize
    );
  }
  const accessorOffset = (acc.byteOffset | 0);
  const base = byteOffset + accessorOffset;
  const lastByte = base + (count > 0 ? (count - 1) * stride + elemSize : 0);
  if (lastByte > byteOffset + (bytes.byteLength - byteOffset)) {
    fail(
      'GLTF_ERR_ACCESSOR',
      'accessor ' + index + ' (count=' + count + ', stride=' + stride + ') reads past bufferView end'
    );
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const normalized = !!acc.normalized;
  const maxVal = ct.max;
  const isUnsigned = acc.componentType === 5121 || acc.componentType === 5123 || acc.componentType === 5125;
  for (let e = 0; e < count; e++) {
    const elemBase = base + e * stride;
    const outBase = e * components;
    for (let c = 0; c < components; c++) {
      const o = elemBase + c * ct.bytes;
      let v;
      switch (acc.componentType) {
        case 5120: v = dv.getInt8(o); break;
        case 5121: v = dv.getUint8(o); break;
        case 5122: v = dv.getInt16(o, true); break;
        case 5123: v = dv.getUint16(o, true); break;
        case 5125: v = dv.getUint32(o, true); break;
        case 5126: v = dv.getFloat32(o, true); break;
        default: fail('GLTF_ERR_ACCESSOR', 'unhandled componentType ' + acc.componentType);
      }
      if (normalized) {
        // 归一化整数 -> 浮点：无符号 [0,1]，有符号 [-1,1]
        v = isUnsigned ? v / maxVal : Math.max(v / maxVal, -1);
      }
      out[outBase + c] = v;
    }
  }
  return { data: out, count, components, normalized, componentType: acc.componentType };
}

// ---------------------------------------------------------------------------
// 材质
// ---------------------------------------------------------------------------

function readMaterials(json, ctx) {
  const src = Array.isArray(json.materials) ? json.materials : [];
  const out = [];
  let textured = false;
  for (let i = 0; i < src.length; i++) {
    const m = src[i] || {};
    const pbr = m.pbrMetallicRoughness || {};
    const baseColorFactor = vec4OrDefault(pbr.baseColorFactor, [1, 1, 1, 1]);
    const emissiveFactor = vec3OrDefault(m.emissiveFactor, [0, 0, 0]);
    const hasBaseColorTex = !!(pbr.baseColorTexture || m.emissiveTexture || m.normalTexture ||
      m.metallicRoughnessTexture || m.occlusionTexture);
    if (hasBaseColorTex) textured = true;
    if (Array.isArray(json.images) && json.images.length > 0) textured = true;
    out.push({
      index: i,
      name: typeof m.name === 'string' ? m.name : 'material_' + i,
      baseColorFactor,
      emissiveFactor,
      alphaMode: typeof m.alphaMode === 'string' ? m.alphaMode : 'OPAQUE',
      doubleSided: !!m.doubleSided,
      hasTexture: hasBaseColorTex,
    });
  }
  // 记录图像/纹理总量，供 describeGLTF 汇报
  ctx.textureCount = (Array.isArray(json.textures) ? json.textures.length : 0);
  ctx.imageCount = (Array.isArray(json.images) ? json.images.length : 0);
  ctx.materialsTextured = textured;
  return out;
}

function vec4OrDefault(v, d) {
  if (!Array.isArray(v)) return [d[0], d[1], d[2], d[3]];
  return [
    finiteOr(v[0], d[0]),
    finiteOr(v[1], d[1]),
    finiteOr(v[2], d[2]),
    finiteOr(v[3], d[3]),
  ];
}

function vec3OrDefault(v, d) {
  if (!Array.isArray(v)) return [d[0], d[1], d[2]];
  return [finiteOr(v[0], d[0]), finiteOr(v[1], d[1]), finiteOr(v[2], d[2])];
}

function finiteOr(x, d) {
  return typeof x === 'number' && Number.isFinite(x) ? x : d;
}

// ---------------------------------------------------------------------------
// 几何：法线展开 / 缺失合成
// ---------------------------------------------------------------------------

/**
 * 当 NORMAL 缺失时，按索引列表把顶点展开成独立三角形并写入面法线。
 * 展开同时复制颜色/UV，保证属性长度一致。
 */
function expandWithFlatNormals(pos, count, colors, uvs, indices) {
  const triCount = (indices.length / 3) | 0;
  const outCount = triCount * 3;
  const oPos = new Float32Array(outCount * 3);
  const oNor = new Float32Array(outCount * 3);
  const oCol = colors ? new Float32Array(outCount * 3) : null;
  const oUv = uvs ? new Float32Array(outCount * 2) : null;
  const oIdx = new Uint32Array(outCount);
  for (let t = 0; t < triCount; t++) {
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];
    if (i0 >= count || i1 >= count || i2 >= count) {
      fail('GLTF_ERR_ACCESSOR', 'index out of range in primitive triangle ' + t + ' (count=' + count + ')');
    }
    const ax = pos[i0 * 3], ay = pos[i0 * 3 + 1], az = pos[i0 * 3 + 2];
    const bx = pos[i1 * 3], by = pos[i1 * 3 + 1], bz = pos[i1 * 3 + 2];
    const cx = pos[i2 * 3], cy = pos[i2 * 3 + 1], cz = pos[i2 * 3 + 2];
    // 面法线 = normalize(cross(b-a, c-a))；退化三角形回退 +Y 以保持有限值
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-12) {
      nx /= len; ny /= len; nz /= len;
    } else {
      nx = 0; ny = 1; nz = 0;
    }
    const tri = [i0, i1, i2];
    for (let k = 0; k < 3; k++) {
      const src = tri[k];
      const dst = t * 3 + k;
      oPos[dst * 3] = pos[src * 3];
      oPos[dst * 3 + 1] = pos[src * 3 + 1];
      oPos[dst * 3 + 2] = pos[src * 3 + 2];
      oNor[dst * 3] = nx;
      oNor[dst * 3 + 1] = ny;
      oNor[dst * 3 + 2] = nz;
      if (oCol) {
        oCol[dst * 3] = colors[src * 3];
        oCol[dst * 3 + 1] = colors[src * 3 + 1];
        oCol[dst * 3 + 2] = colors[src * 3 + 2];
      }
      if (oUv) {
        oUv[dst * 2] = uvs[src * 2];
        oUv[dst * 2 + 1] = uvs[src * 2 + 1];
      }
      oIdx[dst] = dst;
    }
  }
  return { positions: oPos, normals: oNor, colors: oCol, uvs: oUv, indices: oIdx };
}

// ---------------------------------------------------------------------------
// 图元 / 网格
// ---------------------------------------------------------------------------

function parsePrimitive(json, prim, primIndex, ctx) {
  if (!prim || typeof prim !== 'object') {
    fail('GLTF_ERR_ACCESSOR', 'primitive ' + primIndex + ' is not an object');
  }
  if (prim.extensions && prim.extensions.KHR_draco_mesh_compression) {
    fail('GLTF_ERR_UNSUPPORTED', 'primitive ' + primIndex + ' uses KHR_draco_mesh_compression');
  }
  const mode = prim.mode == null ? 4 : prim.mode | 0;
  if (mode !== 4) {
    fail('GLTF_ERR_UNSUPPORTED', 'primitive ' + primIndex + ' mode=' + mode + ' (only TRIANGLES=4)');
  }
  const attrs = prim.attributes;
  if (!attrs || typeof attrs !== 'object') {
    fail('GLTF_ERR_ACCESSOR', 'primitive ' + primIndex + ' has no attributes');
  }
  if (attrs.POSITION == null) {
    fail('GLTF_ERR_ACCESSOR', 'primitive ' + primIndex + ' has no POSITION attribute');
  }
  const posAcc = readAccessor(json, attrs.POSITION | 0, ctx, 3);
  const count = posAcc.count;
  const positions = posAcc.data;

  // --- 索引 ---
  let indices;
  let indexed = false;
  if (prim.indices != null) {
    const ia = readAccessor(json, prim.indices | 0, ctx, 1);
    indexed = true;
    indices = new Uint32Array(ia.count);
    let maxIdx = -1;
    for (let i = 0; i < ia.count; i++) {
      const v = ia.data[i];
      if (!(v >= 0) || v !== Math.floor(v)) {
        fail('GLTF_ERR_ACCESSOR', 'non-integer index ' + v + ' at ' + i + ' in accessor ' + prim.indices);
      }
      indices[i] = v;
      if (v > maxIdx) maxIdx = v;
    }
    if (maxIdx >= count) {
      fail(
        'GLTF_ERR_ACCESSOR',
        'index accessor ' + prim.indices + ' references vertex ' + maxIdx + ' but POSITION has ' + count
      );
    }
    if (indices.length % 3 !== 0) {
      fail('GLTF_ERR_ACCESSOR', 'index count ' + indices.length + ' is not a multiple of 3');
    }
  } else {
    // 无索引：按 0..n-1 合成
    indices = new Uint32Array(count);
    for (let i = 0; i < count; i++) indices[i] = i;
    if (count % 3 !== 0) {
      fail('GLTF_ERR_ACCESSOR', 'non-indexed POSITION count ' + count + ' is not a multiple of 3');
    }
  }

  // --- 法线 ---
  let normals = null;
  if (attrs.NORMAL != null) {
    const na = readAccessor(json, attrs.NORMAL | 0, ctx, 3);
    if (na.count !== count) {
      fail('GLTF_ERR_ACCESSOR', 'NORMAL count ' + na.count + ' != POSITION count ' + count);
    }
    normals = na.data;
  }

  // --- 材质 ---
  let material = null;
  if (prim.material != null) {
    material = ctx.materials[prim.material | 0] || null;
    if (!material) {
      fail('GLTF_ERR_ACCESSOR', 'primitive ' + primIndex + ' references unknown material ' + prim.material);
    }
  }

  // --- 顶点色：COLOR_0 优先；否则用材质的 baseColorFactor / emissiveFactor 作为染色 ---
  let vcolors = null;
  if (attrs.COLOR_0 != null) {
    const ca = readAccessor(json, attrs.COLOR_0 | 0, ctx, null);
    if (ca.count !== count) {
      fail('GLTF_ERR_ACCESSOR', 'COLOR_0 count ' + ca.count + ' != POSITION count ' + count);
    }
    const comps = ca.components;
    vcolors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const s = i * comps;
      vcolors[i * 3] = ca.data[s];
      vcolors[i * 3 + 1] = comps > 1 ? ca.data[s + 1] : ca.data[s];
      vcolors[i * 3 + 2] = comps > 2 ? ca.data[s + 2] : ca.data[s];
    }
  } else if (material) {
    // 颜色 = baseColorFactor 的 RGB 与 emissiveFactor 逐分量取大（自发光体在暗场里要看得见）
    const bc = material.baseColorFactor;
    const em = material.emissiveFactor;
    vcolors = new Float32Array(count * 3);
    const r = Math.min(1, Math.max(bc[0], em[0]));
    const g = Math.min(1, Math.max(bc[1], em[1]));
    const bch = Math.min(1, Math.max(bc[2], em[2]));
    for (let i = 0; i < count; i++) {
      vcolors[i * 3] = r;
      vcolors[i * 3 + 1] = g;
      vcolors[i * 3 + 2] = bch;
    }
  }

  // --- UV ---
  let uvs = null;
  if (attrs.TEXCOORD_0 != null) {
    const ua = readAccessor(json, attrs.TEXCOORD_0 | 0, ctx, 2);
    if (ua.count !== count) {
      fail('GLTF_ERR_ACCESSOR', 'TEXCOORD_0 count ' + ua.count + ' != POSITION count ' + count);
    }
    uvs = ua.data;
  }

  // --- 缺失法线 => 展开并合成平面法线（低多边形工业风格正好需要平面着色）---
  let computed = false;
  if (!normals) {
    computed = true;
    if (!indexed) {
      // 已是独立三角形拓扑，直接逐面写平面法线
      const triCount = (count / 3) | 0;
      normals = new Float32Array(count * 3);
      for (let t = 0; t < triCount; t++) {
        const a = t * 3, b = t * 3 + 1, c = t * 3 + 2;
        let nx = (positions[b * 3 + 1] - positions[a * 3 + 1]) * (positions[c * 3 + 2] - positions[a * 3 + 2]) -
          (positions[b * 3 + 2] - positions[a * 3 + 2]) * (positions[c * 3 + 1] - positions[a * 3 + 1]);
        let ny = (positions[b * 3 + 2] - positions[a * 3 + 2]) * (positions[c * 3] - positions[a * 3]) -
          (positions[b * 3] - positions[a * 3]) * (positions[c * 3 + 2] - positions[a * 3 + 2]);
        let nz = (positions[b * 3] - positions[a * 3]) * (positions[c * 3 + 1] - positions[a * 3 + 1]) -
          (positions[b * 3 + 1] - positions[a * 3 + 1]) * (positions[c * 3] - positions[a * 3]);
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len > 1e-12) { nx /= len; ny /= len; nz /= len; } else { nx = 0; ny = 1; nz = 0; }
        for (let k = 0; k < 3; k++) {
          normals[(t * 3 + k) * 3] = nx;
          normals[(t * 3 + k) * 3 + 1] = ny;
          normals[(t * 3 + k) * 3 + 2] = nz;
        }
      }
    } else {
      const ex = expandWithFlatNormals(positions, count, vcolors, uvs, indices);
      return {
        positions: ex.positions,
        normals: ex.normals,
        colors: ex.colors,
        uvs: ex.uvs,
        indices: ex.indices,
        material,
        vertexCount: ex.positions.length / 3,
        triangleCount: ex.indices.length / 3,
        computedNormals: true,
      };
    }
  }

  return {
    positions,
    normals,
    colors: vcolors,
    uvs,
    indices,
    material,
    vertexCount: count,
    triangleCount: indices.length / 3,
    computedNormals: computed,
  };
}

function parseMeshes(json, ctx) {
  const src = Array.isArray(json.meshes) ? json.meshes : [];
  const out = [];
  for (let mi = 0; mi < src.length; mi++) {
    const m = src[mi] || {};
    const prims = [];
    const list = Array.isArray(m.primitives) ? m.primitives : [];
    for (let pi = 0; pi < list.length; pi++) {
      prims.push(parsePrimitive(json, list[pi], pi, ctx));
    }
    out.push({
      index: mi,
      name: typeof m.name === 'string' ? m.name : 'mesh_' + mi,
      prims,
      weights: Array.isArray(m.weights) ? m.weights.slice() : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 节点
// ---------------------------------------------------------------------------

function nodeLocalMatrix(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) {
    const m = new Float32Array(16);
    for (let i = 0; i < 16; i++) m[i] = finiteOr(node.matrix[i], i % 5 === 0 ? 1 : 0);
    return m;
  }
  const t = vec3OrDefault(node.translation, [0, 0, 0]);
  const q = vec4OrDefault(node.rotation, [0, 0, 0, 1]);
  const s = vec3OrDefault(node.scale, [1, 1, 1]);
  return m4FromTRS(t, q, s, null);
}

function parseNodes(json, meshCount, nodeCount) {
  const src = Array.isArray(json.nodes) ? json.nodes : [];
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const n = src[i] || {};
    const children = Array.isArray(n.children) ? n.children.map((c) => c | 0) : [];
    for (const c of children) {
      if (c < 0 || c >= (src.length || nodeCount)) {
        fail('GLTF_ERR_UNSUPPORTED', 'node ' + i + ' child index ' + c + ' out of range');
      }
    }
    let mesh = null;
    if (n.mesh != null) {
      mesh = n.mesh | 0;
      if (mesh < 0 || mesh >= meshCount) {
        fail('GLTF_ERR_UNSUPPORTED', 'node ' + i + ' references unknown mesh ' + n.mesh);
      }
    } else if (n.extensions && n.extensions.KHR_lights_punctual) {
      // 灯光扩展不参与几何，静默忽略
    }
    out.push({
      index: i,
      name: typeof n.name === 'string' ? n.name : 'node_' + i,
      mesh,
      matrix: nodeLocalMatrix(n),
      children,
    });
  }
  return out;
}

/** 场景根节点列表；无 scenes 时按「未被引用的节点」推断根。 */
function sceneRoots(json, nodes) {
  const scenes = Array.isArray(json.scenes) ? json.scenes : [];
  const sceneIndex = json.scene == null ? 0 : json.scene | 0;
  if (scenes.length > 0) {
    const sc = scenes[sceneIndex] || scenes[0];
    if (sc && Array.isArray(sc.nodes) && sc.nodes.length > 0) return sc.nodes.map((n) => n | 0);
  }
  const referenced = new Set();
  for (const n of nodes) for (const c of n.children) referenced.add(c);
  const roots = [];
  for (const n of nodes) if (!referenced.has(n.index)) roots.push(n.index);
  return roots;
}

// ---------------------------------------------------------------------------
// 条目
// ---------------------------------------------------------------------------

/**
 * 解析 GLTF/GLB 字节流为运行时文档。纯函数：不发起网络请求。
 * @param {ArrayBuffer|Uint8Array} arrayBuffer
 * @param {string} [baseUrl] 外部 buffer 的相对基准（例如 'public/models/'），可省略
 * @param {{buffers?: (Uint8Array|null)[]}} [opts] 预置 buffer 字节（浏览器里由调用方 fetch 后注入）
 * @returns {object} GLTFDocument
 */
export function parseGLTF(arrayBuffer, baseUrl, opts) {
  if (arrayBuffer == null) fail('GLTF_ERR_BUFFER', 'parseGLTF called with null/undefined data');
  const isGlb = looksLikeGLB(arrayBuffer);
  const ctx = {
    bin: null,
    baseUrl: typeof baseUrl === 'string' ? baseUrl : '',
    buffers: [],
    warnings: [],
    textureCount: 0,
    imageCount: 0,
    materialsTextured: false,
  };
  if (opts && Array.isArray(opts.buffers)) {
    for (let i = 0; i < opts.buffers.length; i++) ctx.buffers[i] = opts.buffers[i] || null;
  }

  let json;
  if (isGlb) {
    const glb = parseGLB(arrayBuffer);
    json = glb.json;
    ctx.bin = glb.bin;
  } else {
    const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    const text = bytesToText(bytes);
    try {
      json = JSON.parse(text);
    } catch (e) {
      // 既不是 GLB 也不是合法 JSON —— 归为容器/魔数问题（最常见的调用错误）
      fail('GLTF_ERR_MAGIC', 'input is neither a GLB container nor valid glTF JSON: ' + e.message);
    }
  }

  if (!json || typeof json !== 'object') fail('GLTF_ERR_MAGIC', 'glTF root is not an object');
  if (!json.asset || typeof json.asset !== 'object') {
    fail('GLTF_ERR_VERSION', 'glTF root has no "asset" block');
  }
  const ver = json.asset.version;
  if (typeof ver !== 'string' || ver.charAt(0) !== '2') {
    fail('GLTF_ERR_VERSION', 'unsupported asset.version ' + JSON.stringify(ver) + ' (expected "2.x")');
  }

  const materials = readMaterials(json, ctx);
  ctx.materials = materials;
  const meshes = parseMeshes(json, ctx);
  const nodes = parseNodes(json, meshes.length, json.nodes ? json.nodes.length : 0);
  const scenesSrc = Array.isArray(json.scenes) ? json.scenes : [];
  const scenes = scenesSrc.map((s, i) => ({
    index: i,
    name: s && typeof s.name === 'string' ? s.name : 'scene_' + i,
    nodes: s && Array.isArray(s.nodes) ? s.nodes.map((n) => n | 0) : [],
  }));
  const roots = sceneRoots(json, nodes);

  const doc = {
    meshes,
    nodes,
    scenes,
    scene: json.scene == null ? 0 : json.scene | 0,
    roots,
    materials,
    json,
    warnings: ctx.warnings,
    textures: ctx.textureCount,
    images: ctx.imageCount,
    textured: ctx.materialsTextured || ctx.textureCount > 0 || ctx.imageCount > 0,
  };
  return doc;
}

/** 快速判定头部是否为 GLB 魔数。 */
function looksLikeGLB(buffer) {
  let bytes;
  if (buffer instanceof Uint8Array) bytes = buffer;
  else if (ArrayBuffer.isView(buffer)) bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  else if (buffer instanceof ArrayBuffer) bytes = new Uint8Array(buffer);
  else return false;
  return bytes.byteLength >= 4 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46;
}

/**
 * 从 URL 加载并解析 GLTF/GLB。浏览器用 fetch，Node 用 fs。
 * @param {string} url
 * @returns {Promise<object>} GLTFDocument
 */
export async function loadGLTF(url) {
  if (typeof url !== 'string' || url.length === 0) {
    fail('GLTF_ERR_BUFFER', 'loadGLTF requires a non-empty url');
  }
  let buffer = null;
  if (typeof fetch === 'function') {
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      fail('GLTF_ERR_BUFFER', 'network error fetching "' + url + '": ' + e.message);
    }
    if (!res || !res.ok) {
      fail('GLTF_ERR_BUFFER', 'HTTP ' + (res ? res.status : '?') + ' fetching "' + url + '"');
    }
    buffer = await res.arrayBuffer();
  } else {
    const bytes = readExternalSync(url);
    if (!bytes) fail('GLTF_ERR_BUFFER', 'cannot read "' + url + '" (no fetch and no fs)');
    buffer = bytes;
  }
  return parseGLTF(buffer, url);
}

/**
 * 展平场景层级为 (meshIndex, worldMatrix) 列表，供 `world.importVisual` 批量实例化。
 * 无场景时把每个含 mesh 的节点当作根。
 * @param {object} doc
 * @returns {Array<{ meshIndex:number, matrix:Float32Array(16), nodeIndex:number, name:string }>}
 */
export function gltfInstanceModels(doc) {
  if (!doc || !Array.isArray(doc.nodes)) {
    fail('GLTF_ERR_UNSUPPORTED', 'gltfInstanceModels expects a parsed GLTFDocument');
  }
  const out = [];
  const nodes = doc.nodes;
  const roots = Array.isArray(doc.roots) && doc.roots.length > 0
    ? doc.roots
    : nodes.filter((n) => n.mesh != null).map((n) => n.index);
  const visiting = new Set();
  const stack = [];
  for (let i = roots.length - 1; i >= 0; i--) {
    stack.push({ index: roots[i], parent: null });
  }
  // 显式栈遍历：避免深链递归爆栈，同时检测环
  const worldCache = new Map();
  while (stack.length > 0) {
    const item = stack.pop();
    const n = nodes[item.index];
    if (!n) continue;
    if (visiting.has(item.index)) {
      fail('GLTF_ERR_UNSUPPORTED', 'node hierarchy contains a cycle at node ' + item.index);
    }
    const parentWorld = item.parent == null ? null : worldCache.get(item.parent) || null;
    const world = parentWorld ? m4Mul(parentWorld, n.matrix, null) : copyMat(n.matrix);
    worldCache.set(item.index, world);
    if (n.mesh != null) {
      out.push({
        meshIndex: n.mesh,
        matrix: world,
        nodeIndex: n.index,
        name: n.name,
      });
    }
    if (n.children.length > 0) {
      visiting.add(item.index);
      for (let c = n.children.length - 1; c >= 0; c--) {
        stack.push({ index: n.children[c], parent: item.index });
      }
    }
  }
  return out;
}

function copyMat(m) {
  const o = new Float32Array(16);
  for (let i = 0; i < 16; i++) o[i] = m[i];
  return o;
}

/**
 * 统计信息，用于日志/资产检查。
 * @param {object} doc
 * @returns {{meshes:number, triangles:number, nodes:number, vertices:number, materials:number, textured:boolean, prims:number, warnings:string[]}}
 */
export function describeGLTF(doc) {
  if (!doc || !Array.isArray(doc.meshes)) {
    fail('GLTF_ERR_UNSUPPORTED', 'describeGLTF expects a parsed GLTFDocument');
  }
  let triangles = 0;
  let vertices = 0;
  let prims = 0;
  for (const m of doc.meshes) {
    for (const p of m.prims) {
      prims++;
      triangles += p.triangleCount;
      vertices += p.vertexCount;
    }
  }
  return {
    meshes: doc.meshes.length,
    triangles,
    nodes: Array.isArray(doc.nodes) ? doc.nodes.length : 0,
    vertices,
    prims,
    materials: Array.isArray(doc.materials) ? doc.materials.length : 0,
    textured: !!doc.textured,
    warnings: Array.isArray(doc.warnings) ? doc.warnings.slice() : [],
  };
}
