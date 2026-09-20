// ==== tools/test-spider-queen-hop.mjs — 需求 5：蛛皇高频跳跃 + 喜欢跳墙 ====
//
// 需求原文：「绿影蛛皇跳跃频率大大提升，每几步就要跳，并且喜欢跳墙。」
//
// ⚠ 调参记录（避免以后又调坏）：
//   跳跃频率的真正瓶颈是**滞空时间**而不是冷却：滞空 = 2 * hopSpeed / gravity(22)。
//   初版 hopSpeed 给 9.5 → 滞空 0.86s，它几乎一直挂在空中，落地才可能再跳，
//   实测 10 秒只跳了 5 次。现在 hopSpeed=4.0 → 滞空 ≈0.36s，落地即再跳。
//   另外蛛皇有相当一部分时间在 windup/retreat（攻击循环），那段不跳，
//   所以"整体频率"会低于"接近模式中的频率"——这是设计，不是缺陷。
//
// 用法: node tools/test-spider-queen-hop.mjs

import { World, FLAG } from '../src/world.js';
import { EnemySystem, ENEMY_TYPES } from '../src/enemies.js';

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
};

function makePlayer(x = 0, z = 0) {
  return {
    alive: true, pos: new Float32Array([x, 1, z]), eyePos: new Float32Array([x, 1.6, z]),
    forward: new Float32Array([1, 0, 0]), radius: 0.35, height: 1.8, currentHeight: 1.8,
    vel: new Float32Array(3), state: { hspeed: 0, grounded: true, speed: 0 },
    applyDamage() {}, heal() {},
  };
}
function makeSys(w, p) {
  return new EnemySystem(w, p, null, { particles: { emit() {}, emitBurst() {} } });
}
function makeWorld(withWall) {
  const w = new World({ createMesh: () => ({}) });
  w.size = 200;
  w._addBox([-95, -2, -95], [95, 0, 95], FLAG.SOLID, 'floor');
  if (withWall) w._addBox([6, 0, -30], [8, 12, 30], FLAG.SOLID, 'wallX');
  return w;
}

const T = ENEMY_TYPES.broodStalker;
console.log('\n需求 5：蛛皇跳跃');

// ── 1. 配置合理性：滞空必须短于"看起来一直在蹦"所需
{
  const gravity = 22;                       // CFG.move.gravity 默认值
  const airTime = 2 * T.hopSpeed / gravity;
  check('配置了跳跃参数', Number.isFinite(T.hopInterval) && Number.isFinite(T.hopSpeed),
    `interval=${T.hopInterval} speed=${T.hopSpeed}`);
  check('滞空时间足够短（不会一直挂在天上）', airTime < 0.5,
    `滞空 ${airTime.toFixed(2)}s < 0.5s`);
  check('跳跃间隔配置为"每几步"（远小于旧墙战的 2~4s）', T.hopInterval <= 0.4,
    `interval=${T.hopInterval}s，按 ${T.speed}m/s 约每 ${(T.speed * T.hopInterval).toFixed(1)}m 一跳`);
  check('有独立的墙跳冷却且比墙战冷却短得多', T.wallHopCooldown <= 1.5,
    `wallHopCooldown=${T.wallHopCooldown}s（墙战是 2~4s）`);
}

// ── 2. 实际跑起来：接近阶段要高频起跳
{
  const w = makeWorld(false);
  const p = makePlayer(0, 0);
  const sys = makeSys(w, p);
  const boss = sys.spawn('broodStalker', [-40, 0.5, 0]);
  boss.age = 5;
  let approachFrames = 0, airFrames = 0;
  for (let i = 0; i < 900; i++) {
    const wasGrounded = boss.grounded;
    const inAttack = boss.specialPhase === 'windup' || boss.specialPhase === 'retreat';
    sys.update(1 / 60, p);
    if (!inAttack) approachFrames++;
    if (!wasGrounded && !inAttack) airFrames++;
  }
  const hops = boss.hopCount || 0;
  check('确实发生了多次跳跃', hops >= 8, `15 秒内跳了 ${hops} 次`);
  check('接近阶段有可观比例的时间在空中（"一直在蹦"）',
    approachFrames > 0 && airFrames / approachFrames > 0.25,
    `接近帧 ${approachFrames}，其中空中 ${airFrames}（${(airFrames / Math.max(1, approachFrames) * 100).toFixed(0)}%）`);
  check('跳跃没有让它穿地', boss.pos[1] > -5, `y=${boss.pos[1].toFixed(2)}`);
}

// ── 3. 喜欢跳墙：靠近竖直墙面时跳得明显更高
{
  const wFlat = makeWorld(false);
  const sysFlat = makeSys(wFlat, makePlayer(0, 0));
  const flat = sysFlat.spawn('broodStalker', [-40, 0.5, 0]);
  flat.age = 5;
  let maxFlat = 0;
  for (let i = 0; i < 900; i++) {
    sysFlat.update(1 / 60, makePlayer(0, 0));
    if (flat.pos[1] > maxFlat) maxFlat = flat.pos[1];
  }

  // 墙边场景：玩家贴着墙，蛛皇冲过来时前方就是墙
  const wWall = makeWorld(true);
  const pWall = makePlayer(5, 0);
  const sysWall = makeSys(wWall, pWall);
  const wall = sysWall.spawn('broodStalker', [-6, 0.5, 0]);
  wall.age = 5;
  let maxWall = 0;
  for (let i = 0; i < 900; i++) {
    sysWall.update(1 / 60, pWall);
    if (wall.pos[1] > maxWall) maxWall = wall.pos[1];
  }

  check('紧邻竖直墙面时跳得更高（借墙起跳）', maxWall > maxFlat * 1.5,
    `无墙最高 ${maxFlat.toFixed(2)}m → 有墙最高 ${maxWall.toFixed(2)}m`);
}

// ── 4. 攻击阶段不跳（否则会把挥刀动作打断成抽搐）
{
  const w = makeWorld(false);
  const p = makePlayer(0, 0);
  const sys = makeSys(w, p);
  const boss = sys.spawn('broodStalker', [2.0, 0.5, 0]);   // 贴近玩家，会立刻进入 attackRange
  boss.age = 5;
  // 推进到进入 windup
  for (let i = 0; i < 200 && boss.specialPhase !== 'windup'; i++) sys.update(1 / 60, p);
  check('能进入挥刀前摇', boss.specialPhase === 'windup', `phase=${boss.specialPhase}`);
  const yBefore = boss.pos[1];
  const velYBefore = boss.vel[1];
  sys._spiderQueenHop(boss, 1 / 60, p);
  check('挥刀前摇期间不起跳（不打断攻击动作）',
    boss.vel[1] === velYBefore && boss.pos[1] === yBefore,
    `vel[1]=${boss.vel[1].toFixed(2)}`);
}

// ── 5. 房客不本地跑跳跃（位置由房主快照驱动）
{
  const w = makeWorld(false);
  const p = makePlayer(0, 0);
  const sys = makeSys(w, p);
  sys.setReplicated(true);
  const boss = sys.spawn('broodStalker', [-6, 0.5, 0]);
  boss.age = 5;
  for (let i = 0; i < 300; i++) sys.update(1 / 60, p);
  check('联机房客不本地跑跳跃（以房主为准）', (boss.hopCount || 0) === 0,
    `hopCount=${boss.hopCount || 0}`);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail > 0 ? 1 : 0;
