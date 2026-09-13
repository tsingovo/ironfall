// ==== Titanfall 风格墙跑自检：沿切线稳定奔跑、保持高度后滑落、可主动离墙 ====
import { Player } from '../src/player.js';
import { CFG } from '../src/core/config.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? `  (${detail})` : ''}`); }
}

// 玩家右侧 x=0.6 有一面无限竖直墙，法线朝玩家（-X）。
const world = {
  raycast(_origin, dir) {
    return dir[0] > 0.45
      ? { hit: true, t: 0.25, normal: new Float32Array([-1, 0, 0]), point: new Float32Array([0.6, 2, 0]) }
      : { hit: false, t: Infinity, normal: new Float32Array([0, 1, 0]), point: new Float32Array(3) };
  },
};

const p = new Player(world, null, {});
p.pos.set([0, 2, 0]);
p.vel.set([0.4, -3.5, -8.5]);
p.state.grounded = false;
p.updateBasis();
p.updateCamera(0);
const moveInput = { moveX: 0, moveY: 1, jump: false, jumpPressed: false, crouchPressed: false };

check('高速掠过侧墙可自动进入墙跑', p._tryStartWallRun(p.mods.move, moveInput));
check('墙跑方向继承入墙前进动量', p._wallRunDir[2] < -0.9, `dirZ=${p._wallRunDir[2].toFixed(2)}`);
const startSpeed = Math.hypot(p.vel[0], p.vel[2]);
const startVy = p.vel[1];
for (let i = 0; i < 30; i++) p._moveWallRun(1 / 120, moveInput, p.mods.move);
const holdSpeed = Math.hypot(p.vel[0], p.vel[2]);
check('墙跑沿墙切线前进而不是顶墙/反向', p.vel[2] < -startSpeed && Math.abs(p.vel[0]) < holdSpeed * 0.45,
  `vx=${p.vel[0].toFixed(2)} vz=${p.vel[2].toFixed(2)}`);
check('墙跑会快速进入更高稳定速度', holdSpeed > startSpeed + 0.8,
  `${startSpeed.toFixed(2)} → ${holdSpeed.toFixed(2)}m/s`);
check('接墙前段把下坠速度拉回稳定高度', p.vel[1] > 0.15 && p.vel[1] > startVy + 0.5,
  `vy ${startVy.toFixed(2)} → ${p.vel[1].toFixed(2)}`);
check('墙跑具有明确相机侧倾', Math.abs(p.roll) > 0.08, `roll=${p.roll.toFixed(3)}`);

// 进入末段后应逐渐滑落，不能永远悬浮。
for (let i = 0; i < 150 && p.state.wallRunning; i++) p._moveWallRun(1 / 120, moveInput, p.mods.move);
check('墙跑后段逐渐下坠', p.vel[1] < -0.8, `vy=${p.vel[1].toFixed(2)}`);

// 重开后验证短暂松键容错及最终主动离墙。
p.vel.set([0, 0, -9]);
p.state.wallRunning = false;
p.t.wallRunCooldown = 0;
p.t.wallJumpLockout = 0;
p._tryStartWallRun(p.mods.move, moveInput);
const noInput = { ...moveInput, moveY: 0 };
p._moveWallRun(CFG.move.wallRunInputGrace * 0.5, noInput, p.mods.move);
check('短暂松开方向键不会立刻断墙跑', p.state.wallRunning);
p._moveWallRun(CFG.move.wallRunInputGrace * 0.65, noInput, p.mods.move);
check('持续松开方向键会主动离墙', !p.state.wallRunning);

// 面向前方、墙在侧面时，按住跳不应被墙爬抢走墙跑输入。
p.state.wallRunning = false;
p.t.wallClimbTime = CFG.move.wallClimbTime;
check('侧墙前进不会误触发垂直墙爬', !p._updateWallClimb(1 / 120,
  { ...moveInput, jump: true, moveY: 1 }, p.mods.move));

console.log(`\nWALLRUN SELF-TEST: ${pass}/${pass + fail} passed`);
if (fail) process.exitCode = 1;
