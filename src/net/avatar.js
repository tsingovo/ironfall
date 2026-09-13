// ==== net/avatar.js — 第三人称队友模型（批量实例绘制）====
//
// player-model.js 只画第一人称的下半身；联机时必须看到队友的完整人形，
// 因此这里单独建一套全身低模。所有队友的所有部件合批成一次 drawInstanced，
// 3 名队友也只有 3 个 draw call（立方体/球体各一个批次）。
//
// 局部坐标约定与 player-model.js 一致：脚底为原点，-Z 为角色正前方，yaw 绕 Y 轴。

import * as M from '../core/math.js';

const MAX_REMOTE = 4;
const PARTS_PER_BODY = 21;

/**
 * 身体部件表。pos 为“站立时”相对脚底的局部偏移。
 * swing 表示部件是否参与走路摆动；side 为 -1 左 / +1 右 / 0 中。
 */
const PARTS = [
  { name: 'hips', pos: [0, 0.90, 0], size: [0.34, 0.24, 0.24], color: [0.12, 0.15, 0.19] },
  { name: 'torso', pos: [0, 1.18, 0], size: [0.40, 0.40, 0.26], color: [0.17, 0.21, 0.27] },
  { name: 'plate', pos: [0, 1.22, -0.15], size: [0.30, 0.26, 0.06], color: [0.22, 0.30, 0.38], accent: 1 },
  { name: 'neck', pos: [0, 1.40, 0], size: [0.12, 0.10, 0.12], color: [0.10, 0.13, 0.16] },
  { name: 'head', pos: [0, 1.55, 0], size: [0.24, 0.24, 0.26], color: [0.19, 0.24, 0.30] },
  { name: 'visor', pos: [0, 1.57, -0.13], size: [0.20, 0.09, 0.05], color: [0.28, 0.78, 1.0], accent: 2 },
  { name: 'pack', pos: [0, 1.22, 0.19], size: [0.28, 0.34, 0.14], color: [0.13, 0.17, 0.22], accent: 1 },
  { name: 'shoulderL', pos: [-0.27, 1.34, 0], size: [0.17, 0.16, 0.21], color: [0.21, 0.27, 0.33], side: -1 },
  { name: 'shoulderR', pos: [0.27, 1.34, 0], size: [0.17, 0.16, 0.21], color: [0.21, 0.27, 0.33], side: 1 },
  { name: 'upperArmL', pos: [-0.28, 1.13, -0.02], size: [0.13, 0.28, 0.14], color: [0.15, 0.19, 0.24], side: -1, swing: -1, arm: 1 },
  { name: 'upperArmR', pos: [0.28, 1.13, -0.02], size: [0.13, 0.28, 0.14], color: [0.15, 0.19, 0.24], side: 1, swing: 1, arm: 1 },
  { name: 'forearmL', pos: [-0.28, 0.93, -0.10], size: [0.12, 0.26, 0.13], color: [0.13, 0.17, 0.21], side: -1, arm: 1 },
  { name: 'forearmR', pos: [0.28, 0.93, -0.10], size: [0.12, 0.26, 0.13], color: [0.13, 0.17, 0.21], side: 1, arm: 1 },
  { name: 'handL', pos: [-0.28, 0.79, -0.16], size: [0.11, 0.11, 0.13], color: [0.09, 0.11, 0.14], side: -1, arm: 1 },
  { name: 'handR', pos: [0.28, 0.79, -0.16], size: [0.11, 0.11, 0.13], color: [0.09, 0.11, 0.14], side: 1, arm: 1 },
  { name: 'thighL', pos: [-0.11, 0.65, 0], size: [0.16, 0.34, 0.19], color: [0.13, 0.16, 0.20], side: -1, swing: -1 },
  { name: 'thighR', pos: [0.11, 0.65, 0], size: [0.16, 0.34, 0.19], color: [0.13, 0.16, 0.20], side: 1, swing: 1 },
  { name: 'shinL', pos: [-0.11, 0.33, 0], size: [0.14, 0.32, 0.16], color: [0.10, 0.13, 0.17], side: -1, swing: -1, lower: 1 },
  { name: 'shinR', pos: [0.11, 0.33, 0], size: [0.14, 0.32, 0.16], color: [0.10, 0.13, 0.17], side: 1, swing: 1, lower: 1 },
  { name: 'bootL', pos: [-0.11, 0.07, -0.05], size: [0.17, 0.14, 0.28], color: [0.06, 0.08, 0.10], side: -1, swing: -1, lower: 1 },
  { name: 'bootR', pos: [0.11, 0.07, -0.05], size: [0.17, 0.14, 0.28], color: [0.06, 0.08, 0.10], side: 1, swing: 1, lower: 1 },
];

/** 队伍配色：默认青蓝，便于与琥珀色敌人区分 */
export const TEAM_COLORS = Object.freeze({
  armor: [0.16, 0.20, 0.26],
  accent: [0.20, 0.62, 0.86],
  visor: [0.35, 0.88, 1.0],
  dead: [0.09, 0.10, 0.12],
});

export class AvatarRenderer {
  constructor(engine) {
    this.engine = engine;
    this.enabled = true;
    this._mats = new Float32Array(MAX_REMOTE * PARTS_PER_BODY * 16);
    this._cols = new Float32Array(MAX_REMOTE * PARTS_PER_BODY * 4);
    this._drawCount = 0;
    this._bodyCount = 0;
    this._phase = new Float32Array(MAX_REMOTE);
    this._pos = new Float32Array(3);
  }

  /**
   * 提交一帧所有远程玩家。
   * @param {object} engine
   * @param {Array} players 远程玩家记录（需含 pos/yaw/alive/state/height）
   * @param {number} dt
   */
  render(engine, players, dt = 0) {
    const e = engine || this.engine;
    if (!this.enabled || !e || !e.sharedMeshes || !players || players.length === 0) {
      this._drawCount = 0;
      this._bodyCount = 0;
      return 0;
    }
    const mesh = e.sharedMeshes.cube;
    if (!mesh) return 0;

    const mats = this._mats;
    const cols = this._cols;
    let n = 0;
    let bodies = 0;

    for (let pi = 0; pi < players.length && pi < MAX_REMOTE; pi++) {
      const p = players[pi];
      if (!p || !p.pos) continue;
      const alive = p.alive !== false;
      const speed = p.state && Number.isFinite(p.state.hspeed) ? p.state.hspeed : 0;
      const grounded = !p.state || p.state.grounded !== false;

      // 走路相位：与 player-model 同一思路，速度越快步频越高
      if (alive && grounded && speed > 0.5) {
        this._phase[pi] += dt * (5.0 + Math.min(10, speed) * 0.42);
      } else if (alive) {
        this._phase[pi] += dt * 1.2;
      }
      const swingBase = Math.sin(this._phase[pi]) * Math.min(0.42, 0.06 + speed * 0.03);
      const airborne = alive && !grounded;
      const sliding = !!(p.state && p.state.sliding);
      const crouching = !!(p.state && p.state.crouching);
      const yaw = Number.isFinite(p.yaw) ? p.yaw : 0;

      // 死亡姿态：整体下沉并前倾，作为明确的“倒地”读法
      const baseY = p.pos[1] - (crouching ? 0.20 : 0) - (sliding ? 0.34 : 0);
      const bodyRoll = sliding ? -0.16 : 0;
      const bodyPitch = alive ? 0 : -1.35;
      const bodyY = alive ? baseY : p.pos[1] + 0.35;

      for (let k = 0; k < PARTS.length; k++) {
        const part = PARTS[k];
        let lx = part.pos[0];
        let ly = part.pos[1];
        let lz = part.pos[2];
        let pitch = 0;
        let roll = bodyRoll;

        if (part.swing) {
          pitch = swingBase * part.swing;
          if (airborne) pitch = part.swing < 0 ? -0.40 : 0.26;
          if (sliding) pitch = part.swing < 0 ? -0.62 : 0.40;
          if (part.lower) pitch *= 0.55;
          if (!alive) pitch = 0.25 * part.swing;
        }
        if (part.arm && alive && !sliding) {
          // 持枪姿态：手臂前伸并轻微内收
          pitch += -1.05;
          lz += -0.18;
          lx *= 0.78;
        }

        const co = Math.cos(yaw), sy = Math.sin(yaw);
        const wx = p.pos[0] + lx * co + lz * sy;
        const wz = p.pos[2] - lx * sy + lz * co;
        const shrink = sliding && part.lower ? 0.82 : 1;
        this._pos[0] = wx;
        this._pos[1] = bodyY + ly;
        this._pos[2] = wz;
        M.m4Compose(this._pos, yaw, bodyPitch + pitch, roll,
          [part.size[0], part.size[1] * shrink, part.size[2]], mats.subarray(n * 16, n * 16 + 16));

        // 颜色：护甲基色 + 队伍强调色；死亡后整体压暗
        let cr;
        let cg;
        let cb;
        if (part.accent === 2) {
          cr = TEAM_COLORS.visor[0]; cg = TEAM_COLORS.visor[1]; cb = TEAM_COLORS.visor[2];
        } else if (part.accent) {
          cr = TEAM_COLORS.accent[0]; cg = TEAM_COLORS.accent[1]; cb = TEAM_COLORS.accent[2];
        } else {
          cr = part.color[0]; cg = part.color[1]; cb = part.color[2];
        }
        // 受击闪白（由网络层写入 hitFlash）
        const flash = M.clamp01(p.hitFlash || 0);
        if (!alive) {
          cr = cr * 0.42 + TEAM_COLORS.dead[0];
          cg = cg * 0.42 + TEAM_COLORS.dead[1];
          cb = cb * 0.42 + TEAM_COLORS.dead[2];
        }
        const co4 = n * 4;
        cols[co4] = Math.min(1, cr + flash * 0.85);
        cols[co4 + 1] = Math.min(1, cg + flash * 0.85);
        cols[co4 + 2] = Math.min(1, cb + flash * 0.85);
        cols[co4 + 3] = 1;
        n++;
      }
      bodies++;
    }

    this._drawCount = n;
    this._bodyCount = bodies;
    if (n > 0) {
      e.drawInstanced(mesh, mats.subarray(0, n * 16), n, {
        colors: cols.subarray(0, n * 4),
        cull: false,
      });
    }
    return n;
  }

  debugState() {
    return { enabled: this.enabled, bodies: this._bodyCount, instances: this._drawCount };
  }
}

export default AvatarRenderer;
