// ==== fx/particles.js — 池化粒子系统（零 GC 热路径） ====
// 存储为 SoA（结构体数组拆开），每帧只做原地压缩（swap-remove），不分配任何对象。
// 渲染按"形状"分组：
//   * spark / debris：沿速度方向拉伸的发光盒体（速度感强）
//   * smoke / dust / blood：相机朝向的公告板
//   * ring：地面/墙面上的扩散圆盘（冲击波）
// 单次 drawInstanced 提交全部同类粒子。

import { CFG } from '../core/config.js';
import * as M from '../core/math.js';

// 粒子种类参数表：kind -> { drag, gravity, life, size, sizeEnd, kindOf:'stretch'|'billboard'|'ring', spin }
//
// 烟雾类尺寸说明（用户反馈「击中和跑动的烟雾太大，请调小很多很多」）：
//   原值：smoke 0.35→1.5m、dust 0.28→1.05m、explosion 0.55→2.6m、muzzleSmoke 0.16→0.85m。
//   问题在于击中与落地时烟雾正好在准心前方炸开，一大团直接糊住视野、影响索敌。
//   现在整体缩到约 1/4，并略微降低 alpha：保留「有烟」的反馈，但不挡视线。
//   ⚠️ 调用处的 size / sizeEnd 覆盖值会盖掉这张表，所以 emitImpact 与各 emit 点
//   也必须按同一比例改，只改这里是不够的。
const KINDS = {
  spark: { drag: 1.6, gravity: 12, life: 0.42, size: 0.055, sizeEnd: 0.008, shape: 'stretch', alpha: 1 },
  sparkHeavy: { drag: 1.1, gravity: 16, life: 0.7, size: 0.09, sizeEnd: 0.012, shape: 'stretch', alpha: 1 },
  debris: { drag: 1.2, gravity: 22, life: 1.3, size: 0.11, sizeEnd: 0.06, shape: 'stretch', alpha: 1 },
  smoke: { drag: 1.4, gravity: -1.4, life: 1.5, size: 0.09, sizeEnd: 0.36, shape: 'billboard', alpha: 0.32 },
  dust: { drag: 1.9, gravity: -0.7, life: 1.1, size: 0.07, sizeEnd: 0.26, shape: 'billboard', alpha: 0.24 },
  blood: { drag: 1.5, gravity: 16, life: 0.65, size: 0.14, sizeEnd: 0.05, shape: 'billboard', alpha: 0.9 },
  bloodMist: { drag: 2.4, gravity: 2.0, life: 0.45, size: 0.09, sizeEnd: 0.18, shape: 'billboard', alpha: 0.32 },
  shield: { drag: 2.2, gravity: 3, life: 0.4, size: 0.16, sizeEnd: 0.02, shape: 'stretch', alpha: 1 },
  shieldHit: { drag: 3.0, gravity: 0, life: 0.28, size: 0.1, sizeEnd: 0.02, shape: 'stretch', alpha: 1 },
  muzzle: { drag: 4.0, gravity: 3, life: 0.16, size: 0.14, sizeEnd: 0.03, shape: 'stretch', alpha: 1 },
  ring: { drag: 0, gravity: 0, life: 0.4, size: 0.6, sizeEnd: 4.6, shape: 'ring', alpha: 0.85 },
  ringSmall: { drag: 0, gravity: 0, life: 0.26, size: 0.25, sizeEnd: 1.5, shape: 'ring', alpha: 0.7 },
  explosion: { drag: 2.6, gravity: 4, life: 0.55, size: 0.16, sizeEnd: 0.7, shape: 'billboard', alpha: 0.72 },
  muzzleSmoke: { drag: 1.6, gravity: -1.2, life: 1.0, size: 0.05, sizeEnd: 0.22, shape: 'billboard', alpha: 0.18 },
  trail: { drag: 0.9, gravity: 0, life: 0.5, size: 0.1, sizeEnd: 0.02, shape: 'stretch', alpha: 0.7 },
  energy: { drag: 2.8, gravity: 0, life: 0.5, size: 0.09, sizeEnd: 0.01, shape: 'stretch', alpha: 1 },
  scorch: { drag: 3.2, gravity: 5, life: 0.9, size: 0.2, sizeEnd: 0.02, shape: 'stretch', alpha: 1 },
};

const SHAPES = ['stretch', 'billboard', 'ring'];

export class ParticleSystem {
  constructor(engine, capacity) {
    this.engine = engine;
    this.capacity = capacity || CFG.fx.maxParticles;
    this.count = 0;

    const n = this.capacity;
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.size = new Float32Array(n);
    this.sizeEnd = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.gravity = new Float32Array(n);
    this.rot = new Float32Array(n);
    this.spin = new Float32Array(n);
    this.kindShape = new Uint8Array(n);      // 0 stretch 1 billboard 2 ring
    this.kindId = new Uint8Array(n);         // 索引到 KIND_LIST
    this.cr = new Float32Array(n);
    this.cg = new Float32Array(n);
    this.cb = new Float32Array(n);
    this.nx = new Float32Array(n);           // ring 的法线
    this.ny = new Float32Array(n);
    this.nz = new Float32Array(n);

    this._kinds = Object.keys(KINDS);
    this._mats = new Float32Array(16 * 1024);
    this._cols = new Float32Array(4 * 1024);
    this._rng = M.mulberry32(0x5EED);
    this._alive = 0;
  }

  get aliveCount() { return this.count; }

  clear() { this.count = 0; }

  /**
   * 发射粒子。opts:
   * { pos, dir, speed, spread(度), count, color, size, life, gravity, drag, alpha, kind, normal }
   */
  emit(kind, opts) {
    const o = opts || {};
    const k = KINDS[kind] || KINDS.spark;
    const kid = this._kinds.indexOf(kind) >= 0 ? this._kinds.indexOf(kind) : 0;
    const count = o.count == null ? 1 : Math.max(0, o.count | 0);
    const pos = o.pos || ZERO;
    const dir = o.dir;
    const speed = o.speed == null ? 6 : o.speed;
    const spread = M.toRad(o.spread == null ? 25 : o.spread);
    const rng = this._rng;

    for (let c = 0; c < count; c++) {
      if (this.count >= this.capacity) {
        // 满了就覆盖最老的（swap 掉索引 0）
        this._removeAt(0);
      }
      const i = this.count++;
      this.px[i] = pos[0] + (rng() - 0.5) * (o.jitter || 0);
      this.py[i] = pos[1] + (rng() - 0.5) * (o.jitter || 0);
      this.pz[i] = pos[2] + (rng() - 0.5) * (o.jitter || 0);

      let dx, dy, dz;
      if (dir) {
        if (spread > 1e-4) {
          M.randomConeDir(dir, spread, rng, SPREAD_DIR);
          dx = SPREAD_DIR[0]; dy = SPREAD_DIR[1]; dz = SPREAD_DIR[2];
        } else { dx = dir[0]; dy = dir[1]; dz = dir[2]; }
      } else {
        // 全方向
        const theta = rng() * Math.PI * 2;
        const z = rng() * 2 - 1;
        const r = Math.sqrt(Math.max(0, 1 - z * z));
        dx = Math.cos(theta) * r; dy = z; dz = Math.sin(theta) * r;
      }
      const sp = speed * (0.55 + rng() * 0.9) * (o.speedMul || 1);
      this.vx[i] = dx * sp;
      this.vy[i] = dy * sp + (o.upBias || 0) * rng();
      this.vz[i] = dz * sp;

      const life = (o.life == null ? k.life : o.life) * (0.75 + rng() * 0.5);
      this.life[i] = life;
      this.maxLife[i] = life;
      const sz = (o.size == null ? k.size : o.size) * (0.7 + rng() * 0.6);
      this.size[i] = sz;
      this.sizeEnd[i] = (o.sizeEnd == null ? k.sizeEnd : o.sizeEnd) * (0.7 + rng() * 0.6);
      this.alpha[i] = o.alpha == null ? k.alpha : o.alpha;
      this.drag[i] = o.drag == null ? k.drag : o.drag;
      this.gravity[i] = o.gravity == null ? k.gravity : o.gravity;
      this.rot[i] = rng() * Math.PI * 2;
      this.spin[i] = (rng() - 0.5) * (o.spin == null ? 6 : o.spin);
      this.kindShape[i] = k.shape === 'stretch' ? 0 : (k.shape === 'billboard' ? 1 : 2);
      this.kindId[i] = kid;
      const col = o.color || (k.shape === 'ring' ? CFG.fx.sparkColor : CFG.fx.sparkColor);
      const jitterC = o.colorJitter || 0;
      this.cr[i] = M.clamp01(col[0] + (rng() - 0.5) * jitterC);
      this.cg[i] = M.clamp01(col[1] + (rng() - 0.5) * jitterC);
      this.cb[i] = M.clamp01(col[2] + (rng() - 0.5) * jitterC);
      const nrm = o.normal;
      if (nrm) {
        this.nx[i] = nrm[0]; this.ny[i] = nrm[1]; this.nz[i] = nrm[2];
      } else {
        this.nx[i] = 0; this.ny[i] = 1; this.nz[i] = 0;
      }
    }
    return count;
  }

  /** 移除索引 i 的粒子（把最后一个搬过来，O(1) 且不分配） */
  _removeAt(i) {
    const last = this.count - 1;
    if (i !== last) {
      this.px[i] = this.px[last]; this.py[i] = this.py[last]; this.pz[i] = this.pz[last];
      this.vx[i] = this.vx[last]; this.vy[i] = this.vy[last]; this.vz[i] = this.vz[last];
      this.life[i] = this.life[last]; this.maxLife[i] = this.maxLife[last];
      this.size[i] = this.size[last]; this.sizeEnd[i] = this.sizeEnd[last];
      this.alpha[i] = this.alpha[last]; this.drag[i] = this.drag[last];
      this.gravity[i] = this.gravity[last];
      this.rot[i] = this.rot[last]; this.spin[i] = this.spin[last];
      this.kindShape[i] = this.kindShape[last]; this.kindId[i] = this.kindId[last];
      this.cr[i] = this.cr[last]; this.cg[i] = this.cg[last]; this.cb[i] = this.cb[last];
      this.nx[i] = this.nx[last]; this.ny[i] = this.ny[last]; this.nz[i] = this.nz[last];
    }
    this.count = last;
  }

  /** 命中点特效组（按材质/情形选择） */
  emitBurst(pos, normal, kind, opts) {
    const o = opts || {};
    const n = normal || UP;
    switch (kind) {
      case 'impact':
        this.emit('spark', { pos, dir: n, speed: 11, spread: 42, count: 9, color: o.color || CFG.fx.sparkColor, size: 0.05, life: 0.3 });
        this.emit('dust', { pos, dir: n, speed: 2.2, spread: 70, count: 5, color: o.dustColor || [0.42, 0.40, 0.37], size: 0.22, alpha: 0.28 });
        this.emit('ringSmall', { pos, normal: n, color: o.color || CFG.fx.sparkColor, count: 1 });
        break;
      case 'flesh':
        this.emit('blood', { pos, dir: n, speed: 8, spread: 36, count: 11, color: CFG.fx.bloodColor, size: 0.13 });
        this.emit('bloodMist', { pos, dir: n, speed: 2.6, spread: 60, count: 4, color: CFG.fx.bloodColor });
        break;
      case 'headshot':
        this.emit('blood', { pos, dir: n, speed: 12, spread: 40, count: 18, color: CFG.fx.bloodColor, size: 0.16 });
        this.emit('bloodMist', { pos, dir: n, speed: 3.4, spread: 70, count: 7, color: CFG.fx.bloodColor, size: 0.5 });
        this.emit('spark', { pos, dir: n, speed: 9, spread: 55, count: 6, color: [1.0, 0.85, 0.6], size: 0.05 });
        break;
      case 'shield':
        this.emit('shieldHit', { pos, dir: n, speed: 9, spread: 55, count: 12, color: CFG.fx.shieldColor, size: 0.12, life: 0.3 });
        this.emit('ringSmall', { pos, normal: n, color: CFG.fx.shieldColor, count: 1 });
        break;
      case 'shieldBreak':
        this.emit('shield', { pos, dir: n, speed: 14, spread: 90, count: 30, color: CFG.fx.shieldColor, size: 0.2, life: 0.55 });
        this.emit('ring', { pos, normal: n, color: CFG.fx.shieldColor, count: 1 });
        break;
      case 'explosion':
        this.emit('explosion', { pos, dir: UP, speed: 3.2, spread: 180, count: 8, color: [1.0, 0.62, 0.22], size: 0.6, life: 0.5 });
        this.emit('sparkHeavy', { pos, dir: null, speed: 20, spread: 180, count: 26, color: [1.0, 0.72, 0.28] });
        this.emit('debris', { pos, dir: null, speed: 13, spread: 180, count: 12, color: [0.32, 0.29, 0.26] });
        this.emit('smoke', { pos, dir: UP, speed: 3.2, spread: 60, count: 10, color: [0.20, 0.19, 0.18], size: 0.8, life: 1.9 });
        this.emit('ring', { pos, normal: UP, color: [1.0, 0.68, 0.26], count: 1 });
        this.emit('ring', { pos, normal: n, color: [1.0, 0.68, 0.26], count: 1 });
        break;
      case 'death':
        this.emit('spark', { pos, dir: null, speed: 10, spread: 180, count: 16, color: o.color || [1.0, 0.55, 0.3], size: 0.07 });
        this.emit('debris', { pos, dir: null, speed: 8, spread: 180, count: 8, color: [0.28, 0.30, 0.33] });
        this.emit('smoke', { pos, dir: UP, speed: 2.0, spread: 70, count: 5, color: [0.18, 0.18, 0.20], size: 0.5 });
        break;
      case 'muzzle':
        this.emit('muzzle', { pos, dir: n, speed: 9, spread: 30, count: 4, color: o.color || [1.0, 0.8, 0.4], size: 0.11, life: 0.12 });
        break;
      case 'land':
        this.emit('dust', { pos, dir: UP, speed: 3.4, spread: 80, count: Math.min(14, 4 + Math.round((o.impact || 8) * 0.6)), color: [0.40, 0.38, 0.35], size: 0.3, alpha: 0.32 });
        break;
      case 'slide':
        this.emit('dust', { pos, dir: UP, speed: 1.6, spread: 70, count: 2, color: [0.42, 0.40, 0.36], size: 0.26, alpha: 0.26, life: 0.7 });
        break;
      case 'wallrun':
        this.emit('spark', { pos, dir: n, speed: 6, spread: 30, count: 2, color: [1.0, 0.82, 0.42], size: 0.04, life: 0.22 });
        break;
      case 'dash':
        this.emit('trail', { pos, dir: n, speed: 5, spread: 40, count: 8, color: [0.55, 0.85, 1.0], size: 0.1, life: 0.3 });
        break;
      case 'grappleHit':
        this.emit('energy', { pos, dir: n, speed: 7, spread: 50, count: 8, color: [0.5, 0.9, 1.0] });
        break;
      default:
        this.emit('spark', { pos, dir: n, speed: 8, spread: 45, count: 6 });
        break;
    }
    void o;
  }

  update(dt) {
    let k = 0;
    for (let i = 0; i < this.count; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) continue;
      // 阻尼
      const d = this.drag[i];
      if (d > 0) {
        const f = Math.max(0, 1 - d * dt);
        this.vx[i] *= f; this.vy[i] *= f; this.vz[i] *= f;
      }
      this.vy[i] -= this.gravity[i] * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      this.rot[i] += this.spin[i] * dt;
      if (k !== i) this._copy(i, k);
      k++;
    }
    this.count = k;
    this._alive = k;
  }

  _copy(from, to) {
    this.px[to] = this.px[from]; this.py[to] = this.py[from]; this.pz[to] = this.pz[from];
    this.vx[to] = this.vx[from]; this.vy[to] = this.vy[from]; this.vz[to] = this.vz[from];
    this.life[to] = this.life[from]; this.maxLife[to] = this.maxLife[from];
    this.size[to] = this.size[from]; this.sizeEnd[to] = this.sizeEnd[from];
    this.alpha[to] = this.alpha[from]; this.drag[to] = this.drag[from]; this.gravity[to] = this.gravity[from];
    this.rot[to] = this.rot[from]; this.spin[to] = this.spin[from];
    this.kindShape[to] = this.kindShape[from]; this.kindId[to] = this.kindId[from];
    this.cr[to] = this.cr[from]; this.cg[to] = this.cg[from]; this.cb[to] = this.cb[from];
    this.nx[to] = this.nx[from]; this.ny[to] = this.ny[from]; this.nz[to] = this.nz[from];
  }

  render(engine, cameraRight, cameraUp, cameraForward) {
    if (this.count === 0) return;
    const e = engine;
    const rx = cameraRight ? cameraRight[0] : 1;
    const ry = cameraRight ? cameraRight[1] : 0;
    const rz = cameraRight ? cameraRight[2] : 0;
    const ux = cameraUp ? cameraUp[0] : 0;
    const uy = cameraUp ? cameraUp[1] : 1;
    const uz = cameraUp ? cameraUp[2] : 0;

    // 按形状分组渲染
    for (let shape = 0; shape < 3; shape++) {
      const mesh = shape === 0 ? e.userSparkMesh : (shape === 1 ? e.userBillboardMesh : e.userRingMesh);
      if (!mesh) continue;
      let n = 0;
      for (let i = 0; i < this.count; i++) {
        if (this.kindShape[i] !== shape) continue;
        if (n >= 1024) break;
        const t = M.clamp01(this.life[i] / Math.max(0.001, this.maxLife[i]));
        const sz = M.lerp(this.sizeEnd[i], this.size[i], t);
        const a = this.alpha[i] * (t < 0.35 ? t / 0.35 : 1) * (t > 0.9 ? (1 - t) / 0.1 : 1);
        if (a <= 0.004 || sz <= 0.002) continue;
        const fade = M.clamp01(a * 1.6);
        const write = this._writeInstance(n, shape, mesh, i, sz, rx, ry, rz, ux, uy, uz, fade);
        if (write) n++;
      }
      if (n > 0) {
        e.drawInstanced(mesh, this._mats.subarray(0, n * 16), n, {
          colors: this._cols.subarray(0, n * 4),
          unlit: true,
          cull: false,
          depthWrite: false,
        });
      }
    }
    void cameraForward;
  }

  _writeInstance(idx, shape, mesh, i, sz, rx, ry, rz, ux, uy, uz, fade) {
    const m = this._mats;
    const o = idx * 16;
    if (shape === 0) {
      // 沿速度方向拉伸
      const sp = Math.hypot(this.vx[i], this.vy[i], this.vz[i]);
      let dx = 0, dy = 1, dz = 0;
      let len = sz;
      if (sp > 0.05) {
        dx = this.vx[i] / sp; dy = this.vy[i] / sp; dz = this.vz[i] / sp;
        len = sz + Math.min(1.4, sp * 0.028);
      }
      let ax = 0, ay = 1, az = 0;
      if (Math.abs(dy) > 0.99) { ax = 1; ay = 0; az = 0; }
      let px2 = ay * dz - az * dy;
      let py2 = az * dx - ax * dz;
      let pz2 = ax * dy - ay * dx;
      const pl = Math.hypot(px2, py2, pz2) || 1;
      px2 /= pl; py2 /= pl; pz2 /= pl;
      const qx = dy * pz2 - dz * py2;
      const qy = dz * px2 - dx * pz2;
      const qz = dx * py2 - dy * px2;
      m[o] = px2 * sz; m[o + 1] = py2 * sz; m[o + 2] = pz2 * sz; m[o + 3] = 0;
      m[o + 4] = qx * sz; m[o + 5] = qy * sz; m[o + 6] = qz * sz; m[o + 7] = 0;
      m[o + 8] = -dx * len; m[o + 9] = -dy * len; m[o + 10] = -dz * len; m[o + 11] = 0;
      m[o + 12] = this.px[i]; m[o + 13] = this.py[i]; m[o + 14] = this.pz[i]; m[o + 15] = 1;
    } else if (shape === 1) {
      // 相机朝向公告板（含旋转）
      const c = Math.cos(this.rot[i]), s = Math.sin(this.rot[i]);
      const rx2 = (rx * c + ux * s) * sz;
      const ry2 = (ry * c + uy * s) * sz;
      const rz2 = (rz * c + uz * s) * sz;
      const ux2 = (ux * c - rx * s) * sz;
      const uy2 = (uy * c - ry * s) * sz;
      const uz2 = (uz * c - rz * s) * sz;
      m[o] = rx2; m[o + 1] = ry2; m[o + 2] = rz2; m[o + 3] = 0;
      m[o + 4] = ux2; m[o + 5] = uy2; m[o + 6] = uz2; m[o + 7] = 0;
      m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = 0; m[o + 11] = 0;
      m[o + 12] = this.px[i]; m[o + 13] = this.py[i]; m[o + 14] = this.pz[i]; m[o + 15] = 1;
    } else {
      // 圆盘：贴合给定法线
      const nx = this.nx[i], ny = this.ny[i], nz = this.nz[i];
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
      m[o] = tx * sz; m[o + 1] = ty * sz; m[o + 2] = tz * sz; m[o + 3] = 0;
      m[o + 4] = bx * sz; m[o + 5] = by * sz; m[o + 6] = bz * sz; m[o + 7] = 0;
      m[o + 8] = nx * sz * 0.02; m[o + 9] = ny * sz * 0.02; m[o + 10] = nz * sz * 0.02; m[o + 11] = 0;
      m[o + 12] = this.px[i] + nx * 0.02; m[o + 13] = this.py[i] + ny * 0.02;
      m[o + 14] = this.pz[i] + nz * 0.02; m[o + 15] = 1;
    }
    const co = idx * 4;
    this._cols[co] = this.cr[i] * fade;
    this._cols[co + 1] = this.cg[i] * fade;
    this._cols[co + 2] = this.cb[i] * fade;
    this._cols[co + 3] = 1;
    void mesh;
    return true;
  }

  debugState() {
    return { alive: this.count, capacity: this.capacity };
  }
}

const SPREAD_DIR = new Float32Array(3);
const ZERO = new Float32Array(3);
const UP = new Float32Array([0, 1, 0]);

export default ParticleSystem;
