// ==== tools/test-maps.mjs — 地图库 / GLTF 解析器自检（Node，无第三方依赖） ====

// 设计意图：地图生成与模型导入是两条最容易"悄悄坏掉"的链路。
// 这个脚本用同一份判据（schema + 连通性 + 确定性）跑遍所有原型×生物群系，
// 再在内存里现场拼一个 GLB 与一个 data-URI .gltf 来验证解析器，
// 最后打印每个地图的一行摘要，方便人工扫一眼关卡质量。

import {
  FLAG,
  BIOMES,
  BIOME_IDS,
  ARCHETYPE_IDS,
  MISSIONS,
  MAP_FORMAT_VERSION,
  makeHeightFn,
  generateMap,
  getMission,
  getBiome,
  checkReachability,
} from '../src/maps/builtin-maps.js';

import {
  parseGLTF,
  gltfInstanceModels,
  describeGLTF,
} from '../src/fx/gltf.js';

// ---------------------------------------------------------------------------
// 测试框架（极简）
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];
const groupResults = [];

function group(name, fn) {
  const before = failed;
  const t0 = Date.now();
  try {
    fn();
  } catch (e) {
    failed++;
    failures.push(`[${name}] threw: ${e && e.message ? e.message : String(e)}`);
  }
  const ok = failed === before;
  groupResults.push({ name, ok, ms: Date.now() - t0 });
  if (ok) passed++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + '  (' + (Date.now() - t0) + 'ms)');
}

function check(cond, msg) {
  if (cond) {
    passed++;
    return true;
  }
  failed++;
  failures.push(msg);
  console.log('  ! ' + msg);
  return false;
}

function eq(a, b, msg) {
  return check(a === b, msg + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');
}

// ---------------------------------------------------------------------------
// 数据结构 schema 校验器（按契约 8.1 手写）
// ---------------------------------------------------------------------------

const REQUIRED_KEYS = [
  'version', 'name', 'biome', 'size', 'seed', 'terrain',
  'boxes', 'platforms', 'catwalks', 'walls', 'props',
  'spawnPoints', 'playerSpawns', 'extractPoints', 'objectives', 'lighting',
];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 递归遍历整棵树，任何 NaN / Infinity / undefined / 函数都视为非法。 */
function walkFinite(value, path, problems) {
  if (value === null) return;
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value)) problems.push(path + ' is ' + value);
    return;
  }
  if (t === 'string' || t === 'boolean') return;
  if (t === 'undefined') {
    problems.push(path + ' is undefined');
    return;
  }
  if (t === 'function') {
    problems.push(path + ' is a function');
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) walkFinite(value[i], path + '[' + i + ']', problems);
    return;
  }
  if (t === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      problems.push(path + ' has non-plain prototype');
      return;
    }
    for (const k of Object.keys(value)) walkFinite(value[k], path + '.' + k, problems);
    return;
  }
  problems.push(path + ' has unsupported type ' + t);
}

function vec3(v, path, problems) {
  if (!Array.isArray(v) || v.length !== 3) {
    problems.push(path + ' is not a vec3');
    return;
  }
  for (let i = 0; i < 3; i++) {
    if (!isNum(v[i])) problems.push(path + '[' + i + '] is not finite');
  }
}

/**
 * 校验一张地图是否符合契约 8.1 以及本项目的生成规则。
 * @returns {string[]} 问题列表（空数组 = 通过）
 */
function validateMap(m, opts) {
  const problems = [];
  if (!m || typeof m !== 'object') return ['map is not an object'];

  for (const k of REQUIRED_KEYS) {
    if (!(k in m)) problems.push('missing required key "' + k + '"');
  }
  if (m.version !== MAP_FORMAT_VERSION) problems.push('version !== 1');
  if (!Number.isInteger(m.version)) problems.push('version is not an integer');
  if (typeof m.name !== 'string' || m.name.length < 3) problems.push('name is not a usable string');
  if (!BIOMES[m.biome]) problems.push('unknown biome "' + m.biome + '"');
  if (!isNum(m.size) || m.size < 120 || m.size > 420) problems.push('size out of range: ' + m.size);
  if (!Number.isInteger(m.seed)) problems.push('seed is not an integer');
  if (typeof m.seed !== 'number' || m.seed < 0 || m.seed > 0xffffffff) problems.push('seed out of uint32 range');

  // --- terrain ---
  const t = m.terrain;
  if (!t || typeof t !== 'object') {
    problems.push('terrain is not an object');
  } else {
    if (!Number.isInteger(t.resolution) || t.resolution < 16 || t.resolution > 260) {
      problems.push('terrain.resolution out of range: ' + t.resolution);
    }
    if (!isNum(t.baseHeight)) problems.push('terrain.baseHeight not finite');
    if (!isNum(t.amplitude) || t.amplitude < 0 || t.amplitude > 60) {
      problems.push('terrain.amplitude out of range: ' + t.amplitude);
    }
    if (!Number.isInteger(t.octaves) || t.octaves < 1 || t.octaves > 8) {
      problems.push('terrain.octaves out of range: ' + t.octaves);
    }
    if (!isNum(t.lacunarity) || t.lacunarity < 1) problems.push('terrain.lacunarity < 1');
    if (!isNum(t.gain) || t.gain <= 0 || t.gain > 1) problems.push('terrain.gain out of (0,1]');
    if (!Array.isArray(t.plateau)) problems.push('terrain.plateau is not an array');
    if (!Array.isArray(t.trenches)) problems.push('terrain.trenches is not an array');
  }

  // --- boxes ---
  if (!Array.isArray(m.boxes)) {
    problems.push('boxes is not an array');
  } else {
    if (m.boxes.length < 60 || m.boxes.length > 400) {
      problems.push('box count ' + m.boxes.length + ' outside [60,400]');
    }
    let flagsMissing = 0;
    for (let i = 0; i < m.boxes.length; i++) {
      const b = m.boxes[i];
      const p = 'boxes[' + i + ']';
      if (!b || typeof b !== 'object') { problems.push(p + ' is not an object'); continue; }
      if (!Array.isArray(b.min) || b.min.length !== 3) problems.push(p + '.min is not vec3');
      if (!Array.isArray(b.max) || b.max.length !== 3) problems.push(p + '.max is not vec3');
      if (!Array.isArray(b.min) || !Array.isArray(b.max)) continue;
      for (let k = 0; k < 3; k++) {
        if (!isNum(b.min[k]) || !isNum(b.max[k])) problems.push(p + ' has non-finite bound');
      }
      if (!(b.min[0] < b.max[0])) problems.push(p + ' min.x >= max.x');
      if (!(b.min[1] < b.max[1])) problems.push(p + ' min.y >= max.y');
      if (!(b.min[2] < b.max[2])) problems.push(p + ' min.z >= max.z');
      if (typeof b.flags !== 'number' || !Number.isInteger(b.flags) || b.flags <= 0) {
        flagsMissing++;
        problems.push(p + '.flags missing or invalid: ' + b.flags);
      }
      if (typeof b.material !== 'string' || b.material.length === 0) problems.push(p + '.material invalid');
      if (Math.abs(b.min[0]) > m.size || Math.abs(b.max[0]) > m.size) problems.push(p + ' x out of map');
      if (Math.abs(b.min[2]) > m.size || Math.abs(b.max[2]) > m.size) problems.push(p + ' z out of map');
      if (b.max[1] > 200) problems.push(p + ' too tall: ' + b.max[1]);
      if (b.min[1] < -40) problems.push(p + ' below world floor: ' + b.min[1]);
    }
    if (flagsMissing > 0) problems.push(flagsMissing + ' boxes without flags');
  }

  // --- platforms / catwalks / walls / props ---
  if (!Array.isArray(m.platforms)) problems.push('platforms is not an array');
  else {
    for (let i = 0; i < m.platforms.length; i++) {
      const p = m.platforms[i];
      vec3(p.pos, 'platforms[' + i + '].pos', problems);
      vec3(p.size, 'platforms[' + i + '].size', problems);
      if (!isNum(p.angle)) problems.push('platforms[' + i + '].angle not finite');
      if (typeof p.flags !== 'number') problems.push('platforms[' + i + '].flags missing');
      if (Array.isArray(p.size) && !(p.size[1] > 0)) problems.push('platforms[' + i + '].size.y <= 0');
    }
  }
  if (!Array.isArray(m.catwalks)) problems.push('catwalks is not an array');
  else {
    for (let i = 0; i < m.catwalks.length; i++) {
      const c = m.catwalks[i];
      if (!Array.isArray(c.points) || c.points.length < 2) {
        problems.push('catwalks[' + i + '].points needs >= 2 points');
        continue;
      }
      for (let k = 0; k < c.points.length; k++) vec3(c.points[k], 'catwalks[' + i + '].points[' + k + ']', problems);
      if (!isNum(c.width) || c.width <= 0) problems.push('catwalks[' + i + '].width invalid');
      if (typeof c.flags !== 'number') problems.push('catwalks[' + i + '].flags missing');
    }
  }
  if (!Array.isArray(m.walls)) problems.push('walls is not an array');
  else {
    for (let i = 0; i < m.walls.length; i++) {
      const w = m.walls[i];
      if (!Array.isArray(w.points) || w.points.length !== 2) { problems.push('walls[' + i + '].points must be 2'); continue; }
      vec3(w.points[0], 'walls[' + i + '].points[0]', problems);
      vec3(w.points[1], 'walls[' + i + '].points[1]', problems);
      if (!isNum(w.height) || w.height <= 0) problems.push('walls[' + i + '].height invalid');
      if (!isNum(w.thickness) || w.thickness <= 0) problems.push('walls[' + i + '].thickness invalid');
      if (typeof w.flags !== 'number') problems.push('walls[' + i + '].flags missing');
    }
  }
  if (!Array.isArray(m.props)) problems.push('props is not an array');
  else {
    for (let i = 0; i < m.props.length; i++) {
      const pr = m.props[i];
      if (typeof pr.type !== 'string' || pr.type.length === 0) problems.push('props[' + i + '].type invalid');
      vec3(pr.pos, 'props[' + i + '].pos', problems);
      if (!isNum(pr.scale) || pr.scale <= 0) problems.push('props[' + i + '].scale invalid');
      if (!isNum(pr.yaw)) problems.push('props[' + i + '].yaw not finite');
    }
  }

  // --- 出生点 ---
  if (!Array.isArray(m.playerSpawns) || m.playerSpawns.length < 1) problems.push('playerSpawns empty');
  else {
    for (let i = 0; i < m.playerSpawns.length; i++) vec3(m.playerSpawns[i], 'playerSpawns[' + i + ']', problems);
  }
  if (!Array.isArray(m.spawnPoints)) problems.push('spawnPoints is not an array');
  else {
    if (m.spawnPoints.length < 8 || m.spawnPoints.length > 16) {
      problems.push('spawnPoints count ' + m.spawnPoints.length + ' outside [8,16]');
    }
    for (let i = 0; i < m.spawnPoints.length; i++) {
      const s = m.spawnPoints[i];
      vec3(s, 'spawnPoints[' + i + ']', problems);
      if (!Array.isArray(s)) continue;
      for (let j = 0; j < m.playerSpawns.length; j++) {
        const p = m.playerSpawns[j];
        const d = Math.hypot(s[0] - p[0], s[2] - p[2]);
        if (!(d > 25)) problems.push('spawnPoints[' + i + '] only ' + d.toFixed(2) + 'm from playerSpawns[' + j + ']');
      }
    }
  }

  // --- 撤离点 / 目标 / 补给 ---
  if (!Array.isArray(m.extractPoints)) problems.push('extractPoints is not an array');
  else {
    if (m.extractPoints.length < 2 || m.extractPoints.length > 4) {
      problems.push('extractPoints count ' + m.extractPoints.length + ' outside [2,4]');
    }
    const half = m.size / 2;
    for (let i = 0; i < m.extractPoints.length; i++) {
      const e = m.extractPoints[i];
      vec3(e.pos, 'extractPoints[' + i + '].pos', problems);
      if (!isNum(e.radius) || e.radius <= 0) problems.push('extractPoints[' + i + '].radius invalid');
      if (Array.isArray(e.pos)) {
        const d = Math.max(Math.abs(e.pos[0]), Math.abs(e.pos[2]));
        if (d < half * 0.40) problems.push('extractPoints[' + i + '] not peripheral (|max|=' + d.toFixed(1) + ')');
      }
    }
  }
  if (!Array.isArray(m.objectives)) problems.push('objectives is not an array');
  else {
    if (m.objectives.length < 3 || m.objectives.length > 6) {
      problems.push('objectives count ' + m.objectives.length + ' outside [3,6]');
    }
    const seen = new Set();
    for (let i = 0; i < m.objectives.length; i++) {
      const o = m.objectives[i];
      if (typeof o.id !== 'string' || o.id.length === 0) problems.push('objectives[' + i + '].id invalid');
      else if (seen.has(o.id)) problems.push('duplicate objective id ' + o.id);
      else seen.add(o.id);
      if (typeof o.type !== 'string' || o.type.length === 0) problems.push('objectives[' + i + '].type invalid');
      if (typeof o.label !== 'string' || o.label.length === 0) problems.push('objectives[' + i + '].label invalid');
      else if (!/[\u4e00-\u9fff]/.test(o.label)) problems.push('objectives[' + i + '].label 不是中文: ' + o.label);
      vec3(o.pos, 'objectives[' + i + '].pos', problems);
      if (!isNum(o.radius) || o.radius <= 0) problems.push('objectives[' + i + '].radius invalid');
      if (typeof o.required !== 'boolean') problems.push('objectives[' + i + '].required must be boolean');
    }
  }
  if (!Array.isArray(m.supplyStations)) problems.push('supplyStations is not an array');
  else {
    if (m.supplyStations.length < 2 || m.supplyStations.length > 3) {
      problems.push('supplyStations count ' + m.supplyStations.length + ' outside [2,3]');
    }
    for (let i = 0; i < m.supplyStations.length; i++) {
      const s = m.supplyStations[i];
      if (typeof s.id !== 'string') problems.push('supplyStations[' + i + '].id invalid');
      if (typeof s.label !== 'string' || !/[\u4e00-\u9fff]/.test(s.label)) {
        problems.push('supplyStations[' + i + '].label 不是中文');
      }
      vec3(s.pos, 'supplyStations[' + i + '].pos', problems);
      if (!Array.isArray(s.items) || s.items.length === 0) problems.push('supplyStations[' + i + '].items empty');
      if (!isNum(s.radius) || s.radius <= 0) problems.push('supplyStations[' + i + '].radius invalid');
    }
  }
  if (m.hazards != null && !Array.isArray(m.hazards)) problems.push('hazards is not an array');
  else if (Array.isArray(m.hazards)) {
    for (let i = 0; i < m.hazards.length; i++) {
      const h = m.hazards[i];
      if (typeof h.kind !== 'string') problems.push('hazards[' + i + '].kind invalid');
      if (!isNum(h.strength) || h.strength <= 0) problems.push('hazards[' + i + '].strength invalid');
      vec3(h.min, 'hazards[' + i + '].min', problems);
      vec3(h.max, 'hazards[' + i + '].max', problems);
      if (Array.isArray(h.min) && Array.isArray(h.max)) {
        if (!(h.min[0] < h.max[0] && h.min[1] < h.max[1] && h.min[2] < h.max[2])) {
          problems.push('hazards[' + i + '] min/max not ordered');
        }
      }
    }
  }

  // --- lighting ---
  const L = m.lighting;
  if (!L || typeof L !== 'object') problems.push('lighting missing');
  else {
    vec3(L.sunDir, 'lighting.sunDir', problems);
    vec3(L.sunColor, 'lighting.sunColor', problems);
    vec3(L.ambient, 'lighting.ambient', problems);
    vec3(L.fogColor, 'lighting.fogColor', problems);
    if (!isNum(L.fogNear) || !isNum(L.fogFar)) problems.push('lighting fog bounds not finite');
    else if (!(L.fogNear < L.fogFar)) problems.push('lighting.fogNear >= fogFar');
  }

  // --- debug 块 ---
  if (!m.debug || typeof m.debug !== 'object') problems.push('debug block missing');
  else {
    if (!Number.isInteger(m.debug.trianglesApprox) || m.debug.trianglesApprox <= 0) {
      problems.push('debug.trianglesApprox invalid');
    }
    if (m.debug.boxCount !== m.boxes.length) problems.push('debug.boxCount mismatch');
    if (m.debug.archetype !== m.archetype) problems.push('debug.archetype mismatch');
    if (!isNum(m.debug.generatedAt)) problems.push('debug.generatedAt not finite');
  }

  // --- 全树有限性 + 可序列化 ---
  const finiteProblems = [];
  walkFinite(m, 'map', finiteProblems);
  for (const p of finiteProblems) problems.push('non-finite: ' + p);
  try {
    const json = JSON.stringify(m);
    if (typeof json !== 'string') problems.push('JSON.stringify did not return a string');
    const round = JSON.parse(json);
    if (round.version !== m.version) problems.push('JSON round-trip changed version');
  } catch (e) {
    problems.push('not JSON-serializable: ' + e.message);
  }

  if (opts && opts.expectArchetype && m.archetype !== opts.expectArchetype) {
    problems.push('archetype mismatch: ' + m.archetype);
  }
  if (opts && opts.expectBiome && m.biome !== opts.expectBiome) {
    problems.push('biome mismatch: ' + m.biome);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 1. 静态表自检
// ---------------------------------------------------------------------------

group('静态导出表（FLAG / BIOMES / ARCHETYPES / MISSIONS）', () => {
  eq(FLAG.SOLID, 1, 'FLAG.SOLID');
  eq(FLAG.WALLRUN, 2, 'FLAG.WALLRUN');
  eq(FLAG.CLIMBABLE, 4, 'FLAG.CLIMBABLE');
  eq(FLAG.BREAKABLE, 8, 'FLAG.BREAKABLE');
  eq(FLAG.PLATFORM, 16, 'FLAG.PLATFORM');
  eq(FLAG.COVER, 32, 'FLAG.COVER');
  eq(FLAG.HAZARD, 64, 'FLAG.HAZARD');
  eq(FLAG.LADDER, 128, 'FLAG.LADDER');
  eq(FLAG.EXTRACT, 256, 'FLAG.EXTRACT');
  check(Object.isFrozen(FLAG), 'FLAG 必须冻结');
  eq(Object.keys(FLAG).length, 9, 'FLAG 恰好 9 个位');

  check(BIOME_IDS.length >= 5, '至少 5 个生物群系');
  const wantBiomes = ['industrial_forge', 'ship_graveyard', 'deep_core_mine', 'orbital_anchor', 'slag_wastes'];
  for (const id of wantBiomes) check(!!BIOMES[id], '缺少生物群系 ' + id);
  const paletteKeys = ['sky', 'fog', 'sun', 'ambient', 'ground', 'accent', 'metal', 'emissive'];
  for (const id of BIOME_IDS) {
    const bi = BIOMES[id];
    check(typeof bi.name === 'string' && /[\u4e00-\u9fff]/.test(bi.name), id + '.name 需为中文');
    check(typeof bi.desc === 'string' && bi.desc.length > 6, id + '.desc 太短');
    check(typeof bi.ambientTrack === 'string' && bi.ambientTrack.length > 0, id + '.ambientTrack 缺失');
    check(Number.isFinite(bi.gravityScale) && bi.gravityScale > 0.3 && bi.gravityScale < 2, id + '.gravityScale 越界');
    check(bi.hazard === null || (typeof bi.hazard.kind === 'string' && Number.isFinite(bi.hazard.strength)), id + '.hazard 结构非法');
    for (const k of paletteKeys) {
      check(Array.isArray(bi.palette[k]) && bi.palette[k].length === 3, id + '.palette.' + k + ' 必须是 vec3');
    }
    const tr = bi.terrain;
    check(Number.isFinite(tr.amplitude) && tr.amplitude >= 0, id + '.terrain.amplitude 非法');
    check(Number.isInteger(tr.octaves) && tr.octaves >= 1 && tr.octaves <= 8, id + '.terrain.octaves 非法');
    check(Number.isFinite(tr.lacunarity) && tr.lacunarity >= 1, id + '.terrain.lacunarity 非法');
    check(Number.isFinite(tr.gain) && tr.gain > 0 && tr.gain <= 1, id + '.terrain.gain 非法');
    check(Number.isFinite(tr.roughness) && tr.roughness > 0, id + '.terrain.roughness 非法');
  }

  const wantArch = ['foundry_hall', 'ship_break_yard', 'reactor_spine', 'canyon_pipeline', 'storage_blocks', 'anchor_ring'];
  for (const id of wantArch) check(ARCHETYPE_IDS.indexOf(id) >= 0, '缺少原型 ' + id);
  check(ARCHETYPE_IDS.length >= 6, '至少 6 个原型');

  check(MISSIONS.length >= 10, '至少 10 条远征简报');
  const tiers = MISSIONS.map((m) => m.tier);
  for (let i = 0; i < 10; i++) check(tiers.indexOf(i + 1) >= 0, '缺少 tier ' + (i + 1) + ' 的简报');
  const worlds = new Set();
  const titles = new Set();
  for (const m of MISSIONS) {
    check(typeof m.id === 'string' && m.id.length > 0, '简报 id 缺失');
    check(typeof m.title === 'string' && /[\u4e00-\u9fff]/.test(m.title), m.id + '.title 需为中文');
    check(typeof m.brief === 'string' && m.brief.length > 12, m.id + '.brief 太短');
    const sentences = m.brief.split(/[。！？\n]/).filter((s) => s.trim().length > 0).length;
    check(sentences >= 2 && sentences <= 5, m.id + '.brief 需要 2-4 句（实际 ' + sentences + '）');
    check(typeof m.world === 'string' && /[\u4e00-\u9fff]/.test(m.world), m.id + '.world 需为中文命名');
    check(!!BIOMES[m.biome], m.id + '.biome 未知: ' + m.biome);
    check(ARCHETYPE_IDS.indexOf(m.archetype) >= 0, m.id + '.archetype 未知: ' + m.archetype);
    check(Number.isInteger(m.seedBase) && m.seedBase > 0, m.id + '.seedBase 非法');
    const mo = m.modifiers;
    check(mo && typeof mo === 'object', m.id + '.modifiers 缺失');
    for (const k of ['enemyHpMul', 'enemyDamageMul', 'enemyCountMul', 'extractionTime', 'alloyMul', 'playerShieldMul', 'hazardStrengthMul']) {
      check(mo && Number.isFinite(mo[k]), m.id + '.modifiers.' + k + ' 缺失');
    }
    worlds.add(m.world);
    titles.add(m.title);
  }
  check(worlds.size >= 5, '简报需要覆盖至少 5 个不同的铸造世界（实际 ' + worlds.size + '）');
  eq(titles.size, MISSIONS.length, '简报标题必须互不重复');

  eq(getMission(0).id, MISSIONS[0].id, 'getMission(0)');
  eq(getMission(-5).id, MISSIONS[0].id, 'getMission(-5) 需钳制');
  eq(getMission(999).id, MISSIONS[MISSIONS.length - 1].id, 'getMission(999) 需钳制');
  eq(getBiome('deep_core_mine').id, 'deep_core_mine', 'getBiome 正常');
  eq(getBiome('nope').id, 'industrial_forge', 'getBiome 未知 id 需回退');
});

// ---------------------------------------------------------------------------
// 2. makeHeightFn 自检
// ---------------------------------------------------------------------------

group('makeHeightFn（确定性 / 网格一致 / 任意坐标有限）', () => {
  const spec = {
    resolution: 64,
    baseHeight: 0,
    amplitude: 12,
    octaves: 4,
    lacunarity: 2.0,
    gain: 0.5,
    roughness: 1,
    seed: 777,
    plateau: [{ x: 0, z: 0, radius: 40, height: 2, falloff: 18 }],
    trenches: [{ x: 60, z: -30, radius: 16, depth: -10, falloff: 10 }],
  };
  const h1 = makeHeightFn(spec);
  const h2 = makeHeightFn(JSON.parse(JSON.stringify(spec)));

  // 同 spec 同结果
  let same = true;
  let finite = true;
  const N = spec.resolution;
  const half = 160;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = -half + (i / (N - 1)) * half * 2;
      const z = -half + (j / (N - 1)) * half * 2;
      const a = h1(x, z);
      const b = h1(x, z);
      const c = h2(x, z);
      if (a !== b) same = false;
      if (c !== a) same = false;
      if (!Number.isFinite(a)) finite = false;
    }
  }
  check(same, 'makeHeightFn 在网格点上必须完全可复现（含重建 spec）');
  check(finite, 'makeHeightFn 在所有网格点上必须有限');

  // 大量随机采样（含远超地图范围的坐标）
  let rngState = 123456789;
  const rnd = () => {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return rngState / 4294967296;
  };
  let farFinite = true;
  let farBounded = true;
  for (let i = 0; i < 20000; i++) {
    const x = (rnd() - 0.5) * 4000;
    const z = (rnd() - 0.5) * 4000;
    const v = h1(x, z);
    if (!Number.isFinite(v)) farFinite = false;
    if (v < -34.0001 || v > 400) farBounded = false;
  }
  check(farFinite, 'makeHeightFn 在远场坐标上必须返回有限值');
  check(farBounded, 'makeHeightFn 必须被世界地板钳制在 >= -34');

  // 越界坐标也必须与自身一致
  check(h1(-9999, 9999) === h1(-9999, 9999), '远场坐标必须可复现');

  // plateau / trenches 生效方向正确
  const base = makeHeightFn({ ...spec, plateau: [], trenches: [] });
  const withPlateau = makeHeightFn({ ...spec, plateau: [{ x: 0, z: 0, radius: 30, height: 5, falloff: 5 }], trenches: [] });
  check(withPlateau(0, 0) > base(0, 0) + 3, 'plateau.height 必须抬高地形');
  const withTrench = makeHeightFn({ ...spec, plateau: [], trenches: [{ x: 0, z: 0, radius: 30, depth: -9, falloff: 5 }] });
  check(withTrench(0, 0) < base(0, 0) - 6, 'trenches.depth 必须下切地形');

  // 退化输入不得产生 NaN
  const degenerate = makeHeightFn({ amplitude: 0, octaves: 0, lacunarity: 0, gain: 0 });
  check(Number.isFinite(degenerate(1, 2)), '退化 spec 必须返回有限值');
  const empty = makeHeightFn({});
  check(Number.isFinite(empty(0, 0)), '空 spec 必须返回有限值');
  const negOct = makeHeightFn({ amplitude: 5, octaves: -3, lacunarity: 1, gain: 1, plateau: [{ x: 1, z: 1, radius: 0, falloff: 0 }] });
  check(Number.isFinite(negOct(1, 1)), '负数 octaves / 零半径必须安全');
});

// ---------------------------------------------------------------------------
// 3. 全量生成 + schema 校验 + 连通性 + 逐图摘要
// ---------------------------------------------------------------------------

const generated = [];

group('全量生成：每原型 × 每生物群系（schema + 连通性 + 摘要）', () => {
  console.log('  --- 逐图摘要: name | archetype | biome | boxes | objectives | spawns | extract ---');
  let combos = 0;
  for (const biomeId of BIOME_IDS) {
    for (const archetype of ARCHETYPE_IDS) {
      const m = generateMap({ seed: 42, biome: biomeId, size: 240, tier: 3, archetype });
      combos++;
      const problems = validateMap(m, { expectArchetype: archetype, expectBiome: biomeId });
      check(problems.length === 0, `[${biomeId}/${archetype}] schema 问题: ` + problems.slice(0, 4).join(' ; '));

      const rc = checkReachability(m);
      check(rc.ok, `[${biomeId}/${archetype}] 连通性失败: ` + rc.reason.slice(0, 160));
      check(rc.reachableCells > 0, `[${biomeId}/${archetype}] 可达单元为 0`);

      generated.push(m);
      console.log(
        '  ' + m.name + ' | ' + m.archetype + ' | ' + m.biome + ' | ' + m.boxes.length +
        ' | ' + m.objectives.length + ' | ' + m.spawnPoints.length + ' | ' + m.extractPoints.length
      );
    }
  }
  check(combos >= 30, '组合数必须 >= 30（实际 ' + combos + '）');
});

group('多参数抽样：seed / tier / size 变化下依然合法', () => {
  const cases = [
    { seed: 1, tier: 1, size: 140, biome: 'industrial_forge', archetype: 'foundry_hall' },
    { seed: 7, tier: 2, size: 180, biome: 'ship_graveyard', archetype: 'ship_break_yard' },
    { seed: 99, tier: 4, size: 200, biome: 'deep_core_mine', archetype: 'storage_blocks' },
    { seed: 1234, tier: 5, size: 260, biome: 'slag_wastes', archetype: 'canyon_pipeline' },
    { seed: 65535, tier: 7, size: 300, biome: 'orbital_anchor', archetype: 'anchor_ring' },
    { seed: 424242, tier: 9, size: 340, biome: 'industrial_forge', archetype: 'reactor_spine' },
    { seed: 0, tier: 10, size: 400, biome: 'ship_graveyard', archetype: 'storage_blocks' },
  ];
  for (const c of cases) {
    const m = generateMap(c);
    const problems = validateMap(m);
    check(problems.length === 0, `[seed=${c.seed} tier=${c.tier} size=${c.size}] ` + problems.slice(0, 4).join(' ; '));
    const rc = checkReachability(m);
    check(rc.ok, `[seed=${c.seed} tier=${c.tier} size=${c.size}] 连通性失败: ` + rc.reason.slice(0, 140));
    console.log(
      '  ' + m.name + ' | ' + m.archetype + ' | ' + m.biome + ' | ' + m.boxes.length +
      ' | ' + m.objectives.length + ' | ' + m.spawnPoints.length + ' | ' + m.extractPoints.length
    );
  }
});

// ---------------------------------------------------------------------------
// 4. 确定性
// ---------------------------------------------------------------------------

group('确定性：同 seed 生成字节级一致', () => {
  const opts = { seed: 42, biome: 'industrial_forge', size: 240, tier: 3, archetype: 'foundry_hall' };
  const a = generateMap(opts);
  const b = generateMap(opts);
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  check(ja === jb, 'generateMap 同 seed 两次结果必须字节一致');
  check(ja.length > 1000, '地图 JSON 不应为空壳');

  const c = generateMap({ ...opts, archetype: 'ship_break_yard' });
  check(JSON.stringify(c) !== ja, '不同原型必须产生不同地图');

  const d = generateMap({ ...opts, seed: 43 });
  check(JSON.stringify(d) !== ja, '不同 seed 必须产生不同地图');

  // 逐字段深比较（定位可能的非确定性来源）
  const diff = deepDiff(a, b, 'map');
  check(diff === null, '深比较发现差异: ' + diff);

  // 多次生成同一张，检查全局状态泄漏（例如闭包计数、模块级可变状态）
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(JSON.stringify(generateMap(opts)));
  check(runs[0] === runs[1] && runs[1] === runs[2], '连续生成三次必须完全一致（无状态泄漏）');

  // 交错生成不应互相影响
  const interleaved = JSON.stringify(generateMap(opts));
  generateMap({ seed: 999, biome: 'slag_wastes', size: 300, tier: 8, archetype: 'anchor_ring' });
  check(JSON.stringify(generateMap(opts)) === interleaved, '交错生成不得影响结果');
});

function deepDiff(a, b, path) {
  if (a === b) return null;
  if (typeof a !== typeof b) return path + ' type ' + typeof a + ' vs ' + typeof b;
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return path + ' array vs non-array';
    if (a.length !== b.length) return path + ' length ' + a.length + ' vs ' + b.length;
    for (let i = 0; i < a.length; i++) {
      const d = deepDiff(a[i], b[i], path + '[' + i + ']');
      if (d) return d;
    }
    return null;
  }
  if (a && typeof a === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return path + ' key count ' + ka.length + ' vs ' + kb.length;
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return path + ' key order ' + ka[i] + ' vs ' + kb[i];
      const d = deepDiff(a[ka[i]], b[kb[i]], path + '.' + ka[i]);
      if (d) return d;
    }
    return null;
  }
  return path + ' value ' + a + ' vs ' + b;
}

// ---------------------------------------------------------------------------
// 5. 连通性回归（覆盖所有已生成地图）
// ---------------------------------------------------------------------------

group('连通性：所有已生成地图均可从出生点走到目标/撤离/补给', () => {
  let checked = 0;
  for (const m of generated) {
    const rc = checkReachability(m);
    checked++;
    check(rc.ok, m.name + ' 连通性失败: ' + rc.reason.slice(0, 160));
  }
  check(checked >= 30, '至少检查 30 张地图（实际 ' + checked + '）');
});

// ---------------------------------------------------------------------------
// 6. GLTF：内存中合成 GLB / .gltf
// ---------------------------------------------------------------------------

const GLB_MAGIC = 0x46546c67;

/** 写入一段小端数据。 */
function concatBytes(list) {
  let total = 0;
  for (const x of list) total += x.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const x of list) {
    out.set(x, off);
    off += x.length;
  }
  return out;
}

function padTo4(bytes, padChar) {
  const rem = bytes.length % 4;
  if (rem === 0) return bytes;
  const pad = new Uint8Array(4 - rem);
  pad.fill(padChar);
  return concatBytes([bytes, pad]);
}

/**
 * 现场拼一个 GLB：
 * 节点层级 scene -> root(平移) -> spin(绕 Y 旋转 90°) -> mesh
 * 网格是 2 个三角形（一个竖直的四边形），POSITION + indices，没有 NORMAL。
 */
function buildSyntheticGLB() {
  // 顶点：竖直四边形（y 从 0 到 2，x 从 0 到 2）
  const positions = new Float32Array([
    0, 0, 0,
    2, 0, 0,
    2, 2, 0,
    0, 2, 0,
  ]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const posBytes = new Uint8Array(positions.buffer);
  const idxBytes = new Uint8Array(indices.buffer);
  const idxPadded = padTo4(idxBytes, 0);
  const bin = concatBytes([posBytes, idxPadded]);

  const json = {
    asset: { version: '2.0', generator: 'ironfall-selftest' },
    scene: 0,
    scenes: [{ name: 'scene0', nodes: [0] }],
    nodes: [
      { name: 'root', translation: [10, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], children: [1] },
      { name: 'spin', rotation: [0, 0.7071067811865475, 0, 0.7071067811865476], children: [2] },
      { name: 'meshNode', mesh: 0 },
    ],
    meshes: [{
      name: 'quad',
      primitives: [{
        attributes: { POSITION: 0 },
        indices: 1,
        material: 0,
        mode: 4,
      }],
    }],
    materials: [{
      name: 'hotSteel',
      pbrMetallicRoughness: { baseColorFactor: [0.4, 0.5, 0.6, 1] },
      emissiveFactor: [0.9, 0.2, 0.05],
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [2, 2, 0] },
      { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes.length, target: 34962 },
      { buffer: 0, byteOffset: posBytes.length, byteLength: idxBytes.length, target: 34963 },
    ],
    buffers: [{ byteLength: bin.length }],
  };

  const jsonBytes = padTo4(new TextEncoder().encode(JSON.stringify(json)), 0x20);
  const totalLen = 12 + 8 + jsonBytes.length + 8 + bin.length;
  const header = new Uint8Array(12);
  new DataView(header.buffer).setUint32(0, GLB_MAGIC, true);
  new DataView(header.buffer).setUint32(4, 2, true);
  new DataView(header.buffer).setUint32(8, totalLen, true);
  const jsonHeader = new Uint8Array(8);
  new DataView(jsonHeader.buffer).setUint32(0, jsonBytes.length, true);
  new DataView(jsonHeader.buffer).setUint32(4, 0x4e4f534a, true); // 'JSON'
  const binHeader = new Uint8Array(8);
  new DataView(binHeader.buffer).setUint32(0, bin.length, true);
  new DataView(binHeader.buffer).setUint32(4, 0x004e4942, true); // 'BIN\0'

  return concatBytes([header, jsonHeader, jsonBytes, binHeader, bin]);
}

/** 合成一个 .gltf：buffer 走 data URI，只有 POSITION，没有索引（应自动合成 0..n-1）。 */
function buildSyntheticGLTF() {
  // 两个独立三角形（非索引），共 6 个顶点，位于 XY 平面，逆时针 -> 法线 +Z
  const positions = new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    0, 0, 1, 1, 0, 1, 0, 1, 1,
  ]);
  const bytes = new Uint8Array(positions.buffer);
  const b64 = Buffer.from(bytes).toString('base64');
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'solo', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.25, 0.5, 0.75, 1] } }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 6, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bytes.length }],
    buffers: [{ uri: 'data:application/octet-stream;base64,' + b64, byteLength: bytes.length }],
  };
  return new TextEncoder().encode(JSON.stringify(json));
}

group('GLTF：合成 GLB 解析（顶点/索引/材质/世界矩阵）', () => {
  const glb = buildSyntheticGLB();
  const doc = parseGLTF(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), '');
  eq(doc.meshes.length, 1, 'meshes.length');
  eq(doc.nodes.length, 3, 'nodes.length');
  eq(doc.materials.length, 1, 'materials.length');
  eq(doc.scenes.length, 1, 'scenes.length');
  eq(doc.roots.length, 1, 'roots.length');
  eq(doc.roots[0], 0, 'root 节点索引');

  const prim = doc.meshes[0].prims[0];
  // 契约要求：缺 NORMAL 时按索引展开并合成平面法线，因此 4 顶点 2 三角形变成 6 个独立顶点
  eq(prim.triangleCount, 2, 'triangleCount');
  eq(prim.vertexCount, 6, 'vertexCount（flat normal 展开后 = 三角形数 × 3）');
  eq(prim.positions.length, 18, 'POSITION 分量数 (6 verts * 3)');
  check(prim.indices instanceof Uint32Array, 'indices 必须是 Uint32Array');
  eq(prim.indices.length, 6, 'indices 长度');
  eq(Array.from(prim.indices).join(','), '0,1,2,3,4,5', 'indices 内容（展开后连续）');
  check(prim.positions instanceof Float32Array, 'positions 必须是 Float32Array');
  check(prim.normals instanceof Float32Array, 'NORMAL 缺失时必须合成平面法线');
  eq(prim.computedNormals, true, 'computedNormals 标记');
  // 展开后第 0/1/2 顶点即原三角形 (0,0,0)(2,0,0)(2,2,0)，逆时针 -> 法线 +Z
  eq(Array.from(prim.positions.slice(0, 9)).join(','), '0,0,0,2,0,0,2,2,0', '展开后的第一个三角形顶点顺序');
  for (let i = 0; i < 6; i++) {
    const nz = prim.normals[i * 3 + 2];
    check(Math.abs(nz - 1) < 1e-5, '第 ' + i + ' 个顶点法线应为 +Z（实际 ' + nz + '）');
    check(Math.abs(prim.normals[i * 3]) < 1e-6, '法线 x 分量应为 0');
    check(Math.abs(prim.normals[i * 3 + 1]) < 1e-6, '法线 y 分量应为 0');
  }
  check(prim.uvs === null, '没有 TEXCOORD_0 时 uvs 必须为 null');
  check(prim.colors !== null, '材质 baseColorFactor / emissiveFactor 应被用作顶点色');
  // 颜色 = max(baseColorFactor, emissiveFactor)，自发光体在暗场里要看得见
  check(Math.abs(prim.colors[0] - 0.9) < 1e-6, '顶点色 r = max(0.4, 0.9)');
  check(Math.abs(prim.colors[1] - 0.5) < 1e-6, '顶点色 g = max(0.5, 0.2)');
  check(Math.abs(prim.colors[2] - 0.6) < 1e-6, '顶点色 b = max(0.6, 0.05)');
  eq(prim.colors.length, 18, '顶点色数组长度与顶点数一致');
  check(prim.material && prim.material.name === 'hotSteel', '材质应挂到 primitive 上');
  check(Math.abs(prim.material.emissiveFactor[0] - 0.9) < 1e-6, 'emissiveFactor 读取正确');

  const stats = describeGLTF(doc);
  eq(stats.meshes, 1, 'describeGLTF.meshes');
  eq(stats.triangles, 2, 'describeGLTF.triangles');
  eq(stats.nodes, 3, 'describeGLTF.nodes');
  eq(stats.vertices, 6, 'describeGLTF.vertices');
  eq(stats.materials, 1, 'describeGLTF.materials');
  eq(stats.textured, false, '无贴图时 textured 必须为 false');

  // --- 世界矩阵 ---
  const inst = gltfInstanceModels(doc);
  eq(inst.length, 1, '实例数量');
  eq(inst[0].meshIndex, 0, '实例网格索引');
  eq(inst[0].nodeIndex, 2, '实例节点索引');
  const M = inst[0].matrix;
  check(M instanceof Float32Array && M.length === 16, '世界矩阵必须是 Float32Array(16)');
  // 绕 Y 轴 +90° 把 (1,0,0) 映射到 (0,0,-1)，再平移 (10,0,0)
  const px = M[12], py = M[13], pz = M[14];
  check(Math.abs(px - 10) < 1e-5 && Math.abs(py) < 1e-5 && Math.abs(pz) < 1e-5,
    '世界矩阵平移应为 (10,0,0)，实际 (' + px + ',' + py + ',' + pz + ')');
  const ax = [M[0], M[1], M[2]];
  const bx2 = [M[4], M[5], M[6]];
  const cx2 = [M[8], M[9], M[10]];
  check(Math.abs(ax[0]) < 1e-5 && Math.abs(ax[1]) < 1e-5 && Math.abs(ax[2] + 1) < 1e-5,
    '局部 +X 应被旋转到 -Z，实际 (' + ax.join(',') + ')');
  check(Math.abs(bx2[1] - 1) < 1e-5, '局部 +Y 应保持 +Y');
  check(Math.abs(cx2[0] - 1) < 1e-5, '局部 +Z 应被旋转到 +X');
  // 变换一个点验算：局部 (2,2,0) -> 世界 (10,2,-2)
  const wx = M[0] * 2 + M[4] * 2 + M[12];
  const wy = M[1] * 2 + M[5] * 2 + M[13];
  const wz = M[2] * 2 + M[6] * 2 + M[14];
  check(Math.abs(wx - 10) < 1e-5 && Math.abs(wy - 2) < 1e-5 && Math.abs(wz + 2) < 1e-5,
    '点变换结果应为 (10,2,-2)，实际 (' + wx + ',' + wy + ',' + wz + ')');
});

group('GLTF：合成 .gltf（data URI / 无索引 / 自动 flat normal）', () => {
  const bytes = buildSyntheticGLTF();
  const doc = parseGLTF(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  eq(doc.meshes.length, 1, 'meshes.length');
  const prim = doc.meshes[0].prims[0];
  eq(prim.vertexCount, 6, 'vertexCount（非索引 6 顶点不变）');
  eq(prim.triangleCount, 2, 'triangleCount');
  eq(Array.from(prim.indices).join(','), '0,1,2,3,4,5', '无索引时自动合成 0..n-1');
  check(prim.normals !== null, '必须合成法线');
  eq(prim.computedNormals, true, 'computedNormals 必须为 true');
  // 两个三角形都在 XY 平面、逆时针 -> 法线 +Z
  for (let i = 0; i < 6; i++) {
    check(Math.abs(prim.normals[i * 3 + 2] - 1) < 1e-5, '第 ' + i + ' 个合成法线应为 +Z');
  }
  check(Math.abs(prim.colors[0] - 0.25) < 1e-6, 'baseColorFactor 作为顶点色 r');
  const stats = describeGLTF(doc);
  eq(stats.triangles, 2, 'describeGLTF.triangles');
  eq(stats.textured, false, 'textured = false');
  const inst = gltfInstanceModels(doc);
  eq(inst.length, 1, '实例数量');
  check(Math.abs(inst[0].matrix[0] - 1) < 1e-6 && Math.abs(inst[0].matrix[12]) < 1e-6, '无变换节点应为单位阵');
});

group('GLTF：贴图存在时 describeGLTF.textured === true', () => {
  const bytes = buildSyntheticGLTF();
  const json = JSON.parse(new TextDecoder().decode(bytes));
  json.images = [{ uri: 'data:image/png;base64,iVBORw0KGgo=' }];
  json.textures = [{ source: 0 }];
  json.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, baseColorFactor: [1, 1, 1, 1] } }];
  json.meshes[0].primitives[0].material = 0;
  const buf = new TextEncoder().encode(JSON.stringify(json));
  const doc = parseGLTF(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  const stats = describeGLTF(doc);
  eq(stats.textured, true, '带贴图时 textured 必须为 true');
  eq(stats.materials, 1, 'materials 数量');
  eq(doc.textures, 1, 'doc.textures 数量');
  eq(doc.images, 1, 'doc.images 数量');
  const prim = doc.meshes[0].prims[0];
  check(Math.abs(prim.colors[0] - 1) < 1e-6, '贴图存在时仍回退到 baseColorFactor(白)');
});

group('GLTF：错误码必须可 grep（MAGIC / VERSION / ACCESSOR / BUFFER / CHUNK）', () => {
  const good = buildSyntheticGLB();

  const expectCode = (label, buffer, code) => {
    let thrown = null;
    try {
      parseGLTF(buffer, '');
    } catch (e) {
      thrown = e;
    }
    if (!thrown) {
      check(false, label + ' 应当抛出 ' + code + '，但没有抛错');
      return;
    }
    check(typeof thrown.message === 'string' && thrown.message.indexOf(code) === 0,
      label + ' 错误信息必须以 ' + code + ' 开头，实际: ' + thrown.message);
  };

  // 1) 魔数损坏
  const badMagic = good.slice();
  badMagic[0] = 0x00;
  badMagic[1] = 0x00;
  expectCode('魔数损坏', badMagic.buffer.slice(badMagic.byteOffset, badMagic.byteOffset + badMagic.byteLength), 'GLTF_ERR_MAGIC');
  expectCode('随机文本', new TextEncoder().encode('this is definitely not a model').buffer, 'GLTF_ERR_MAGIC');

  // 2) 版本号损坏
  const badVersion = good.slice();
  new DataView(badVersion.buffer, badVersion.byteOffset).setUint32(4, 1, true);
  expectCode('容器版本=1', badVersion.buffer.slice(badVersion.byteOffset, badVersion.byteOffset + badVersion.byteLength), 'GLTF_ERR_VERSION');

  // 3) chunk 长度越界
  const badChunk = good.slice();
  new DataView(badChunk.buffer, badChunk.byteOffset).setUint32(12, 0x7fffffff, true);
  expectCode('JSON chunk 长度越界', badChunk.buffer.slice(badChunk.byteOffset, badChunk.byteOffset + badChunk.byteLength), 'GLTF_ERR_CHUNK');

  // 4) accessor 越界（把索引 accessor 的 count 改成远超顶点数）
  const glbJsonOffset = 12 + 8;
  const srcJsonLen = new DataView(good.buffer, good.byteOffset).getUint32(12, true);
  const srcJson = JSON.parse(new TextDecoder().decode(good.subarray(glbJsonOffset, glbJsonOffset + srcJsonLen)));
  srcJson.accessors[0].count = 9999;
  const brokenJsonBytes = padTo4(new TextEncoder().encode(JSON.stringify(srcJson)), 0x20);
  const binStart = glbJsonOffset + srcJsonLen;
  const binLen = new DataView(good.buffer, good.byteOffset).getUint32(binStart, true);
  const binChunk = good.subarray(binStart + 8, binStart + 8 + binLen);
  const newTotal = 12 + 8 + brokenJsonBytes.length + 8 + binLen;
  const hdr = new Uint8Array(12);
  new DataView(hdr.buffer).setUint32(0, GLB_MAGIC, true);
  new DataView(hdr.buffer).setUint32(4, 2, true);
  new DataView(hdr.buffer).setUint32(8, newTotal, true);
  const jh = new Uint8Array(8);
  new DataView(jh.buffer).setUint32(0, brokenJsonBytes.length, true);
  new DataView(jh.buffer).setUint32(4, 0x4e4f534a, true);
  const bh = new Uint8Array(8);
  new DataView(bh.buffer).setUint32(0, binLen, true);
  new DataView(bh.buffer).setUint32(4, 0x004e4942, true);
  const badAccessor = concatBytes([hdr, jh, brokenJsonBytes, bh, binChunk]);
  expectCode('accessor.count 越界', badAccessor.buffer.slice(badAccessor.byteOffset, badAccessor.byteOffset + badAccessor.byteLength), 'GLTF_ERR_ACCESSOR');

  // 5) buffer 无法解析（外部 uri 且没有 baseUrl 可读）
  const bufferJson = JSON.parse(new TextDecoder().decode(good.subarray(glbJsonOffset, glbJsonOffset + srcJsonLen)));
  bufferJson.buffers = [{ uri: 'nowhere/vertex.bin', byteLength: binLen }];
  const bufBytes = new TextEncoder().encode(JSON.stringify(bufferJson));
  let bufferErr = null;
  try {
    parseGLTF(bufBytes.buffer.slice(bufBytes.byteOffset, bufBytes.byteOffset + bufBytes.byteLength), '');
  } catch (e) {
    bufferErr = e;
  }
  check(bufferErr !== null && bufferErr.message.indexOf('GLTF_ERR_BUFFER') === 0,
    '外部 buffer 不可读时必须抛 GLTF_ERR_BUFFER，实际: ' + (bufferErr ? bufferErr.message : '(未抛错)'));

  // 6) 未支持特性（非三角形拓扑）
  const modeJson = JSON.parse(new TextDecoder().decode(good.subarray(glbJsonOffset, glbJsonOffset + srcJsonLen)));
  modeJson.meshes[0].primitives[0].mode = 1; // LINES
  const modeBytes = new TextEncoder().encode(JSON.stringify(modeJson));
  let modeErr = null;
  try {
    parseGLTF(modeBytes.buffer.slice(modeBytes.byteOffset, modeBytes.byteOffset + modeBytes.byteLength), '');
  } catch (e) {
    modeErr = e;
  }
  check(modeErr !== null && modeErr.message.indexOf('GLTF_ERR_UNSUPPORTED') === 0,
    '非 TRIANGLES 拓扑必须抛 GLTF_ERR_UNSUPPORTED，实际: ' + (modeErr ? modeErr.message : '(未抛错)'));

  // 7) 合法输入不得抛错
  let ok = true;
  try {
    parseGLTF(good.buffer.slice(good.byteOffset, good.byteOffset + good.byteLength), '');
  } catch (e) {
    ok = false;
  }
  check(ok, '合法 GLB 不得抛错');
});

group('GLTF：interleaved（byteStride）与稀疏 accessor 容错', () => {
  // 交错布局：每个顶点 [pos.xyz, pad, uv.xy, pad]
  const stride = 32;
  const vcount = 3;
  const buf = new ArrayBuffer(stride * vcount);
  const f32 = new Float32Array(buf);
  const verts = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0],
  ];
  for (let i = 0; i < vcount; i++) {
    f32[i * 8 + 0] = verts[i][0];
    f32[i * 8 + 1] = verts[i][1];
    f32[i * 8 + 2] = verts[i][2];
    f32[i * 8 + 4] = i * 0.5;
    f32[i * 8 + 5] = 1 - i * 0.5;
  }
  const idxBytes = new Uint8Array(new Uint16Array([0, 1, 2]).buffer);
  const total = buf.byteLength + idxBytes.length + ((4 - (idxBytes.length % 4)) % 4);
  const bin = new Uint8Array(total);
  bin.set(new Uint8Array(buf), 0);
  bin.set(idxBytes, buf.byteLength);
  const json = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }],
    scene: 0,
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2 }] }],
    accessors: [
      { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 0, byteOffset: 16, componentType: 5126, count: 3, type: 'VEC2' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR', sparse: { count: 1, indices: { bufferView: 0, byteOffset: 0, componentType: 5123 }, values: { bufferView: 0, byteOffset: 0 } } },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: stride * vcount, byteStride: stride },
      { buffer: 0, byteOffset: stride * vcount, byteLength: idxBytes.length },
    ],
    buffers: [{ byteLength: total }],
  };
  const jsonBytes = padTo4(new TextEncoder().encode(JSON.stringify(json)), 0x20);
  const totalLen = 12 + 8 + jsonBytes.length + 8 + bin.length;
  const hdr = new Uint8Array(12);
  new DataView(hdr.buffer).setUint32(0, GLB_MAGIC, true);
  new DataView(hdr.buffer).setUint32(4, 2, true);
  new DataView(hdr.buffer).setUint32(8, totalLen, true);
  const jh = new Uint8Array(8);
  new DataView(jh.buffer).setUint32(0, jsonBytes.length, true);
  new DataView(jh.buffer).setUint32(4, 0x4e4f534a, true);
  const bh = new Uint8Array(8);
  new DataView(bh.buffer).setUint32(0, bin.length, true);
  new DataView(bh.buffer).setUint32(4, 0x004e4942, true);
  const glb = concatBytes([hdr, jh, jsonBytes, bh, bin]);

  const doc = parseGLTF(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), '');
  const prim = doc.meshes[0].prims[0];
  eq(prim.vertexCount, 3, 'interleaved vertexCount');
  check(Math.abs(prim.positions[3] - 1) < 1e-6, 'interleaved POSITION[1].x 应为 1');
  check(Math.abs(prim.positions[7] - 1) < 1e-6, 'interleaved POSITION[2].y 应为 1');
  check(prim.uvs !== null && Math.abs(prim.uvs[2] - 0.5) < 1e-6, 'interleaved TEXCOORD_0 读取正确');
  check(doc.warnings.length >= 1, '稀疏 accessor 必须记录一条警告');
  check(doc.warnings[0].indexOf('GLTF_ERR_ACCESSOR') === 0, '警告信息必须带错误码前缀');
  eq(prim.triangleCount, 1, 'interleaved triangleCount');
});

// ---------------------------------------------------------------------------
// 7. 地图库与 GLTF 交叉校验（地图 JSON 必须能被 world.js 直接消费）
// ---------------------------------------------------------------------------

group('交叉校验：地图 JSON 结构可直接喂给 world.load', () => {
  const m = generated[0];
  const json = JSON.stringify(m);
  const round = JSON.parse(json);
  const problems = validateMap(round);
  check(problems.length === 0, 'JSON 往返后 schema 仍须通过: ' + problems.slice(0, 3).join(' ; '));
  const rc = checkReachability(round);
  check(rc.ok, 'JSON 往返后连通性仍须通过: ' + rc.reason.slice(0, 120));
  // flags 位必须都在 FLAG 的并集内
  const allMask = Object.keys(FLAG).reduce((acc, k) => acc | FLAG[k], 0);
  let extra = 0;
  for (const b of round.boxes) if ((b.flags & ~allMask) !== 0) extra++;
  eq(extra, 0, '不得出现未定义的 flags 位');
  // 每张地图都必须给 world 提供高台/栈桥（垂直性要求）
  let withVertical = 0;
  for (const g of generated) {
    let high = false;
    for (const b of g.boxes) if (b.max[1] >= 6) { high = true; break; }
    if (high) withVertical++;
  }
  eq(withVertical, generated.length, '每张地图都必须有 6m 以上的可站立高度（垂直性）');
});

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

console.log('');
for (const g of groupResults) console.log((g.ok ? 'PASS' : 'FAIL') + '  ' + g.name);
if (failures.length > 0) {
  console.log('');
  console.log('失败明细:');
  for (const f of failures.slice(0, 40)) console.log('  - ' + f);
  if (failures.length > 40) console.log('  ... 以及另外 ' + (failures.length - 40) + ' 条');
}
console.log('');
console.log('MAPS/GLTF SELF-TEST: ' + passed + '/' + (passed + failed) + ' passed');
process.exit(failed === 0 ? 0 : 1);
