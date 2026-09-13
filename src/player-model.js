// ==== player-model.js — 第一人称下半身模型 ====
// 枪械 viewmodel 负责分段手臂；这里仅绘制低于相机的骨盆、腿和靴子。
// 不绘制头/胸是刻意设计：第一人称相机位于头部，完整上身会产生镜头穿模黑屏。

import * as M from './core/math.js';

const PARTS = [
  { name: 'belt', shape: 'cube', pos: [0, 0.73, 0.02], size: [0.42, 0.13, 0.27], color: [0.055, 0.075, 0.095] },
  { name: 'hipL', shape: 'cube', pos: [-0.12, 0.60, 0], size: [0.18, 0.24, 0.22], color: [0.13, 0.17, 0.21] },
  { name: 'hipR', shape: 'cube', pos: [0.12, 0.60, 0], size: [0.18, 0.24, 0.22], color: [0.13, 0.17, 0.21] },
  { name: 'thighL', shape: 'cube', pos: [-0.12, 0.43, 0], size: [0.17, 0.34, 0.20], color: [0.11, 0.15, 0.19], leg: -1 },
  { name: 'thighR', shape: 'cube', pos: [0.12, 0.43, 0], size: [0.17, 0.34, 0.20], color: [0.11, 0.15, 0.19], leg: 1 },
  { name: 'kneeL', shape: 'cube', pos: [-0.12, 0.27, -0.035], size: [0.19, 0.13, 0.12], color: [0.18, 0.29, 0.38], accent: true, leg: -1 },
  { name: 'kneeR', shape: 'cube', pos: [0.12, 0.27, -0.035], size: [0.19, 0.13, 0.12], color: [0.18, 0.29, 0.38], accent: true, leg: 1 },
  { name: 'shinL', shape: 'cube', pos: [-0.12, 0.14, 0], size: [0.15, 0.28, 0.17], color: [0.075, 0.10, 0.13], leg: -1 },
  { name: 'shinR', shape: 'cube', pos: [0.12, 0.14, 0], size: [0.15, 0.28, 0.17], color: [0.075, 0.10, 0.13], leg: 1 },
  { name: 'bootL', shape: 'cube', pos: [-0.12, 0.055, -0.075], size: [0.19, 0.11, 0.31], color: [0.035, 0.045, 0.055], leg: -1 },
  { name: 'bootR', shape: 'cube', pos: [0.12, 0.055, -0.075], size: [0.19, 0.11, 0.31], color: [0.035, 0.045, 0.055], leg: 1 },
];

export class PlayerModelRenderer {
  constructor(engine, player) {
    this.engine = engine;
    this.player = player;
    this.phase = 0;
    this._m = new Float32Array(16);
  }

  render(engine, dt = 0) {
    const p = this.player;
    const e = engine || this.engine;
    if (!p || !p.alive || !e || !e.sharedMeshes) return;
    const speed = p.state && Number.isFinite(p.state.hspeed) ? p.state.hspeed : 0;
    if (p.state && p.state.grounded && speed > 0.5) this.phase += dt * (5.4 + Math.min(10, speed) * 0.38);
    const swingBase = Math.sin(this.phase) * Math.min(0.34, speed * 0.024);
    const crouch = p.state && p.state.crouching ? 1 : 0;
    const slide = p.state && p.state.sliding ? 1 : 0;
    const airborne = p.state && !p.state.grounded ? 1 : 0;
    const cy = p.pos[1] - crouch * 0.22 - slide * 0.38;
    const yaw = p.yaw || 0;
    const sy = Math.sin(yaw), co = Math.cos(yaw);

    for (const part of PARTS) {
      let lx = part.pos[0];
      let ly = part.pos[1];
      let lz = part.pos[2];
      let pitch = 0;
      if (part.leg) {
        pitch = swingBase * part.leg;
        if (airborne) pitch = part.leg < 0 ? -0.42 : 0.28;
        if (slide) { pitch = part.leg < 0 ? -0.68 : 0.46; lz += part.leg < 0 ? -0.15 : 0.10; }
      }
      const wx = p.pos[0] + lx * co + lz * sy;
      const wz = p.pos[2] - lx * sy + lz * co;
      const scale = [part.size[0], part.size[1] * (slide ? 0.82 : 1), part.size[2]];
      M.m4Compose([wx, cy + ly, wz], yaw, pitch, slide ? -0.12 : 0, scale, this._m);
      const mesh = part.shape === 'sphere' ? e.sharedMeshes.sphere : e.sharedMeshes.cube;
      if (mesh) e.drawInstanced(mesh, this._m, 1, {
        color: part.color, emissive: part.accent ? 0.12 : 0, cull: false,
      });
    }
  }
}

