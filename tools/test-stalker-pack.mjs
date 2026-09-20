// ==== tools/test-stalker-pack.mjs — 需求 3：绿影自相残杀 ====
//
// 需求原文：
//   「绿影设置碰撞体积，如果小范围人数过多，会不断互相攻击自相残杀，
//     直到 4m 范围内只有 4 只以下，击杀同类后总状态回满至原上限 2 倍，
//     速度变为 22m/s，具有夸张的横向移动，boss 不受该逻辑影响，
//     也不被绿影识别为同类。」
//
// 这里直接驱动 _updateStalkerPack（而不是跑完整 update），
// 因为完整 update 里绿影会以 18m/s 到处跑，簇的构成每帧都在变，断言不稳定。
//
// 用法: node tools/test-stalker-pack.mjs

import { World, FLAG } from '../src/world.js';
import { EnemySystem, ENEMY_TYPES } from '../src/enemies.js';

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
};

function makeWorld() {
  const w = new World({ createMesh: () => ({}) });
  w.size = 200;
  w._addBox([-95, -2, -95], [95, 0, 95], FLAG.SOLID, 'floor');
  return w;
}
function makePlayer() {
  return {
    alive: true, pos: new Float32Array([0, 1, 0]), eyePos: new Float32Array([0, 1.6, 0]),
    forward: new Float32Array([0, 0, 1]), radius: 0.35, height: 1.8, currentHeight: 1.8,
    vel: new Float32Array(3), state: { hspeed: 0, grounded: true, speed: 0 },
    applyDamage() {}, heal() {},
  };
}
function makeSys(particles) {
  return new EnemySystem(makeWorld(), makePlayer(), null,
    { particles: particles || { emit() {}, emitBurst() {} } });
}

console.log('\n需求 3：绿影碰撞体积与自相残杀');

// ── 1. 4m 内超过 4 只 → 会互相攻击直到只剩 4 只
{
  const sys = makeSys();
  // 6 只挤在同一个点上（距离 0，最极端的"小范围人数过多"）
  const mob = [];
  for (let i = 0; i < 6; i++) mob.push(sys.spawn('stalker', [0, 0.5, 0]));
  const before = mob.filter((e) => e.alive).length;

  // 反复推进；每帧把它们按回原位，模拟"一直挤在一起"
  for (let step = 0; step < 400; step++) {
    for (const e of mob) { e.pos[0] = 0; e.pos[1] = 0.5; e.pos[2] = 0; }
    sys._updateStalkerPack(1 / 60);
  }
  const alive = mob.filter((e) => e.alive).length;
  check('4m 内 6 只会自相残杀减少', alive < before, `${before} 只 → ${alive} 只`);
  check('残杀收敛到 4 只以下（含 4）', alive <= 4, `剩 ${alive} 只`);
}

// ── 2. 刚好 4 只不应该互相打
{
  const sys = makeSys();
  const mob = [];
  for (let i = 0; i < 4; i++) mob.push(sys.spawn('stalker', [0, 0.5, 0]));
  for (let step = 0; step < 400; step++) {
    for (const e of mob) { e.pos[0] = 0; e.pos[1] = 0.5; e.pos[2] = 0; }
    sys._updateStalkerPack(1 / 60);
  }
  const alive = mob.filter((e) => e.alive).length;
  check('4m 内恰好 4 只时不会互相攻击', alive === 4, `剩 ${alive} 只`);
}

// ── 3. 分散的绿影不会互相打
{
  const sys = makeSys();
  const a = sys.spawn('stalker', [0, 0.5, 0]);
  const b = sys.spawn('stalker', [30, 0.5, 0]);     // 相距 30m，远超 4m
  const hpA = a.hp, hpB = b.hp;
  for (let step = 0; step < 300; step++) {
    a.pos[0] = 0; a.pos[2] = 0;
    b.pos[0] = 30; b.pos[2] = 0;
    sys._updateStalkerPack(1 / 60);
  }
  check('相距较远的绿影不会互相攻击', a.hp === hpA && b.hp === hpB && a.alive && b.alive,
    `hp ${hpA}/${hpB} → ${a.hp}/${b.hp}`);
}

// ── 4. 碰撞体积：重叠的绿影被推开
{
  const sys = makeSys();
  const a = sys.spawn('stalker', [0, 0.5, 0]);
  const b = sys.spawn('stalker', [0, 0.5, 0]);      // 完全重合
  const minD = (a.radius || 0.4) + (b.radius || 0.4);
  sys._updateStalkerPack(1 / 60);
  const d = Math.hypot(b.pos[0] - a.pos[0], b.pos[2] - a.pos[2]);
  check('完全重合的绿影会被推开（有碰撞体积）', d > 0.01,
    `分离后距离 ${d.toFixed(3)}m，二者半径和 ${minD.toFixed(2)}m`);
}

// ── 5. 击杀同类后的强化：上限 2 倍、速度 22、横向移动夸张、状态回满
{
  const particles = { emitted: [], emit(kind, o) { this.emitted.push(kind); }, emitBurst() {} };
  const sys = makeSys(particles);
  const winner = sys.spawn('stalker', [0, 0.5, 0]);
  const base = ENEMY_TYPES.stalker;
  // 让 winner 先掉点血，验证"回满"确实发生
  winner.hp = 10;
  winner.shield = 0;
  sys._rewardPackKill(winner);

  check('击杀同类后血量上限变为原上限的 2 倍',
    winner.maxHp === base.hp * 2, `${base.hp} → ${winner.maxHp}`);
  check('击杀同类后护盾上限变为原上限的 2 倍',
    winner.maxShield === base.shield * 2, `${base.shield} → ${winner.maxShield}`);
  check('击杀同类后总状态回满至新上限',
    winner.hp === winner.maxHp && winner.shield === winner.maxShield,
    `hp=${winner.hp}/${winner.maxHp} shield=${winner.shield}/${winner.maxShield}`);
  check('击杀同类后速度变为 22 m/s', winner.speed === 22, `speed=${winner.speed}`);
  check('横向移动变得夸张（weaveAmp 提升）',
    Number.isFinite(winner.weaveAmp) && winner.weaveAmp > (base.weaveAmp || 0.45),
    `weaveAmp=${winner.weaveAmp}（基础 ${base.weaveAmp || 0.45}）`);
  check('强化只发生一次（不会反复翻倍滚雪球）', (() => {
    const hp1 = winner.maxHp;
    sys._rewardPackKill(winner);
    return winner.maxHp === hp1;
  })(), `再次调用后 maxHp=${winner.maxHp}`);
  check('击杀同类有可见特效', particles.emitted.length > 0, particles.emitted.join(','));
}

// ── 6. BOSS 不参与、也不被识别为同类
{
  const sys = makeSys();
  // 蛛皇（hybridBoss）与 6 只绿影挤在一起
  const boss = sys.spawn('broodStalker', [0, 0.5, 0]);
  const mob = [];
  for (let i = 0; i < 6; i++) mob.push(sys.spawn('stalker', [0, 0.5, 0]));
  const bossHp = boss.hp;
  for (let step = 0; step < 400; step++) {
    boss.pos[0] = 0; boss.pos[1] = 0.5; boss.pos[2] = 0;
    for (const e of mob) { e.pos[0] = 0; e.pos[1] = 0.5; e.pos[2] = 0; }
    sys._updateStalkerPack(1 / 60);
  }
  check('BOSS 不受自相残杀逻辑影响', boss.alive && boss.hp === bossHp,
    `boss hp ${bossHp} → ${boss.hp}`);
  check('BOSS 不被绿影识别为同类（不参与簇计数）',
    mob.filter((e) => e.alive).length <= 4,
    `绿影剩 ${mob.filter((e) => e.alive).length} 只（BOSS 未计入）`);
}

// ── 7. 房客（replicated）不跑这套逻辑
{
  const sys = makeSys();
  sys.setReplicated(true);
  const mob = [];
  for (let i = 0; i < 6; i++) mob.push(sys.spawn('stalker', [0, 0.5, 0]));
  const hp0 = mob.map((e) => e.hp);
  for (let step = 0; step < 120; step++) {
    for (const e of mob) { e.pos[0] = 0; e.pos[1] = 0.5; e.pos[2] = 0; }
    sys.update(1 / 60, makePlayer());
  }
  check('联机房客不本地跑自相残杀（以房主为准）',
    mob.every((e, i) => e.hp === hp0[i]),
    '所有绿影血量未变');
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail > 0 ? 1 : 0;
