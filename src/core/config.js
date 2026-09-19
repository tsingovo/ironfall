// ==== core/config.js — 全部手感调参集中地：改这里就能调游戏 ====
// CFG 是可变的浅层对象（允许运行时调参），键名与默认值必须与 CFG_DEFAULTS 一致。
// 设计取向：数值偏"爽"不偏"真"。Apex 风格强化运动 + R-99 高速冲锋枪手感。

import { toRad } from './math.js';

const DEFAULTS = {
  // ------------------------------------------------------------ 渲染
  render: {
    fovDeg: 100,               // 基础视野（Apex 默认 ~100 水平）
    near: 0.06,
    far: 1200,
    /**
     * 视图模型（枪 + 手臂）独立视野。
     * 设计约束：16:9 下垂直 FOV ≈ 2*atan(tan(h/2)/aspect)，h=72° 时只有 44.5°，
     * 在 z≈0.30m 处的可视半高仅 0.12m —— 而枪身中心在 y≈-0.15m，会被整个切到画面外
     * （表现为"看不到枪和手臂"）。这里放宽到 85°（垂直约 55°），可视半高约 0.157m，
     * 配合 viewmodel 里上移后的枪位刚好完整入画。
     * 改这个值必须同步跑 tools/test-ui-input.mjs 的"视图模型在屏占比"断言。
     */
    viewmodelFovDeg: 85,
    weaponLowering: 0.18,      // 腰射枪体下移，保留屏幕下沿轮廓；ADS 不偏移瞄具
    /** 开始远征时自动进入全屏：全屏下浏览器不再把 Ctrl+W 当成关闭标签页 */
    autoFullscreen: true,
    fovSprintBoost: 8,         // 冲刺时额外 FOV
    fovSpeedBoost: 10,         // 高速时额外 FOV（速度感）
    fovSpeedRef: 22,           // 达到满额 FOV 加速所需速度
    fovKickAds: -22,           // 开镜 FOV 收缩
    maxPixelRatio: 1.5,        // 高帧率优先，默认限制 DPR
    shadows: false,            // 预留：无阴影贴图（保帧）
    fogNear: 70,
    fogFar: 420,
    clearColor: [0.045, 0.055, 0.075, 1],
    targetFpsCap: 0,           // 0 = 不限制
    terrainResolution: 96,
    cullDistance: 700,
    maxInstancesPerDraw: 4096,
  },

  recoil: {
    startShots: 3,             // 第 3 发起进入连射爬升
    rampShots: 7,              // 再以 7 发的跨度平滑提升到满强度
    singleShotScale: 0.035,    // 单发仅 3.5% 的驱动力
    maxPitchSpeedDeg: 7,       // 基础最大上抬角速度（度/秒）
    acceleration: 9,           // 指数速度响应，约 0.33 秒接近目标速度
    braking: 22,               // 停火约 0.14 秒消去 95% 速度，不反向回弹
    burstResetSeconds: 0.30,
  },

  // ------------------------------------------------------------ 相机
  cam: {
    eyeHeight: 1.62,
    crouchEyeHeight: 1.18,
    slideEyeHeight: 0.78,
    eyeLerpRate: 14,           // 姿态眼高插值速率
    bobAmp: 0.035,
    bobFreq: 9.5,
    bobSpeedRef: 9,
    rollMax: 0.055,            // 侧移滚转上限（弧度）
    rollRate: 6.5,
    wallRunRoll: 0.22,         // 蹬墙跑滚转（弧度）
    slideRoll: 0.10,
    tiltAmount: 0.05,
    shakeDecay: 3.4,
    shakeMax: 1.2,
    landDipMax: 0.16,          // 落地相机下沉
    fastFovLerp: 6.0,
    slowFovLerp: 11.0,         // 开镜要求更快
    recoilFovRate: 9,
    pitchLimit: 1.5533,        // ±89°
    strafePitchInfluence: 0.0,
  },

  // ------------------------------------------------------------ 运动（核心）
  move: {
    // 速度
    walkSpeed: 6.6,
    sprintSpeed: 9.0,          // 奔跑上限收紧，避免常规移动压过滑铲/技能的价值
    crouchSpeed: 3.4,
    backwardMul: 0.82,
    sprintWindup: 0.90,        // 奔跑需要明显加速过程，不再一按 Shift 就到顶速
    groundAccel: 78,           // Quake 风格地面加速度
    groundDecel: 62,
    airAccel: 32,              // 空中加速度（Apex 空中控制较强）
    airMaxSpeed: 6.2,          // 空中加速的软上限增量（不是硬上限，保留动量）
    airControl: 0.55,          // 空中转向强度
    airTurnAssist: 1.5,        // 速度矢量与输入夹角大时的额外转向（tap-strafe 手感）
    airDrag: 0.06,             // 极轻微空气阻力，避免无限加速
    friction: 9.0,
    stopSpeed: 2.2,
    gravity: 22.0,
    gravityAirMul: 1.0,
    terminalVel: 62,
    maxSpeed: 42,              // 水平硬上限（防数值崩坏，正常玩不到）
    // 跳跃相关
    jumpVel: 7.6,
    doubleJumpVel: 7.0,
    doubleJumpForwardBoost: 1.6,  // 二段跳沿输入方向额外推力
    coyoteTime: 0.14,
    jumpBuffer: 0.16,
    jumpCutMul: 0.45,          // 提前松开跳跃键的截断（可变跳高）
    bunnyHopBoost: 1.035,      // 落地保留速度的轻微增益
    // 滑铲
    slideMinSpeed: 7.4,        // 必须先跑起来；普通走速不足以启动有效滑铲
    slideSpeed: 12.6,          // 启动加速的目标上限，高速入铲仍完整保留动量
    slideBoost: 2.8,           // 启动瞬间先加速，再由 slideFriction 连续减速
    slideFriction: 3.05,
    slideExitSpeed: 4.8,
    slideCooldown: 0.44,
    slideJumpVel: 8.9,         // 滑铲跳高于普通跳，便于越过掩体并延续连招
    slideJumpForwardBoost: 0.65,
    slideSteer: 0.85,          // 滑铲转向能力
    slideDownhillBoost: 8.5,   // 下坡沿坡加速
    slideDownhillMaxSpeed: 18.5, // 坡面重力助推软上限；保留技能带入的更高动量但不继续无限增速
    slideGroundSnapDist: 0.68, // 高速越过坡折/三角拼缝时向下贴地，避免胶囊前缘卡脚
    slopeAccel: 6.4,           // 通用边坡加速度
    slopeUphillPenalty: 0.55,
    // 蹬墙跑
    wallRunMinSpeed: 5.2,
    wallRunGravity: 3.0,       // 兼容旧存档/改件；实际垂直曲线由下列参数控制
    wallRunStick: 18.0,        // 稳定贴墙力，最终仍由胶囊碰撞消解，不会穿墙
    wallRunTime: 2.2,          // Titanfall 风格：短时间稳定奔跑，而非无限黏墙
    wallRunCooldown: 0.24,
    wallRunUpBoost: 0.75,      // 接墙瞬间轻抬，不凭空大跳
    wallRunSpeedGain: 7.5,     // 沿墙快速进入稳定奔跑速度
    wallRunMaxSpeed: 18.5,
    wallRunHoldTime: 0.42,     // 前段基本保持高度
    wallRunFallSpeed: 0.75,    // 稳定段缓慢下坠
    wallRunEndFallSpeed: 4.8,  // 末段逐步滑落，提示即将离墙
    wallRunContactGrace: 0.10, // 墙面拼缝允许短暂失去射线命中
    wallRunInputGrace: 0.18,   // 松开移动键后仍保留极短动量窗口
    wallRunCameraRoll: 0.22,
    // 蹬墙跳
    wallJumpUp: 7.2,
    wallJumpOut: 8.4,
    wallJumpForward: 3.2,
    wallJumpLockout: 0.18,     // 跳离后短时间内不能重贴同一面墙
    // 墙爬
    wallClimbSpeed: 4.6,
    wallClimbTime: 0.9,
    wallClimbCost: 0,          // 预留：能量消耗
    // 攀爬翻越
    mantleMaxHeight: 2.35,
    mantleReach: 1.35,
    mantleTime: 0.26,
    mantleCooldown: 0.2,
    mantleMinSpeed: 0,
    // 冲刺
    dashSpeed: 26.0,
    dashTime: 0.13,
    dashCooldown: 1.85,        // Dash 是强位移，不应半秒内反复刷新
    dashAirCharges: 1,
    dashGroundRefresh: 1.0,    // 落地后恢复的空中冲刺次数
    dashUpward: 1.2,
    dashPreserveVel: 0.55,     // 冲刺保留的原速度比例
    // 抓钩
    grappleRange: 42,
    grappleSpeed: 34,
    grappleAccel: 92,          // 弹簧加速度
    grapplePull: 22,
    grappleMinDist: 2.0,           // 距离锚点 2m 内自动断钩
    grappleBreakAngleDeg: 58,      // 视线偏离锚点超过此角度后开始计时
    grappleBreakAimTime: 1.0,      // 持续偏离超过 1 秒自动断钩
    grappleCooldown: 0.6,
    grappleDetachSpeed: 34,
    grappleSwingRetain: 1.02,  // 摆荡时轻微速度增益
    grappleAimAssistDeg: 5.5,
    grappleMaxMass: 1,
    // 通用
    // 地图楼梯统一按 <=0.58m 生成；0.64m 的自动跨步余量让环台可直接跑上，
    // 同时仍低于常规掩体高度，不会误爬越箱体。
    stepHeight: 0.64,
    capsuleRadius: 0.35,
    capsuleHeight: 1.8,
    crouchHeight: 1.25,
    slideHeight: 1.1,
    groundSnapDist: 0.36,
    maxSlopeAngleDeg: 48,
    standUpClearanceCheck: true,
    fallDamageSpeed: 34,       // 超过此落地速度开始受伤
    fallDamageScale: 2.6,
    hardLandSpeed: 19,         // 触发硬着陆效果的阈值
    selfDamageFromExplosionMul: 0.35,
  },

  // ------------------------------------------------------------ 相机震动/冲击
  fx: {
    hitmarkerTime: 0.5,
    damageNumbers: true,
    tracers: true,
    impactDecals: true,
    bloodColor: [0.75, 0.12, 0.10],
    sparkColor: [1.0, 0.78, 0.35],
    shieldColor: [0.35, 0.75, 1.0],
    screenShakeScale: 1.0,
    /**
     * 开火 / 命中时的屏幕抖动。默认**关闭**：
     * 用户反馈「射击时的屏幕抖动可以取消」，而且高射速武器下每发都抖会让画面持续晃动。
     * 后坐力由连续角速度驱动相机俯仰，弹道与画面保持同一瞄向，不依赖额外抖动。
     * 兼容旧配置保留此字段；射击与命中不再发送震动事件。
     */
    fireScreenShake: false,
    // 保留可控的枪械后坐；独立的 fireScreenShake 仍默认关闭，避免高频屏幕震动。
    fireCameraRecoil: true,
    hitStopScale: 1.0,
    maxParticles: 4096,
    maxDecals: 320,
    maxProjectiles: 512,
    tracerLife: 0.20,
    slowmoOnKill: 0.0,         // 预留：击杀子弹时间
  },

  // ------------------------------------------------------------ 玩家资源
  gameplay: {
    maxHealth: 100,
    maxShield: 75,
    shieldRegenDelay: 3.6,
    // 脱战后每秒恢复最大护盾的 10%（再乘升级倍率）。保留旧字段作为
    // 第三方/旧存档的兼容回退，实际默认值由 shieldRegenPercent 驱动。
    shieldRegenPercent: 0.10,
    shieldRegenRate: 28,
    shieldRegenDelayDamage: 1.0,   // 受伤时延迟的额外惩罚
    respawnInvuln: 1.5,
    extractHoldTime: 6.0,
    interactTime: 0.4,
    interactRange: 3.2,
    pickupRadius: 2.2,
    alloyPerKill: 3,
    alloyPerElite: 12,
    objectiveAlloy: 40,
    heatPerKill: 0.06,             // 连杀热度（影响刷怪强度与得分倍率）
    heatDecay: 0.045,
    heatMax: 1.0,
    scorePerKill: 100,
    scorePerHeadshot: 60,
    scorePerObjective: 2500,
  },

  // ------------------------------------------------------------ 音频
  audio: {
    master: 0.72,
    sfx: 0.95,
    music: 0.45,
    ui: 0.7,
    muted: false,
  },

  // ------------------------------------------------------------ 调试
  debug: {
    showStats: false,
    showCollision: false,
    showNav: false,
    showGrapple: false,
    noclip: false,
    godMode: false,
    infiniteAmmo: false,
    slowMotion: 0.0,
    freeCam: false,
  },
};

/** 冻结的出厂默认值（深拷贝），resetCFG 用它恢复 */
export const CFG_DEFAULTS = deepFreeze(deepClone(DEFAULTS));

/** 运行时可写的配置对象 */
export const CFG = deepClone(DEFAULTS);

/** 恢复出厂设置 */
export function resetCFG() {
  for (const section of Object.keys(CFG_DEFAULTS)) {
    CFG[section] = deepClone(CFG_DEFAULTS[section]);
  }
}

/** 便捷：读取角度制配置并转弧度 */
export function fovRad() {
  return toRad(CFG.render.fovDeg);
}

/** 把一批 "a.b.c" 路径覆盖到 CFG 上（存档/调试用） */
export function applyCFGOverrides(overrides) {
  if (!overrides) return;
  for (const path of Object.keys(overrides)) {
    const parts = path.split('.');
    let node = CFG;
    for (let i = 0; i < parts.length - 1; i++) {
      if (node[parts[i]] == null || typeof node[parts[i]] !== 'object') node = null;
      else node = node[parts[i]];
      if (!node) break;
    }
    if (node && typeof node === 'object') node[parts[parts.length - 1]] = overrides[path];
  }
}

function deepClone(o) {
  if (Array.isArray(o)) return o.map(deepClone);
  if (o && typeof o === 'object') {
    const r = {};
    for (const k of Object.keys(o)) r[k] = deepClone(o[k]);
    return r;
  }
  return o;
}

function deepFreeze(o) {
  if (o && typeof o === 'object') {
    for (const k of Object.keys(o)) deepFreeze(o[k]);
    Object.freeze(o);
  }
  return o;
}
