// ==== tools/test-lan-map.mjs — 局域网同图校验（地图生成的确定性与可序列化）====
//
// 联机的前提是：房主和房客用同一组 {seed, biome, archetype, size, tier} 必须
// 生成**逐字节一致**的地图。这个测试把该前提变成可执行断言，避免以后有人在
// 生成路径里塞进 Math.random 或 Date.now 而让联机悄悄错位。
//
// 用法: node tools/test-lan-map.mjs

import { generateMap, MISSIONS, getMission } from '../src/maps/builtin-maps.js';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) { pass++; process.stdout.write(`  PASS  ${name}\n`); }
  else {
    fail++;
    failures.push(`${name}${detail ? '  [' + detail + ']' : ''}`);
    process.stdout.write(`  FAIL  ${name}${detail ? '  [' + detail + ']' : ''}\n`);
  }
}

function section(t) { process.stdout.write(`\n── ${t} ──\n`); }

/** 结构感知的深比较，返回第一处差异的路径（'' 表示相同） */
function firstDiff(a, b, path = '') {
  if (a === b) return '';
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return '';
    return `${path}: ${a} !== ${b}`;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return `${path}: ${String(a)} !== ${String(b)}`;
  }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return `${path}: 类型不同`;
    if (a.length !== b.length) return `${path}: 长度 ${a.length} !== ${b.length}`;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return `${path}[${i}]: ${a[i]} !== ${b[i]}`;
    return '';
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${path}: 数组类型不同`;
    if (a.length !== b.length) return `${path}: 长度 ${a.length} !== ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return '';
  }
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) {
    return `${path}: 键不同 ${ka.join(',')} vs ${kb.join(',')}`;
  }
  for (const k of ka) {
    const d = firstDiff(a[k], b[k], path ? `${path}.${k}` : k);
    if (d) return d;
  }
  return '';
}

/** 统计对象里出现的非有限数值（Infinity/NaN 无法 JSON 往返） */
function findNonFinite(value, path = '') {
  if (typeof value === 'number') return Number.isFinite(value) ? '' : `${path}=${value}`;
  if (!value || typeof value !== 'object') return '';
  if (ArrayBuffer.isView(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!Number.isFinite(value[i])) return `${path}[${i}]=${value[i]}`;
    }
    return '';
  }
  for (const k of Object.keys(value)) {
    const d = findNonFinite(value[k], path ? `${path}.${k}` : k);
    if (d) return d;
  }
  return '';
}

const OPTS_LIST = [
  { seed: 1000, biome: 'industrial_forge', archetype: 'foundry_hall', size: 320, tier: 1 },
  { seed: 1009, biome: 'industrial_forge', archetype: 'ship_break_yard', size: 320, tier: 2 },
  { seed: 2024, biome: 'ice_drift', archetype: 'reactor_spine', size: 320, tier: 5 },
  { seed: 7331, biome: 'toxic_swamp', archetype: 'storage_blocks', size: 320, tier: 8 },
  { seed: 99991, biome: 'orbital_station', archetype: 'anchor_ring', size: 320, tier: 10 },
];

section('1. 相同 seed 生成完全一致的地图');

for (const opts of OPTS_LIST) {
  const a = generateMap(opts);
  const b = generateMap(opts);
  const diff = firstDiff(a, b);
  check(`seed=${opts.seed} 两次生成逐字段一致`, diff === '', diff);
}

section('2. 不同 seed 生成不同地图（防止 seed 被忽略）');

{
  const a = generateMap(OPTS_LIST[0]);
  const b = generateMap({ ...OPTS_LIST[0], seed: OPTS_LIST[0].seed + 1 });
  const diff = firstDiff(a, b);
  check('改 seed 后地图确实不同', diff !== '', '两个 seed 生成了同一张图，seed 可能没生效');
}

section('3. 地图可 JSON 往返（网络传输前提）');

for (const opts of OPTS_LIST) {
  const a = generateMap(opts);
  const bad = findNonFinite(a);
  check(`seed=${opts.seed} 不含 Infinity/NaN`, bad === '', bad);
  let round = null;
  let err = '';
  try { round = JSON.parse(JSON.stringify(a)); } catch (e) { err = e.message; }
  check(`seed=${opts.seed} JSON 往返成功`, !!round && !err, err);
  if (round) {
    const diff = firstDiff(a, round);
    // 数组经 JSON 往返仍是数组；若生成结果里混入 Float32Array 则会在此暴露
    check(`seed=${opts.seed} JSON 往返后逐字段一致`, diff === '', diff);
  }
}

section('4. 战役任务参数可复现（联机同步用的就是这些字段）');

{
  const problems = [];
  for (let i = 0; i < MISSIONS.length; i++) {
    const m = getMission(i);
    if (!m) { problems.push(`任务 ${i} 缺失`); continue; }
    const seed = (m.seedBase || 1000) + 0;
    const opts = { seed, biome: m.biome, archetype: m.archetype, size: 320, tier: m.tier || 1 };
    const a = generateMap(opts);
    const b = generateMap(opts);
    const diff = firstDiff(a, b);
    if (diff) problems.push(`第 ${i + 1} 关: ${diff}`);
  }
  check('全部战役关卡都能由 {seed,biome,archetype,size,tier} 复现', problems.length === 0,
    problems.slice(0, 3).join(' | '));
}

process.stdout.write(`\n${'─'.repeat(52)}\n`);
if (fail === 0) {
  process.stdout.write(`局域网同图校验通过：${pass}/${pass}\n`);
  process.exit(0);
} else {
  process.stdout.write(`局域网同图校验失败：${pass} 通过 / ${fail} 失败\n`);
  for (const f of failures) process.stdout.write(`  · ${f}\n`);
  process.exit(1);
}
