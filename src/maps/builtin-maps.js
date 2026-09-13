// ==== maps/builtin-maps.js — 程序化地图库：生物群系 / 高度函数 / 六种原型布局 / 战役阶梯【自包含，不 import 任何模块】 ====

// 设计意图：本文件是"铸造世界远征"的内容引擎。铁陨行动（IRONFALL）的地图必须是
// 垂直的、可蹬墙的、可滑铲的——平地射击场毫无意义。因此每种原型都先设计"运动路线"
// （墙跑长廊 / 上升环 / 槽沟桥），再填结构；并强制通过一层粗网格连通性验证，
// 保证任何随机结果都是"可玩的"，而不是"好看的"。
//
// 本文件刻意不依赖 core/math.js：并行开发期间它可能不存在，地图库必须能独立运行。
// 所有随机数来自本地 mulberry32；同一 seed 必定产出字节级一致的地图 JSON。

// ---------------------------------------------------------------------------
// 0. 常量
// ---------------------------------------------------------------------------

/** 地图格式版本，必须与 world.js 的 MAP_FORMAT_VERSION 一致。 */
export const MAP_FORMAT_VERSION = 1;

/** 碰撞盒标志位。位含义见 docs/CONTRACTS.md 8.1。 */
export const FLAG = Object.freeze({
  SOLID: 1,       // 可碰撞
  WALLRUN: 2,     // 可蹬墙
  CLIMBABLE: 4,   // 可攀爬
  BREAKABLE: 8,   // 可破坏（预留）
  PLATFORM: 16,   // 单向平台语义（薄板/栈桥）
  COVER: 32,      // 掩体（AI 与关卡设计用）
  HAZARD: 64,     // 危险区（伤害体积）
  LADDER: 128,    // 梯子
  EXTRACT: 256,   // 撤离/补给交互体
});

/** 常用标志组合，避免每处手写位或。 */
const F_STRUCT = FLAG.SOLID | FLAG.WALLRUN | FLAG.CLIMBABLE;        // 墙体、柱、船壳
const F_CATWALK = FLAG.SOLID | FLAG.PLATFORM | FLAG.WALLRUN;        // 细长栈桥
const F_DECK = FLAG.SOLID | FLAG.PLATFORM;                          // 大平台/地板
const F_COVER = FLAG.SOLID | FLAG.COVER;                            // 掩体
const F_LADDER = FLAG.SOLID | FLAG.CLIMBABLE | FLAG.LADDER;         // 梯井
const F_HAZARD = FLAG.HAZARD;                                       // 危险体积
const F_GATE = FLAG.SOLID | FLAG.WALLRUN | FLAG.CLIMBABLE | FLAG.COVER;

/** 玩家/敌人尺度常量（与 core/config.js 的默认值保持一致）。 */
const CELL = 2;              // 占用网格与地面网格的单元边长（米）
const BODY_H = 1.8;          // 玩家站立高度
const REACH_H = 4.0;         // 需要留出的净空（米）
const SPAWN_CLEAR_ABOVE = 2.2;
const MIN_BOXES = 60;
const MAX_BOXES = 400;
const ENEMY_SPAWN_MIN_DIST = 26;  // > 25m 的硬性要求，留 1m 余量
const MIN_FREE_RATIO = 0.08;      // 连通区域至少占可站立单元的 8%

// ---------------------------------------------------------------------------
// 1. 本地数学与噪声（不依赖 core/math.js）
// ---------------------------------------------------------------------------

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 标准 smoothstep；e0 === e1 时退化为阶跃，避免除零产生 NaN。 */
function smoothstep(e0, e1, x) {
  if (e1 === e0) return x < e0 ? 0 : 1;
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** mulberry32 —— 确定性 PRNG，返回 [0,1)。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 整数哈希 -> [0,1)，与 mulberry32 混洗器一致，用于无缝噪声。 */
function hash2i(ix, iy, seed) {
  let t = (Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** 双线性插值的值噪声 -> [0,1]。 */
function valueNoise2(x, y, seed) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const n00 = hash2i(x0, y0, seed);
  const n10 = hash2i(x0 + 1, y0, seed);
  const n01 = hash2i(x0, y0 + 1, seed);
  const n11 = hash2i(x0 + 1, y0 + 1, seed);
  return lerp(lerp(n00, n10, sx), lerp(n01, n11, sx), sy);
}

/** 分形叠加噪声，输出归一化到 [0,1]。 */
function fbm2(x, y, octaves, lacunarity, gain, seed) {
  const oct = Math.max(1, octaves | 0);
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * valueNoise2(x * freq, y * freq, seed + i * 1013);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/** 噪声特征波长（米）。octaves 越高细节越碎，整体幅度不变。 */
const NOISE_WAVELENGTH = 26;

// ---------------------------------------------------------------------------
// 2. 生物群系表
// ---------------------------------------------------------------------------

/**
 * 生物群系定义。palette 驱动光照与雾，terrain 驱动高度函数默认参数，
 * hazard 描述该世界的主导环境危害。
 */
export const BIOMES = Object.freeze({
  industrial_forge: Object.freeze({
    id: 'industrial_forge',
    name: '熔炉星港',
    desc: '永不停歇的铸造环带。传送带把半熔的合金锭送进中央坩埚，热浪让空气都在扭曲。',
    palette: Object.freeze({
      sky: [0.24, 0.15, 0.11],
      fog: [0.20, 0.11, 0.07],
      sun: [1.0, 0.72, 0.44],
      ambient: [0.20, 0.14, 0.12],
      ground: [0.26, 0.22, 0.20],
      accent: [1.0, 0.52, 0.16],
      metal: [0.34, 0.29, 0.27],
      emissive: [1.0, 0.46, 0.12],
    }),
    hazard: Object.freeze({ kind: 'lava', strength: 26 }),
    ambientTrack: 'ambient_forge',
    gravityScale: 1.0,
    terrain: Object.freeze({ amplitude: 9, octaves: 4, lacunarity: 2.0, gain: 0.5, roughness: 1.0 }),
  }),
  ship_graveyard: Object.freeze({
    id: 'ship_graveyard',
    name: '舰骸坟场',
    desc: '拆解轨道上拖来的退役舰体。千米长的龙骨斜插进沙里，护栏早被拆去当废铁。',
    palette: Object.freeze({
      sky: [0.17, 0.19, 0.23],
      fog: [0.13, 0.15, 0.19],
      sun: [0.86, 0.90, 1.0],
      ambient: [0.18, 0.20, 0.25],
      ground: [0.30, 0.28, 0.25],
      accent: [0.42, 0.78, 1.0],
      metal: [0.40, 0.42, 0.46],
      emissive: [0.30, 0.70, 1.0],
    }),
    hazard: Object.freeze({ kind: 'vacuum', strength: 20 }),
    ambientTrack: 'ambient_forge',
    gravityScale: 0.92,
    terrain: Object.freeze({ amplitude: 7, octaves: 3, lacunarity: 2.1, gain: 0.52, roughness: 0.8 }),
  }),
  deep_core_mine: Object.freeze({
    id: 'deep_core_mine',
    name: '深核矿脉',
    desc: '向下三百层仍在开采的重金属矿脉。通风井喷出的热气带着放射性尘埃。',
    palette: Object.freeze({
      sky: [0.06, 0.07, 0.09],
      fog: [0.05, 0.06, 0.08],
      sun: [0.72, 0.82, 0.92],
      ambient: [0.12, 0.15, 0.19],
      ground: [0.19, 0.20, 0.22],
      accent: [0.36, 1.0, 0.62],
      metal: [0.28, 0.31, 0.34],
      emissive: [0.28, 1.0, 0.58],
    }),
    hazard: Object.freeze({ kind: 'radiation', strength: 16 }),
    ambientTrack: 'ambient_forge',
    gravityScale: 1.0,
    terrain: Object.freeze({ amplitude: 15, octaves: 5, lacunarity: 2.0, gain: 0.48, roughness: 1.25 }),
  }),
  orbital_anchor: Object.freeze({
    id: 'orbital_anchor',
    name: '轨道锚站',
    desc: '把地表与同步轨道锁在一起的系泊塔群。外壳破损处直接暴露在真空里。',
    palette: Object.freeze({
      sky: [0.05, 0.07, 0.12],
      fog: [0.04, 0.06, 0.11],
      sun: [0.94, 0.96, 1.0],
      ambient: [0.14, 0.17, 0.24],
      ground: [0.24, 0.25, 0.28],
      accent: [0.42, 0.86, 1.0],
      metal: [0.44, 0.47, 0.52],
      emissive: [0.35, 0.78, 1.0],
    }),
    hazard: Object.freeze({ kind: 'vacuum', strength: 24 }),
    ambientTrack: 'ambient_forge',
    gravityScale: 0.78,
    terrain: Object.freeze({ amplitude: 5, octaves: 3, lacunarity: 2.2, gain: 0.5, roughness: 1.5 }),
  }),
  slag_wastes: Object.freeze({
    id: 'slag_wastes',
    name: '炉渣荒原',
    desc: '几个世纪的炉渣堆积成丘陵。酸雨在洼地里汇成池子，把钢靴咬出气泡。',
    palette: Object.freeze({
      sky: [0.20, 0.18, 0.13],
      fog: [0.19, 0.16, 0.11],
      sun: [1.0, 0.88, 0.62],
      ambient: [0.21, 0.18, 0.13],
      ground: [0.28, 0.25, 0.19],
      accent: [0.92, 1.0, 0.44],
      metal: [0.33, 0.31, 0.26],
      emissive: [0.86, 1.0, 0.36],
    }),
    hazard: Object.freeze({ kind: 'acid', strength: 18 }),
    ambientTrack: 'ambient_forge',
    gravityScale: 1.05,
    terrain: Object.freeze({ amplitude: 18, octaves: 5, lacunarity: 1.9, gain: 0.55, roughness: 1.1 }),
  }),
});

/** 生物群系 id 顺序表（生成器遍历用）。 */
export const BIOME_IDS = Object.freeze(Object.keys(BIOMES));

/** 按 id 取生物群系；未知 id 回退到熔炉星港并给出警告。 */
export function getBiome(id) {
  return BIOMES[id] || BIOMES.industrial_forge;
}

// ---------------------------------------------------------------------------
// 3. 地形高度函数（契约 8.2）
// ---------------------------------------------------------------------------

/**
 * 依据 terrain 段构造确定性高度函数。纯函数：同 spec 同 (x,z) 必定同结果，
 * 且可在任意实数坐标求值（不限于网格点），地图外自然外推。
 * @param {object} terrainSpec { resolution, baseHeight, amplitude, octaves, lacunarity, gain, plateau[], trenches[] }
 * @returns {(x:number, z:number) => number}
 */
export function makeHeightFn(terrainSpec) {
  const spec = terrainSpec || {};
  const seed = ((spec.seed | 0) || 0) >>> 0;
  const baseHeight = numOr(spec.baseHeight, 0);
  const amplitude = numOr(spec.amplitude, 0);
  const octaves = clamp(spec.octaves | 0 || 4, 1, 8);
  const lacunarity = numOr(spec.lacunarity, 2);
  const gain = numOr(spec.gain, 0.5);
  const roughness = numOr(spec.roughness, 1);
  // 预解析地貌修饰，避免每次采样重新读对象字段（高度函数在生成期被调用数十万次）
  // plateau.height 是"抬升量"（多数为正），trenches.depth 是"下切量"（多数为负）
  const plateaus = normalizeFeatures(spec.plateau, 'height');
  const trenches = normalizeFeatures(spec.trenches, 'depth');
  const hazardBasins = normalizeHazardBasins(spec.hazardBasins);
  const field = spec.field || null;
  const inv = 1 / (NOISE_WAVELENGTH * roughness);

  return function heightAt(x, z) {
    // 分级地形优先：它保证了可步行坡度，噪声只用来做细节
    if (field) {
      let h = sampleField(field, x, z);
      if (amplitude !== 0) {
        const n = fbm2(x * inv, z * inv, octaves, lacunarity, gain, seed);
        h += (n * 2 - 1) * amplitude * FIELD_DETAIL;
      }
      h = applyHazardBasins(h, x, z, hazardBasins);
      return h < -34 ? -34 : h;
    }
    let h = baseHeight;
    if (amplitude !== 0) {
      const n = fbm2(x * inv, z * inv, octaves, lacunarity, gain, seed);
      h += (n * 2 - 1) * amplitude;
    }
    for (let i = 0; i < plateaus.length; i++) {
      const p = plateaus[i];
      const dx = x - p.x;
      const dz = z - p.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      const t = 1 - smoothstep(p.radius, p.radius + p.falloff, d);
      if (t > 0) h += p.amount * t;
    }
    for (let i = 0; i < trenches.length; i++) {
      const p = trenches[i];
      const dx = x - p.x;
      const dz = z - p.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      const t = 1 - smoothstep(p.radius, p.radius + p.falloff, d);
      if (t > 0) h += p.amount * t; // depth 为负值
    }
    h = applyHazardBasins(h, x, z, hazardBasins);
    // 世界地板：任何地方都不低于 -34m，保证撤离/出生点永远有落脚面
    return h < -34 ? -34 : h;
  };
}

/**
 * 地形融合危险区：危险区边界保持原高度，向内用缓坡下切成浅池/裂隙。
 * 这里改变的就是最终高度函数，因此渲染网格、地面查询和碰撞三角始终同源。
 */
function applyHazardBasins(h, x, z, basins) {
  for (let i = 0; i < basins.length; i++) {
    const b = basins[i];
    const ix = b.halfW - Math.abs(x - b.x);
    const iz = b.halfD - Math.abs(z - b.z);
    if (ix <= 0 || iz <= 0) continue;
    const inward = Math.min(ix, iz);
    h -= b.depth * smoothstep(0, b.rimWidth, inward);
  }
  return h;
}

function normalizeHazardBasins(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (!b || typeof b !== 'object') continue;
    const w = Math.max(0.8, numOr(b.w, numOr(b.width, 1)));
    const d = Math.max(0.8, numOr(b.d, numOr(b.depthSize, 1)));
    out.push({
      x: numOr(b.x, 0),
      z: numOr(b.z, 0),
      halfW: w * 0.5,
      halfD: d * 0.5,
      depth: Math.max(0, numOr(b.basinDepth, 0)),
      rimWidth: Math.max(0.8, numOr(b.rimWidth, 3.5)),
    });
  }
  return out;
}

/** 双线性采样分级地形场（坐标单位：场节点索引）。 */
function sampleField(field, x, z) {
  const gx = x / field.spacing + field.ox;
  const gz = z / field.spacing + field.oz;
  const x0 = Math.floor(gx);
  const z0 = Math.floor(gz);
  const fx = gx - x0;
  const fz = gz - z0;
  const n = field.n;
  const cx0 = x0 < 0 ? 0 : x0 > n - 1 ? n - 1 : x0;
  const cz0 = z0 < 0 ? 0 : z0 > n - 1 ? n - 1 : z0;
  const cx1 = cx0 + 1 > n - 1 ? n - 1 : cx0 + 1;
  const cz1 = cz0 + 1 > n - 1 ? n - 1 : cz0 + 1;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const h = field.h;
  const a = h[cz0 * n + cx0];
  const b = h[cz0 * n + cx1];
  const c = h[cz1 * n + cx0];
  const d = h[cz1 * n + cx1];
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sz);
}

// ---------------------------------------------------------------------------
// 3b. 地形整平（保证"可步行坡度"这一硬约束）
// ---------------------------------------------------------------------------

const FIELD_SPACING = 8;      // 分级节点间距（米）
const FIELD_DETAIL = 0.16;    // 分级模式下噪声细节占比
const FIELD_STEP_MAX = 0.95;  // 相邻节点的最大高差（约 12m/2m 格）
const FIELD_SMOOTH_R = 16;    // 应用回高度函数时的过渡半径（米），保证坡度 ≤ ~0.1

/**
 * 先把原始地形采样到粗网格，再迭代"填谷削峰"把它压成缓坡，
 * 最后让高度函数以平滑过渡的方式采用这份分级数据。
 * 设计意图：粗糙噪声地形会让"可步行"判定全灭；先整平再谈连通性。
 * @returns {{ n:number, spacing:number, ox:number, oz:number, h:Float64Array }}
 */
function gradeTerrain(size, heightFn, passes) {
  const spacing = FIELD_SPACING;
  const n = Math.ceil(size / spacing) + 5;
  const ox = (n - 1) / 2;
  const oz = (n - 1) / 2;
  const h = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      h[j * n + i] = heightFn((i - ox) * spacing, (j - oz) * spacing);
    }
  }
  const rounds = passes == null ? 10 : passes;
  const idx = (i, j) => j * n + i;
  for (let r = 0; r < rounds; r++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = idx(i, j);
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            if (di === 0 && dj === 0) continue;
            const ni = i + di;
            const nj = j + dj;
            if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
            const nk = idx(ni, nj);
            const diff = h[nk] - h[k];
            if (diff > FIELD_STEP_MAX) h[k] += (diff - FIELD_STEP_MAX) * 0.5;
            else if (diff < -FIELD_STEP_MAX) h[nk] += (-diff - FIELD_STEP_MAX) * 0.5;
          }
        }
      }
    }
  }
  // 收尾：再做一次低通，抹掉迭代产生的棱角
  const tmp = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let sum = 0;
      let cnt = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
          sum += h[idx(ni, nj)];
          cnt++;
        }
      }
      tmp[idx(i, j)] = sum / cnt;
    }
  }
  h.set(tmp);
  return { n, spacing, ox, oz, h };
}


/** 统一 plateau / trenches 的字段名（height | depth 都归一到 amount）。 */
function normalizeFeatures(list, key) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (!f || typeof f !== 'object') continue;
    const amount = numOr(f[key], 0);
    out.push({
      x: numOr(f.x, 0),
      z: numOr(f.z, 0),
      radius: Math.max(0.01, numOr(f.radius, 1)),
      falloff: Math.max(0.01, numOr(f.falloff, 1)),
      amount,
    });
  }
  return out;
}

function numOr(v, d) {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

// ---------------------------------------------------------------------------
// 4. 几何工具
// ---------------------------------------------------------------------------

/**
 * 世界坐标 -> 单元索引。
 * 关键：导航网格的原点是地图角点 (-size/2, -size/2)，不是世界原点。
 * 早先版本把 grid cell 0 当成世界 0，导致 x<0 或 z<0 的半个场地全在网格之外。
 */
function cellOf(grid, v) {
  return Math.floor((v + grid.origin) / CELL + 0.5);
}

/** 单元索引 -> 单元中心世界坐标。 */
function cellCenter(grid, i) {
  return i * CELL - grid.origin;
}

/** 把 [min,max] 展开为覆盖其单元索引范围（半开区间，避免恰好落在边界时漏格）。 */
function cellRange(origin, min, max) {
  return [Math.floor((min + origin) / CELL), Math.ceil((max + origin) / CELL) - 1];
}

/** 绕 Y 轴旋转的矩形墙体 -> 世界 AABB（四角包围盒）。 */
function wallAABB(cx, cz, len, thickness, yaw, y0, y1) {
  const hx = len / 2;
  const hz = thickness / 2;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const pts = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
  for (let i = 0; i < 4; i++) {
    const px = pts[i][0] * c - pts[i][1] * s + cx;
    const pz = pts[i][0] * s + pts[i][1] * c + cz;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (pz < minZ) minZ = pz;
    if (pz > maxZ) maxZ = pz;
  }
  return [[minX, y0, minZ], [maxX, y1, maxZ]];
}

/** 均匀取整到 0.05m，让 JSON 体积可控且完全确定。 */
function q(v) {
  return Math.round(v * 20) / 20;
}

// ---------------------------------------------------------------------------
// 5. 地图建造器
// ---------------------------------------------------------------------------

/**
 * 收集所有几何与占位信息，并提供"能否放置"的粗网格判据。
 * 网格单元 2m；每个单元记录被盒子占据的竖直区间，用来判断净空。
 */
class MapBuilder {
  constructor(size, heightFn) {
    this.size = size;
    this.half = size / 2;
    this.origin = size / 2; // 导航网格原点偏移：cell 0 的中心位于 (-size/2, -size/2)
    this.heightFn = heightFn;
    this.gridN = Math.floor(size / CELL) + 1;
    const n = this.gridN;
    this.occ = new Array(n * n);
    for (let i = 0; i < this.occ.length; i++) this.occ[i] = null;
    this.boxes = [];
    this.platforms = [];
    this.catwalks = [];
    this.walls = [];
    this.props = [];
    this.hazards = [];
    this.landmarks = [];
  }

  idx(ix, iz) {
    const n = this.gridN;
    if (ix < 0 || iz < 0 || ix >= n || iz >= n) return -1;
    return iz * n + ix;
  }

  /** 单元内的占据区间列表（惰性创建）。 */
  intervals(ix, iz) {
    const i = this.idx(ix, iz);
    if (i < 0) return null;
    let list = this.occ[i];
    if (!list) {
      list = [];
      this.occ[i] = list;
    }
    return list;
  }

  /**
   * 单元内是否存在与 [y0,y1] 相交的盒子。
   * ignores 里的"顶面高度"会被跳过——定义站立面的那块板不能算作挡头结构。
   */
  cellBlocked(ix, iz, y0, y1, ignores) {
    const list = this.intervals(ix, iz);
    if (!list || list.length === 0) return false;
    for (let i = 0; i < list.length; i += 2) {
      if (y0 < list[i + 1] && y1 > list[i]) {
        if (ignores && ignores.indexOf(list[i + 1]) >= 0) continue;
        return true;
      }
    }
    return false;
  }

  /** 单元在 [y0,y1] 上的最低阻塞高度（无阻塞返回 Infinity）。 */
  cellLowestBlock(ix, iz, y0, y1) {
    const list = this.intervals(ix, iz);
    if (!list || list.length === 0) return Infinity;
    let best = Infinity;
    for (let i = 0; i < list.length; i += 2) {
      if (y0 < list[i + 1] && y1 > list[i] && list[i] < best) best = list[i];
    }
    return best;
  }

  /** 检查 AABB 是否与已有几何冲突（留 margin 米间隙）。 */
  fits(min, max, margin) {
    const m = margin == null ? 0.6 : margin;
    const x0 = min[0] - m;
    const x1 = max[0] + m;
    const z0 = min[2] - m;
    const z1 = max[2] + m;
    const [ix0, ix1] = cellRange(this.origin, x0, x1);
    const [iz0, iz1] = cellRange(this.origin, z0, z1);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        if (this.idx(ix, iz) < 0) continue;
        // 矩形相交才判定冲突：点采样会漏掉夹在采样点之间的墙
        if (!(x1 > ix * CELL - CELL / 2 && x0 < ix * CELL + CELL / 2)) continue;
        if (!(z1 > iz * CELL - CELL / 2 && z0 < iz * CELL + CELL / 2)) continue;
        if (this.cellBlocked(ix, iz, min[1], max[1])) return false;
      }
    }
    return true;
  }

  /** 写入占据区间。 */
  occupy(min, max) {
    const [ix0, ix1] = cellRange(this.origin, min[0], max[0]);
    const [iz0, iz1] = cellRange(this.origin, min[2], max[2]);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const list = this.intervals(ix, iz);
        if (list) list.push(min[1], max[1]);
      }
    }
  }

  /**
   * 直接登记一个已存在的碰撞盒（从地图 JSON 还原时使用）。
   * 与 addBox 不同：不做冲突检测、不改动数值，只登记几何。
   */
  seedBox(min, max, flags) {
    const box = {
      min: [min[0], min[1], min[2]],
      max: [max[0], max[1], max[2]],
      flags: flags == null ? FLAG.SOLID : flags | 0,
      material: 'seeded',
    };
    this.boxes.push(box);
    this.occupy(box.min, box.max);
    return box;
  }

  /**
   * 添加碰撞盒。
   * @param {number[]} min
   * @param {number[]} max
   * @param {number} flags
   * @param {string} material
   * @param {object} [opts] { support:boolean 是否需要地面支撑, margin:number, force:boolean 忽略冲突 }
   */
  addBox(min, max, flags, material, opts) {
    const o = opts || {};
    const nmin = [q(min[0]), q(min[1]), q(min[2])];
    const nmax = [q(Math.max(max[0], min[0] + 0.4)), q(Math.max(max[1], min[1] + 0.4)), q(Math.max(max[2], min[2] + 0.4))];
    if (nmin[1] < -34) nmin[1] = -34;
    if (nmax[1] > 190) nmax[1] = 190;
    if (!o.force && !this.fits(nmin, nmax, o.margin)) return null;
    this.occupy(nmin, nmax);
    const box = { min: nmin, max: nmax, flags: flags | 0, material: material || 'concrete' };
    this.boxes.push(box);
    return box;
  }

  addPlatform(cx, y, cz, sx, sz, flags, material) {
    const box = this.addBox(
      [cx - sx / 2, y - 0.4, cz - sz / 2],
      [cx + sx / 2, y, cz + sz / 2],
      flags == null ? F_DECK : flags,
      material || 'deck',
      { margin: 0.3 }
    );
    if (box) this.platforms.push({ pos: [q(cx), q(y), q(cz)], size: [q(sx), 0.5, q(sz)], angle: 0, flags: box.flags });
    return box;
  }

  /**
   * 任意角度的栈桥：两端点 y 相同，用若干段拼接以近似斜置。
   * @returns {boolean} 是否全部落位
   */
  addCatwalk(ax, ay, az, bx, by, bz, width, flags) {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const horiz = Math.sqrt(dx * dx + dz * dz);
    const segs = Math.max(1, Math.round(horiz / 6));
    const yaw = Math.atan2(dx, dz);
    const f = flags == null ? F_CATWALK : flags;
    const pts = [];
    let ok = true;
    for (let s = 0; s < segs; s++) {
      const t0 = s / segs;
      const t1 = (s + 1) / segs;
      const cx = ax + dx * (t0 + t1) / 2;
      const cz = az + dz * (t0 + t1) / 2;
      const cy = ay + dy * (t0 + t1) / 2;
      const segLen = Math.sqrt(dx * dx + dz * dz) / segs + width * 0.5;
      const [min, max] = wallAABB(cx, cz, segLen, width, yaw, cy - 0.45, cy);
      const box = this.addBox(min, max, f, 'grate', { margin: 0.25 });
      if (!box) ok = false;
      pts.push([q(ax + dx * t0), q(ay + dy * t0), q(az + dz * t0)]);
    }
    pts.push([q(bx), q(by), q(bz)]);
    this.catwalks.push({ points: pts, width: q(width), flags: f });
    return ok;
  }

  /** 竖直墙面（用于记录到 walls 数组，供 world 生成装饰网格）。 */
  addWallSegment(ax, ay, az, bx, by, bz, height, thickness, flags) {
    this.walls.push({
      points: [[q(ax), q(ay), q(az)], [q(bx), q(by), q(bz)]],
      height: q(height),
      thickness: q(thickness),
      flags: flags == null ? F_STRUCT : flags,
    });
  }

  addProp(type, x, y, z, scale, yaw) {
    this.props.push({ type, pos: [q(x), q(y), q(z)], scale: q(scale), yaw: q(yaw) });
  }

  addHazard(kind, min, max, strength) {
    this.hazards.push({
      kind,
      label: HAZARD_LABEL[kind] || '危险区',
      strength: q(strength),
      shape: 'box',
      min: [q(min[0]), q(min[1]), q(min[2])],
      max: [q(max[0]), q(max[1]), q(max[2])],
      terrainIntegrated: false,
      basinDepth: 0.45,
      rimWidth: 1.2,
      shapeSeed: ((Math.abs(min[0] * 31 + min[2] * 17) * 100) | 0) >>> 0,
    });
  }

  /** 尖塔/烟囱环：竖直薄板围成的可蹬墙圆筒。 */
  addRing(segments, radius, thickness, y0, y1, cx, cz, flags, material) {
    const f = flags == null ? F_STRUCT : flags;
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const px = cx + Math.cos(a) * radius;
      const pz = cz + Math.sin(a) * radius;
      const segLen = (2 * Math.PI * radius) / segments * 1.08;
      const [min, max] = wallAABB(px, pz, segLen, thickness, -a, y0, y1);
      this.addBox(min, max, f, material || 'metal', { margin: 0.1 });
    }
  }

  /** 开阔地带的低矮护栏（掩体）。 */
  addFence(ax, az, bx, bz, h, thickness) {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.sqrt(dx * dx + dz * dz);
    const yaw = Math.atan2(dx, dz);
    const y = q(this.heightFn((ax + bx) / 2, (az + bz) / 2));
    const [min, max] = wallAABB((ax + bx) / 2, (az + bz) / 2, len, thickness, yaw, y, y + h);
    return this.addBox(min, max, F_COVER, 'plate', { margin: 0.4 });
  }
}

// ---------------------------------------------------------------------------
// 6. 地面网格与连通性检查
// ---------------------------------------------------------------------------

/**
 * 依据盒子与地形计算每个单元的可站立面高度。
 * 单元用"矩形相交"判定被谁占据（不是点采样），因此薄墙也不会从网格缝隙里漏掉。
 * - 薄板/栈桥（顶面在 y）→ 可站立面 = 顶面
 * - 大体块 → 若上方 REACH_H 内无遮挡则顶面可站立，否则该单元视为被堵死（-Infinity）
 * @returns {{ ground: Float64Array, n:number, cell:number, half:number, solid:Uint8Array }}
 */
function buildGroundGrid(builder) {
  const n = builder.gridN;
  const half = CELL / 2;
  const ground = new Float64Array(n * n);
  const solid = new Uint8Array(n * n);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      ground[iz * n + ix] = builder.heightFn(cellCenter(builder, ix), cellCenter(builder, iz));
    }
  }
  const boxes = builder.boxes;
  for (let bi = 0; bi < boxes.length; bi++) {
    const b = boxes[bi];
    if (b._carved) continue; // 被预算/开洞裁掉的盒子不参与地面计算（自检也看不到它们）
    const bx0 = b.min[0], bx1 = b.max[0];
    const bz0 = b.min[2], bz1 = b.max[2];
    const top = b.max[1];
    const bottom = b.min[1];
    const isDeck = (b.flags & FLAG.PLATFORM) !== 0;
    const walkableTop = isDeck || (top - bottom) <= REACH_H;
    const ignore = [top];
    const ca = cellRange(builder.origin, bx0, bx1);
    const cc = cellRange(builder.origin, bz0, bz1);
    const ia0 = Math.max(0, ca[0]);
    const ia1 = Math.min(n - 1, ca[1]);
    const ic0 = Math.max(0, cc[0]);
    const ic1 = Math.min(n - 1, cc[1]);
    for (let iz = ic0; iz <= ic1; iz++) {
      const v0 = iz * CELL - half;
      const v1 = iz * CELL + half;
      if (!(bz1 > v0 && bz0 < v1)) continue;
      for (let ix = ia0; ix <= ia1; ix++) {
        const u0 = ix * CELL - half;
        const u1 = ix * CELL + half;
        if (!(bx1 > u0 && bx0 < u1)) continue;
        const k = iz * n + ix;
        // 已被判定为"不可站立"的格子不再被后续盒子提升，保证生成期与自检结果一致
        if (solid[k]) continue;
        if (!walkableTop) {
          ground[k] = -Infinity;
          solid[k] = 1;
          continue;
        }
        if (top <= ground[k]) continue;
        // 顶面必须被整格覆盖、且上方有净空，才可作为站立面；否则整格作废
        const covers = bx0 <= u0 && bx1 >= u1 && bz0 <= v0 && bz1 >= v1;
        if (covers && !builder.cellBlocked(ix, iz, top + 0.05, top + REACH_H, ignore)) {
          ground[k] = top;
        } else if (bottom > ground[k]) {
          ground[k] = -Infinity;
          solid[k] = 1;
        }
      }
    }
  }
  return { ground, n, cell: CELL, half: builder.half, origin: builder.origin, solid };
}

/** 采样点地面高度（仅地形与顶面，不含净空判定）。 */
function sampleGround(grid, x, z) {
  const ix = cellOf(grid, x);
  const iz = cellOf(grid, z);
  if (ix < 0 || iz < 0 || ix >= grid.n || iz >= grid.n) return -Infinity;
  const k = iz * grid.n + ix;
  if (grid.solid[k]) return -Infinity;
  return grid.ground[k];
}

/** 检查某点能否站人：整格有地面、四角与中心都有净空。
 * 四角采样是关键——墙只压住单元一角时人依然站不住；
 * 四角取"导航格"的四个角（而不是以点为中心的正方形），保证与寻路判据完全一致。
 * @returns {number} 可站立高度，或 -Infinity
 */
function standHeightAt(builder, grid, x, z) {
  const ix = cellOf(grid, x);
  const iz = cellOf(grid, z);
  if (ix < 0 || iz < 0 || ix >= grid.n || iz >= grid.n) return -Infinity;
  const k = iz * grid.n + ix;
  const g = grid.ground[k];
  if (!Number.isFinite(g) || grid.solid[k]) return -Infinity;
  const ignore = [g];
  const hi = g + BODY_H + 0.25;
  if (builder.cellBlocked(ix, iz, g + 0.15, hi, ignore)) return -Infinity;
  const corners = navCorners(grid, ix, iz);
  for (let i = 0; i < 8; i += 2) {
    const cix = corners[i];
    const ciz = corners[i + 1];
    if (cix < 0 || ciz < 0 || cix >= grid.n || ciz >= grid.n) return -Infinity;
    const ck = ciz * grid.n + cix;
    if (grid.solid[ck]) return -Infinity;
    const gc = grid.ground[ck];
    if (!Number.isFinite(gc)) return -Infinity;
    if (builder.cellBlocked(cix, ciz, gc + 0.15, gc + BODY_H + 0.25, [gc])) return -Infinity;
  }
  return g;
}

/** 导航格 (ix,iz) 的四个角点坐标（对外半格，与占用表的矩形判据一致）。 */
function navCorners(grid, ix, iz) {
  const x0 = ix * CELL - CELL / 2 - grid.origin;
  const x1 = ix * CELL + CELL / 2 - grid.origin;
  const z0 = iz * CELL - CELL / 2 - grid.origin;
  const z1 = iz * CELL + CELL / 2 - grid.origin;
  return [cellOf(grid, x0), cellOf(grid, z0), cellOf(grid, x1), cellOf(grid, z0),
    cellOf(grid, x0), cellOf(grid, z1), cellOf(grid, x1), cellOf(grid, z1)];
}

/**
 * 目标点专用判据：以目标点为心、半径一整格（含 8 邻格）全部可站立。
 * 设计意图：出生点/目标点会被 AI 与导演在运行时反复取样，必须远离几何边界，
 * 否则墙角的"半格"会让它们站不住或卡住。
 */
function needStandRoom(builder, grid, x, z) {
  const ix = cellOf(grid, x);
  const iz = cellOf(grid, z);
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const px = cellCenter(grid, ix + dx);
      const pz = cellCenter(grid, iz + dz);
      if (Math.abs(px) > builder.half || Math.abs(pz) > builder.half) return -Infinity;
      if (!Number.isFinite(standHeightAt(builder, grid, px, pz))) return -Infinity;
    }
  }
  return standHeightAt(builder, grid, x, z);
}

/** 相邻单元是否可步行通行（含台阶、下落与短距离跳跃）。 */
function canTraverse(builder, grid, ax, az, bx, bz) {
  const ga = standHeightAt(builder, grid, ax, az);
  if (!Number.isFinite(ga)) return false;
  const gb = standHeightAt(builder, grid, bx, bz);
  if (!Number.isFinite(gb)) return false;
  const rise = gb - ga;
  if (rise > 1.05) return false;     // 约 28°：整平后的地形与楼梯都能过，一格厚的墙不能
  if (ga - gb > 5.5) return false;   // 落差太大，视为断路
  const dx = bx - ax;
  const dz = bz - az;
  const dist = Math.sqrt(dx * dx + dz * dz);
  const gapCells = Math.round(dist / CELL) - 1;
  if (gapCells <= 0) return true;
  if (gapCells > 2) return false;    // 最多跨 2 格（约 6m）
  for (let s = 1; s <= gapCells; s++) {
    const t = s / (gapCells + 1);
    const gm = sampleGround(grid, ax + dx * t, az + dz * t);
    // 中间塌陷到落脚面以下 => 是条缝，需要跳跃通过；否则一路平地
    if (!Number.isFinite(gm) || gm < ga - 0.65) return true;
    if (gm > ga + 0.7) return false; // 中间隆起，过不去
  }
  return true;
}

/** 四邻域方向（轴向 + 对角，对角需两侧同时可通行）。 */
const DIRS_AXIS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIRS_DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

/**
 * 从起点做粗网格可达性泛洪。
 * @returns {{ reach: Uint8Array, count:number, n:number }}
 */
function floodFrom(builder, grid, sx, sz) {
  const n = grid.n;
  const reach = new Uint8Array(n * n);
  const startX = cellOf(grid, sx);
  const startZ = cellOf(grid, sz);
  if (startX < 0 || startZ < 0 || startX >= n || startZ >= n) return { reach, count: 0, n };
  const stack = [startZ * n + startX];
  reach[startZ * n + startX] = 1;
  let count = 1;
  while (stack.length > 0) {
    const k = stack.pop();
    const iz = (k / n) | 0;
    const ix = k - iz * n;
    const ax = cellCenter(grid, ix);
    const az = cellCenter(grid, iz);
    for (let d = 0; d < 4; d++) {
      const nx = ix + DIRS_AXIS[d][0];
      const nz = iz + DIRS_AXIS[d][1];
      if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
      const nk = nz * n + nx;
      if (reach[nk]) continue;
      if (canTraverse(builder, grid, ax, az, cellCenter(grid, nx), cellCenter(grid, nz))) {
        reach[nk] = 1;
        count++;
        stack.push(nk);
      }
    }
    for (let d = 0; d < 4; d++) {
      const dx = DIRS_DIAG[d][0];
      const dz = DIRS_DIAG[d][1];
      const nx = ix + dx;
      const nz = iz + dz;
      if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
      const nk = nz * n + nx;
      if (reach[nk]) continue;
      const n1x = ix + dx;
      const n1z = iz;
      const n2x = ix;
      const n2z = iz + dz;
      const ok1 = canTraverse(builder, grid, ax, az, cellCenter(grid, n1x), cellCenter(grid, n1z)) &&
        canTraverse(builder, grid, cellCenter(grid, n1x), cellCenter(grid, n1z), cellCenter(grid, nx), cellCenter(grid, nz));
      const ok2 = canTraverse(builder, grid, ax, az, cellCenter(grid, n2x), cellCenter(grid, n2z)) &&
        canTraverse(builder, grid, cellCenter(grid, n2x), cellCenter(grid, n2z), cellCenter(grid, nx), cellCenter(grid, nz));
      if (ok1 || ok2) {
        reach[nk] = 1;
        count++;
        stack.push(nk);
      }
    }
  }
  return { reach, count, n };
}

// ---------------------------------------------------------------------------
// 7. 目标 / 撤离 / 补给 / 敌人出生点的主题词池
// ---------------------------------------------------------------------------

const OBJECTIVE_POOL = [
  { type: 'destroy', label: '摧毁热核中继' },
  { type: 'sabotage', label: '切断冷却主泵' },
  { type: 'capture', label: '夺回导航核心' },
  { type: 'sabotage', label: '瘫痪防空阵列' },
  { type: 'recover', label: '回收黑匣数据' },
  { type: 'destroy', label: '炸开熔炉闸门' },
  { type: 'capture', label: '重接轨道系缆' },
  { type: 'recover', label: '抢运浓缩燃料棒' },
  { type: 'sabotage', label: '关闭等离子导管' },
  { type: 'destroy', label: '过载磁轨压缩机' },
  { type: 'capture', label: '接管炉渣排放闸' },
  { type: 'recover', label: '取回舰体识别芯片' },
  { type: 'sabotage', label: '切断熔渣回流管' },
  { type: 'capture', label: '校准深井升降机' },
  { type: 'destroy', label: '击毁废弃炮塔核心' },
  { type: 'recover', label: '回收合金样本箱' },
];

const EXTRACT_LABELS = [
  '撤离点 · 北锚',
  '撤离点 · 东坞',
  '撤离点 · 南闸',
  '撤离点 · 西桥',
  '撤离点 · 备用升降井',
  '撤离点 · 拖船泊位',
];

const SUPPLY_LABELS = [
  '补给站 · 熔渣栈',
  '补给站 · 拆卸台',
  '补给站 · 井口仓',
  '补给站 · 系缆平台',
];

const SUPPLY_ITEMS = ['ammo', 'shield', 'health', 'alloy'];

const HAZARD_LABEL = {
  lava: '熔渣流道',
  coolant: '冷却剂喷口',
  vacuum: '真空缺口',
  radiation: '辐射区',
  acid: '酸蚀池',
  scrap: '废钢塌落区',
};

// ---------------------------------------------------------------------------
// 8. 原型布局生成器
// ---------------------------------------------------------------------------

/** 从候选点中挑一个与已有集合最远的点（最大化散布）。 */
function pickSpread(candidates, existing, rng) {
  let best = null;
  let bestScore = -Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    let minD = Infinity;
    for (let j = 0; j < existing.length; j++) {
      const e = existing[j];
      const dx = c[0] - e[0];
      const dz = c[2] - e[2];
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < minD) minD = d;
    }
    if (existing.length === 0) minD = 1e6;
    const score = minD + rng() * 6;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/** 在 builder 中投一条"楼梯"：一串小平台，确保粗网格可通行。 */
function buildStairs(b, x, z, y0, y1, dirX, dirZ, width, material) {
  const dy = y1 - y0;
  // 旧楼梯单级最高可达 1.4m，只能反复跳/翻越，环台因此几乎无法正常上楼。
  // 现在每级不超过 0.58m，低于玩家 0.64m 自动跨步能力，可连续跑上。
  const steps = Math.max(1, Math.ceil(Math.abs(dy) / 0.58));
  const run = 1.15;
  for (let s = 1; s <= steps; s++) {
    const y = y0 + (dy * s) / steps;
    const cx = x + dirX * run * s;
    const cz = z + dirZ * run * s;
    b.addPlatform(cx, y, cz, width, width, F_DECK, material || 'steel');
  }
  return [x + dirX * run * steps, y1, z + dirZ * run * steps];
}

/** 四角立柱 + 顶部平台：垂直运动的锚点。 */
function buildTower(b, x, z, y0, y1, radius, material) {
  const segs = 4;
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2 + Math.PI / 4;
    const px = x + Math.cos(a) * radius;
    const pz = z + Math.sin(a) * radius;
    b.addBox([px - 0.9, y0, pz - 0.9], [px + 0.9, y1 - 2, pz + 0.9], F_STRUCT, material || 'girder');
  }
  b.addPlatform(x, y1, z, radius * 2.6, radius * 2.6, F_DECK, material || 'steel');
}

// --- 8.1 熔炉大厅 -----------------------------------------------------------

function genFoundryHall(ctx) {
  const { b, rng, size, terrainHeight } = ctx;
  const half = size / 2;
  const floorY = 0.25;
  const coreR = clamp(size * 0.11, 12, 22);
  const deckR = coreR + 3;

  // 中央坩埚：一圈可蹬墙的炉壁 + 顶环
  b.addRing(14, coreR, 2.6, floorY, 26, 0, 0, F_STRUCT, 'furnace');
  b.addPlatform(0, 26, 0, coreR * 1.5, coreR * 1.5, F_DECK, 'furnace');
  b.addBox([-coreR * 0.5, -4, -coreR * 0.5], [coreR * 0.5, floorY, coreR * 0.5], F_STRUCT, 'furnace', { force: true });
  b.addHazard('lava', [-coreR * 0.55, -2, -coreR * 0.55], [coreR * 0.55, floorY + 0.1, coreR * 0.55], 34);
  b.landmarks.push({ kind: 'crucible', x: 0, y: 26, z: 0 });

  // 主地板：环形大平台，中心留出坩埚
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const r = deckR + (half - deckR) * 0.5;
    const px = Math.cos(a) * r * 0.86;
    const pz = Math.sin(a) * r * 0.86;
    const w = (half - deckR) * 0.5 + 4;
    b.addPlatform(px, floorY, pz, w, w, F_DECK, 'concrete');
  }

  // 四周外墙（连续墙跑面）
  const wallH = 24;
  const inset = half - 3;
  b.addBox([-inset, floorY, -inset], [inset, wallH, -inset + 2.4], F_STRUCT, 'concrete', { force: true });
  b.addBox([-inset, floorY, inset - 2.4], [inset, wallH, inset], F_STRUCT, 'concrete', { force: true });
  b.addBox([-inset, floorY, -inset], [-inset + 2.4, wallH, inset], F_STRUCT, 'concrete', { force: true });
  b.addBox([inset - 2.4, floorY, -inset], [inset, wallH, inset], F_STRUCT, 'concrete', { force: true });
  b.addWallSegment(-inset, 0, -inset, inset, 0, -inset, wallH, 2.4, F_STRUCT);

  // 立柱 + 堆叠栈桥网络（三层）
  const levels = [8, 15, 22];
  const pillars = [];
  for (let gx = -1; gx <= 1; gx += 2) {
    for (let gz = -1; gz <= 1; gz += 2) {
      const px = gx * (coreR + (half - coreR) * 0.55);
      const pz = gz * (coreR + (half - coreR) * 0.55);
      pillars.push([px, pz]);
      b.addBox([px - 2.6, floorY, pz - 2.6], [px + 2.6, 30, pz + 2.6], F_STRUCT, 'girder', { force: true });
      for (let li = 0; li < levels.length; li++) {
        b.addPlatform(px, levels[li], pz, 11, 11, F_DECK, 'grate');
      }
      b.addProp('crane', px, 30, pz, 1.2, rng() * Math.PI * 2);
    }
  }

  // 环形栈桥：连接四个立柱簇，并在不同高度错开
  for (let li = 0; li < levels.length; li++) {
    const y = levels[li];
    const spread = coreR + (half - coreR) * 0.55;
    const corners = [
      [-spread, -spread], [spread, -spread], [spread, spread], [-spread, spread],
    ];
    const insetC = corners.map((c) => [c[0] * 0.62, y + (li === 1 ? 1.4 : 0), c[1] * 0.62]);
    for (let i = 0; i < 4; i++) {
      const a = corners[i];
      const n = corners[(i + 1) % 4];
      const bend = insetC[i];
      b.addCatwalk(a[0], y, a[1], bend[0], bend[1], bend[2], 3.4, F_CATWALK);
      b.addCatwalk(bend[0], bend[1], bend[2], n[0], y, n[1], 3.4, F_CATWALK);
    }
    // 通向坩埚顶环的径向桥
    if (li === 2) {
      b.addCatwalk(spread * 0.62, y + 1.4, spread * 0.62, coreR * 0.8, 24.4, coreR * 0.8, 3.2, F_CATWALK);
    }
  }

  // 地面到二层的楼梯与坡道
  buildStairs(b, coreR + 4, -deckR - 2, floorY, levels[0], 0.15, -0.99, 3.6, 'steel');
  buildStairs(b, -deckR - 2, coreR + 4, floorY, levels[0], -0.99, 0.15, 3.6, 'steel');
  buildStairs(b, half * 0.62, half * 0.62, levels[0], levels[1], -0.72, -0.72, 3.4, 'steel');
  buildStairs(b, -half * 0.62, half * 0.62, levels[1], levels[2], 0.72, -0.72, 3.4, 'steel');

  // 地面掩体与检修槽
  for (let i = 0; i < 14; i++) {
    const a = rng() * Math.PI * 2;
    const r = deckR + 5 + rng() * (half - deckR - 12);
    const px = Math.cos(a) * r;
    const pz = Math.sin(a) * r;
    if (Math.abs(px) > half - 8 || Math.abs(pz) > half - 8) continue;
    if (rng() < 0.45) {
      b.addFence(px - 4, pz, px + 4, pz, 1.5, 1.2);
    } else {
      b.addPlatform(px, floorY + 1.1, pz, 5, 5, F_COVER, 'plate');
      b.addProp(rng() < 0.5 ? 'crate' : 'barrel', px + 2.6, floorY, pz + 2.2, 1 + rng() * 0.6, rng() * 6.28);
    }
  }

  // 检修槽（下沉通道，滑铲用）
  const trenchY = -3.2;
  b.addPlatform(0, trenchY, 0, 0, 0, F_DECK, 'steel'); // 占位，避免空数组
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const inner = coreR + 3.5;
    const outer = coreR + 3.5 + 26;
    const x0 = Math.cos(a) * inner;
    const z0 = Math.sin(a) * inner;
    const x1 = Math.cos(a) * outer;
    const z1 = Math.sin(a) * outer;
    b.addCatwalk(x0, trenchY, z0, x1, trenchY, z1, 3.2, FLAG.SOLID, 'plate');
    b.addFence(x0, z0, x1, z1, 0.9, 0.6);
  }

  b.landmarks.push({ kind: 'pillar', x: pillars[0][0], y: levels[1], z: pillars[0][1] });
  b.landmarks.push({ kind: 'pillar', x: pillars[2][0], y: levels[2], z: pillars[2][1] });
  return { floorY, wallH };
}

// --- 8.2 舰骸拆解场 ---------------------------------------------------------

function genShipBreakYard(ctx) {
  const { b, rng, size, terrainHeight } = ctx;
  const half = size / 2;
  const hulls = 3 + (rng() < 0.5 ? 1 : 0);
  const spacing = (size * 0.8) / hulls;

  for (let h = 0; h < hulls; h++) {
    const zc = -size * 0.4 + spacing * (h + 0.5);
    const len = size * (0.7 + rng() * 0.24);
    const xc = (rng() - 0.5) * size * 0.08;
    const yaw = (rng() - 0.5) * 0.22;
    const hullH = clamp(11 + rng() * 6, 10, 16.4); // 双舷间距 = 0.8*hullH ≤ 2 格跳距
    const y0 = terrainHeight(xc, zc) - 1.5;
    const thickness = 3.4;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    // 两舷：长直墙，墙跑高速走廊
    for (let side = -1; side <= 1; side += 2) {
      const oz = side * (hullH * 0.40);
      const px = xc + (-oz * s) * 0;
      const pz = zc + oz * c;
      const ax = px - c * len / 2;
      const az = pz - s * len / 2;
      const bx = px + c * len / 2;
      const bz = pz + s * len / 2;
      const [min, max] = wallAABB(px, pz, len, thickness, yaw, y0, y0 + hullH);
      b.addBox(min, max, F_STRUCT, 'hull', { margin: 0.4 });
      b.addWallSegment(ax, y0, az, bx, y0, bz, hullH, thickness, F_STRUCT);
      // 舷侧开口：留出破口让人进出（用跳板跨越）
      b.addCatwalk(ax + c * len * 0.15, y0 + hullH * 0.35, az + s * len * 0.15,
        ax + c * len * 0.15 + s * 9, y0 + hullH * 0.35, az + s * len * 0.15 + c * 9, 2.6, F_CATWALK);
    }
    // 甲板
    b.addPlatform(xc, y0 + hullH, zc, len * 0.98, hullH * 0.95, F_DECK, 'hull');
    // 甲板上的舱室与龙骨脊
    const cabins = 3 + ((rng() * 3) | 0);
    for (let i = 0; i < cabins; i++) {
      const t = (i + 0.5) / cabins - 0.5;
      const px = xc + c * len * t;
      const pz = zc + s * len * t;
      const w = 5 + rng() * 4;
      const hh = 3.4 + rng() * 2.6;
      const [min, max] = wallAABB(px, pz, w, w, yaw, y0 + hullH, y0 + hullH + hh);
      b.addBox(min, max, F_GATE, 'cabin', { margin: 0.3 });
      b.addProp('antenna', px, y0 + hullH + hh, pz, 1, rng() * 6.28);
    }
    // 斜插的断龙骨：一条倾斜坡道，兼作滑铲下坡
    const rx = xc + c * len * 0.36;
    const rz = zc + s * len * 0.36;
    b.addCatwalk(rx, y0 + hullH, rz, rx + c * 22, y0 + hullH * 0.25, rz + s * 22, 4.2, F_CATWALK);
    b.addCatwalk(rx - c * 30, y0 + 1.2, rz - s * 30, rx - c * 8, y0 + hullH * 0.62, rz - s * 8, 3.6, F_CATWALK);
    b.landmarks.push({ kind: 'hull', x: xc, y: y0 + hullH, z: zc });
  }

  // 拆解龙门吊：横跨全场的高空桥（第二层网络）
  const gantries = 2 + ((rng() * 2) | 0);
  for (let g = 0; g < gantries; g++) {
    const zc = -size * 0.36 + (size * 0.72 * (g + 0.5)) / gantries;
    const y = 24 + g * 7;
    b.addCatwalk(-half + 6, y, zc, half - 6, y, zc, 3.6, F_CATWALK);
    for (let s = -1; s <= 1; s += 2) {
      const px = s * (half - 8);
      b.addBox([px - 2, terrainHeight(px, zc) - 1, zc - 2], [px + 2, y + 2, zc + 2], F_STRUCT, 'girder', { margin: 0.3 });
      buildStairs(b, px, zc + (s > 0 ? -4 : 4) * 1.0, terrainHeight(px, zc + s * 6), y, 0, s > 0 ? -1 : 1, 3.2, 'steel');
    }
    b.addProp('crane', -half * 0.4, y, zc, 1.4, 0);
    b.landmarks.push({ kind: 'gantry', x: -half * 0.4, y, z: zc });
  }

  // 地面废料掩体
  for (let i = 0; i < 22; i++) {
    const px = (rng() - 0.5) * (size - 20);
    const pz = (rng() - 0.5) * (size - 20);
    const y = terrainHeight(px, pz);
    if (rng() < 0.5) {
      const [min, max] = wallAABB(px, pz, 5 + rng() * 6, 1.6, rng() * Math.PI, y, y + 1.4 + rng() * 1.6);
      b.addBox(min, max, F_COVER, 'plate', { margin: 0.5 });
    } else {
      b.addProp(rng() < 0.5 ? 'scrap' : 'barrel', px, y, pz, 0.9 + rng() * 0.8, rng() * 6.28);
    }
  }
  return { floorY: 0 };
}

// --- 8.3 反应堆脊柱 ---------------------------------------------------------

function genReactorSpine(ctx) {
  const { b, rng, size, terrainHeight } = ctx;
  const half = size / 2;
  const coreR = clamp(size * 0.075, 8, 15);
  const segs = 10;
  const baseY = terrainHeight(0, 0);

  // 主体：分段圆柱，层间留出蹬墙缝隙
  const bandH = 11;
  const bands = 6;
  for (let k = 0; k < bands; k++) {
    const y0 = baseY + k * bandH;
    const r = coreR + k * 0.5;
    const n = segs + (k % 2);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + k * 0.22;
      const px = Math.cos(a) * r;
      const pz = Math.sin(a) * r;
      const segLen = (2 * Math.PI * r) / n * 0.98;
      // 每隔一段开个缺口，形成攀爬入口
      if (i % 4 === 3) continue;
      const [min, max] = wallAABB(px, pz, segLen, 1.8, -a, y0, y0 + bandH - 1.6);
      b.addBox(min, max, F_STRUCT, 'reactor', { margin: 0.15 });
    }
    // 层间隔板（可站立环）
    b.addPlatform(0, y0, 0, r * 2.2, r * 2.2, F_DECK, 'grate');
  }
  const topY = baseY + bands * bandH;
  b.addPlatform(0, topY, 0, coreR * 2.4, coreR * 2.4, F_DECK, 'reactor');
  b.landmarks.push({ kind: 'spine_top', x: 0, y: topY, z: 0 });

  // 上升螺旋：环绕脊柱的中继平台，每级 2.8m
  const pads = 14;
  for (let i = 0; i < pads; i++) {
    const a = (i / pads) * Math.PI * 1.75 + 0.4;
    const r = coreR + 7 + (i % 3) * 2.2;
    const y = baseY + 3.2 + i * ((topY - baseY - 6) / pads);
    const px = Math.cos(a) * r;
    const pz = Math.sin(a) * r;
    b.addPlatform(px, y, pz, 7.5, 7.5, F_DECK, 'grate');
    // 与脊柱之间的连接跳板
    b.addCatwalk(px, y, pz, Math.cos(a + 0.35) * (coreR + 1), y - 0.6, Math.sin(a + 0.35) * (coreR + 1), 2.2, F_CATWALK);
    if (i % 3 === 0) b.addProp('beacon', px, y, pz, 1, a);
    if (i % 4 === 1) {
      // 垂直攀爬柱（可攀爬标志）
      b.addBox([px - 1.2, y - 12, pz - 1.2], [px + 1.2, y, pz + 1.2], F_LADDER, 'ladder', { margin: 0.2 });
    }
  }
  b.landmarks.push({ kind: 'helix', x: coreR + 9, y: baseY + 20, z: 0 });

  // 外层锚环：一圈高墙，制造环形墙跑赛道
  const ringR = half - 14;
  b.addRing(20, ringR, 2.6, baseY - 0.5, baseY + 26, 0, 0, F_STRUCT, 'concrete');
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const px = Math.cos(a) * ringR;
    const pz = Math.sin(a) * ringR;
    // 从外环伸向中心的栈桥
    const y = baseY + 6 + (i % 4) * 4;
    b.addCatwalk(px, y, pz, Math.cos(a) * (coreR + 12), y + 1.2, Math.sin(a) * (coreR + 12), 3.0, F_CATWALK);
    b.addProp('pylon', px, baseY + 26, pz, 1.2, a);
  }

  // 地面：支撑区与货架
  for (let i = 0; i < 16; i++) {
    const a = rng() * Math.PI * 2;
    const r = coreR + 12 + rng() * (ringR - coreR - 20);
    const px = Math.cos(a) * r;
    const pz = Math.sin(a) * r;
    const y = terrainHeight(px, pz);
    if (rng() < 0.5) {
      b.addPlatform(px, y + 1.2, pz, 6, 6, F_COVER, 'plate');
      b.addProp('crate', px + 3, y, pz, 1.2, rng() * 6.28);
    } else {
      b.addFence(px - 5, pz, px + 5, pz, 1.4, 1.0);
    }
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.3;
    const px = Math.cos(a) * (coreR + 10);
    const pz = Math.sin(a) * (coreR + 10);
    buildStairs(b, px, pz, terrainHeight(px, pz), baseY + 3.2, -Math.cos(a) * 0.4, -Math.sin(a) * 0.4, 3.4, 'steel');
  }
  return { floorY: 0 };
}

// --- 8.4 峡谷管线 -----------------------------------------------------------

function genCanyonPipeline(ctx) {
  const { b, rng, size, terrainHeight } = ctx;
  const half = size / 2;
  const canyonZ = 0;
  const canyonR = size * 0.16;
  const floorY = terrainHeight(0, canyonZ) - 8;

  // 峡谷内的大型管线主干
  for (let p = -1; p <= 1; p++) {
    const zz = canyonZ + p * 6;
    const y = floorY + 1.6;
    const [min, max] = wallAABB(0, zz, size * 1.02, 4.4, 0, y - 2.6, y);
    b.addBox(min, max, F_STRUCT, 'pipe', { force: true });
    b.addProp('pipe', -size * 0.3, y, zz, 1.6, 0);
    b.addProp('pipe', size * 0.3, y, zz, 1.6, 0);
  }
  // 管线顶部即为峡谷地面走廊
  b.addPlatform(0, floorY + 1.6, canyonZ, size * 1.0, 22, F_DECK, 'pipe');

  // 跨越峡谷的管桥（多个高度，形成立体的过桥选择）
  const bridges = 4;
  for (let i = 0; i < bridges; i++) {
    const t = (i + 0.5) / bridges - 0.5;
    const x = t * size * 0.82;
    const y = floorY + 9 + i * 5.5 + (i % 2) * 2.2;
    const z0 = canyonZ - canyonR - 12;
    const z1 = canyonZ + canyonR + 12;
    b.addCatwalk(x, y, z0, x, y, z1, 3.4, F_CATWALK);
    b.addProp('pipe', x + 4, y - 1.4, z0 + 6, 1.2, Math.PI / 2);
    b.landmarks.push({ kind: 'pipe_bridge', x, y, z: z0 });
    // 桥下支撑柱
    b.addBox([x - 1.4, floorY, z0 + 4], [x + 1.4, y - 0.5, z0 + 6.8], F_STRUCT, 'girder', { force: true });
    b.addBox([x - 1.4, floorY, z1 - 6.8], [x + 1.4, y - 0.5, z1 - 4], F_STRUCT, 'girder', { force: true });
  }

  // 峡谷两侧的崖顶厂区
  for (let s = -1; s <= 1; s += 2) {
    const zc = s * (canyonR + 26);
    for (let i = 0; i < 7; i++) {
      const x = -half + 24 + i * ((size - 48) / 6);
      const y = terrainHeight(x, zc);
      const w = 10 + rng() * 8;
      const h = 6 + rng() * 9;
      const [min, max] = wallAABB(x, zc + (rng() - 0.5) * 12, w, w * 0.7, 0, y, y + h);
      b.addBox(min, max, F_GATE, 'concrete', { margin: 0.4 });
      b.addPlatform(x, y + h, zc + (rng() - 0.5) * 10, w * 1.5, w, F_DECK, 'roof');
      // 屋顶连廊
      if (i > 0) {
        b.addCatwalk(x - ((size - 48) / 6), y + h, zc, x, y + h + 1.5, zc, 2.6, F_CATWALK);
      }
    }
    // 崖壁上的垂直检修梯
    for (let i = 0; i < 5; i++) {
      const x = -half + 40 + i * ((size - 80) / 4);
      const yTop = terrainHeight(x, zc);
      const yBot = floorY + 2;
      b.addBox([x - 1.4, yBot, zc - s * 2.6], [x + 1.4, yTop + 1, zc - s * 1.2], F_LADDER, 'ladder', { margin: 0.2 });
      b.landmarks.push({ kind: 'ladder', x, y: yTop, z: zc - s * 2.6 });
    }
  }

  // 峡谷底：滑铲隧道与货箱
  for (let i = 0; i < 14; i++) {
    const x = (rng() - 0.5) * (size * 0.85);
    const z = canyonZ + (rng() - 0.5) * canyonR * 1.3;
    const y = floorY + 1.6;
    if (rng() < 0.5) {
      b.addPlatform(x, y + 1.3, z, 6.5, 6.5, F_COVER, 'plate');
      b.addProp('barrel', x + 3, y, z, 1.1, rng() * 6.28);
    } else {
      const [min, max] = wallAABB(x, z, 7 + rng() * 5, 1.4, 0, y, y + 2.2);
      b.addBox(min, max, F_COVER, 'plate', { margin: 0.4 });
    }
  }

  // 高架输送管：从崖顶斜插进峡谷的滑道
  for (let s = -1; s <= 1; s += 2) {
    const zTop = s * (canyonR + 20);
    const x = s * size * 0.24;
    const yTop = terrainHeight(x, zTop) + 8;
    b.addCatwalk(x, yTop, zTop, x * 0.55, floorY + 4.5, s * (canyonR * 0.4), 4.0, F_CATWALK);
  }
  return { floorY };
}

// --- 8.5 集装箱堆场 ---------------------------------------------------------

function genStorageBlocks(ctx) {
  const { b, rng, size, terrainHeight } = ctx;
  const half = size / 2;
  const cols = 5;
  const spacing = (size - 30) / cols;
  const halfW = spacing * 0.30;
  const boxW = spacing * 0.60;
  const cellH = 3.2;

  const towers = [];
  for (let ix = 0; ix < cols; ix++) {
    for (let iz = 0; iz < cols; iz++) {
      if (b.boxes.length > 216) break; // 为巷道/隧道/塔楼预留盒预算
      const cx = -half + 16 + (ix + 0.5) * spacing;
      const cz = -half + 16 + (iz + 0.5) * spacing;
      const y0 = terrainHeight(cx, cz);
      const stack = 1 + ((rng() * 4.6) | 0);
      const th = 0.7;
      for (let k = 0; k < stack; k++) {
        const y = y0 + k * cellH;
        // 每层开一个方向的缺口：竖直方向形成可攀爬的错位通道
        const openSide = (ix + iz + k) % 4;
        const sides = [
          [cx, cz - halfW, boxW, th, 0],
          [cx, cz + halfW, boxW, th, 0],
          [cx - halfW, cz, th, boxW, Math.PI / 2],
          [cx + halfW, cz, th, boxW, Math.PI / 2],
        ];
        for (let s = 0; s < 4; s++) {
          if (s === openSide) continue;
          const [min, max] = wallAABB(sides[s][0], sides[s][1], sides[s][2], sides[s][3], sides[s][4], y, y + cellH);
          b.addBox(min, max, s === 0 ? F_GATE : F_STRUCT, 'container', { margin: 0.25 });
        }
        b.addPlatform(cx, y + cellH, cz, boxW * 1.02, boxW * 1.02, F_DECK, 'container');
        // 外侧蹬墙条：让每一层都能靠墙跑攀上去
        b.addBox([cx - halfW - 0.5, y + 0.8, cz - halfW * 0.6], [cx - halfW + 0.1, y + cellH - 0.4, cz + halfW * 0.6], F_STRUCT, 'rib', { margin: 0.1 });
        b.addBox([cx + halfW - 0.1, y + 0.8, cz - halfW * 0.6], [cx + halfW + 0.5, y + cellH - 0.4, cz + halfW * 0.6], F_STRUCT, 'rib', { margin: 0.1 });
      }
      towers.push([cx, y0 + stack * cellH, cz, stack]);
      if (rng() < 0.6) b.addProp('container', cx, y0, cz, 1, rng() * 6.28);
    }
  }

  // 巷道之间的高空连廊（顶部网络）
  for (let iz = 0; iz < cols; iz++) {
    const cz = -half + 16 + (iz + 0.5) * spacing;
    const y = 17 + (iz % 3) * 3.4;
    b.addCatwalk(-half + 12, y, cz, half - 12, y, cz, 2.8, F_CATWALK);
  }
  for (let ix = 0; ix < cols; ix += 2) {
    const cx = -half + 16 + (ix + 0.5) * spacing;
    const y = 21 + ((ix / 2) % 2) * 3.6;
    b.addCatwalk(cx, y, -half + 12, cx, y, half - 12, 2.8, F_CATWALK);
  }

  // 地面滑铲隧道：两墙 + 顶板，净高 1.7m
  const tunnels = 3;
  for (let i = 0; i < tunnels; i++) {
    const t = (i + 0.5) / tunnels - 0.5;
    const z = t * size * 0.86;
    const y = terrainHeight(0, z);
    const len = size * 0.86;
    const [minA, maxA] = wallAABB(0, z - 1.6, len, 0.8, 0, y, y + 1.7);
    const [minB, maxB] = wallAABB(0, z + 1.6, len, 0.8, 0, y, y + 1.7);
    b.addBox(minA, maxA, FLAG.SOLID, 'tunnel', { margin: 0.2 });
    b.addBox(minB, maxB, FLAG.SOLID, 'tunnel', { margin: 0.2 });
    const [minC, maxC] = wallAABB(0, z, len, 4.0, 0, y + 1.7, y + 2.2);
    b.addBox(minC, maxC, F_DECK, 'tunnel', { margin: 0.2 });
    b.addWallSegment(-len / 2, y, z, len / 2, y, z, 2.2, 4, FLAG.SOLID);
  }

  // 攀爬塔：把巷道连到顶部网络
  for (let i = 0; i < 3; i++) {
    const x = -half + 24 + i * ((size - 48) / 2);
    const z = (i % 2 === 0 ? 1 : -1) * (half - 18);
    const y0 = terrainHeight(x, z);
    buildTower(b, x, z, y0, 24 + i * 2, 3.2, 'girder');
    buildStairs(b, x, z + 6, y0, 8.5, 0, -1, 3.2, 'steel');
    buildStairs(b, x + 6, z, 8.5, 17, -1, 0, 3.2, 'steel');
  }

  // 地面零星掩体
  for (let i = 0; i < 12; i++) {
    const px = (rng() - 0.5) * (size - 24);
    const pz = (rng() - 0.5) * (size - 24);
    const y = terrainHeight(px, pz);
    if (rng() < 0.5) {
      b.addFence(px - 4.5, pz, px + 4.5, pz, 1.3, 1.0);
    } else {
      b.addProp(rng() < 0.5 ? 'crate' : 'scrap', px, y, pz, 0.9 + rng() * 0.7, rng() * 6.28);
    }
  }
  if (towers.length > 0) b.landmarks.push({ kind: 'stack', x: towers[0][0], y: towers[0][1], z: towers[0][2] });
  b.landmarks.push({ kind: 'stack', x: towers[towers.length - 1][0], y: towers[towers.length - 1][1], z: towers[towers.length - 1][2] });
  return { floorY: 0 };
}

// --- 8.6 锚环站 -------------------------------------------------------------

function genAnchorRing(ctx) {
  const { b, rng, size, terrainHeight } = ctx;
  const half = size / 2;
  const pitR = size * 0.15;
  const ringR = half - 16;
  const pitY = -18;
  const rimY = 1.5;

  // 中央深井：内衬可蹬墙，井底是可站立的检修层
  b.addRing(18, pitR, 2.4, pitY, rimY + 5, 0, 0, F_STRUCT, 'anchor');
  b.addPlatform(0, pitY, 0, pitR * 2.0, pitR * 2.0, F_DECK, 'anchor');
  b.addHazard('vacuum', [-pitR * 0.42, pitY, -pitR * 0.42], [pitR * 0.42, pitY + 0.6, pitR * 0.42], 30);
  b.landmarks.push({ kind: 'pit', x: 0, y: pitY, z: 0 });

  // 井口环廊：留下四个通向外圈的开口
  const gapAngles = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    let hasGap = false;
    for (const g of gapAngles) {
      if (Math.abs(Math.atan2(Math.sin(a - g), Math.cos(a - g))) < 0.16) hasGap = true;
    }
    if (hasGap) continue;
    const px = Math.cos(a) * (pitR + 6);
    const pz = Math.sin(a) * (pitR + 6);
    b.addPlatform(px, rimY, pz, 10, 10, F_DECK, 'anchor');
  }

  // 外环：巨大的环墙 + 环廊，构成 360° 墙跑赛道
  b.addRing(26, ringR, 3.0, rimY - 12, rimY + 22, 0, 0, F_STRUCT, 'anchor');
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    const px = Math.cos(a) * (ringR - 8);
    const pz = Math.sin(a) * (ringR - 8);
    b.addPlatform(px, rimY + 12 + (i % 4) * 2.5, pz, 11, 11, F_DECK, 'grate');
  }

  // 四根系缆臂：从环伸向中心的阶梯，逐步升高
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    let y = rimY + 4;
    const r0 = ringR - 10;
    const r1 = pitR + 7;
    const steps = 7;
    for (let s = 0; s < steps; s++) {
      const t0 = s / steps;
      const t1 = (s + 1) / steps;
      const rr = r0 + (r1 - r0) * ((t0 + t1) / 2);
      const px = ca * rr;
      const pz = sa * rr;
      y = rimY + 4 + s * 2.6;
      b.addPlatform(px, y, pz, 8, 8, F_DECK, 'grate');
    }
    // 缆索塔
    b.addBox([ca * (ringR - 6) - 2.2, rimY, sa * (ringR - 6) - 2.2],
      [ca * (ringR - 6) + 2.2, rimY + 46, sa * (ringR - 6) + 2.2], F_STRUCT, 'tether', { margin: 0.4 });
    b.addProp('tether', ca * (ringR - 6), rimY + 46, sa * (ringR - 6), 1.6, a);
    b.landmarks.push({ kind: 'tether', x: ca * (ringR - 6), y: rimY + 46, z: sa * (ringR - 6) });

    // 跨井主桥（两端落在井口环廊上）
    if (k < 2) {
      const bx = ca * (ringR - 4);
      const bz = sa * (ringR - 4);
      const y2 = rimY + 2 + k * 6;
      b.addCatwalk(bx, y2, bz, -bx * 0.55, y2, -bz * 0.55, 3.6, F_CATWALK);
      b.addCatwalk(-bx * 0.55, y2, -bz * 0.55, -bx, y2 + 2.4, -bz, 3.6, F_CATWALK);
    }
  }

  // 井底到环廊的螺旋爬升（保证井底也连通）
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 1.5;
    const r = pitR - 2 - (i % 3) * 1.2;
    const y = pitY + 1.5 + i * ((rimY - pitY) / 12);
    b.addPlatform(Math.cos(a) * r, y, Math.sin(a) * r, 6, 6, F_DECK, 'grate');
  }

  // 外环到地面的坡道与掩体
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.2;
    const px = Math.cos(a) * (ringR + 5);
    const pz = Math.sin(a) * (ringR + 5);
    b.addFence(px - 6, pz, px + 6, pz, 1.4, 1.2);
    b.addProp('crate', px + 4, terrainHeight(px, pz), pz + 4, 1.1, a);
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.5;
    const px = Math.cos(a) * (pitR + 14);
    const pz = Math.sin(a) * (pitR + 14);
    buildStairs(b, px, pz, rimY, rimY + 6, -Math.cos(a) * 0.5, -Math.sin(a) * 0.5, 3.4, 'steel');
  }
  return { floorY: 0 };
}

/** 原型表。 */
const ARCHETYPES = Object.freeze({
  foundry_hall: Object.freeze({ id: 'foundry_hall', name: '熔炉大厅', desc: '室内大厅，堆叠栈桥环绕中央坩埚。', build: genFoundryHall, sizeMul: 1.0 }),
  ship_break_yard: Object.freeze({ id: 'ship_break_yard', name: '舰骸拆解场', desc: '搁浅舰体的长直舷侧，天然的高速墙跑走廊。', build: genShipBreakYard, sizeMul: 1.05 }),
  reactor_spine: Object.freeze({ id: 'reactor_spine', name: '反应堆脊柱', desc: '中央高塔 + 上升环带，靠跳板与蹬墙攀升。', build: genReactorSpine, sizeMul: 0.92 }),
  canyon_pipeline: Object.freeze({ id: 'canyon_pipeline', name: '峡谷管线', desc: '深切峡谷与多层管桥，垂直落差极大。', build: genCanyonPipeline, sizeMul: 1.1 }),
  storage_blocks: Object.freeze({ id: 'storage_blocks', name: '集装箱堆场', desc: '密集集装箱迷宫，地面滑铲隧道与顶部连廊并行。', build: genStorageBlocks, sizeMul: 0.9 }),
  anchor_ring: Object.freeze({ id: 'anchor_ring', name: '锚环站', desc: '围绕中央深井的巨型环廊与系缆臂。', build: genAnchorRing, sizeMul: 1.0 }),
});

/** 原型 id 列表。 */
export const ARCHETYPE_IDS = Object.freeze(Object.keys(ARCHETYPES));

// ---------------------------------------------------------------------------
// 9. 生成主流程
// ---------------------------------------------------------------------------

/** 遍历所有单元，返回可站立单元列表 {ix,iz,x,z,y}。（按 y 降序、索引升序）
 *  只收集落在 ±size/2 之内的单元——网格为覆盖整格会外扩半格，那部分不属于场地。 */
function collectFreeCells(b, grid) {
  const n = grid.n;
  const half = b.half;
  const out = [];
  for (let iz = 1; iz < n - 1; iz++) {
    const z = cellCenter(grid, iz);
    if (z < -half || z > half) continue;
    for (let ix = 1; ix < n - 1; ix++) {
      const x = cellCenter(grid, ix);
      if (x < -half || x > half) continue;
      const y = standHeightAt(b, grid, x, z);
      if (Number.isFinite(y)) out.push({ ix, iz, x, z, y });
    }
  }
  out.sort((p, q2) => (q2.y - p.y) || (p.iz - q2.iz) || (p.ix - q2.ix));
  return out;
}

/**
 * 在自由单元里按"最小间距 + 额外条件"贪心取样。
 * 第一遍严格满足间距，第二遍放宽间距后再补一次，保证数量达标且分布均匀。
 */
function pickCells(free, reach, n, want, minDist, filter, preferred) {
  const pool = preferred && preferred.length > 0 ? preferred : free;
  const chosen = [];
  const take = (c, dist) => {
    for (let j = 0; j < chosen.length; j++) {
      const o = chosen[j];
      const dx = c.x - o.x;
      const dz = c.z - o.z;
      if (dx * dx + dz * dz < dist * dist) return false;
    }
    if (filter && !filter(c)) return false;
    chosen.push(c);
    return true;
  };
  for (let i = 0; i < pool.length && chosen.length < want; i++) take(pool[i], minDist);
  if (chosen.length < want) {
    for (let i = 0; i < pool.length && chosen.length < want; i++) take(pool[i], minDist * 0.55);
  }
  return chosen;
}

/** 按到地图中心的距离排序候选（rim=true 时由外向内）。 */
function radialCandidates(free, size, rim) {
  const half = size / 2;
  return free.slice().sort((a, c) => {
    const da = rim ? Math.max(Math.abs(a.x), Math.abs(a.z)) : Math.hypot(a.x, a.z);
    const db = rim ? Math.max(Math.abs(c.x), Math.abs(c.z)) : Math.hypot(c.x, c.z);
    const diff = rim ? db - da : da - db;
    if (diff !== 0) return diff;
    return (a.iz - c.iz) || (a.ix - c.ix);
  });
}

/** 玩家出生点：每个分区取一个可达单元，保证互相拉开且都落在同一连通区。 */
function placePlayerSpawns(b, grid, freeAll, regions, size, rng) {
  const seen = new Set();
  const out = [];
  const occupied = [];
  for (let r = 0; r < regions.length && out.length < 4; r++) {
    const rx = regions[r][0];
    const rz = regions[r][1];
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < freeAll.length; i++) {
      const c = freeAll[i];
      if (seen.has((c.iz << 12) ^ c.ix)) continue;
      let tooClose = false;
      for (let j = 0; j < occupied.length; j++) {
        const dx = occupied[j].x - c.x;
        const dz = occupied[j].z - c.z;
        if (dx * dx + dz * dz < 30 * 30) { tooClose = true; break; }
      }
      if (tooClose) continue;
      const dx = c.x - rx;
      const dz = c.z - rz;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = c; }
    }
    if (!best) continue;
    if (bestD > (size * 0.30) * (size * 0.30)) continue; // 该分区完全没有落脚点
    seen.add((best.iz << 12) ^ best.ix);
    occupied.push(best);
    out.push({
      pos: [q(best.x), q(best.y), q(best.z)],
      yaw: q(rng() * Math.PI * 2),
    });
  }
  return out;
}

/** 距离某个点集的最小水平距离。 */
function minDistTo(point, list) {
  let best = Infinity;
  for (let i = 0; i < list.length; i++) {
    const dx = point[0] - list[i][0];
    const dz = point[2] - list[i][2];
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < best) best = d;
  }
  return best;
}

/**
 * 清理建筑核心区：移除挡住站位的小体量（<5m）结构，并重算该单元的可站立面。
 * 被移除的盒子打上 _carved 标记，assembleMap 会把它们从 JSON 里剔除，
 * 这样连通性自检能从 JSON 重建出同一份几何。
 */
function carveCore(b, grid, cx, cz, radius) {
  const n = grid.n;
  const [ix0, ix1] = cellRange(grid.origin, cx - radius, cx + radius);
  const [iz0, iz1] = cellRange(grid.origin, cz - radius, cz + radius);
  const lo = b.heightFn(cx, cz) - 1.2;
  const hi = b.heightFn(cx, cz) + 3.4;
  let carved = 0;
  for (let bi = 0; bi < b.boxes.length; bi++) {
    const box = b.boxes[bi];
    if (box._carved) continue;
    const th = box.max[1] - box.min[1];
    if (!(box.max[1] > lo && box.min[1] < hi && th < 5)) continue;
    const [bx0, bx1] = cellRange(grid.origin, box.min[0], box.max[0]);
    const [bz0, bz1] = cellRange(grid.origin, box.min[2], box.max[2]);
    if (bx1 < ix0 || bx0 > ix1 || bz1 < iz0 || bz0 > iz1) continue;
    box._carved = true;
    carved++;
  }
  if (carved === 0) return;
  // 重建占据表，避免被删盒子的区间继续挡住判定
  for (let i = 0; i < b.occ.length; i++) b.occ[i] = null;
  for (let bi = 0; bi < b.boxes.length; bi++) {
    const box = b.boxes[bi];
    if (box._carved) continue;
    b.occupy(box.min, box.max);
  }
  for (let iz = iz0; iz <= iz1; iz++) {
    if (iz < 0 || iz >= n) continue;
    for (let ix = ix0; ix <= ix1; ix++) {
      if (ix < 0 || ix >= n) continue;
      const k = iz * n + ix;
      // 重算该格：可能露出地形，也可能露出下方更高的顶面
      grid.solid[k] = 0;
      grid.ground[k] = -Infinity;
      const px = cellCenter(grid, ix);
      const pz = cellCenter(grid, iz);
      const base = b.heightFn(px, pz);
      const cx0 = px - CELL / 2;
      const cx1 = px + CELL / 2;
      const cz0 = pz - CELL / 2;
      const cz1 = pz + CELL / 2;
      let ground = base;
      const ignore = [];
      let solidHit = false;
      for (let bi = 0; bi < b.boxes.length; bi++) {
        const box = b.boxes[bi];
        if (box._carved) continue;
        if (!(box.max[0] > cx0 && box.min[0] < cx1)) continue;
        if (!(box.max[2] > cz0 && box.min[2] < cz1)) continue;
        const top = box.max[1];
        const isDeck = (box.flags & FLAG.PLATFORM) !== 0;
        const walkableTop = isDeck || (top - box.min[1]) <= REACH_H;
        if (!walkableTop && top > ground) {
          solidHit = true;
          break;
        }
        ignore.push(top);
      }
      if (solidHit) {
        grid.solid[k] = 1;
        grid.ground[k] = -Infinity;
        continue;
      }
      for (let bi = 0; bi < b.boxes.length; bi++) {
        const box = b.boxes[bi];
        if (box._carved) continue;
        if (!(box.max[0] > cx0 && box.min[0] < cx1)) continue;
        if (!(box.max[2] > cz0 && box.min[2] < cz1)) continue;
        const top = box.max[1];
        const covers = box.min[0] <= cx0 && box.max[0] >= cx1 && box.min[2] <= cz0 && box.max[2] >= cz1;
        if (top > ground && covers && !b.cellBlocked(ix, iz, top + 0.05, top + REACH_H, ignore)) ground = top;
      }
      grid.ground[k] = ground;
    }
  }
}

/**
 * 把某个目标点吸附到合格的格心：从原点向外做环形搜索，取第一个
 * "在连通区内 + 目标判据通过"的格心。吸附结果必定落在格心上，
 * 保证生成期判定与自检判定评价的是同一组采样点。
 * @returns {{x:number,y:number,z:number}|null}
 */
function snapTargetToRegion(b, grid, x, z, reachInfo) {
  const cx = cellOf(grid, x);
  const cz = cellOf(grid, z);
  const maxRing = 48;
  for (let ring = 0; ring <= maxRing; ring++) {
    const per = ring === 0 ? 1 : ring * 8;
    for (let i = 0; i < per; i++) {
      const a = (i / per) * Math.PI * 2;
      const ix = cx + Math.round(Math.cos(a) * ring);
      const iz = cz + Math.round(Math.sin(a) * ring);
      if (ix < 0 || iz < 0 || ix >= grid.n || iz >= grid.n) continue;
      const px = cellCenter(grid, ix);
      const pz = cellCenter(grid, iz);
      if (Math.abs(px) > b.half || Math.abs(pz) > b.half) continue;
      if (!reachAt(reachInfo, ix, iz)) continue;
      const y = needStandRoom(b, grid, px, pz);
      if (!Number.isFinite(y)) continue;
      return { x: q(px), y: q(y), z: q(pz) };
    }
  }
  return null;
}

/** 逐个目标做连通性修复：不可达则吸附到最近的合法单元。 */
function repairTargets(b, grid, free, targets, reachInfo) {
  let repairs = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const p = t.pos;
    const ix = cellOf(grid, p[0]);
    const iz = cellOf(grid, p[2]);
    let ok = false;
    if (ix >= 0 && iz >= 0 && ix < grid.n && iz < grid.n && reachAt(reachInfo, ix, iz)) {
      const room = needStandRoom(b, grid, p[0], p[2]);
      if (Number.isFinite(room)) ok = true;
    }
    if (!ok) {
      const hit = snapTargetToRegion(b, grid, p[0], p[2], reachInfo);
      if (hit) {
        p[0] = hit.x;
        p[1] = hit.y;
        p[2] = hit.z;
        repairs++;
      }
    }
  }
  return repairs;
}

/** 检查所有目标是否落在可达区域内，并且四周有完整站位。 */
function verifyTargets(b, grid, reachInfo, targets) {
  for (let i = 0; i < targets.length; i++) {
    const p = targets[i].pos;
    const ix = cellOf(grid, p[0]);
    const iz = cellOf(grid, p[2]);
    if (ix < 0 || iz < 0 || ix >= grid.n || iz >= grid.n) return false;
    if (!reachInfo.reach[iz * grid.n + ix]) return false;
    if (!Number.isFinite(needStandRoom(b, grid, p[0], p[2]))) return false;
  }
  return true;
}

/**
 * 碰撞盒预算控制：超出契约上限时，优先删除"体积最小"的装饰性盒子。
 * 生成期与自检必须落在同一份几何上，所以这里只打 _carved 标记，
 * 真正的剔除由 assembleMap 完成。
 * @returns {number} 被丢弃的数量
 */
function fitBoxBudget(b, maxBoxes) {
  const alive = [];
  for (let i = 0; i < b.boxes.length; i++) {
    if (!b.boxes[i]._carved) alive.push(i);
  }
  if (alive.length <= maxBoxes) return 0;
  alive.sort((i, j) => {
    const a = b.boxes[i];
    const c = b.boxes[j];
    const va = (a.max[0] - a.min[0]) * (a.max[1] - a.min[1]) * (a.max[2] - a.min[2]);
    const vc = (c.max[0] - c.min[0]) * (c.max[1] - c.min[1]) * (c.max[2] - c.min[2]);
    return (va - vc) || (i - j);
  });
  let excess = alive.length - maxBoxes;
  let dropped = 0;
  for (let k = 0; k < alive.length && excess > 0; k++, excess--) {
    b.boxes[alive[k]]._carved = true;
    dropped++;
  }
  return dropped;
}

/**
 * 生成一张完整地图（契约 8.1 格式）。
 * @param {{seed?:number, biome?:string, size?:number, tier?:number, archetype?:string}} opts
 * @returns {object} 地图 JSON
 */
export function generateMap(opts) {
  const o = opts || {};
  const seed = (o.seed == null ? 1337 : o.seed | 0) >>> 0;
  const biome = getBiome(o.biome);
  const tier = clamp(o.tier == null ? 1 : o.tier | 0, 1, 10);
  const requested = o.archetype && ARCHETYPES[o.archetype]
    ? ARCHETYPES[o.archetype]
    : ARCHETYPES[ARCHETYPE_IDS[seed % ARCHETYPE_IDS.length]];
  const size = clamp(Math.round((o.size == null ? 200 + tier * 18 : o.size) * requested.sizeMul / 2) * 2, 140, 400);

  const maxAttempts = 10;
  let fallback = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const attemptSeed = (seed + attempt * 0x9e3779b1) >>> 0;
    const rng = mulberry32(attemptSeed);
    const terrain = buildGradedTerrainSpec(size, biome, attemptSeed, tier);
    // 危险区先于高度函数确定：池底下切会同时进入导航、碰撞和渲染，
    // 不再是地图完成后临时盖上去的一层“发光地毯”。使用独立 RNG，避免改变原型布局序列。
    const hazardPlan = planHazards(size, biome, attemptSeed);
    terrain.hazardBasins = hazardPlan.map((h) => ({
      x: h.x, z: h.z, w: h.w, d: h.d,
      basinDepth: h.basinDepth, rimWidth: h.rimWidth,
      kind: h.kind, shapeSeed: h.shapeSeed,
    }));
    const heightFn = makeHeightFn(terrain);
    const b = new MapBuilder(size, heightFn);
    b.landmarks.push({ kind: 'core', x: 0, y: heightFn(0, 0), z: 0 });
    const ctx = {
      b, rng, size, half: size / 2, tier, biome, terrain,
      heightFn, terrainHeight: (x, z) => heightFn(x, z), terrainSeed: attemptSeed,
    };

    const outline = requested.build(ctx) || {};
    // 静态承重结构必须落地：把悬空的墙/柱/设备吸附到地面
    if (outline.snap !== false) snapToGround(b);
    // 先在几何层面满足盒预算，后续所有判定都基于这份几何
    fitBoxBudget(b, MAX_BOXES);
    const grid = buildGroundGrid(b);
    if (outline.clears && outline.clears.length > 0) {
      for (let i = 0; i < outline.clears.length; i++) {
        const c = outline.clears[i];
        carveCore(b, grid, c[0], c[2], c[3]);
      }
    }

    const freeAll = collectFreeCells(b, grid);
    if (freeAll.length < 160) continue;

    // --- 主连通区：从若干候选种子泛洪，取最大的一块作为"可行走主场" ---
    let main = null;
    for (let i = 0; i < freeAll.length; i += 211) {
      const c = freeAll[i];
      const r = floodFrom(b, grid, c.x, c.z);
      if (!main || r.count > main.reach.count) main = { root: c, reach: r };
      if (main.reach.count > freeAll.length * 0.72) break;
    }
    if (!main || main.reach.count < MIN_FREE_RATIO * freeAll.length) continue;
    const reachInfo = main.reach;
    // 只保留"从主区起点真的走得到"的单元；后续所有放置都在此列表内取样
    // 任务、出生和补给必须落在危险区岸线之外；危险区仍属于连续地形，玩家可自行进入。
    const free = freeAll.filter((c) => reachAt(reachInfo, c.ix, c.iz)
      && !insideHazardPlan(c.x, c.z, hazardPlan, 2.5));
    if (free.length < 100) continue;

    // --- 玩家出生点：3x3 区域各取一点，全部落在主连通区内 ---
    const regions = [];
    const regionSpan = size * 0.32;
    for (let gx = -1; gx <= 1; gx++) {
      for (let gz = -1; gz <= 1; gz++) {
        regions.push([gx * regionSpan, gz * regionSpan]);
      }
    }
    const pspawns = placePlayerSpawns(b, grid, free, regions, size, rng);
    if (pspawns.length < 2) continue;
    const root = pspawns[0].pos;

    // --- 敌人出生点：距所有玩家出生点 > 25m ---
    const pspawnPos = pspawns.map((p) => p.pos);
    const spawnList = pickCells(free, reachInfo.reach, reachInfo.n, 16, 15, (c) => {
      if (minDistTo([c.x, c.y, c.z], pspawnPos) < ENEMY_SPAWN_MIN_DIST) return false;
      const dx = c.x - root[0];
      const dz = c.z - root[2];
      return dx * dx + dz * dz > (ENEMY_SPAWN_MIN_DIST + 3) * (ENEMY_SPAWN_MIN_DIST + 3);
    }, (() => {
      const s = (attemptSeed % free.length) | 0;
      return free.slice(s).concat(free.slice(0, s));
    })());
    if (spawnList.length < 8) continue;

    // --- 目标点：优先靠近地标，彼此拉开，且避开出生点 ---
    const objCount = clamp(3 + (rng() * 4 | 0), 3, 6);
    const objOrder = radialCandidates(free, size, false);
    const nearSpawn = (c) => minDistTo([c.x, c.y, c.z], pspawnPos) > 15;
    let objCells = pickCells(free, reachInfo.reach, reachInfo.n, objCount, size * 0.22,
      (c) => nearSpawn(c) && nearLandmark(b, c, 55), objOrder);
    if (objCells.length < 3) {
      objCells = pickCells(free, reachInfo.reach, reachInfo.n, objCount, size * 0.22, nearSpawn, objOrder);
    }
    const labelOffset = (attemptSeed + tier) % OBJECTIVE_POOL.length;
    const objectives = [];
    for (let i = 0; i < objCells.length && objectives.length < objCount; i++) {
      const c = objCells[i];
      const def = OBJECTIVE_POOL[(labelOffset + i * 3) % OBJECTIVE_POOL.length];
      objectives.push({
        id: 'obj_' + i + '_' + def.type,
        type: def.type,
        label: def.label,
        pos: [q(c.x), q(c.y), q(c.z)],
        radius: q(4 + rng() * 3),
        required: i < 2,
      });
    }
    if (objectives.length < 3) continue;

    // --- 撤离点：地图外缘，2~4 个 ---
    const extractCount = clamp(2 + (rng() * 3 | 0), 2, 4);
    const extractPoints = [];
    const rimOrder = radialCandidates(free, size, true);
    const rimCells = pickCells(free, reachInfo.reach, reachInfo.n, extractCount, size * 0.30, null, rimOrder);
    for (let i = 0; i < rimCells.length && extractPoints.length < extractCount; i++) {
      const c = rimCells[i];
      extractPoints.push({
        pos: [q(c.x), q(c.y), q(c.z)],
        radius: q(6 + rng() * 2),
        label: EXTRACT_LABELS[(i + attemptSeed) % EXTRACT_LABELS.length],
      });
    }
    if (extractPoints.length < 2) continue;

    // --- 补给站：2~3 个，离出生点不远也不近 ---
    const supplyCount = clamp(2 + (rng() * 2 | 0), 2, 3);
    const supplyStations = [];
    const supplyCells = pickCells(free, reachInfo.reach, reachInfo.n, supplyCount, size * 0.24, (c) => {
      const d = minDistTo([c.x, c.y, c.z], pspawnPos);
      return d > 18 && d < size * 0.42;
    }, objOrder);
    for (let i = 0; i < supplyCells.length && supplyStations.length < supplyCount; i++) {
      const c = supplyCells[i];
      supplyStations.push({
        id: 'supply_' + supplyStations.length,
        label: SUPPLY_LABELS[(i + attemptSeed) % SUPPLY_LABELS.length],
        pos: [q(c.x), q(c.y), q(c.z)],
        radius: 5,
        items: SUPPLY_ITEMS.slice(),
      });
    }
    if (supplyStations.length < 2) continue;

    // --- 连通性复核（生成期保证 == 测试期断言）---
    // 注意：repairTargets 可能移动玩家出生点，所以敌人出生点的 25m 间距必须在这之后才算
    const targets = []
      .concat(pspawns.map((p) => ({ pos: p.pos })))
      .concat(objectives.map((p) => ({ pos: p.pos })))
      .concat(extractPoints.map((p) => ({ pos: p.pos })))
      .concat(supplyStations.map((p) => ({ pos: p.pos })));

    if (!verifyTargets(b, grid, reachInfo, targets)) {
      repairTargets(b, grid, free, targets, reachInfo);
      if (!verifyTargets(b, grid, reachInfo, targets)) continue;
    }

    // --- 敌人出生点最终过滤：必须离"最终"玩家出生点 > 25m（契约硬性要求）---
    const finalSpawnPos = pspawns.map((p) => p.pos);
    const spawnPoints = [];
    for (let i = 0; i < spawnList.length && spawnPoints.length < 16; i++) {
      const c = spawnList[i];
      if (minDistTo([c.x, c.y, c.z], finalSpawnPos) > ENEMY_SPAWN_MIN_DIST + 1) {
        spawnPoints.push([c.x, c.y, c.z]);
      }
    }
    if (spawnPoints.length < 8) continue;

    // --- 危害区：与生物群系一致 ---
    const hazards = buildHazards(b, rng, size, biome, terrain, heightFn, hazardPlan);

    const map = assembleMap({
      b, size, seed, tier, biome, terrain, archetype: requested,
      pspawns, spawnList: spawnPoints, objectives, extractPoints, supplyStations, hazards,
    });
    // 自洽闸门：用与自检完全相同的判据复核候选地图，不一致就换一次尝试
    if (!checkReachability(map).ok) continue;
    // 盒数下限由原型设计保证；真出现不足说明布局崩了，宁可走兜底也不要输出残图
    if (map.boxes.length < MIN_BOXES) continue;
    // 盒数上限由 fitBoxBudget 预裁剪保证，这里是最后一道保险
    if (map.boxes.length > MAX_BOXES) {
      fallback = fallback || map;
      continue;
    }
    return map;
  }

  if (fallback) return fallback;
  // 兜底：极端情况下也要返回合法地图（空原型 + 纯地形）
  return emergencyMap(seed, size, tier, biome, requested);
}

function reachAt(info, ix, iz) {
  if (ix < 0 || iz < 0 || ix >= info.n || iz >= info.n) return false;
  return info.reach[iz * info.n + ix] === 1;
}

/** 自由单元是否靠近某个地标（水平 46m 内）。 */
function nearLandmark(b, cell, within) {
  for (let i = 0; i < b.landmarks.length; i++) {
    const l = b.landmarks[i];
    const dx = l.x - cell.x;
    const dz = l.z - cell.z;
    if (dx * dx + dz * dz < within * within) return true;
  }
  return false;
}

/** 把悬空的结构、设备、掩体吸附到其下方的地面/顶面。 */
function snapToGround(b) {
  const bottomOf = (box) => {
    const [ix0, ix1] = cellRange(b.origin, box.min[0], box.max[0]);
    const [iz0, iz1] = cellRange(b.origin, box.min[2], box.max[2]);
    let best = Infinity;
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const top = b.cellLowestBlock(ix, iz, -60, box.min[1]);
        if (top < best) best = top;
      }
    }
    if (!Number.isFinite(best)) best = b.heightFn((box.min[0] + box.max[0]) / 2, (box.min[2] + box.max[2]) / 2);
    return best;
  };
  for (let i = 0; i < b.boxes.length; i++) {
    const box = b.boxes[i];
    if ((box.flags & FLAG.PLATFORM) !== 0) continue; // 栈桥/平台按设计悬空
    const floor = bottomOf(box);
    const gap = box.min[1] - floor;
    if (gap <= 0.02 || gap > 14) continue;
    const h = box.max[1] - box.min[1];
    box.min[1] = floor;
    box.max[1] = floor + h;
  }
}

/**
 * 先规划危险区平面轮廓，再由 makeHeightFn 把轮廓内部下切成浅池/裂隙。
 * 独立随机流保证增减危险区细节不会扰动原型、出生点与任务点的随机序列。
 */
function planHazards(size, biome, seed) {
  const rng = mulberry32((seed ^ 0xa53c9e17) >>> 0);
  const kind = biome.hazard ? biome.hazard.kind : 'radiation';
  const count = 3 + ((rng() * 3) | 0);
  const half = size * 0.5;
  const out = [];
  const profile = kind === 'lava'
    ? { depth: 0.82, rim: 4.2 }
    : kind === 'acid'
      ? { depth: 0.64, rim: 3.8 }
      : kind === 'coolant'
        ? { depth: 0.48, rim: 3.2 }
        : kind === 'vacuum'
          ? { depth: 1.35, rim: 5.2 }
          : { depth: 0.24, rim: 3.0 };

  for (let i = 0; i < count; i++) {
    let w;
    let d;
    if (kind === 'lava' || kind === 'acid') {
      const long = clamp(size * (0.15 + rng() * 0.08), 23, 58);
      const short = 7.5 + rng() * 5.5;
      if (rng() < 0.5) { w = long; d = short; } else { w = short; d = long; }
    } else if (kind === 'vacuum') {
      const diameter = 13 + rng() * 12;
      w = diameter;
      d = diameter * (0.82 + rng() * 0.24);
    } else if (kind === 'coolant') {
      w = 8 + rng() * 7;
      d = 8 + rng() * 7;
    } else {
      w = 15 + rng() * 15;
      d = 15 + rng() * 15;
    }

    let x = 0;
    let z = 0;
    let placed = false;
    for (let attempt = 0; attempt < 32; attempt++) {
      const a = rng() * Math.PI * 2;
      const r = size * (0.19 + rng() * 0.20);
      x = clamp(Math.cos(a) * r, -half + w * 0.5 + 7, half - w * 0.5 - 7);
      z = clamp(Math.sin(a) * r, -half + d * 0.5 + 7, half - d * 0.5 - 7);
      placed = true;
      for (let j = 0; j < out.length; j++) {
        const o = out[j];
        if (Math.abs(x - o.x) < (w + o.w) * 0.5 + 7
          && Math.abs(z - o.z) < (d + o.d) * 0.5 + 7) {
          placed = false;
          break;
        }
      }
      if (placed) break;
    }
    if (!placed) {
      const a = (i / Math.max(1, count)) * Math.PI * 2 + 0.35;
      x = clamp(Math.cos(a) * size * 0.31, -half + w * 0.5 + 5, half - w * 0.5 - 5);
      z = clamp(Math.sin(a) * size * 0.31, -half + d * 0.5 + 5, half - d * 0.5 - 5);
    }
    out.push({
      kind,
      x: q(x), z: q(z), w: q(w), d: q(d),
      basinDepth: q(profile.depth * (0.88 + rng() * 0.24)),
      rimWidth: q(profile.rim * (0.90 + rng() * 0.20)),
      shapeSeed: ((seed + Math.imul(i + 1, 0x6d2b79f5)) >>> 0),
    });
  }
  return out;
}

function insideHazardPlan(x, z, plans, padding) {
  const p = padding || 0;
  for (let i = 0; i < plans.length; i++) {
    const h = plans[i];
    if (Math.abs(x - h.x) <= h.w * 0.5 + p && Math.abs(z - h.z) <= h.d * 0.5 + p) return true;
  }
  return false;
}

/** 生物群系驱动的危害区布置。 */
function buildHazards(b, rng, size, biome, terrainSpec, heightFn, planned) {
  const out = [];
  const strength = biome.hazard ? biome.hazard.strength : 12;
  const plans = Array.isArray(planned) ? planned : planHazards(size, biome, terrainSpec.seed || 1);
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i];
    let minY = Infinity;
    let maxY = -Infinity;
    // 伤害体积的纵向范围包住整个融合池；运行时还会按局部地面高度复核。
    for (let ix = 0; ix <= 4; ix++) for (let iz = 0; iz <= 4; iz++) {
      const sx = p.x - p.w * 0.5 + p.w * ix / 4;
      const sz = p.z - p.d * 0.5 + p.d * iz / 4;
      const y = heightFn(sx, sz);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    out.push({
      kind: p.kind,
      label: HAZARD_LABEL[p.kind] || '危险区',
      strength: q(strength * (0.7 + rng() * 0.6)),
      shape: 'box',
      min: [q(p.x - p.w / 2), q(minY - 1.2), q(p.z - p.d / 2)],
      max: [q(p.x + p.w / 2), q(maxY + 2.1), q(p.z + p.d / 2)],
      terrainIntegrated: true,
      basinDepth: p.basinDepth,
      rimWidth: p.rimWidth,
      shapeSeed: p.shapeSeed,
    });
  }
  return out;
}

/** 组装最终地图对象（键顺序固定，便于字节级对比）。 */
function assembleMap(p) {
  const { b, size, seed, tier, biome, terrain, archetype } = p;
  const half = size / 2;
  const pal = biome.palette;

  // 剔除被 carveCore 清掉的体积，并在超预算时优先丢弃小体量（保留平台与结构）
  const kept = [];
  for (let i = 0; i < b.boxes.length; i++) {
    if (!b.boxes[i]._carved) kept.push(b.boxes[i]);
  }
  if (kept.length > MAX_BOXES) {
    const order = kept.map((box, i) => {
      const v = (box.max[0] - box.min[0]) * (box.max[1] - box.min[1]) * (box.max[2] - box.min[2]);
      return { i, v };
    });
    order.sort((x, y) => (x.v - y.v) || (x.i - y.i));
    const drop = new Set();
    let excess = kept.length - MAX_BOXES;
    for (let i = 0; i < order.length && excess > 0; i++) {
      drop.add(order[i].i);
      excess--;
    }
    const trimmed = [];
    for (let i = 0; i < kept.length; i++) if (!drop.has(i)) trimmed.push(kept[i]);
    kept.length = 0;
    for (let i = 0; i < trimmed.length; i++) kept.push(trimmed[i]);
  }

  const triangles =
    kept.length * 12 + b.catwalks.length * 12 + b.props.length * 12 +
    (terrain.resolution - 1) * (terrain.resolution - 1) * 2;
  const name = 'IRONFALL-' + String(tier).padStart(2, '0') + ' // ' + biome.name + ' · ' + archetype.name;
  return {
    version: MAP_FORMAT_VERSION,
    name,
    biome: biome.id,
    size,
    seed,
    tier,
    archetype: archetype.id,
    terrain,
    bounds: { min: [-half, -34, -half], max: [half, 190, half] },
    boxes: kept.map((x) => ({
      min: x.min.slice(),
      max: x.max.slice(),
      flags: x.flags,
      material: x.material,
    })),
    platforms: b.platforms,
    catwalks: b.catwalks,
    walls: b.walls,
    props: b.props,
    spawnPoints: p.spawnList,
    playerSpawns: p.pspawns.map((s) => s.pos),
    extractPoints: p.extractPoints,
    objectives: p.objectives,
    supplyStations: p.supplyStations,
    hazards: b.hazards.concat(p.hazards || []),
    playerSpawnYaw: p.pspawns.map((s) => s.yaw),
    lighting: {
      sunDir: [0.42, -0.78, -0.34],
      sunColor: pal.sun.slice(),
      ambient: pal.ambient.slice(),
      fogColor: pal.fog.slice(),
      skyColor: pal.sky.slice(),
      groundColor: pal.ground.slice(),
      accentColor: pal.accent.slice(),
      metalColor: pal.metal.slice(),
      emissiveColor: pal.emissive.slice(),
      fogNear: q(Math.max(28, size * 0.22)),
      fogFar: q(size * 1.25),
    },
    lightingPreset: pal,
    gravityScale: biome.gravityScale,
    ambientTrack: biome.ambientTrack,
    debug: {
      trianglesApprox: triangles,
      boxCount: kept.length,
      archetype: archetype.id,
      generatedAt: seed,
    },
  };
}

/**
 * 极端兜底：前 10 次尝试都没能通过自洽闸门时使用。
 * 构造完全确定、无需验证的场地：整张图是一块平坦地板（噪声振幅归零、trenches 清空），
 * 结构只摆在"偶数行 / 偶数列"的交点上，因此奇数行与奇数列永远是贯通的空地，
 * 所有出生点/目标/撤离点都按固定公式落在这些空地里。
 */
function emergencyMap(seed, size, tier, biome, archetype) {
  const terrain = buildGradedTerrainSpec(size, biome, seed, tier);
  terrain.plateau = [{ x: 0, z: 0, radius: q(size * 0.75), height: 4, falloff: 1 }];
  terrain.trenches = [];
  terrain.field = null;
  terrain.amplitude = 0;
  const heightFn = makeHeightFn(terrain);
  const b = new MapBuilder(size, heightFn);
  const half = size / 2;
  const groundAt = (x, z) => q(heightFn(x, z));

  // 明确的三段式布局（全部用相对半场的带宽，任意 size 都不会互相侵入）：
  //   内带 |v| ≤ 0.36*half  → 结构
  //   中带 0.42..0.66       → 玩家出生 / 目标 / 补给
  //   外带 0.78..0.92       → 敌人出生 / 撤离点
  const structSpan = half * 0.36;
  const sp = Math.max(8, structSpan / 1.6);
  const n = 3;
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      const x = q((i * structSpan) / n);
      const z = q((j * structSpan) / n);
      const w = Math.min(sp * 0.34, 7);
      const h = 5 + (Math.abs(i + j) % 3);
      const y = groundAt(x, z);
      b.addBox([x - w, y, z - w], [x + w, y + h, z + w], F_STRUCT, 'concrete', { force: true });
      b.addPlatform(x, y + h, z, w * 2.4, w * 2.4, F_DECK, 'steel');
      b.addProp('crate', x + w + 1.6, y, z, 1.2, 0);
    }
  }

  const mid = half * 0.54;
  const pspawnPts = [
    { pos: [0, groundAt(0, mid), mid], yaw: Math.PI },
    { pos: [mid, groundAt(mid, 0), 0], yaw: -Math.PI / 2 },
    { pos: [0, groundAt(0, -mid), -mid], yaw: 0 },
  ];
  const outer = half * 0.86;
  const spawnPts = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.3;
    const x = q(Math.cos(a) * outer);
    const z = q(Math.sin(a) * outer);
    spawnPts.push([x, groundAt(x, z), z]);
  }
  return assembleMap({
    b, size, seed, tier, biome, terrain, archetype,
    pspawns: pspawnPts,
    spawnList: spawnPts,
    objectives: [
      { id: 'obj_0_destroy', type: 'destroy', label: OBJECTIVE_POOL[0].label, pos: [-mid, groundAt(-mid, 0), 0], radius: 5, required: true },
      { id: 'obj_1_sabotage', type: 'sabotage', label: OBJECTIVE_POOL[1].label, pos: [0, groundAt(0, 0), -mid], radius: 5, required: true },
      { id: 'obj_2_capture', type: 'capture', label: OBJECTIVE_POOL[2].label, pos: [mid, groundAt(mid, 0), 0], radius: 5, required: false },
    ],
    extractPoints: [
      { pos: [-outer, groundAt(-outer, 0), 0], radius: 6, label: EXTRACT_LABELS[0] },
      { pos: [outer, groundAt(outer, 0), 0], radius: 6, label: EXTRACT_LABELS[1] },
    ],
    supplyStations: [
      { id: 'supply_0', label: SUPPLY_LABELS[0], pos: [0, groundAt(0, 0), mid], radius: 5, items: SUPPLY_ITEMS.slice() },
      { id: 'supply_1', label: SUPPLY_LABELS[1], pos: [0, groundAt(0, 0), -mid], radius: 5, items: SUPPLY_ITEMS.slice() },
    ],
    hazards: [],
  });
}

/** 依据生物群系与规模构造 terrain 段（含原型化的地貌修饰）。 */
function buildTerrainSpec(size, biome, seed, tier) {
  const t = biome.terrain;
  const roughness = t.roughness;
  const resolution = clamp(Math.round(size / clamp(3.4 / roughness, 2.0, 5.2)), 40, 160);
  const amplitude = t.amplitude * (0.85 + (tier % 3) * 0.12);
  const plateau = [];
  const trenches = [];
  const rng = mulberry32(seed ^ 0x5bf03635);

  plateau.push({ x: 0, z: 0, radius: Math.round(size * 0.19), height: 1.4 * roughness, falloff: Math.round(size * 0.10) });
  if (tier >= 3) {
    const a = rng() * Math.PI * 2;
    plateau.push({
      x: Math.round(Math.cos(a) * size * 0.28),
      z: Math.round(Math.sin(a) * size * 0.28),
      radius: Math.round(size * 0.11),
      height: 3.6 * roughness,
      falloff: Math.round(size * 0.08),
    });
  }
  if (tier >= 5) {
    const a = rng() * Math.PI * 2;
    trenches.push({
      x: Math.round(Math.cos(a) * size * 0.26),
      z: Math.round(Math.sin(a) * size * 0.26),
      radius: Math.round(size * 0.08),
      depth: -9 * roughness,
      falloff: Math.round(size * 0.06),
    });
  }
  // 熔炉星港：一条贯穿的冷却渠；峡谷管线：中央深切峡谷
  if (biome.id === 'industrial_forge') {
    trenches.push({ x: Math.round(size * 0.24), z: 0, radius: Math.round(size * 0.03), depth: -6, falloff: Math.round(size * 0.05) });
  }
  if (biome.id === 'canyon_pipeline') {
    trenches.push({ x: 0, z: 0, radius: Math.round(size * 0.15), depth: -15, falloff: Math.round(size * 0.045) });
    trenches.push({ x: 0, z: Math.round(size * 0.30), radius: Math.round(size * 0.05), depth: -7, falloff: Math.round(size * 0.03) });
  }
  if (biome.id === 'anchor_ring') {
    trenches.push({ x: 0, z: 0, radius: Math.round(size * 0.15), depth: -17, falloff: Math.round(size * 0.035) });
  }
  if (biome.id === 'deep_core_mine') {
    trenches.push({ x: Math.round(-size * 0.22), z: Math.round(size * 0.18), radius: Math.round(size * 0.07), depth: -12, falloff: Math.round(size * 0.05) });
  }

  return {
    resolution,
    baseHeight: 0,
    amplitude: q(amplitude),
    octaves: clamp(t.octaves | 0, 1, 8),
    lacunarity: t.lacunarity,
    gain: t.gain,
    roughness,
    seed: seed >>> 0,
    plateau,
    trenches,
  };
}

/**
 * 生成最终地形规范：先整平粗网格压掉不可通行的陡坡，再把分级数据挂到 spec 上。
 * 这样 makeHeightFn(spec) 在别处重建时（例如 world.js / 连通性自检）会得到同一条曲线。
 */
function buildGradedTerrainSpec(size, biome, seed, tier) {
  const spec = buildTerrainSpec(size, biome, seed, tier);
  const coarse = makeHeightFn(spec);
  const field = gradeTerrain(size, coarse, clamp(8 + tier, 8, 18));
  spec.field = {
    n: field.n,
    spacing: field.spacing,
    ox: q(field.ox),
    oz: q(field.oz),
    h: Array.from(field.h, q),
  };
  return spec;
}

// ---------------------------------------------------------------------------
// 10. 战役阶梯
// ---------------------------------------------------------------------------

const BASE_MODIFIERS = {
  enemyHpMul: 1,
  enemyDamageMul: 1,
  enemyCountMul: 1,
  extractionTime: 25,
  alloyMul: 1,
  playerShieldMul: 1,
  hazardStrengthMul: 1,
};

function missionModifiers(tier, hazardStrengthMul) {
  return {
    enemyHpMul: q(1 + (tier - 1) * 0.16),
    enemyDamageMul: q(1 + (tier - 1) * 0.11),
    enemyCountMul: q(1 + (tier - 1) * 0.13),
    extractionTime: Math.max(14, 28 - tier),
    alloyMul: q(1 + (tier - 1) * 0.12),
    playerShieldMul: q(Math.max(0.7, 1 - (tier - 1) * 0.035)),
    hazardStrengthMul: q(hazardStrengthMul),
  };
}

/** 十条手写远征简报：从熔炉星港一路推到锚环站。 */
export const MISSIONS = Object.freeze([
  {
    id: 'm01', tier: 1, world: '熔炉星港 K-7', title: '第一次下线',
    brief: '你的运输舱在 K-7 的铸造环带外侧硬着陆。中继塔被本地拆解帮占了，先夺回来。\n这套外骨骼是租的，别弄坏。\n撤离船二十分钟后经过，错过就等下一天。',
    biome: 'industrial_forge', archetype: 'foundry_hall', seedBase: 1337,
    modifiers: Object.freeze(missionModifiers(1, 1)),
  },
  {
    id: 'm02', tier: 2, world: '熔炉星港 K-7', title: '冷却渠里的东西',
    brief: '主泵停机了三个班次，坩埚温度已经压不住。\n拆解帮把泵房改成了据点，你得一层层清上去。\n别站在冷却渠里——那玩意儿现在是熔渣。',
    biome: 'industrial_forge', archetype: 'canyon_pipeline', seedBase: 2411,
    modifiers: Object.freeze(missionModifiers(2, 1.1)),
  },
  {
    id: 'm03', tier: 3, world: '舰骸坟场 V-9', title: '拆船人的账本',
    brief: 'V-9 的拆解队集体失联，最后一条通讯里只有金属被撕开的声音。\n黑匣子还在领航舱里，数据比人值钱。\n龙骨之间的风很大，抓钩能救命。',
    biome: 'ship_graveyard', archetype: 'ship_break_yard', seedBase: 3527,
    modifiers: Object.freeze(missionModifiers(3, 1.15)),
  },
  {
    id: 'm04', tier: 4, world: '舰骸坟场 V-9', title: '拾荒者的长廊',
    brief: '三艘退役战列舰被并排拖上岸，舷侧之间只剩下六米的缝。\n那是全星系最好的墙跑走廊，也是最好的伏击点。\n把导航核心从舰桥里挖出来，然后跑。',
    biome: 'ship_graveyard', archetype: 'storage_blocks', seedBase: 4649,
    modifiers: Object.freeze(missionModifiers(4, 1.2)),
  },
  {
    id: 'm05', tier: 5, world: '深核矿脉 D-21', title: '三百层之下',
    brief: '矿脉的通风系统停了，井口的辐射读数每十分钟翻一倍。\n浓缩燃料棒在第七中段，搬运需要两个人，你只有一个。\n升降机井是唯一的直路，也是唯一的死路。',
    biome: 'deep_core_mine', archetype: 'storage_blocks', seedBase: 5711,
    modifiers: Object.freeze(missionModifiers(5, 1.3)),
  },
  {
    id: 'm06', tier: 6, world: '深核矿脉 D-21', title: '深井呼吸',
    brief: '我们把冷却主泵的替代件吊下来了，但没人愿意下到井底去装。\n井壁全是可攀的轨道支架，你只要不掉下去。\n装完之后井底会被灌满，别磨蹭。',
    biome: 'deep_core_mine', archetype: 'anchor_ring', seedBase: 6823,
    modifiers: Object.freeze(missionModifiers(6, 1.35)),
  },
  {
    id: 'm07', tier: 7, world: '炉渣荒原 S-3', title: '酸雨中的信标',
    brief: 'S-3 的地表已经被炉渣埋了三百年，只有信标塔还露在外面。\n酸池会把你的护盾一层层吃掉，走高处。\n防线阵列必须在我们到达前瘫痪。',
    biome: 'slag_wastes', archetype: 'reactor_spine', seedBase: 7937,
    modifiers: Object.freeze(missionModifiers(7, 1.45)),
  },
  {
    id: 'm08', tier: 8, world: '炉渣荒原 S-3', title: '废钢塌落区',
    brief: '整片荒原是一场缓慢进行的塌方。\n拆解帮在渣堆里挖出了迷宫一样的通道，只有蹲下的高度。\n抢在下一场塌落前把合金样本运出来。',
    biome: 'slag_wastes', archetype: 'canyon_pipeline', seedBase: 8101,
    modifiers: Object.freeze(missionModifiers(8, 1.5)),
  },
  {
    id: 'm09', tier: 9, world: '轨道锚站 A-1', title: '断缆之前',
    brief: '锚站的外壳被碎片打穿了两处，真空正在把里面的一切往外抽。\n系缆张力只剩 4%，你要在它断开前重接。\n别相信任何一扇看起来完好的气密门。',
    biome: 'orbital_anchor', archetype: 'anchor_ring', seedBase: 9203,
    modifiers: Object.freeze(missionModifiers(9, 1.6)),
  },
  {
    id: 'm10', tier: 10, world: '轨道锚站 A-1', title: '铁陨行动',
    brief: '这是最后一班岗：把热核中继从锚站核心拆下来，带回去。\n整座站都在朝地表坠落，脊柱塔会是你唯一的路。\n你会掉下去一次。别掉第二次。',
    biome: 'orbital_anchor', archetype: 'reactor_spine', seedBase: 10337,
    modifiers: Object.freeze(missionModifiers(10, 1.75)),
  },
]);

/**
 * 取第 index 条远征简报（越界时钳制，永不返回 undefined）。
 * @param {number} index
 */
export function getMission(index) {
  const i = Number.isFinite(index) ? Math.floor(index) : 0;
  return MISSIONS[clamp(i, 0, MISSIONS.length - 1)];
}

// ---------------------------------------------------------------------------
// 11. 连通性自检（供 tools/test-maps.mjs 与关卡调试复用）
// ---------------------------------------------------------------------------

/**
 * 依据地图 JSON 重建高度函数与地面网格，从第一个玩家出生点泛洪，
 * 检查所有玩家出生点 / 目标 / 撤离点 / 补给站是否互相连通。
 * 设计意图：让"生成期保证"与"测试期断言"共用同一份判据，避免两套规则漂移。
 * @param {object} mapData
 * @returns {{ ok:boolean, reason:string, reachableCells:number, freeCells:number, unreachable:string[] }}
 */
export function checkReachability(mapData) {
  const reasons = [];
  if (!mapData || typeof mapData !== 'object') {
    return { ok: false, reason: 'mapData is not an object', reachableCells: 0, freeCells: 0, unreachable: [] };
  }
  const terrain = mapData.terrain || {};
  const heightFn = makeHeightFn(Object.assign({}, terrain, { seed: terrain.seed == null ? 0 : terrain.seed }));
  const b = new MapBuilder(mapData.size, heightFn);
  const boxes = Array.isArray(mapData.boxes) ? mapData.boxes : [];
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    if (!box || !Array.isArray(box.min) || !Array.isArray(box.max)) continue;
    b.seedBox(box.min, box.max, box.flags);
  }
  const grid = buildGroundGrid(b);
  const free = collectFreeCells(b, grid);
  const spawns = Array.isArray(mapData.playerSpawns) ? mapData.playerSpawns : [];
  if (spawns.length === 0) {
    return { ok: false, reason: 'no playerSpawns', reachableCells: 0, freeCells: free.length, unreachable: [] };
  }
  const root = spawns[0];
  const reachInfo = floodFrom(b, grid, root[0], root[2]);

  const checks = [];
  for (let i = 0; i < spawns.length; i++) checks.push({ tag: 'playerSpawn#' + i, pos: spawns[i] });
  const adds = [mapData.objectives, mapData.extractPoints, mapData.supplyStations];
  const tags = ['objective', 'extractPoint', 'supplyStation'];
  for (let a = 0; a < adds.length; a++) {
    const list = Array.isArray(adds[a]) ? adds[a] : [];
    for (let i = 0; i < list.length; i++) {
      if (list[i] && Array.isArray(list[i].pos)) checks.push({ tag: tags[a] + '#' + i, pos: list[i].pos });
    }
  }

  const unreachable = [];
  for (let i = 0; i < checks.length; i++) {
    const p = checks[i].pos;
    const ix = cellOf(grid, p[0]);
    const iz = cellOf(grid, p[2]);
    if (ix < 0 || iz < 0 || ix >= grid.n || iz >= grid.n) {
      unreachable.push(checks[i].tag + ' (out of bounds)');
      continue;
    }
    if (!reachInfo.reach[iz * grid.n + ix]) {
      unreachable.push(checks[i].tag + ' @[' + p[0] + ',' + p[1] + ',' + p[2] + ']');
      continue;
    }
    if (!Number.isFinite(standHeightAt(b, grid, p[0], p[2]))) {
      unreachable.push(checks[i].tag + ' has no standing room');
    }
  }

  // 出生点之间也必须互相连通（用每个出生点各自泛洪，取可达数一致性即可判定）
  for (let i = 1; i < spawns.length; i++) {
    const r = floodFrom(b, grid, spawns[i][0], spawns[i][2]);
    const ix = cellOf(grid, spawns[0][0]);
    const iz = cellOf(grid, spawns[0][2]);
    if (!reachAt(r, ix, iz)) unreachable.push('playerSpawn#0 unreachable from playerSpawn#' + i);
  }

  if (unreachable.length > 0) reasons.push(unreachable.join('; '));
  return {
    ok: unreachable.length === 0,
    reason: reasons.join(' | '),
    reachableCells: reachInfo.count,
    freeCells: free.length,
    unreachable,
  };
}
