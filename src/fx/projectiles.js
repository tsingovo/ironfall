// ==== fx/projectiles.js — 视觉弹道 / 曳光 / 枪口火光（池化，零 GC） ====
// 设计：命中判定在 weapons.js 里用即时射线完成（干脆），这里只负责"看得见"的部分。
//   * 曳光（tracer）：从枪口到命中点的快速衰减明亮线段，制造弹道感
//   * 弹丸（projectile）：可选的慢速可见弹体（能量武器/敌人投射物）
//   * 枪口火光：视图模型空间的自发光四边形 + 世界空间闪光

import { CFG } from '../core/config.js';
import * as M from '../core/math.js';

const FLOATS_PER_INST = 20;
// 曳光的世界宽度统一缩放。保留数据层的武器参数和最小可见长度，
// 只把最终渲染截面收细，避免从枪口附近开始的三层光带遮住准心/敌人。
const TRACER_WIDTH_SCALE = 0.46;

/** 单位拉伸盒（沿 -Z 长度 1，截面 1x1）用于曳光与弹体 */
function makeStretchBox(Geo) {
  return Geo.unitCube();
}

export class ProjectilePool {
  constructor(engine, capacity = 512) {
    this.engine = engine;
    this.capacity = capacity;
    this.count = 0;

    // SoA 存储，避免对象分配
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.width = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.damage = new Float32Array(capacity);
    this.ownerId = new Int32Array(capacity);
    this.cr = new Float32Array(capacity);
    this.cg = new Float32Array(capacity);
    this.cb = new Float32Array(capacity);

    // 曳光（独立的更短生命周期池）
    this.tracerCapacity = 128;
    this.tracerCount = 0;
    this.tax = new Float32Array(this.tracerCapacity);
    this.tay = new Float32Array(this.tracerCapacity);
    this.taz = new Float32Array(this.tracerCapacity);
    this.tbx = new Float32Array(this.tracerCapacity);
    this.tby = new Float32Array(this.tracerCapacity);
    this.tbz = new Float32Array(this.tracerCapacity);
    this.tlife = new Float32Array(this.tracerCapacity);
    this.tmaxLife = new Float32Array(this.tracerCapacity);
    this.twidth = new Float32Array(this.tracerCapacity);
    this.tcr = new Float32Array(this.tracerCapacity);
    this.tcg = new Float32Array(this.tracerCapacity);
    this.tcb = new Float32Array(this.tracerCapacity);

    // 枪口火光
    this.flashTime = 0;
    this.flashScale = 1;
    this.flashColor = new Float32Array([1, 0.8, 0.4]);
    this.flashWorldTime = 0;
    this.flashWorldPos = new Float32Array(3);
    this.flashWorldDir = new Float32Array([0, 0, -1]);

    // 每条曳光由“暗色轮廓 + 彩色光带 + 白色亮芯”三层组成。容量按整个
    // tracer pool 预留，避免战斗激烈时只渲染数组前部的弹道。
    const renderCapacity = Math.max(this.capacity, this.tracerCapacity * 3);
    this._mats = new Float32Array(16 * renderCapacity);
    this._cols = new Float32Array(4 * renderCapacity);
    this._tmpM = new Float32Array(16);
    this._tmpM2 = new Float32Array(16);
    this._up = new Float32Array([0, 1, 0]);
    this._fwd = new Float32Array(3);
    this._grappleStart = new Float32Array(3);
  }

  get aliveCount() { return this.count + this.tracerCount; }

  clear() {
    this.count = 0;
    this.tracerCount = 0;
    this.flashTime = 0;
    this.flashWorldTime = 0;
  }

  // ---------------------------------------------------------------- 弹丸

  /**
   * 生成一个可见弹丸。
   * opts: { color:[r,g,b], width, life, damage, ownerId, gravity, onHit }
   */
  spawn(origin, dir, speed, opts) {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    const o = opts || {};
    this.px[i] = origin[0]; this.py[i] = origin[1]; this.pz[i] = origin[2];
    this.vx[i] = dir[0] * speed; this.vy[i] = dir[1] * speed; this.vz[i] = dir[2] * speed;
    const life = o.life == null ? 2.0 : o.life;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.width[i] = o.width == null ? 0.06 : o.width;
    this.gravity[i] = o.gravity == null ? 0 : o.gravity;
    this.damage[i] = o.damage == null ? 0 : o.damage;
    this.ownerId[i] = o.ownerId == null ? 0 : o.ownerId;
    const c = o.color || CFG.fx.sparkColor;
    this.cr[i] = c[0]; this.cg[i] = c[1]; this.cb[i] = c[2];
    return i;
  }

  /**
   * 瞬时曳光：从 a 到 b。
   *
   * 关键：曳光**不能只画枪口到命中点那一小段** —— 高速武器的命中点常远在
   * 百米之外，1~2 米长的线段在屏幕上根本看不见。这里改为：
   *   · 若给了命中点 b：沿方向从 a 画到 b，但**至少** `minLen` 长
   *   · 若没给 b：沿 dir 画 `fallbackLen`
   * 另外宽度用 `widthScale` 放大（渲染层再乘光晕倍率）。
   */
  spawnTracer(a, b, opts) {
    if (!CFG.fx.tracers) return;
    if (this.tracerCount >= this.tracerCapacity) {
      this._evictTracer();
    }
    const i = this.tracerCount++;
    const o = opts || {};
    const dir = o.dir || this._fwd;
    const len = o.length == null ? 26 : o.length;
    const minLen = o.minLength == null ? 10 : o.minLength;

    // 方向归一化
    let dx, dy, dz;
    if (b) {
      dx = b[0] - a[0]; dy = b[1] - a[1]; dz = b[2] - a[2];
      const l = Math.hypot(dx, dy, dz) || 1;
      dx /= l; dy /= l; dz /= l;
      // 实际命中距离；太短就补到 minLen，保证可见
      const drawLen = Math.max(l, minLen);
      if (l >= minLen) {
        this.tbx[i] = b[0]; this.tby[i] = b[1]; this.tbz[i] = b[2];
      } else {
        this.tbx[i] = a[0] + dx * drawLen;
        this.tby[i] = a[1] + dy * drawLen;
        this.tbz[i] = a[2] + dz * drawLen;
      }
    } else {
      dx = dir[0] || 0; dy = dir[1] || 0; dz = dir[2] || -1;
      const l = Math.hypot(dx, dy, dz) || 1;
      dx /= l; dy /= l; dz /= l;
      const drawLen = Math.max(len, minLen);
      this.tbx[i] = a[0] + dx * drawLen;
      this.tby[i] = a[1] + dy * drawLen;
      this.tbz[i] = a[2] + dz * drawLen;
    }
    this.tax[i] = a[0]; this.tay[i] = a[1]; this.taz[i] = a[2];

    // 至少保留约 8 帧（60 Hz），防止短曳光恰好落在两次显示刷新之间。
    const life = Math.max(0.13, o.life == null ? CFG.fx.tracerLife : o.life);
    this.tlife[i] = life;
    this.tmaxLife[i] = life;
    // 宽度：直接用世界尺寸（渲染层会再乘光晕倍率）。敌方弹道可以通过
    // minWidth 使用更细的尺寸，防止射线靠近相机时变成遮屏光柱。
    const minWidth = o.minWidth == null ? 0.045 : Math.max(0.01, o.minWidth);
    this.twidth[i] = Math.max(minWidth, o.width == null ? 0.055 : o.width);
    const c = o.color || CFG.fx.sparkColor;
    this.tcr[i] = c[0]; this.tcg[i] = c[1]; this.tcb[i] = c[2];
  }

  _evictTracer() {
    // 把最旧的一条与最后一条交换（数组语义，不保序）
    const last = this.tracerCount - 1;
    this.tax[0] = this.tax[last]; this.tay[0] = this.tay[last]; this.taz[0] = this.taz[last];
    this.tbx[0] = this.tbx[last]; this.tby[0] = this.tby[last]; this.tbz[0] = this.tbz[last];
    this.tlife[0] = this.tlife[last]; this.tmaxLife[0] = this.tmaxLife[last];
    this.twidth[0] = this.twidth[last];
    this.tcr[0] = this.tcr[last]; this.tcg[0] = this.tcg[last]; this.tcb[0] = this.tcb[last];
    this.tracerCount = last;
  }

  spawnMuzzleFlash(pos, dir, color, scale) {
    this.flashTime = 0.045;
    this.flashScale = scale == null ? 1 : scale;
    const c = color || [1, 0.8, 0.4];
    this.flashColor[0] = c[0]; this.flashColor[1] = c[1]; this.flashColor[2] = c[2];
    this.flashWorldTime = 0.05;
    this.flashWorldPos[0] = pos[0]; this.flashWorldPos[1] = pos[1]; this.flashWorldPos[2] = pos[2];
    this.flashWorldDir[0] = dir[0]; this.flashWorldDir[1] = dir[1]; this.flashWorldDir[2] = dir[2];
  }

  // ---------------------------------------------------------------- 更新

  update(dt, world, enemies) {
    // 曳光衰减
    let w = 0;
    for (let i = 0; i < this.tracerCount; i++) {
      this.tlife[i] -= dt;
      if (this.tlife[i] <= 0) continue;
      if (w !== i) {
        this.tax[w] = this.tax[i]; this.tay[w] = this.tay[i]; this.taz[w] = this.taz[i];
        this.tbx[w] = this.tbx[i]; this.tby[w] = this.tby[i]; this.tbz[w] = this.tbz[i];
        this.tlife[w] = this.tlife[i]; this.tmaxLife[w] = this.tmaxLife[i];
        this.twidth[w] = this.twidth[i];
        this.tcr[w] = this.tcr[i]; this.tcg[w] = this.tcg[i]; this.tcb[w] = this.tcb[i];
      }
      w++;
    }
    this.tracerCount = w;

    // 枪口火光
    if (this.flashTime > 0) this.flashTime -= dt;
    if (this.flashWorldTime > 0) this.flashWorldTime -= dt;

    // 弹丸推进（用射线步进避免穿透）
    let k = 0;
    for (let i = 0; i < this.count; i++) {
      this.vy[i] -= this.gravity[i] * dt;
      const dx = this.vx[i] * dt, dy = this.vy[i] * dt, dz = this.vz[i] * dt;
      const dist = Math.hypot(dx, dy, dz);
      let hitPt = null;
      let hitN = null;
      if (dist > 1e-5) {
        DIR_T[0] = dx / dist; DIR_T[1] = dy / dist; DIR_T[2] = dz / dist;
        ORIG_T[0] = this.px[i]; ORIG_T[1] = this.py[i]; ORIG_T[2] = this.pz[i];
        const wh = world ? world.raycast(ORIG_T, DIR_T, dist, {}) : null;
        const eh = enemies ? enemies.raycastEnemies(ORIG_T, DIR_T, dist) : null;
        const wt = wh && wh.hit ? wh.t : Infinity;
        const et = eh ? eh.t : Infinity;
        if (et <= wt && eh) {
          hitPt = eh.point; hitN = eh.normal;
          if (this.damage[i] > 0) {
            enemies.damage(eh.enemy, this.damage[i], eh.headshot, eh.point, eh.normal, {});
          }
        } else if (wh && wh.hit) {
          hitPt = wh.point; hitN = wh.normal;
        }
      }
      if (hitPt) {
        // 命中：通知外部（由 main 消费事件生成粒子）
        HIT_P[0] = hitPt[0]; HIT_P[1] = hitPt[1]; HIT_P[2] = hitPt[2];
        if (hitN) { HIT_N[0] = hitN[0]; HIT_N[1] = hitN[1]; HIT_N[2] = hitN[2]; }
        else { HIT_N[0] = 0; HIT_N[1] = 1; HIT_N[2] = 0; }
        continue;   // 不复制到新数组 => 销毁
      }
      this.px[i] += dx; this.py[i] += dy; this.pz[i] += dz;
      this.life[i] -= dt;
      if (this.life[i] <= 0) continue;
      if (k !== i) {
        this.px[k] = this.px[i]; this.py[k] = this.py[i]; this.pz[k] = this.pz[i];
        this.vx[k] = this.vx[i]; this.vy[k] = this.vy[i]; this.vz[k] = this.vz[i];
        this.life[k] = this.life[i]; this.maxLife[k] = this.maxLife[i];
        this.width[k] = this.width[i]; this.gravity[k] = this.gravity[i];
        this.damage[k] = this.damage[i]; this.ownerId[k] = this.ownerId[i];
        this.cr[k] = this.cr[i]; this.cg[k] = this.cg[i]; this.cb[k] = this.cb[i];
      }
      k++;
    }
    this.count = k;
  }

  // ---------------------------------------------------------------- 渲染

  /**
   * 渲染曳光与弹道。
   *
   * ⚠️ 尺寸说明（改之前先读）：这里用的是 **1×1×1 米的共享立方体**，
   * 实例矩阵的缩放直接就是"世界尺寸"。早期版本把 width 设成 0.02 之类的小值，
   * 结果在 10m 外不到 1 个像素 —— 表现为"看不到子弹效果"。
   * 现在分三层画（统一缩细）：
   *   · 轮廓层：深色细底，在雪地/亮地板前也有清晰边界
   *   · 光带层：高饱和武器颜色，负责辨认弹道阵营和武器
   *   · 亮芯层：近乎纯白的细芯，在暗背景前保持亮度
   * 长度也统一拉到 8m 级别，命中方向的弹道一眼可见。
   */
  render(engine) {
    const e = engine;
    // 曳光：拉长的盒体，从一个点到另一个点
    if (this.tracerCount > 0) {
      const mesh = e.userTracerMesh;
      if (mesh) {
        let n = 0;
        for (let i = 0; i < this.tracerCount; i++) {
          const t = M.clamp01(this.tlife[i] / Math.max(0.001, this.tmaxLife[i]));
          const fade = t * t;
          const w = this.twidth[i] * (0.6 + 0.4 * fade) * TRACER_WIDTH_SCALE;
          // 深色轮廓。先画细底，再由同一批次里的后续实例覆盖中心区域。
          if (this._writeStretch(n, this.tax[i], this.tay[i], this.taz[i],
            this.tbx[i], this.tby[i], this.tbz[i],
            w * 4.6 * fade, w * 4.6 * fade,
            0.018 * fade, 0.022 * fade, 0.030 * fade)) n++;
          // 彩色中层
          if (this._writeStretch(n, this.tax[i], this.tay[i], this.taz[i],
            this.tbx[i], this.tby[i], this.tbz[i],
            w * 2.7 * fade, w * 2.7 * fade,
            Math.min(1, this.tcr[i] * 1.25) * fade,
            Math.min(1, this.tcg[i] * 1.25) * fade,
            Math.min(1, this.tcb[i] * 1.25) * fade)) n++;
          // 内层白芯
          if (this._writeStretch(n, this.tax[i], this.tay[i], this.taz[i],
            this.tbx[i], this.tby[i], this.tbz[i],
            w * 1.05 * fade, w * 1.05 * fade,
            Math.min(1, this.tcr[i] + 0.55) * fade,
            Math.min(1, this.tcg[i] + 0.55) * fade,
            Math.min(1, this.tcb[i] + 0.55) * fade)) n++;
        }
        if (n > 0) e.drawInstanced(mesh, this._mats.subarray(0, n * 16), n, {
          colors: this._cols.subarray(0, n * 4), unlit: true, cull: false, depthWrite: false,
        });
      }
    }
    // 弹丸（可见弹体，用于慢速/能量武器）
    if (this.count > 0) {
      const mesh = e.userStretchMesh;
      if (mesh) {
        let n = 0;
        for (let i = 0; i < this.count; i++) {
          const sp = Math.hypot(this.vx[i], this.vy[i], this.vz[i]) || 1;
          const len = M.clamp(sp * 0.05, 0.6, 4.0);
          const ex = this.px[i] - this.vx[i] / sp * len;
          const ey = this.py[i] - this.vy[i] / sp * len;
          const ez = this.pz[i] - this.vz[i] / sp * len;
          const w = this.width[i] * 2.2;
          if (this._writeStretch(n, ex, ey, ez, this.px[i], this.py[i], this.pz[i],
            w, w, this.cr[i], this.cg[i], this.cb[i])) n++;
        }
        if (n > 0) e.drawInstanced(mesh, this._mats.subarray(0, n * 16), n, {
          colors: this._cols.subarray(0, n * 4), unlit: true, cull: false, depthWrite: false,
        });
      }
    }
  }

  /** 渲染玩家抓钩：带轮廓的绳索与锚点钩头。 */
  renderGrapple(engine, player) {
    const e = engine;
    const g = player && player.grapple;
    if (!g || !g.active || !e.userTracerMesh) return;
    const end = g.attachedEnemy ? g.attachedEnemy.pos : g.point;
    const ex = end[0], ey = end[1] + (g.attachedEnemy ? 0.9 : 0.12), ez = end[2];
    // 从右手/腕部附近出绳，避免绳索从屏幕正中心凭空出现。
    const start = this._grappleStart;
    start[0] = player.eyePos[0] + player.right[0] * 0.28 - player.up[0] * 0.18 + player.forward[0] * 0.34;
    start[1] = player.eyePos[1] + player.right[1] * 0.28 - player.up[1] * 0.18 + player.forward[1] * 0.34;
    start[2] = player.eyePos[2] + player.right[2] * 0.28 - player.up[2] * 0.18 + player.forward[2] * 0.34;
    let n = 0;
    this._writeStretch(n++, start[0], start[1], start[2], ex, ey, ez, 0.16, 0.16, 0.018, 0.035, 0.045);
    this._writeStretch(n++, start[0], start[1], start[2], ex, ey, ez, 0.085, 0.085, 0.08, 0.42, 0.62);
    this._writeStretch(n++, start[0], start[1], start[2], ex, ey, ez, 0.035, 0.035, 0.38, 0.92, 1.0);
    e.drawInstanced(e.userTracerMesh, this._mats.subarray(0, n * 16), n, {
      colors: this._cols.subarray(0, n * 4), unlit: true, cull: false, depthWrite: false,
    });
    // 锚点钩头：球体远处也能辨认落点。
    const hook = this._tmpM2;
    M.m4Compose([ex, ey, ez], 0, 0, 0, [0.24, 0.24, 0.24], hook);
    e.drawInstanced(e.userSphereMesh || e.userTracerMesh, hook, 1, {
      color: [0.18, 0.82, 1.0], emissive: 0.75, unlit: true, cull: false, depthWrite: false,
    });
  }

  /** 写入一条"从 a 到 b 的拉伸盒"实例数据，返回是否成功 */
  _writeStretch(idx, ax, ay, az, bx, by, bz, wTop, wBottom, cr, cg, cb) {
    if (idx >= this._mats.length / 16) return false;
    let dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return false;
    dx /= len; dy /= len; dz /= len;
    // 构造正交基：盒体沿局部 -Z 拉伸，截面按 width 缩放
    let ux = 0, uy = 1, uz = 0;
    if (Math.abs(dy) > 0.99) { ux = 1; uy = 0; uz = 0; }
    let rx = uy * dz - uz * dy;
    let ry = uz * dx - ux * dz;
    let rz = ux * dy - uy * dx;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    const tx = dy * rz - dz * ry;
    const ty = dz * rx - dx * rz;
    const tz = dx * ry - dy * rx;
    const m = this._mats;
    const o = idx * 16;
    const hw = wBottom * 0.5;
    const hh = wTop * 0.5;
    // 列 = (right*hw, up*hh, -dir*len)
    m[o] = rx * hw; m[o + 1] = ry * hw; m[o + 2] = rz * hw; m[o + 3] = 0;
    m[o + 4] = tx * hh; m[o + 5] = ty * hh; m[o + 6] = tz * hh; m[o + 7] = 0;
    m[o + 8] = -dx * len; m[o + 9] = -dy * len; m[o + 10] = -dz * len; m[o + 11] = 0;
    m[o + 12] = (ax + bx) * 0.5; m[o + 13] = (ay + by) * 0.5; m[o + 14] = (az + bz) * 0.5; m[o + 15] = 1;
    const co = idx * 4;
    this._cols[co] = cr; this._cols[co + 1] = cg; this._cols[co + 2] = cb; this._cols[co + 3] = 1;
    return true;
  }

  /** 视图模型空间的枪口火光（在 weapons.render 里调用） */
  renderViewmodelFlash(engine, weaponSystem, def) {
    if (this.flashTime <= 0) return;
    const e = engine;
    const mesh = e.userFlashMesh;
    if (!mesh) return;
    const t = M.clamp01(this.flashTime / 0.045);
    const s = this.flashScale * (0.55 + t * 0.75);
    const ml = def.viewmodel.muzzleLocal;
    const vm = weaponSystem.vm;
    const px = vm.pos[0] + ml[0];
    const py = vm.pos[1] + ml[1];
    const pz = vm.pos[2] + ml[2];
    const m = this._tmpM2;
    M.m4Compose([px, py, pz], 0, 0, 0, [s * 0.16, s * 0.16, s * 0.34], m);
    // 轻微随机旋转，避免每发一模一样
    const roll = (this.flashTime * 977) % 1 * 6.28;
    const c = Math.cos(roll), sn = Math.sin(roll);
    const m0 = m[0], m1 = m[1], m4 = m[4], m5 = m[5];
    m[0] = m0 * c - m4 * sn; m[1] = m1 * c - m5 * sn;
    m[4] = m0 * sn + m4 * c; m[5] = m1 * sn + m5 * c;
    const g = t * 1.5;
    e.drawInstanced(mesh, m, 1, {
      color: [this.flashColor[0] * g, this.flashColor[1] * g, this.flashColor[2] * g],
      unlit: true, cull: false, depthWrite: false,
    });
  }

  debugState() {
    return { projectiles: this.count, tracers: this.tracerCount, flash: this.flashTime > 0 };
  }
}

const DIR_T = new Float32Array(3);
const ORIG_T = new Float32Array(3);
const HIT_P = new Float32Array(3);
const HIT_N = new Float32Array(3);

export default ProjectilePool;
