// ==== tools/test-stalker-weave.mjs — 绿影(含蛛皇)蛇形接近的行为自测 ====
//
// 验证四件事：
//   1. 总速度：接近过程中水平速度稳定在 type.speed（绿影 18 m/s）附近，
//      摆动不应让它变慢或变快
//   2. 非线性：横向速度方向会多次反转 —— 说明确实在左右摆动，
//      而不是一次性偏航后继续走直线
//   3. 个体差异：两只绿影的轨迹不应完全相同（相位/频率按 e.id 派生）
//   4. 蛛皇（关卡 boss）同样生效
//
// 世界构造沿用 tools/test-special-enemies.mjs 的做法：无引擎 stub + 一整块地面盒。
//
// 用法: node tools/test-stalker-weave.mjs

import { World, FLAG } from '../src/world.js';
import { EnemySystem } from '../src/enemies.js';

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
};

function player() {
  return {
    alive: true,
    pos: new Float32Array([0, 1, -40]),
    eyePos: new Float32Array([0, 1.62, -40]),
    forward: new Float32Array([0, 0, 1]),
    radius: 0.35, height: 1.8,
    state: { hspeed: 0, grounded: true },
    applyDamage() {}, heal() {},
  };
}

function setup(p) {
  const world = new World({ createMesh: () => ({}) });
  // 一整块巨大的地面，保证没有掩体干扰 —— 测的是纯运动学
  world._addBox([-300, -2, -300], [300, 0, 300], FLAG.SOLID, 'ground');
  const fx = [];
  const sys = new EnemySystem(world, p, null, {
    particles: { emit: (...a) => fx.push(a), emitBurst: () => {} },
  });
  return { world, sys, p, fx };
}

/** 跑一段并采集速度/横向分量的统计 */
function run(sys, p, e, steps, stopDist) {
  const speeds = [];
  let prevSide = 0, reversals = 0, peakLat = 0;
  let minDist = Infinity;
  for (let i = 0; i < steps; i++) {
    sys.update(1 / 60, p);
    const sp = Math.hypot(e.vel[0], e.vel[2]);
    if (sp > 0.5) speeds.push(sp);

    const dx = e.pos[0] - p.pos[0], dz = e.pos[2] - p.pos[2];
    const d = Math.hypot(dx, dz) || 1;
    minDist = Math.min(minDist, d);
    // 横向 = 速度在"垂直于视线"方向上的投影
    const lat = e.vel[0] * (-dz / d) + e.vel[2] * (dx / d);
    if (Math.abs(lat) > peakLat) peakLat = Math.abs(lat);
    const sign = Math.sign(lat);
    if (sign !== 0) {
      if (prevSide !== 0 && sign !== prevSide) reversals++;
      prevSide = sign;
    }
    if (d < stopDist) break;
  }
  const max = speeds.length ? Math.max(...speeds) : 0;
  const avg = speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;
  return { max, avg, peakLat, reversals, minDist, samples: speeds.length };
}

console.log('\n绿影蛇形接近 —— 行为自测');

// ---------------------------------------------------------------- 1 & 2. 绿影
{
  const p = player();
  const { sys } = setup(p);
  const e = sys.spawn('stalker', [0, 0.1, 0]);
  e.age = 5;
  const r = run(sys, p, e, 300, 3.2);

  console.log('\n── 1. 总速度（目标 18 m/s）──');
  check('接近过程中水平速度达标', r.max > 15 && r.max <= 19.2,
    `峰值 ${r.max.toFixed(2)} m/s，均值 ${r.avg.toFixed(2)} m/s（${r.samples} 采样）`);
  check('没有明显超调（<= 18×1.06 = 19.08）', r.max <= 19.08, `峰值 ${r.max.toFixed(2)}`);
  check('没有长期偏低（均值 > 14）', r.avg > 14, `均值 ${r.avg.toFixed(2)}`);

  console.log('\n── 2. 非线性摆动 ──');
  check('存在可测量的横向速度', r.peakLat > 2, `峰值横向速度 ${r.peakLat.toFixed(2)} m/s`);
  check('横向方向多次反转（确实在左右摆动，非一次偏航）', r.reversals >= 2,
    `反转 ${r.reversals} 次`);
  check('最终仍能推进到攻击距离内（摆动不影响接敌）', r.minDist < 4,
    `最近距离 ${r.minDist.toFixed(2)} m`);
}

// ---------------------------------------------------------------- 3. 个体差异
{
  const p = player();
  const A = setup(p);
  const B = setup(p);
  const a = A.sys.spawn('stalker', [0, 0.1, 0]);
  const b = B.sys.spawn('stalker', [0, 0.1, 0]);
  a.age = 5; b.age = 5;
  const ta = [], tb = [];
  for (let i = 0; i < 150; i++) {
    A.sys.update(1 / 60, p);
    B.sys.update(1 / 60, p);
    ta.push(a.vel[0]);
    tb.push(b.vel[0]);
  }
  let identical = 0;
  for (let i = 0; i < ta.length; i++) if (Math.abs(ta[i] - tb[i]) < 1e-9) identical++;
  console.log('\n── 3. 个体差异 ──');
  check('两只绿影轨迹不同（相位按 e.id 派生，不会全体同步）',
    identical < ta.length * 0.5, `${identical}/${ta.length} 帧完全相同`);
}

// ---------------------------------------------------------------- 4. 蛛皇
{
  const p = player();
  const { sys } = setup(p);
  const e = sys.spawn('broodStalker', [0, 0.1, 0]);
  e.age = 5;
  const r = run(sys, p, e, 300, 4.0);
  console.log('\n── 4. 绿影蛛皇（关卡 boss）──');
  check('蛛皇同样使用蛇形接近且速度达标', r.max > 15 && r.max <= 19.2,
    `峰值 ${r.max.toFixed(2)} m/s`);
  check('蛛皇也在左右摆动', r.reversals >= 2, `反转 ${r.reversals} 次`);
}

// ---------------------------------------------------------------- 5. 对照：普通兵种不应被影响
{
  const p = player();
  const { sys } = setup(p);
  const e = sys.spawn('grunt', [0, 0.1, 0]);
  e.age = 5;
  const r = run(sys, p, e, 200, 5);
  console.log('\n── 5. 对照（普通兵种行为不受影响）──');
  check('普通兵种仍走直线接近（横向反转很少）', r.reversals <= 2,
    `反转 ${r.reversals} 次，峰值横向 ${r.peakLat.toFixed(2)} m/s`);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
