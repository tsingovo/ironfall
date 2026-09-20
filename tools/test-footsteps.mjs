// ==== tools/test-footsteps.mjs — 需求 9：所有怪物以及玩家增加脚步声 ====
//
// 需求原文：「所有怪物以及玩家增加脚步声」。
//
// 这里验证的是**触发行为**而不是声音本身（音频合成需要 AudioContext，
// 纯逻辑测试环境没有）。断言重点：
//   · 玩家在地面移动会迈步，且步频随速度提高
//   · 滑铲/蹬墙跑/空中不迈步
//   · 各类敌人按体型选不同音色，飞行单位不迈步
//   · 房客不本地迈步（位置由房主快照驱动，本地发声会与位置对不上）
//   · main.js 的事件转发不会丢掉 rate（真实踩过的 bug）
//
// 用法: node tools/test-footsteps.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { World, FLAG } from '../src/world.js';
import { EnemySystem } from '../src/enemies.js';
import { Player } from '../src/player.js';
import * as Events from '../src/core/events.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
};

const played = [];
const off = Events.on('audio:play', (p) => {
  if (String(p.name).startsWith('footstep')) played.push(p);
});

function makeWorld() {
  const w = new World({ createMesh: () => ({}) });
  w.size = 200;
  w._addBox([-95, -2, -95], [95, 0, 95], FLAG.SOLID, 'floor');
  return w;
}
function makeEnemyPlayer() {
  return {
    alive: true, pos: new Float32Array([0, 1, 0]), eyePos: new Float32Array([0, 1.6, 0]),
    forward: new Float32Array([0, 0, 1]), radius: 0.35, height: 1.8, currentHeight: 1.8,
    vel: new Float32Array(3), state: { hspeed: 0, grounded: true, speed: 0 },
    applyDamage() {}, heal() {},
  };
}
function walkInput(over) {
  return Object.assign({
    moveX: 0, moveY: 1, jump: false, jumpPressed: false, jumpReleased: false,
    crouch: false, crouchPressed: false, sprint: false, fire: false, ads: false,
    reloadPressed: false, dashPressed: false, grappleDown: false, grapplePressed: false,
    swapPressed: false, interactDown: false, interactPressed: false, lookX: 0, lookY: 0,
  }, over || {});
}

console.log('\n需求 9：脚步声');

// ── 1. 音效已在音频库里注册（否则 play 会静默失败）
{
  const audio = readFileSync(join(root, 'src/audio/audio.js'), 'utf8');
  check('注册了玩家脚步声 footstep_player', /footstep_player:\s*\{/.test(audio));
  check('注册了重型敌人脚步声 footstep_heavy', /footstep_heavy:\s*\{/.test(audio));
  check('注册了轻型敌人脚步声 footstep_light', /footstep_light:\s*\{/.test(audio));
}

// ── 2. 玩家：走路会迈步
{
  const w = makeWorld();
  const pl = new Player(w);
  pl.teleport([0, 0.5, 0]);
  played.length = 0;
  for (let i = 0; i < 360; i++) { pl.look(0, 0); pl.updateBasis(); pl.step(1 / 120, walkInput()); }
  const walkSteps = played.length;
  check('玩家步行会迈步', walkSteps > 0, `3 秒 ${walkSteps} 步`);

  // 冲刺：同样时长内步数应该更多
  pl.teleport([0, 0.5, 0]);
  played.length = 0;
  for (let i = 0; i < 360; i++) {
    pl.look(0, 0); pl.updateBasis(); pl.step(1 / 120, walkInput({ sprint: true }));
  }
  const runSteps = played.length;
  check('冲刺时步频更高（步距累积的自然结果）', runSteps > walkSteps,
    `步行 ${walkSteps} 步 → 冲刺 ${runSteps} 步`);
  check('脚步声带位置信息（用于左右声道定位）',
    played.length > 0 && Array.isArray(played[0].pos) && played[0].pos.length === 3);
  check('脚步声带 rate（避免每次听起来完全一样）',
    played.length > 0 && Number.isFinite(played[0].rate));
}

// ── 3. 玩家：站着不动不迈步
{
  const w = makeWorld();
  const pl = new Player(w);
  pl.teleport([0, 0.5, 0]);
  played.length = 0;
  for (let i = 0; i < 240; i++) { pl.look(0, 0); pl.updateBasis(); pl.step(1 / 120, walkInput({ moveY: 0 })); }
  check('站着不动不迈步', played.length === 0, `${played.length} 步`);
}

// ── 4. 玩家：空中不迈步
{
  const w = makeWorld();
  const pl = new Player(w);
  pl.teleport([0, 20, 0]);                       // 高空落下
  played.length = 0;
  let airFrames = 0;
  for (let i = 0; i < 120; i++) {
    pl.look(0, 0); pl.updateBasis();
    if (!pl.state.grounded) airFrames++;
    pl.step(1 / 120, walkInput());
  }
  // 落地前不应有脚步；落地后可能有一两步，只断言"空中阶段没有"
  check('空中阶段不迈步（落地音由 land 负责）', airFrames > 0 && played.length <= 2,
    `空中 ${airFrames} 帧，期间共 ${played.length} 步`);
}

// ── 5. 敌人：各类兵种按体型选音色
{
  const w = makeWorld();
  const sys = new EnemySystem(w, makeEnemyPlayer(), null, { particles: { emit() {}, emitBurst() {} } });
  const cases = [
    ['heavy', 'footstep_heavy', '重装兵'],
    ['broodStalker', 'footstep_heavy', '蛛皇'],
    ['swarm', 'footstep_light', '虫群'],
    ['blastSpider', 'footstep_light', '爆蛛'],
    ['grunt', 'footstep_player', '普通步兵'],
  ];
  for (const [id, expect, label] of cases) {
    const e = sys.spawn(id, [0, 0.5, 0]);
    e.age = 5;
    played.length = 0;
    for (let i = 0; i < 300; i++) { e.vel[0] = 6; e.vel[2] = 0; sys._physics(e, 1 / 120); }
    const got = played.length ? played[0].name : '(无)';
    check(`${label} 有脚步声且音色正确`, played.length > 0 && got === expect,
      `${played.length} 步，音色 ${got}`);
  }
}

// ── 6. 飞行单位不迈步
{
  const w = makeWorld();
  const sys = new EnemySystem(w, makeEnemyPlayer(), null, { particles: { emit() {}, emitBurst() {} } });
  const flyer = sys.spawn('flyer', [0, 5, 0]);
  flyer.age = 5;
  played.length = 0;
  for (let i = 0; i < 300; i++) { flyer.vel[0] = 6; sys._physics(flyer, 1 / 120); }
  check('飞行单位不迈步', played.length === 0, `${played.length} 步`);
}

// ── 7. 房客不本地迈步
{
  const w = makeWorld();
  const sys = new EnemySystem(w, makeEnemyPlayer(), null, { particles: { emit() {}, emitBurst() {} } });
  sys.setReplicated(true);
  const e = sys.spawn('grunt', [0, 0.5, 0]);
  e.age = 5;
  played.length = 0;
  for (let i = 0; i < 300; i++) sys.update(1 / 120, makeEnemyPlayer());
  check('房客不本地迈步（以房主为准）', played.length === 0, `${played.length} 步`);
}

// ── 8. audioEnabled 可关闭（自测里避免刷事件）
{
  const w = makeWorld();
  const sys = new EnemySystem(w, makeEnemyPlayer(), null, { particles: { emit() {}, emitBurst() {} } });
  sys.audioEnabled = false;
  const e = sys.spawn('grunt', [0, 0.5, 0]);
  e.age = 5;
  played.length = 0;
  for (let i = 0; i < 300; i++) { e.vel[0] = 6; sys._physics(e, 1 / 120); }
  check('audioEnabled=false 时不发脚步事件', played.length === 0, `${played.length} 步`);
}

// ── 9. main.js 的事件转发必须把 rate 传给带位置的音效
{
  const main = readFileSync(join(root, 'src/main.js'), 'utf8');
  // 真实 bug：原写法 playAt(..., { gain: p.gain }) 漏了 rate，
  // 导致所有带位置的音效速率恒为 1，调用方传的 rate 被静默丢弃。
  const m = /if \(p\.pos\)\s*Audio\.playAt\([^)]*\)/.exec(main);
  check('带位置的音效转发包含 rate', !!m && /rate:\s*p\.rate/.test(m[0]),
    m ? m[0].slice(0, 72) : '未找到转发语句');
}

off();
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail > 0 ? 1 : 0;
