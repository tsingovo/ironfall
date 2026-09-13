// ==== engine/collision.js — 纯几何碰撞：射线 / 球 / 胶囊 / 扫掠 / 空间哈希 ====
// 全部无状态、不依赖引擎。运动系统的稳定性完全取决于这里的正确性：
//   * 胶囊用"线段 + 半径"表示，胶囊 vs 三角用线段-三角最近点求解，
//     天然覆盖胶囊柱体与两端半球，避免分三段处理带来的接缝问题。
//   * 提供的 resolve 系列是"推出式"求解（给出需要沿法线移动的距离），
//     由调用方迭代应用 —— 这是 Apex 类高速运动不穿模的关键。

import { EPS } from '../core/math.js';

const TMP = new Float32Array(3);

// ---------------------------------------------------------------- 射线

/** 射线 vs AABB（slab 法）。返回 {t, normal} 或 null。射线起点在盒内也能处理。 */
export function rayAABB(origin, dir, min, max) {
  let tmin = -Infinity, tmax = Infinity;
  let axis = -1, sign = 0;

  for (let i = 0; i < 3; i++) {
    const o = origin[i], d = dir[i];
    const lo = min[i], hi = max[i];
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null;
      continue;
    }
    const inv = 1 / d;
    let t1 = (lo - o) * inv;
    let t2 = (hi - o) * inv;
    let s = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = i; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }

  if (tmax < 0) return null;
  let t = tmin;
  let n;
  if (tmin < 0) {
    // 起点在盒内：用出射面作为命中面
    t = tmax;
    n = new Float32Array(3);
    // 重新算出射轴
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const d = dir[i];
      if (Math.abs(d) < 1e-9) continue;
      const tt = ((d > 0 ? min[i] : max[i]) - origin[i]) / d;
      if (tt < best) { best = tt; n[0] = 0; n[1] = 0; n[2] = 0; n[i] = d > 0 ? -1 : 1; }
    }
    return { t: best, normal: n, inside: true };
  }
  n = new Float32Array(3);
  if (axis >= 0) n[axis] = sign;
  return { t, normal: n };
}

/** 射线 vs 三角形（Möller–Trumbore，双面）。返回 {t, u, v} 或 null。 */
export function rayTriangle(origin, dir, a, b, c) {
  const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
  const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
  const px = dir[1] * e2z - dir[2] * e2y;
  const py = dir[2] * e2x - dir[0] * e2z;
  const pz = dir[0] * e2y - dir[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-10) return null;
  const invDet = 1 / det;
  const tx = origin[0] - a[0], ty = origin[1] - a[1], tz = origin[2] - a[2];
  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < 0 || u > 1) return null;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * invDet;
  if (v < 0 || u + v > 1) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  if (t < 1e-7) return null;
  return { t, u, v };
}

/** 射线 vs 球 */
export function raySphere(origin, dir, center, r) {
  const ox = origin[0] - center[0], oy = origin[1] - center[1], oz = origin[2] - center[2];
  const b = ox * dir[0] + oy * dir[1] + oz * dir[2];
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = -b - sq;
  if (t < 0) t = -b + sq;
  if (t < 0) return null;
  const n = new Float32Array(3);
  n[0] = origin[0] + dir[0] * t - center[0];
  n[1] = origin[1] + dir[1] * t - center[1];
  n[2] = origin[2] + dir[2] * t - center[2];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  n[0] /= l; n[1] /= l; n[2] /= l;
  return { t, normal: n };
}

/** 射线 vs 胶囊（线段 p0-p1 + 半径 r）—— 抓钩对敌人用 */
export function rayCapsule(origin, dir, p0, p1, r) {
  // 解 |(o + t d) - closestPointOnSegment(o + t d)| = r，用数值细分求首个根
  const steps = 24;
  const segLen = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]) || 1;
  const maxT = segLen + r * 4;
  let prev = -1;
  const px = new Float32Array(3);
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * maxT;
    const x = origin[0] + dir[0] * t;
    const y = origin[1] + dir[1] * t;
    const z = origin[2] + dir[2] * t;
    TMP[0] = x; TMP[1] = y; TMP[2] = z;
    closestPointSegment(TMP, p0, p1, px);
    const d = Math.hypot(x - px[0], y - px[1], z - px[2]) - r;
    if (d <= 0) {
      if (prev < 0) return { t, normal: new Float32Array([0, 1, 0]) };
      // 二分细化
      let lo = ((i - 1) / steps) * maxT, hi = t;
      for (let k = 0; k < 12; k++) {
        const mid = (lo + hi) * 0.5;
        const mx = origin[0] + dir[0] * mid, my = origin[1] + dir[1] * mid, mz = origin[2] + dir[2] * mid;
        TMP[0] = mx; TMP[1] = my; TMP[2] = mz;
        closestPointSegment(TMP, p0, p1, px);
        if (Math.hypot(mx - px[0], my - px[1], mz - px[2]) - r <= 0) hi = mid; else lo = mid;
      }
      const tHit = hi;
      const hx = origin[0] + dir[0] * tHit, hy = origin[1] + dir[1] * tHit, hz = origin[2] + dir[2] * tHit;
      TMP[0] = hx; TMP[1] = hy; TMP[2] = hz;
      closestPointSegment(TMP, p0, p1, px);
      const n = new Float32Array(3);
      n[0] = hx - px[0]; n[1] = hy - px[1]; n[2] = hz - px[2];
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      n[0] /= l; n[1] /= l; n[2] /= l;
      return { t: tHit, normal: n };
    }
    prev = d;
  }
  return null;
}

// ---------------------------------------------------------------- 最近点

/** 点到线段的最近点，写入 out */
export function closestPointSegment(p, a, b, out) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];
  const ab2 = abx * abx + aby * aby + abz * abz;
  let t = ab2 > EPS ? (apx * abx + apy * aby + apz * abz) / ab2 : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  out[0] = a[0] + abx * t;
  out[1] = a[1] + aby * t;
  out[2] = a[2] + abz * t;
  return out;
}

/** 点到三角形最近点（Ericson, Real-Time Collision Detection 的经典算法） */
export function closestPointOnTriangle(p, a, b, c, out) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
  const apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; return out; }

  const bpx = p[0] - b[0], bpy = p[1] - b[1], bpz = p[2] - b[2];
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { out[0] = b[0]; out[1] = b[1]; out[2] = b[2]; return out; }

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    out[0] = a[0] + abx * v; out[1] = a[1] + aby * v; out[2] = a[2] + abz * v;
    return out;
  }

  const cpx = p[0] - c[0], cpy = p[1] - c[1], cpz = p[2] - c[2];
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; return out; }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    out[0] = a[0] + acx * w; out[1] = a[1] + acy * w; out[2] = a[2] + acz * w;
    return out;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    out[0] = b[0] + (c[0] - b[0]) * w;
    out[1] = b[1] + (c[1] - b[1]) * w;
    out[2] = b[2] + (c[2] - b[2]) * w;
    return out;
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  out[0] = a[0] + abx * v + acx * w;
  out[1] = a[1] + aby * v + acy * w;
  out[2] = a[2] + abz * v + acz * w;
  return out;
}

/** 两条线段的最近点对（含退化处理） */
export function segmentSegmentDistance(p1, q1, p2, q2) {
  const d1x = q1[0] - p1[0], d1y = q1[1] - p1[1], d1z = q1[2] - p1[2];
  const d2x = q2[0] - p2[0], d2y = q2[1] - p2[1], d2z = q2[2] - p2[2];
  const rx = p1[0] - p2[0], ry = p1[1] - p2[1], rz = p1[2] - p2[2];
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s, t;
  if (a <= EPS && e <= EPS) { s = 0; t = 0; }
  else if (a <= EPS) { s = 0; t = clamp01(f / e); }
  else {
    const cc = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) { t = 0; s = clamp01(-cc / a); }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom > EPS ? clamp01((b * f - cc * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-cc / a); }
      else if (t > 1) { t = 1; s = clamp01((b - cc) / a); }
    }
  }
  const c1x = p1[0] + d1x * s, c1y = p1[1] + d1y * s, c1z = p1[2] + d1z * s;
  const c2x = p2[0] + d2x * t, c2y = p2[1] + d2y * t, c2z = p2[2] + d2z * t;
  const dist = Math.hypot(c1x - c2x, c1y - c2y, c1z - c2z);
  return { s, t, dist, c1: new Float32Array([c1x, c1y, c1z]), c2: new Float32Array([c2x, c2y, c2z]) };
}

function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

// ---------------------------------------------------------------- 球/胶囊 vs 三角/盒

const CP = new Float32Array(3);
const TRI_A = new Float32Array(3);
const TRI_B = new Float32Array(3);
const TRI_C = new Float32Array(3);

function triFromArray(tri, off) {
  TRI_A[0] = tri[off]; TRI_A[1] = tri[off + 1]; TRI_A[2] = tri[off + 2];
  TRI_B[0] = tri[off + 3]; TRI_B[1] = tri[off + 4]; TRI_B[2] = tri[off + 5];
  TRI_C[0] = tri[off + 6]; TRI_C[1] = tri[off + 7]; TRI_C[2] = tri[off + 8];
}

const RESULT = {
  point: new Float32Array(3),
  normal: new Float32Array(3),
  depth: 0,
};

function fillResult(px, py, pz, nx, ny, nz, depth) {
  RESULT.point[0] = px; RESULT.point[1] = py; RESULT.point[2] = pz;
  RESULT.normal[0] = nx; RESULT.normal[1] = ny; RESULT.normal[2] = nz;
  RESULT.depth = depth;
  return RESULT;
}

/** 球 vs 三角形。返回共享的结果对象（{point, normal, depth}）或 null。 */
export function sphereTriangle(center, r, a, b, c) {
  closestPointOnTriangle(center, a, b, c, CP);
  const dx = center[0] - CP[0], dy = center[1] - CP[1], dz = center[2] - CP[2];
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 > r * r) return null;
  const d = Math.sqrt(d2);
  if (d < 1e-7) {
    // 球心在三角形平面上：用面法线推出
    const nx0 = (b[0] - a[0]), ny0 = (b[1] - a[1]), nz0 = (b[2] - a[2]);
    const nx1 = (c[0] - a[0]), ny1 = (c[1] - a[1]), nz1 = (c[2] - a[2]);
    let nx = ny0 * nz1 - nz0 * ny1, ny = nz0 * nx1 - nx0 * nz1, nz = nx0 * ny1 - ny0 * nx1;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    return fillResult(CP[0], CP[1], CP[2], nx, ny, nz, r);
  }
  const inv = 1 / d;
  const nx = dx * inv, ny = dy * inv, nz = dz * inv;
  return fillResult(CP[0], CP[1], CP[2], nx, ny, nz, r - d);
}

/** 球 vs AABB。返回共享结果对象或 null。 */
export function sphereAABB(center, r, min, max) {
  const cx = center[0], cy = center[1], cz = center[2];
  const qx = cx < min[0] ? min[0] : (cx > max[0] ? max[0] : cx);
  const qy = cy < min[1] ? min[1] : (cy > max[1] ? max[1] : cy);
  const qz = cz < min[2] ? min[2] : (cz > max[2] ? max[2] : cz);
  const dx = cx - qx, dy = cy - qy, dz = cz - qz;
  const d2 = dx * dx + dy * dy + dz * dz;

  if (d2 > r * r) return null;

  if (d2 > 1e-12) {
    // 球心在盒外：法线由盒上最近点指向球心
    const d = Math.sqrt(d2);
    const inv = 1 / d;
    return fillResult(qx, qy, qz, dx * inv, dy * inv, dz * inv, r - d);
  }

  // 球心在盒内：选最近的四个侧面之一推出（保留 y 轴上下两种可能）
  let bestDist = Infinity;
  let bnx = 0, bny = 1, bnz = 0;
  let bx = cx, by = cy, bz = cz;
  for (let i = 0; i < 3; i++) {
    const c = center[i];
    const dLo = c - min[i];
    const dHi = max[i] - c;
    if (dLo < bestDist) {
      bestDist = dLo;
      bx = cx; by = cy; bz = cz;
      bx = i === 0 ? min[0] : cx;
      by = i === 1 ? min[1] : cy;
      bz = i === 2 ? min[2] : cz;
      bnx = 0; bny = 0; bnz = 0;
      if (i === 0) bnx = -1; else if (i === 1) bny = -1; else bnz = -1;
    }
    if (dHi < bestDist) {
      bestDist = dHi;
      bx = i === 0 ? max[0] : cx;
      by = i === 1 ? max[1] : cy;
      bz = i === 2 ? max[2] : cz;
      bnx = 0; bny = 0; bnz = 0;
      if (i === 0) bnx = 1; else if (i === 1) bny = 1; else bnz = 1;
    }
  }
  return fillResult(bx, by, bz, bnx, bny, bnz, bestDist + r);
}

/**
 * 胶囊（线段 p0-p1 + 半径 r）vs 三角形。
 * 内部对 3 条边做"线段-线段最近点"求解，得到柱体接触；
 * 对两个端点做"点-三角形最近点"求解，得到半球接触。取最小分离量。
 */
export function capsuleTriangle(p0, p1, r, a, b, c) {
  let bestSep = Infinity;
  let bn = TMP;
  let bp = null;
  let found = false;

  const edges = [
    [a, b], [b, c], [c, a],
  ];

  for (let i = 0; i < 3; i++) {
    const e0 = edges[i][0], e1 = edges[i][1];
    const res = segmentSegmentDistance(p0, p1, e0, e1);
    if (res.dist < bestSep) {
      bestSep = res.dist;
      // 法线方向：从三角形上的点指向胶囊轴上的点
      let nx = res.c1[0] - res.c2[0];
      let ny = res.c1[1] - res.c2[1];
      let nz = res.c1[2] - res.c2[2];
      const l = Math.hypot(nx, ny, nz);
      if (l < 1e-7) {
        // 退化：用面法线兜底
        const fn = faceNormal(a, b, c);
        nx = fn[0]; ny = fn[1]; nz = fn[2];
      } else { nx /= l; ny /= l; nz /= l; }
      bn = [nx, ny, nz];
      bp = [res.c2[0], res.c2[1], res.c2[2]];
      found = true;
    }
  }

  // 端点半球
  for (let k = 0; k < 2; k++) {
    const p = k === 0 ? p0 : p1;
    closestPointOnTriangle(p, a, b, c, CP);
    let nx = p[0] - CP[0], ny = p[1] - CP[1], nz = p[2] - CP[2];
    const l = Math.hypot(nx, ny, nz);
    if (l < bestSep) {
      if (l < 1e-7) {
        const fn = faceNormal(a, b, c);
        // 端点落在三角形上：用面法线并按胶囊轴方向决定里外
        const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
        const dot = ax * fn[0] + ay * fn[1] + az * fn[2];
        const s = dot > 0 ? 1 : -1;
        nx = fn[0] * s; ny = fn[1] * s; nz = fn[2] * s;
        bestSep = 0;
      } else {
        nx /= l; ny /= l; nz /= l;
        bestSep = l;
      }
      bn = [nx, ny, nz];
      bp = [CP[0], CP[1], CP[2]];
      found = true;
    }
  }

  if (!found) return null;
  const depth = r - bestSep;
  if (depth <= 0) return null;
  return fillResult(bp[0], bp[1], bp[2], bn[0], bn[1], bn[2], depth);
}

/** 胶囊 vs AABB：取 3 条候选线段（两轴 + 对角线）中分离量最小者 */
export function capsuleAABB(p0, p1, r, min, max) {
  // 用 AABB 的 12 条边做线段-线段，再加两个端点 vs 盒
  let bestSep = Infinity;
  let bnx = 0, bny = 1, bnz = 0;
  let bpx = 0, bpy = 0, bpz = 0;
  let found = false;

  // 端点 vs 盒（覆盖角落/端面接触）
  for (let k = 0; k < 2; k++) {
    const p = k === 0 ? p0 : p1;
    const res = sphereAABB(p, r, min, max);
    if (res) {
      const sep = r - res.depth;
      if (sep < bestSep) {
        bestSep = sep;
        bnx = res.normal[0]; bny = res.normal[1]; bnz = res.normal[2];
        bpx = res.point[0]; bpy = res.point[1]; bpz = res.point[2];
        found = true;
      }
    }
  }

  // 胶囊轴 vs 12 条边
  const X0 = min[0], Y0 = min[1], Z0 = min[2];
  const X1 = max[0], Y1 = max[1], Z1 = max[2];
  const corners = [
    [X0, Y0, Z0], [X1, Y0, Z0], [X1, Y0, Z1], [X0, Y0, Z1],
    [X0, Y1, Z0], [X1, Y1, Z0], [X1, Y1, Z1], [X0, Y1, Z1],
  ];
  const edgeIdx = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  for (let i = 0; i < 12; i++) {
    const e0 = corners[edgeIdx[i][0]], e1 = corners[edgeIdx[i][1]];
    const res = segmentSegmentDistance(p0, p1, e0, e1);
    if (res.dist < bestSep) {
      let nx = res.c1[0] - res.c2[0], ny = res.c1[1] - res.c2[1], nz = res.c1[2] - res.c2[2];
      const l = Math.hypot(nx, ny, nz) || 1;
      bestSep = res.dist;
      bnx = nx / l; bny = ny / l; bnz = nz / l;
      bpx = res.c2[0]; bpy = res.c2[1]; bpz = res.c2[2];
      found = true;
    }
  }

  if (!found) return null;
  const depth = r - bestSep;
  if (depth <= 0) return null;
  return fillResult(bpx, bpy, bpz, bnx, bny, bnz, depth);
}

export function faceNormal(a, b, c) {
  const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
  const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
  let nx = e1y * e2z - e1z * e2y;
  let ny = e1z * e2x - e1x * e2z;
  let nz = e1x * e2y - e1y * e2x;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

// ---------------------------------------------------------------- 扫掠

/**
 * 球体扫掠 vs 三角形集合：返回 {t, point, normal} 或 null。
 * 用"离散推进 + 二分细化"实现，稳定且对高速运动不会穿透（步长上限 = r）。
 */
export function sweepSphereTriangles(center, r, delta, triangles, triCount, filter) {
  const dist = Math.hypot(delta[0], delta[1], delta[2]);
  if (dist < 1e-9) return null;
  const steps = Math.max(1, Math.ceil(dist / Math.max(0.05, r * 0.75)));
  let prevT = 0;
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const cx = center[0] + delta[0] * t;
    const cy = center[1] + delta[1] * t;
    const cz = center[2] + delta[2] * t;
    TMP[0] = cx; TMP[1] = cy; TMP[2] = cz;
    let any = null;
    for (let i = 0; i < triCount; i++) {
      const off = i * 9;
      if (filter && !filter(i)) continue;
      const ax = triangles[off], ay = triangles[off + 1], az = triangles[off + 2];
      const bx = triangles[off + 3], by = triangles[off + 4], bz = triangles[off + 5];
      const cxx = triangles[off + 6], cyy = triangles[off + 7], czz = triangles[off + 8];
      // 粗剔除：球 vs 三角 AABB
      if (cx + r < Math.min(ax, bx, cxx) || cx - r > Math.max(ax, bx, cxx)) continue;
      if (cy + r < Math.min(ay, by, cyy) || cy - r > Math.max(ay, by, cyy)) continue;
      if (cz + r < Math.min(az, bz, czz) || cz - r > Math.max(az, bz, czz)) continue;
      TRI_A[0] = ax; TRI_A[1] = ay; TRI_A[2] = az;
      TRI_B[0] = bx; TRI_B[1] = by; TRI_B[2] = bz;
      TRI_C[0] = cxx; TRI_C[1] = cyy; TRI_C[2] = czz;
      const res = sphereTriangle(TMP, r, TRI_A, TRI_B, TRI_C);
      if (res) { any = { normal: [res.normal[0], res.normal[1], res.normal[2]], point: [res.point[0], res.point[1], res.point[2]] }; break; }
    }
    if (any) {
      // 在 [prevT, t] 内二分
      let lo = prevT, hi = t;
      for (let k = 0; k < 10; k++) {
        const mid = (lo + hi) * 0.5;
        const mx = center[0] + delta[0] * mid;
        const my = center[1] + delta[1] * mid;
        const mz = center[2] + delta[2] * mid;
        TMP[0] = mx; TMP[1] = my; TMP[2] = mz;
        let sub = null;
        for (let i = 0; i < triCount; i++) {
          const off = i * 9;
          if (filter && !filter(i)) continue;
          TRI_A[0] = triangles[off]; TRI_A[1] = triangles[off + 1]; TRI_A[2] = triangles[off + 2];
          TRI_B[0] = triangles[off + 3]; TRI_B[1] = triangles[off + 4]; TRI_B[2] = triangles[off + 5];
          TRI_C[0] = triangles[off + 6]; TRI_C[1] = triangles[off + 7]; TRI_C[2] = triangles[off + 8];
          // 快速 AABB 剔除
          const tminx = Math.min(TRI_A[0], TRI_B[0], TRI_C[0]);
          if (mx + r < tminx) continue;
          const res = sphereTriangle(TMP, r, TRI_A, TRI_B, TRI_C);
          if (res) { sub = res; break; }
        }
        if (sub) hi = mid; else lo = mid;
      }
      const tHit = hi;
      const hx = center[0] + delta[0] * tHit;
      const hy = center[1] + delta[1] * tHit;
      const hz = center[2] + delta[2] * tHit;
      const n = faceNormalOrHit(hx, hy, hz, triangles, triCount, r);
      return { t: tHit, point: new Float32Array([hx, hy, hz]), normal: new Float32Array(n) };
    }
    prevT = t;
  }
  return null;
}

function faceNormalOrHit(x, y, z, triangles, triCount, r) {
  // 找到最近三角形并用它的面法线（比接触法线更适合反弹/滑移，避免沿边抖动）
  let bestD = Infinity;
  let bn = [0, 1, 0];
  TMP[0] = x; TMP[1] = y; TMP[2] = z;
  for (let i = 0; i < triCount; i++) {
    const off = i * 9;
    TRI_A[0] = triangles[off]; TRI_A[1] = triangles[off + 1]; TRI_A[2] = triangles[off + 2];
    TRI_B[0] = triangles[off + 3]; TRI_B[1] = triangles[off + 4]; TRI_B[2] = triangles[off + 5];
    TRI_C[0] = triangles[off + 6]; TRI_C[1] = triangles[off + 7]; TRI_C[2] = triangles[off + 8];
    closestPointOnTriangle(TMP, TRI_A, TRI_B, TRI_C, CP);
    const d = Math.hypot(x - CP[0], y - CP[1], z - CP[2]);
    if (d < bestD) {
      bestD = d;
      const fn = faceNormal(TRI_A, TRI_B, TRI_C);
      // 保证法线朝向球心一侧
      const toC = (x - CP[0]) * fn[0] + (y - CP[1]) * fn[1] + (z - CP[2]) * fn[2];
      const s = toC >= 0 ? 1 : -1;
      bn = [fn[0] * s, fn[1] * s, fn[2] * s];
    }
  }
  return bn;
}

/** 球体扫掠 vs AABB 集合。返回 {t, point, normal} 或 null。 */
export function sweepSphereBoxes(center, r, delta, boxes) {
  const dist = Math.hypot(delta[0], delta[1], delta[2]);
  if (dist < 1e-9) return null;
  const steps = Math.max(1, Math.ceil(dist / Math.max(0.05, r * 0.75)));
  let prevT = 0;
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const cx = center[0] + delta[0] * t;
    const cy = center[1] + delta[1] * t;
    const cz = center[2] + delta[2] * t;
    TMP[0] = cx; TMP[1] = cy; TMP[2] = cz;
    let any = false;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (sphereAABB(TMP, r, b.min, b.max)) { any = true; break; }
    }
    if (any) {
      let lo = prevT, hi = t;
      for (let k = 0; k < 10; k++) {
        const mid = (lo + hi) * 0.5;
        TMP[0] = center[0] + delta[0] * mid;
        TMP[1] = center[1] + delta[1] * mid;
        TMP[2] = center[2] + delta[2] * mid;
        let sub = false;
        for (let i = 0; i < boxes.length; i++) {
          const b = boxes[i];
          if (sphereAABB(TMP, r, b.min, b.max)) { sub = true; break; }
        }
        if (sub) hi = mid; else lo = mid;
      }
      const tHit = hi;
      TMP[0] = center[0] + delta[0] * tHit;
      TMP[1] = center[1] + delta[1] * tHit;
      TMP[2] = center[2] + delta[2] * tHit;
      let best = null, bestDepth = -Infinity;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        const res = sphereAABB(TMP, r, b.min, b.max);
        if (res && res.depth > bestDepth) { bestDepth = res.depth; best = b; }
      }
      const n = best ? [RESULT.normal[0], RESULT.normal[1], RESULT.normal[2]] : [0, 1, 0];
      return { t: tHit, point: new Float32Array([TMP[0], TMP[1], TMP[2]]), normal: new Float32Array(n) };
    }
    prevT = t;
  }
  return null;
}

// ---------------------------------------------------------------- 工具

export function pointInAABB(p, min, max) {
  return p[0] >= min[0] && p[0] <= max[0]
    && p[1] >= min[1] && p[1] <= max[1]
    && p[2] >= min[2] && p[2] <= max[2];
}

export function aabbOverlapSphere(min, max, c, r) {
  const qx = c[0] < min[0] ? min[0] : (c[0] > max[0] ? max[0] : c[0]);
  const qy = c[1] < min[1] ? min[1] : (c[1] > max[1] ? max[1] : c[1]);
  const qz = c[2] < min[2] ? min[2] : (c[2] > max[2] ? max[2] : c[2]);
  const dx = c[0] - qx, dy = c[1] - qy, dz = c[2] - qz;
  return dx * dx + dy * dy + dz * dz <= r * r;
}

export function aabbOverlap(minA, maxA, minB, maxB) {
  return minA[0] <= maxB[0] && maxA[0] >= minB[0]
    && minA[1] <= maxB[1] && maxA[1] >= minB[1]
    && minA[2] <= maxB[2] && maxA[2] >= minB[2];
}

/** 把 AABB 展开写入 out6 = [minx,miny,minz,maxx,maxy,maxz] */
export function expandAABB(out6, min, max, pad) {
  out6[0] = min[0] - pad; out6[1] = min[1] - pad; out6[2] = min[2] - pad;
  out6[3] = max[0] + pad; out6[4] = max[1] + pad; out6[5] = max[2] + pad;
  return out6;
}

/** 胶囊包围盒：pos 为底部中点 */
export function capsuleBounds(pos, height, radius, out6) {
  out6[0] = pos[0] - radius;
  out6[1] = pos[1] - radius;
  out6[2] = pos[2] - radius;
  out6[3] = pos[0] + radius;
  out6[4] = pos[1] + height + radius;
  out6[5] = pos[2] + radius;
  return out6;
}

// ---------------------------------------------------------------- 空间哈希

/** 整数 key 编码。
 * 用乘法而非位或：cell 坐标各自占 22 bit（±2,097,152，按 8m 格子即 ±16,777 km），
 * 位或会在任意一位重叠时产生键冲突。
 */
function cellKey(ix, iy) {
  return (ix + 2097152) * 4194304 + (iy + 2097152);
}

/**
 * 2D (XZ) 空间哈希，用于地形三角形与静态盒体的宽相。
 * query* 系列复用调用方传入的数组（零 GC）。
 */
export class SpatialHash {
  constructor(cellSize = 8) {
    this.cellSize = cellSize;
    this.inv = 1 / cellSize;
    /** @type {Map<number, Int32Array|Array<number>>} */
    this.cells = new Map();
    this._scratch = [];
  }

  clear() {
    this.cells.clear();
  }

  /** 插入一个 AABB（XZ 投影），id 为任意整数索引 */
  insertBox(id, minX, minZ, maxX, maxZ) {
    const cs = this.cellSize;
    const x0 = Math.floor(minX * this.inv);
    const x1 = Math.floor(maxX * this.inv);
    const z0 = Math.floor(minZ * this.inv);
    const z1 = Math.floor(maxZ * this.inv);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const k = cellKey(x, z);
        let arr = this.cells.get(k);
        if (!arr) { arr = []; this.cells.set(k, arr); }
        arr.push(id);
      }
    }
  }

  /** 插入三角形（由三点算 XZ 包围盒；y 范围另存用于快速竖直剔除） */
  insertTri(id, ax, ay, az, bx, by, bz, cx, cy, cz) {
    const minX = Math.min(ax, bx, cx), maxX = Math.max(ax, bx, cx);
    const minZ = Math.min(az, bz, cz), maxZ = Math.max(az, bz, cz);
    this.insertBox(id, minX, minZ, maxX, maxZ);
  }

  /** 查询 XZ 矩形内所有 id，写入 out（会被清空后填充，返回 out） */
  queryBox(minX, minZ, maxX, maxZ, out) {
    out.length = 0;
    const seen = this._seen || (this._seen = new Set());
    seen.clear();
    const x0 = Math.floor(minX * this.inv);
    const x1 = Math.floor(maxX * this.inv);
    const z0 = Math.floor(minZ * this.inv);
    const z1 = Math.floor(maxZ * this.inv);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const arr = this.cells.get(cellKey(x, z));
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          const id = arr[i];
          if (!seen.has(id)) { seen.add(id); out.push(id); }
        }
      }
    }
    return out;
  }

  querySphere(cx, cz, r, out) {
    return this.queryBox(cx - r, cz - r, cx + r, cz + r, out);
  }

  /** 沿射线的 XZ 路径查询（DDA），带上 maxDist */
  queryRay(ox, oz, dx, dz, maxDist, out) {
    out.length = 0;
    const seen = this._seen2 || (this._seen2 = new Set());
    seen.clear();
    const len = Math.hypot(dx, dz);
    if (len < 1e-9) return this.querySphere(ox, oz, this.cellSize, out);
    const inv = 1 / len;
    const ndx = dx * inv, ndz = dz * inv;
    const steps = Math.ceil(maxDist / (this.cellSize * 0.5)) + 1;
    let px = ox, pz = oz;
    for (let s = 0; s <= steps; s++) {
      const t = Math.min(maxDist, s * this.cellSize * 0.5);
      px = ox + ndx * t;
      pz = oz + ndz * t;
      const cx = Math.floor(px * this.inv);
      const cz = Math.floor(pz * this.inv);
      // 3x3 邻域，避免掠射漏格
      for (let z = cz - 1; z <= cz + 1; z++) {
        for (let x = cx - 1; x <= cx + 1; x++) {
          const arr = this.cells.get(cellKey(x, z));
          if (!arr) continue;
          for (let i = 0; i < arr.length; i++) {
            const id = arr[i];
            if (!seen.has(id)) { seen.add(id); out.push(id); }
          }
        }
      }
      if (t >= maxDist) break;
    }
    return out;
  }

  stats() {
    let entries = 0;
    for (const arr of this.cells.values()) entries += arr.length;
    return { cells: this.cells.size, entries };
  }
}

export default {
  rayAABB, rayTriangle, raySphere, rayCapsule,
  closestPointSegment, closestPointOnTriangle, segmentSegmentDistance,
  sphereTriangle, sphereAABB, capsuleTriangle, capsuleAABB, faceNormal,
  sweepSphereTriangles, sweepSphereBoxes,
  pointInAABB, aabbOverlapSphere, aabbOverlap, expandAABB, capsuleBounds,
  SpatialHash,
};
