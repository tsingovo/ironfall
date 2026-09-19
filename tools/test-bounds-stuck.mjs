// ==== tools/test-bounds-stuck.mjs — 边界夹取 + 怪物卡住自动脱离 ====
//
// 对应两个用户反馈：
//   4. 地图边界外玩家容易卡出去
//      （大部分原型没有外围墙，跑出地形网格就没有几何可碰撞 → 掉进虚空回不来）
//   5. boss 和小怪都容易卡墙里导致动不了
//      （推出式解算在墙角会把人顶住；现在有卡住检测 + 自动脱离）
//
// 用法: node tools/test-bounds-stuck.mjs

import { World, FLAG } from '../src/world.js';
import { Player } from '../src/player.js';
import { EnemySystem } from '../src/enemies.js';
import * as CFG from '../src/core/config.js';

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
};

/** 一块 size×size 的地面，没有任何外围墙（复现问题 4 的场景） */
function makeOpenWorld(size = 200) {
  const w = new World({ createMesh: () => ({}) });
  const h = size / 2;
  w.size = size;
  w._addBox([-h, -2, -h], [h, 0, h], FLAG.SOLID, 'ground');
  w._terrainBounds = {
    min: new Float32Array([-h, -400, -h]),
    max: new Float32Array([h, 400, h]),
  };
  return w;
}

console.log('\n── 4. 地图边界夹取 ──');

{
  const w = makeOpenWorld(200);

  check('world.clampToBounds 存在', typeof w.clampToBounds === 'function');

  const p = new Float32Array([999, 5, -999]);
  const pushed = w.clampToBounds(p, 1.5);
  const half = 200 / 2 - 1.5;
  check('超出范围的位置被夹回界内',
    pushed === 3 && Math.abs(p[0]) <= half + 1e-6 && Math.abs(p[2]) <= half + 1e-6,
    `pushed=${pushed} pos=[${p[0].toFixed(1)}, ${p[2].toFixed(1)}] 上限 ${half}`);

  const inside = new Float32Array([10, 5, 10]);
  check('界内位置不受影响', w.clampToBounds(inside, 1.5) === 0,
    `pos=[${inside[0]}, ${inside[2]}]`);

  check('isOutOfBounds 判定正确',
    w.isOutOfBounds([999, 0, 0]) === true && w.isOutOfBounds([0, 0, 0]) === false);
}

{
  // 真玩家：全速朝边界冲，跑很久也不应该掉出地图
  const w = makeOpenWorld(200);
  const p = new Player(w);
  p.teleport([0, 0.5, 0]);
  p.yaw = 0; p.pitch = 0;

  const half = 200 / 2;
  let worstX = 0, worstZ = 0;
  const input = {
    moveX: 0, moveY: 1, jump: false, jumpPressed: false, jumpReleased: false,
    crouch: false, crouchPressed: false, sprint: true, fire: false, ads: false,
    reloadPressed: false, dashPressed: false, grappleDown: false, grapplePressed: false,
    swapPressed: false, interactDown: false, interactPressed: false,
    lookX: 0, lookY: 0,
  };
  // 朝 8 个方向各冲 6 秒
  for (let dir = 0; dir < 8; dir++) {
    p.teleport([0, 0.5, 0]);
    p.vel[0] = 0; p.vel[1] = 0; p.vel[2] = 0;
    p.yaw = dir * Math.PI / 4;
    for (let i = 0; i < 360; i++) {
      p.look(0, 0);
      p.updateBasis();
      p.step(1 / 60, input);
      worstX = Math.max(worstX, Math.abs(p.pos[0]));
      worstZ = Math.max(worstZ, Math.abs(p.pos[2]));
    }
  }
  check('全速冲边界不会跑出地图', worstX <= half && worstZ <= half,
    `最远 |x|=${worstX.toFixed(1)} |z|=${worstZ.toFixed(1)}，地图半宽 ${half}`);
  check('玩家没有掉出地图底部', p.pos[1] > -50, `y=${p.pos[1].toFixed(1)}`);
}

console.log('\n── 5. 怪物卡住自动脱离 ──');

{
  const w = makeOpenWorld(200);
  // 造一个夹角：两面成 90° 的墙，测试怪往里冲会不会永久卡死
  w._addBox([10, 0, -30], [12, 8, 30], FLAG.SOLID, 'wallX');
  w._addBox([-30, 0, 10], [30, 8, 12], FLAG.SOLID, 'wallZ');

  const p = {
    alive: true, pos: new Float32Array([-20, 1, -20]), radius: 0.35, height: 1.8,
    eyePos: new Float32Array([-20, 1.6, -20]), forward: new Float32Array([1, 0, 1]),
    state: { hspeed: 0, grounded: true, speed: 0 }, applyDamage() {}, heal() {},
  };
  const sys = new EnemySystem(w, p, null, {
    particles: { emit() {}, emitBurst() {} },
  });

  check('存在卡住检测实现', typeof sys._detectStuck === 'function');
  check('存在不靠墙倾向实现', typeof sys._avoidWalls === 'function');

  // 把怪放在夹角里、朝墙角冲，跑 5 秒看它会不会位移
  const e = sys.spawn('grunt', [8.6, 0.2, 8.6]);
  e.age = 5;
  const start = [e.pos[0], e.pos[2]];
  for (let i = 0; i < 300; i++) {
    p.pos[0] = e.pos[0] + 6; p.pos[2] = e.pos[2] + 6;   // 让它一直往墙角方向追
    sys.update(1 / 60, p);
  }
  const moved = Math.hypot(e.pos[0] - start[0], e.pos[2] - start[1]);
  // 只要求"没有永久冻住"：夹角里本来就会被墙面挡住一部分移动，
  // 关键是不能完全不动（卡死时位移会接近 0）。
  check('夹角里的怪没有原地卡死（有位移）', moved > 0.4,
    `位移 ${moved.toFixed(2)}m`);
  check('怪没有穿进墙体', e.pos[0] < 10.05 && e.pos[2] < 10.05,
    `pos=[${e.pos[0].toFixed(2)}, ${e.pos[2].toFixed(2)}]（墙从 10 开始）`);
}

{
  // 卡住检测的直测：人为制造"想动但动不了"，确认脱离逻辑真的触发
  const w = makeOpenWorld(200);
  const p = {
    alive: true, pos: new Float32Array([0, 1, 0]), radius: 0.35, height: 1.8,
    eyePos: new Float32Array([0, 1.6, 0]), forward: new Float32Array([0, 0, 1]),
    state: { hspeed: 0, grounded: true, speed: 0 }, applyDamage() {}, heal() {},
  };
  const sys = new EnemySystem(w, p, null, { particles: { emit() {}, emitBurst() {} } });
  const e = sys.spawn('grunt', [0, 0.2, 0]);
  e.age = 5;
  // 连续喂"有速度但位置不变"的帧 —— 正是被墙顶住的特征
  let escaped = 0;
  for (let i = 0; i < 60; i++) {
    e.vel[0] = 6; e.vel[2] = 0;
    e.pos[0] = 0; e.pos[2] = 0;                 // 位置纹丝不动
    sys._detectStuck(e, 1 / 60);
    if (Math.abs(e.vel[1]) > 1 || Math.abs(e.vel[2]) > 0.5 || e.stuckAttempts > 0) escaped++;
  }
  check('卡住超过阈值后会自动脱离', escaped > 0,
    `触发 ${escaped} 次（上抬/侧推/瞬移任一即可）`);
}

{
  // 不靠墙倾向：怪朝墙走时应当被推离墙面，而不是贴上去磨
  const w = makeOpenWorld(200);
  w._addBox([10, 0, -30], [12, 8, 30], FLAG.SOLID, 'wallX');
  const p = {
    alive: true, pos: new Float32Array([20, 1, 0]), radius: 0.35, height: 1.8,
    eyePos: new Float32Array([20, 1.6, 0]), forward: new Float32Array([-1, 0, 0]),
    state: { hspeed: 0, grounded: true, speed: 0 }, applyDamage() {}, heal() {},
  };
  const sys = new EnemySystem(w, p, null, { particles: { emit() {}, emitBurst() {} } });
  // 贴近墙面（探针长度 = max(radius,0.4)+0.9 ≈ 1.3m，所以必须站得更近才探得到）
  const e = sys.spawn('grunt', [9.0, 0.2, 0]);
  e.age = 5;
  // 让它朝 +X（墙的方向）全速移动
  e.vel[0] = 6; e.vel[2] = 0;
  sys._avoidWalls(e, 1 / 60);
  // 期望：不再朝墙（+X）推进 —— 要么朝外弹开（vel[0] 变负），要么沿墙切向偏转。
  // 这里不能只看 |vel[0]|，把 +6 弹成 -6 时绝对值不变，但那正是我们要的行为。
  const awayFromWall = e.vel[0] < 0.5;
  const tangential = Math.abs(e.vel[2]) > 0.5;
  check('非蜘蛛兵种朝墙移动时被切向重定向/弹开', awayFromWall || tangential,
    `vel=[${e.vel[0].toFixed(2)}, ${e.vel[2].toFixed(2)}]（原为朝墙 +6）`);

  // 蜘蛛不应被重定向（它本来就要爬墙）
  const sp = sys.spawn('blastSpider', [9.0, 0.2, 0]);
  sp.vel[0] = 6; sp.vel[2] = 0;
  sys._avoidWalls(sp, 1 / 60);
  check('爆蛛不受不靠墙逻辑影响（保留爬墙行为）',
    Math.abs(sp.vel[0] - 6) < 1e-6 && Math.abs(sp.vel[2]) < 1e-6,
    `vel=[${sp.vel[0].toFixed(2)}, ${sp.vel[2].toFixed(2)}]`);
}

{
  // 敌人也不应该跑出地图
  const w = makeOpenWorld(200);
  const p = {
    alive: true, pos: new Float32Array([0, 1, 0]), radius: 0.35, height: 1.8,
    eyePos: new Float32Array([0, 1.6, 0]), forward: new Float32Array([0, 0, 1]),
    state: { hspeed: 0, grounded: true, speed: 0 }, applyDamage() {}, heal() {},
  };
  const sys = new EnemySystem(w, p, null, { particles: { emit() {}, emitBurst() {} } });
  const e = sys.spawn('grunt', [90, 0.2, 0]);
  e.age = 5;
  e.vel[0] = 40; e.vel[2] = 40;                 // 硬塞一个朝界外的速度
  for (let i = 0; i < 240; i++) sys.update(1 / 60, p);
  check('敌人被夹回地图范围内', Math.abs(e.pos[0]) <= 100 && Math.abs(e.pos[2]) <= 100,
    `pos=[${e.pos[0].toFixed(1)}, ${e.pos[2].toFixed(1)}]`);
}

void CFG;
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail > 0 ? 1 : 0;
