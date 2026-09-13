// ==== fx/screenshake.js — 屏幕震动与 FOV 冲击 ====
// 用多个不同频率/相位的正弦叠加（trauma 模型），比纯随机更"有重量"且不会抖成噪点。
// 幅度按 trauma^2 衰减：小事件几乎无感，大事件非常暴力 —— 这是打击感的来源。

import { CFG } from '../core/config.js';
import * as M from '../core/math.js';

const FREQS = [
  // 轴索引, 频率, 相位, 权重
  { axis: 0, f: 27.3, p: 0.0, w: 1.0 },
  { axis: 1, f: 31.7, p: 1.7, w: 1.0 },
  { axis: 2, f: 23.1, p: 3.1, w: 0.8 },
  { axis: 0, f: 41.9, p: 2.2, w: 0.45 },
  { axis: 1, f: 37.3, p: 4.4, w: 0.45 },
  { axis: 2, f: 47.1, p: 0.9, w: 0.35 },
];

export class ScreenShake {
  constructor() {
    this.trauma = 0;
    this.traumaDecay = CFG.cam.shakeDecay;
    this.time = 0;
    this.offset = new Float32Array(3);
    this.rotation = new Float32Array(3);
    this.fovOffset = 0;
    this._fovKick = 0;
    this.maxOffset = 0.16;
    this.maxRotation = 0.045;
    this.maxFov = 7.5;
    this.enabled = true;
    this._seed = 0;
  }

  /**
   * 追加震动。amount 约 0..1（会被夹紧），time 为持续时间（用于调整衰减速度）。
   */
  add(amount, time, opts) {
    if (!this.enabled) return;
    const a = M.clamp01(amount) * CFG.fx.screenShakeScale;
    if (a <= 0) return;
    // 取最大值而非累加，避免连续开火把画面抖散
    this.trauma = Math.min(CFG.cam.shakeMax, Math.max(this.trauma, a * 0.55) + a * 0.45);
    const o = opts || {};
    if (o.freq) this.traumaDecay = o.freq;
    else if (time && time > 0) this.traumaDecay = 1 / Math.max(0.02, time) * 1.6;
    this._seed = (this._seed + 1) * 2654435761 % 4294967296;
  }

  /** FOV 冲击（开火/冲刺/爆炸） */
  kick(amount) {
    this._fovKick = Math.min(this.maxFov, this._fovKick + amount * CFG.fx.screenShakeScale);
  }

  update(dt) {
    this.time += dt;
    if (this.trauma > 0) {
      this.trauma = Math.max(0, this.trauma - this.traumaDecay * dt);
    }
    const t = this.time;
    const mag = this.trauma * this.trauma;   // 平方衰减：细腻的低幅度反馈
    const ox = Math.sin(t * 27.3) * 0.6 + Math.sin(t * 41.9 + 2.2) * 0.28;
    const oy = Math.sin(t * 31.7 + 1.7) * 0.6 + Math.sin(t * 37.3 + 4.4) * 0.28;
    const oz = Math.sin(t * 23.1 + 3.1) * 0.5 + Math.sin(t * 47.1 + 0.9) * 0.22;
    this.offset[0] = ox * mag * this.maxOffset;
    this.offset[1] = oy * mag * this.maxOffset;
    this.offset[2] = oz * mag * this.maxOffset * 0.5;

    // 旋转分量（滚转最明显）
    this.rotation[0] = oy * mag * this.maxRotation * 0.7;
    this.rotation[1] = ox * mag * this.maxRotation * 0.7;
    this.rotation[2] = (ox * 0.8 + oy * 0.4) * mag * this.maxRotation;

    // FOV 冲击指数回落
    this._fovKick = M.damp(this._fovKick, 0, 9, dt);
    this.fovOffset = this._fovKick;
  }

  reset() {
    this.trauma = 0;
    this.offset.fill(0);
    this.rotation.fill(0);
    this.fovOffset = 0;
    this._fovKick = 0;
  }

  debugState() {
    return {
      trauma: Math.round(this.trauma * 1000) / 1000,
      offset: [this.offset[0], this.offset[1], this.offset[2]].map((v) => Math.round(v * 1000) / 1000),
      fov: Math.round(this.fovOffset * 100) / 100,
    };
  }
}

export default ScreenShake;
void FREQS;
