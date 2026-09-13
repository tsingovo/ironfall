// ==== fx/decals.js — 弹孔/灼痕贴花（环形缓冲池） ====
// 贴花是贴在表面上的薄四边形，沿表面法线偏移一点避免 z-fighting。
// 用环形缓冲覆盖最旧的，容量固定 => 零分配、零增长。

import { CFG } from '../core/config.js';
import * as M from '../core/math.js';

export class DecalSystem {
  constructor(engine, capacity) {
    this.engine = engine;
    this.capacity = capacity || CFG.fx.maxDecals;
    this.count = 0;
    this.head = 0;

    const n = this.capacity;
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.nx = new Float32Array(n);
    this.ny = new Float32Array(n);
    this.nz = new Float32Array(n);
    this.size = new Float32Array(n);
    this.rot = new Float32Array(n);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.cr = new Float32Array(n);
    this.cg = new Float32Array(n);
    this.cb = new Float32Array(n);

    this._mats = new Float32Array(16 * 256);
    this._cols = new Float32Array(4 * 256);
    this._rng = M.mulberry32(0xDECA1);
  }

  get aliveCount() { return this.count; }

  clear() { this.count = 0; this.head = 0; }

  /**
   * 加一个贴花。opts: { size, color, kind:'bullet'|'scorch'|'blood'|'shield' }
   */
  add(point, normal, opts) {
    if (!CFG.fx.impactDecals) return;
    const o = opts || {};
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;

    // 沿法线偏移，避免与表面共面
    this.px[i] = point[0] + normal[0] * 0.012;
    this.py[i] = point[1] + normal[1] * 0.012;
    this.pz[i] = point[2] + normal[2] * 0.012;
    this.nx[i] = normal[0]; this.ny[i] = normal[1]; this.nz[i] = normal[2];

    const kind = o.kind || 'bullet';
    let baseSize = 0.14;
    let col = [0.055, 0.05, 0.048];
    let life = 26;
    if (kind === 'scorch') { baseSize = 0.55; col = [0.045, 0.04, 0.038]; life = 30; }
    else if (kind === 'blood') { baseSize = 0.30; col = [0.20, 0.035, 0.03]; life = 18; }
    else if (kind === 'shield') { baseSize = 0.22; col = [0.18, 0.42, 0.62]; life = 4; }
    if (o.size != null) baseSize = o.size;
    if (o.color) col = o.color;

    this.size[i] = baseSize * (0.75 + this._rng() * 0.55);
    this.rot[i] = this._rng() * Math.PI * 2;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.cr[i] = col[0]; this.cg[i] = col[1]; this.cb[i] = col[2];
  }

  update(dt) {
    // 环形缓冲不压缩，只衰减寿命；过期的标记为 0 尺寸（渲染时跳过）
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] > 0) this.life[i] -= dt;
    }
  }

  render(engine, cameraForward) {
    if (this.count === 0) return;
    const e = engine;
    const mesh = e.userDecalMesh;
    if (!mesh) return;
    let n = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;
      if (n >= 256) break;
      const t = M.clamp01(this.life[i] / Math.max(0.001, this.maxLife[i]));
      // 最后 15% 淡出
      const fade = t < 0.15 ? t / 0.15 : 1;
      const sz = this.size[i] * (0.85 + 0.15 * fade);
      const nx = this.nx[i], ny = this.ny[i], nz = this.nz[i];
      // 构造切向基
      let ax = 0, ay = 1, az = 0;
      if (Math.abs(ny) > 0.95) { ax = 1; ay = 0; az = 0; }
      let tx = ay * nz - az * ny;
      let ty = az * nx - ax * nz;
      let tz = ax * ny - ay * nx;
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      const bx = ny * tz - nz * ty;
      const by = nz * tx - nx * tz;
      const bz = nx * ty - ny * tx;
      const c = Math.cos(this.rot[i]), s = Math.sin(this.rot[i]);
      const r0x = tx * c + bx * s, r0y = ty * c + by * s, r0z = tz * c + bz * s;
      const r1x = bx * c - tx * s, r1y = by * c - ty * s, r1z = bz * c - tz * s;
      const m = this._mats;
      const o = n * 16;
      m[o] = r0x * sz; m[o + 1] = r0y * sz; m[o + 2] = r0z * sz; m[o + 3] = 0;
      m[o + 4] = r1x * sz; m[o + 5] = r1y * sz; m[o + 6] = r1z * sz; m[o + 7] = 0;
      m[o + 8] = nx * 0.004; m[o + 9] = ny * 0.004; m[o + 10] = nz * 0.004; m[o + 11] = 0;
      m[o + 12] = this.px[i]; m[o + 13] = this.py[i]; m[o + 14] = this.pz[i]; m[o + 15] = 1;
      const co = n * 4;
      this._cols[co] = this.cr[i] * fade;
      this._cols[co + 1] = this.cg[i] * fade;
      this._cols[co + 2] = this.cb[i] * fade;
      this._cols[co + 3] = 1;
      n++;
    }
    if (n > 0) {
      e.drawInstanced(mesh, this._mats.subarray(0, n * 16), n, {
        colors: this._cols.subarray(0, n * 4),
        unlit: true,
        cull: false,
        depthWrite: false,
      });
    }
    void cameraForward;
  }

  debugState() {
    let live = 0;
    for (let i = 0; i < this.capacity; i++) if (this.life[i] > 0) live++;
    return { live, capacity: this.capacity, head: this.head };
  }
}

export default DecalSystem;
