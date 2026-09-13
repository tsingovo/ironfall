// ==== engine/geometry.js — 程序化低模网格生成（单位形状 + 组合工具） ====
// 产出统一结构 MeshData = { positions, normals, colors, uvs, indices }
// 约定：CCW 为正面；法线为面法线（平直着色）；uv 供世界空间三平面细节使用（可为 null）。
//
// 设计：静态世界与实例化渲染共用少量"单位形状"（cube / cylinder / sphere / cone / wedge），
// 由实例矩阵负责缩放与朝向 —— 这样敌人、道具、粒子都能走同一批 draw call。

/** 创建空的 MeshData 累加器 */
export function createMeshData() {
  return {
    positions: [],
    normals: [],
    colors: [],
    uvs: [],
    indices: [],
    _vc: 0,
  };
}

/** 把累加器收尾为可提交给引擎的定型结构 */
export function finalizeMeshData(md, { includeColors = false, includeUvs = true } = {}) {
  const count = md.positions.length / 3;
  return {
    positions: new Float32Array(md.positions),
    normals: new Float32Array(md.normals),
    colors: includeColors && md.colors.length === count * 3 ? new Float32Array(md.colors) : null,
    uvs: includeUvs && md.uvs.length === count * 2 ? new Float32Array(md.uvs) : null,
    indices: count > 65535 ? new Uint32Array(md.indices) : new Uint16Array(md.indices),
  };
}

function pushVert(md, x, y, z, nx, ny, nz, u, v, r, g, b) {
  md.positions.push(x, y, z);
  md.normals.push(nx, ny, nz);
  if (u !== undefined) md.uvs.push(u, v);
  if (r !== undefined) md.colors.push(r, g, b);
  return md._vc++;
}

function pushTri(md, a, b, c) {
  md.indices.push(a, b, c);
}

function pushQuad(md, a, b, c, d) {
  pushTri(md, a, b, c);
  pushTri(md, a, c, d);
}

// ---------------------------------------------------------------- 单位形状

/**
 * 单位立方体：中心在原点，尺寸 1x1x1（-0.5..0.5）。
 * 每个面独立 4 顶点，保证硬边法线。
 */
export function unitCube() {
  const md = createMeshData();
  const h = 0.5;
  // 面表：法线, 四个角（CCW）
  const faces = [
    { n: [0, 0, 1], p: [[-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]] },     // +Z
    { n: [0, 0, -1], p: [[h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h]] }, // -Z
    { n: [1, 0, 0], p: [[h, -h, h], [h, -h, -h], [h, h, -h], [h, h, h]] },      // +X
    { n: [-1, 0, 0], p: [[-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h]] }, // -X
    { n: [0, 1, 0], p: [[-h, h, h], [h, h, h], [h, h, -h], [-h, h, -h]] },      // +Y
    { n: [0, -1, 0], p: [[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]] }, // -Y
  ];
  for (const f of faces) {
    const base = md._vc;
    // uv 按面局部坐标，尺度 1（世界空间三平面细节会覆盖）
    const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (let i = 0; i < 4; i++) {
      pushVert(md, f.p[i][0], f.p[i][1], f.p[i][2], f.n[0], f.n[1], f.n[2], uvs[i][0], uvs[i][1]);
    }
    pushQuad(md, base, base + 1, base + 2, base + 3);
  }
  return rawFinalize(md);
}

/** 内部：把累加器收尾为定型结构（顶点色由 colorizeMeshData 补） */
function rawFinalize(md) {
  return {
    positions: new Float32Array(md.positions),
    normals: new Float32Array(md.normals),
    colors: null,
    uvs: md.uvs.length ? new Float32Array(md.uvs) : null,
    indices: md._vc > 65535 ? new Uint32Array(md.indices) : new Uint16Array(md.indices),
  };
}

/**
 * 单位圆柱：轴为 +Y，高 1（-0.5..0.5），半径 0.5（顶/底可分别指定比例）。
 * segments 为侧面分段数。
 */
export function unitCylinder(segments = 16, capTop = true, capBottom = true, rTop = 0.5, rBottom = 0.5) {
  const md = createMeshData();
  const h = 0.5;
  const n = Math.max(3, segments | 0);
  // 侧面
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);
    // 侧面用平滑法线（斜度正确）
    const slope = (rBottom - rTop);
    let nx0 = c0, nz0 = s0, ny0 = slope;
    let nx1 = c1, nz1 = s1, ny1 = slope;
    const l0 = Math.hypot(nx0, ny0, nz0) || 1;
    const l1 = Math.hypot(nx1, ny1, nz1) || 1;
    nx0 /= l0; ny0 /= l0; nz0 /= l0;
    nx1 /= l1; ny1 /= l1; nz1 /= l1;
    const u0 = i / n, u1 = (i + 1) / n;
    const base = md._vc;
    pushVert(md, c0 * rBottom, -h, s0 * rBottom, nx0, ny0, nz0, u0, 0);
    pushVert(md, c1 * rBottom, -h, s1 * rBottom, nx1, ny1, nz1, u1, 0);
    pushVert(md, c1 * rTop, h, s1 * rTop, nx1, ny1, nz1, u1, 1);
    pushVert(md, c0 * rTop, h, s0 * rTop, nx0, ny0, nz0, u0, 1);
    // theta 正向在 XZ 平面从 +X 转向 +Z；原顺序朝圆柱内部，开启背面剔除后
    // 整个圆柱会像“透明模型”。反转为朝外的 CCW。
    pushQuad(md, base, base + 3, base + 2, base + 1);
  }
  // 顶盖
  if (capTop && rTop > 1e-5) {
    const center = pushVert(md, 0, h, 0, 0, 1, 0, 0.5, 0.5);
    const ring = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      ring.push(pushVert(md, Math.cos(a) * rTop, h, Math.sin(a) * rTop, 0, 1, 0,
        0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5));
    }
    for (let i = 0; i < n; i++) pushTri(md, center, ring[i + 1], ring[i]);
  }
  // 底盖
  if (capBottom && rBottom > 1e-5) {
    const center = pushVert(md, 0, -h, 0, 0, -1, 0, 0.5, 0.5);
    const ring = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      ring.push(pushVert(md, Math.cos(a) * rBottom, -h, Math.sin(a) * rBottom, 0, -1, 0,
        0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5));
    }
    for (let i = 0; i < n; i++) pushTri(md, center, ring[i], ring[i + 1]);
  }
  return rawFinalize(md);
}

/** 单位球：半径 0.5，中心原点 */
export function unitSphere(segments = 12, rings = 8) {
  const md = createMeshData();
  const n = Math.max(3, segments | 0);
  const m = Math.max(2, rings | 0);
  const r = 0.5;
  const grid = [];
  for (let j = 0; j <= m; j++) {
    const row = [];
    const phi = (j / m) * Math.PI;
    const y = Math.cos(phi) * r;
    const rr = Math.sin(phi) * r;
    for (let i = 0; i <= n; i++) {
      const theta = (i / n) * Math.PI * 2;
      const x = Math.cos(theta) * rr;
      const z = Math.sin(theta) * rr;
      const nx = x / r, ny = y / r, nz = z / r;
      row.push(pushVert(md, x, y, z, nx, ny, nz, i / n, j / m));
    }
    grid.push(row);
  }
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < n; i++) {
      const a = grid[j][i], b = grid[j][i + 1], c = grid[j + 1][i + 1], d = grid[j + 1][i];
      if (j !== 0) pushTri(md, a, b, c);
      if (j !== m - 1) pushTri(md, a, c, d);
    }
  }
  return rawFinalize(md);
}

/** 单位圆锥：底半径 0.5，高 1，顶点 +Y=0.5 */
export function unitCone(segments = 14) {
  const md = createMeshData();
  const n = Math.max(3, segments | 0);
  const h = 0.5, r = 0.5;
  const apex = pushVert(md, 0, h, 0, 0, 1, 0, 0.5, 1);
  const ring = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    ring.push(pushVert(md, Math.cos(a) * r, -h, Math.sin(a) * r, Math.cos(a) * r, r, Math.sin(a) * r,
      0.5 + Math.cos(a) * 0.5, 0));
  }
  for (let i = 0; i < n; i++) pushTri(md, apex, ring[i + 1], ring[i]);
  const center = pushVert(md, 0, -h, 0, 0, -1, 0, 0.5, 0.5);
  for (let i = 0; i < n; i++) pushTri(md, center, ring[i], ring[i + 1]);
  return rawFinalize(md);
}

/** 单位楔形/斜坡：底 1x1，高 1，斜面从 -Z 低到 +Z 高 */
export function unitWedge() {
  const md = createMeshData();
  const h = 0.5;
  // 顶点
  const A = pushVert(md, -h, -h, h, 0, 0, 1, 0, 0);
  const B = pushVert(md, h, -h, h, 0, 0, 1, 1, 0);
  const C = pushVert(md, h, h, h, 0, 0, 1, 1, 1);
  const D = pushVert(md, -h, h, h, 0, 0, 1, 0, 1);
  pushQuad(md, A, B, C, D);
  const E = pushVert(md, -h, -h, -h, 0, 0, -1, 0, 0);
  const F = pushVert(md, h, -h, -h, 0, 0, -1, 1, 0);
  const G = pushVert(md, -h, h, -h, 0, 0, -1, 0, 1);
  pushTri(md, E, G, F);
  // 斜面（+Z 高 -> -Z 低）
  const slopeN = [0, Math.SQRT1_2, -Math.SQRT1_2];
  const S0 = pushVert(md, -h, -h, -h, slopeN[0], slopeN[1], slopeN[2], 0, 0);
  const S1 = pushVert(md, h, -h, -h, slopeN[0], slopeN[1], slopeN[2], 1, 0);
  const S2 = pushVert(md, h, h, h, slopeN[0], slopeN[1], slopeN[2], 1, 1);
  const S3 = pushVert(md, -h, h, h, slopeN[0], slopeN[1], slopeN[2], 0, 1);
  pushQuad(md, S0, S3, S2, S1);
  // 两侧三角
  const L0 = pushVert(md, -h, -h, -h, -1, 0, 0, 0, 0);
  const L1 = pushVert(md, -h, -h, h, -1, 0, 0, 1, 0);
  const L2 = pushVert(md, -h, h, h, -1, 0, 0, 1, 1);
  pushTri(md, L0, L1, L2);
  const R0 = pushVert(md, h, -h, h, 1, 0, 0, 0, 0);
  const R1 = pushVert(md, h, -h, -h, 1, 0, 0, 1, 0);
  const R2 = pushVert(md, h, h, h, 1, 0, 0, 1, 1);
  pushTri(md, R0, R1, R2);
  return rawFinalize(md);
}

/**
 * 面向相机的单位战术刀刃薄棱柱（长轴为 Y，厚度为 Z）。
 * 与斜坡用 unitWedge 不同，它有明确的刀尖、背脊与刃腹轮廓，适合第一人称
 * 视图模型；调用方可用非等比 scale 调整实际刀长和宽度。
 */
export function unitKnifeBlade() {
  const md = createMeshData();
  const outline = [
    // 窄根部 → 微鼓刃腹 → 长斜背 → 尖端。保持凸多边形，扇形三角化
    // 不会翻面；轮廓比旧版“几乎等宽的六边形板”有明显刀尖和收束。
    [-0.22, -0.50], [0.26, -0.50], [0.33, 0.06],
    [0.20, 0.27], [0.00, 0.50], [-0.27, 0.15],
  ];
  const zf = 0.5, zb = -0.5;
  const front = outline.map((p) => pushVert(md, p[0], p[1], zf, 0, 0, 1, p[0] + 0.5, p[1] + 0.5));
  const back = outline.map((p) => pushVert(md, p[0], p[1], zb, 0, 0, -1, p[0] + 0.5, p[1] + 0.5));
  for (let i = 1; i < front.length - 1; i++) pushTri(md, front[0], front[i], front[i + 1]);
  for (let i = 1; i < back.length - 1; i++) pushTri(md, back[0], back[i + 1], back[i]);
  for (let i = 0; i < outline.length; i++) {
    const j = (i + 1) % outline.length;
    const dx = outline[j][0] - outline[i][0];
    const dy = outline[j][1] - outline[i][1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = dy / len, ny = -dx / len;
    const a = pushVert(md, outline[i][0], outline[i][1], zf, nx, ny, 0, 0, 0);
    const d = pushVert(md, outline[i][0], outline[i][1], zb, nx, ny, 0, 0, 1);
    const c = pushVert(md, outline[j][0], outline[j][1], zb, nx, ny, 0, 1, 1);
    const b = pushVert(md, outline[j][0], outline[j][1], zf, nx, ny, 0, 1, 0);
    pushQuad(md, a, d, c, b);
  }
  return rawFinalize(md);
}

/** 单位平面：XZ 平面，1x1，法线 +Y */
export function unitPlane() {
  const md = createMeshData();
  const h = 0.5;
  const a = pushVert(md, -h, 0, h, 0, 1, 0, 0, 0);
  const b = pushVert(md, h, 0, h, 0, 1, 0, 1, 0);
  const c = pushVert(md, h, 0, -h, 0, 1, 0, 1, 1);
  const d = pushVert(md, -h, 0, -h, 0, 1, 0, 0, 1);
  pushQuad(md, a, b, c, d);
  return rawFinalize(md);
}

/** 单位四边形（面向 +Z，中心原点，1x1）—— 粒子/曳光/贴花 */
export function unitQuad() {
  const md = createMeshData();
  const h = 0.5;
  const a = pushVert(md, -h, -h, 0, 0, 0, 1, 0, 0);
  const b = pushVert(md, h, -h, 0, 0, 0, 1, 1, 0);
  const c = pushVert(md, h, h, 0, 0, 0, 1, 1, 1);
  const d = pushVert(md, -h, h, 0, 0, 0, 1, 0, 1);
  pushQuad(md, a, b, c, d);
  return rawFinalize(md);
}

/** 单位圆盘（面向 +Y，半径 0.5）—— 环形冲击波、地面标记 */
export function unitDisc(segments = 20) {
  const md = createMeshData();
  const n = Math.max(3, segments | 0);
  const center = pushVert(md, 0, 0, 0, 0, 1, 0, 0.5, 0.5);
  const ring = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    ring.push(pushVert(md, Math.cos(a) * 0.5, 0, Math.sin(a) * 0.5, 0, 1, 0,
      0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5));
  }
  for (let i = 0; i < n; i++) pushTri(md, center, ring[i + 1], ring[i]);
  return rawFinalize(md);
}

// ---------------------------------------------------------------- 兼容 API（契约 6 节）

/** 盒体（以原点为中心），带颜色 */
export function box(w, h, d, color) {
  const md = unitCube();
  return scaleMeshData(md, [w, h, d], color);
}

/** 由 min/max 角点构造盒体 */
export function boxMinMax(min, max, color) {
  const sx = max[0] - min[0], sy = max[1] - min[1], sz = max[2] - min[2];
  const cx = (min[0] + max[0]) * 0.5, cy = (min[1] + max[1]) * 0.5, cz = (min[2] + max[2]) * 0.5;
  const md = scaleMeshData(unitCube(), [sx, sy, sz], color);
  return translateMeshData(md, [cx, cy, cz]);
}

export function cylinder(rTop, rBottom, h, segments, color) {
  const md = unitCylinder(segments, true, true, rTop * 2, rBottom * 2);
  return scaleMeshData(md, [1, h, 1], color);
}

export function sphere(r, segments, rings, color) {
  const md = unitSphere(segments, rings);
  return scaleMeshData(md, [r * 2, r * 2, r * 2], color);
}

export function capsule(r, h, segments, color) {
  // 用圆柱 + 两个半球近似（低模够用）
  const parts = [];
  const cylH = Math.max(0.001, h - r * 2);
  parts.push(translateMeshData(scaleMeshData(unitCylinder(segments, false, false), [r * 2, cylH, r * 2]), [0, 0, 0]));
  const top = translateMeshData(scaleMeshData(unitSphere(segments, Math.max(3, segments >> 1)), [r * 2, r * 2, r * 2]), [0, cylH * 0.5, 0]);
  const bot = translateMeshData(scaleMeshData(unitSphere(segments, Math.max(3, segments >> 1)), [r * 2, r * 2, r * 2]), [0, -cylH * 0.5, 0]);
  parts.push(top, bot);
  const merged = mergeMeshData(parts);
  return color ? colorizeMeshData(merged, color) : merged;
}

export function cone(r, h, segments, color) {
  const md = scaleMeshData(unitCone(segments), [r * 2, h, r * 2], color);
  return md;
}

/** 四点四边形（逆时针），a,b,c,d 为 vec3 或数组 */
export function quad(a, b, c, d, color) {
  const md = createMeshData();
  const va = pushVert(md, a[0], a[1], a[2], 0, 1, 0, 0, 0);
  const vb = pushVert(md, b[0], b[1], b[2], 0, 1, 0, 1, 0);
  const vc = pushVert(md, c[0], c[1], c[2], 0, 1, 0, 1, 1);
  const vd = pushVert(md, d[0], d[1], d[2], 0, 1, 0, 0, 1);
  pushQuad(md, va, vb, vc, vd);
  const out = rawFinalize(md);
  computeNormals(out);
  if (color) colorizeMeshData(out, color);
  return out;
}

export function planeGrid(w, d, segX, segZ, color) {
  const md = createMeshData();
  const nx = Math.max(1, segX | 0), nz = Math.max(1, segZ | 0);
  const grid = [];
  for (let j = 0; j <= nz; j++) {
    const row = [];
    for (let i = 0; i <= nx; i++) {
      const x = (i / nx - 0.5) * w;
      const z = (j / nz - 0.5) * d;
      row.push(pushVert(md, x, 0, z, 0, 1, 0, i / nx, j / nz));
    }
    grid.push(row);
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = grid[j][i], b = grid[j][i + 1], c = grid[j + 1][i + 1], d2 = grid[j + 1][i];
      pushQuad(md, a, d2, c, b);
    }
  }
  const out = rawFinalize(md);
  if (color) colorizeMeshData(out, color);
  return out;
}

// ---------------------------------------------------------------- 工具

/** 缩放（就地，返回同一对象） */
export function scaleMeshData(md, s, color) {
  const sx = typeof s === 'number' ? s : s[0];
  const sy = typeof s === 'number' ? s : s[1];
  const sz = typeof s === 'number' ? s : s[2];
  const p = md.positions;
  for (let i = 0; i < p.length; i += 3) { p[i] *= sx; p[i + 1] *= sy; p[i + 2] *= sz; }
  if (color) colorizeMeshData(md, color);
  return md;
}

export function translateMeshData(md, t) {
  const p = md.positions;
  for (let i = 0; i < p.length; i += 3) { p[i] += t[0]; p[i + 1] += t[1]; p[i + 2] += t[2]; }
  return md;
}

/** 绕 X/Y/Z 旋转（欧拉，YXZ 顺序） */
export function rotateMeshData(md, euler) {
  const cy = Math.cos(euler[1] || 0), sy = Math.sin(euler[1] || 0);
  const cp = Math.cos(euler[0] || 0), sp = Math.sin(euler[0] || 0);
  const cr = Math.cos(euler[2] || 0), sr = Math.sin(euler[2] || 0);
  const m00 = cy * cr + sy * sp * sr, m01 = cp * sr, m02 = -sy * cr + cy * sp * sr;
  const m10 = -cy * sr + sy * sp * cr, m11 = cp * cr, m12 = sy * sr + cy * sp * cr;
  const m20 = sy * cp, m21 = -sp, m22 = cy * cp;
  const p = md.positions, n = md.normals;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    p[i] = m00 * x + m10 * y + m20 * z;
    p[i + 1] = m01 * x + m11 * y + m21 * z;
    p[i + 2] = m02 * x + m12 * y + m22 * z;
    const nx = n[i], ny = n[i + 1], nz = n[i + 2];
    n[i] = m00 * nx + m10 * ny + m20 * nz;
    n[i + 1] = m01 * nx + m11 * ny + m21 * nz;
    n[i + 2] = m02 * nx + m12 * ny + m22 * nz;
  }
  return md;
}

/** 给顶点色赋值（就地） */
export function colorizeMeshData(md, color) {
  const count = md.positions.length / 3;
  const c = new Float32Array(count * 3);
  const r = color[0], g = color[1], b = color[2];
  for (let i = 0; i < count; i++) { c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b; }
  md.colors = c;
  return md;
}

/** 合并多个 MeshData（索引偏移重排） */
export function mergeMeshData(list) {
  const arr = Array.isArray(list) ? list : Array.from(arguments).filter(Boolean);
  let vTotal = 0, iTotal = 0;
  let hasColors = false, hasUvs = false;
  for (const md of arr) {
    vTotal += md.positions.length / 3;
    iTotal += md.indices.length;
    if (md.colors) hasColors = true;
    if (md.uvs) hasUvs = true;
  }
  const positions = new Float32Array(vTotal * 3);
  const normals = new Float32Array(vTotal * 3);
  const colors = hasColors ? new Float32Array(vTotal * 3) : null;
  const uvs = hasUvs ? new Float32Array(vTotal * 2) : null;
  const indices = vTotal > 65535 ? new Uint32Array(iTotal) : new Uint16Array(iTotal);
  let vo = 0, io = 0;
  for (const md of arr) {
    const vc = md.positions.length / 3;
    positions.set(md.positions, vo * 3);
    normals.set(md.normals, vo * 3);
    if (colors) {
      if (md.colors) colors.set(md.colors, vo * 3);
      else colors.fill(1, vo * 3, (vo + vc) * 3);
    }
    if (uvs) {
      if (md.uvs) uvs.set(md.uvs, vo * 2);
      else uvs.fill(0, vo * 2, (vo + vc) * 2);
    }
    for (let i = 0; i < md.indices.length; i++) indices[io + i] = md.indices[i] + vo;
    vo += vc;
    io += md.indices.length;
  }
  return { positions, normals, colors, uvs, indices };
}

/** 由四元数 + 平移 + 缩放变换 MeshData */
export function transformMeshData(md, m) {
  const out = {
    positions: new Float32Array(md.positions.length),
    normals: new Float32Array(md.normals.length),
    colors: md.colors ? new Float32Array(md.colors) : null,
    uvs: md.uvs ? new Float32Array(md.uvs) : null,
    indices: md.indices.slice(),
  };
  const p = md.positions, n = md.normals;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    out.positions[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out.positions[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out.positions[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    const nx = n[i], ny = n[i + 1], nz = n[i + 2];
    let tx = m[0] * nx + m[4] * ny + m[8] * nz;
    let ty = m[1] * nx + m[5] * ny + m[9] * nz;
    let tz = m[2] * nx + m[6] * ny + m[10] * nz;
    const l = Math.hypot(tx, ty, tz) || 1;
    out.normals[i] = tx / l; out.normals[i + 1] = ty / l; out.normals[i + 2] = tz / l;
  }
  return out;
}

/** 由三角形重新计算面法线（就地，平直着色） */
export function computeNormals(md) {
  const { positions, normals, indices } = md;
  normals.fill(0);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const e1x = positions[b] - positions[a], e1y = positions[b + 1] - positions[a + 1], e1z = positions[b + 2] - positions[a + 2];
    const e2x = positions[c] - positions[a], e2y = positions[c + 1] - positions[a + 1], e2z = positions[c + 2] - positions[a + 2];
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    normals[a] += nx; normals[a + 1] += ny; normals[a + 2] += nz;
    normals[b] += nx; normals[b + 1] += ny; normals[b + 2] += nz;
    normals[c] += nx; normals[c + 1] += ny; normals[c + 2] += nz;
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= l; normals[i + 1] /= l; normals[i + 2] /= l;
  }
  return md;
}

// ---------------------------------------------------------------- 地形

/**
 * 生成高度场地形网格。heightFn(x,z) -> 世界高度。
 * colorFn(x, z, height, slope) -> [r,g,b]（可选）
 * 顶点色烘焙进网格 → 静态世界只需一次 draw call。
 */
export function generateHeightfield({ size, segments, originX = 0, originZ = 0, heightFn, colorFn, skipFn }) {
  const md = createMeshData();
  const n = Math.max(2, segments | 0);
  const step = size / (n - 1);
  const x0 = originX - size * 0.5;
  const z0 = originZ - size * 0.5;
  const h = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      h[j * n + i] = heightFn(x0 + i * step, z0 + j * step);
    }
  }
  // 顶点（略过被跳过的格子会浪费顶点，但地形网格顶点数很小，保持简单）
  const vIdx = new Int32Array(n * n).fill(-1);
  const col = [1, 1, 1];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = x0 + i * step, z = z0 + j * step, y = h[j * n + i];
      // 法线由相邻高度差得到（中心差分）
      const hl = h[j * n + Math.max(0, i - 1)];
      const hr = h[j * n + Math.min(n - 1, i + 1)];
      const hd = h[Math.max(0, j - 1) * n + i];
      const hu = h[Math.min(n - 1, j + 1) * n + i];
      let nx = (hl - hr), ny = 2 * step, nz = (hd - hu);
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      if (colorFn) {
        const slope = 1 - ny;
        const c = colorFn(x, z, y, slope);
        col[0] = c[0]; col[1] = c[1]; col[2] = c[2];
      }
      vIdx[j * n + i] = pushVert(md, x, y, z, nx, ny, nz, x * 0.25, z * 0.25, col[0], col[1], col[2]);
    }
  }
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      if (skipFn && skipFn(x0 + (i + 0.5) * step, z0 + (j + 0.5) * step)) continue;
      const a = vIdx[j * n + i];
      const b = vIdx[j * n + i + 1];
      const c = vIdx[(j + 1) * n + i + 1];
      const d = vIdx[(j + 1) * n + i];
      // 用两条对角线中较短的一条分割，减少长条三角
      const dy1 = Math.abs(h[j * n + i] - h[(j + 1) * n + i + 1]);
      const dy2 = Math.abs(h[j * n + i + 1] - h[(j + 1) * n + i]);
      // 从 +Y 上方观察必须为 CCW。旧顺序法线朝下，背面剔除会把地板整个挖空。
      if (dy1 <= dy2) { pushTri(md, a, c, b); pushTri(md, a, d, c); }
      else { pushTri(md, a, d, b); pushTri(md, b, d, c); }
    }
  }
  return {
    positions: new Float32Array(md.positions),
    normals: new Float32Array(md.normals),
    colors: new Float32Array(md.colors),
    uvs: new Float32Array(md.uvs),
    indices: md._vc > 65535 ? new Uint32Array(md.indices) : new Uint16Array(md.indices),
    gridN: n,
    gridStep: step,
    gridOrigin: [x0, z0],
    heights: h,
  };
}

/**
 * 生成地形三角面片数据（供碰撞用），与 generateHeightfield 使用同一 heightFn。
 * 返回 Float32Array，每 9 个 float 一个三角形。
 */
export function generateHeightfieldTriangles({ size, segments, originX = 0, originZ = 0, heightFn, maxSlopeCos = -1 }) {
  const n = Math.max(2, segments | 0);
  const step = size / (n - 1);
  const x0 = originX - size * 0.5;
  const z0 = originZ - size * 0.5;
  const h = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) h[j * n + i] = heightFn(x0 + i * step, z0 + j * step);
  }
  const tri = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const xa = x0 + i * step, xb = x0 + (i + 1) * step;
      const za = z0 + j * step, zb = z0 + (j + 1) * step;
      const ya = h[j * n + i], yb = h[j * n + i + 1], yc = h[(j + 1) * n + i + 1], yd = h[(j + 1) * n + i];
      // 与渲染保持一致的三角划分
      const dy1 = Math.abs(ya - yc), dy2 = Math.abs(yb - yd);
      if (dy1 <= dy2) {
        tri.push(xa, ya, za, xb, yc, zb, xb, yb, za);
        tri.push(xa, ya, za, xa, yd, zb, xb, yc, zb);
      } else {
        tri.push(xa, ya, za, xa, yd, zb, xb, yb, za);
        tri.push(xb, yb, za, xa, yd, zb, xb, yc, zb);
      }
    }
  }
  return { triangles: new Float32Array(tri), gridN: n, gridStep: step, gridOrigin: [x0, z0], heights: h };
}

export function vertexCount(md) {
  return md.positions.length / 3;
}

export function triangleCount(md) {
  return md.indices.length / 3;
}

export default {
  unitCube, unitCylinder, unitSphere, unitCone, unitWedge, unitPlane, unitQuad, unitDisc,
  box, boxMinMax, cylinder, sphere, capsule, cone, quad, planeGrid,
  mergeMeshData, transformMeshData, colorizeMeshData, computeNormals,
  generateHeightfield, generateHeightfieldTriangles,
  createMeshData, finalizeMeshData, vertexCount, triangleCount,
};
