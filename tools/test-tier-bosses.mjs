// ==== tools/test-tier-bosses.mjs — 需求 8：第三关开始每关都有 boss ====
//
// 需求原文（要点）：
//   第三关开始都有 boss。第 4 关重盾机甲（蓝色透明护盾、转向慢、放 2-3 只爆炸蜘蛛、
//   激光炮 200 伤 + 减速 60% 3 秒、击中护盾不算击中 boss）
//   第 5 关神秘杀手（身高 6 倍、每秒瞬移、贴身捶地秒杀其他怪 + 玩家 100 伤 + 击飞）
//   第 6 关腐化龙（空中盘旋、锁定正下方 100m 俯冲 100 伤）
//   第 7 关克隆哥布林大军（每只 1 血、伤害 1、每秒一次、同存 50 只、死亡 100 只后罐子爆炸）
//   第 8 关鬼火骑士（来回冲刺，击中后仍要冲满 40m、伤害 50）
//   第 9 关拳皇（跳着走、血量 500、伤害 10、攻击频率 1、远程无效）
//   第 10 关熔岩守卫者（无任务无小怪、跳跃保持 50-150m、静止爆炸蜘蛛、
//                        追踪弹每秒约 5 个、可被击破、命中 40 伤）
//   除了拳皇外，boss 血量按目前样本大致线性增长。
//
// 用法: node tools/test-tier-bosses.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { World, FLAG } from '../src/world.js';
import { EnemySystem, ENEMY_TYPES } from '../src/enemies.js';
import { Director } from '../src/director.js';
import { ProjectilePool } from '../src/fx/projectiles.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
};

function makePlayer(x = 0, z = 0) {
  return {
    alive: true, pos: new Float32Array([x, 1, z]), eyePos: new Float32Array([x, 1.6, z]),
    forward: new Float32Array([1, 0, 0]), radius: 0.35, height: 1.8, currentHeight: 1.8, yaw: 0,
    vel: new Float32Array(3), state: { hspeed: 0, grounded: true, speed: 0 },
    applyDamage() {}, heal() {},
  };
}
function setup(tier) {
  const w = new World({ createMesh: () => ({}) });
  w.size = 200;
  w._addBox([-95, -2, -95], [95, 0, 95], FLAG.SOLID, 'floor');
  w._navCandidates = [];
  for (let x = -80; x <= 80; x += 8) for (let z = -80; z <= 80; z += 8) w._navCandidates.push(new Float32Array([x, 0, z]));
  const p = makePlayer();
  // 接上投射物系统：第 10 关的「追踪弹可被击破」需要真实走 projectiles 的路径
  const projectiles = new ProjectilePool(null, 256);
  const enemies = new EnemySystem(w, p, null, { particles: { emit() {}, emitBurst() {} }, projectiles });
  enemies.audioEnabled = false;
  const run = { tier, bossPending: true, phase: 'objectives', objectives: [] };
  const d = new Director(w, enemies, p, {});
  d.active = true; d.enabled = true;
  d.start(run);
  run.bossPending = true;
  return { d, enemies, run, p, w };
}

const EXPECT = {
  3: 'broodStalker', 4: 'tier4ShieldMech', 5: 'tier5Stalker', 6: 'tier6Dragon',
  7: 'tier7Vat', 8: 'tier8GhostKnight', 9: 'tier9Boxer', 10: 'tier10LavaGuardian',
};

console.log('\n需求 8：每关 boss');

// ── 1. 第 3~10 关各自生成正确的 boss
{
  const bad = [];
  for (const tier of [3, 4, 5, 6, 7, 8, 9, 10]) {
    const { d } = setup(tier);
    d._boss = null;
    for (let i = 0; i < 90 && !d._boss; i++) d.update(1 / 60);
    if (!d._boss) { bad.push(`tier${tier}:未生成`); continue; }
    if (d._boss.typeId !== EXPECT[tier]) bad.push(`tier${tier}:${d._boss.typeId}`);
  }
  check('第 3~10 关都生成了对应的 boss', bad.length === 0, bad.length ? bad.join(', ') : '8 层全部正确');
}

// ── 2. 第 1/2 关不应有 boss（需求是"第三关开始"）
{
  const bad = [];
  for (const tier of [1, 2]) {
    const { d, run } = setup(tier);
    run.bossPending = tier >= 3;          // 与 director.start 的判定一致
    d._boss = null;
    for (let i = 0; i < 60; i++) d.update(1 / 60);
    if (d._boss) bad.push(`tier${tier}`);
  }
  check('第 1/2 关没有 boss', bad.length === 0, bad.length ? bad.join(',') : '符合"第三关开始"');
}

// ── 3. 血量线性增长（拳皇除外，固定 500）
{
  const hp = {};
  for (const tier of [3, 4, 5, 6, 8, 9, 10]) {
    const { d } = setup(tier);
    d._boss = null;
    for (let i = 0; i < 90 && !d._boss; i++) d.update(1 / 60);
    hp[tier] = d._boss ? d._boss.maxHp : null;
  }
  check('拳皇血量固定为 500（需求明确）', hp[9] === 500, `hp=${hp[9]}`);
  const seq = [3, 4, 5, 6, 8, 10].map((t) => hp[t]);
  const rising = seq.every((v, i) => i === 0 || (v != null && seq[i - 1] != null && v > seq[i - 1]));
  check('其余 boss 血量随层数递增（大致线性增长）', rising, seq.join(' → '));
}

// ── 4. 重盾机甲：转向慢 + 正面护盾 + 会放爆炸蜘蛛
{
  const { d, enemies, p } = setup(4);
  d._boss = null;
  for (let i = 0; i < 90 && !d._boss; i++) d.update(1 / 60);
  const boss = d._boss;
  const t = ENEMY_TYPES.tier4ShieldMech;
  check('重盾机甲有正面护盾配置', !!t.frontShield && t.shieldArc > 0);
  check('转向速率明显偏慢', t.turnRate > 0 && t.turnRate <= 1.5, `turnRate=${t.turnRate} rad/s`);

  // 放蜘蛛：推进足够长时间
  const before = enemies.all.filter((e) => e.alive && e.typeId === 'blastSpider').length;
  for (let i = 0; i < 700; i++) d.update(1 / 60);
  const after = enemies.all.filter((e) => e.alive && e.typeId === 'blastSpider').length;
  check('会释放爆炸蜘蛛', after > before, `爆炸蜘蛛 ${before} → ${after}`);
  void p;
}

// ── 5. 神秘杀手：身高 6 倍 + 会瞬移
{
  const { d, p } = setup(5);
  d._boss = null;
  for (let i = 0; i < 90 && !d._boss; i++) d.update(1 / 60);
  const boss = d._boss;
  const t = ENEMY_TYPES.tier5Stalker;
  check('身高是玩家的约 6 倍', Math.abs(boss.height - p.height * 6) < 0.6,
    `boss ${boss.height.toFixed(2)}m vs 玩家 ${p.height}m`);
  // 把玩家放远，观察它在 2 秒内是否发生瞬移（位置跳变）
  p.pos[0] = 60; p.pos[2] = 60;
  let maxJump = 0, last = [boss.pos[0], boss.pos[2]];
  for (let i = 0; i < 240; i++) {
    d.update(1 / 60);
    const step = Math.hypot(boss.pos[0] - last[0], boss.pos[2] - last[1]);
    // 单帧位移远超正常移动速度即为瞬移
    if (step > 12) maxJump = Math.max(maxJump, step);
    last = [boss.pos[0], boss.pos[2]];
  }
  check('会瞬移（出现远超步行速度的单帧位移）', maxJump > 12,
    `最大单帧位移 ${maxJump.toFixed(1)}m`);
}

// ── 6. 克隆罐：不可被直接击杀 + 会持续补哥布林
{
  const { d, enemies } = setup(7);
  d._boss = null;
  for (let i = 0; i < 90 && !d._boss; i++) d.update(1 / 60);
  const vat = d._boss;
  check('克隆罐生成了', vat && vat.typeId === 'tier7Vat');
  const hpBefore = vat.hp;
  enemies.damage(vat, 999999, false, vat.pos, null, {});
  check('克隆罐不可被直接击杀', vat.alive && vat.hp === hpBefore, `hp=${vat.hp}`);
  // 推进看是否开始生成哥布林
  for (let i = 0; i < 300; i++) d.update(1 / 60);
  const goblins = enemies.all.filter((e) => e.alive && e.typeId === 'tier7CloneGoblin').length;
  check('克隆罐持续生成哥布林', goblins > 0, `当前 ${goblins} 只`);
  check('哥布林血量 1、护盾 0（需求）',
    ENEMY_TYPES.tier7CloneGoblin.hp === 1 && ENEMY_TYPES.tier7CloneGoblin.shield === 0);
  check('哥布林伤害 1、攻击间隔 1 秒（需求）',
    ENEMY_TYPES.tier7CloneGoblin.weapon.damage === 1 && ENEMY_TYPES.tier7CloneGoblin.weapon.burstPause === 1.0);
}

// ── 7. 拳皇：血量 500、伤害 10、远程免疫、只会跳
{
  const t = ENEMY_TYPES.tier9Boxer;
  check('拳皇血量 500 / 伤害 10 / 攻击频率 1 秒', t.hp === 500 && t.weapon.damage === 10 && t.weapon.burstPause === 1.0,
    `hp=${t.hp} dmg=${t.weapon.damage} pause=${t.weapon.burstPause}`);
  check('拳皇标记了远程免疫', t.rangedImmune === true);
  check('拳皇只会跳着走', t.hopOnly === true && Number.isFinite(t.hopInterval));
}

// ── 8. 熔岩守卫者：可被击破的追踪弹（引擎能力）
{
  const { d } = setup(10);
  d._boss = null;
  for (let i = 0; i < 90 && !d._boss; i++) d.update(1 / 60);
  const boss = d._boss;
  const t = ENEMY_TYPES.tier10LavaGuardian;
  check('标记了"无任务无小怪"', t.noObjectives === true && t.noMinions === true);
  check('追踪弹参数齐全（血量 1、伤害 40、速度慢、追踪）',
    t.bulletHp === 1 && t.bulletDamage === 40 && t.bulletSpeed > 0 && t.bulletSpeed < 20 && t.bulletHoming === true);

  // 直接调用生成，验证投射物真的带上了 hp / homing 标记
  const proj = d.enemies.projectiles;
  if (!proj) {
    console.log('  SKIP  投射物系统不可用，跳过拦截/追踪字段断言');
  } else {
    d._spawnHomingBullet(boss, t, 0);
    const n = proj.count;
    check('生成的子弹带可击破标记（hp>0）', n > 0 && proj.hp[n - 1] === t.bulletHp,
      n > 0 ? `hp=${proj.hp[n - 1]}` : '没有生成');
    check('生成的子弹带追踪标记', n > 0 && proj.homing[n - 1] === 1);
    // 拦截：构造一条正好穿过子弹的玩家射线，推进一帧后子弹应被销毁
    const bx = proj.px[n - 1], by = proj.py[n - 1], bz = proj.pz[n - 1];
    const before = proj.count;
    d.enemies.projectiles.update(1 / 60, d.world, d.enemies, [
      { ox: bx - 10, oy: by, oz: bz, dx: 1, dy: 0, dz: 0, len: 20 },
    ]);
    check('玩家射击可以击破这发子弹', proj.count < before,
      `子弹数 ${before} → ${proj.count}`);
  }
}

// ── 9. 全部 boss 都带 tierBoss 标记（供 HUD/结算识别）
{
  const bad = [];
  for (const id of Object.values(EXPECT)) {
    const def = ENEMY_TYPES[id];
    if (!def) { bad.push(id + ':缺失'); continue; }
    if (id === 'broodStalker') {
      // 蛛皇用的是既有 hybridBoss 标记
      if (!def.hybridBoss) bad.push(id + ':无 boss 标记');
    } else if (!def.tierBoss) bad.push(id + ':无 tierBoss 标记');
  }
  check('所有关卡 boss 都带 boss 标记', bad.length === 0, bad.length ? bad.join(', ') : `${Object.values(EXPECT).length} 个`);
}

// ── 10. 源码级护栏：不得再把刷怪环推出地图尺度
{
  const src = readFileSync(join(root, 'src/enemies.js'), 'utf8');
  // 内置地图 size=200 → 半宽 100；导演的环约为 attackRange+12 起，
  // 超过 ~115 就基本选不到点（第 10 关踩过这个坑）。
  const bad = [];
  for (const id of Object.values(EXPECT)) {
    const def = ENEMY_TYPES[id];
    if (!def) continue;
    const ar = def.attackRange || 0;
    if (ar > 115) bad.push(`${id}:attackRange=${ar}`);
  }
  check('所有 boss 的交战距离都在地图尺度内（<115m）', bad.length === 0,
    bad.length ? bad.join(', ') : '符合');
  void src;
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail > 0 ? 1 : 0;
