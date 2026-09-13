// ==== fx/enemy-markers.js — 敌人高亮标记（默认开启）====
// 深色工业地图中，单靠模型配色仍可能被结构遮住，因此以面向相机的 unlit 公告板
// 标记视锥内敌人。标记服从深度测试，绝不透过地板或墙体。
// 早期“提交了实例却没有像素”的根因是引擎实例 VBO 偏移与跨批次合并错误，现已修复。

import * as M from '../core/math.js';

const MAX_MARKERS = 48;

export class EnemyMarkerSystem {
  constructor(engine) {
    this.engine = engine;
    // 实例偏移与多 pass 已修；默认开启，保证深色地图中的敌人可辨识。
    this.enabled = true;
    this._mats = new Float32Array(16 * MAX_MARKERS);
    this._cols = new Float32Array(4 * MAX_MARKERS);
    this._size = 0.42;          // 世界尺寸基准（米）
    this._drawCount = 0;
  }

  /**
   * 渲染一帧敌人标记。
   * @param engine 引擎
   * @param enemies EnemySystem
   * @param world   World（用于视线判定）
   * @param eye     相机位置
   */
  render(engine, enemies, world, eye) {
    if (!this.enabled || !enemies || !engine) return 0;
    const mesh = engine.userBillboardMesh;
    if (!mesh) return 0;

    const e = engine;
    const vp = e.viewProj;
    const W = e.width, H = e.height;
    const camX = eye[0], camY = eye[1], camZ = eye[2];

    let n = 0;
    for (let i = 0; i < enemies.all.length && n < MAX_MARKERS; i++) {
      const en = enemies.all[i];
      if (!en.alive) continue;

      // 胸口高度作为标记锚点
      const wx = en.pos[0];
      const wy = en.pos[1] + en.height * 0.62;
      const wz = en.pos[2];

      // 到相机的距离
      const dx = wx - camX, dy = wy - camY, dz = wz - camZ;
      const dist = Math.hypot(dx, dy, dz);
      if (dist < 0.5 || dist > 90) continue;          // 太近太远都不画

      // 投影到裁剪空间
      const cx = vp[0] * wx + vp[4] * wy + vp[8] * wz + vp[12];
      const cy = vp[1] * wx + vp[5] * wy + vp[9] * wz + vp[13];
      const cw = vp[3] * wx + vp[7] * wy + vp[11] * wz + vp[15];
      if (cw <= 0.05) continue;                        // 在背后
      const ndcX = cx / cw, ndcY = cy / cw;
      // 只画视野内的（留一点边缘余量，避免边缘闪烁）
      if (ndcX < -1.15 || ndcX > 1.15 || ndcY < -1.15 || ndcY > 1.15) continue;

      // 可见性：被墙挡住时仍会提交，但深度测试会把它正确遮住。
      const visible = !world || world.lineOfSight(
        eye, [wx, wy, wz], { hitBoxes: true, hitTriangles: true });

      // 屏幕空间尺寸：距离衰减，夹紧到 [0.18, 0.9] 米等效
      const sz = M.clamp(this._size * (dist / 12), 0.16, 0.95);

      // 构造面向相机的公告板矩阵：直接用屏幕空间偏移
      // 标记中心 = 锚点朝相机方向偏移一点，避免与身体 z-fighting
      const inv = 1 / dist;
      const bx = wx - dx * inv * 0.12;
      const by = wy - dy * inv * 0.12;
      const bz = wz - dz * inv * 0.12;

      // 相机右/上/前向量（由引擎在 setCamera 时算好）
      const r = e.cameraRight;
      const u = e.cameraUp;
      const f = e.cameraForward;
      const rx = r ? r[0] : 1, ry = r ? r[1] : 0, rz = r ? r[2] : 0;
      const ux = u ? u[0] : 0, uy = u ? u[1] : 1, uz = u ? u[2] : 0;
      const fx = f ? f[0] : 0, fy = f ? f[1] : 0, fz = f ? f[2] : -1;

      const o = n * 16;
      const m = this._mats;
      // 三列必须是正交的单位向量乘上尺寸；早期版本第三列写成接近零的退化值，
      // 结果公告板被压成零体积，矩阵存在但画不出任何像素。
      m[o] = rx * sz;     m[o + 1] = ry * sz;     m[o + 2] = rz * sz;     m[o + 3] = 0;
      m[o + 4] = ux * sz; m[o + 5] = uy * sz;     m[o + 6] = uz * sz;     m[o + 7] = 0;
      m[o + 8] = fx * sz; m[o + 9] = fy * sz;     m[o + 10] = fz * sz;    m[o + 11] = 0;
      m[o + 12] = bx;     m[o + 13] = by;         m[o + 14] = bz;         m[o + 15] = 1;

      // 颜色：可见 → 亮琥珀；被遮挡部分会由深度缓冲裁掉。
      const type = en.type || {};
      const acc = type.accentColor || [1.0, 0.55, 0.2];
      const hit = M.clamp01(en.hitFlash || 0);
      const k = visible ? 1.0 : 0.34;
      const co = n * 4;
      // 自发光观感：用 unlit + 高亮度颜色
      this._cols[co] = Math.min(1, acc[0] * k + hit * 0.8 + (visible ? 0.25 : 0));
      this._cols[co + 1] = Math.min(1, acc[1] * k + hit * 0.8 + (visible ? 0.18 : 0));
      this._cols[co + 2] = Math.min(1, acc[2] * k + hit * 0.8 + (visible ? 0.10 : 0));
      this._cols[co + 3] = 1;
      n++;
    }

    this._drawCount = n;
    if (n > 0) {
      e.drawInstanced(mesh, this._mats.subarray(0, n * 16), n, {
        colors: this._cols.subarray(0, n * 4),
        unlit: true,
        cull: false,
        depthWrite: false,
        noDepthTest: false,
      });
    }
    return n;
  }

  debugState() {
    return { enabled: this.enabled, drawn: this._drawCount };
  }
}

export default EnemyMarkerSystem;
