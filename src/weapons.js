// ==== weapons.js — 武器与射击系统（R-99 手感为核心） ====
// R-99 手感配方（逐条对应实现）：
//   * 1080 RPM —— 每 55.6ms 一发，靠固定步内计时器补发，任何帧率都不丢射速
//   * 双通道后坐力 —— recoilAim 真实推移准心（弹道会偏），recoilVisual 只推相机（有体感但不惩罚）
//   * 固定弹道序列 —— 每发按 recoilPattern 走，越打越"上+左右摆"，可背弹道
//   * 扩散累积 —— 连发时锥角变大，停火后衰减；移动/空中/跳跃进一步放大
//   * 干脆的命中 —— 判定用即时射线（不延迟），曳光只做视觉
//   * 换弹动画分阶段 —— 弹匣下沉→脱出→插入→拉栓，空仓更慢
//   * 机瞄对齐 —— 视图模型从 hipPos 插值到 adsPos，FOV 同步收缩
//
// 视图模型为程序化低模（箱体/圆柱拼装），并带完整程序化动画：
// 呼吸、走摆、冲刺低摆、滑铲大倾角、开火后坐、换弹分阶段、开镜、切枪、蹬墙跑位移。

import { CFG } from './core/config.js';
import * as M from './core/math.js';
import * as Events from './core/events.js';
import * as Geo from './engine/geometry.js';
import { normalizeMods } from './player.js';
import { ProjectilePool } from './fx/projectiles.js';
import { LOOT_DEFS } from './inventory.js';

// ================================================================ 武器数据

/**
 * 弹道序列生成器：确定性后坐力图谱。
 * amp 越大后坐越强；前 6 发几乎垂直以便"压枪"，之后开始水平摇摆。
 */
function buildRecoilPattern(count, seed, style) {
  const rng = M.mulberry32(seed);
  const out = [];
  let yawDrift = 0;
  for (let i = 0; i < count; i++) {
    const prog = i / Math.max(1, count - 1);
    let pitch, yaw;
    if (style === 'smg') {
      // 起手猛、随后趋于稳定的小幅摇摆
      pitch = 0.55 + Math.min(0.9, prog * 1.3) * 0.5;
      const sway = Math.sin(i * 0.9) * 0.5 + (rng() - 0.5) * 0.6;
      yawDrift += sway * 0.16;
      yaw = yawDrift * (0.4 + prog * 0.9);
    } else if (style === 'rifle') {
      pitch = 0.7 + Math.min(1.0, prog * 1.1) * 0.7;
      yawDrift += (Math.sin(i * 0.62) * 0.7 + (rng() - 0.5) * 0.5) * 0.2;
      yaw = yawDrift * (0.35 + prog);
    } else if (style === 'shotgun') {
      pitch = 2.4 * (1 - prog * 0.35);
      yaw = (rng() - 0.5) * 0.5;
    } else if (style === 'sniper') {
      pitch = 3.2;
      yaw = (rng() - 0.5) * 0.4;
    } else {
      pitch = 0.8 + prog * 0.4;
      yaw = (rng() - 0.5) * 0.3;
    }
    // 正 pitch = 抬头（准心往上飘）
    out.push([yaw, pitch]);
  }
  return out;
}

// 基础弹匣扩为 35 后，后坐力序列也必须覆盖完整弹匣；否则第 25 发以后会
// 重复/越界回退，自动化也无法保证整匣弹道可学习。
// 仍保留 35 发长度，兼容扩容/升级；基础弹匣按最新平衡值为 24。
const R99_PATTERN = buildRecoilPattern(35, 99099, 'smg');
const FLATLINE_PATTERN = buildRecoilPattern(35, 44211, 'rifle');
const VOLT_PATTERN = buildRecoilPattern(35, 77123, 'smg');
const PEACEKEEPER_PATTERN = buildRecoilPattern(6, 31337, 'shotgun');
const LONGBOW_PATTERN = buildRecoilPattern(6, 80808, 'sniper');
const SENTINEL_PATTERN = buildRecoilPattern(8, 515151, 'sniper');

// 换弹采用七个可听、可见的动作拍点。阈值使用归一化进度，因此 R-99 的
// 0.6 秒、平行的 1 秒和哨兵的 2 秒都共享同一套动作叙事而保持各自速度。
const RELOAD_CUES = Object.freeze([
  { at: 0.025, sound: 'reload_release', gain: 0.92 }, // 按卡榫
  { at: 0.16, sound: 'reload_out', gain: 0.95 },      // 抽出旧匣
  { at: 0.31, sound: 'reload_drop', gain: 0.88 },     // 脱手丢弃
  { at: 0.43, sound: 'reload_grab', gain: 0.86 },     // 取新弹匣
  { at: 0.62, sound: 'reload_in', gain: 1.00 },       // 插入弹匣井
  { at: 0.79, sound: 'reload_seat', gain: 1.00 },     // 拍紧锁定
  { at: 0.90, sound: 'reload_bolt', gain: 0.96 },     // 拉栓/枪机复位
]);

/** 视图模型部件（程序化低模，尺寸单位米） */
/**
 * 视图模型坐标说明（改这里之前务必先读）
 *
 * 视图模型有**独立的相机**：相机固定在原点、朝 -Z，FOV 为 CFG.render.viewmodelFovDeg。
 * 因此 hipPos/adsPos 的 y 值不能太负，否则整把枪会掉到视锥下沿之外 ——
 * 屏幕上就"看不到枪和手臂"。可用的 y 下界约等于
 *   -tan(vFov/2) * |z|
 * 例如 z = -0.30、vFov = 55° 时约 -0.156m。
 * tools/test-ui-input.mjs 会逐部件做 NDC 投影断言，任何改动若把枪挤出画面都会失败。
 */
/**
 * Apex 风格开放式机瞄。它不是悬浮在画面上的方框：底座、两侧护翼和枪身导轨
 * 连成一体，中间完全镂空。当前渲染器没有透明材质，因此绝不放实体镜片。
 */
function addReflexOptic(v, opts = {}) {
  const y = opts.y == null ? 0.112 : opts.y;
  const z = opts.z == null ? -0.11 : opts.z;
  const c = opts.color || [0.075, 0.09, 0.105];
  const glow = opts.glow || [1.0, 0.34, 0.12];
  const optic = true;
  v.parts.push(
    // 宽底座直接压在导轨上，避免“镜子下面是一根孤立柱子”。
    { shape: 'box', size: [0.122, 0.018, 0.102], pos: [0, y - 0.054, z + 0.002], color: c, optic, tag: 'optic-mount' },
    { shape: 'box', size: [0.092, 0.020, 0.135], pos: [0, y - 0.067, z + 0.018], color: [0.13, 0.16, 0.19], optic, tag: 'optic-mount' },
    // 两侧护翼向外展开，轮廓接近 Apex 的机械瞄具；上方不封口。
    { shape: 'box', size: [0.014, 0.090, 0.026], pos: [-0.052, y - 0.002, z - 0.014], rot: [0, 0, -0.10], color: c, optic, tag: 'optic-wing' },
    { shape: 'box', size: [0.014, 0.090, 0.026], pos: [0.052, y - 0.002, z - 0.014], rot: [0, 0, 0.10], color: c, optic, tag: 'optic-wing' },
    { shape: 'box', size: [0.024, 0.018, 0.030], pos: [-0.055, y + 0.040, z - 0.016], rot: [0, 0, -0.18], color: [0.18, 0.21, 0.24], optic, tag: 'optic-cap' },
    { shape: 'box', size: [0.024, 0.018, 0.030], pos: [0.055, y + 0.040, z - 0.016], rot: [0, 0, 0.18], color: [0.18, 0.21, 0.24], optic, tag: 'optic-cap' },
    // 下方双斜面形成浅 V 缺口；中央目标区仍完全开放。
    { shape: 'box', size: [0.052, 0.012, 0.025], pos: [-0.023, y - 0.035, z - 0.020], rot: [0, 0, -0.19], color: [0.22, 0.25, 0.28], optic, tag: 'optic-notch' },
    { shape: 'box', size: [0.052, 0.012, 0.025], pos: [0.023, y - 0.035, z - 0.020], rot: [0, 0, 0.19], color: [0.22, 0.25, 0.28], optic, tag: 'optic-notch' },
    // 两枚侧灯提供对称参照，不再用会被透视拉成长条的中央 sphere。
    { shape: 'box', size: [0.008, 0.018, 0.009], pos: [-0.052, y + 0.020, z - 0.030], color: glow, emissive: 1.15, optic, tag: 'optic-marker' },
    { shape: 'box', size: [0.008, 0.018, 0.009], pos: [0.052, y + 0.020, z - 0.030], color: glow, emissive: 1.15, optic, tag: 'optic-marker' },
  );
  v.opticCenterY = y;
  return v;
}

/** 分段前臂 + 护腕 + 手掌。第一人称不绘制整具身体，避免相机穿入躯干。 */
function addFirstPersonArms(v) {
  const skin = [0.29, 0.245, 0.205];
  const glove = [0.075, 0.085, 0.095];
  const cloth = [0.12, 0.145, 0.17];
  v.parts.push(
    // 右手：握把手掌、护腕、前臂三段，不再是一整块方砖。
    { shape: 'box', size: [0.060, 0.070, 0.075], pos: [0.018, -0.050, -0.020], rot: [0.30, 0, -0.08], color: glove, hand: true, adsBody: true, tag: 'right-palm' },
    { shape: 'box', size: [0.072, 0.040, 0.055], pos: [0.043, -0.075, -0.050], rot: [0.40, 0, -0.10], color: skin, hand: true, adsBody: true, tag: 'right-wrist' },
    { shape: 'box', size: [0.082, 0.065, 0.145], pos: [0.075, -0.105, -0.120], rot: [0.52, 0.05, -0.16], color: cloth, hand: true, tag: 'right-forearm' },
    { shape: 'box', size: [0.088, 0.022, 0.050], pos: [0.066, -0.082, -0.075], rot: [0.46, 0, -0.13], color: [0.035, 0.045, 0.055], hand: true, adsBody: true, tag: 'right-cuff' },
    // 左手：托住护木；ADS 仅保留位于准镜下方的手掌/护腕轮廓。
    { shape: 'box', size: [0.062, 0.055, 0.095], pos: [-0.018, -0.052, -0.245], rot: [-0.08, 0, 0.08], color: glove, hand: true, adsBody: true, tag: 'left-palm' },
    { shape: 'box', size: [0.070, 0.042, 0.055], pos: [-0.040, -0.072, -0.205], rot: [-0.20, 0, 0.10], color: skin, hand: true, adsBody: true, tag: 'left-wrist' },
    { shape: 'box', size: [0.080, 0.065, 0.145], pos: [-0.072, -0.098, -0.135], rot: [-0.38, -0.04, 0.12], color: cloth, hand: true, tag: 'left-forearm' },
    { shape: 'box', size: [0.084, 0.022, 0.050], pos: [-0.052, -0.078, -0.180], rot: [-0.27, 0, 0.10], color: [0.035, 0.045, 0.055], hand: true, adsBody: true, tag: 'left-cuff' },
  );
  return v;
}

function r99Viewmodel() {
  const v = {
    parts: [
      // 机匣
      { shape: 'box', size: [0.075, 0.085, 0.34], pos: [0, 0, -0.06], color: [0.135, 0.142, 0.155], adsBody: true, tag: 'receiver' },
      { shape: 'box', size: [0.086, 0.045, 0.22], pos: [0, -0.045, -0.10], color: [0.10, 0.108, 0.12], adsBody: true, tag: 'lower-receiver' },
      { shape: 'box', size: [0.008, 0.052, 0.19], pos: [-0.043, 0.006, -0.10], color: [0.20, 0.215, 0.235], adsBody: true, tag: 'side-panel' },
      { shape: 'box', size: [0.008, 0.052, 0.19], pos: [0.043, 0.006, -0.10], color: [0.20, 0.215, 0.235], adsBody: true, tag: 'side-panel' },
      // 上机匣/导轨
      { shape: 'box', size: [0.055, 0.028, 0.30], pos: [0, 0.056, -0.06], color: [0.10, 0.105, 0.115], adsBody: true, tag: 'rail' },
      // 枪管
      { shape: 'cyl', r: 0.016, h: 0.20, pos: [0, 0.028, -0.30], rot: [Math.PI / 2, 0, 0], color: [0.085, 0.088, 0.095], tag: 'barrel' },
      { shape: 'box', size: [0.066, 0.057, 0.115], pos: [0, 0.018, -0.255], color: [0.16, 0.17, 0.19], adsBody: true, tag: 'handguard' },
      // 消焰器
      { shape: 'cyl', r: 0.022, h: 0.055, pos: [0, 0.028, -0.40], rot: [Math.PI / 2, 0, 0], color: [0.13, 0.115, 0.10], tag: 'muzzle' },
      // 弹匣（前倾）
      { shape: 'box', size: [0.048, 0.15, 0.075], pos: [0, -0.115, -0.02], rot: [0.13, 0, 0], color: [0.115, 0.12, 0.13], tag: 'magazine', reloadGroup: 'mag' },
      { shape: 'box', size: [0.058, 0.018, 0.085], pos: [0, -0.108, -0.008], rot: [0.13, 0, 0], color: [0.19, 0.20, 0.22], tag: 'mag-base', reloadGroup: 'mag' },
      // 弹匣三道压筋与识别色带随弹匣一起运动，拉出/抛弃/插入过程一眼可辨。
      { shape: 'box', size: [0.052, 0.010, 0.078], pos: [0, -0.074, -0.016], rot: [0.13, 0, 0], color: [0.035, 0.042, 0.052], tag: 'mag-rib', reloadGroup: 'mag' },
      { shape: 'box', size: [0.052, 0.010, 0.078], pos: [0, -0.115, -0.010], rot: [0.13, 0, 0], color: [0.035, 0.042, 0.052], tag: 'mag-rib', reloadGroup: 'mag' },
      { shape: 'box', size: [0.052, 0.010, 0.078], pos: [0, -0.150, -0.005], rot: [0.13, 0, 0], color: [0.21, 0.53, 0.68], emissive: 0.18, tag: 'mag-band', reloadGroup: 'mag' },
      // 握把
      { shape: 'box', size: [0.045, 0.11, 0.06], pos: [0, -0.09, 0.06], rot: [-0.28, 0, 0], color: [0.10, 0.105, 0.115], tag: 'grip' },
      // 枪托
      { shape: 'box', size: [0.045, 0.06, 0.10], pos: [0, 0.005, 0.14], color: [0.125, 0.13, 0.14], tag: 'stock' },
      { shape: 'box', size: [0.062, 0.012, 0.15], pos: [0, 0.045, 0.145], rot: [0.08, 0, 0], color: [0.20, 0.21, 0.23], tag: 'stock-strut' },
      { shape: 'box', size: [0.068, 0.090, 0.024], pos: [0, 0.002, 0.225], rot: [0.08, 0, 0], color: [0.055, 0.06, 0.07], tag: 'butt-pad' },
      // 扳机、护圈、弹匣井唇和双侧上机匣斜面，消除“几块长方体拼枪”的轮廓。
      { shape: 'box', size: [0.012, 0.042, 0.012], pos: [0, -0.051, 0.028], rot: [-0.24, 0, 0], color: [0.025, 0.030, 0.035], tag: 'trigger' },
      { shape: 'box', size: [0.010, 0.050, 0.012], pos: [-0.028, -0.058, 0.030], rot: [0.12, 0, -0.34], color: [0.075, 0.082, 0.092], tag: 'trigger-guard' },
      { shape: 'box', size: [0.010, 0.050, 0.012], pos: [0.028, -0.058, 0.030], rot: [0.12, 0, 0.34], color: [0.075, 0.082, 0.092], tag: 'trigger-guard' },
      { shape: 'box', size: [0.052, 0.010, 0.012], pos: [0, -0.079, 0.036], color: [0.075, 0.082, 0.092], tag: 'trigger-guard' },
      { shape: 'box', size: [0.070, 0.018, 0.092], pos: [0, -0.055, -0.012], color: [0.075, 0.082, 0.094], tag: 'mag-well' },
      { shape: 'wedge', size: [0.020, 0.048, 0.285], pos: [-0.043, 0.026, -0.065], rot: [0, Math.PI, 0], color: [0.27, 0.29, 0.32], tag: 'receiver-bevel' },
      { shape: 'wedge', size: [0.020, 0.048, 0.285], pos: [0.043, 0.026, -0.065], color: [0.27, 0.29, 0.32], tag: 'receiver-bevel' },
      { shape: 'box', size: [0.042, 0.018, 0.048], pos: [0, 0.074, 0.046], color: [0.11, 0.12, 0.135], tag: 'charging-handle', reloadGroup: 'bolt' },
      { shape: 'box', size: [0.012, 0.018, 0.025], pos: [0.047, -0.010, -0.006], color: [0.55, 0.22, 0.08], tag: 'mag-release' },
      // 后照门
      { shape: 'box', size: [0.012, 0.022, 0.012], pos: [0, 0.082, -0.02], color: [0.07, 0.072, 0.08], hideInAds: true },
      // 前准星
      { shape: 'box', size: [0.010, 0.030, 0.010], pos: [0, 0.082, -0.22], color: [0.07, 0.072, 0.08], hideInAds: true },
      // 能量指示条（自发光）
      { shape: 'box', size: [0.012, 0.008, 0.14], pos: [0.041, 0.02, -0.10], color: [0.35, 0.85, 1.0], emissive: 0.8, tag: 'energy-strip' },
      // 三条散热槽与枪机抛壳口，打破大块长方体轮廓。
      { shape: 'box', size: [0.010, 0.014, 0.055], pos: [0.043, 0.030, -0.020], color: [0.025, 0.030, 0.035], tag: 'ejection-port' },
      { shape: 'box', size: [0.010, 0.012, 0.042], pos: [-0.044, 0.020, -0.205], color: [0.025, 0.035, 0.040], tag: 'vent' },
      { shape: 'box', size: [0.010, 0.012, 0.042], pos: [-0.044, 0.020, -0.153], color: [0.025, 0.035, 0.040], tag: 'vent' },
      { shape: 'box', size: [0.010, 0.012, 0.042], pos: [-0.044, 0.020, -0.101], color: [0.025, 0.035, 0.040], tag: 'vent' },
    ],
    hipPos: [0.135, -0.025, -0.42],
    hipRot: [0, -0.055, 0.02],
    // 机瞄时把枪整体向前推，并让照门/准星轴落在屏幕中心。旧值 z=-0.24
    // 会让相机贴进枪托，只能看到“枪屁股”。
    // ADS 时把枪推远，避免机匣/握把堵住光学准星；准星高度仍由 y=-0.082 对齐屏幕中心。
    adsPos: [0, -0.112, -0.52],
    adsRot: [0, 0, 0],
    sprintPos: [0.17, -0.135, -0.26],
    sprintRot: [0.30, -0.48, 0.22],
    slidePos: [0.19, -0.185, -0.28],
    slideRot: [0.52, -0.70, 0.34],
    muzzleLocal: [0, 0.028, -0.44],
    shellEjectLocal: [0.05, 0.02, -0.02],
    scale: 1,
  };
  addReflexOptic(v);
  addFirstPersonArms(v);
  return v;
}

function silverR99Viewmodel() {
  const v = r99Viewmodel();
  v.parts = v.parts.map((p, i) => ({
    ...p,
    // 枪体银白；发光件、瞄具与双手保留材质分区，避免变成无细节白砖。
    color: p.hand || p.optic || p.emissive ? p.color
      : (p.tag === 'vent' || p.tag === 'ejection-port' ? [0.035, 0.045, 0.055]
        : [0.68 + (i % 3) * 0.055, 0.72 + (i % 2) * 0.045, 0.78 + (i % 2) * 0.05]),
  }));
  return v;
}

function heavyViewmodel(scale) {
  const v = r99Viewmodel();
  const s = scale || 1.25;
  const volt = s <= 1.05;
  v.parts = v.parts.map((p) => ({ ...p }));
  for (const p of v.parts) {
    if (p.tag === 'receiver') p.size = [0.082 * s, 0.095 * s, 0.40 * s];
    if (p.tag === 'lower-receiver') p.size = [0.092 * s, 0.050 * s, 0.26 * s];
    if (p.tag === 'rail') p.size = [0.062 * s, 0.026 * s, 0.35 * s];
    if (p.tag === 'barrel') { p.h = 0.28 * s; p.pos = [0, 0.030, -0.40 * s]; }
    if (p.tag === 'handguard') p.size = [0.078 * s, 0.068 * s, 0.18 * s];
    if (p.tag === 'muzzle') p.pos = [0, 0.030, -0.54 * s];
    if (!p.hand && !p.optic && !p.emissive) {
      p.color = volt ? [0.16, 0.25 + ((p.tag === 'side-panel') ? 0.10 : 0), 0.34]
        : [0.24, 0.205 + ((p.tag === 'side-panel') ? 0.08 : 0), 0.17];
    }
  }
  // 独立护木肋条、枪机与能量电容，让平行/电能枪不再只是 R-99 等比放大。
  for (let i = 0; i < 4; i++) {
    v.parts.push({ shape: 'box', size: [0.094 * s, 0.010, 0.025], pos: [0, 0.046, -0.22 - i * 0.045],
      color: volt ? [0.22, 0.55, 0.67] : [0.34, 0.29, 0.22], tag: 'handguard-rib' });
  }
  v.parts.push(
    { shape: 'box', size: [0.014, 0.036, 0.10], pos: [0.050, 0.024, -0.04], color: [0.035, 0.045, 0.055], tag: 'bolt' },
    { shape: 'cyl', r: 0.018, h: 0.10, pos: [-0.052, -0.005, -0.10], rot: [Math.PI / 2, 0, 0],
      color: volt ? [0.26, 0.82, 1.0] : [0.46, 0.38, 0.26], emissive: volt ? 0.9 : 0.05, tag: 'power-cell' },
  );
  v.hipPos = [0.14, -0.025, -0.50];
  v.adsPos = [0, -0.112, -0.58];
  v.muzzleLocal = [0, 0.03, -0.58 * s];
  return v;
}

function shotgunViewmodel() {
  const v = r99Viewmodel();
  v.parts = v.parts.map((p) => ({ ...p }));
  for (const p of v.parts) {
    if (p.tag === 'receiver') p.size = [0.09, 0.10, 0.42];
    if (p.tag === 'barrel') { p.r = 0.026; p.h = 0.32; p.pos = [0, 0.030, -0.40]; }
    if (p.tag === 'handguard') { p.size = [0.095, 0.080, 0.20]; p.pos = [0, 0.005, -0.33]; }
    if (p.tag === 'muzzle') p.pos = [0, 0.030, -0.57];
    if (p.tag === 'magazine' || p.tag === 'mag-base') p.hideInAds = true;
  }
  // 泵动护木、下方管式弹仓与两侧加强筋。
  v.parts.push(
    { shape: 'box', size: [0.105, 0.085, 0.16], pos: [0, -0.010, -0.39], color: [0.18, 0.14, 0.11], tag: 'pump' },
    { shape: 'cyl', r: 0.017, h: 0.34, pos: [0, -0.040, -0.39], rot: [Math.PI / 2, 0, 0], color: [0.075, 0.07, 0.065], tag: 'shell-tube' },
    { shape: 'box', size: [0.012, 0.060, 0.28], pos: [-0.052, 0.005, -0.22], color: [0.31, 0.25, 0.18], tag: 'receiver-rib' },
    { shape: 'box', size: [0.012, 0.060, 0.28], pos: [0.052, 0.005, -0.22], color: [0.31, 0.25, 0.18], tag: 'receiver-rib' },
  );
  v.hipPos = [0.145, -0.025, -0.54];
  v.adsPos = [0, -0.112, -0.62];
  v.muzzleLocal = [0, 0.028, -0.54];
  return v;
}

/** 八边形空心镜筒：所有部件只在边缘，绝不会像旧实心 cylinder 一样堵住目标。 */
function addSniperScope(v, opts = {}) {
  const y = opts.y == null ? 0.112 : opts.y;
  const z = opts.z == null ? -0.09 : opts.z;
  const r = opts.r || 0.050;
  const len = opts.length || 0.29;
  const body = opts.color || [0.065, 0.075, 0.09];
  const rim = opts.rim || [0.14, 0.22, 0.28];
  const optic = true;
  // 八条纵向镜筒骨架；镜筒中心保持完全中空。
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    v.parts.push({ shape: 'box', size: [0.014, 0.014, len],
      pos: [Math.cos(a) * r, y + Math.sin(a) * r, z], rot: [0, 0, a], color: body, optic, tag: 'scope-tube' });
  }
  // 前后八边形压圈，提供“镜片边缘”，但没有不透明镜片。
  for (const zz of [z - len * 0.5, z + len * 0.5]) {
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      v.parts.push({ shape: 'box', size: [0.043, 0.010, 0.014],
        pos: [Math.cos(a) * r * 0.88, y + Math.sin(a) * r * 0.88, zz],
        rot: [0, 0, a + Math.PI / 2], color: rim, optic, tag: 'scope-rim' });
    }
  }
  v.parts.push(
    { shape: 'box', size: [0.070, 0.025, 0.045], pos: [0, y - r - 0.018, z - 0.075], color: body, optic, tag: 'scope-mount' },
    { shape: 'box', size: [0.070, 0.025, 0.045], pos: [0, y - r - 0.018, z + 0.075], color: body, optic, tag: 'scope-mount' },
    { shape: 'cyl', r: 0.018, h: 0.038, pos: [r + 0.022, y, z], rot: [0, 0, Math.PI / 2], color: rim, optic, tag: 'scope-turret' },
  );
  v.opticCenterY = y;
  return v;
}

function sniperViewmodel() {
  const v = r99Viewmodel();
  // 移除卡宾枪反射瞄具，替换为挂在导轨上的空心 4× 镜筒。
  v.parts = v.parts.filter((p) => !p.optic).map((p) => ({ ...p }));
  for (const p of v.parts) {
    if (p.tag === 'receiver') p.size = [0.078, 0.092, 0.52];
    if (p.tag === 'lower-receiver') p.size = [0.085, 0.050, 0.36];
    if (p.tag === 'barrel') { p.h = 0.44; p.pos = [0, 0.030, -0.50]; }
    if (p.tag === 'handguard') { p.size = [0.074, 0.068, 0.25]; p.pos = [0, 0.020, -0.36]; }
    if (p.tag === 'muzzle') p.pos = [0, 0.030, -0.73];
  }
  v.parts.push(
    { shape: 'box', size: [0.018, 0.025, 0.14], pos: [0.050, 0.030, -0.03], color: [0.035, 0.042, 0.052], tag: 'bolt-channel' },
    { shape: 'cyl', r: 0.010, h: 0.075, pos: [0.075, 0.045, 0.015], rot: [0, 0, Math.PI / 2], color: [0.12, 0.13, 0.15], tag: 'bolt-handle' },
  );
  addSniperScope(v);
  v.hipPos = [0.14, -0.030, -0.56];
  v.adsPos = [0, -0.112, -0.68];
  v.muzzleLocal = [0, 0.028, -0.74];
  return v;
}

// 哨兵与长弓共用狙击镜布局，但枪身略短、镜筒更粗，保证 4× ADS 时仍能看清镜框。
function sentinelViewmodel() {
  const v = sniperViewmodel();
  v.parts = v.parts.map((p) => ({ ...p }));
  v.parts = v.parts.map((p, i) => ({
    ...p,
    // 哨兵主色深蓝；手部保留材质，镜筒压圈用亮蓝识别 4× 光学组件。
    color: p.hand ? p.color
      : (p.tag === 'scope-rim' ? [0.08, 0.34, 0.68]
        : [0.035 + (i % 3) * 0.012, 0.09 + (i % 2) * 0.025, 0.19 + (i % 3) * 0.035]),
  }));
  for (const p of v.parts) {
    if (p.tag === 'receiver') p.size = [0.082, 0.100, 0.50];
    if (p.tag === 'barrel') { p.h = 0.40; p.pos = [0, 0.030, -0.47]; }
    if (p.tag === 'muzzle') p.pos = [0, 0.030, -0.69];
  }
  // Sentinel 独有的侧置充能单元。
  v.parts.push(
    { shape: 'cyl', r: 0.024, h: 0.19, pos: [-0.058, -0.005, -0.10], rot: [Math.PI / 2, 0, 0], color: [0.07, 0.35, 0.78], emissive: 0.65, tag: 'charge-cell' },
    { shape: 'box', size: [0.014, 0.030, 0.28], pos: [-0.052, 0.034, -0.17], color: [0.12, 0.48, 0.94], emissive: 0.5, tag: 'charge-rail' },
  );
  v.hipPos = [0.14, -0.030, -0.56];
  v.adsPos = [0, -0.112, -0.68];
  v.muzzleLocal = [0, 0.028, -0.70];
  return v;
}

/**
 * 3 号槽近战视图模型。
 *
 * 不再用两个大方盒冒充拳头：前臂使用低模圆柱，手掌、指节和拇指分件，
 * 因而待机时能看出握拳轮廓。战术刀安装后只替换右手的拳面组件，袖口和
 * 前臂仍然连续，避免刀像悬浮在屏幕上。
 */
function meleeViewmodel() {
  const v = {
    parts: [],
    hipPos: [0, -0.082, -0.47], hipRot: [0, 0, 0],
    adsPos: [0, -0.082, -0.47], adsRot: [0, 0, 0],
    sprintPos: [0, -0.130, -0.42], sprintRot: [0.16, 0, 0],
    slidePos: [0, -0.170, -0.43], slideRot: [0.30, 0, 0],
    muzzleLocal: [0, 0, -0.25], shellEjectLocal: [0, 0, 0], scale: 1,
  };
  const glove = [0.055, 0.070, 0.085];
  const gloveTop = [0.105, 0.125, 0.145];
  const cloth = [0.075, 0.115, 0.155];
  const seam = [0.025, 0.035, 0.050];
  for (const side of [-1, 1]) {
    const x = side * 0.145;
    v.parts.push(
      // 圆柱沿局部 Y 轴，绕 X 后形成由屏幕下沿伸向拳头的前臂。
      { shape: 'cyl', r: 0.047, h: 0.205, pos: [side * 0.158, -0.095, -0.015], rot: [-0.72, 0, side * 0.08], color: cloth, hand: true, meleeSide: side, tag: 'forearm' },
      { shape: 'cyl', r: 0.054, h: 0.050, pos: [side * 0.151, -0.049, -0.096], rot: [-0.72, 0, side * 0.08], color: [0.025, 0.035, 0.050], hand: true, meleeSide: side, tag: 'cuff' },
      { shape: 'box', size: [0.078, 0.010, 0.042], pos: [side * 0.158, -0.081, 0.002], rot: [-0.70, 0, side * 0.08], color: seam, hand: true, meleeSide: side, tag: 'sleeve-seam' },
      // 空手拳面。右手装刀后这些部件隐藏，换成下方的握柄手。
      { shape: 'sphere', size: [0.092, 0.073, 0.105], pos: [x, -0.005, -0.145], rot: [-0.12, side * 0.05, side * 0.06], color: glove, hand: true, meleeSide: side, bareOnly: side === 1, tag: 'palm' },
      { shape: 'box', size: [0.083, 0.020, 0.075], pos: [x, 0.033, -0.157], rot: [-0.10, 0, side * 0.05], color: gloveTop, hand: true, meleeSide: side, bareOnly: side === 1, tag: 'knuckle-plate' },
      { shape: 'sphere', size: [0.033, 0.029, 0.045], pos: [x + side * 0.051, -0.001, -0.150], color: gloveTop, hand: true, meleeSide: side, bareOnly: side === 1, tag: 'thumb' },
    );
    // 四枚独立指节打破“大方块”轮廓；它们随所属手一起做局部攻击动画。
    for (let finger = 0; finger < 4; finger++) {
      v.parts.push({
        shape: 'sphere', size: [0.022, 0.027, 0.035],
        pos: [x + (finger - 1.5) * 0.021, 0.043, -0.180],
        rot: [-0.08, 0, side * 0.04], color: gloveTop,
        hand: true, meleeSide: side, bareOnly: side === 1, tag: `knuckle-${finger}`,
      });
    }
  }
  // 战术刀采用右下斜持姿态：刀尖朝左上、刀柄落在右手掌内。旧版主刃竖直贴近
  // 相机，透视后像一块贯穿屏幕的门板；现在缩短刃宽、推远 Z，并让各部件共用
  // 约 32° 的斜向轴线，能同时读出刀尖、刃腹、护手和握柄。
  v.parts.push(
    { shape: 'sphere', size: [0.078, 0.092, 0.072], pos: [0.170, -0.035, -0.250], rot: [0.08, 0.18, 0.55], color: glove, hand: true, meleeSide: 1, requiresKnife: true, tag: 'knife-palm' },
    { shape: 'cyl', r: 0.026, h: 0.135, pos: [0.168, 0.016, -0.270], rot: [0.05, 0.18, 0.55], color: [0.025, 0.038, 0.050], hand: true, meleeSide: 1, requiresKnife: true, tag: 'knife-grip' },
    { shape: 'sphere', size: [0.060, 0.034, 0.052], pos: [0.205, -0.049, -0.270], rot: [0.05, 0.18, 0.55], color: [0.09, 0.17, 0.22], meleeSide: 1, requiresKnife: true, tag: 'knife-pommel' },
    // 小型指挡，避免再次形成截图中横贯刀柄的粗板。
    { shape: 'box', size: [0.095, 0.014, 0.038], pos: [0.132, 0.080, -0.278], rot: [0.04, 0.18, 0.55], color: [0.055, 0.12, 0.17], meleeSide: 1, requiresKnife: true, tag: 'knife-guard' },
    { shape: 'box', size: [0.018, 0.036, 0.040], pos: [0.087, 0.069, -0.278], rot: [0.04, 0.18, 0.72], color: [0.12, 0.25, 0.31], meleeSide: 1, requiresKnife: true, tag: 'knife-guard-hook' },
    // 30cm 单刃刀身：宽度受控、厚度可见、尖端由专用 blade 网格形成。
    { shape: 'blade', size: [0.135, 0.300, 0.026], pos: [0.063, 0.205, -0.300], rot: [0.04, 0.18, 0.55], color: [0.16, 0.21, 0.24], emissive: 0.012, meleeSide: 1, requiresKnife: true, tag: 'knife-blade' },
    { shape: 'box', size: [0.010, 0.188, 0.030], pos: [0.027, 0.174, -0.306], rot: [0.04, 0.18, 0.55], color: [0.62, 0.70, 0.73], emissive: 0.06, meleeSide: 1, requiresKnife: true, tag: 'knife-edge' },
    { shape: 'box', size: [0.010, 0.148, 0.031], pos: [0.080, 0.196, -0.307], rot: [0.04, 0.18, 0.55], color: [0.035, 0.075, 0.090], meleeSide: 1, requiresKnife: true, tag: 'knife-fuller' },
  );
  // 防滑握柄环槽，让握把在暗处仍有读得出的分段轮廓。
  for (let groove = 0; groove < 3; groove++) {
    v.parts.push({
      shape: 'box', size: [0.056, 0.010, 0.050],
      pos: [0.194 - groove * 0.017, -0.033 + groove * 0.030, -0.272],
      rot: [0.05, 0.18, 0.55], color: [0.12, 0.19, 0.22],
      meleeSide: 1, requiresKnife: true, tag: `knife-grip-ring-${groove}`,
    });
  }
  // 握刀手的四指包住刀柄，轮廓与“黑色球体”区分开。
  for (let finger = 0; finger < 4; finger++) {
    v.parts.push({
      shape: 'cyl', r: 0.014, h: 0.052,
      pos: [0.143 + finger * 0.014, -0.026 + finger * 0.018, -0.298],
      rot: [0.08, 0.18, 0.55], color: gloveTop, hand: true,
      meleeSide: 1, requiresKnife: true, tag: `knife-finger-${finger}`,
    });
  }
  return v;
}

/** 武器表 */
export const WEAPONS = {
  r99: {
    id: 'r99', name: 'R-99', nameCN: 'R-99 冲锋枪', class: 'smg',
    desc: '极高射速，近距离压制力惊人，但弹匣小、后坐力抬头明显。',
    rpm: 1080,
    damage: 18, damageHead: 27, damageLeg: 14,
    pellets: 1,
    // 冲锋枪仍然偏近战，但 42m 前不衰减、150m 后仍保留 85%，不会出现
    // “敌人明明看得见却像射出射程外”的违和感。
    rangeFar: 300, damageFalloffStart: 42, damageFalloffEnd: 150, falloffMinMul: 0.85,
    magSize: 24, reserveMax: Infinity, reloadTime: 0.60, reloadEmptyTime: 0.60,
    adsTime: 0.13, adsSpreadMul: 0.40, adsMoveMul: 0.50, adsFovMul: 0.86,
    hipSpreadBase: 0.62,
    spreadPerShot: 0.155,
    spreadMax: 4.4,
    spreadDecay: 3.4,
    spreadMoveMul: 1.85, spreadAirMul: 2.5, spreadCrouchMul: 0.70, spreadSlideMul: 3.6,
    recoilPitch: 0.30, recoilYaw: 0.14,
    recoilPattern: R99_PATTERN,
    recoilRecovery: 7.8,
    recoilVisualMul: 1.75,
    recoilAimMul: 0.42,
    // R-99 使用低可见度枪口焰（只保留曳光与音效），避免高射速连射遮挡视野。
    muzzleFlashScale: 0, muzzleColor: [1.0, 0.80, 0.40],
    tracerColor: [1.0, 0.76, 0.34], tracerWidth: 0.060, tracerLife: 0.22,
    bulletSpeed: 380,
    fireSound: 'r99_fire', reloadSound: 'r99_reload', emptySound: 'dryfire',
    viewmodel: silverR99Viewmodel(),
    equipTime: 0.32, holsterTime: 0.24,
    adsSwayMul: 0.32,
    color: [0.78, 0.82, 0.88],
    pierceDefault: 1,
  },
  flatline: {
    id: 'flatline', name: 'FLATLINE', nameCN: '平行步枪', class: 'rifle',
    desc: '全自动重型步枪，单发伤害高，腰射精度差但压制力强。',
    rpm: 600,
    damage: 22, damageHead: 33, damageLeg: 17,
    pellets: 1,
    rangeFar: 180, damageFalloffStart: 34, damageFalloffEnd: 90, falloffMinMul: 0.7,
    magSize: 35, reserveMax: Infinity, reloadTime: 1.00, reloadEmptyTime: 1.00,
    adsTime: 0.20, adsSpreadMul: 0.34, adsMoveMul: 0.50, adsFovMul: 0.82,
    hipSpreadBase: 0.95,
    spreadPerShot: 0.30,
    spreadMax: 5.6,
    spreadDecay: 3.0,
    spreadMoveMul: 1.7, spreadAirMul: 2.6, spreadCrouchMul: 0.68, spreadSlideMul: 3.4,
    recoilPitch: 0.62, recoilYaw: 0.26,
    recoilPattern: FLATLINE_PATTERN,
    recoilRecovery: 6.6,
    recoilVisualMul: 1.6,
    recoilAimMul: 0.5,
    muzzleFlashScale: 1.25, muzzleColor: [1.0, 0.72, 0.34],
    tracerColor: [1.0, 0.70, 0.30], tracerWidth: 0.075, tracerLife: 0.24,
    bulletSpeed: 460,
    fireSound: 'flatline_fire', reloadSound: 'r99_reload', emptySound: 'dryfire',
    viewmodel: heavyViewmodel(1.15),
    equipTime: 0.42, holsterTime: 0.32,
    adsSwayMul: 0.28,
    color: [0.38, 0.34, 0.30],
    pierceDefault: 1,
  },
  volt: {
    id: 'volt', name: 'VOLT', nameCN: '电能冲锋枪', class: 'smg',
    desc: '能量弹武器，弹道笔直无下坠，射速与稳定性兼顾。',
    rpm: 780,
    damage: 14, damageHead: 20, damageLeg: 11,
    pellets: 1,
    rangeFar: 320, damageFalloffStart: 50, damageFalloffEnd: 180, falloffMinMul: 0.88,
    magSize: 35, reserveMax: Infinity, reloadTime: 1.6, reloadEmptyTime: 2.05,
    adsTime: 0.15, adsSpreadMul: 0.30, adsMoveMul: 0.50, adsFovMul: 0.86,
    hipSpreadBase: 0.5,
    spreadPerShot: 0.115,
    spreadMax: 3.4,
    spreadDecay: 4.2,
    spreadMoveMul: 1.7, spreadAirMul: 2.4, spreadCrouchMul: 0.72, spreadSlideMul: 3.2,
    recoilPitch: 0.22, recoilYaw: 0.10,
    recoilPattern: VOLT_PATTERN,
    recoilRecovery: 9.5,
    recoilVisualMul: 1.5,
    recoilAimMul: 0.36,
    muzzleFlashScale: 0.9, muzzleColor: [0.45, 0.80, 1.0],
    tracerColor: [0.48, 0.86, 1.0], tracerWidth: 0.070, tracerLife: 0.26,
    bulletSpeed: 520,
    fireSound: 'r99_fire', reloadSound: 'r99_reload', emptySound: 'dryfire',
    viewmodel: heavyViewmodel(1.0),
    equipTime: 0.38, holsterTime: 0.28,
    adsSwayMul: 0.30,
    color: [0.30, 0.42, 0.52],
    pierceDefault: 1,
  },
  peacekeeper: {
    id: 'peacekeeper', name: 'PEACEKEEPER', nameCN: '和平捍卫者', class: 'shotgun',
    desc: '泵动霰弹枪，弹丸密集，近距离一枪可秒杀轻装目标。',
    rpm: 72,
    damage: 12, damageHead: 17, damageLeg: 10,
    pellets: 8,
    rangeFar: 70, damageFalloffStart: 8, damageFalloffEnd: 30, falloffMinMul: 0.22,
    magSize: 6, reserveMax: Infinity, reloadTime: 2.4, reloadEmptyTime: 3.0, shellReload: true,
    adsTime: 0.24, adsSpreadMul: 0.55, adsMoveMul: 0.50, adsFovMul: 0.86,
    hipSpreadBase: 3.4,
    spreadPerShot: 0.0,
    spreadMax: 3.4,
    spreadDecay: 8.0,
    spreadMoveMul: 1.3, spreadAirMul: 1.8, spreadCrouchMul: 0.75, spreadSlideMul: 2.4,
    recoilPitch: 2.4, recoilYaw: 0.5,
    recoilPattern: PEACEKEEPER_PATTERN,
    recoilRecovery: 5.5,
    recoilVisualMul: 1.35,
    recoilAimMul: 0.75,
    muzzleFlashScale: 2.0, muzzleColor: [1.0, 0.66, 0.28],
    tracerColor: [1.0, 0.62, 0.24], tracerWidth: 0.090, tracerLife: 0.22,
    bulletSpeed: 300,
    fireSound: 'shotgun_fire', reloadSound: 'r99_reload', emptySound: 'dryfire',
    viewmodel: shotgunViewmodel(),
    equipTime: 0.5, holsterTime: 0.36,
    adsSwayMul: 0.4,
    color: [0.36, 0.30, 0.24],
    pierceDefault: 1,
  },
  longbow: {
    id: 'longbow', name: 'LONGBOW', nameCN: '长弓精确步枪', class: 'sniper',
    desc: '栓动狙击枪，蓄力后一枪破甲，需要节奏而非连发。',
    rpm: 48,
    damage: 55, damageHead: 110, damageLeg: 44,
    pellets: 1,
    rangeFar: 400, damageFalloffStart: 120, damageFalloffEnd: 260, falloffMinMul: 0.88,
    magSize: 5, reserveMax: Infinity, reloadTime: 2.7, reloadEmptyTime: 3.3,
    adsTime: 0.34, adsSpreadMul: 0.02, adsMoveMul: 0.50, adsFovMul: 0.55,
    hipSpreadBase: 2.6,
    spreadPerShot: 0.9,
    spreadMax: 5.0,
    spreadDecay: 2.2,
    spreadMoveMul: 1.5, spreadAirMul: 2.2, spreadCrouchMul: 0.55, spreadSlideMul: 3.0,
    recoilPitch: 3.2, recoilYaw: 0.4,
    recoilPattern: LONGBOW_PATTERN,
    recoilRecovery: 4.0,
    recoilVisualMul: 1.2,
    recoilAimMul: 0.9,
    muzzleFlashScale: 1.6, muzzleColor: [0.85, 0.90, 1.0],
    tracerColor: [0.80, 0.90, 1.0], tracerWidth: 0.065, tracerLife: 0.32,
    bulletSpeed: 900,
    fireSound: 'sniper_fire', reloadSound: 'r99_reload', emptySound: 'dryfire',
    boltAction: true, boltTime: 0.34, boltSound: 'sniper_bolt',
    viewmodel: sniperViewmodel(),
    equipTime: 0.62, holsterTime: 0.44,
    adsSwayMul: 0.15,
    color: [0.28, 0.32, 0.40],
    pierceDefault: 2,
  },
  sentinel: {
    id: 'sentinel', name: 'SENTINEL', nameCN: '哨兵狙击步枪', class: 'sniper',
    desc: '高精度栓动狙击步枪；按一下 B 为整匣 8 发充能，读条完成后每发均造成强化伤害。',
    rpm: 42,
    damage: 60, damageHead: 120, damageLeg: 48,
    damageCharged: 90, damageHeadCharged: 180, damageLegCharged: 72,
    pellets: 1,
    rangeFar: 500, damageFalloffStart: 150, damageFalloffEnd: 360, falloffMinMul: 0.90,
    magSize: 8, reserveMax: Infinity, reloadTime: 2.00, reloadEmptyTime: 2.00,
    adsTime: 0.30, adsSpreadMul: 0.015, adsMoveMul: 0.50, adsFovMul: 0.25,
    scopeMagnification: 4,
    chargeTime: 1.20,
    hipSpreadBase: 2.8,
    spreadPerShot: 1.0,
    spreadMax: 5.2,
    spreadDecay: 2.0,
    spreadMoveMul: 1.55, spreadAirMul: 2.3, spreadCrouchMul: 0.52, spreadSlideMul: 3.2,
    recoilPitch: 3.5, recoilYaw: 0.42,
    recoilPattern: SENTINEL_PATTERN,
    recoilRecovery: 3.8,
    recoilVisualMul: 1.25,
    recoilAimMul: 0.92,
    muzzleFlashScale: 1.7, muzzleColor: [0.86, 0.92, 1.0],
    tracerColor: [0.72, 0.90, 1.0], tracerWidth: 0.070, tracerLife: 0.36,
    bulletSpeed: 980,
    fireSound: 'sniper_fire', reloadSound: 'r99_reload', emptySound: 'dryfire',
    boltAction: true, boltTime: 0.34, boltSound: 'sniper_bolt',
    viewmodel: sentinelViewmodel(),
    equipTime: 0.62, holsterTime: 0.44,
    adsSwayMul: 0.12,
    color: [0.045, 0.14, 0.34],
    pierceDefault: 2,
  },
  // 近战先遵循完整武器数据契约，输入层将 3 号键接入后无需再改 WeaponSystem。
  melee: {
    id: 'melee', name: 'FISTS', nameCN: '近战', class: 'melee',
    desc: '动力拳套；近距离攻击，不消耗弹药。',
    rpm: 120, damage: 45, damageHead: 60, damageLeg: 45, pellets: 1,
    rangeFar: 2.8, damageFalloffStart: 2.2, damageFalloffEnd: 2.8, falloffMinMul: 0.8,
    magSize: 1, reserveMax: Infinity, reloadTime: 0.20, reloadEmptyTime: 0.20,
    adsTime: 0.10, adsSpreadMul: 1, adsMoveMul: 1, adsFovMul: 1,
    hipSpreadBase: 0.15, spreadPerShot: 0, spreadMax: 0.15, spreadDecay: 12,
    spreadMoveMul: 1, spreadAirMul: 1, spreadCrouchMul: 1, spreadSlideMul: 1,
    recoilPitch: 0.10, recoilYaw: 0.04, recoilPattern: [[0, 0.10]],
    recoilRecovery: 14, recoilVisualMul: 0.5, recoilAimMul: 0,
    muzzleFlashScale: 0, muzzleColor: [0.4, 0.5, 0.6],
    // 数据仍满足通用武器契约；_fire 会对 melee 跳过实际曳光生成。
    tracerColor: [0.4, 0.5, 0.6], tracerWidth: 0.055, tracerLife: 0.13, bulletSpeed: 1,
    fireSound: 'melee_swing', reloadSound: 'dryfire', emptySound: 'dryfire',
    viewmodel: meleeViewmodel(), equipTime: 0.12, holsterTime: 0.10,
    adsSwayMul: 0, color: [0.10, 0.13, 0.16], pierceDefault: 1,
  },
};

export const WEAPON_IDS = ['r99', 'flatline', 'volt', 'peacekeeper', 'longbow', 'sentinel', 'melee'];

// ================================================================ 视图模型

/** 把 def.viewmodel 的部件描述编译为实例矩阵 + 颜色列表 */
function buildViewmodelParts(engine, vm) {
  const meshes = {
    box: engine.createMesh(Geo.unitCube()),
    cyl: engine.createMesh(Geo.unitCylinder(12, true, true)),
    sphere: engine.createMesh(Geo.unitSphere(10, 7)),
    wedge: engine.createMesh(Geo.unitWedge()),
    blade: engine.createMesh(Geo.unitKnifeBlade()),
  };
  const items = [];
  const positions = new Float32Array(3);
  for (const p of vm.parts) {
    const rot = p.rot || [0, 0, 0];
    const size = p.size || [p.r * 2 || 0.05, p.h || 0.05, p.r * 2 || 0.05];
    const m = new Float32Array(16);
    M.m4Compose(p.pos || [0, 0, 0], rot[1] || 0, rot[0] || 0, rot[2] || 0, size, m);
    items.push({
      mesh: p.shape === 'cyl' ? meshes.cyl
        : (p.shape === 'sphere' ? meshes.sphere
          : (p.shape === 'wedge' ? meshes.wedge : (p.shape === 'blade' ? meshes.blade : meshes.box))),
      matrix: m,
      color: p.color || [0.2, 0.2, 0.2],
      hideInAds: !!p.hideInAds,
      // ADS 按语义筛部件：optic 是物理瞄具，adsBody 是位于镜下且不会遮挡目标的手部。
      optic: !!p.optic,
      adsBody: !!p.adsBody,
      requiresKnife: !!p.requiresKnife,
      bareOnly: !!p.bareOnly,
      meleeSide: p.meleeSide || 0,
      tag: p.tag || '',
      emissive: p.emissive || 0,
      reloadGroup: p.reloadGroup || '',
    });
  }
  void positions;
  return { items, meshes };
}

// ================================================================ 武器系统

export class WeaponSystem {
  constructor(engine, world, player, opts = {}) {
    this.engine = engine;
    this.world = world;
    this.player = player;
    this.opts = opts;
    this.enemies = opts.enemies || null;

    this.projectiles = new ProjectilePool(engine, CFG.fx.maxProjectiles);

    // 每把枪的独立状态
    // Apex 风格四槽预留：1=R-99，2=平行步枪，3=近战，4=哨兵。
    this.slots = [{ id: 'r99' }, { id: 'flatline' }, { id: 'melee' }, { id: 'sentinel' }];
    this.slotIndex = 0;
    this.state = new Map();
    for (const id of WEAPON_IDS) {
      this.state.set(id, this._newState(id));
    }

    this.mods = normalizeMods(null);
    // 搜打撤配件按武器独立保存。背包安装后立即参与弹匣、ADS 与充能计算，
    // 不能再出现“捡到扩容弹匣但只是收藏品”的假系统。
    this.lootAttachments = Object.create(null);
    for (const id of WEAPON_IDS) this.lootAttachments[id] = { mag: null, optic: null, charge: null, melee: null };
    this.rng = M.mulberry32(0xC0FFEE);

    // 开火计时
    this._fireTimer = 0;
    this._triggerHeld = false;
    this._triggerEdge = false;
    // 弹匣打空并触发自动换弹后，持续按住左键不能让新弹匣立刻再次开火。
    // 玩家必须先松开扳机；这同时阻断“打空—换弹—再次打空”的无限循环。
    this._requireTriggerRelease = false;

    // 后坐力
    this.recoil = {
      aimPitch: 0, aimYaw: 0,          // 实际影响弹道的偏移（弧度）
      visPitch: 0, visYaw: 0,          // 视觉相机偏移（弧度）
      patternIndex: 0,
      recoveryDelay: 0,
    };

    // 视图模型
    this.vm = {
      meshes: {}, items: [],
      t: 0,
      pos: new Float32Array(3),
      rot: new Float32Array(3),
      bobPhase: 0, bobAmp: 0,
      kick: 0, kickRot: 0,
      meleeT: 1, meleeSide: 1, meleeAttack: 0, meleeWindup: 0,
      equipT: 1, holsterT: 0,
      reloadStage: 0, reloadT: 0,
      sway: new Float32Array(2),
      sprintBlend: 0, slideBlend: 0, airBlend: 0, wallrunBlend: 0,
      lastYaw: 0, lastPitch: 0,
    };
    this._vmCache = new Map();
    this._healVm = null;

    this.stats = { shotsFired: 0, hits: 0, headshots: 0, kills: 0, damageDealt: 0 };
    this._lastHit = null;
    this._equip(this.slots[this.slotIndex].id, true);
  }

  _newState(id) {
    const def = WEAPONS[id];
    return {
      id,
      ammo: def.magSize,
      reserve: def.reserveMax,
      reloading: false,
      reloadT: 0,
      reloadDuration: 0,
      reloadFromEmpty: false,
      reloadCueIndex: 0,
      ads: false,
      adsT: 0,
      // 仅哨兵使用的 B 充能状态；其余武器保持中性值，避免调用方判空。
      chargeT: 0,
      charging: false,
      chargeReady: false,
      chargeShotsRemaining: 0,
      chargeAfterReload: false,
      // 栓动狙击枪：开火后必须完成一次拉栓，下一次扣扳机才会送弹。
      boltT: 0,
      boltDuration: 0,
      bolting: false,
      spread: def.hipSpreadBase,
      spreadExtra: 0,
      shotsFiredThisBurst: 0,
      timeSinceShot: 99,
      chambered: true,
    };
  }

  // ---------------------------------------------------------------- 装备

  get current() {
    const st = this.state.get(this.slots[this.slotIndex].id);
    const def = WEAPONS[st.id];
    return {
      def,
      id: st.id,
      ammo: st.ammo,
      reserve: st.reserve,
      magSize: this._magSize(def),
      reloading: st.reloading,
      reloadProgress: st.reloading ? M.clamp01(st.reloadT / Math.max(0.01, st.reloadDuration)) : 0,
      ads: st.ads,
      adsProgress: st.adsT,
      /** 与 adsProgress 同值，避免调用方猜字段名（缺字段会静默变成 NaN） */
      adsT: st.adsT,
      chargeProgress: def.chargeTime > 0
        ? M.clamp01(st.chargeT / Math.max(0.01, this._chargeTime(def))) : 0,
      charging: !!st.charging,
      chargeReady: !!st.chargeReady,
      chargeShotsRemaining: Math.max(0, Math.floor(st.chargeShotsRemaining || 0)),
      chargeAfterReload: !!st.chargeAfterReload,
      bolting: !!st.bolting,
      boltProgress: st.bolting
        ? M.clamp01(st.boltT / Math.max(0.01, st.boltDuration || def.boltTime || 0.34)) : 0,
      chambered: st.chambered !== false,
      scopeMagnification: def.scopeMagnification || 1,
      spread: st.spread + st.spreadExtra,
      slotIndex: this.slotIndex,
      slots: this.slots.map((s) => s.id),
      fireInterval: this._fireInterval(def),
      recoilAimPitch: this.recoil.aimPitch,
      recoilAimYaw: this.recoil.aimYaw,
      attachments: this.getAttachments(st.id),
    };
  }

  _magSize(def) {
    const equipped = this.lootAttachments && this.lootAttachments[def.id];
    const lootDef = equipped && equipped.mag ? LOOT_DEFS[equipped.mag] : null;
    const lootBonus = lootDef && lootDef.attachment ? (+lootDef.attachment.magAdd || 0) : 0;
    return Math.max(1, Math.round(def.magSize + (this.mods.weapon.magSizeAdd || 0) + lootBonus));
  }

  _chargeTime(def) {
    const equipped = this.lootAttachments && this.lootAttachments[def.id];
    const lootDef = equipped && equipped.charge ? LOOT_DEFS[equipped.charge] : null;
    const mul = lootDef && lootDef.attachment ? (+lootDef.attachment.chargeTimeMul || 1) : 1;
    return Math.max(0.05, (def.chargeTime || 0) * mul);
  }

  _hasOptic(def) {
    const equipped = this.lootAttachments && this.lootAttachments[def.id];
    return !!(equipped && equipped.optic === 'optic_1x');
  }

  _hasKnife() {
    const equipped = this.lootAttachments && this.lootAttachments.melee;
    return !!(equipped && equipped.melee === 'tactical_knife');
  }

  /** 背包双击或拖到武器槽时调用；targetWeaponId 可强制指定拖放目标。 */
  installAttachment(itemId, targetWeaponId = null) {
    const item = LOOT_DEFS[itemId];
    const compatible = item && Array.isArray(item.compatible) ? item.compatible : [];
    const preferred = compatible.includes(this.current.id) ? this.current.id : compatible[0];
    const spec = item && item.equipSlot ? { weaponId: preferred, slot: item.equipSlot, compatible } : null;
    if (spec && targetWeaponId) {
      if (!spec.compatible.includes(targetWeaponId)) return { ok: false, reason: 'incompatible', weaponId: targetWeaponId };
      spec.weaponId = targetWeaponId;
    }
    if (!spec || !this.lootAttachments[spec.weaponId]) return { ok: false, reason: 'incompatible' };
    const equipped = this.lootAttachments[spec.weaponId];
    if (equipped[spec.slot] === itemId) return { ok: false, reason: 'equipped', weaponId: spec.weaponId, slot: spec.slot };
    const previousDef = equipped[spec.slot] ? LOOT_DEFS[equipped[spec.slot]] : null;
    const newRank = item && item.attachment ? (+item.attachment.rank || 0) : 0;
    const oldRank = previousDef && previousDef.attachment ? (+previousDef.attachment.rank || 0) : 0;
    if (previousDef && oldRank >= newRank && newRank > 0) {
      return { ok: false, reason: 'lower_rank', weaponId: spec.weaponId, slot: spec.slot, equipped: equipped[spec.slot] };
    }
    const def = WEAPONS[spec.weaponId];
    const beforeMag = this._magSize(def);
    const replaced = equipped[spec.slot];
    equipped[spec.slot] = itemId;
    const afterMag = this._magSize(def);
    if (afterMag > beforeMag) {
      const st = this.state.get(spec.weaponId);
      st.ammo = Math.min(afterMag, st.ammo + (afterMag - beforeMag));
    }
    Events.emit('weapon:attachment', { itemId, weaponId: spec.weaponId, slot: spec.slot, replaced });
    return { ok: true, weaponId: spec.weaponId, slot: spec.slot, replaced };
  }

  /** 把指定武器槽上的配件卸下，交还给背包系统。 */
  uninstallAttachment(weaponId, slot) {
    const equipped = this.lootAttachments && this.lootAttachments[weaponId];
    if (!equipped || !['mag', 'optic', 'charge', 'melee'].includes(slot) || !equipped[slot]) {
      return { ok: false, reason: 'empty', weaponId, slot };
    }
    const itemId = equipped[slot];
    equipped[slot] = null;
    const def = WEAPONS[weaponId];
    if (def && slot === 'mag') {
      const st = this.state.get(weaponId);
      if (st) st.ammo = Math.min(st.ammo, this._magSize(def));
    }
    Events.emit('weapon:attachment', { itemId: null, weaponId, slot, removed: itemId });
    return { ok: true, itemId, weaponId, slot };
  }

  getAttachments(weaponId) {
    const a = this.lootAttachments && this.lootAttachments[weaponId];
    return a ? { mag: a.mag, optic: a.optic, charge: a.charge, melee: a.melee }
      : { mag: null, optic: null, charge: null, melee: null };
  }

  clearLootAttachments() {
    if (!this.lootAttachments) return;
    for (const id of WEAPON_IDS) this.lootAttachments[id] = { mag: null, optic: null, charge: null, melee: null };
    for (const [id, st] of this.state) st.ammo = Math.min(st.ammo, this._magSize(WEAPONS[id]));
  }

  _fireInterval(def) {
    const rpm = def.rpm * (this.mods.weapon.rpmMul || 1);
    return 60 / Math.max(1, rpm);
  }

  equip(id) {
    if (!WEAPONS[id]) return false;
    const idx = this.slots.findIndex((s) => s.id === id);
    if (idx === this.slotIndex) return false;
    // 切枪采用“瞬切”语义：按键这一帧就完成武器、弹药状态和视图模型切换。
    // 旧版先播放 holster/equip 动画，最快也要 0.24s，导致 Apex 式连招（滑铲跳/切枪
    // 开火）被输入锁住。保留 equipTime/holsterTime 字段供动画/数据兼容，但不再作为
    // 游戏逻辑的等待条件。
    this._pendingEquip = null;
    this.vm.holsterT = 0;
    this._equip(id, true);
    return true;
  }

  next() {
    const i = (this.slotIndex + 1) % this.slots.length;
    return this.equip(this.slots[i].id);
  }

  prev() {
    const i = (this.slotIndex - 1 + this.slots.length) % this.slots.length;
    return this.equip(this.slots[i].id);
  }

  setSlotWeapon(slot, id) {
    if (!WEAPONS[id] || slot < 0 || slot >= this.slots.length) return false;
    this.slots[slot].id = id;
    this.state.set(id, this._newState(id));
    if (slot === this.slotIndex) this._equip(id, true);
    return true;
  }

  /**
   * 将拾取到的枪械装入真实武器槽。3 号槽永久保留近战；哨兵优先进入
   * 4 号额外武器槽，其余枪械进入当前的 1/2 号槽。每把枪在 state Map 中
   * 保留独立弹匣、充能与配件状态，因此这不是只改 HUD 名称。
   */
  installLootWeapon(id, targetSlot = null) {
    const def = WEAPONS[id];
    if (!def || def.class === 'melee') return { ok: false, reason: 'invalid_weapon' };
    const explicitlyTargeted = Number.isInteger(targetSlot);
    let slot = explicitlyTargeted ? targetSlot : -1;
    if (explicitlyTargeted && slot === 2) return { ok: false, reason: 'melee_reserved' };
    if (slot < 0 || slot >= this.slots.length) {
      slot = id === 'sentinel' ? 3 : ([0, 1].includes(this.slotIndex) ? this.slotIndex : 1);
    }
    const existingSlot = this.slots.findIndex(s => s.id === id);
    if (existingSlot >= 0) return { ok: false, reason: 'equipped', weaponId: id, slot: existingSlot };
    const replaced = this.slots[slot].id;
    this.slots[slot] = { id };
    if (!this.state.has(id)) this.state.set(id, this._newState(id));
    if (slot === this.slotIndex) this._equip(id, true);
    Events.emit('weapon:loot-equipped', { weaponId: id, slot, replaced });
    return { ok: true, weaponId: id, slot, replaced };
  }

  _equip(id, instant) {
    const idx = this.slots.findIndex((s) => s.id === id);
    if (idx >= 0) this.slotIndex = idx;
    const def = WEAPONS[id];
    const st = this.state.get(id);
    st.reloading = false;
    st.reloadCueIndex = 0;
    st.ads = false;
    st.adsT = 0;
    // Sentinel 已完成的整匣充能属于该武器弹匣状态，切到别的武器再切回来不能清空。
    // 进行中的充能也保留进度并在重新装备后继续；只有换弹、耗尽强化弹或重置局面
    // 才会取消。非充能武器仍强制保持中性字段，便于调试状态稳定。
    if (!(def.chargeTime > 0)) {
      st.chargeT = 0;
      st.charging = false;
      st.chargeReady = false;
      st.chargeShotsRemaining = 0;
      st.chargeAfterReload = false;
    }
    st.boltT = 0;
    st.boltDuration = 0;
    st.bolting = false;
    st.chambered = true;
    st.spread = def.hipSpreadBase;
    st.spreadExtra = 0;
    st.shotsFiredThisBurst = 0;
    this.recoil.patternIndex = 0;
    this.recoil.aimPitch = 0; this.recoil.aimYaw = 0;
    this.recoil.visPitch = 0; this.recoil.visYaw = 0;
    this._fireTimer = 0;
    // 切枪后重新建立扳机边沿；否则上一把单发枪的按住状态会吞掉
    // 下一次点击，表现为“要按好几下才切成功/开火”。
    this._triggerHeld = false;
    this._requireTriggerRelease = false;
    this.vm.equipT = instant ? 1 : 0;
    this.vm.holsterT = 0;
    this.vm.reloadStage = 0;
    this.vm.reloadT = 0;
    if (!this._vmCache.has(id)) {
      this._vmCache.set(id, buildViewmodelParts(this.engine, def.viewmodel));
    }
    const built = this._vmCache.get(id);
    this.vm.items = built.items;
    this.vm.meshes = built.meshes;
    Events.emit('weapon:switch', { def });
  }

  addModifiers(mods) {
    this.mods = sanitizeWeaponMods(mods);
    // 弹匣上限变化时夹紧当前弹药
    for (const [id, st] of this.state) {
      const def = WEAPONS[id];
      const mag = this._magSize(def);
      if (st.ammo > mag) st.ammo = mag;
      sanitizeState(st);
    }
  }

  resetAmmo() {
    for (const [id, st] of this.state) {
      const def = WEAPONS[id];
      st.ammo = this._magSize(def);
      st.reserve = def.reserveMax;
      st.reloading = false;
      st.reloadT = 0;
      st.reloadDuration = 0;
      st.reloadCueIndex = 0;
      st.chargeT = 0;
      st.charging = false;
      st.chargeReady = false;
      st.chargeShotsRemaining = 0;
      st.chargeAfterReload = false;
      st.bolting = false;
      st.boltT = 0;
      st.boltDuration = 0;
      st.chambered = true;
    }
  }

  /** 新部署恢复制式四槽；撤离获得的稀有枪械由仓库作为物品重新带入。 */
  resetLoadout() {
    this.slots = [{ id: 'r99' }, { id: 'flatline' }, { id: 'melee' }, { id: 'sentinel' }];
    this.slotIndex = 0;
    this._pendingEquip = null;
    this._equip('r99', true);
    return this.slots.map((s) => s.id);
  }

  /** 野战补给：补满所有武器弹匣与备弹，并取消未完成的换弹。 */
  refillAmmo() {
    let weapons = 0;
    let rounds = 0;
    for (const [id, st] of this.state) {
      const def = WEAPONS[id];
      const mag = this._magSize(def);
      // 备弹为无限时只统计弹匣补充量，避免 Infinity - Infinity 产生 NaN。
      const reserveGain = Number.isFinite(def.reserveMax) && Number.isFinite(st.reserve)
        ? Math.max(0, def.reserveMax - st.reserve) : 0;
      rounds += Math.max(0, mag - st.ammo) + reserveGain;
      st.ammo = mag;
      st.reserve = def.reserveMax;
      st.reloading = false;
      st.reloadT = 0;
      st.reloadDuration = 0;
      st.reloadCueIndex = 0;
      st.chargeT = 0;
      st.charging = false;
      st.chargeReady = false;
      st.chargeShotsRemaining = 0;
      st.chargeAfterReload = false;
      st.bolting = false;
      st.boltT = 0;
      st.boltDuration = 0;
      st.chambered = true;
      weapons++;
    }
    this.vm.reloadStage = 0;
    this.vm.reloadT = 0;
    return { weapons, rounds };
  }

  // ---------------------------------------------------------------- 更新

  update(dt, input) {
    if (input.slot1Pressed && this.slotIndex !== 0) this.equip(this.slots[0].id);
    else if (input.slot2Pressed && this.slotIndex !== 1) this.equip(this.slots[1].id);
    else if (input.slot3Pressed && this.slotIndex !== 2) this.equip(this.slots[2].id);
    else if (input.slot4Pressed && this.slotIndex !== 3) this.equip(this.slots[3].id);
    else if (input.swapPressed) this.next();
    const st = this.state.get(this.slots[this.slotIndex].id);
    const def = WEAPONS[st.id];
    const W = this.mods.weapon;

    // 数值守卫：任何 NaN 一旦进入 adsT/spread 就会经 HUD 扩散到玩家可见界面，
    // 并且很难回溯源头。在这里做一次廉价的有限性检查，坏值立刻回落到安全值。
    if (!Number.isFinite(st.adsT)) st.adsT = 0;
    if (!Number.isFinite(st.spreadExtra)) st.spreadExtra = 0;
    if (!Number.isFinite(st.reloadT)) st.reloadT = 0;
    if (!Number.isFinite(st.reloadDuration) || st.reloadDuration <= 0) {
      st.reloadDuration = def.reloadTime;
    }

    // 切枪过渡
    if (this.vm.holsterT > 0) {
      this.vm.holsterT -= dt;
      if (this.vm.holsterT <= 0 && this._pendingEquip) {
        const pe = this._pendingEquip;
        this._pendingEquip = null;
        this.slotIndex = pe.idx;
        this._equip(pe.id, false);
      }
      return;
    }
    if (this.vm.equipT < 1) {
      this.vm.equipT = Math.min(1, this.vm.equipT + dt / Math.max(0.05, def.equipTime * (W.switchSpeedMul || 1)));
    }

    // 后坐力回落
    this._updateRecoil(dt);

    // 扩散衰减
    st.timeSinceShot += dt;
    const decay = def.spreadDecay * dt;
    st.spreadExtra = Math.max(0, st.spreadExtra - decay);
    st.shotsFiredThisBurst = st.timeSinceShot > 0.28 ? 0 : st.shotsFiredThisBurst;

    // 开镜
    const wantAds = !!input.ads && !st.reloading;
    st.ads = wantAds;
    const adsRate = dt / Math.max(0.02, def.adsTime * (W.adsTimeMul || 1));
    st.adsT = M.clamp01(st.adsT + (wantAds ? adsRate : -adsRate));
    // 1× 全息并非纯 UI 图标：安装后视野略宽、抖动和散布更小。
    const opticFov = this._hasOptic(def) ? M.lerp(def.adsFovMul, 0.94, 0.42) : def.adsFovMul;
    this.player.setAdsFovMul(M.lerp(1, opticFov, st.adsT));

    // 栓动狙击枪：每次开火后进入短暂拉栓阶段。拉栓完成的这一帧
    // 才重新装填下一发，避免连续扣扳机时出现“枪响了但没有送弹”的假射击。
    if (def.boltAction && st.bolting) {
      st.boltT = Math.min(st.boltDuration, st.boltT + dt);
      if (st.boltT >= Math.max(0.01, st.boltDuration)) this._finishBoltCycle(st, def);
    }

    // 哨兵充能：按一下 B 即开始读条；完成后整匣（最多 8 发）都使用强化伤害。
    // 充能不再要求一直按住，也不需要松键确认；弹匣不满时会先自动换弹，
    // 换弹完成后立即进入充能读条，确保一次 B 操作拿到完整弹匣强化。
    if (def.chargeTime > 0) {
      if (st.reloading) {
        if (input.chargePressed) {
          // 换弹中重新按 B 明确表示“新弹匣重新充满”，完成后覆盖旧余量。
          st.chargeAfterReload = true;
          st.chargeT = 0;
          st.charging = false;
          st.chargeReady = false;
          st.chargeShotsRemaining = 0;
        }
      } else if (input.chargePressed && !st.bolting && !st.charging && !st.chargeReady) {
        const mag = this._magSize(def);
        if (st.ammo < mag && st.reserve > 0) {
          // B 自动补满弹匣；_finishReload 会接着开始充能。
          this._startReload(st, def, { chargeAfterReload: true });
        } else {
          st.chargeAfterReload = false;
          st.chargeT = 0;
          st.charging = true;
          st.chargeShotsRemaining = 0;
          Events.emit('weapon:charge', { def, start: true, autoReload: false });
        }
      }
      if (st.charging) {
        // 充能是一次按键触发的持续读条；不要在每帧把计时器清零，
        // 否则读条永远停在 0，B 键看起来就像“没有反应”。
        const chargeTime = this._chargeTime(def);
        st.chargeT = Math.min(chargeTime, st.chargeT + dt);
        if (st.chargeT >= chargeTime) {
          st.charging = false;
          st.chargeReady = true;
          st.chargeShotsRemaining = Math.min(this._magSize(def), Math.max(0, st.ammo));
          Events.emit('weapon:charge', { def, start: false, shots: st.chargeShotsRemaining });
        }
      }
    } else {
      st.chargeT = 0;
      st.charging = false;
      st.chargeReady = false;
      st.chargeShotsRemaining = 0;
      st.chargeAfterReload = false;
    }

    // 换弹
    if (st.reloading) {
      st.reloadT += dt;
      const prog = st.reloadT / st.reloadDuration;
      // 每个可见动作都有独立同步音效。用 while 补齐跨过的拍点，避免卡顿帧
      // 直接跳过“丢匣/取新匣”等关键声音。
      while (st.reloadCueIndex < RELOAD_CUES.length
        && prog >= RELOAD_CUES[st.reloadCueIndex].at) {
        const cue = RELOAD_CUES[st.reloadCueIndex];
        this.vm.reloadStage = st.reloadCueIndex + 1;
        const isBoltCue = st.reloadCueIndex === RELOAD_CUES.length - 1;
        Events.emit('audio:play', {
          name: isBoltCue && def.boltAction ? (def.boltSound || 'sniper_bolt') : cue.sound,
          gain: cue.gain,
          // 短换弹略提高音高，长换弹略压低；限制范围避免机械声失真。
          rate: M.clamp(1.04 - (st.reloadDuration - 0.60) * 0.055, 0.92, 1.06),
        });
        st.reloadCueIndex++;
      }
      if (st.reloadT >= st.reloadDuration) {
        this._finishReload(st, def);
      }
    } else if (input.reloadPressed && st.ammo < this._magSize(def) && st.reserve > 0) {
      this._startReload(st, def);
    }

    // 开火（全自动 / 单发；狙击与霰弹需要重新扣扳机）
    // 只推进当前冷却，不保存负数“射击欠账”。1.0 的补发 while 在较轻的
    // 旧场景里不明显，但 2.0 未命中时的长距离世界判定更重，卡顿后会把多发
    // 欠账一次扣掉，表现为弹匣瞬空。每次 update 最多只允许一次真实开火。
    this._fireTimer = Math.max(0, this._fireTimer - dt);
    if (!input.fire) this._requireTriggerRelease = false;
    const fullAuto = def.class !== 'sniper' && def.class !== 'shotgun' && def.class !== 'melee';
    const charging = def.chargeTime > 0 && st.charging;
    const boltLocked = !!def.boltAction && (!st.chambered || st.bolting);
    const wantsFire = (fullAuto ? !!input.fire : (!!input.fire && !this._triggerHeld))
      && !this._requireTriggerRelease && !charging && !boltLocked;

    if (wantsFire && this.vm.equipT >= 1 && !st.reloading && this._fireTimer <= 0) {
      if (st.ammo <= 0) {
        Events.emit('audio:play', { name: def.emptySound });
        if (st.reserve > 0) {
          this._requireTriggerRelease = true;
          this._startReload(st, def);
        }
        this._fireTimer = 0.22;
      } else {
        this._fire(st, def, input);
        if (def.boltAction) {
          // 栓动枪的下一次可射击时间由拉栓决定，而不是再叠加一段
          // 过长的 RPM 间隔；拉栓结束后扣扳机即可开火。
          this._fireTimer = Math.max(0.01, st.boltDuration || def.boltTime || 0.34);
        } else {
          this._fireTimer = this._fireInterval(def);
        }
      }
    }
    this._triggerHeld = !!input.fire;

    // 视图模型动画
    this._updateViewmodel(dt, st, def, input);
    this.projectiles.update(dt, this.world, this.enemies);
  }

  _startReload(st, def, opts = {}) {
    const W = this.mods.weapon;
    // Sentinel 普通 R 换弹只更换实体弹药，不会抹掉剩余强化次数。例如还剩 5 发
    // 强化时提前换弹，换完仍有 5 发强化。只有 B 触发的“换满后重新充能”才清旧值。
    const keepCharge = def.chargeTime > 0 && opts.chargeAfterReload !== true
      && st.chargeReady === true && st.chargeShotsRemaining > 0;
    if (!keepCharge) {
      st.chargeT = 0;
      st.charging = false;
      st.chargeReady = false;
      st.chargeShotsRemaining = 0;
    }
    // 只有 Sentinel 的 B 操作会把换弹标记为“换完立即充能”；
    // 普通 R 换弹必须清掉旧标记，避免下一次误触发自动充能。
    st.chargeAfterReload = opts.chargeAfterReload === true;
    // 主动换弹可以打断拉栓动作；新弹匣装入后枪膛视为已就绪。
    if (def.boltAction) {
      st.bolting = false;
      st.boltT = 0;
      st.boltDuration = 0;
      st.chambered = true;
    }
    st.reloading = true;
    st.reloadFromEmpty = st.ammo <= 0;
    st.reloadT = 0;
    const base = st.reloadFromEmpty ? def.reloadEmptyTime : def.reloadTime;
    st.reloadDuration = base * (W.reloadTimeMul || 1);
    st.reloadCueIndex = 0;
    this.vm.reloadStage = 0;
    this.vm.reloadT = 0;
    st.ads = false;
    Events.emit('weapon:reload', { def, start: true, duration: st.reloadDuration });
  }

  _finishReload(st, def) {
    const W = this.mods.weapon;
    const mag = this._magSize(def);
    const need = mag - st.ammo;
    const take = Math.min(need, st.reserve);
    st.ammo += take;
    st.reserve -= take;
    if (W.ammoRefundOnHeadshotAdd) { /* 由击杀/爆头事件单独处理 */ }
    st.reloading = false;
    st.reloadT = 0;
    st.reloadCueIndex = 0;
    this.vm.reloadStage = 0;
    Events.emit('weapon:reload', { def, start: false, duration: 0 });

    // Sentinel 按 B 时若弹匣不满，会先自动补满；换弹刚结束立刻进入
    // 整匣充能读条，不要求玩家再次按 B。
    if (def.chargeTime > 0 && st.chargeAfterReload && st.ammo > 0) {
      st.chargeAfterReload = false;
      st.chargeT = 0;
      st.charging = true;
      st.chargeReady = false;
      st.chargeShotsRemaining = 0;
      Events.emit('weapon:charge', { def, start: true, autoReload: true });
    } else {
      st.chargeAfterReload = false;
    }
  }

  /** 栓动狙击枪开火后的拉栓周期。拉栓期间锁定扳机，避免连点出现假射击。 */
  _startBoltCycle(st, def) {
    if (!def || !def.boltAction) return;
    st.bolting = true;
    st.chambered = false;
    st.boltT = 0;
    st.boltDuration = Math.max(0.01, Number(def.boltTime) || 0.34);
    Events.emit('weapon:bolt', { def, start: true, duration: st.boltDuration });
    Events.emit('audio:play', { name: def.boltSound || 'sniper_bolt', gain: 0.95 });
  }

  /** 拉栓完成后才把下一发送入膛内；完成时不额外叠加 RPM 等待。 */
  _finishBoltCycle(st, def) {
    if (!def || !def.boltAction) return;
    st.bolting = false;
    st.chambered = true;
    st.boltT = 0;
    st.boltDuration = 0;
    // 拉栓完成即允许下一次扣扳机，不再残留旧 RPM 间隔。
    this._fireTimer = Math.min(0, this._fireTimer);
    Events.emit('weapon:bolt', { def, start: false, duration: 0 });
  }

  cancelReload() {
    const st = this.state.get(this.slots[this.slotIndex].id);
    st.reloading = false;
    st.chargeAfterReload = false;
    this.vm.reloadStage = 0;
  }

  // ---------------------------------------------------------------- 开火

  /**
   * 开火。返回本次射击的结果（用于调试）。
   * 判定用即时射线；视觉用高速弹丸，两者方向完全一致。
   */
  _fire(st, def, input) {
    const W = this.mods.weapon;
    const player = this.player;
    // 充能状态在本发开始时锁存；开火后立即消耗，避免切枪/连点重复使用强化伤害。
    const charged = def.chargeTime > 0 && st.chargeReady === true && st.chargeShotsRemaining > 0;
    if (def.class !== 'melee') st.ammo--;
    st.timeSinceShot = 0;
    st.shotsFiredThisBurst++;
    this.stats.shotsFired++;
    if (def.class === 'melee') {
      this.vm.meleeT = 0;
      // 拳头左右交替；装备刀后固定使用右手做清晰的斜向挥砍。
      this.vm.meleeSide = this._hasKnife() ? 1 : -this.vm.meleeSide;
    }

    // 当前扩散（度 -> 弧度）
    let spreadDeg = this._computeSpread(st, def);
    // 首发射击精度加成
    if (st.shotsFiredThisBurst === 1 && def.pierceDefault) {
      spreadDeg *= (W.firstShotSpreadMul || 1);
    }
    const spreadRad = M.toRad(spreadDeg);

    // 开火原点与基础方向
    const origin = FIRE_O;
    const eye = player.eyePos;
    origin[0] = eye[0]; origin[1] = eye[1]; origin[2] = eye[2];
    const baseDir = FIRE_D;
    this._aimDir(baseDir);

    const pellets = Math.max(1, def.pellets);
    const results = [];
    for (let p = 0; p < pellets; p++) {
      const dir = FIRE_D2;
      if (spreadRad > 1e-5) M.randomConeDir(baseDir, spreadRad, this.rng, dir);
      else { dir[0] = baseDir[0]; dir[1] = baseDir[1]; dir[2] = baseDir[2]; }
      results.push(this._hitscan(origin, dir, def, st, charged));
    }

    if (charged) {
      st.chargeShotsRemaining = Math.max(0, st.chargeShotsRemaining - 1);
      if (st.chargeShotsRemaining <= 0) {
        st.chargeT = 0;
        st.charging = false;
        st.chargeReady = false;
      }
    }

    // 后坐力：弹道序列 + 随机抖动
    this._applyRecoil(def, st);

    // 视觉与音频反馈
    const muzzleWorld = MUZZLE_W;
    this._muzzleWorldPos(muzzleWorld, def);
    // 曳光从真实枪口而非相机原点出发，避免近裁剪面把它放大成整屏色块。
    if (def.class !== 'melee') {
      this.projectiles.spawnTracer(muzzleWorld, results[0] ? results[0].endPoint : null, {
        color: def.tracerColor, width: def.tracerWidth, life: def.tracerLife,
        // 命中点常在百米外，若只画枪口到命中点的一小段就看不见；
        // 这里给一个最小可见长度，并沿弹道方向延伸。
        dir: baseDir, minLength: def.class === 'shotgun' ? 5 : 12, length: 30,
      });
    }
    if (def.muzzleFlashScale > 0) {
      this.projectiles.spawnMuzzleFlash(muzzleWorld, baseDir, def.muzzleColor, def.muzzleFlashScale);
    } else {
      // 清除上一把武器残留的枪口焰（例如切到 R-99 的瞬间）。
      this.projectiles.flashTime = 0;
      this.projectiles.flashWorldTime = 0;
    }
    Events.emit('weapon:fire', { def, ammo: st.ammo, charged, origin: Array.from(muzzleWorld), dir: Array.from(baseDir), end: results[0]?.endPoint ? Array.from(results[0].endPoint) : null });
    Events.emit('audio:play', { name: def.fireSound, gain: 0.9 });
    // 开火不再产生额外的随机屏幕震动；枪械本身的后坐/压枪仍正常保留。
    // 想恢复抖动：把 CFG.fx.fireScreenShake 设为 true。
    if (CFG.fx.fireScreenShake) {
      Events.emit('fx:shake', {
        amount: def.recoilPitch * 0.05 * (W.recoilMul || 1) * CFG.fx.screenShakeScale,
        time: 0.06,
      });
    }
    // 视图模型后坐
    this.vm.kick = Math.min(1.4, this.vm.kick + 0.55 * (W.recoilMul || 1));
    this.vm.kickRot = Math.min(0.5, this.vm.kickRot + 0.09 * (W.recoilMul || 1));
    if (def.boltAction) this._startBoltCycle(st, def);
    void input;
    return results;
  }

  _computeSpread(st, def) {
    const W = this.mods.weapon;
    const p = this.player.state;
    let s = def.hipSpreadBase;
    if (st.adsT > 0) {
      const opticSpread = this._hasOptic(def) ? def.adsSpreadMul * 0.82 : def.adsSpreadMul;
      s = M.lerp(s, s * opticSpread, st.adsT);
    }
    // 连发累积
    s += st.spreadExtra;
    // 移动/姿态倍率
    let mul = 1;
    const speed = p.hspeed;
    if (speed > 1.2) {
      const moveBlend = M.clamp01(speed / Math.max(1, CFG.move.walkSpeed));
      const m = M.lerp(1, def.spreadMoveMul * (W.moveSpreadMul || 1), moveBlend);
      mul *= M.lerp(1, m, 1 - st.adsT * 0.65);
    }
    if (!p.grounded) {
      if (p.wallRunning) mul *= 0.62;          // 蹬墙跑时反而更稳（Apex 手感）
      else mul *= M.lerp(1, def.spreadAirMul, 1 - st.adsT * 0.5);
    }
    if (p.sliding) mul *= def.spreadSlideMul;
    else if (p.crouching) mul *= def.spreadCrouchMul;
    if (p.mantling || p.dashing || p.grappleActive) mul *= 2.2;
    s *= mul;
    return Math.max(0.02, s * (W.spreadMul || 1));
  }

  /**
   * 准心方向必须与玩家此帧实际看到的相机方向一致。
   *
   * 旧实现用较小的 aimPitch 做命中、用较大的 visPitch 抬相机；连续射击后相机
   * 已经看向上方，射线却仍指向更低的位置，于是曳光和命中点会落在屏幕准心
   * 下方。这里统一使用视觉相机后坐通道，玩家始终是“屏幕中心指哪就打哪”。
   */
  _aimDir(out) {
    const player = this.player;
    const yaw = player.yaw + this.recoil.visYaw;
    const pitch = M.clamp(player.pitch + this.recoil.visPitch,
      -CFG.cam.pitchLimit, CFG.cam.pitchLimit);
    return M.dirFromAngles(yaw, pitch, out);
  }

  /** 单个弹丸的即时射线判定：先敌人，后世界 */
  _hitscan(origin, dir, def, st, charged = false) {
    const W = this.mods.weapon;
    const maxDist = def.rangeFar * (W.rangeMul || 1);
    const res = {
      hit: false, enemy: null, point: null, endPoint: null,
      damage: 0, headshot: false, legshot: false, killed: false, dist: maxDist,
    };

    // 敌人
    let enemyHit = null;
    if (this.enemies) {
      enemyHit = this.enemies.raycastEnemies(origin, dir, maxDist);
    }
    // 世界
    const worldHit = this.world.raycast(origin, dir, maxDist, { hitTriangles: true, hitBoxes: true });

    const enemyT = enemyHit ? enemyHit.t : Infinity;
    const worldT = worldHit.hit ? worldHit.t : Infinity;

    const query = { origin, dir, maxDistance: Math.min(maxDist, enemyT, worldT), hit: null };
    Events.emit('net:raycast-player', query);
    if (query.hit && query.hit.t <= query.maxDistance) {
      const hit = query.hit;
      const body = charged && def.damageCharged != null ? def.damageCharged : def.damage;
      const head = charged && def.damageHeadCharged != null ? def.damageHeadCharged : (def.damageHead || body);
      const damage = (hit.headshot ? head : body) * this._falloff(def, hit.t) * (W.damageMul || 1);
      Events.emit('net:damage-player', { targetId: hit.id, damage, headshot: !!hit.headshot, point: Array.from(hit.point), dir: Array.from(dir) });
      return { ...res, hit: true, playerId: hit.id, point: hit.point, endPoint: hit.point, damage, headshot: !!hit.headshot, dist: hit.t };
    }

    if (enemyHit && enemyT <= worldT) {
      // 距离衰减
      const falloff = this._falloff(def, enemyT);
      const bodyDamage = charged && def.damageCharged != null ? def.damageCharged : def.damage;
      const headDamage = charged && def.damageHeadCharged != null ? def.damageHeadCharged : def.damageHead;
      const legDamage = charged && def.damageLegCharged != null ? def.damageLegCharged : def.damageLeg;
      let dmg = bodyDamage;
      if (enemyHit.headshot) dmg = headDamage;
      else if (enemyHit.legshot) dmg = legDamage;
      dmg *= falloff * (W.damageMul || 1);
      if (def.class === 'melee' && this._hasKnife()) dmg *= 1.3;
      if (enemyHit.headshot) dmg *= (W.damageHeadMul || 1);

      // 暴击（crit_matrix）
      let crit = false;
      if (W.critChanceAdd > 0 && this.rng() < W.critChanceAdd) {
        crit = true;
        dmg *= 2 * (W.critDamageMul || 1);
      }
      // 速度转伤害（kinetic_converter）
      if (W.speedToDamageAdd > 0) {
        dmg *= 1 + this.player.state.hspeed * W.speedToDamageAdd;
      }
      // 连杀增伤（kill_combo）
      if (this._comboDamageMul) dmg *= this._comboDamageMul;

      const r = this.enemies.damage(enemyHit.enemy, dmg, enemyHit.headshot, enemyHit.point, enemyHit.normal, {
        crit, legshot: enemyHit.legshot, def,
      });
      if (def.class === 'melee') Events.emit('audio:play', { name: 'melee_hit', gain: 1.0 });
      res.hit = true;
      res.enemy = enemyHit.enemy;
      res.point = enemyHit.point;
      res.endPoint = enemyHit.point;
      res.damage = dmg;
      res.headshot = enemyHit.headshot;
      res.legshot = enemyHit.legshot;
      res.killed = !!(r && r.killed);
      res.dist = enemyT;

      this.stats.hits++;
      if (res.headshot) this.stats.headshots++;
      this.stats.damageDealt += dmg;

      const appliedDamage = r && Number.isFinite(r.damage) ? r.damage : dmg;

      // 附加效果
      this._applyOnHitEffects(enemyHit.enemy, enemyHit.point, enemyHit.normal, def, res);

      Events.emit('hit:enemy', {
        // HUD/战报显示实际扣除量；护盾减伤或护盾吸收不会再虚报枪械面板伤害。
        damage: appliedDamage, shieldDamage: r && r.shieldDamage || 0,
        healthDamage: r && r.healthDamage || 0,
        shieldHit: !!(r && r.shieldHit), shieldBreak: !!(r && r.shieldBreak),
        headshot: res.headshot, kill: res.killed,
        point: enemyHit.point, enemy: enemyHit.enemy, crit,
        charged,
      });
      // 命中音效由 Enemies.damage 按实际结算层触发：护盾播 hit_armor，
      // 生命播 hit_flesh/hit_head，破盾另播清脆的 shield_break。这样命中
      // 有甲目标时不会再把每一发都误报成肉体命中。
      // 命中反馈用命中标记（hitmarker）表达即可，不再叠加屏幕抖动 ——
      // 高射速武器下每发都抖会让画面一直在晃，玩家明确反馈要取消。
      if (CFG.fx.fireScreenShake) Events.emit('fx:shake', { amount: 0.03, time: 0.05 });
    } else if (worldHit.hit) {
      res.endPoint = worldHit.point;
      res.dist = worldHit.t;
      // 世界命中没有敌人的部位伤害变量；必须独立计算，不能引用上方块内 dmg。
      const worldDamage = (charged && def.damageCharged != null ? def.damageCharged : def.damage)
        * this._falloff(def, worldHit.t) * (W.damageMul || 1);
      Events.emit('hit:world', {
        point: worldHit.point, normal: worldHit.normal, kind: worldHit.kind,
        flags: worldHit.flags, damage: worldDamage,
      });
      // 穿透：命中世界后按剩余穿透数继续（简化：只在敌人穿透时生效）
    } else {
      res.endPoint = null;
    }

    // 穿透：如果命中的是敌人且还有穿透数，继续向后打
    let pierce = (def.pierceDefault || 1) + (W.penetrationAdd || 0);
    let curOrigin = PIERCE_O;
    let curT = 0;
    while (res.hit && enemyHit && pierce > 1 && this.enemies) {
      pierce--;
      curT += enemyT + 0.35;
      if (curT > maxDist) break;
      curOrigin[0] = origin[0] + dir[0] * curT;
      curOrigin[1] = origin[1] + dir[1] * curT;
      curOrigin[2] = origin[2] + dir[2] * curT;
      const remaining = maxDist - curT;
      const next = this.enemies.raycastEnemies(curOrigin, dir, remaining);
      if (!next) break;
      const falloff = this._falloff(def, curT + next.t);
      const bodyDamage = charged && def.damageCharged != null ? def.damageCharged : def.damage;
      const headDamage = charged && def.damageHeadCharged != null ? def.damageHeadCharged : def.damageHead;
      const nextBase = next.headshot ? headDamage : bodyDamage;
      let dmg = nextBase * falloff * (W.damageMul || 1) * 0.72;
      const rr = this.enemies.damage(next.enemy, dmg, next.headshot, next.point, next.normal, { def });
      res.damage += dmg;
      res.pierceCount = (res.pierceCount || 0) + 1;
      Events.emit('hit:enemy', {
        damage: dmg, headshot: next.headshot, kill: !!(rr && rr.killed),
        point: next.point, enemy: next.enemy, crit: false, charged,
      });
      enemyHit = next;
      curT += next.t;
      // 只在穿透后还命中时继续
    }

    void st;
    return res;
  }

  _falloff(def, dist) {
    const W = this.mods.weapon;
    const start = def.damageFalloffStart * (W.rangeMul || 1);
    const end = def.damageFalloffEnd * (W.rangeMul || 1);
    if (dist <= start) return 1;
    if (dist >= end) return def.falloffMinMul * (W.falloffMinMul || 1) / 1;
    const t = (dist - start) / Math.max(0.01, end - start);
    return M.lerp(1, def.falloffMinMul, t);
  }

  _applyOnHitEffects(enemy, point, normal, def, res) {
    const W = this.mods.weapon;
    if (!this.enemies) return;
    if (W.bleedDotAdd > 0) {
      this.enemies.applyStatus(enemy, 'bleed', W.bleedDotAdd * (def.damage / 15), 4.0);
    }
    if (W.slowOnHitAdd > 0) {
      this.enemies.applyStatus(enemy, 'slow', W.slowOnHitAdd, 1.6);
    }
    if (W.explosiveRoundsAdd > 0) {
      const r = 3.4;
      const dmg = def.damage * 0.6 * W.explosiveRoundsAdd;
      this.enemies.explosion(point, r, dmg, { exclude: enemy });
    }
    if (W.chainLightningAdd > 0) {
      const targets = this.enemies.nearestEnemies(point, 2, 9);
      for (const t of targets) {
        if (t === enemy) continue;
        this.enemies.damage(t, def.damage * 0.45 * W.chainLightningAdd, false, t.pos, null, { def });
      }
      void normal;
    }
    if (W.ammoRefundOnHeadshotAdd > 0 && res.headshot) {
      const st = this.state.get(this.slots[this.slotIndex].id);
      st.ammo = Math.min(this._magSize(def), st.ammo + W.ammoRefundOnHeadshotAdd);
    }
  }

  /** 弹道序列后坐力 + 随机水平抖动 */
  _applyRecoil(def, st) {
    const W = this.mods.weapon;
    const mul = (W.recoilMul || 1);
    const pat = def.recoilPattern;
    const idx = Math.min(pat.length - 1, this.recoil.patternIndex);
    const entry = pat[idx] || [0, def.recoilPitch];
    this.recoil.patternIndex = Math.min(pat.length - 1, this.recoil.patternIndex + 1);

    // 固定序列（度 -> 弧度）
    const patYaw = M.toRad(entry[0] * 0.55 * mul);
    const patPitch = M.toRad(entry[1] * mul);
    // 随机抖动
    const rndYaw = M.toRad((this.rng() - 0.5) * def.recoilYaw * 2 * mul);
    const rndPitch = M.toRad((this.rng() - 0.5) * def.recoilPitch * 0.32 * mul);

    const aimMul = def.recoilAimMul;
    const visMul = def.recoilVisualMul;

    if (CFG.fx.fireCameraRecoil !== false) {
      this.recoil.aimPitch += (patPitch + rndPitch) * aimMul * (1 - st.adsT * 0.22);
      this.recoil.aimYaw += (patYaw + rndYaw) * aimMul;
      this.recoil.visPitch += (patPitch + rndPitch) * visMul;
      this.recoil.visYaw += (patYaw + rndYaw) * visMul;
    } else {
      // 用户要求开火时镜头完全稳定。这里同时清掉影响真实射线的 aim 通道，
      // 避免画面不动但子弹偷偷偏离准心；枪体 kick 和 spreadExtra 仍提供反馈。
      this.recoil.aimPitch = 0; this.recoil.aimYaw = 0;
      this.recoil.visPitch = 0; this.recoil.visYaw = 0;
    }
    this.recoil.recoveryDelay = 0.055;

    // 扩散累积
    st.spreadExtra = Math.min(def.spreadMax, st.spreadExtra + def.spreadPerShot * mul);
  }

  _updateRecoil(dt) {
    const def = WEAPONS[this.slots[this.slotIndex].id];
    this.recoil.recoveryDelay = Math.max(0, this.recoil.recoveryDelay - dt);
    const rate = def.recoilRecovery * dt;
    // 瞄准偏移恢复
    this.recoil.aimPitch = M.moveTowards(this.recoil.aimPitch, 0, rate * 0.55);
    this.recoil.aimYaw = M.moveTowards(this.recoil.aimYaw, 0, rate * 0.55);
    // 视觉偏移恢复更快（相机抖动迅速归位，但仍有冲击感）
    this.recoil.visPitch = M.damp(this.recoil.visPitch, 0, 9.5, dt);
    this.recoil.visYaw = M.damp(this.recoil.visYaw, 0, 9.5, dt);
    if (this.recoil.recoveryDelay <= 0 && this.state.get(def.id).timeSinceShot > 0.22) {
      // 停火一段时间后重置弹道序列（下次开火从第一发开始）
      if (this.state.get(def.id).timeSinceShot > 0.5) this.recoil.patternIndex = 0;
    }
  }

  /**
   * 相机后坐力偏移（由 main.js 叠加到相机上）。
   * 字段名必须与消费方（main.js / debugState）一致，否则会静默变成 undefined → NaN。
   */
  getCameraRecoil() {
    return {
      pitch: this.recoil.visPitch,
      yaw: this.recoil.visYaw,
      aimPitch: this.recoil.aimPitch,
      aimYaw: this.recoil.aimYaw,
    };
  }

  // ---------------------------------------------------------------- 视图模型动画

  _updateViewmodel(dt, st, def, input) {
    const vm = this.vm;
    const player = this.player;
    const p = player.state;
    vm.t += dt;

    // 姿态混合权重
    const isSprint = p.sprinting && p.hspeed > CFG.move.walkSpeed * 1.1 && !st.ads;
    const isSlide = p.sliding;
    const isAir = !p.grounded;
    const isWall = p.wallRunning;
    vm.sprintBlend = M.damp(vm.sprintBlend, isSprint ? 1 : 0, 9, dt);
    vm.slideBlend = M.damp(vm.slideBlend, isSlide ? 1 : 0, 10, dt);
    vm.airBlend = M.damp(vm.airBlend, isAir ? 1 : 0, 7, dt);
    vm.wallrunBlend = M.damp(vm.wallrunBlend, isWall ? 1 : 0, 9, dt);

    // 目标锚点
    const targetPos = VMP_P;
    const targetRot = VMP_R;
    const basePos = st.adsT > 0.5 ? def.viewmodel.adsPos : def.viewmodel.hipPos;
    const baseRot = st.adsT > 0.5 ? def.viewmodel.adsRot : def.viewmodel.hipRot;
    targetPos[0] = basePos[0]; targetPos[1] = basePos[1]; targetPos[2] = basePos[2];
    targetRot[0] = baseRot[0]; targetRot[1] = baseRot[1]; targetRot[2] = baseRot[2];

    // 机瞄插值（hip <-> ads 线性混合）
    if (st.adsT < 1) {
      const hp = def.viewmodel.hipPos, ap = def.viewmodel.adsPos;
      const hr = def.viewmodel.hipRot, ar = def.viewmodel.adsRot;
      targetPos[0] = M.lerp(hp[0], ap[0], st.adsT);
      targetPos[1] = M.lerp(hp[1], ap[1], st.adsT);
      targetPos[2] = M.lerp(hp[2], ap[2], st.adsT);
      targetRot[0] = M.lerp(hr[0], ar[0], st.adsT);
      targetRot[1] = M.lerp(hr[1], ar[1], st.adsT);
      targetRot[2] = M.lerp(hr[2], ar[2], st.adsT);
    }

    // 冲刺/滑铲姿态
    if (vm.sprintBlend > 0.001) {
      const sp = def.viewmodel.sprintPos, sr = def.viewmodel.sprintRot;
      targetPos[0] = M.lerp(targetPos[0], sp[0], vm.sprintBlend);
      targetPos[1] = M.lerp(targetPos[1], sp[1], vm.sprintBlend);
      targetPos[2] = M.lerp(targetPos[2], sp[2], vm.sprintBlend);
      targetRot[0] = M.lerp(targetRot[0], sr[0], vm.sprintBlend);
      targetRot[1] = M.lerp(targetRot[1], sr[1], vm.sprintBlend);
      targetRot[2] = M.lerp(targetRot[2], sr[2], vm.sprintBlend);
    }
    if (vm.slideBlend > 0.001) {
      const sp = def.viewmodel.slidePos, sr = def.viewmodel.slideRot;
      targetPos[0] = M.lerp(targetPos[0], sp[0], vm.slideBlend);
      targetPos[1] = M.lerp(targetPos[1], sp[1], vm.slideBlend);
      targetPos[2] = M.lerp(targetPos[2], sp[2], vm.slideBlend);
      targetRot[0] = M.lerp(targetRot[0], sr[0], vm.slideBlend);
      targetRot[1] = M.lerp(targetRot[1], sr[1], vm.slideBlend);
      targetRot[2] = M.lerp(targetRot[2], sr[2], vm.slideBlend);
    }
    // 空中腰射会自然抬枪；一旦 ADS，该姿态按 adsT 连续衰减为 0，避免跳跃时
    // 枪体/镜框突然抬到准星前方。不是在 render 阶段硬纠正，因此不会产生跳变。
    const airPose = vm.airBlend * (1 - st.adsT);
    if (airPose > 0.001) {
      targetPos[1] += 0.028 * airPose;
      targetPos[2] += 0.018 * airPose;
      targetRot[0] -= 0.10 * airPose;
    }
    // 蹬墙跑：向墙侧偏移 + 倾斜（强化速度感）
    if (vm.wallrunBlend > 0.001) {
      const side = p.wallSide || 1;
      targetPos[0] -= 0.045 * side * vm.wallrunBlend;
      targetPos[1] += 0.012 * vm.wallrunBlend;
      targetRot[2] += 0.30 * side * vm.wallrunBlend;
      targetRot[1] -= 0.16 * side * vm.wallrunBlend;
    }

    // 走路摆动（随速度）
    const hsp = p.hspeed;
    if (p.grounded && hsp > 0.8) {
      vm.bobPhase += dt * (5.2 + hsp * 0.42);
      vm.bobAmp = M.damp(vm.bobAmp, M.clamp01(hsp / 10) * 0.016, 7, dt);
    } else {
      vm.bobAmp = M.damp(vm.bobAmp, 0, 6, dt);
    }
    const bobX = Math.cos(vm.bobPhase) * vm.bobAmp;
    const bobY = Math.abs(Math.sin(vm.bobPhase)) * vm.bobAmp * 1.25;
    targetPos[0] += bobX;
    targetPos[1] += bobY;
    targetRot[2] += bobX * 0.6;
    targetRot[0] += bobY * 0.5;

    // 待机呼吸
    const breath = Math.sin(vm.t * 1.35) * 0.0022;
    targetPos[1] += breath * (1 - st.adsT * 0.7);
    targetRot[0] += breath * 0.4 * (1 - st.adsT * 0.7);

    // 鼠标摆动惯性（视线快速转动时枪身滞后）
    const dYaw = M.wrapAngle(player.yaw - vm.lastYaw);
    const dPitch = player.pitch - vm.lastPitch;
    vm.lastYaw = player.yaw;
    vm.lastPitch = player.pitch;
    const swayScale = (def.adsSwayMul != null ? def.adsSwayMul : 0.35) * (this._hasOptic(def) ? 0.72 : 1);
    vm.sway[0] = M.damp(vm.sway[0], M.clamp(dYaw * 6.5, -0.06, 0.06) * swayScale / 0.35, 12, dt);
    vm.sway[1] = M.damp(vm.sway[1], M.clamp(dPitch * 6.5, -0.05, 0.05) * swayScale / 0.35, 12, dt);
    targetPos[0] += vm.sway[0];
    targetPos[1] += vm.sway[1];
    targetRot[2] += vm.sway[0] * 2.2;
    targetRot[0] -= vm.sway[1] * 1.8;

    // 开火后坐（位置后拉 + 旋转抬头）
    vm.kick = M.damp(vm.kick, 0, 13, dt);
    vm.kickRot = M.damp(vm.kickRot, 0, 11, dt);
    targetPos[2] += vm.kick * 0.045 * (1 - st.adsT * 0.5);
    targetRot[0] -= vm.kickRot * (1 - st.adsT * 0.4);
    targetRot[1] += vm.kick * 0.035 * (this.rng() - 0.5) * 2;

    // 近战采用完整的前摇—打击—收回曲线。真正的单手局部矩阵在 render 中
    // 应用；这里不再旋转整套双手，否则另一只护手也会一起飞出去，看起来仍像无动作。
    if (def.class === 'melee' && vm.meleeT < 1) {
      vm.meleeT = Math.min(1, vm.meleeT + dt / 0.34);
      const t = vm.meleeT;
      vm.meleeWindup = t < 0.20 ? M.smoothstep(0, 1, t / 0.20)
        : (t < 0.34 ? 1 - M.smoothstep(0, 1, (t - 0.20) / 0.14) : 0);
      vm.meleeAttack = t < 0.20 ? 0
        : (t < 0.43 ? M.smoothstep(0, 1, (t - 0.20) / 0.23)
          : 1 - M.smoothstep(0, 1, (t - 0.43) / 0.57));
      // 只保留很轻的身体跟随，主要位移全部交给正在攻击的手臂。
      targetRot[2] -= (vm.meleeSide || 1) * vm.meleeAttack * 0.035;
    } else if (def.class === 'melee') {
      vm.meleeAttack = 0;
      vm.meleeWindup = 0;
    }

    // 换弹根姿态：把枪向内翻出弹匣井，同时维持枪口远离屏幕中心。
    // 真正的弹匣、左手和枪机分件动画在 render() 中独立完成。
    if (st.reloading) {
      const prog = M.clamp01(st.reloadT / Math.max(0.01, st.reloadDuration));
      const raise = prog < 0.16 ? M.smoothstep(0, 1, prog / 0.16)
        : (prog < 0.82 ? 1 : 1 - M.smoothstep(0, 1, (prog - 0.82) / 0.18));
      const seatKick = prog > 0.76 && prog < 0.87
        ? Math.sin((prog - 0.76) / 0.11 * Math.PI) : 0;
      targetPos[0] += 0.055 * raise;
      targetPos[1] -= 0.045 * raise + 0.012 * seatKick;
      targetPos[2] += 0.030 * raise;
      targetRot[0] += 0.31 * raise + 0.055 * seatKick;
      targetRot[1] -= 0.24 * raise;
      targetRot[2] += 0.19 * raise + 0.045 * seatKick;
    }

    // 切枪（举起/放下）
    const equipEase = M.smoothstep(0, 1, vm.equipT);
    targetPos[1] -= (1 - equipEase) * 0.24;
    targetRot[0] += (1 - equipEase) * 0.9;
    const holsterEase = M.clamp01(vm.holsterT / 0.3);
    targetPos[1] -= holsterEase * 0.26;
    targetRot[0] += holsterEase * 1.0;

    // 平滑到目标
    vm.pos[0] = M.damp(vm.pos[0], targetPos[0], 16, dt);
    vm.pos[1] = M.damp(vm.pos[1], targetPos[1], 16, dt);
    vm.pos[2] = M.damp(vm.pos[2], targetPos[2], 16, dt);
    vm.rot[0] = M.damp(vm.rot[0], targetRot[0], 15, dt);
    vm.rot[1] = M.damp(vm.rot[1], targetRot[1], 15, dt);
    vm.rot[2] = M.damp(vm.rot[2], targetRot[2], 15, dt);
    void input;
  }

  _muzzleWorldPos(out, def) {
    // 视图模型枪口 -> 世界坐标（用相机基向量变换）
    const p = this.player;
    const ml = def.viewmodel.muzzleLocal;
    const vx = this.vm.pos[0] + ml[0] * (def.viewmodel.scale || 1);
    const vy = this.vm.pos[1] + ml[1] * (def.viewmodel.scale || 1);
    const vz = this.vm.pos[2] + ml[2] * (def.viewmodel.scale || 1);
    // 相机 right/up/-forward 基
    out[0] = p.eyePos[0] + p.right[0] * vx + p.up[0] * vy - p.forward[0] * vz;
    out[1] = p.eyePos[1] + p.right[1] * vx + p.up[1] * vy - p.forward[1] * vz;
    out[2] = p.eyePos[2] + p.right[2] * vx + p.up[2] * vy - p.forward[2] * vz;
    return out;
  }

  // ---------------------------------------------------------------- 渲染

  _ensureHealingViewmodel() {
    if (this._healVm) return this._healVm;
    this._healVm = {
      meshes: {
        box: this.engine.createMesh(Geo.unitCube()),
        cyl: this.engine.createMesh(Geo.unitCylinder(12, true, true)),
      },
      // 两只手参与完整道具动作：拿出、打开/接入、持续操作、收尾。部件 tag 由
      // _renderHealingViewmodel 按读条进度分别驱动，避免整件道具只做单一上下平移。
      medkit: [
        { shape: 'box', size: [0.22, 0.14, 0.11], pos: [0.10, -0.075, -0.49], color: [0.82, 0.86, 0.88], tag: 'body' },
        { shape: 'box', size: [0.21, 0.025, 0.105], pos: [0.10, 0.008, -0.49], color: [0.26, 0.30, 0.33], tag: 'lid' },
        { shape: 'box', size: [0.035, 0.105, 0.014], pos: [0.10, -0.075, -0.551], color: [0.88, 0.16, 0.12], emissive: 0.25, tag: 'body' },
        { shape: 'box', size: [0.105, 0.035, 0.014], pos: [0.10, -0.075, -0.551], color: [0.88, 0.16, 0.12], emissive: 0.25, tag: 'body' },
        { shape: 'box', size: [0.085, 0.095, 0.115], pos: [0.235, -0.14, -0.42], color: [0.28, 0.24, 0.21], tag: 'right-hand' },
        { shape: 'box', size: [0.085, 0.095, 0.115], pos: [-0.075, -0.10, -0.46], color: [0.28, 0.24, 0.21], tag: 'left-hand' },
        { shape: 'box', size: [0.035, 0.035, 0.10], pos: [-0.01, -0.035, -0.50], color: [0.92, 0.56, 0.18], emissive: 0.20, tag: 'injector' },
      ],
      battery: [
        { shape: 'cyl', r: 0.070, h: 0.24, pos: [0.11, -0.07, -0.49], rot: [Math.PI / 2, 0, 0], color: [0.08, 0.28, 0.58], emissive: 0.35, tag: 'body' },
        { shape: 'cyl', r: 0.079, h: 0.022, pos: [0.11, -0.07, -0.62], rot: [Math.PI / 2, 0, 0], color: [0.28, 0.78, 1.0], emissive: 0.65, tag: 'cap' },
        { shape: 'box', size: [0.085, 0.105, 0.12], pos: [0.235, -0.15, -0.42], color: [0.28, 0.24, 0.21], tag: 'right-hand' },
        { shape: 'box', size: [0.085, 0.105, 0.12], pos: [-0.055, -0.09, -0.48], color: [0.28, 0.24, 0.21], tag: 'left-hand' },
        { shape: 'box', size: [0.018, 0.055, 0.10], pos: [0.11, -0.015, -0.49], color: [0.40, 0.90, 1.0], emissive: 0.75, tag: 'meter' },
      ],
      syringe: [
        { shape: 'cyl', r: 0.030, h: 0.22, pos: [0.08, -0.06, -0.49], rot: [Math.PI / 2, 0, 0], color: [0.72, 0.88, 0.92], emissive: 0.08, tag: 'barrel' },
        { shape: 'cyl', r: 0.010, h: 0.10, pos: [0.08, -0.06, -0.655], rot: [Math.PI / 2, 0, 0], color: [0.74, 0.78, 0.82], tag: 'needle' },
        { shape: 'cyl', r: 0.022, h: 0.09, pos: [0.08, -0.06, -0.345], rot: [Math.PI / 2, 0, 0], color: [0.88, 0.16, 0.13], tag: 'plunger' },
        { shape: 'box', size: [0.10, 0.018, 0.040], pos: [0.08, -0.06, -0.295], color: [0.30, 0.34, 0.38], tag: 'plunger' },
        { shape: 'box', size: [0.085, 0.095, 0.12], pos: [0.22, -0.14, -0.40], color: [0.28, 0.24, 0.21], tag: 'right-hand' },
        { shape: 'box', size: [0.085, 0.095, 0.12], pos: [-0.065, -0.09, -0.50], color: [0.28, 0.24, 0.21], tag: 'left-hand' },
      ],
      cell: [
        { shape: 'cyl', r: 0.050, h: 0.15, pos: [0.09, -0.07, -0.49], rot: [Math.PI / 2, 0, 0], color: [0.06, 0.30, 0.68], emissive: 0.35, tag: 'body' },
        { shape: 'cyl', r: 0.058, h: 0.018, pos: [0.09, -0.07, -0.575], rot: [Math.PI / 2, 0, 0], color: [0.35, 0.92, 1.0], emissive: 0.80, tag: 'cap' },
        { shape: 'box', size: [0.075, 0.09, 0.105], pos: [0.205, -0.13, -0.41], color: [0.28, 0.24, 0.21], tag: 'right-hand' },
        { shape: 'box', size: [0.075, 0.09, 0.105], pos: [-0.045, -0.085, -0.49], color: [0.28, 0.24, 0.21], tag: 'left-hand' },
        { shape: 'box', size: [0.014, 0.040, 0.070], pos: [0.09, -0.025, -0.49], color: [0.42, 0.94, 1.0], emissive: 0.90, tag: 'meter' },
      ],
    };
    return this._healVm;
  }

  _renderHealingViewmodel(e, healing) {
    const hv = this._ensureHealingViewmodel();
    const item = Math.max(0, Math.min(3, healing && healing.useItem | 0));
    const parts = item === 1 ? hv.battery : (item === 2 ? hv.syringe : (item === 3 ? hv.cell : hv.medkit));
    const progress = M.clamp01((healing && healing.useT || 0) / Math.max(0.01, healing && healing.useDuration || 1));
    // 四阶段动作：举起 → 打开/接入 → 持续操作 → 收尾。左右手与可动件使用
    // 不同轨迹，且中段保留轻微机械/呼吸节奏，避免“模型整块平移”的廉价感。
    const lift = M.smoothstep(0, 1, Math.min(1, progress / 0.16));
    const lower = progress > 0.84 ? M.smoothstep(0, 1, (progress - 0.84) / 0.16) * 0.035 : 0;
    const operate = M.smoothstep(0, 1, M.clamp01((progress - 0.16) / 0.52));
    const finish = M.smoothstep(0, 1, M.clamp01((progress - 0.76) / 0.24));
    const pulse = Math.sin(progress * Math.PI * (item >= 2 ? 5 : 8));
    const root = VM_ROOT;
    const tmp = VM_TMP;
    for (const part of parts) {
      const pos = [part.pos[0], part.pos[1] + (1 - lift) * -0.28 + lower, part.pos[2]];
      const baseRot = part.rot || [0, 0, 0];
      const rot = [baseRot[0], baseRot[1], baseRot[2]];
      if (part.tag === 'left-hand') {
        pos[0] += 0.045 * (1 - operate) - 0.018 * operate;
        pos[1] += 0.035 * operate + pulse * 0.004 * (1 - finish);
        pos[2] -= 0.055 * operate;
        rot[2] -= 0.30 * operate;
      } else if (part.tag === 'right-hand') {
        pos[1] += pulse * 0.003 * (1 - finish);
        rot[2] += 0.12 * operate;
      }
      if (item === 0) {
        if (part.tag === 'lid') { pos[1] += 0.055 * operate; pos[2] += 0.025 * operate; rot[0] -= 0.75 * operate; }
        if (part.tag === 'injector') { pos[0] -= 0.07 * operate; pos[2] -= 0.06 * operate; rot[2] += 0.45 * operate; }
      } else if (item === 1 || item === 3) {
        if (part.tag === 'cap') { pos[2] += 0.018 * operate; rot[1] += operate * Math.PI * 2.5; }
        if (part.tag === 'meter') pos[1] += Math.max(0, pulse) * 0.008 * (1 - finish);
        rot[2] += pulse * 0.025 * (1 - finish);
      } else if (item === 2) {
        // 注射器推杆在后半段真正压入针筒，而不是只播放一个图标。
        if (part.tag === 'plunger') pos[2] -= 0.095 * M.smoothstep(0, 1, M.clamp01((progress - 0.34) / 0.50));
        if (part.tag === 'barrel' || part.tag === 'needle') rot[2] -= 0.20 * operate;
      }
      const size = part.size || [part.r * 2, part.h, part.r * 2];
      M.m4Compose(pos, rot[1] || 0, rot[0] || 0, rot[2] || 0, size, tmp);
      e.drawInstanced(part.shape === 'cyl' ? hv.meshes.cyl : hv.meshes.box, tmp, 1, {
        color: part.color, emissive: part.emissive || 0, cull: false,
      });
    }
    void root;
  }

  /** 视图模型渲染（独立相机 + 独立深度，避免穿墙） */
  render(engine) {
    const vm = this.vm;
    if (!vm.items || vm.items.length === 0) return;
    const def = WEAPONS[this.slots[this.slotIndex].id];
    const st = this.state.get(def.id);
    const p = this.player;
    const e = engine || this.engine;

    // 保存主相机
    const savedViewProj = new Float32Array(e.viewProj);
    const savedView = new Float32Array(e.view);
    const savedProj = new Float32Array(e.proj);
    const savedPos = new Float32Array(e.cameraPos);

    // 视图模型相机：固定在原点，朝 -Z
    const vmFov = CFG.render.viewmodelFovDeg;
    const near = 0.008, far = 12;
    const vFov = 2 * Math.atan(Math.tan(M.toRad(vmFov) * 0.5) / e.aspect);
    M.m4Perspective(vFov, e.aspect, near, far, e.proj);
    M.m4Identity(e.view);
    M.m4Mul(e.proj, e.view, e.viewProj);
    e.cameraPos[0] = 0; e.cameraPos[1] = 0; e.cameraPos[2] = 0;

    e.clearDepthOnly();
    e.gl.enable(e.gl.DEPTH_TEST);
    e.gl.depthFunc(e.gl.LEQUAL);

    // 组装实例矩阵
    const root = VM_ROOT;
    M.m4Compose(vm.pos, vm.rot[1], vm.rot[0], vm.rot[2], def.viewmodel.scale || 1, root);
    const tmp = VM_TMP;
      const healing = p && p.healing && p.healing.useActive;
      const adsHide = this.current && this.current.adsT > 0.62;
      const knifeEquipped = def.class === 'melee' && this._hasKnife();
      const meleeAttack = def.class === 'melee' ? M.clamp01(vm.meleeAttack || 0) : 0;
      const meleeWindup = def.class === 'melee' ? M.clamp01(vm.meleeWindup || 0) : 0;
      const reloadProg = st && st.reloading
        ? M.clamp01(st.reloadT / Math.max(0.01, st.reloadDuration)) : 0;
      // 4× 狙击镜已经由 HUD 提供镜内视野、暗角和刻线；实体镜筒若继续出现在圆内，
      // 会形成截图中的“双重镜子”并用机匣遮住目标。完全开镜后隐藏整个 viewmodel。
      const scopedOverlay = !!(def.scopeMagnification > 1 && this.current && this.current.adsT > 0.72);
      // ADS 不再把整把枪或整套狙击 viewmodel 一刀切掉：主体隐藏，只保留实际安装
      // 在导轨上的空心瞄具和镜下手部。这样瞄具属于枪，且中心没有不透明镜片。
      if (!healing) for (const it of vm.items) {
        if (scopedOverlay) continue;
        if (it.requiresKnife && !knifeEquipped) continue;
        if (it.bareOnly && knifeEquipped) continue;
        // 普通 ADS 保留完整枪身，只隐藏与新光学组件重叠的旧准星/弹匣细节。
        // 旧逻辑仅绘制 optic/adsBody 标记部件，会让大半把枪在按右键后消失。
        if (adsHide && it.hideInAds) continue;
        let partMatrix = it.matrix;
        // 完整分件换弹：旧匣抽出并抛离画面，同一模型在画面外切换为新匣后
        // 由左下方送回；左手全程跟随，最后枪机/拉柄后拉复位。
        if (reloadProg > 0 && def.class !== 'melee') {
          let rdx = 0, rdy = 0, rdz = 0, ryaw = 0, rpitch = 0, rroll = 0;
          let animatedReloadPart = false;
          if (it.reloadGroup === 'mag') {
            animatedReloadPart = true;
            if (reloadProg < 0.16) {
              // 卡榫释放时弹匣仍在井内，只有轻微机械松动。
              const j = M.smoothstep(0, 1, reloadProg / 0.16);
              rdy = -0.008 * j;
            } else if (reloadProg < 0.31) {
              const q = M.smoothstep(0, 1, (reloadProg - 0.16) / 0.15);
              rdx = -0.045 * q; rdy = -0.205 * q; rdz = 0.025 * q;
              rroll = -0.16 * q;
            } else if (reloadProg < 0.43) {
              // 旧弹匣脱手：加速落出视野并向左翻转。
              const q = M.smoothstep(0, 1, (reloadProg - 0.31) / 0.12);
              rdx = -0.045 - 0.22 * q; rdy = -0.205 - 0.58 * q; rdz = 0.025 + 0.12 * q;
              ryaw = -0.28 * q; rroll = -0.16 - 0.88 * q;
            } else if (reloadProg < 0.79) {
              // 新弹匣从左下画外出现，找准弹匣井并逐步插入。
              const q = M.smoothstep(0, 1, (reloadProg - 0.43) / 0.36);
              rdx = M.lerp(-0.24, 0, q); rdy = M.lerp(-0.62, 0, q); rdz = M.lerp(0.13, 0, q);
              ryaw = M.lerp(0.22, 0, q); rroll = M.lerp(0.42, 0, q);
            } else if (reloadProg < 0.87) {
              const q = (reloadProg - 0.79) / 0.08;
              rdy = Math.sin(q * Math.PI) * 0.020;
            }
          } else if (it.tag && it.tag.indexOf('left-') === 0) {
            animatedReloadPart = true;
            if (reloadProg < 0.16) {
              const q = M.smoothstep(0, 1, reloadProg / 0.16);
              rdx = -0.015 * q; rdy = -0.10 * q; rdz = 0.19 * q; rroll = -0.13 * q;
            } else if (reloadProg < 0.34) {
              const q = M.smoothstep(0, 1, (reloadProg - 0.16) / 0.18);
              rdx = -0.035 - 0.055 * q; rdy = -0.11 - 0.20 * q; rdz = 0.18 + 0.06 * q;
              rpitch = -0.16 * q; rroll = -0.18 - 0.18 * q;
            } else if (reloadProg < 0.48) {
              const q = M.smoothstep(0, 1, (reloadProg - 0.34) / 0.14);
              rdx = -0.09 - 0.13 * q; rdy = -0.31 - 0.22 * q; rdz = 0.24 + 0.03 * q;
              rroll = -0.36 + 0.22 * q;
            } else if (reloadProg < 0.79) {
              const q = M.smoothstep(0, 1, (reloadProg - 0.48) / 0.31);
              rdx = M.lerp(-0.22, -0.01, q); rdy = M.lerp(-0.52, -0.09, q); rdz = M.lerp(0.27, 0.18, q);
              rpitch = M.lerp(0.12, 0, q); rroll = M.lerp(0.18, -0.10, q);
            } else {
              const q = M.smoothstep(0, 1, (reloadProg - 0.79) / 0.21);
              rdx = M.lerp(-0.01, 0, q); rdy = M.lerp(-0.09, 0, q); rdz = M.lerp(0.18, 0, q);
              rroll = M.lerp(-0.10, 0, q);
            }
          } else if (it.reloadGroup === 'bolt' && reloadProg > 0.88) {
            animatedReloadPart = true;
            const q = M.clamp01((reloadProg - 0.88) / 0.12);
            const pull = Math.sin(q * Math.PI);
            rdz = 0.092 * pull;
            rdy = -0.012 * pull;
            rpitch = -0.08 * pull;
          }
          if (animatedReloadPart) {
            M.m4Compose([rdx, rdy, rdz], ryaw, rpitch, rroll, 1, RELOAD_ANIM_A);
            M.m4Mul(RELOAD_ANIM_A, it.matrix, RELOAD_PART);
            partMatrix = RELOAD_PART;
          }
        }
        // 近战部件按所属手臂独立动画。非攻击手保持护脸位置；攻击手围绕袖口
        // 根部做真正的前伸或斜劈，而不是让两只手随 root 一起平移。
        if (def.class === 'melee' && it.meleeSide) {
          const side = it.meleeSide;
          const active = side === (vm.meleeSide || 1);
          const pivot = MELEE_PIVOT;
          pivot[0] = side * 0.158; pivot[1] = -0.145; pivot[2] = 0.055;
          let dx = 0, dy = 0, dz = 0, yaw = 0, pitch = 0, roll = 0;
          if (active && knifeEquipped) {
            // 右手先抬刀蓄势，再从右上向左下划过屏幕中央。
            dx = meleeWindup * 0.105 - meleeAttack * 0.285;
            dy = meleeWindup * 0.105 - meleeAttack * 0.020;
            dz = meleeWindup * 0.065 - meleeAttack * 0.235;
            yaw = meleeWindup * 0.28 - meleeAttack * 0.88;
            pitch = meleeWindup * 0.22 - meleeAttack * 0.30;
            roll = -meleeWindup * 0.72 + meleeAttack * 1.12;
          } else if (active) {
            // 拳击有清晰收拳前摇和约 34cm 的单拳前伸，左右手交替。
            dx = side * (meleeWindup * 0.045 - meleeAttack * 0.070);
            dy = meleeWindup * 0.018 + meleeAttack * 0.068;
            dz = meleeWindup * 0.090 - meleeAttack * 0.345;
            yaw = side * (-meleeWindup * 0.18 + meleeAttack * 0.12);
            pitch = meleeWindup * 0.24 - meleeAttack * 0.24;
            roll = side * (meleeWindup * 0.10 - meleeAttack * 0.16);
          } else {
            // 非攻击手略收回形成护手，不跟随攻击手一起冲出去。
            dy = -meleeAttack * 0.025;
            dz = meleeAttack * 0.035;
            roll = -side * meleeAttack * 0.055;
          }
          M.m4Compose([pivot[0] + dx, pivot[1] + dy, pivot[2] + dz], yaw, pitch, roll, 1, MELEE_ANIM_A);
          M.m4FromTranslation([-pivot[0], -pivot[1], -pivot[2]], MELEE_ANIM_B);
          M.m4Mul(MELEE_ANIM_A, MELEE_ANIM_B, MELEE_ANIM_C);
          M.m4Mul(MELEE_ANIM_C, it.matrix, MELEE_PART);
          partMatrix = MELEE_PART;
        }
      M.m4Mul(root, partMatrix, tmp);
      e.drawInstanced(it.mesh, tmp, 1, {
        color: it.color,
        emissive: it.emissive,
        cull: false,
      });
    }

    // 枪口火光（自发光四边形）
    if (!adsHide && !scopedOverlay && !healing) this.projectiles.renderViewmodelFlash(e, this, def);
    if (healing) this._renderHealingViewmodel(e, p.healing);

    // 必须在视图模型相机仍生效时提交，不能留给世界相机的 flush。
    e.flushAndReset();

    void p;
    // 恢复主相机
    e.viewProj.set(savedViewProj);
    e.view.set(savedView);
    e.proj.set(savedProj);
    e.cameraPos.set(savedPos);
    M.m4FrustumPlanes(e.viewProj, e.frustum);
  }

  debugState() {
    const cur = this.current;
    return {
      id: cur.id,
      name: cur.def.name,
      ammo: cur.ammo,
      // debugState 保持 JSON/数值哨兵可用：无限备弹通过标志表达，
      // 实际 current.reserve 仍为 Infinity 供射击与 HUD 使用。
      reserve: Number.isFinite(cur.reserve) ? cur.reserve : Number.MAX_SAFE_INTEGER,
      reserveInfinite: !Number.isFinite(cur.reserve),
      magSize: cur.magSize,
      reloading: cur.reloading,
      reloadProgress: Math.round(cur.reloadProgress * 100) / 100,
      ads: cur.ads,
      adsProgress: Math.round(cur.adsT * 100) / 100,
      chargeProgress: Math.round(cur.chargeProgress * 100) / 100,
      charging: cur.charging,
      chargeReady: cur.chargeReady,
      chargeShotsRemaining: cur.chargeShotsRemaining,
      chargeAfterReload: cur.chargeAfterReload,
      bolting: cur.bolting,
      boltProgress: Math.round(cur.boltProgress * 100) / 100,
      chambered: cur.chambered,
      spread: Math.round(cur.spread * 100) / 100,
      recoilAimPitch: Math.round(this.recoil.aimPitch * 10000) / 10000,
      recoilVisPitch: Math.round(this.recoil.visPitch * 10000) / 10000,
      patternIndex: this.recoil.patternIndex,
      shots: this.stats.shotsFired,
      hits: this.stats.hits,
      headshots: this.stats.headshots,
      accuracy: this.stats.shotsFired > 0 ? Math.round(this.stats.hits / this.stats.shotsFired * 1000) / 10 : 0,
      damageDealt: Math.round(this.stats.damageDealt),
      slots: this.slots.map((s) => s.id),
      attachments: Object.fromEntries(this.slots.map((s) => [s.id, this.getAttachments(s.id)])),
      projectiles: this.projectiles.aliveCount,
    };
  }
}

// ---------------------------------------------------------------- 暂存

/**
 * 武器 modifier 的安全归一化。
 * 乘算键（*Mul）缺省/坏值回落到 1，加算键（Add）回落到 0，
 * 除了明确表示“无限备弹”的 reserve 外，任何 NaN/Infinity 都不允许进入
 * 射击计算 —— 一次 NaN 就会让扩散、后坐力、HUD 数值全部变成 NaN。
 */
function sanitizeWeaponMods(mods) {
  const base = normalizeMods(mods);
  const out = { move: base.move, weapon: {}, meta: base.meta };
  for (const k of Object.keys(base.weapon)) {
    const v = base.weapon[k];
    if (Number.isFinite(v)) { out.weapon[k] = v; continue; }
    // 加算键回落到 0，其余（乘算键）回落到 1
    out.weapon[k] = k.endsWith('Add') ? 0 : 1;
  }
  return out;
}

/** 把单个武器状态里的非有限值修回安全值 */
function sanitizeState(st) {
  if (!Number.isFinite(st.adsT)) st.adsT = 0;
  if (!Number.isFinite(st.spreadExtra)) st.spreadExtra = 0;
  if (!Number.isFinite(st.spread)) st.spread = 0.5;
  if (!Number.isFinite(st.reloadT)) st.reloadT = 0;
  if (!Number.isFinite(st.reloadCueIndex)) st.reloadCueIndex = 0;
  st.reloadCueIndex = Math.max(0, Math.min(RELOAD_CUES.length, Math.floor(st.reloadCueIndex)));
  if (!Number.isFinite(st.chargeT)) st.chargeT = 0;
  if (!Number.isFinite(st.chargeShotsRemaining)) st.chargeShotsRemaining = 0;
  if (!Number.isFinite(st.boltT)) st.boltT = 0;
  if (!Number.isFinite(st.boltDuration)) st.boltDuration = 0;
  st.chargeShotsRemaining = Math.max(0, Math.floor(st.chargeShotsRemaining));
  st.charging = !!st.charging;
  st.chargeReady = !!st.chargeReady;
  st.chargeAfterReload = !!st.chargeAfterReload;
  st.bolting = !!st.bolting;
  st.chambered = st.chambered !== false;
  if (!Number.isFinite(st.ammo)) st.ammo = 0;
  if (st.reserve !== Infinity && !Number.isFinite(st.reserve)) st.reserve = 0;
  if (!Number.isFinite(st.timeSinceShot)) st.timeSinceShot = 99;
  return st;
}

const FIRE_O = new Float32Array(3);
const FIRE_D = new Float32Array(3);
const FIRE_D2 = new Float32Array(3);
const MUZZLE_W = new Float32Array(3);
const PIERCE_O = new Float32Array(3);
const VMP_P = new Float32Array(3);
const VMP_R = new Float32Array(3);
const VM_ROOT = new Float32Array(16);
const VM_TMP = new Float32Array(16);
const MELEE_ANIM_A = new Float32Array(16);
const MELEE_ANIM_B = new Float32Array(16);
const MELEE_ANIM_C = new Float32Array(16);
const MELEE_PART = new Float32Array(16);
const MELEE_PIVOT = new Float32Array(3);
const RELOAD_ANIM_A = new Float32Array(16);
const RELOAD_PART = new Float32Array(16);

export default WeaponSystem;
