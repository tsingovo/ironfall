// ==== world.js — 世界：地图载入 / 静态网格合并 / 碰撞查询 / 模型导入通道 ====
// 关键设计：
//   * 地形的"渲染网格"与"碰撞三角"由同一个高度函数生成，保证视觉与判定完全一致。
//   * 所有静态盒体合并成一次 instanced draw call（数千个盒子仍然只有 1 次绘制）。
//     为了让不同尺寸的盒子能共用单位立方体，用实例矩阵的缩放来表达尺寸。
//   * 碰撞走 2D 空间哈希宽相 + 精确窄相，高速运动由 sweepSphere* 兜底防穿透。
//   * 程序化几何是碰撞的唯一权威；导入模型（GLTF）默认只替换渲染，避免美术资源改坏判定。

import { CFG } from './core/config.js';
import * as M from './core/math.js';
import * as Geo from './engine/geometry.js';
import * as Col from './engine/collision.js';

export const MAP_FORMAT_VERSION = 1;

/** 盒体标志位（与 maps/builtin-maps.js 的 FLAG 保持一致） */
export const FLAG = {
  SOLID: 1,
  WALLRUN: 2,
  CLIMBABLE: 4,
  BREAKABLE: 8,
  PLATFORM: 16,
  COVER: 32,
  HAZARD: 64,
  LADDER: 128,
  EXTRACT: 256,
};

const TMP_MIN = new Float32Array(3);
const TMP_MAX = new Float32Array(3);
const TMP_V = new Float32Array(3);
const TMP_V2 = new Float32Array(3);
const QUERY_BUF = [];

/** 默认调色板（地图未指定 lighting 时使用） */
const DEFAULT_LIGHT = {
  sunDir: [-0.42, -0.82, -0.36],
  sunColor: [1.0, 0.87, 0.72],
  ambient: [0.18, 0.21, 0.28],
  fill: [0.11, 0.10, 0.09],
  fogColor: [0.075, 0.09, 0.12],
  fogRange: [80, 460],
  clearColor: [0.045, 0.055, 0.075],
};

export class World {
  constructor(engine, opts = {}) {
    this.engine = engine;
    this.opts = opts;
    this.mapData = null;
    this.mapName = '';
    this.biomeId = 'industrial_forge';
    this.size = 200;
    this.seed = 1;

    // 碰撞数据
    this.triangles = new Float32Array(0);
    this.triangleCount = 0;
    this.boxes = [];
    this.hash = new Col.SpatialHash(8);
    this._boxHash = new Col.SpatialHash(8);

    // 渲染资源
    this.meshes = {
      cube: engine.createMesh(Geo.unitCube()),
      cylinder: engine.createMesh(Geo.unitCylinder(14, true, true)),
      cylinderThin: engine.createMesh(Geo.unitCylinder(10, true, true)),
      sphere: engine.createMesh(Geo.unitSphere(12, 8)),
      cone: engine.createMesh(Geo.unitCone(12)),
      wedge: engine.createMesh(Geo.unitWedge()),
      quad: engine.createMesh(Geo.unitQuad()),
      disc: engine.createMesh(Geo.unitDisc(20)),
      plane: engine.createMesh(Geo.unitPlane()),
    };

    this.staticTerrainMesh = null;
    this.staticBoxData = null;   // { matrices: Float32Array, colors: Float32Array, count }
    // 危险区独立使用高亮、无光照实例。不能只依赖伤害 AABB，否则岩浆/酸液
    // 在画面里和普通地面完全一样，玩家直到掉血才知道踩进了危险区。
    this._hazardSurfaceData = null;
    this._hazardBankData = null;
    this._supplyVisualData = null;
    this.importedVisuals = [];   // GLTF 导入的渲染网格
    this.importedCount = 0;

    // 地形高度函数（载入后设置）
    this._heightFn = null;
    this._terrainGrid = null;    // { n, step, x0, z0, heights }

    // 目标点 / 出生点
    this._spawnPoints = [];
    this._playerSpawns = [];
    this._extractPoints = [];
    this._objectives = [];
    this._supplyStations = [];
    this._hazards = [];
    this._props = [];
    this._navCandidates = [];

    // 兼容别名：对外的属性写法统一为方法调用，避免与同名数组字段冲突。
    // 注意：不要在这里写 `this.objectives = this._objectives`，那会覆盖原型方法。
    this.stats = { terrainTris: 0, boxes: 0, props: 0, totalTris: 0 };
  }

  // ================================================================ 载入

  load(mapData) {
    if (!mapData || typeof mapData !== 'object') throw new Error('WORLD_MAP_INVALID');
    if (mapData.version != null && mapData.version !== MAP_FORMAT_VERSION) {
      // 容忍未来版本的小改动：只警告不拒绝
      if (typeof console !== 'undefined') {
        console.warn('[world] 地图版本不匹配:', mapData.version, '期望', MAP_FORMAT_VERSION);
      }
    }
    this.unload();
    this.mapData = mapData;
    this.mapName = mapData.name || '未命名区域';
    this.biomeId = mapData.biome || 'industrial_forge';
    this.size = mapData.size || 200;
    this.seed = mapData.seed || 1;

    this._buildTerrain(mapData.terrain || {});
    this._buildStructures(mapData);
    this._buildProps(mapData);
    this._collectPoints(mapData);
    this._buildSupplyVisuals();
    this._buildNavCandidates();
    this.buildStaticMeshes();
    this.applyLighting(mapData.lighting);

    this.stats.totalTris = this.triangleCount + (this.staticTerrainMesh ? this.staticTerrainMesh.triangleCount : 0);
    return this;
  }

  unload() {
    if (this.staticTerrainMesh) this.engine.destroyMesh(this.staticTerrainMesh);
    this.staticTerrainMesh = null;
    this.staticBoxData = null;
    this._hazardSurfaceData = null;
    this._hazardBankData = null;
    this._supplyVisualData = null;
    for (const v of this.importedVisuals) this.engine.destroyMesh(v.mesh);
    this.importedVisuals.length = 0;
    this.importedCount = 0;
    this.boxes.length = 0;
    this.hash.clear();
    this._boxHash.clear();
    this.triangles = new Float32Array(0);
    this.triangleCount = 0;
    this._spawnPoints.length = 0;
    this._playerSpawns.length = 0;
    this._extractPoints.length = 0;
    this._objectives.length = 0;
    this._supplyStations.length = 0;
    this._hazards.length = 0;
    this._navCandidates.length = 0;
    this.mapData = null;
  }

  // ---------------------------------------------------------------- 地形

  _buildTerrain(terrainSpec) {
    const res = Math.max(16, Math.min(256, terrainSpec.resolution || CFG.render.terrainResolution));
    const size = this.size;
    let heightFn;
    if (typeof terrainSpec.heightFn === 'function') {
      // 地图作者直接给了函数（最高优先级）
      heightFn = terrainSpec.heightFn;
    } else {
      // makeHeightFn 会自动识别 terrainSpec.field（地图生成器的分级地形场），
      // 这条路径与地图的连通性校验同源，保证"视觉地形 == 碰撞地形"。
      heightFn = makeHeightFn(terrainSpec);
    }
    this._heightFn = heightFn;

    // 碰撞三角（与渲染同源）
    const tri = Geo.generateHeightfieldTriangles({
      size, segments: res, originX: 0, originZ: 0, heightFn,
    });
    this.triangles = tri.triangles;
    this.triangleCount = this.triangles.length / 9;
    this._terrainGrid = {
      n: tri.gridN,
      step: tri.gridStep,
      x0: tri.gridOrigin[0],
      z0: tri.gridOrigin[1],
      heights: tri.heights,
    };
    this.stats.terrainTris = this.triangleCount;

    // 宽相：三角形入哈希
    this.hash.clear();
    const T = this.triangles;
    for (let i = 0; i < this.triangleCount; i++) {
      const o = i * 9;
      this.hash.insertTri(i, T[o], T[o + 1], T[o + 2], T[o + 3], T[o + 4], T[o + 5], T[o + 6], T[o + 7], T[o + 8]);
    }

    // 渲染网格（顶点色按高度/坡度上色，做出工业地形质感）
    const palette = this._terrainPalette();
    // 当前轻量引擎的世界 shader 使用实例色，不读取生成器的逐顶点 colorFn。
    // 旧代码没有给地形实例传 tint，默认白色在强环境光下直接过曝成一片白地。
    // 取生物群系两种地表色的中值，既恢复场景层次，也让岩浆警戒色真正可辨。
    this._terrainColor = new Float32Array([
      (palette[0][0] + palette[1][0]) * 0.5,
      (palette[0][1] + palette[1][1]) * 0.5,
      (palette[0][2] + palette[1][2]) * 0.5,
      1,
    ]);
    const colorFn = (x, z, y, slope) => {
      const rock = M.clamp01((slope - 0.28) * 2.4);
      const dirt = M.valueNoise2(x * 0.08, z * 0.08);
      let r = palette[0][0] + (palette[1][0] - palette[0][0]) * dirt;
      let g = palette[0][1] + (palette[1][1] - palette[0][1]) * dirt;
      let b = palette[0][2] + (palette[1][2] - palette[0][2]) * dirt;
      const rk = palette[2];
      r = M.lerp(r, rk[0], rock);
      g = M.lerp(g, rk[1], rock);
      b = M.lerp(b, rk[2], rock);
      return [r, g, b];
    };
    const md = Geo.generateHeightfield({
      size, segments: res, originX: 0, originZ: 0, heightFn, colorFn,
    });
    this.staticTerrainMesh = this.engine.createMesh({
      positions: md.positions,
      normals: md.normals,
      uvs: md.uvs,
      indices: md.indices,
      name: 'terrain',
    });
    this._terrainBounds = { min: new Float32Array([-size / 2, -400, -size / 2]), max: new Float32Array([size / 2, 400, size / 2]) };
  }

  _terrainPalette() {
    const b = this.biomeId;
    if (b === 'slag_wastes') return [[0.20, 0.15, 0.12], [0.30, 0.20, 0.14], [0.12, 0.09, 0.08]];
    if (b === 'ship_graveyard') return [[0.17, 0.19, 0.21], [0.24, 0.25, 0.26], [0.10, 0.11, 0.13]];
    if (b === 'deep_core_mine') return [[0.14, 0.13, 0.16], [0.20, 0.17, 0.19], [0.08, 0.08, 0.10]];
    if (b === 'orbital_anchor') return [[0.16, 0.18, 0.22], [0.22, 0.24, 0.29], [0.10, 0.12, 0.16]];
    return [[0.19, 0.18, 0.17], [0.26, 0.23, 0.20], [0.11, 0.10, 0.10]];
  }

  // ---------------------------------------------------------------- 结构体

  _addBox(minA, maxA, flags, material) {
    const min = new Float32Array(3);
    const max = new Float32Array(3);
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(minA[i], maxA[i]);
      max[i] = Math.max(minA[i], maxA[i]);
    }
    // 零厚度盒体退化为薄板，避免数值问题
    for (let i = 0; i < 3; i++) {
      if (max[i] - min[i] < 0.02) {
        const c = (max[i] + min[i]) * 0.5;
        min[i] = c - 0.01; max[i] = c + 0.01;
      }
    }
    const box = {
      min, max,
      flags: flags == null ? FLAG.SOLID : flags,
      material: material || 'metal',
      id: this.boxes.length,
    };
    this.boxes.push(box);
    this._boxHash.insertBox(box.id, min[0], min[2], max[0], max[2]);
    return box;
  }

  _buildStructures(mapData) {
    const boxes = mapData.boxes || [];
    for (const b of boxes) {
      if (!b || !b.min || !b.max) continue;
      this._addBox(b.min, b.max, b.flags != null ? b.flags : FLAG.SOLID, b.material);
    }

    // 平台（可带倾角，用楔形/扁盒近似；倾角实现为旋转盒 -> 用三角化处理）
    for (const p of mapData.platforms || []) {
      const pos = p.pos || [0, 0, 0];
      const s = p.size || [4, 0.4, 4];
      const angle = p.angle || 0;
      const flags = p.flags != null ? p.flags : (FLAG.SOLID | FLAG.PLATFORM | FLAG.WALLRUN);
      if (Math.abs(angle) < 0.02) {
        this._addBox(
          [pos[0] - s[0] / 2, pos[1] - s[1] / 2, pos[2] - s[2] / 2],
          [pos[0] + s[0] / 2, pos[1] + s[1] / 2, pos[2] + s[2] / 2],
          flags, p.material || 'plate');
      } else {
        this._addSlopedSlab(pos, s, angle, p.yaw || 0, flags);
      }
    }

    // 天桥（沿路径的窄板）
    for (const c of mapData.catwalks || []) {
      const pts = c.points || [];
      const width = c.width || 2.5;
      const flags = c.flags != null ? c.flags : (FLAG.SOLID | FLAG.PLATFORM | FLAG.WALLRUN);
      for (let i = 0; i < pts.length - 1; i++) {
        this._addBeamBetween(pts[i], pts[i + 1], width, 0.35, flags, c.material || 'grate');
      }
    }

    // 墙（竖直薄板，可蹬墙）
    for (const w of mapData.walls || []) {
      const pts = w.points || [];
      const h = w.height || 6;
      const th = w.thickness || 0.8;
      const baseY = w.baseY != null ? w.baseY : 0;
      const flags = w.flags != null ? w.flags : (FLAG.SOLID | FLAG.WALLRUN | FLAG.CLIMBABLE);
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        this._addWallBetween(a, b, baseY, h, th, flags);
      }
    }
  }

  /** 轴向对齐的倾斜板：拆成 N 段台阶 + 一块斜面三角化地板 */
  _addSlopedSlab(pos, size, angle, yaw, flags) {
    // 简化：把倾角板拆成 6 段递增高度的小盒，视觉与碰撞都够用且极稳
    const segs = Math.max(3, Math.round(size[0] / 1.2));
    const drop = Math.tan(angle) * size[0];
    for (let i = 0; i < segs; i++) {
      const t0 = i / segs, t1 = (i + 1) / segs;
      const tm = (t0 + t1) * 0.5;
      const y = pos[1] - drop * (tm - 0.5);
      const x0 = pos[0] - size[0] / 2 + t0 * size[0];
      const x1 = pos[0] - size[0] / 2 + t1 * size[0] + 0.02;
      this._addBox(
        [x0, y - size[1] / 2, pos[2] - size[2] / 2],
        [x1, y + size[1] / 2, pos[2] + size[2] / 2],
        flags, 'plate');
    }
  }

  /** 两点之间的水平梁（天桥/管道） */
  _addBeamBetween(a, b, width, thickness, flags, material) {
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const len = Math.hypot(dx, dz);
    if (len < 0.05) return;
    const segs = Math.max(1, Math.ceil(len / 8));
    for (let i = 0; i < segs; i++) {
      const t0 = i / segs, t1 = (i + 1) / segs;
      const x0 = a[0] + dx * t0, z0 = a[2] + dz * t0;
      const x1 = a[0] + dx * t1, z1 = a[2] + dz * t1;
      const y0 = a[1] + (b[1] - a[1]) * t0;
      const y1 = a[1] + (b[1] - a[1]) * t1;
      const hw = width * 0.5 * (Math.abs(dx) > Math.abs(dz) ? 1 : 1);
      // 用轴对齐近似：水平方向用长轴
      if (Math.abs(dx) >= Math.abs(dz)) {
        this._addBox([Math.min(x0, x1) - 0.05, Math.min(y0, y1) - thickness, z0 - hw],
          [Math.max(x0, x1) + 0.05, Math.max(y0, y1), z0 + hw], flags, material);
      } else {
        this._addBox([x0 - hw, Math.min(y0, y1) - thickness, Math.min(z0, z1) - 0.05],
          [x0 + hw, Math.max(y0, y1), Math.max(z0, z1) + 0.05], flags, material);
      }
    }
  }

  /** 两点之间的竖直墙 */
  _addWallBetween(a, b, baseY, h, th, flags) {
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const len = Math.hypot(dx, dz);
    if (len < 0.05) return;
    const segs = Math.max(1, Math.ceil(len / 6));
    const hth = th * 0.5;
    for (let i = 0; i < segs; i++) {
      const t0 = i / segs, t1 = (i + 1) / segs;
      const x0 = a[0] + dx * t0, z0 = a[2] + dz * t0;
      const x1 = a[0] + dx * t1, z1 = a[2] + dz * t1;
      if (Math.abs(dx) >= Math.abs(dz)) {
        this._addBox([Math.min(x0, x1), baseY, z0 - hth], [Math.max(x0, x1), baseY + h, z0 + hth], flags, 'wall');
      } else {
        this._addBox([x0 - hth, baseY, Math.min(z0, z1)], [x0 + hth, baseY + h, Math.max(z0, z1)], flags, 'wall');
      }
    }
  }

  /** 道具（纯视觉，可选生成碰撞） */
  _buildProps(mapData) {
    const props = mapData.props || [];
    const colorFor = (type) => {
      switch (type) {
        case 'crate': return [0.34, 0.27, 0.18];
        case 'barrel': return [0.42, 0.24, 0.12];
        case 'pipe': return [0.26, 0.28, 0.31];
        case 'antenna': return [0.30, 0.31, 0.33];
        case 'tank': return [0.24, 0.30, 0.33];
        case 'pillar': return [0.28, 0.27, 0.26];
        case 'lightpost': return [0.20, 0.21, 0.23];
        case 'silo': return [0.31, 0.30, 0.27];
        default: return [0.30, 0.30, 0.30];
      }
    };
    for (const p of props) {
      const pos = p.pos || [0, 0, 0];
      const scale = p.scale == null ? 1 : p.scale;
      const yaw = p.yaw || 0;
      const type = p.type || 'crate';
      const solid = p.solid !== false && type !== 'lightpost';
      this._props.push({
        type, pos: [pos[0], pos[1], pos[2]], scale, yaw,
        color: p.color || colorFor(type),
        meshIndex: M.hash2(Math.round(pos[0] * 7), Math.round(pos[2] * 13)),
      });
      if (solid) {
        const s = propCollisionSize(type, scale);
        // 用旋转包围盒的 AABB 近似（道具都是小物件，足够）
        const c = Math.abs(Math.cos(yaw)), sn = Math.abs(Math.sin(yaw));
        const ex = s[0] * c + s[2] * sn;
        const ez = s[0] * sn + s[2] * c;
        this._addBox(
          [pos[0] - ex, pos[1], pos[2] - ez],
          [pos[0] + ex, pos[1] + s[1], pos[2] + ez],
          FLAG.SOLID | FLAG.COVER, 'prop');
      }
    }
    this.stats.props = props.length;
  }

  /**
   * 归一化各类点位数据。
   * 地图生成器与手写地图的字段形态不完全一致（例如 spawnPoints 可能是
   * `[x,y,z]` 也可能是 `{ix,iz,x,y,z}`），这里统一收敛成引擎内部形状，
   * 避免把兼容性判断散落到各处。
   */
  _collectPoints(mapData) {
    const toV3 = (p, fallbackY) => {
      if (Array.isArray(p) || ArrayBuffer.isView(p)) {
        return new Float32Array([p[0] || 0, p[1] == null ? (fallbackY || 0) : p[1], p[2] || 0]);
      }
      if (p && typeof p === 'object') {
        const y = p.y != null ? p.y : (p.pos ? p.pos[1] : (fallbackY || 0));
        if (p.pos) return new Float32Array([p.pos[0] || 0, y, p.pos[2] || 0]);
        return new Float32Array([p.x || 0, y, p.z || 0]);
      }
      return new Float32Array([0, fallbackY || 0, 0]);
    };

    // 地面高度（地形已构建，可以直接吸附，避免点位悬空/陷地）
    const snapped = (v) => {
      const out = new Float32Array(3);
      out[0] = v[0]; out[1] = v[1]; out[2] = v[2];
      if (!Number.isFinite(out[1]) || out[1] === 0) out[1] = this.groundHeight(out[0], out[2]);
      return out;
    };

    this._spawnPoints = (mapData.spawnPoints || []).map((p) => snapped(toV3(p)));

    this._playerSpawns = (mapData.playerSpawns || []).map((p) => {
      const v = toV3(p);
      // 玩家出生点：贴到地形表面上方一点，防止生成在几何体内部
      const out = new Float32Array(3);
      out[0] = v[0]; out[2] = v[2];
      const gy = this.groundHeight(v[0], v[2]);
      out[1] = Math.max(v[1], gy) + 0.4;
      return out;
    });

    this._extractPoints = (mapData.extractPoints || []).map((e) => ({
      pos: snapped(toV3(e)),
      radius: e.radius || 6,
      label: e.label || '撤离点',
    }));

    this._objectives = (mapData.objectives || []).map((o) => ({
      id: o.id || ('obj_' + Math.random().toString(36).slice(2, 7)),
      type: o.type || 'destroy',
      label: o.label || '目标',
      pos: snapped(toV3(o)),
      radius: o.radius || 5,
      required: o.required !== false,
      done: false,
      progress: 0,
      hp: o.hp || 100,
    }));

    this._supplyStations = (mapData.supplyStations || []).map((s) => ({
      id: s.id || 'supply',
      pos: snapped(toV3(s)),
      radius: s.radius || 3.5,
      used: false,
      items: s.items || null,
      name: s.label || s.name || '野战补给站',
    }));

    // 危险区：生成器输出的是 AABB（shape:'box' + min/max），也兼容点+半径写法
    this._hazards = (mapData.hazards || []).map((h) => {
      const isBox = Array.isArray(h.min) && Array.isArray(h.max);
      if (isBox) {
        const min = new Float32Array(h.min);
        const max = new Float32Array(h.max);
        return {
          kind: h.kind || 'heat',
          shape: 'box',
          min, max,
          center: new Float32Array([
            (min[0] + max[0]) * 0.5, (min[1] + max[1]) * 0.5, (min[2] + max[2]) * 0.5,
          ]),
          size: new Float32Array([max[0] - min[0], max[1] - min[1], max[2] - min[2]]),
          // 生成器的 strength 是"每秒伤害"，直接用；点+半径写法用 damage
          dps: h.strength != null ? h.strength : (h.damage || 8),
          strength: h.strength == null ? 1 : h.strength,
          label: h.label || '',
          terrainIntegrated: h.terrainIntegrated === true,
          basinDepth: Number.isFinite(h.basinDepth) ? h.basinDepth : 0.45,
          rimWidth: Number.isFinite(h.rimWidth) ? h.rimWidth : 2.5,
          shapeSeed: (h.shapeSeed | 0) >>> 0,
        };
      }
      const pos = snapped(toV3(h));
      return {
        kind: h.kind || 'heat',
        shape: 'sphere',
        pos,
        center: pos,
        radius: h.radius || 6,
        dps: h.damage != null ? h.damage : (h.strength != null ? h.strength : 8),
        strength: h.strength == null ? 1 : h.strength,
        label: h.label || '',
      };
    });
  }

  /** 玩家是否处于某个危险区内；返回该危险区（否则 null） */
  hazardAt(pos) {
    for (let i = 0; i < this._hazards.length; i++) {
      const h = this._hazards[i];
      if (h.shape === 'box') {
        if (pos[0] >= h.min[0] && pos[0] <= h.max[0]
          && pos[2] >= h.min[2] && pos[2] <= h.max[2]) {
          // 地形融合池按玩家脚下的局部地面判断纵向范围。旧做法只参考危险 AABB
          // 中心高度，斜坡另一端会出现“看着是岩浆却不扣血”或反过来的情况。
          if (h.terrainIntegrated) {
            const localGround = this.groundHeight(pos[0], pos[2]);
            if (pos[1] >= localGround - 0.8 && pos[1] <= localGround + 2.2) return h;
          } else if (pos[1] >= h.min[1] - 0.5 && pos[1] <= h.max[1] + 2.0) {
            return h;
          }
        }
      } else {
        const dx = pos[0] - h.pos[0];
        const dy = pos[1] - h.pos[1];
        const dz = pos[2] - h.pos[2];
        if (dx * dx + dy * dy + dz * dz <= h.radius * h.radius) return h;
      }
    }
    return null;
  }

  /** 生成导航候选点（网格采样可站立位置，供刷怪导演取点） */
  _buildNavCandidates() {
    const step = 6;
    const half = this.size * 0.5 - 6;
    const cands = this._navCandidates;
    for (let x = -half; x <= half; x += step) {
      for (let z = -half; z <= half; z += step) {
        const y = this.groundHeight(x, z);
        if (y < -200) continue;
        const slope = this.sampleSlope(x, z);
        if (slope > 0.55) continue;
        cands.push(new Float32Array([x, y, z]));
      }
    }
  }

  // ================================================================ 渲染

  /** 构建高对比补给站模型（纯视觉，不加入碰撞）。 */
  _buildSupplyVisuals() {
    const bodyMatrices = [], bodyColors = [];
    const lightMatrices = [], lightColors = [];
    const add = (list, colors, pos, size, color, yaw = 0) => {
      const m = new Float32Array(16);
      M.m4Compose(pos, yaw, 0, 0, size, m);
      list.push(m);
      colors.push(color[0], color[1], color[2], 1);
    };
    for (const s of this._supplyStations) {
      const x = s.pos[0], y = s.pos[1], z = s.pos[2];
      // 深色底座 + 橙色面板，轮廓在工业地形上清楚可见。
      add(bodyMatrices, bodyColors, [x, y + 0.20, z], [1.45, 0.40, 1.15], [0.10, 0.12, 0.15]);
      add(bodyMatrices, bodyColors, [x, y + 0.88, z], [1.08, 1.00, 0.86], [0.18, 0.23, 0.28]);
      add(bodyMatrices, bodyColors, [x, y + 1.56, z], [1.30, 0.18, 1.02], [0.26, 0.30, 0.34]);
      add(bodyMatrices, bodyColors, [x, y + 0.93, z - 0.46], [0.70, 0.54, 0.055], [0.94, 0.34, 0.05]);
      add(lightMatrices, lightColors, [x, y + 1.70, z], [0.12, 0.72, 0.12], [1.0, 0.70, 0.08]);
      add(lightMatrices, lightColors, [x, y + 0.93, z - 0.50], [0.42, 0.08, 0.035], [1.0, 0.90, 0.24]);
    }
    this._supplyVisualData = {
      body: { matrices: new Float32Array(flatten(bodyMatrices)), colors: new Float32Array(bodyColors), count: bodyMatrices.length },
      light: { matrices: new Float32Array(flatten(lightMatrices)), colors: new Float32Array(lightColors), count: lightMatrices.length },
    };
  }

  buildStaticMeshes() {
    // 静态盒体：单位立方体 + 实例矩阵缩放，合并为一次 draw call
    const n = this.boxes.length;
    const visibleBoxes = [];
    for (let i = 0; i < n; i++) {
      const b = this.boxes[i];
      // 兼容旧地图：纯 HAZARD 盒是判定体积，不应作为实心红方块渲染。
      if ((b.flags & FLAG.HAZARD) && !(b.flags & FLAG.SOLID)) continue;
      visibleBoxes.push(b);
    }
    const matrices = new Float32Array(visibleBoxes.length * 16);
    const colors = new Float32Array(visibleBoxes.length * 4);
    const scratch = new Float32Array(16);
    for (let i = 0; i < visibleBoxes.length; i++) {
      const b = visibleBoxes[i];
      const sx = b.max[0] - b.min[0];
      const sy = b.max[1] - b.min[1];
      const sz = b.max[2] - b.min[2];
      const cx = (b.max[0] + b.min[0]) * 0.5;
      const cy = (b.max[1] + b.min[1]) * 0.5;
      const cz = (b.max[2] + b.min[2]) * 0.5;
      M.m4FromTranslationScale(TMP_V, [sx, sy, sz], scratch);
      scratch[12] = cx; scratch[13] = cy; scratch[14] = cz;
      matrices.set(scratch, i * 16);
      const c = materialColor(b.material, b.flags);
      colors[i * 4] = c[0]; colors[i * 4 + 1] = c[1]; colors[i * 4 + 2] = c[2]; colors[i * 4 + 3] = 1;
    }
    this.staticBoxData = { matrices, colors, count: visibleBoxes.length };
    this.stats.boxes = n;

    // 危险区不是一整张悬空平面：液面逐块贴合已经下切的高度场，岸线也逐段
    // 采样局部地面。自然地形负责池壁碰撞，以下实例只补液体体积、焦黑岸石和流动亮纹。
    const hazardMatrices = [];
    const hazardColors = [];
    const bankMatrices = [];
    const bankColors = [];
    const addHazardBox = (cx, cy, cz, sx, sy, sz, color) => {
      const m = new Float32Array(16);
      M.m4FromTranslationScale([cx, cy, cz], [Math.max(0.04, sx), Math.max(0.02, sy), Math.max(0.04, sz)], m);
      hazardMatrices.push(m);
      hazardColors.push(color[0], color[1], color[2], 1);
    };
    const addBankBox = (cx, cy, cz, sx, sy, sz, color) => {
      const m = new Float32Array(16);
      M.m4FromTranslationScale([cx, cy, cz], [Math.max(0.04, sx), Math.max(0.02, sy), Math.max(0.04, sz)], m);
      bankMatrices.push(m);
      bankColors.push(color[0], color[1], color[2], 1);
    };
    for (const h of this._hazards) {
      let cx, cz, sx, sz;
      if (h.shape === 'box') {
        cx = h.center[0]; cz = h.center[2];
        sx = Math.max(0.4, h.size[0]); sz = Math.max(0.4, h.size[2]);
      } else {
        cx = h.pos[0]; cz = h.pos[2];
        sx = sz = Math.max(0.8, h.radius * 2);
      }
      const palette = hazardPalette(h.kind);
      if (h.shape === 'box') {
        const nx = Math.max(2, Math.min(18, Math.ceil(sx / 3.2)));
        const nz = Math.max(2, Math.min(18, Math.ceil(sz / 3.2)));
        const tileW = sx / nx;
        const tileD = sz / nz;
        for (let ix = 0; ix < nx; ix++) for (let iz = 0; iz < nz; iz++) {
          const tx = h.min[0] + tileW * (ix + 0.5);
          const tz = h.min[2] + tileD * (iz + 0.5);
          const tileGround = this.groundHeight(tx, tz);
          const variation = 0.84 + M.hash2((ix + h.shapeSeed) | 0, (iz - h.shapeSeed) | 0) * 0.16;
          const fill = [palette.fill[0] * variation, palette.fill[1] * variation, palette.fill[2] * variation];
          const liquidDepth = h.terrainIntegrated ? 0.13 + h.basinDepth * 0.10 : 0.09;
          addHazardBox(tx, tileGround + 0.045 - liquidDepth * 0.5, tz,
            tileW * 1.035, liquidDepth, tileD * 1.035, fill);
        }

        // 岸线逐段落在局部高度上，取代跨越整块区域的悬空矩形边框。
        const edgeThickness = Math.min(0.52, Math.max(0.28, Math.min(sx, sz) * 0.045));
        const xSegs = Math.max(2, Math.ceil(sx / 3.0));
        const zSegs = Math.max(2, Math.ceil(sz / 3.0));
        const bankColor = palette.bank;
        for (let i = 0; i < xSegs; i++) {
          const x = h.min[0] + sx * (i + 0.5) / xSegs;
          const segW = sx / xSegs * 1.035;
          for (const z of [h.min[2], h.max[2]]) {
            const y = this.groundHeight(x, z);
            const rough = 0.16 + M.hash2((i + h.shapeSeed) | 0, (z * 11) | 0) * 0.14;
            addBankBox(x, y + rough * 0.5, z, segW, rough, edgeThickness * 1.7, bankColor);
            addHazardBox(x, y + rough + 0.025, z, segW * 0.76, 0.055, edgeThickness * 0.42, palette.edge);
          }
        }
        for (let i = 0; i < zSegs; i++) {
          const z = h.min[2] + sz * (i + 0.5) / zSegs;
          const segD = sz / zSegs * 1.035;
          for (const x of [h.min[0], h.max[0]]) {
            const y = this.groundHeight(x, z);
            const rough = 0.16 + M.hash2((x * 13) | 0, (i + h.shapeSeed) | 0) * 0.14;
            addBankBox(x, y + rough * 0.5, z, edgeThickness * 1.7, rough, segD, bankColor);
            addHazardBox(x, y + rough + 0.025, z, edgeThickness * 0.42, 0.055, segD * 0.76, palette.edge);
          }
        }

        // 液体沿长轴出现断续亮纹，避免规整十字让池面重新看成 UI 贴纸。
        if (h.kind === 'lava' || h.kind === 'acid' || h.kind === 'coolant') {
          const alongX = sx >= sz;
          const veinCount = Math.max(3, Math.min(10, Math.ceil((alongX ? sx : sz) / 6)));
          for (let i = 0; i < veinCount; i++) {
            const t = (i + 0.5) / veinCount;
            const wobble = (M.hash2((i + h.shapeSeed) | 0, h.shapeSeed | 0) - 0.5) * (alongX ? sz : sx) * 0.34;
            const x = alongX ? h.min[0] + sx * t : cx + wobble;
            const z = alongX ? cz + wobble : h.min[2] + sz * t;
            const y = this.groundHeight(x, z);
            addHazardBox(x, y + 0.105, z,
              alongX ? sx / veinCount * 0.58 : 0.16,
              0.045,
              alongX ? 0.16 : sz / veinCount * 0.58,
              palette.stripe);
          }
        }
      } else {
        const y = h.pos[1] + 0.08;
        addHazardBox(cx, y, cz, sx, 0.10, sz, palette.fill);
      }
    }
    this._hazardSurfaceData = {
      matrices: new Float32Array(flatten(hazardMatrices)),
      colors: new Float32Array(hazardColors),
      count: hazardMatrices.length,
    };
    this._hazardBankData = {
      matrices: new Float32Array(flatten(bankMatrices)),
      colors: new Float32Array(bankColors),
      count: bankMatrices.length,
    };

    // 静态道具：按类型分组的实例矩阵
    const groups = new Map();
    for (const p of this._props) {
      let g = groups.get(p.type);
      if (!g) { g = { matrices: [], colors: [] }; groups.set(p.type, g); }
      const m = new Float32Array(16);
      M.m4FromYaw(p.pos, p.yaw, m);
      for (let k = 0; k < 3; k++) {
        // 叠加缩放
        m[k] *= p.scale; m[4 + k] *= p.scale; m[8 + k] *= p.scale;
      }
      g.matrices.push(m);
      g.colors.push(p.color[0], p.color[1], p.color[2], 1);
    }
    this._propGroups = [];
    for (const [type, g] of groups) {
      this._propGroups.push({
        type,
        matrices: new Float32Array(flatten(g.matrices)),
        colors: new Float32Array(g.colors),
        count: g.matrices.length,
      });
    }
  }

  applyLighting(lighting) {
    const L = lighting || {};
    this.lighting = {
      sunDir: new Float32Array(L.sunDir || DEFAULT_LIGHT.sunDir),
      sunColor: new Float32Array(L.sunColor || DEFAULT_LIGHT.sunColor),
      ambient: new Float32Array(L.ambient || DEFAULT_LIGHT.ambient),
      fill: new Float32Array(L.fill || DEFAULT_LIGHT.fill),
      fogColor: new Float32Array(L.fogColor || DEFAULT_LIGHT.fogColor),
      fogRange: new Float32Array(L.fogNear != null ? [L.fogNear, L.fogFar] : DEFAULT_LIGHT.fogRange),
      clearColor: new Float32Array(L.clearColor || DEFAULT_LIGHT.clearColor),
    };
    if (this.engine) this.engine.setLighting(this.lighting);
  }

  render(engine) {
    const e = engine || this.engine;
    if (!e) return;
    if (this.staticTerrainMesh) {
      const id = M.m4();
      e.drawMesh(this.staticTerrainMesh, id, { color: this._terrainColor || [0.22, 0.20, 0.18, 1] });
    }
    if (this.staticBoxData && this.staticBoxData.count > 0) {
      e.drawInstanced(this.meshes.cube, this.staticBoxData.matrices, this.staticBoxData.count, {
        colors: this.staticBoxData.colors,
      });
    }
    if (this._hazardBankData && this._hazardBankData.count > 0) {
      e.drawInstanced(this.meshes.cube, this._hazardBankData.matrices, this._hazardBankData.count, {
        colors: this._hazardBankData.colors,
      });
    }
    if (this._hazardSurfaceData && this._hazardSurfaceData.count > 0) {
      e.drawInstanced(this.meshes.cube, this._hazardSurfaceData.matrices, this._hazardSurfaceData.count, {
        colors: this._hazardSurfaceData.colors,
        unlit: true,
        cull: false,
      });
    }
    if (this._supplyVisualData) {
      const s = this._supplyVisualData;
      if (s.body.count > 0) e.drawInstanced(this.meshes.cube, s.body.matrices, s.body.count, { colors: s.body.colors });
      if (s.light.count > 0) e.drawInstanced(this.meshes.cube, s.light.matrices, s.light.count, {
        colors: s.light.colors, unlit: true, cull: false, depthWrite: false,
      });
    }
    if (this._propGroups) {
      for (const g of this._propGroups) {
        const mesh = propMesh(this.meshes, g.type);
        e.drawInstanced(mesh, g.matrices, g.count, { colors: g.colors });
      }
    }
    for (const v of this.importedVisuals) {
      e.drawMesh(v.mesh, v.matrix, { color: v.color });
    }
  }

  // ================================================================ 地形查询

  /**
   * 地形高度。必须与 generateHeightfieldTriangles 的三角划分和插值完全一致，
   * 否则会出现"视觉站得住、判定踩空"的问题。
   *
   * 单元的四个角（局部 0..1 的 s=tx, t=tz）：
   *   a(i,j)      b(i+1,j)      c(i+1,j+1)    d(i,j+1)
   * dy1=|ya-yc| <= dy2=|yb-yd| 时按对角线 a-c 切分：(a,b,c) 与 (a,c,d)
   *   否则按对角线 b-d 切分：(a,b,d) 与 (b,c,d)
   */
  groundHeight(x, z) {
    if (!this._terrainGrid) return this._heightFn ? this._heightFn(x, z) : 0;
    const g = this._terrainGrid;
    const fx = (x - g.x0) / g.step;
    const fz = (z - g.z0) / g.step;
    const n = g.n;
    if (!(fx >= 0 && fz >= 0 && fx < n - 1 && fz < n - 1)) {
      return this._heightFn ? this._heightFn(x, z) : 0;
    }
    const i0 = fx | 0, j0 = fz | 0;
    const s = fx - i0, t = fz - j0;
    const h = g.heights;
    const ya = h[j0 * n + i0];
    const yb = h[j0 * n + i0 + 1];
    const yc = h[(j0 + 1) * n + i0 + 1];
    const yd = h[(j0 + 1) * n + i0];
    if (Math.abs(ya - yc) <= Math.abs(yb - yd)) {
      // 对角线 a-c
      return (s + t <= 1)
        ? ya + (yb - ya) * s + (yc - yb) * t        // 三角形 (a,b,c)
        : yd + (yc - yd) * s + (ya - yd) * (1 - t); // 三角形 (a,c,d)
    }
    // 对角线 b-d
    return (t >= s)
      ? yb + (yd - yb) * s + (yc - yd) * (t - s)        // 三角形 (b,c,d)
      : yb + (ya - yb) * (1 - t) + (yd - yb) * (s - t); // 三角形 (a,b,d)
  }

  groundNormal(x, z, out) {
    if (!out) out = new Float32Array(3);
    const e = 0.6;
    const hl = this.groundHeight(x - e, z);
    const hr = this.groundHeight(x + e, z);
    const hd = this.groundHeight(x, z - e);
    const hu = this.groundHeight(x, z + e);
    let nx = hl - hr, ny = 2 * e, nz = hd - hu;
    const l = Math.hypot(nx, ny, nz) || 1;
    out[0] = nx / l; out[1] = ny / l; out[2] = nz / l;
    return out;
  }

  /** 0 = 平地，1 = 垂直 */
  sampleSlope(x, z) {
    const n = this.groundNormal(x, z, TMP_V);
    return 1 - n[1];
  }

  isWallrunSurface(normal) {
    return Math.abs(normal[1]) < 0.34;
  }

  isWalkable(normal, maxSlopeCos) {
    const cos = maxSlopeCos == null ? Math.cos(M.toRad(CFG.move.maxSlopeAngleDeg)) : maxSlopeCos;
    return normal[1] >= cos;
  }

  // ================================================================ 碰撞查询

  /**
   * 射线检测。返回 { hit, t, point, normal, kind:'box'|'tri', boxId, triIndex, flags }
   * opts: { maxDist, ignoreFlags, hitTriangles=true, hitBoxes=true }
   */
  raycast(origin, dir, maxDist, opts) {
    const o = opts || {};
    const res = {
      hit: false, t: maxDist, point: new Float32Array(3), normal: new Float32Array(3),
      kind: null, boxId: -1, triIndex: -1, flags: 0,
    };
    let bestT = maxDist;
    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const d = TMP_V2;
    d[0] = dir[0] / len; d[1] = dir[1] / len; d[2] = dir[2] / len;

    // 盒体宽相：沿射线采样
    if (o.hitBoxes !== false) {
      const ids = QUERY_BUF;
      this._boxHash.queryRay(origin[0], origin[2], d[0], d[2], maxDist, ids);
      for (let i = 0; i < ids.length; i++) {
        const b = this.boxes[ids[i]];
        if (o.ignoreFlags && (b.flags & o.ignoreFlags)) continue;
        const hit = Col.rayAABB(origin, d, b.min, b.max);
        if (hit && hit.t >= 0 && hit.t < bestT) {
          bestT = hit.t;
          res.hit = true;
          res.t = hit.t;
          res.normal[0] = hit.normal[0]; res.normal[1] = hit.normal[1]; res.normal[2] = hit.normal[2];
          res.kind = 'box';
          res.boxId = b.id;
          res.flags = b.flags;
        }
      }
    }

    // 地形三角
    if (o.hitTriangles !== false) {
      const ids = QUERY_BUF2;
      this.hash.queryRay(origin[0], origin[2], d[0], d[2], maxDist, ids);
      const T = this.triangles;
      for (let i = 0; i < ids.length; i++) {
        const ti = ids[i];
        const off = ti * 9;
        TRI0[0] = T[off]; TRI0[1] = T[off + 1]; TRI0[2] = T[off + 2];
        TRI1[0] = T[off + 3]; TRI1[1] = T[off + 4]; TRI1[2] = T[off + 5];
        TRI2[0] = T[off + 6]; TRI2[1] = T[off + 7]; TRI2[2] = T[off + 8];
        const hit = Col.rayTriangle(origin, d, TRI0, TRI1, TRI2);
        if (hit && hit.t < bestT) {
          bestT = hit.t;
          res.hit = true;
          res.t = hit.t;
          res.kind = 'tri';
          res.triIndex = ti;
          res.flags = FLAG.SOLID | FLAG.WALLRUN;
          const fn = Col.faceNormal(TRI0, TRI1, TRI2);
          // 保证法线朝向射线来向
          const dot = fn[0] * d[0] + fn[1] * d[1] + fn[2] * d[2];
          const s = dot > 0 ? -1 : 1;
          res.normal[0] = fn[0] * s; res.normal[1] = fn[1] * s; res.normal[2] = fn[2] * s;
        }
      }
    }

    if (res.hit) {
      res.point[0] = origin[0] + d[0] * res.t;
      res.point[1] = origin[1] + d[1] * res.t;
      res.point[2] = origin[2] + d[2] * res.t;
    }
    return res;
  }

  /** 视线是否通畅（AI 用，只测静态几何） */
  lineOfSight(a, b, opts) {
    const d = TMP_V;
    M.sub3(b, a, d);
    const dist = M.len3(d);
    if (dist < 0.05) return true;
    M.scale3(d, 1 / dist, d);
    const hit = this.raycast(a, d, dist - 0.05, opts);
    return !hit.hit;
  }

  /**
   * 胶囊碰撞求解（推出式）。
   * posOut 为胶囊底部中点，就地修改。返回 { grounded, groundNormal, contacts, wallNormal, wallSide }
   */
  resolveCapsule(posOut, radius, height, iterations = 4) {
    const result = {
      grounded: false,
      groundNormal: new Float32Array([0, 1, 0]),
      contacts: 0,
      wallNormal: new Float32Array(3),
      wallSide: 0,
      groundDist: Infinity,
    };
    const p0 = P0;
    const p1 = P1;
    const min = BMIN;
    const max = BMAX;
    const ids = QUERY_BUF;

    for (let iter = 0; iter < iterations; iter++) {
      // 胶囊轴端点：底部半球心 + 顶部半球心
      p0[0] = posOut[0]; p0[1] = posOut[1] + radius; p0[2] = posOut[2];
      p1[0] = posOut[0]; p1[1] = posOut[1] + height - radius; p1[2] = posOut[2];

      Col.capsuleBounds(posOut, height, radius, BOUNDS);
      const pad = 0.25;
      min[0] = BOUNDS[0] - pad; min[1] = BOUNDS[1] - pad; min[2] = BOUNDS[2] - pad;
      max[0] = BOUNDS[3] + pad; max[1] = BOUNDS[4] + pad; max[2] = BOUNDS[5] + pad;

      let deepest = 0;
      let dx = 0, dy = 0, dz = 0;
      let hasContact = false;

      // --- 盒体
      this._boxHash.queryBox(min[0], min[2], max[0], max[2], ids);
      for (let i = 0; i < ids.length; i++) {
        const b = this.boxes[ids[i]];
        if (b.max[1] < min[1] || b.min[1] > max[1]) continue;
        if (b.min[0] > max[0] || b.max[0] < min[0]) continue;
        if (b.min[2] > max[2] || b.max[2] < min[2]) continue;
        const c = Col.capsuleAABB(p0, p1, radius, b.min, b.max);
        if (c && c.depth > deepest) {
          deepest = c.depth;
          dx = c.normal[0]; dy = c.normal[1]; dz = c.normal[2];
          hasContact = true;
          if (dy > 0.55) {
            result.grounded = true;
            result.groundNormal[0] = c.normal[0];
            result.groundNormal[1] = c.normal[1];
            result.groundNormal[2] = c.normal[2];
            result.groundDist = Math.min(result.groundDist, -c.depth);
          }
        }
        if (c) result.contacts++;
      }

      // --- 地形三角
      this.hash.queryBox(min[0], min[2], max[0], max[2], ids);
      const T = this.triangles;
      for (let i = 0; i < ids.length; i++) {
        const ti = ids[i];
        const off = ti * 9;
        // 竖直剔除
        const ay = T[off + 1], by = T[off + 4], cy = T[off + 7];
        const tminY = Math.min(ay, by, cy), tmaxY = Math.max(ay, by, cy);
        if (tmaxY < min[1] || tminY > max[1]) continue;
        TRI0[0] = T[off]; TRI0[1] = ay; TRI0[2] = T[off + 2];
        TRI1[0] = T[off + 3]; TRI1[1] = by; TRI1[2] = T[off + 5];
        TRI2[0] = T[off + 6]; TRI2[1] = cy; TRI2[2] = T[off + 8];
        const c = Col.capsuleTriangle(p0, p1, radius, TRI0, TRI1, TRI2);
        if (c && c.depth > deepest) {
          deepest = c.depth;
          dx = c.normal[0]; dy = c.normal[1]; dz = c.normal[2];
          hasContact = true;
          if (dy > 0.55) {
            result.grounded = true;
            result.groundNormal[0] = c.normal[0];
            result.groundNormal[1] = c.normal[1];
            result.groundNormal[2] = c.normal[2];
            result.groundDist = Math.min(result.groundDist, -c.depth);
          }
        }
        if (c) result.contacts++;
      }

      if (!hasContact || deepest <= 1e-4) break;

      // 沿法线推出（加 0.2% 余量避免残留穿透导致抖动）
      const push = deepest * 1.002;
      posOut[0] += dx * push;
      posOut[1] += dy * push;
      posOut[2] += dz * push;

      // 记录可用于蹬墙跑的法线（水平分量大的才算墙）
      if (Math.abs(dy) < 0.34) {
        const hl = Math.hypot(dx, dz);
        if (hl > 1e-3) {
          result.wallNormal[0] = dx / hl;
          result.wallNormal[1] = 0;
          result.wallNormal[2] = dz / hl;
          result.wallSide = (dx / hl) > 0 ? 1 : -1;
        }
      }
    }

    result.pos = posOut;
    return result;
  }

  /**
   * 硬性安全钳：把胶囊从地形内部抬出来，并保证它不会停在实体里。
   *
   * 为什么需要：迭代"沿最深接触法线推出"在某些几何组合下（夹角、薄板、斜面边缘）
   * 会把胶囊推到地形**下方**——此时人会卡在地面之下，表现为"出生点/走动时穿模、
   * 只能看到地形背面"。推出式解算本身没有"最终位置必须合法"的保证，
   * 所以这里做一次独立的后置校验与纠正。
   *
   * 返回 { lifted, pushedOut } 供调试统计。
   */
  enforceCapsuleValidity(posOut, radius, height) {
    let lifted = 0;
    let pushedOut = 0;
    const p0 = P0;
    const p1 = P1;
    const ids = QUERY_BUF;

    // 1) 地形：胶囊底部不得低于地形高度
    const gy = this.groundHeight(posOut[0], posOut[2]);
    const minY = gy - 0.02;          // 留 2cm 容差，避免在斜面上反复弹
    if (posOut[1] < minY) {
      lifted = minY - posOut[1];
      posOut[1] = minY;
    }

    // 2) 盒体：如果轴心落在某个盒体内部，沿"最短退出方向"推出来
    p0[0] = posOut[0]; p0[1] = posOut[1] + radius; p0[2] = posOut[2];
    p1[0] = posOut[0]; p1[1] = posOut[1] + height - radius; p1[2] = posOut[2];
    Col.capsuleBounds(posOut, height, radius, BOUNDS);
    this._boxHash.queryBox(BOUNDS[0] - 0.3, BOUNDS[2] - 0.3, BOUNDS[3] + 0.3, BOUNDS[5] + 0.3, ids);
    for (let i = 0; i < ids.length; i++) {
      const b = this.boxes[ids[i]];
      const c = Col.capsuleAABB(p0, p1, radius, b.min, b.max);
      if (!c || c.depth <= 0) continue;
      // 只接受朝上的纠正，避免把已经被压到地下的人继续往下推
      if (c.normal[1] < -0.2) continue;
      const push = c.depth * 1.01;
      posOut[0] += c.normal[0] * push;
      posOut[1] += c.normal[1] * push;
      posOut[2] += c.normal[2] * push;
      pushedOut++;
    }

    // 3) 推出后再兜一次地形（推盒体可能又把人压进地面）
    const gy2 = this.groundHeight(posOut[0], posOut[2]);
    if (posOut[1] < gy2 - 0.02) {
      lifted += (gy2 - 0.02) - posOut[1];
      posOut[1] = gy2 - 0.02;
    }
    return { lifted, pushedOut };
  }

  /** 地面探测：向下扫掠，返回 {grounded, groundNormal, distance, point} */
  probeGround(pos, radius, height, maxDist = 0.35) {
    const origin = PROBE_O;
    origin[0] = pos[0];
    origin[1] = pos[1] + radius + 0.02;
    origin[2] = pos[2];
    const dir = PROBE_D;
    dir[0] = 0; dir[1] = -1; dir[2] = 0;
    const res = this.sweepSphere(origin, radius, [0, -(maxDist + 0.02), 0], { hitBoxes: true, hitTriangles: true });
    if (res.hit && res.normal[1] > Math.cos(M.toRad(CFG.move.maxSlopeAngleDeg + 6))) {
      return { grounded: true, groundNormal: res.normal, distance: res.t, point: res.point };
    }
    return { grounded: false, groundNormal: new Float32Array([0, 1, 0]), distance: Infinity, point: null };
  }

  /**
   * 球体扫掠（防穿透）。返回 {hit, t, point, normal}
   * 用离散推进 + 二分细化，步长按半径限制，高速也不会穿模。
   */
  sweepSphere(center, radius, delta, opts) {
    const o = opts || {};
    const dist = Math.hypot(delta[0], delta[1], delta[2]);
    if (dist < 1e-6) return NO_HIT;
    const steps = Math.max(2, Math.ceil(dist / Math.max(0.08, radius * 0.7)));
    let prevT = 0;
    const P = SWEEP_P;
    const ids = QUERY_BUF;
    const triMin = SWEEP_MIN;
    const triMax = SWEEP_MAX;

    const testAt = (t) => {
      P[0] = center[0] + delta[0] * t;
      P[1] = center[1] + delta[1] * t;
      P[2] = center[2] + delta[2] * t;
      // 盒体
      const bmin = [P[0] - radius, P[1] - radius, P[2] - radius];
      const bmax = [P[0] + radius, P[1] + radius, P[2] + radius];
      if (o.hitBoxes !== false) {
        this._boxHash.queryBox(bmin[0], bmin[2], bmax[0], bmax[2], ids);
        for (let i = 0; i < ids.length; i++) {
          const b = this.boxes[ids[i]];
          if (o.ignoreFlags && (b.flags & o.ignoreFlags)) continue;
          const c = Col.sphereAABB(P, radius, b.min, b.max);
          if (c) {
            NORM[0] = c.normal[0]; NORM[1] = c.normal[1]; NORM[2] = c.normal[2];
            return true;
          }
        }
      }
      // 地形
      if (o.hitTriangles !== false) {
        this.hash.queryBox(bmin[0], bmin[2], bmax[0], bmax[2], ids);
        const T = this.triangles;
        for (let i = 0; i < ids.length; i++) {
          const off = ids[i] * 9;
          triMin[0] = Math.min(T[off], T[off + 3], T[off + 6]);
          triMax[0] = Math.max(T[off], T[off + 3], T[off + 6]);
          if (P[0] + radius < triMin[0] || P[0] - radius > triMax[0]) continue;
          triMin[1] = Math.min(T[off + 1], T[off + 4], T[off + 7]);
          triMax[1] = Math.max(T[off + 1], T[off + 4], T[off + 7]);
          if (P[1] + radius < triMin[1] || P[1] - radius > triMax[1]) continue;
          triMin[2] = Math.min(T[off + 2], T[off + 5], T[off + 8]);
          triMax[2] = Math.max(T[off + 2], T[off + 5], T[off + 8]);
          if (P[2] + radius < triMin[2] || P[2] - radius > triMax[2]) continue;
          TRI0[0] = T[off]; TRI0[1] = T[off + 1]; TRI0[2] = T[off + 2];
          TRI1[0] = T[off + 3]; TRI1[1] = T[off + 4]; TRI1[2] = T[off + 5];
          TRI2[0] = T[off + 6]; TRI2[1] = T[off + 7]; TRI2[2] = T[off + 8];
          const c = Col.sphereTriangle(P, radius, TRI0, TRI1, TRI2);
          if (c) {
            NORM[0] = c.normal[0]; NORM[1] = c.normal[1]; NORM[2] = c.normal[2];
            return true;
          }
        }
      }
      return false;
    };

    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      if (testAt(t)) {
        let lo = prevT, hi = t;
        for (let k = 0; k < 8; k++) {
          const mid = (lo + hi) * 0.5;
          if (testAt(mid)) hi = mid; else lo = mid;
        }
        SWEEP_RESULT.hit = true;
        SWEEP_RESULT.t = hi * dist;
        SWEEP_RESULT.point[0] = center[0] + delta[0] * hi;
        SWEEP_RESULT.point[1] = center[1] + delta[1] * hi;
        SWEEP_RESULT.point[2] = center[2] + delta[2] * hi;
        SWEEP_RESULT.normal[0] = NORM[0];
        SWEEP_RESULT.normal[1] = NORM[1];
        SWEEP_RESULT.normal[2] = NORM[2];
        return SWEEP_RESULT;
      }
      prevT = t;
    }
    return NO_HIT;
  }

  // ================================================================ 点位查询

  spawnPoints() { return this._spawnPoints; }
  playerSpawns() { return this._playerSpawns; }
  extractPoints() { return this._extractPoints; }
  objectives() { return this._objectives; }
  supplyStations() { return this._supplyStations; }
  hazards() { return this._hazards; }
  navCandidates() { return this._navCandidates; }

  /** 找一个远离 reference 的开放点（刷怪用） */
  randomOpenPoint(rng, minDistFrom, out) {
    if (!out) out = new Float32Array(3);
    const cands = this._navCandidates;
    if (cands.length === 0) {
      out[0] = 0; out[1] = this.groundHeight(0, 0); out[2] = 0;
      return out;
    }
    const minD2 = (minDistFrom || 0) * (minDistFrom || 0);
    for (let attempt = 0; attempt < 40; attempt++) {
      const c = cands[(rng() * cands.length) | 0];
      if (minDistFrom && M.distSq3(c, minDistFrom) < minD2) continue;
      out[0] = c[0]; out[1] = c[1]; out[2] = c[2];
      return out;
    }
    const c = cands[(rng() * cands.length) | 0];
    out[0] = c[0]; out[1] = c[1]; out[2] = c[2];
    return out;
  }

  randomNavPoint(rng) {
    return this.randomOpenPoint(rng, null, new Float32Array(3));
  }

  /** 把点吸附到地面上方一点 */
  snapToGround(pos, margin = 0.05) {
    const y = this.groundHeight(pos[0], pos[2]);
    // 检查是否有盒体顶面更高
    const ids = QUERY_BUF;
    this._boxHash.queryBox(pos[0] - 0.4, pos[2] - 0.4, pos[0] + 0.4, pos[2] + 0.4, ids);
    let best = y;
    for (let i = 0; i < ids.length; i++) {
      const b = this.boxes[ids[i]];
      if (pos[0] < b.min[0] - 0.4 || pos[0] > b.max[0] + 0.4) continue;
      if (pos[2] < b.min[2] - 0.4 || pos[2] > b.max[2] + 0.4) continue;
      if (b.max[1] > best && b.max[1] < pos[1] + 6) best = b.max[1];
    }
    pos[1] = best + margin;
    return pos;
  }

  /**
   * 找到安全的玩家出生点。
   *
   * 之前只做"贴到地形表面"，结果在地图结构密集的区域（集装箱堆场等）会把玩家
   * 直接放进结构内部 —— 表现就是"卡模型 / 看不到外面"。
   * 这里要求真正的空间余量：头顶高度、四周水平余量、并且不是站在盒体里。
   *
   * @param index 优先使用第几个地图给定出生点（作为搜索起点）
   */
  findPlayerSpawn(index = 0) {
    const out = new Float32Array(3);
    const list = this._playerSpawns;

    // 候选起点：地图给定出生点优先，其后并入导航采样点
    const starts = [];
    if (list.length > 0) {
      for (let i = 0; i < list.length; i++) {
        const p = list[(index + i) % list.length];
        starts.push(p);
      }
    }
    const cands = this._navCandidates;

    const test = (x, z) => {
      const y = this.groundHeight(x, z);
      if (!(y > -30) || !isFinite(y)) return null;
      // 太陡不能站
      if (this.sampleSlope(x, z) > 0.45) return null;
      const r = 0.42;            // 胶囊半径 + 余量
      const h = 1.85;
      // 1) 头顶必须有空间
      const up = this.raycast([x, y + 0.1, z], [0, 1, 0], 2.6, {});
      if (up.hit) return null;
      // 2) 四周水平 1.4m 内不能有障碍（防止贴脸卡墙）
      for (let a = 0; a < 6; a++) {
        const ang = a * Math.PI / 3;
        const hit = this.raycast([x, y + 1.1, z], [Math.cos(ang), 0, Math.sin(ang)], 1.4, {});
        if (hit.hit) return null;
      }
      // 3) 脚下不能是盒体内部
      const ids = QUERY_BUF2;
      ids.length = 0;
      this._boxHash.queryBox(x - r, z - r, x + r, z + r, ids);
      for (let i = 0; i < ids.length; i++) {
        const b = this.boxes[ids[i]];
        if (b.max[1] <= y + 0.05 || b.min[1] >= y + h) continue;
        const qx = Math.max(b.min[0], Math.min(x, b.max[0]));
        const qz = Math.max(b.min[2], Math.min(z, b.max[2]));
        const dx = x - qx, dz = z - qz;
        if (dx * dx + dz * dz < r * r) return null;
      }
      return y;
    };

    // 先试给定出生点
    for (const p of starts) {
      const y = test(p[0], p[2]);
      if (y !== null) { out[0] = p[0]; out[1] = y + 0.08; out[2] = p[2]; return out; }
    }
    // 再从导航点里按"离中心近"的顺序找
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      const y = test(c[0], c[2]);
      if (y !== null) { out[0] = c[0]; out[1] = y + 0.08; out[2] = c[2]; return out; }
    }
    // 实在找不到就退回旧行为（保证不崩）
    const p0 = list.length ? list[index % list.length] : [0, 0, 0];
    out[0] = p0[0]; out[2] = p0[2];
    out[1] = Math.max(p0[1], this.groundHeight(out[0], out[2])) + 0.4;
    return out;
  }

  // ================================================================ 模型导入

  /**
   * 导入外部模型（仅视觉）。placement = { pos, yaw, scale, color, collision }
   * collision.mode: 'none' | 'box' | 'aabbPerNode'
   */
  importVisual(gltfDoc, placement, loadGLTFInstanceModels, engine) {
    const e = engine || this.engine;
    if (!gltfDoc || !e) return 0;
    const instances = loadGLTFInstanceModels(gltfDoc);
    const base = new Float32Array(16);
    const p = placement || {};
    M.m4FromYaw(new Float32Array(p.pos || [0, 0, 0]), p.yaw || 0, base);
    const sc = p.scale == null ? 1 : p.scale;
    if (sc !== 1) {
      for (let k = 0; k < 3; k++) { base[k] *= sc; base[4 + k] *= sc; base[8 + k] *= sc; }
    }
    let added = 0;
    const color = p.color || [1, 1, 1];
    let bmin = null, bmax = null;
    for (const inst of instances) {
      const prim = gltfDoc.meshes[inst.meshIndex];
      if (!prim || !prim.prims || prim.prims.length === 0) continue;
      for (const pp of prim.prims) {
        const mesh = e.createMeshFromGLTF(pp);
        const m = new Float32Array(16);
        M.m4Mul(base, inst.matrix, m);
        this.importedVisuals.push({ mesh, matrix: m, color, source: p.id || 'imported' });
        added++;
        // 记录 AABB（用网格包围盒变换后的近似）
        const bb = mesh.bounds;
        if (!bmin) { bmin = new Float32Array(3); bmax = new Float32Array(3); }
      }
    }
    // 碰撞：可选（程序化几何仍是判定权威，导入模型仅在显式要求时补一个盒体）
    const colMode = (p.collision && p.collision.mode) || 'none';
    if (colMode === 'box' && added > 0) {
      const gmin = new Float32Array([Infinity, Infinity, Infinity]);
      const gmax = new Float32Array([-Infinity, -Infinity, -Infinity]);
      for (const v of this.importedVisuals) {
        for (let c = 0; c < 8; c++) {
          const wp = M.m4TransformPoint(v.matrix, CORNERS[c], TMP_V);
          for (let k = 0; k < 3; k++) {
            if (wp[k] < gmin[k]) gmin[k] = wp[k];
            if (wp[k] > gmax[k]) gmax[k] = wp[k];
          }
        }
      }
      if (isFinite(gmin[0]) && gmax[1] > gmin[1]) {
        this._addBox(gmin, gmax, FLAG.SOLID | FLAG.WALLRUN | FLAG.CLIMBABLE, 'imported');
        this.buildStaticMeshes();
      }
    }
    this.importedCount += added;
    return added;
  }

  debugState() {
    return {
      map: this.mapName,
      biome: this.biomeId,
      size: this.size,
      triangleCount: this.triangleCount,
      boxCount: this.boxes.length,
      propCount: this._props.length,
      spawnPoints: this._spawnPoints.length,
      objectives: this._objectives.filter((o) => !o.done).length,
      extractPoints: this._extractPoints.length,
      navCandidates: this._navCandidates.length,
      importedVisuals: this.importedVisuals.length,
      hash: this.hash.stats(),
    };
  }
}

// ---------------------------------------------------------------- 静态暂存

const QUERY_BUF2 = [];
const TRI0 = new Float32Array(3);
const TRI1 = new Float32Array(3);
const TRI2 = new Float32Array(3);
const P0 = new Float32Array(3);
const P1 = new Float32Array(3);
const BMIN = new Float32Array(3);
const BMAX = new Float32Array(3);
const BOUNDS = new Float32Array(6);
const PROBE_O = new Float32Array(3);
const PROBE_D = new Float32Array(3);
const SWEEP_P = new Float32Array(3);
const SWEEP_MIN = new Float32Array(3);
const SWEEP_MAX = new Float32Array(3);
const NORM = new Float32Array(3);
const NO_HIT = { hit: false, t: Infinity, point: null, normal: null };
const SWEEP_RESULT = {
  hit: false, t: 0, point: new Float32Array(3), normal: new Float32Array(3),
};
const CORNERS = [
  [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5],
  [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5],
];

function flatten(list) {
  const total = list.reduce((a, m) => a + m.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const m of list) { out.set(m, o); o += m.length; }
  return out;
}

/** 材质 -> 颜色（工业冷色调） */
export function materialColor(material, flags) {
  if (flags & FLAG.HAZARD) return [0.95, 0.16, 0.025];
  switch (material) {
    case 'concrete': return [0.26, 0.26, 0.27];
    case 'plate': return [0.30, 0.32, 0.35];
    case 'grate': return [0.22, 0.24, 0.26];
    case 'wall': return [0.28, 0.29, 0.31];
    case 'rust': return [0.34, 0.22, 0.14];
    case 'hazard': return [0.95, 0.22, 0.025];
    case 'glass': return [0.22, 0.34, 0.40];
    case 'prop': return [0.30, 0.29, 0.27];
    case 'imported': return [0.42, 0.44, 0.47];
    case 'metal':
    default: return [0.29, 0.30, 0.33];
  }
}

/** 危险种类 -> 高对比无光照配色。数值刻意比任何普通地面明亮。 */
function hazardPalette(kind) {
  switch (kind) {
    case 'lava': return { fill: [1.00, 0.09, 0.01], edge: [1.00, 0.72, 0.06], stripe: [1.00, 0.94, 0.42], bank: [0.16, 0.075, 0.045] };
    case 'acid': return { fill: [0.18, 0.82, 0.025], edge: [0.68, 1.00, 0.08], stripe: [0.90, 1.00, 0.52], bank: [0.12, 0.14, 0.055] };
    case 'coolant': return { fill: [0.02, 0.48, 0.86], edge: [0.12, 0.94, 1.00], stripe: [0.64, 1.00, 1.00], bank: [0.09, 0.13, 0.17] };
    case 'vacuum': return { fill: [0.11, 0.025, 0.22], edge: [0.73, 0.25, 1.00], stripe: [0.94, 0.68, 1.00], bank: [0.09, 0.07, 0.13] };
    case 'radiation': return { fill: [0.72, 0.48, 0.01], edge: [1.00, 0.94, 0.04], stripe: [1.00, 1.00, 0.66], bank: [0.16, 0.13, 0.055] };
    default: return { fill: [0.92, 0.10, 0.02], edge: [1.00, 0.66, 0.06], stripe: [1.00, 0.92, 0.44], bank: [0.15, 0.07, 0.045] };
  }
}

function propCollisionSize(type, scale) {
  switch (type) {
    case 'crate': return [0.9 * scale, 1.0 * scale, 0.9 * scale];
    case 'barrel': return [0.55 * scale, 1.35 * scale, 0.55 * scale];
    case 'pillar': return [0.7 * scale, 6 * scale, 0.7 * scale];
    case 'silo': return [1.9 * scale, 8 * scale, 1.9 * scale];
    case 'tank': return [2.4 * scale, 4.2 * scale, 2.4 * scale];
    case 'antenna': return [0.4 * scale, 9 * scale, 0.4 * scale];
    case 'pipe': return [0.5 * scale, 0.5 * scale, 4 * scale];
    default: return [0.8 * scale, 0.9 * scale, 0.8 * scale];
  }
}

function propMesh(meshes, type) {
  switch (type) {
    case 'barrel': case 'silo': case 'tank': return meshes.cylinder;
    case 'pillar': return meshes.cube;
    case 'pipe': return meshes.cylinderThin;
    case 'antenna': return meshes.cylinderThin;
    case 'lightpost': return meshes.cylinderThin;
    case 'crate': default: return meshes.cube;
  }
}

// ---------------------------------------------------------------- 地形噪声（与地图生成器逐位一致）
// 为什么不用 core/math.js 的 fbm2：地图生成器的噪声带 seed 参与哈希，两者曲线不同。
// 载体地形必须与地图生成器**同一条曲线**，否则可达性校验（在生成器侧）与实际碰撞地形
// 会对不上，玩家会在出生点陷地或悬空。所以这里照搬同一套哈希/插值。

const NOISE_WAVELENGTH = 26;
const FIELD_DETAIL = 0.16;   // 分级模式下噪声细节占比（与 builtin-maps.js 一致）
const TERRAIN_FLOOR = -34;   // 世界地板：保证任何位置都有落脚面

function hash2i(ix, iy, seed) {
  let t = (Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function noiseValue2(x, y, seed) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2i(x0, y0, seed);
  const b = hash2i(x0 + 1, y0, seed);
  const c = hash2i(x0, y0 + 1, seed);
  const d = hash2i(x0 + 1, y0 + 1, seed);
  const ab = a + (b - a) * sx;
  const cd = c + (d - c) * sx;
  return ab + (cd - ab) * sy;
}

function noiseFbm2(x, y, octaves, lacunarity, gain, seed) {
  const oct = Math.max(1, octaves | 0);
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += noiseValue2(x * freq, y * freq, seed + i * 1013) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/** 双线性采样分级地形场（与 builtin-maps.js 的 sampleField 等价） */
function sampleGradedField(field, x, z) {
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
  const ab = a + (b - a) * sx;
  const cd = c + (d - c) * sx;
  return ab + (cd - ab) * sz;
}

/** 地形要素（平台/沟壑）的归一化，兼容 {radius,height} 与 {radius,amount} 两种写法 */
function normalizeFeatures(list, amountKey) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const f of list) {
    if (!f) continue;
    const amount = f[amountKey] != null ? f[amountKey]
      : (amountKey === 'height' ? (f.height != null ? f.height : f.amount)
        : (f.depth != null ? f.depth : f.amount));
    out.push({
      x: f.x || 0,
      z: f.z || 0,
      radius: f.radius == null ? 10 : f.radius,
      falloff: f.falloff == null ? 10 : f.falloff,
      amount: amount || 0,
    });
  }
  return out;
}

function normalizeHazardBasins(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const b of list) {
    if (!b) continue;
    const w = Number.isFinite(b.w) ? b.w : (Number.isFinite(b.width) ? b.width : 1);
    const d = Number.isFinite(b.d) ? b.d : (Number.isFinite(b.depthSize) ? b.depthSize : 1);
    out.push({
      x: Number.isFinite(b.x) ? b.x : 0,
      z: Number.isFinite(b.z) ? b.z : 0,
      halfW: Math.max(0.8, w) * 0.5,
      halfD: Math.max(0.8, d) * 0.5,
      depth: Math.max(0, Number.isFinite(b.basinDepth) ? b.basinDepth : 0),
      rimWidth: Math.max(0.8, Number.isFinite(b.rimWidth) ? b.rimWidth : 3.5),
    });
  }
  return out;
}

function applyHazardBasins(h, x, z, basins) {
  for (let i = 0; i < basins.length; i++) {
    const b = basins[i];
    const ix = b.halfW - Math.abs(x - b.x);
    const iz = b.halfD - Math.abs(z - b.z);
    if (ix <= 0 || iz <= 0) continue;
    const inward = Math.min(ix, iz);
    h -= b.depth * M.smoothstep(0, b.rimWidth, inward);
  }
  return h;
}

/**
 * 由地形规格构造确定性高度函数。
 *
 * 优先使用 `spec.field`（地图生成器产出的"分级地形场"）：
 * 那份数据已经过"填谷削峰"整平，保证坡度可步行，且与地图的连通性校验同源。
 * 没有 field 时退回纯噪声 + 平台/沟壑的解析式地形。
 *
 * 本实现与 maps/builtin-maps.js 的 makeHeightFn 逐位一致 —— tools/test-modules.mjs
 * 会用随机采样对比两者，防止将来漂移。
 */
export function makeHeightFn(spec) {
  const s = spec || {};
  const seed = ((s.seed | 0) || 0) >>> 0;
  const base = s.baseHeight || 0;
  const amp = s.amplitude == null ? 0 : s.amplitude;
  const oct = M.clamp(s.octaves | 0 || 4, 1, 8);
  const lac = s.lacunarity == null ? 2 : s.lacunarity;
  const gain = s.gain == null ? 0.5 : s.gain;
  const roughness = s.roughness == null ? 1 : s.roughness;
  const plateau = normalizeFeatures(s.plateau, 'height');
  const trenches = normalizeFeatures(s.trenches, 'depth');
  const hazardBasins = normalizeHazardBasins(s.hazardBasins);
  const field = s.field || null;
  const inv = 1 / (NOISE_WAVELENGTH * roughness);

  return function heightFn(x, z) {
    // 分级地形优先
    if (field) {
      let h = sampleGradedField(field, x, z);
      if (amp !== 0) {
        const n = noiseFbm2(x * inv, z * inv, oct, lac, gain, seed);
        h += (n * 2 - 1) * amp * FIELD_DETAIL;
      }
      h = applyHazardBasins(h, x, z, hazardBasins);
      return h < TERRAIN_FLOOR ? TERRAIN_FLOOR : h;
    }
    // 解析式回退
    let h = base;
    if (amp !== 0) {
      const n = noiseFbm2(x * inv, z * inv, oct, lac, gain, seed);
      h += (n * 2 - 1) * amp;
    }
    for (let i = 0; i < plateau.length; i++) {
      const p = plateau[i];
      const d = Math.hypot(x - p.x, z - p.z);
      const t = 1 - M.smoothstep(p.radius, p.radius + p.falloff, d);
      if (t > 0) h += p.amount * t;
    }
    for (let i = 0; i < trenches.length; i++) {
      const p = trenches[i];
      const d = Math.hypot(x - p.x, z - p.z);
      const t = 1 - M.smoothstep(p.radius, p.radius + p.falloff, d);
      if (t > 0) h += p.amount * t;
    }
    h = applyHazardBasins(h, x, z, hazardBasins);
    return h < TERRAIN_FLOOR ? TERRAIN_FLOOR : h;
  };
}

export default World;
