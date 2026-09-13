// ==== core/math.js — 零依赖数学库：标量 / Vec3 / Mat4 / 四元数 / 确定性噪声 ====
// 约定：所有返回向量的函数在提供 out 时写入 out 并返回 out，否则分配新 Float32Array(3)。
// 矩阵为列主序 Float32Array(16)（与 WebGL 一致）。四元数为 (x, y, z, w)。

export const EPS = 1e-6;
export const TAU = Math.PI * 2;
export const HALF_PI = Math.PI * 0.5;

// ---------------------------------------------------------------- Vec3 构造

export function v3(x = 0, y = 0, z = 0) {
  const o = new Float32Array(3);
  o[0] = x; o[1] = y; o[2] = z;
  return o;
}

export function copy3(a, out) {
  out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
  return out;
}

export function set3(out, x, y, z) {
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}

export function clone3(a) {
  const o = new Float32Array(3);
  o[0] = a[0]; o[1] = a[1]; o[2] = a[2];
  return o;
}

export function zero3(out) {
  out[0] = 0; out[1] = 0; out[2] = 0;
  return out;
}

// ---------------------------------------------------------------- Vec3 运算

export function add3(a, b, out) {
  if (!out) out = new Float32Array(3);
  out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2];
  return out;
}

export function sub3(a, b, out) {
  if (!out) out = new Float32Array(3);
  out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2];
  return out;
}

export function mul3(a, b, out) {
  if (!out) out = new Float32Array(3);
  out[0] = a[0] * b[0]; out[1] = a[1] * b[1]; out[2] = a[2] * b[2];
  return out;
}

export function scale3(a, s, out) {
  if (!out) out = new Float32Array(3);
  out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s;
  return out;
}

/** out = a + b * s —— 最常用的融合操作（加速度积分） */
export function addScaled3(a, b, s, out) {
  if (!out) out = new Float32Array(3);
  out[0] = a[0] + b[0] * s; out[1] = a[1] + b[1] * s; out[2] = a[2] + b[2] * s;
  return out;
}

export function neg3(a, out) {
  if (!out) out = new Float32Array(3);
  out[0] = -a[0]; out[1] = -a[1]; out[2] = -a[2];
  return out;
}

export function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(a, b, out) {
  if (!out) out = new Float32Array(3);
  const ax = a[0], ay = a[1], az = a[2];
  const bx = b[0], by = b[1], bz = b[2];
  out[0] = ay * bz - az * by;
  out[1] = az * bx - ax * bz;
  out[2] = ax * by - ay * bx;
  return out;
}

export function len3(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

export function lenSq3(a) {
  return a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
}

/** 水平长度（忽略 Y）——运动系统里判断"速度够不够蹬墙跑"用 */
export function len2XZ(a) {
  return Math.hypot(a[0], a[2]);
}

export function dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function distSq3(a, b) {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

export function dist2XZ(a, b) {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}

export function normalize3(a, out) {
  if (!out) out = new Float32Array(3);
  const l = Math.hypot(a[0], a[1], a[2]);
  if (l < EPS) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
  const inv = 1 / l;
  out[0] = a[0] * inv; out[1] = a[1] * inv; out[2] = a[2] * inv;
  return out;
}

/** 归一化并返回原长度（运动系统高频使用，避免两次开方） */
export function normalizeWithLen(a, out) {
  const l = Math.hypot(a[0], a[1], a[2]);
  if (!out) out = new Float32Array(3);
  if (l < EPS) { out[0] = 0; out[1] = 0; out[2] = 0; return 0; }
  const inv = 1 / l;
  out[0] = a[0] * inv; out[1] = a[1] * inv; out[2] = a[2] * inv;
  return l;
}

export function lerp3(a, b, t, out) {
  if (!out) out = new Float32Array(3);
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

export function min3(a, b, out) {
  if (!out) out = new Float32Array(3);
  out[0] = a[0] < b[0] ? a[0] : b[0];
  out[1] = a[1] < b[1] ? a[1] : b[1];
  out[2] = a[2] < b[2] ? a[2] : b[2];
  return out;
}

export function max3(a, b, out) {
  if (!out) out = new Float32Array(3);
  out[0] = a[0] > b[0] ? a[0] : b[0];
  out[1] = a[1] > b[1] ? a[1] : b[1];
  out[2] = a[2] > b[2] ? a[2] : b[2];
  return out;
}

// ---------------------------------------------------------------- 标量

export function clamp(x, lo, hi) {
  return x < lo ? lo : (x > hi ? hi : x);
}

export function clamp01(x) {
  return x < 0 ? 0 : (x > 1 ? 1 : x);
}

export function clampMag(x, mag) {
  return x < -mag ? -mag : (x > mag ? mag : x);
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0 || EPS));
  return t * t * (3 - 2 * t);
}

export function smootherstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0 || EPS));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** 帧率无关的指数趋近：lambda 越大越快 */
export function damp(a, b, lambda, dt) {
  return lerp(a, b, 1 - Math.exp(-lambda * dt));
}

export function damp3(a, b, lambda, dt, out) {
  const t = 1 - Math.exp(-lambda * dt);
  return lerp3(a, b, t, out);
}

export function moveTowards(cur, target, maxDelta) {
  const d = target - cur;
  if (Math.abs(d) <= maxDelta) return target;
  return cur + Math.sign(d) * maxDelta;
}

export function moveTowards3(a, b, maxDelta, out) {
  if (!out) out = new Float32Array(3);
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const d = Math.hypot(dx, dy, dz);
  if (d <= maxDelta || d < EPS) { out[0] = b[0]; out[1] = b[1]; out[2] = b[2]; return out; }
  const s = maxDelta / d;
  out[0] = a[0] + dx * s; out[1] = a[1] + dy * s; out[2] = a[2] + dz * s;
  return out;
}

export function sign(x) {
  return x < 0 ? -1 : (x > 0 ? 1 : 0);
}

export function approx(a, b, eps = EPS) {
  return Math.abs(a - b) < eps;
}

export function toRad(deg) { return deg * Math.PI / 180; }
export function toDeg(rad) { return rad * 180 / Math.PI; }

/** 归一化到 [-PI, PI) */
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** 走最短弧插值，帧率无关 */
export function angleLerp(a, b, t) {
  return a + wrapAngle(b - a) * t;
}

export function angleDamp(a, b, lambda, dt) {
  return a + wrapAngle(b - a) * (1 - Math.exp(-lambda * dt));
}

/** 把 x 从 [a0,a1] 重映射到 [b0,b1] 并夹紧 */
export function remap(x, a0, a1, b0, b1) {
  const t = clamp01((x - a0) / ((a1 - a0) || EPS));
  return b0 + (b1 - b0) * t;
}

/** 圆锥内均匀取样：返回单位向量。rng 需返回 [0,1) */
export function randomConeDir(forward, halfAngleRad, rng, out) {
  if (!out) out = new Float32Array(3);
  const cosMax = Math.cos(halfAngleRad);
  const cosT = 1 - rng() * (1 - cosMax);
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
  const phi = rng() * TAU;
  // 构造与 forward 正交的基
  const up = Math.abs(forward[1]) > 0.95 ? UPX : UPY;
  const rx = cross3(up, forward, TMP_A);
  normalize3(rx, rx);
  const ry = cross3(forward, rx, TMP_B);
  const ct = cosT, st = sinT, cp = Math.cos(phi), sp = Math.sin(phi);
  out[0] = forward[0] * ct + (rx[0] * cp + ry[0] * sp) * st;
  out[1] = forward[1] * ct + (rx[1] * cp + ry[1] * sp) * st;
  out[2] = forward[2] * ct + (rx[2] * cp + ry[2] * sp) * st;
  return out;
}

const TMP_A = new Float32Array(3);
const TMP_B = new Float32Array(3);
const TMP_D = new Float32Array(3);
const UPX = new Float32Array([1, 0, 0]);
const UPY = new Float32Array([0, 1, 0]);

/** 由 yaw/pitch 构造前方向（yaw=0 时朝 -Z） */
export function dirFromAngles(yaw, pitch, out) {
  if (!out) out = new Float32Array(3);
  const cp = Math.cos(pitch);
  out[0] = -Math.sin(yaw) * cp;
  out[1] = Math.sin(pitch);
  out[2] = -Math.cos(yaw) * cp;
  return out;
}

// ---------------------------------------------------------------- 确定性噪声 / PRNG

/** 整数哈希 -> [0,1)，确定性、无状态 */
export function hash2(x, y) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

export function hash3(x, y, z) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (z | 0) * 2147483647;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

/** 双线性插值的值噪声，返回 [0,1) */
export function valueNoise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
}

/** 分形布朗运动，返回约 [0,1] */
export function fbm2(x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  const oct = Math.max(1, octaves | 0);
  for (let i = 0; i < oct; i++) {
    sum += valueNoise2(x * freq, y * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/** 脊状噪声，用于山脊 / 岩层 */
export function ridged2(x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise2(x * freq, y * freq) * 2 - 1);
    sum += n * n * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/** mulberry32 —— 高质量小体积 PRNG，返回 [0,1) */
export function mulberry32(seed) {
  let a = (seed | 0) >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 从数组按权重取样，weights 与 items 等长 */
export function weightedPick(items, weights, rng) {
  let total = 0;
  for (let i = 0; i < weights.length; i++) total += weights[i];
  if (total <= 0) return items[0];
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

// ---------------------------------------------------------------- Mat4

export function m4() {
  const o = new Float32Array(16);
  o[0] = 1; o[5] = 1; o[10] = 1; o[15] = 1;
  return o;
}

export function m4Identity(out) {
  out.fill(0);
  out[0] = 1; out[5] = 1; out[10] = 1; out[15] = 1;
  return out;
}

export function m4Copy(a, out) {
  out.set(a);
  return out;
}

/** out = a * b（列主序：先应用 b 再应用 a） */
export function m4Mul(a, b, out) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  for (let i = 0; i < 4; i++) {
    const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
    out[i * 4] = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
    out[i * 4 + 1] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
    out[i * 4 + 2] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
    out[i * 4 + 3] = a03 * b0 + a13 * b1 + a23 * b2 + a33 * b3;
  }
  return out;
}

export function m4Perspective(fovyRad, aspect, near, far, out) {
  const f = 1 / Math.tan(fovyRad * 0.5);
  const nf = 1 / (near - far);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) * nf;
  out[11] = -1;
  out[14] = 2 * far * near * nf;
  return out;
}

export function m4Ortho(l, r, b, t, n, f, out) {
  const lr = 1 / (l - r), bt = 1 / (b - t), nf = 1 / (n - f);
  out.fill(0);
  out[0] = -2 * lr;
  out[5] = -2 * bt;
  out[10] = 2 * nf;
  out[12] = (l + r) * lr;
  out[13] = (t + b) * bt;
  out[14] = (f + n) * nf;
  out[15] = 1;
  return out;
}

export function m4LookAt(eye, center, up, out) {
  let z0 = eye[0] - center[0], z1 = eye[1] - center[1], z2 = eye[2] - center[2];
  let l = Math.hypot(z0, z1, z2);
  if (l < EPS) { z0 = 0; z1 = 0; z2 = 1; l = 1; }
  const zi = 1 / l;
  z0 *= zi; z1 *= zi; z2 *= zi;
  let x0 = up[1] * z2 - up[2] * z1;
  let x1 = up[2] * z0 - up[0] * z2;
  let x2 = up[0] * z1 - up[1] * z0;
  l = Math.hypot(x0, x1, x2);
  if (l < EPS) { x0 = 1; x1 = 0; x2 = 0; } else { const xi = 1 / l; x0 *= xi; x1 *= xi; x2 *= xi; }
  const y0 = z1 * x2 - z2 * x1;
  const y1 = z2 * x0 - z0 * x2;
  const y2 = z0 * x1 - z1 * x0;
  out[0] = x0; out[1] = y0; out[2] = z0; out[3] = 0;
  out[4] = x1; out[5] = y1; out[6] = z1; out[7] = 0;
  out[8] = x2; out[9] = y2; out[10] = z2; out[11] = 0;
  out[12] = -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]);
  out[13] = -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]);
  out[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]);
  out[15] = 1;
  return out;
}

/**
 * 视图矩阵：由位置 + 前方向 + 上方向构造（右手，相机朝 -Z）。
 *
 * ⚠️ 三个基向量必须各用一块独立暂存：早先这里把 f 与 u 共用同一个 TMP，
 * 导致计算 u 时覆盖了 f，第三列读到的其实是 u，整个视图矩阵退化成奇异矩阵
 * （透视行变成 [0,y,0,z]），结果是"什么几何都画不出来"。切勿再合并这两块暂存。
 */
export function m4ViewFromDir(eye, forward, up, out) {
  const f = normalize3(forward, TMP_A);
  let r = cross3(f, up, TMP_B);
  if (lenSq3(r) < 1e-10) r = cross3(f, UPX, r);
  normalize3(r, r);
  const u = cross3(r, f, TMP_D);
  out[0] = r[0]; out[1] = u[0]; out[2] = -f[0]; out[3] = 0;
  out[4] = r[1]; out[5] = u[1]; out[6] = -f[1]; out[7] = 0;
  out[8] = r[2]; out[9] = u[2]; out[10] = -f[2]; out[11] = 0;
  out[12] = -(r[0] * eye[0] + r[1] * eye[1] + r[2] * eye[2]);
  out[13] = -(u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]);
  out[14] = (f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2]);
  out[15] = 1;
  return out;
}

export function m4FromTranslation(t, out) {
  m4Identity(out);
  out[12] = t[0]; out[13] = t[1]; out[14] = t[2];
  return out;
}

export function m4FromTranslationScale(t, s, out) {
  const sx = typeof s === 'number' ? s : s[0];
  const sy = typeof s === 'number' ? s : s[1];
  const sz = typeof s === 'number' ? s : s[2];
  out.fill(0);
  out[0] = sx; out[5] = sy; out[10] = sz; out[15] = 1;
  out[12] = t[0]; out[13] = t[1]; out[14] = t[2];
  return out;
}

/** 由四元数 + 平移 + 缩放构造（快速路径，无通用矩阵乘） */
export function m4FromTranslationQuatScale(t, q, s, out) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const sx = typeof s === 'number' ? s : s[0];
  const sy = typeof s === 'number' ? s : s[1];
  const sz = typeof s === 'number' ? s : s[2];
  out[0] = (1 - (yy + zz)) * sx;
  out[1] = (xy + wz) * sx;
  out[2] = (xz - wy) * sx;
  out[3] = 0;
  out[4] = (xy - wz) * sy;
  out[5] = (1 - (xx + zz)) * sy;
  out[6] = (yz + wx) * sy;
  out[7] = 0;
  out[8] = (xz + wy) * sz;
  out[9] = (yz - wx) * sz;
  out[10] = (1 - (xx + yy)) * sz;
  out[11] = 0;
  out[12] = t[0]; out[13] = t[1]; out[14] = t[2]; out[15] = 1;
  return out;
}

/** 由 YXZ 欧拉角（先 yaw 后 pitch 再 roll）构造旋转矩阵，含平移与缩放 */
export function m4Compose(pos, yaw, pitch, roll, scale, out) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const sx = typeof scale === 'number' ? scale : scale[0];
  const sy2 = typeof scale === 'number' ? scale : scale[1];
  const sz = typeof scale === 'number' ? scale : scale[2];
  // R = Ry * Rx * Rz
  const m00 = cy * cr + sy * sp * sr;
  const m01 = cp * sr;
  const m02 = -sy * cr + cy * sp * sr;
  const m10 = -cy * sr + sy * sp * cr;
  const m11 = cp * cr;
  const m12 = sy * sr + cy * sp * cr;
  const m20 = sy * cp;
  const m21 = -sp;
  const m22 = cy * cp;
  out[0] = m00 * sx; out[1] = m01 * sx; out[2] = m02 * sx; out[3] = 0;
  out[4] = m10 * sy2; out[5] = m11 * sy2; out[6] = m12 * sy2; out[7] = 0;
  out[8] = m20 * sz; out[9] = m21 * sz; out[10] = m22 * sz; out[11] = 0;
  out[12] = pos[0]; out[13] = pos[1]; out[14] = pos[2]; out[15] = 1;
  return out;
}

/** 通用的轴对齐缩放的纯旋转-平移矩阵（绕 Y 旋转，常用于道具） */
export function m4FromYaw(pos, yaw, out) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  out[0] = c; out[1] = 0; out[2] = -s; out[3] = 0;
  out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
  out[8] = s; out[9] = 0; out[10] = c; out[11] = 0;
  out[12] = pos[0]; out[13] = pos[1]; out[14] = pos[2]; out[15] = 1;
  return out;
}

export function m4Invert(a, out) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-12) { return m4Identity(out); }
  det = 1 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

export function m4TransformPoint(m, p, out) {
  if (!out) out = new Float32Array(3);
  const x = p[0], y = p[1], z = p[2];
  const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
  out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
  out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
  out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
  return out;
}

export function m4TransformDir(m, p, out) {
  if (!out) out = new Float32Array(3);
  const x = p[0], y = p[1], z = p[2];
  out[0] = m[0] * x + m[4] * y + m[8] * z;
  out[1] = m[1] * x + m[5] * y + m[9] * z;
  out[2] = m[2] * x + m[6] * y + m[10] * z;
  return out;
}

/**
 * 从 viewProj 提取 6 个视锥平面（Gribb-Hartmann），平面为 (a,b,c,d) 且法线朝内。
 * outPlanes 长度 24。
 */
export function m4FrustumPlanes(m, outPlanes) {
  const p = outPlanes;
  // left
  p[0] = m[3] + m[0]; p[1] = m[7] + m[4]; p[2] = m[11] + m[8]; p[3] = m[15] + m[12];
  // right
  p[4] = m[3] - m[0]; p[5] = m[7] - m[4]; p[6] = m[11] - m[8]; p[7] = m[15] - m[12];
  // bottom
  p[8] = m[3] + m[1]; p[9] = m[7] + m[5]; p[10] = m[11] + m[9]; p[11] = m[15] + m[13];
  // top
  p[12] = m[3] - m[1]; p[13] = m[7] - m[5]; p[14] = m[11] - m[9]; p[15] = m[15] - m[13];
  // near
  p[16] = m[3] + m[2]; p[17] = m[7] + m[6]; p[18] = m[11] + m[10]; p[19] = m[15] + m[14];
  // far
  p[20] = m[3] - m[2]; p[21] = m[7] - m[6]; p[22] = m[11] - m[10]; p[23] = m[15] - m[14];
  for (let i = 0; i < 6; i++) {
    const o = i * 4;
    const l = Math.hypot(p[o], p[o + 1], p[o + 2]) || 1;
    const inv = 1 / l;
    p[o] *= inv; p[o + 1] *= inv; p[o + 2] *= inv; p[o + 3] *= inv;
  }
  return outPlanes;
}

// ---------------------------------------------------------------- 四元数

export function quat() {
  const o = new Float32Array(4);
  o[3] = 1;
  return o;
}

export function quatIdentity(out) {
  out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1;
  return out;
}

export function quatFromAxisAngle(axis, angle, out) {
  const h = angle * 0.5;
  const s = Math.sin(h);
  const l = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  out[0] = axis[0] / l * s;
  out[1] = axis[1] / l * s;
  out[2] = axis[2] / l * s;
  out[3] = Math.cos(h);
  return out;
}

/** 顺序 YXZ：yaw 绕 Y，pitch 绕 X，roll 绕 Z（与 FPS 相机直觉一致） */
export function quatFromEuler(pitch, yaw, roll, out) {
  const cy = Math.cos(yaw * 0.5), sy = Math.sin(yaw * 0.5);
  const cp = Math.cos(pitch * 0.5), sp = Math.sin(pitch * 0.5);
  const cr = Math.cos(roll * 0.5), sr = Math.sin(roll * 0.5);
  // q = qy * qx * qz
  out[0] = sy * cp * cr + cy * sp * sr;
  out[1] = cy * sp * cr - sy * cp * sr;
  out[2] = cy * cp * sr - sy * sp * cr;
  out[3] = cy * cp * cr + sy * sp * sr;
  return out;
}

export function quatMul(a, b, out) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

export function quatNormalize(q, out) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  const inv = 1 / l;
  out[0] = q[0] * inv; out[1] = q[1] * inv; out[2] = q[2] * inv; out[3] = q[3] * inv;
  return out;
}

export function quatSlerp(a, b, t, out) {
  let ax = a[0], ay = a[1], az = a[2], aw = a[3];
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  if (cos > 0.9995) {
    out[0] = ax + (bx - ax) * t; out[1] = ay + (by - ay) * t;
    out[2] = az + (bz - az) * t; out[3] = aw + (bw - aw) * t;
    return quatNormalize(out, out);
  }
  const theta = Math.acos(cos);
  const sinTheta = Math.sin(theta);
  const s0 = Math.sin((1 - t) * theta) / sinTheta;
  const s1 = Math.sin(t * theta) / sinTheta;
  out[0] = ax * s0 + bx * s1;
  out[1] = ay * s0 + by * s1;
  out[2] = az * s0 + bz * s1;
  out[3] = aw * s0 + bw * s1;
  return out;
}

export function quatRotate(q, v, out) {
  if (!out) out = new Float32Array(3);
  const x = v[0], y = v[1], z = v[2];
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + (qy * tz - qz * ty);
  out[1] = y + qw * ty + (qz * tx - qx * tz);
  out[2] = z + qw * tz + (qx * ty - qy * tx);
  return out;
}

/** 由前方向 + 上方向构造四元数（用于让实例朝向速度方向） */
export function quatLookRotation(forward, up, out) {
  const f = normalize3(forward, TMP_A);
  let r = cross3(up || UPY, f, TMP_B);
  if (lenSq3(r) < 1e-10) r = cross3(UPX, f, r);
  normalize3(r, r);
  const u = cross3(f, r, TMP_A);
  // 基为 (r, u, -f) 与 quatFromEuler 的列一致，转为矩阵再转四元数
  const m00 = r[0], m01 = u[0], m02 = -f[0];
  const m10 = r[1], m11 = u[1], m12 = -f[1];
  const m20 = r[2], m21 = u[2], m22 = -f[2];
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    out[3] = 0.25 * s;
    out[0] = (m21 - m12) / s;
    out[1] = (m02 - m20) / s;
    out[2] = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    out[3] = (m21 - m12) / s;
    out[0] = 0.25 * s;
    out[1] = (m01 + m10) / s;
    out[2] = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    out[3] = (m02 - m20) / s;
    out[0] = (m01 + m10) / s;
    out[1] = 0.25 * s;
    out[2] = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    out[3] = (m10 - m01) / s;
    out[0] = (m02 + m20) / s;
    out[1] = (m12 + m21) / s;
    out[2] = 0.25 * s;
  }
  return out;
}

// ---------------------------------------------------------------- 视锥测试

export function planeSphereTest(planes, i, c, r) {
  const o = i * 4;
  const d = planes[o] * c[0] + planes[o + 1] * c[1] + planes[o + 2] * c[2] + planes[o + 3];
  return d >= -r;
}

export function frustumSphere(planes, c, r) {
  for (let i = 0; i < 6; i++) {
    if (!planeSphereTest(planes, i, c, r)) return false;
  }
  return true;
}

const TMP_C = new Float32Array(3);

/** 直接以分量做球测试，避免构造临时向量 */
export function frustumSphereAt(planes, x, y, z, r) {
  TMP_C[0] = x; TMP_C[1] = y; TMP_C[2] = z;
  return frustumSphere(planes, TMP_C, r);
}

/** 轴对齐盒的视锥测试（用中心 + 半径近似，足够快且保守） */
export function frustumAABB(planes, min, max, pad = 0) {
  const cx = (min[0] + max[0]) * 0.5;
  const cy = (min[1] + max[1]) * 0.5;
  const cz = (min[2] + max[2]) * 0.5;
  const ex = (max[0] - min[0]) * 0.5 + pad;
  const ey = (max[1] - min[1]) * 0.5 + pad;
  const ez = (max[2] - min[2]) * 0.5 + pad;
  const r = Math.hypot(ex, ey, ez);
  return frustumSphereAt(planes, cx, cy, cz, r);
}

/** 线段是否与视锥球近似相交（粒子/曳光剔除用） */
export function frustumSegment(planes, a, b, pad = 0.5) {
  const mx = (a[0] + b[0]) * 0.5;
  const my = (a[1] + b[1]) * 0.5;
  const mz = (a[2] + b[2]) * 0.5;
  const r = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * 0.5 + pad;
  return frustumSphereAt(planes, mx, my, mz, r);
}
