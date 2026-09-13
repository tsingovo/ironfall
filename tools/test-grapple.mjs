// ==== 双向抓钩自检：命中敌人后双方相向移动，且质量分配/断钩状态正确 ====
import { Player } from '../src/player.js';
import { EnemySystem } from '../src/enemies.js';
import { CFG } from '../src/core/config.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? `  (${detail})` : ''}`); }
}

const world = {};
const player = new Player(world, null, {});
const enemies = new EnemySystem(world, player, null, {});
const enemy = enemies.spawn('grunt', [0, 0, -12]);

player.pos[0] = 0; player.pos[1] = 0; player.pos[2] = 0;
player.vel.fill(0);
player.updateCamera(0);
player.grapple.active = true;
player.grapple.attachedEnemy = enemy;
player.grapple.point.set(enemy.pos);
player.grapple.distance = 12;
player.grapple.offAimTime = 0;

const input = { grapplePressed: false, crouchPressed: false };
const dt = 1 / 120;
const startPlayerZ = player.pos[2];
const startEnemyZ = enemy.pos[2];
let minDistance = 12;

for (let i = 0; i < 54 && player.grapple.active; i++) {
  player._updateGrapple(dt, input, player.mods.move);
  const extraCap = enemies._applyGrapplePull(enemy, dt, player);
  // 本测试只隔离验证绳索力；抵消 Player._updateGrapple 中为实际重力准备的补偿项。
  player.vel[1] -= CFG.move.gravity * 0.62 * dt;
  player.pos[0] += player.vel[0] * dt;
  player.pos[1] += player.vel[1] * dt;
  player.pos[2] += player.vel[2] * dt;
  enemy.pos[0] += enemy.vel[0] * dt;
  enemy.pos[1] += enemy.vel[1] * dt;
  enemy.pos[2] += enemy.vel[2] * dt;
  enemy.grapplePull.pending = false;
  const d = Math.hypot(enemy.pos[0] - player.pos[0], enemy.pos[1] - player.pos[1], enemy.pos[2] - player.pos[2]);
  minDistance = Math.min(minDistance, d);
  check('敌人牵引速度上限高于普通巡逻上限', extraCap >= enemy.type.speed * 1.35, extraCap.toFixed(2));
  // 此项只需在第一帧确认，避免把循环内断钩后的 0 重复计为失败。
  break;
}

// 继续推进，不重复输出检查。
for (let i = 1; i < 54 && player.grapple.active; i++) {
  player._updateGrapple(dt, input, player.mods.move);
  enemies._applyGrapplePull(enemy, dt, player);
  player.vel[1] -= CFG.move.gravity * 0.62 * dt;
  player.pos[0] += player.vel[0] * dt;
  player.pos[1] += player.vel[1] * dt;
  player.pos[2] += player.vel[2] * dt;
  enemy.pos[0] += enemy.vel[0] * dt;
  enemy.pos[1] += enemy.vel[1] * dt;
  enemy.pos[2] += enemy.vel[2] * dt;
  enemy.grapplePull.pending = false;
  minDistance = Math.min(minDistance, Math.hypot(
    enemy.pos[0] - player.pos[0], enemy.pos[1] - player.pos[1], enemy.pos[2] - player.pos[2]));
}

check('玩家朝敌人移动', player.pos[2] < startPlayerZ - 0.15,
  `z ${startPlayerZ.toFixed(2)} → ${player.pos[2].toFixed(2)}`);
check('敌人同时朝玩家移动', enemy.pos[2] > startEnemyZ + 0.15,
  `z ${startEnemyZ.toFixed(2)} → ${enemy.pos[2].toFixed(2)}`);
check('双方距离明显缩短', minDistance < 10,
  `12.00m → ${minDistance.toFixed(2)}m`);
check('普通敌人按 55/45 分配牵引', Math.abs(enemy.grapplePull.targetSpeed - CFG.move.grapplePull * 0.45) < 0.01,
  `敌人目标速度 ${enemy.grapplePull.targetSpeed.toFixed(2)}m/s`);

player._releaseGrapple();
check('断钩会清除敌人牵引请求', enemy.grapplePull.pending === false && enemy.grapplePull.source === null);

console.log(`\nGRAPPLE SELF-TEST: ${pass}/${pass + fail} passed`);
if (fail) process.exitCode = 1;
