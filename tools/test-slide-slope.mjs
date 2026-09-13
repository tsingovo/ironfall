// ==== 滑铲坡面自检：真实下坡方向、切面速度、坡折余量与贴地 ====
import { Player } from '../src/player.js';
import { CFG } from '../src/core/config.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? `  (${detail})` : ''}`); }
}

const noopInput = { moveX: 0, moveY: 0, jump: false, jumpPressed: false, crouch: true };
const bareWorld = { groundNormal: (_x, _z, out) => out };

// h(z)=0.5z 时法线约为 [0,.894,-.447]，最陡下坡是 -Z（与法线 XZ 同向）。
const p = new Player(bareWorld, null, {});
p.state.sliding = true;
p.state.grounded = true;
p.state.groundNormal.set([0, 0.894427, -0.447214]);
p.vel.set([0, 0, -10]);
bareWorld.groundNormal = (_x, _z, out) => { out.set([0, 0.894427, -0.447214]); return out; };
check('坡度符号把 -Z 正确识别为下坡', p._slopeAlongVelocity() > 0);
p._moveSlide(1 / 60, noopInput, p.mods.move);
const tangentDot = p.vel[0] * p.state.groundNormal[0]
  + p.vel[1] * p.state.groundNormal[1] + p.vel[2] * p.state.groundNormal[2];
check('下坡速度投影到真实坡面切面', Math.abs(tangentDot) < 1e-4, `dot=${tangentDot.toFixed(5)}`);
const slopeSpeed = Math.hypot(p.vel[0], p.vel[2]);
check('贴地滑铲不额外施加压地负Y重力', p.vel[1] < 0 && p.vel[1] > -8,
  `vy=${p.vel[1].toFixed(2)}`);

// 平地只能受摩擦，不能凭坡面逻辑重复加速；启动时的一次小加速另由 _startSlide 负责。
const flat = new Player(bareWorld, null, {});
flat.state.sliding = true;
flat.state.grounded = true;
flat.state.groundNormal.set([0, 1, 0]);
flat.vel.set([0, 0, -10]);
flat._moveSlide(1 / 60, noopInput, flat.mods.move);
check('助推沿真实最陡下坡方向', slopeSpeed > Math.hypot(flat.vel[0], flat.vel[2]),
  `slope=${slopeSpeed.toFixed(2)} flat=${Math.hypot(flat.vel[0], flat.vel[2]).toFixed(2)}`);
check('平地滑铲持续衰减而非无限加速', Math.hypot(flat.vel[0], flat.vel[2]) < 10);
check('平地贴地垂直速度为零', Math.abs(flat.vel[1]) < 1e-6);

const starter = new Player(bareWorld, null, {});
starter.vel.set([0, 0, -8]);
starter._startSlide(starter.mods.move);
check('达到门槛后的滑铲保留一次有上限小加速', Math.hypot(starter.vel[0], starter.vel[2]) > 8
  && Math.hypot(starter.vel[0], starter.vel[2]) <= 8 + CFG.move.slideBoost + 1e-5);

// 首次 sweep 模拟命中下降坡折，第二次必须继续消费投影后的剩余位移。
let sweeps = 0;
let requestedProbe = 0;
const foldWorld = {
  groundNormal(_x, _z, out) { out.set([0, 1, 0]); return out; },
  sweepSphere(_center, _radius, delta) {
    sweeps++;
    if (sweeps === 1) {
      return { hit: true, t: Math.hypot(...delta) * 0.28,
        normal: new Float32Array([0, 0.8, 0.6]) };
    }
    return { hit: false, t: Infinity, normal: new Float32Array([0, 1, 0]) };
  },
  resolveCapsule() {
    return { grounded: false, contacts: 0, groundNormal: new Float32Array([0, 1, 0]) };
  },
  enforceCapsuleValidity() {},
  probeGround(_pos, _r, _h, maxDist) {
    requestedProbe = maxDist;
    return { grounded: true, distance: 0.31, groundNormal: new Float32Array([0, 0.94, 0.342]) };
  },
};
const fold = new Player(foldWorld, null, {});
fold.state.sliding = true;
fold.state.grounded = true;
fold.pos.set([0, 1, 0]);
fold.vel.set([12, -2, 0]);
fold._integrate(0.1, false);
check('滑铲命中坡折后执行第二段扫掠', sweeps === 2, `sweeps=${sweeps}`);
check('坡折后继续消费切向位移而非卡在首碰撞点', fold.pos[0] > 0.8, `x=${fold.pos[0].toFixed(2)}`);
check('滑铲使用加大的向下贴地探测距离', requestedProbe >= CFG.move.slideGroundSnapDist,
  `probe=${requestedProbe.toFixed(2)}`);
check('坡折探测成功后向下吸附地面', fold.pos[1] < 0.95, `y=${fold.pos[1].toFixed(2)}`);

console.log(`\nSLIDE SLOPE SELF-TEST: ${pass}/${pass + fail} passed`);
if (fail) process.exitCode = 1;
