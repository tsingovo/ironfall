// ==== player.js — Apex 风格强化运动系统（项目核心） ====
// 运动机制清单（每一项都独立可调，见 core/config.js 的 CFG.move）：
//   1. Quake 风格地面/空中加速（accelerate + 投影速度上限）
//   2. 疾跑加速斜坡（不是瞬间满速）
//   3. 滑铲：继承当前动量、下坡加速、上坡衰减、转向、低姿态相机
//   4. 蹬墙跑：重�力削弱 + 吸附 + 沿墙加速 + 时长限制 + 相机侧倾
//   5. 蹬墙跳：向上 + 离墙 + 沿墙前进方向的三合一冲量
//   6. 墙爬：贴墙按住前即可上升，可銜接翻越
//   7. 攀爬翻越（mantle）：前方可站立面自动登顶
//   8. 二段跳 + coyote time + 跳跃缓冲 + 可变跳高（松键截断）
//   9. 冲刺（dash）：空中次数、FOV 冲击、保留部分动量
//  10. 抓钩（grapple）：弹簧力摆荡，不直接改速度方向，保留动量
//  11. 边坡加速：下坡推进、上坡惩罚；陡壁滑落
//  12. 空中变向：速度矢量对齐（tap-strafe 手感）+ 软上限保留动量
//  13. 连跳：落地保留水平速度并有轻微增益
//  14. 台阶自动上抬
//  15. 胶囊迭代碰撞（不抖动、不穿模、贴墙滑行）
//  16. 相机：眼高插值、速度 bob、落地 dolly、滚转、震动通道
//
// 手感要点：所有加速都作用在"速度矢量"上而不是位置，重力只影响 Y，
// 因此水平动量可以被长期保留 —— 这正是 Apex 滑铲/蹬墙跑爽感的来源。

import { CFG } from './core/config.js';
import * as M from './core/math.js';
import * as Events from './core/events.js';
import { Input } from './core/input.js';
import { MODIFIER_DEFAULTS } from './upgrades.js';

const STATE_AIR = 0;
const STATE_GROUND = 1;
const STATE_SLIDE = 2;
const STATE_WALLRUN = 3;
const STATE_MANTLE = 4;

// 复用的临时向量（热路径零分配）
const T_A = new Float32Array(3);
const T_B = new Float32Array(3);
const T_C = new Float32Array(3);
const T_D = new Float32Array(3);
const T_E = new Float32Array(3);
const T_F = new Float32Array(3);
const WISH = new Float32Array(3);
const FLAT_VEL = new Float32Array(3);
const GROUND_N = new Float32Array(3);

/** Quake 风格加速：把速度沿着 wishDir 推到 wishSpeed，受投影速度上限约束 */
function accelerate(vel, wishDir, wishSpeed, accel, dt, projCap) {
  const current = vel[0] * wishDir[0] + vel[1] * wishDir[1] + vel[2] * wishDir[2];
  const add = wishSpeed - current;
  if (add <= 0) return;
  // projCap < 0 表示不限制（地面）；否则限制"垂直于 wishDir 的速度"可换取的推进量
  let speedAdd = add;
  if (projCap >= 0) {
    const vx = vel[0] - wishDir[0] * current;
    const vy = vel[1] - wishDir[1] * current;
    const vz = vel[2] - wishDir[2] * current;
    const proj = Math.hypot(vx, vy, vz);
    if (proj > projCap) speedAdd = Math.min(add, (wishSpeed - proj) * 0.5);
    if (speedAdd <= 0) return;
  }
  const accelSpeed = Math.min(accel * wishSpeed * dt, speedAdd);
  vel[0] += wishDir[0] * accelSpeed;
  vel[1] += wishDir[1] * accelSpeed;
  vel[2] += wishDir[2] * accelSpeed;
}

/** 地面摩擦（Quake 风格，带 stopSpeed 下限保证能停住） */
function applyFriction(vel, friction, stopSpeed, dt) {
  const speed = Math.hypot(vel[0], vel[1], vel[2]);
  if (speed < 0.05) return;
  const control = speed < stopSpeed ? stopSpeed : speed;
  let newSpeed = speed - control * friction * dt;
  if (newSpeed < 0) newSpeed = 0;
  const s = newSpeed / speed;
  vel[0] *= s; vel[1] *= s; vel[2] *= s;
}

/** 水平速度大小 */
function hspeed(v) { return Math.hypot(v[0], v[2]); }

/** 把速度投影到法线为 n 的平面上（去掉撞墙分量） */
function clipVelocity(vel, n, out, bounce = 0) {
  const d = vel[0] * n[0] + vel[1] * n[1] + vel[2] * n[2];
  out[0] = vel[0] - n[0] * d * (1 + bounce);
  out[1] = vel[1] - n[1] * d * (1 + bounce);
  out[2] = vel[2] - n[2] * d * (1 + bounce);
  return out;
}

export class Player {
  constructor(world, engine, opts = {}) {
    this.world = world;
    this.engine = engine || null;
    this.opts = opts;

    // 位置与速度（pos = 胶囊底部中点）
    this.pos = new Float32Array(3);
    this.vel = new Float32Array(3);
    this.eyePos = new Float32Array(3);
    this.forward = new Float32Array([0, 0, -1]);
    this.right = new Float32Array([1, 0, 0]);
    this.up = new Float32Array([0, 1, 0]);
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this._rollVis = 0;
    this._shakeRoll = 0;
    this._shakePitch = 0;

    // 尺寸
    this.radius = CFG.move.capsuleRadius;
    this.height = CFG.move.capsuleHeight;
    this.standHeight = CFG.move.capsuleHeight;
    this.crouchHeight = CFG.move.crouchHeight;
    this.slideHeight = CFG.move.slideHeight;
    this.currentHeight = this.standHeight;

    // 视觉
    this.eyeHeightOffset = 0;
    this.bobPhase = 0;
    this.bobAmount = 0;
    this._landDip = 0;
    this._landDipVel = 0;
    this._fallStartY = 0;
    this.fovExtra = 0;
    this.fovTarget = 0;
    this.adsFovMul = 1;
    // 武器/治疗等上层动作施加的移动速度倍率。单独保存而不修改输入轴：
    // _wishDir() 会归一化输入，缩放 moveX/moveY 并不能真正降低目标速度。
    this.actionMoveSpeedMul = 1;

    // 状态
    this.state = {
      grounded: false,
      groundNormal: new Float32Array([0, 1, 0]),
      groundKind: 'none',
      sliding: false,
      crouching: false,
      sprinting: false,
      wallRunning: false,
      wallSide: 0,
      wallNormal: new Float32Array(3),
      wallClimbing: false,
      mantling: false,
      dashing: false,
      airJumps: 0,
      dashCharges: CFG.move.dashAirCharges,
      grappleActive: false,
      speed: 0,
      hspeed: 0,
      vspeed: 0,
      sprintFraction: 0,
      lastLandImpact: 0,
      moveState: 'AIR',
    };

    // 计时器
    this.t = {
      coyote: 0,
      jumpBuffer: 0,
      wallRunTime: 0,
      wallRunCooldown: 0,
      wallJumpLockout: 0,
      wallClimbTime: 0,
      slideCooldown: 0,
      dashTime: 0,
      dashCooldown: 0,
      mantleTime: 0,
      mantleCooldown: 0,
      grappleCooldown: 0,
      timeSinceGround: 0,
      jumpHeld: false,
      sprintHold: 0,
      lastWallNormalAge: 0,
    };

    // 生命
    this.maxHealth = CFG.gameplay.maxHealth;
    this.health = this.maxHealth;
    this.maxShield = CFG.gameplay.maxShield;
    this.shield = this.maxShield;
    // 远征内装甲板提供的独立护盾上限；不写进肉鸽 mods，避免下一次应用改件时丢失。
    this.armorShieldBonus = 0;
    this.alive = true;
    this.pveDeaths = 0;
    this.eliminated = false;
    this.invulnTime = 0;
    this._shieldRegenDelay = 0;
    this.shieldBroken = false;

    // 抓钩
    this.grapple = {
      active: false,
      target: null,
      point: new Float32Array(3),
      distance: 0,
      restLength: 0,
      offAimTime: 0,
      attachedEnemy: null,
      maxRange: CFG.move.grappleRange,
    };
    // 滑铲跳在同一物理步内保留滑铲动量，避免速度先被地面摩擦吃掉。
    this._slideJump = false;

    // 攀爬
    this._mantle = { start: new Float32Array(3), end: new Float32Array(3), t: 0, dur: 0.26 };

    // 冲刺方向
    this._dashDir = new Float32Array(3);

    // 修饰符（来自肉鸽升级）
    this.mods = defaultMods();

    // 上一帧位置（用于渲染插值）
    this.prevPos = new Float32Array(3);
    this.prevEyePos = new Float32Array(3);

    // 碰撞求解结果缓存
    this._lastContacts = 0;

    // 相机震动（由外部 fx 系统驱动，这里只保存偏移）
    this.shakeOffset = new Float32Array(3);
    this.shakeRotation = new Float32Array(3);
    this.shakeFov = 0;

    this._inputSprintLatched = false;
    this._wallNormalScratch = new Float32Array(3);
    this._groundForWall = new Float32Array(3);
    this._wallRunDir = new Float32Array(3);
    this._wallRunLostTime = 0;
    this._wallRunNoInputTime = 0;
  }

  // ================================================================ 初始化

  respawn(pos) {
    this.pos[0] = pos[0]; this.pos[1] = pos[1]; this.pos[2] = pos[2];
    // 地图给点与搜索结果仍要经过最终碰撞权威校验，避免缓存/平台边缘或浮点误差
    // 让首帧相机落在地形下方。
    if (this.world && this.world.enforceCapsuleValidity) {
      this.world.enforceCapsuleValidity(this.pos, this.radius, this.standHeight);
    }
    this.prevPos.set(this.pos);
    this.vel[0] = 0; this.vel[1] = 0; this.vel[2] = 0;
    this.health = this.maxHealth;
    this.shield = this.maxShield;
    this.alive = true;
    this.invulnTime = CFG.gameplay.respawnInvuln;
    this._shieldRegenDelay = 0;
    this.shieldBroken = false;
    this.currentHeight = this.standHeight;
    this._resetMoveState();
    this.updateCamera(0);
    this.prevEyePos.set(this.eyePos);
    Events.emit('player:spawn', { pos: this.pos });
  }

  teleport(pos) {
    this.pos[0] = pos[0]; this.pos[1] = pos[1]; this.pos[2] = pos[2];
    this.vel[0] = 0; this.vel[1] = 0; this.vel[2] = 0;
    this._resetMoveState();
    this.updateCamera(0);
  }

  _resetMoveState() {
    const s = this.state;
    // 重生/传送也必须结束持续动作。事件接线层据此关闭循环声部，避免旧状态
    // 留下永不停止的滑铲、墙跑或抓钩声音。
    if (s.sliding) Events.emit('player:slide', { start: false, reason: 'reset' });
    if (s.sprinting) Events.emit('player:sprint', { start: false, reason: 'reset' });
    if (s.wallRunning) Events.emit('player:wallrun', { start: false, side: s.wallSide, reason: 'reset' });
    if (s.wallClimbing) Events.emit('player:wallclimb', { start: false, reason: 'reset' });
    if (s.dashing) Events.emit('player:dash', { start: false, reason: 'reset' });
    if (s.mantling) Events.emit('player:mantle', { start: false, reason: 'reset' });
    if (this.grapple.active) Events.emit('player:grapple', { start: false, point: this.grapple.point, enemy: null, reason: 'reset' });
    s.grounded = false; s.sliding = false; s.crouching = false; s.sprinting = false;
    s.wallRunning = false; s.wallSide = 0; s.wallClimbing = false;
    s.mantling = false; s.dashing = false; s.grappleActive = false;
    s.airJumps = 0; s.dashCharges = this._dashMax(); s.sprintFraction = 0;
    this.t.coyote = 0; this.t.jumpBuffer = 0; this.t.wallRunTime = 0;
    this.t.wallRunCooldown = 0; this.t.slideCooldown = 0; this.t.dashTime = 0;
    this.t.dashCooldown = 0; this.t.mantleTime = 0; this.t.grappleCooldown = 0;
    this.grapple.active = false; this.grapple.attachedEnemy = null; this.grapple.offAimTime = 0;
    this._slideJump = false;
    this._mantle.t = 0;
  }

  setModifiers(mods) {
    this.mods = normalizeMods(mods);
    const mm = this.mods.move;
    this.maxHealth = CFG.gameplay.maxHealth + (mm.maxHealthAdd || 0);
    this.maxShield = CFG.gameplay.maxShield + (mm.maxShieldAdd || 0) + (this.armorShieldBonus || 0);
    this.health = Math.min(this.health, this.maxHealth);
    this.shield = Math.min(this.shield, this.maxShield);
    // 致死免疫充能（升级可能提供多次）
    const charges = mm.cheatDeathCharges || 0;
    if (charges > (this._cheatDeathMax || 0)) {
      this._cheatDeathLeft = charges - (this._cheatDeathMax || 0) + (this._cheatDeathLeft || 0);
    }
    this._cheatDeathMax = charges;
    if (this._cheatDeathLeft == null) this._cheatDeathLeft = charges;
  }

  _dashMax() {
    const mm = this.mods.move;
    return Math.max(0, Math.round(CFG.move.dashAirCharges + (mm.dashChargesAdd || 0)));
  }

  // ================================================================ 视角

  /**
   * 应用视角变化量。
   *
   * 契约（上层必须按此约定传参，否则会出现"瞄准反向"）：
   *   dxRad 直接累加到 yaw；由于本项目 yaw 正方向朝左，输入层把鼠标右移映射为负值。
   *   dyRad > 0 → 视角向下看（pitch 减小）。DOM movementY 本来就是向下为正，
   *   所以默认 Y 轴不能再取反；只有设置开启 invertY 时才反向。
   */
  look(dxRad, dyRad) {
    this.yaw = M.wrapAngle(this.yaw + dxRad);
    this.pitch = M.clamp(this.pitch - dyRad, -CFG.cam.pitchLimit, CFG.cam.pitchLimit);
  }

  /**
   * 由视角计算朝向基向量。
   * 约定：yaw=0 时朝 -Z；yaw 增大 → forward.x 减小（视线向左转）。
   * 与 `look()` 的符号约定必须一致，否则会出现"瞄准反向"。
   */
  updateBasis() {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    // yaw=0 朝 -Z；yaw 增大转向 +X
    this.forward[0] = -sy * cp;
    this.forward[1] = sp;
    this.forward[2] = -cy * cp;
    // right = normalize(cross(forward, worldUp)) 的水平化版本
    this.right[0] = cy;
    this.right[1] = 0;
    this.right[2] = -sy;
    // up 由 roll 旋转
    const cr = Math.cos(this.roll), sr = Math.sin(this.roll);
    const ux = sy * sp, uy = cp, uz = cy * sp;
    this.up[0] = ux * cr + this.right[0] * sr;
    this.up[1] = uy * cr + this.right[1] * sr;
    this.up[2] = uz * cr + this.right[2] * sr;
  }

  // ================================================================ 主步进

  /**
   * 固定步长物理更新。
   * input 需提供：{ moveX, moveY, jump, jumpPressed, jumpReleased, crouch, crouchPressed,
   *                 sprint, dashPressed, grappleDown, grapplePressed, lookX, lookY }
   */
  step(dt, input) {
    if (!this.alive) { this.updateCamera(dt); return; }

    const move = CFG.move;
    const mods = this.mods.move || {};
    const s = this.state;
    const t = this.t;

    // --- 视角输入
    if (input.lookX || input.lookY) this.look(input.lookX, input.lookY);
    // 注意：basis 在鼠标旋转后立即更新，保证移动方向与准心一致
    this.updateBasis();

    if (this.invulnTime > 0) this.invulnTime -= dt;
    if (this._cheatDeathCooldown > 0) this._cheatDeathCooldown -= dt;

    // --- 计时器衰减
    t.jumpBuffer = Math.max(0, t.jumpBuffer - dt);
    t.coyote = Math.max(0, t.coyote - dt);
    t.wallRunCooldown = Math.max(0, t.wallRunCooldown - dt);
    t.wallJumpLockout = Math.max(0, t.wallJumpLockout - dt);
    t.slideCooldown = Math.max(0, t.slideCooldown - dt);
    t.dashCooldown = Math.max(0, t.dashCooldown - dt);
    t.mantleCooldown = Math.max(0, t.mantleCooldown - dt);
    t.grappleCooldown = Math.max(0, t.grappleCooldown - dt);
    t.timeSinceGround += dt;

    if (input.jumpPressed) t.jumpBuffer = move.jumpBuffer;
    t.jumpHeld = !!input.jump;

    this.prevPos[0] = this.pos[0];
    this.prevPos[1] = this.pos[1];
    this.prevPos[2] = this.pos[2];

    // --- 抓钩更新（在移动之前，因为它是外力）
    this._updateGrapple(dt, input, mods);

    // --- 攀爬中：直接插值，跳过常规物理
    if (s.mantling) {
      this._updateMantle(dt);
      this._integrate(dt, true);
      this._postStep(dt, input);
      return;
    }

    // --- 冲刺：独立的位移通道
    if (s.dashing) {
      this._updateDash(dt, input, mods);
      this._integrate(dt, false);
      this._postStep(dt, input);
      return;
    }

    // --- 蹲伏 / 滑铲状态决策
    this._updateStance(dt, input, mods);

    // --- 冲刺触发（必须在这里显式调用：冲刺是独立位移通道，
    //     不接入状态机的话按键会完全没有反应）
    if (input.dashPressed && !s.dashing && !s.mantling) {
      this._tryDash(input, mods);
      if (s.dashing) {
        this._updateDash(dt, input, mods);
        this._integrate(dt, false);
        this._postStep(dt, input);
        return;
      }
    }

    // --- 根据地面状态决定运动模型
    if (s.sliding || this._slideJump) {
      this._moveSlide(dt, input, mods);
    } else if (s.wallRunning) {
      this._moveWallRun(dt, input, mods);
    } else if (s.grounded) {
      this._moveGround(dt, input, mods);
    } else {
      this._moveAir(dt, input, mods);
    }

    // --- 跳跃处理（在运动之后，保证跳跃冲量不被本帧加速覆盖）
    this._handleJump(dt, input, mods);
    this._slideJump = false;

    // --- 重力（滑铲/蹬墙跑内部已处理，用标志跳过）
    if (!this._gravityHandled) {
      if (s.grounded) {
        // 已落地时不要每个物理步继续把胶囊压进斜坡。旧逻辑先施加向下重力，
        // resolveCapsule 再沿斜面法线推出；推出量包含 X/Z 分量，即使水平速度为 0
        // 也会让无操作角色持续沿地图漂移。离开平台后下一步会恢复空中重力。
        if (this.vel[1] < 0) this.vel[1] = 0;
      } else {
        let g = move.gravity * (mods.gravityAirMul != null ? mods.gravityAirMul : move.gravityAirMul);
        if (mods.gravityMul != null) g *= mods.gravityMul;
        this.vel[1] -= g * dt;
      }
    }
    this._gravityHandled = false;

    // --- 终端速度
    const term = move.terminalVel;
    if (this.vel[1] < -term) this.vel[1] = -term;

    // --- 水平硬上限
    const hsp = hspeed(this.vel);
    const maxH = move.maxSpeed * (mods.maxSpeedMul || 1);
    if (hsp > maxH) {
      const k = maxH / hsp;
      this.vel[0] *= k; this.vel[2] *= k;
    }

    this._integrate(dt, false);
    this._postStep(dt, input);
  }

  // ---------------------------------------------------------------- 姿态

  _updateStance(dt, input, mods) {
    const move = CFG.move;
    const s = this.state;
    const t = this.t;
    const crouchHeld = !!input.crouch;
    const wantCrouch = crouchHeld;
    const slideJump = s.sliding && !!input.jumpPressed;
    if (slideJump) {
      // Apex 风格滑铲跳：空格优先于蹲伏维持，当前帧保留滑行速度并立即起跳。
      this._endSlide();
      this._slideJump = true;
    }

    if (wantCrouch) {
      if (!s.grounded) {
        // 空中按下蹲：给一个向下的助推（Apex 里用于快速落地/变向）
        this.vel[1] -= 3.5 * dt * 10;
      }
    }

    // 滑铲触发：必须已经进入奔跑加速并达到门槛速度。普通走路时按蹲只会
    // 蹲下，不再凭空触发强位移；这样滑铲成为“跑 → 铲”的连招。
    if (wantCrouch && s.grounded && !s.sliding && t.slideCooldown <= 0) {
      const speed = hspeed(this.vel);
      const sprintReady = s.sprinting && s.sprintFraction >= 0.28;
      if (sprintReady && speed >= move.slideMinSpeed * (mods.slideMinSpeedMul || 1)) {
        this._startSlide(mods);
      }
    }

    // 滑铲维持判定
    if (s.sliding) {
      const speed = hspeed(this.vel);
      const downhill = this._slopeAlongVelocity();
      const exitSpeed = move.slideExitSpeed * (mods.slideExitSpeedMul || 1);
      const wantsExit = !wantCrouch && downhill > -0.12;
      if (!s.grounded || speed < exitSpeed || wantsExit) {
        this._endSlide();
      }
      // 蹲伏保持
      s.crouching = s.sliding || (wantCrouch && !slideJump);
    } else {
      s.crouching = wantCrouch && s.grounded && !slideJump;
    }

    // 目标高度
    let target = this.standHeight;
    if (s.sliding) target = this.slideHeight;
    else if (s.crouching) target = this.crouchHeight;
    // 低矮空间强制下蹲（简化：探测头顶）
    this.currentHeight = M.damp(this.currentHeight, target, 16, dt);
    if (s.sliding) this.currentHeight = this.slideHeight;

    // 冲刺状态（仅地面且不在滑铲）
    const sprintInput = !!input.sprint;
    const wasSprinting = s.sprinting;
    s.sprinting = sprintInput && s.grounded && !s.sliding && !s.crouching
      && (input.moveY > 0.2);
    if (s.sprinting !== wasSprinting) {
      Events.emit('player:sprint', { start: s.sprinting, speed: hspeed(this.vel) });
      Events.emit('audio:play', { name: s.sprinting ? 'sprint_start' : 'sprint_end', gain: 0.72 });
    }
    if (s.sprinting) {
      const windup = move.sprintWindup * (mods.sprintWindupMul || 1);
      t.sprintHold = Math.min(1, t.sprintHold + dt / Math.max(0.01, windup));
    } else {
      const windup = move.sprintWindup * (mods.sprintWindupMul || 1);
      t.sprintHold = Math.max(0, t.sprintHold - dt / Math.max(0.01, windup) * 1.6);
    }
    s.sprintFraction = t.sprintHold;
  }

  _startSlide(mods) {
    const s = this.state;
    s.sliding = true;
    // 达到奔跑门槛后，滑铲启动会先获得一次有上限的小加速，随后进入连续
    // 摩擦衰减。高速技能入铲不会被强行降到 slideSpeed，原有动量完整保留。
    const speed = hspeed(this.vel);
    if (speed > 0.01) {
      const target = CFG.move.slideSpeed * (mods.slideSpeedMul || 1);
      const boost = CFG.move.slideBoost * (mods.slideBoostMul || 1);
      const boosted = Math.max(speed, Math.min(target, speed + boost));
      const k = boosted / speed;
      this.vel[0] *= k;
      this.vel[2] *= k;
    }
    // 保留一点向下速度让滑铲贴地
    if (this.vel[1] > 1) this.vel[1] = 1;
    Events.emit('player:slide', { start: true });
    Events.emit('audio:play', { name: 'slide_start', gain: 0.82 });
  }

  _endSlide() {
    const s = this.state;
    if (!s.sliding) return;
    s.sliding = false;
    this.t.slideCooldown = CFG.move.slideCooldown;
    Events.emit('player:slide', { start: false });
    Events.emit('audio:play', { name: 'slide_end', gain: 0.68 });
  }

  /** 当前速度方向上的坡度（正 = 向下滑，负 = 向上坡） */
  _slopeAlongVelocity() {
    const speed = hspeed(this.vel);
    if (speed < 0.1) return 0;
    const n = this.world.groundNormal(this.pos[0], this.pos[2], GROUND_N);
    const dx = this.vel[0] / speed, dz = this.vel[2] / speed;
    // 坡面沿运动方向的切向 y 分量：坡面法线点乘水平方向得到坡的倾斜
    // groundNormal 的 XZ 分量指向高度下降方向（n = normalize(-dh/dx,1,-dh/dz)）。
    return (n[0] * dx + n[2] * dz) / Math.max(0.2, n[1]);
  }

  // ---------------------------------------------------------------- 地面移动

  _moveGround(dt, input, mods) {
    const move = CFG.move;
    const s = this.state;
    const t = this.t;

    // 摩擦
    let friction = move.friction * (mods.frictionMul || 1);
    applyFriction(this.vel, friction, move.stopSpeed, dt);

    // 期望方向（相机相对）
    this._wishDir(input, WISH, true);
    let wishSpeed = move.walkSpeed * (mods.walkSpeedMul || 1);
    if (s.crouching) {
      wishSpeed = move.crouchSpeed * (mods.crouchSpeedMul || 1);
    } else if (s.sprinting) {
      const sprintTop = move.sprintSpeed * (mods.sprintSpeedMul || 1);
      wishSpeed = M.lerp(move.walkSpeed, sprintTop, s.sprintFraction);
    }
    // 后退惩罚
    if (input.moveY < 0) wishSpeed *= move.backwardMul;
    // ADS 等动作的速度限制作用在最终目标速度上；摩擦仍照常工作，所以已有
    // 动量会自然减到新上限，而不是按右键时生硬地把玩家瞬间刹停。
    wishSpeed *= this.actionMoveSpeedMul;
    // 侧向不额外惩罚（保留 strafe 手感）

    accelerate(this.vel, WISH, wishSpeed, move.groundAccel * (mods.groundAccelMul || 1), dt, -1);

    const inputMag = Math.hypot(input.moveX || 0, input.moveY || 0);
    // 只有玩家主动移动时才加入普通地面下坡助力。站立不动时允许摩擦彻底
    // 消除旧动量，不能让坡面力在每帧重新制造速度；真正滑坡仍由滑铲/陡坡分支负责。
    if (inputMag >= 0.02) this._applySlopeForce(dt, mods);

    // 小于物理噪声的残余水平速度直接归零，避免松开所有按键后角色仍
    // 相对地面缓慢爬行（尤其是三角地形法线存在微小误差时）。
    if (inputMag < 0.02 && hspeed(this.vel) < 0.18) {
      this.vel[0] = 0;
      this.vel[2] = 0;
    }
  }

  /** 边坡力：把重力在坡面上的切向分量作用到速度上 */
  _applySlopeForce(dt, mods, forceOverride) {
    const move = CFG.move;
    const s = this.state;
    const n = s.grounded ? s.groundNormal : this.world.groundNormal(this.pos[0], this.pos[2], GROUND_N);
    if (n[1] < 0.55) return;   // 太陡，交给滑落逻辑
    // 平面/三角拼接的法线会有极小 XZ 抖动；低于约 2° 时不施加坡力，
    // 否则静止角色会被每帧推向同一侧，表现为“无操作缓慢移动”。
    if (Math.hypot(n[0], n[2]) < 0.035) return;
    // 切向重力方向（水平分量指向下坡）
    const g = move.gravity;
    const slopeX = n[0] * n[1] * g;
    const slopeZ = n[2] * n[1] * g;
    let k = (forceOverride != null ? forceOverride : move.slopeAccel) * (mods.slopeAccelMul || 1);
    if (k <= 0) return;
    // 只在下坡时施加（用速度方向判断）
    const speed = hspeed(this.vel);
    if (speed > 0.2) {
      const dx = this.vel[0] / speed, dz = this.vel[2] / speed;
      const along = slopeX * dx + slopeZ * dz;
      if (along < 0) k *= move.slopeUphillPenalty;   // 上坡衰减
    }
    this.vel[0] += slopeX * k * dt;
    this.vel[2] += slopeZ * k * dt;
  }

  // ---------------------------------------------------------------- 滑铲

  _moveSlide(dt, input, mods) {
    const move = CFG.move;
    const s = this.state;

    // 沿速度方向的摩擦（比地面小得多）
    const speed = hspeed(this.vel);
    if (speed > 0.01) {
      let fr = move.slideFriction * (mods.slideFrictionMul || 1);
      // 下坡时摩擦大幅降低 —— 这是"滑铲下山越来越快"的关键
      const slope = this._slopeAlongVelocity();
      if (slope > 0) fr *= M.clamp(1 - slope * 1.4, 0.08, 1);
      const newSpeed = Math.max(0, speed - fr * dt * Math.max(1, speed / 8));
      const k = newSpeed / speed;
      this.vel[0] *= k; this.vel[2] *= k;
    }

    // 贴地滑铲的速度必须位于真实坡面切面内。旧实现只沿“已有水平速度”助推，
    // 且每帧另加负 Y 重力；跨坡折时扫掠球会把整段水平位移一起截断，形成卡脚。
    // 现在以地面法线求最陡下降方向，并让垂直速度恰好满足 dot(v,n)=0。
    const n = s.groundNormal;
    if (s.grounded && n[1] > 0.55) {
      this.vel[1] = -(n[0] * this.vel[0] + n[2] * this.vel[2]) / Math.max(0.2, n[1]);
      const slopeMag = Math.hypot(n[0], n[2]);
      const downhillCap = move.slideDownhillMaxSpeed || move.maxSpeed;
      if (slopeMag > 0.035 && hspeed(this.vel) < downhillCap) {
        const boost = move.slideDownhillBoost * (mods.slideDownhillMul || 1);
        // normal.xz 就是真实最陡下坡方向；不再错误地沿旧速度方向“凭空推”。
        this.vel[0] += n[0] * boost * dt;
        this.vel[2] += n[2] * boost * dt;
      }
      // 助推改变水平分量后再次投影，保证最终积分位移仍严格贴合坡面。
      this.vel[1] = -(n[0] * this.vel[0] + n[2] * this.vel[2]) / Math.max(0.2, n[1]);
    }

    // 滑铲中的转向：允许有限度地改变方向
    this._wishDir(input, WISH, true);
    const curSpeed = hspeed(this.vel);
    if (curSpeed > 0.2) {
      const steer = move.slideSteer * dt * (mods.slideSteerMul || 1);
      const wishH = T_A;
      wishH[0] = WISH[0]; wishH[1] = 0; wishH[2] = WISH[2];
      const wl = Math.hypot(wishH[0], wishH[2]);
      if (wl > 0.001) {
        const curDir = T_B;
        curDir[0] = this.vel[0] / curSpeed;
        curDir[2] = this.vel[2] / curSpeed;
        const nl = wl;
        const ndx = curDir[0] + (wishH[0] / nl - curDir[0]) * steer;
        const ndz = curDir[2] + (wishH[2] / nl - curDir[2]) * steer;
        const nlen = Math.hypot(ndx, ndz) || 1;
        this.vel[0] = ndx / nlen * curSpeed;
        this.vel[2] = ndz / nlen * curSpeed;
      }
    }

    // 转向同样会改变水平分量；积分前作最终切面约束，避免斜向操控时重新压坡。
    if (s.grounded && n[1] > 0.55) {
      this.vel[1] = -(n[0] * this.vel[0] + n[2] * this.vel[2]) / Math.max(0.2, n[1]);
    }

    // 离地后才恢复重力；贴地时负 Y 已由坡面切向投影给出，不能再把胶囊压进地面。
    if (!s.grounded) this.vel[1] -= move.gravity * 0.5 * dt;
    this._gravityHandled = true;
  }

  // ---------------------------------------------------------------- 空中

  _moveAir(dt, input, mods) {
    const move = CFG.move;
    const s = this.state;

    this._wishDir(input, WISH, true);
    const wishSpeed = (move.sprintSpeed * 0.86) * (mods.airSpeedMul || 1)
      * this.actionMoveSpeedMul;

    // 空中加速：投影速度上限让"速度矢量对齐"成为可能（tap-strafe 手感）
    // 纯前推时不启用（避免无脑加速），有侧向分量时启用
    const strafeMag = Math.abs(input.moveX);
    const cap = strafeMag > 0.05 ? move.airMaxSpeed * (mods.airProjCapMul || 1) : 0;
    accelerate(this.vel, WISH, wishSpeed * move.airControl, move.airAccel * (mods.airAccelMul || 1), dt, cap);

    // 额外转向力：当速度矢量与期望方向夹角大时提供柔和纠偏
    const hsp = hspeed(this.vel);
    if (hsp > 1.5) {
      const cur = T_A;
      cur[0] = this.vel[0] / hsp; cur[2] = this.vel[2] / hsp;
      const wishH = T_B;
      wishH[0] = WISH[0]; wishH[2] = WISH[2];
      const wl = Math.hypot(wishH[0], wishH[2]);
      if (wl > 0.01) {
        wishH[0] /= wl; wishH[2] /= wl;
        const cosA = M.clamp(cur[0] * wishH[0] + cur[2] * wishH[2], -1, 1);
        const angle = Math.acos(cosA);
        if (angle > 0.35) {
          const turn = move.airTurnAssist * (mods.airControlMul || 1) * (angle / Math.PI) * dt * 2.2;
          const ndx = cur[0] + (wishH[0] - cur[0]) * Math.min(1, turn);
          const ndz = cur[2] + (wishH[2] - cur[2]) * Math.min(1, turn);
          const nl = Math.hypot(ndx, ndz) || 1;
          this.vel[0] = ndx / nl * hsp;
          this.vel[2] = ndz / nl * hsp;
        }
      }
    }

    // 极轻微空气阻力（防止无限加速，但保留绝大部分动量）
    const drag = move.airDrag;
    if (drag > 0) {
      const f = Math.max(0, 1 - drag * dt);
      this.vel[0] *= f; this.vel[2] *= f;
    }
  }

  // ---------------------------------------------------------------- 蹬墙跑

  /** 检测可蹬墙的墙面（左右两侧 + 前方），返回法线与方向 */
  _detectWall(out) {
    const move = CFG.move;
    const r = this.radius + 0.42;
    const h = this.currentHeight;
    const origins = [
      [this.right[0], this.right[1], this.right[2]],
      [-this.right[0], -this.right[1], -this.right[2]],
      [this.forward[0], this.forward[1], this.forward[2]],
    ];
    let bestDot = 0.7;
    let found = false;
    const center = T_C;
    center[0] = this.pos[0]; center[1] = this.pos[1] + h * 0.55; center[2] = this.pos[2];
    const dir = T_D;
    const probe = T_E;
    for (let i = 0; i < origins.length; i++) {
      dir[0] = origins[i][0]; dir[1] = 0; dir[2] = origins[i][2];
      const dl = Math.hypot(dir[0], dir[2]);
      if (dl < 1e-4) continue;
      dir[0] /= dl; dir[2] /= dl;
      // 从上中下三个高度各探一次，命中率更高
      for (const yOff of [0.15, 0.55, 0.9]) {
        probe[0] = this.pos[0]; probe[1] = this.pos[1] + h * yOff; probe[2] = this.pos[2];
        const hit = this.world.raycast(probe, dir, r, { hitTriangles: true, hitBoxes: true });
        if (hit.hit && Math.abs(hit.normal[1]) < 0.34) {
          const facing = -(dir[0] * hit.normal[0] + dir[2] * hit.normal[2]);
          if (facing > bestDot) {
            bestDot = facing;
            out[0] = hit.normal[0]; out[1] = 0; out[2] = hit.normal[2];
            const nl = Math.hypot(out[0], out[2]) || 1;
            out[0] /= nl; out[2] /= nl;
            found = true;
          }
        }
      }
    }
    return found ? out : null;
  }

  _tryStartWallRun(mods, input) {
    const move = CFG.move;
    const s = this.state;
    const t = this.t;
    if (s.grounded || s.wallRunning) return false;
    if (t.wallRunCooldown > 0 || t.wallJumpLockout > 0) return false;
    const speed = hspeed(this.vel);
    const need = move.wallRunMinSpeed * (mods.wallRunMinSpeedMul || 1);
    if (speed < need) return false;
    if (this.vel[1] > 6.5) return false;             // 上升太快时不贴墙
    // 必须有一点贴墙的意愿（不能背对墙）
    const n = T_F;
    if (!this._detectWall(n)) return false;
    // 不能因为高速掠过墙边就自动吸墙。只有玩家有移动/跳跃意图，
    // 或速度确实朝墙推进时才进入蹬墙跑；静止贴墙时保持普通空中物理。
    const hasIntent = !!input && (
      Math.hypot(input.moveX || 0, input.moveY || 0) > 0.08 || !!input.jump
    );
    const towardWall = -(this.vel[0] * n[0] + this.vel[2] * n[2]);
    if (!hasIntent && towardWall < 0.8) return false;
    if (this._wallNormalScratch[0] * n[0] + this._wallNormalScratch[2] * n[2] > 0.94 && t.lastWallNormalAge < 0.3) {
      // 刚离开同一面墙，短时间内不再贴
      return false;
    }

    s.wallRunning = true;
    s.wallNormal[0] = n[0]; s.wallNormal[1] = 0; s.wallNormal[2] = n[2];
    // 侧别：法线指向玩家，判断墙在左侧还是右侧
    const sideDot = n[0] * this.right[0] + n[2] * this.right[2];
    s.wallSide = sideDot > 0 ? -1 : 1;   // 墙在右侧 => side = 1
    t.wallRunTime = move.wallRunTime * (mods.wallRunTimeMul || 1);
    this._wallRunLostTime = 0;
    this._wallRunNoInputTime = 0;
    // 入墙时就锁定与当前动量同向的墙面切线。后续允许随弯墙渐变，但不会因
    // 玩家转动视角而突然 180° 掉头，这是旧实现最不像 Titanfall 的地方。
    let tx = -n[2], tz = n[0];
    if (this.vel[0] * tx + this.vel[2] * tz < 0) { tx = -tx; tz = -tz; }
    this._wallRunDir[0] = tx; this._wallRunDir[1] = 0; this._wallRunDir[2] = tz;
    // 贴上瞬间的向上助推
    if (this.vel[1] < 0) this.vel[1] *= 0.35;
    this.vel[1] += move.wallRunUpBoost * (mods.wallRunBoostMul || 1);
    // 蹬墙不再刷新 Dash；否则贴一下墙就能绕过冷却连续爆发。
    s.airJumps = 0;
    Events.emit('player:wallrun', { start: true, side: s.wallSide });
    Events.emit('audio:play', { name: 'wallrun_start', gain: 0.78 });
    return true;
  }

  _moveWallRun(dt, input, mods) {
    const move = CFG.move;
    const s = this.state;
    const t = this.t;

    // 重新检测墙面（保持贴墙）
    const n = T_F;
    if (!this._detectWall(n)) {
      this._wallRunLostTime += dt;
      if (this._wallRunLostTime > move.wallRunContactGrace) {
        this._endWallRun();
        this._moveAir(dt, input, mods);
        return;
      }
      // 跨过墙体模型拼缝时短暂复用上一帧法线，避免连续断续重贴。
      n[0] = s.wallNormal[0]; n[1] = 0; n[2] = s.wallNormal[2];
    } else {
      this._wallRunLostTime = 0;
      s.wallNormal[0] = n[0]; s.wallNormal[1] = 0; s.wallNormal[2] = n[2];
    }

    // 松开方向键时不要继续“黏”在墙上；按离墙方向也立即退出，
    // 交还给空中加速，避免玩家只能等计时器结束或被迫按跳才能脱离。
    const moveMag = Math.hypot(input.moveX || 0, input.moveY || 0);
    this._wishDir(input, WISH, true);
    const awayIntent = WISH[0] * n[0] + WISH[2] * n[2] > 0.42;
    if (moveMag < 0.08) this._wallRunNoInputTime += dt;
    else this._wallRunNoInputTime = 0;
    if (this._wallRunNoInputTime > move.wallRunInputGrace || awayIntent || input.crouchPressed) {
      this._endWallRun();
      this._moveAir(dt, input, mods);
      return;
    }

    // 计时
    t.wallRunTime -= dt;
    if (t.wallRunTime <= 0) {
      this._endWallRun();
      this._moveAir(dt, input, mods);
      return;
    }

    // 沿墙方向：以入墙动量为主，依据新墙面的切线平滑转弯。镜头可自由查看，
    // 不再用 forward 投影强行改写奔跑方向。
    const along = T_A;
    along[0] = -n[2]; along[1] = 0; along[2] = n[0];
    if (along[0] * this._wallRunDir[0] + along[2] * this._wallRunDir[2] < 0) {
      along[0] = -along[0]; along[2] = -along[2];
    }
    const turn = M.clamp(8.5 * dt, 0, 1);
    this._wallRunDir[0] += (along[0] - this._wallRunDir[0]) * turn;
    this._wallRunDir[2] += (along[2] - this._wallRunDir[2]) * turn;
    const wl = Math.hypot(this._wallRunDir[0], this._wallRunDir[2]) || 1;
    along[0] = this._wallRunDir[0] / wl; along[2] = this._wallRunDir[2] / wl;

    // 只读取沿墙切线的动量；吸附墙面的法向速度不属于奔跑速度，不能在下一帧
    // 被错误转换成切向加速（旧实现会因此每帧凭空提速）。
    let speed = Math.max(0, this.vel[0] * along[0] + this.vel[2] * along[2]);
    speed = Math.max(speed, move.wallRunMinSpeed * (mods.wallRunMinSpeedMul || 1));
    const maxRun = move.wallRunMaxSpeed * (mods.wallRunMaxSpeedMul || 1);
    const gain = move.wallRunSpeedGain * (mods.wallRunSpeedMul || 1);
    speed = Math.min(maxRun, speed + gain * dt);
    this.vel[0] = along[0] * speed;
    this.vel[2] = along[2] * speed;

    // 吸附：向墙施加力，避免"飞出去"
    const toWall = T_C;
    toWall[0] = -n[0]; toWall[1] = 0; toWall[2] = -n[2];
    const velIntoWall = this.vel[0] * toWall[0] + this.vel[2] * toWall[2];
    const stick = move.wallRunStick * (mods.wallRunStickMul || 1);
    const contactSpeed = Math.min(2.4, stick * 0.14);
    if (velIntoWall < contactSpeed) {
      const add = Math.min(stick * dt * 4, contactSpeed - velIntoWall);
      this.vel[0] += toWall[0] * add;
      this.vel[2] += toWall[2] * add;
    }

    // Titanfall 式垂直曲线：接墙后短暂稳定高度，随后从轻微下坠平滑过渡到
    // 明显滑落。它既不像普通跳跃立刻掉下去，也不会在墙上悬浮。
    const total = Math.max(0.01, move.wallRunTime * (mods.wallRunTimeMul || 1));
    const elapsed = Math.max(0, total - t.wallRunTime);
    let targetVy;
    if (elapsed < move.wallRunHoldTime) targetVy = 0.35;
    else {
      const fallT = M.clamp01((elapsed - move.wallRunHoldTime) / Math.max(0.01, total - move.wallRunHoldTime));
      targetVy = -M.lerp(move.wallRunFallSpeed, move.wallRunEndFallSpeed, fallT * fallT);
    }
    this.vel[1] = M.damp(this.vel[1], targetVy, 10, dt);
    this._gravityHandled = true;

    // 蹬墙时相机向墙侧滚转
    this.roll = M.damp(this.roll, move.wallRunCameraRoll * s.wallSide, 9, dt);

    // 离开判定：速度太低或玩家反向
    if (hspeed(this.vel) < move.wallRunMinSpeed * 0.6) {
      this._endWallRun();
    }
  }

  _endWallRun() {
    const s = this.state;
    if (!s.wallRunning) return;
    s.wallRunning = false;
    this._wallRunLostTime = 0;
    this._wallRunNoInputTime = 0;
    this.t.wallRunCooldown = CFG.move.wallRunCooldown;
    this._wallNormalScratch[0] = s.wallNormal[0];
    this._wallNormalScratch[2] = s.wallNormal[2];
    this.t.lastWallNormalAge = 0;
    Events.emit('player:wallrun', { start: false, side: s.wallSide });
    Events.emit('audio:play', { name: 'wallrun_end', gain: 0.66 });
    s.wallSide = 0;
  }

  /** 蹬墙跳：法线方向的离墙冲量 + 沿墙前进方向的冲量 + 向上冲量，并保留部分原速度 */
  _wallJump(mods) {
    const move = CFG.move;
    const s = this.state;
    const n = s.wallNormal;
    const up = move.wallJumpUp * (mods.wallJumpMul || 1);
    const out = move.wallJumpOut * (mods.wallJumpMul || 1);
    const fwd = move.wallJumpForward * (mods.wallJumpMul || 1);

    // 沿墙前进方向（水平，与法线正交，取与当前速度同侧）
    const tx = -n[2], tz = n[0];
    const dot = this.vel[0] * tx + this.vel[2] * tz;
    const sgn = dot >= 0 ? 1 : -1;

    // 先记下原水平速度，跳出后保留一部分，避免蹬墙跳把动量清零
    const prevHx = this.vel[0];
    const prevHz = this.vel[2];
    const keep = 0.4;

    this.vel[0] = n[0] * out + tx * sgn * fwd + prevHx * keep;
    this.vel[2] = n[2] * out + tz * sgn * fwd + prevHz * keep;
    this.vel[1] = up;

    const t = this.t;
    t.wallJumpLockout = move.wallJumpLockout;
    t.wallRunCooldown = move.wallRunCooldown;
    t.coyote = 0;
    t.jumpBuffer = 0;
    s.grounded = false;
    s.airJumps = 0;
    // 墙跳只重置二段跳，不刷新 Dash 冷却/次数。
    this._endWallRun();
    Events.emit('player:jump', { kind: 'wall' });
    Events.emit('audio:play', { name: 'jump', gain: 0.9, rate: 1.12 });
  }

  /** 墙爬：贴墙上升 */
  _updateWallClimb(dt, input, mods) {
    const move = CFG.move;
    const s = this.state;
    const t = this.t;
    const wantClimb = input.jump && input.moveY > 0.3 && !s.grounded;
    if (!wantClimb) { this._setWallClimbing(false); t.wallClimbTime = move.wallClimbTime; return false; }
    const n = T_F;
    if (!this._detectWall(n)) { this._setWallClimbing(false); return false; }
    // 只有明确朝墙冲并按住跳跃才是墙爬；沿着侧墙前进时应进入墙跑，不能
    // 被这条优先级更高的分支抢走。
    this._wishDir(input, WISH, true);
    const towardWall = -(WISH[0] * n[0] + WISH[2] * n[2]);
    if (towardWall < 0.55) { this._setWallClimbing(false); return false; }
    if (t.wallClimbTime <= 0) { this._setWallClimbing(false); return false; }
    this._setWallClimbing(true);
    t.wallClimbTime -= dt;
    this.vel[1] = move.wallClimbSpeed * (mods.wallClimbSpeedMul || 1);
    // 水平速度向墙压
    this.vel[0] = -n[0] * 1.2;
    this.vel[2] = -n[2] * 1.2;
    this._gravityHandled = true;
    // 尝试銜接翻越
    this._tryMantle(mods, true);
    return true;
  }

  _setWallClimbing(active) {
    const s = this.state;
    if (s.wallClimbing === active) return;
    s.wallClimbing = active;
    Events.emit('player:wallclimb', { start: active });
    Events.emit('audio:play', { name: active ? 'wallclimb_start' : 'wallclimb_end', gain: active ? 0.74 : 0.62 });
  }

  // ---------------------------------------------------------------- 跳跃

  _handleJump(dt, input, mods) {
    const move = CFG.move;
    const s = this.state;
    const t = this.t;

    // 墙爬优先（按住前 + 跳跃 贴墙）
    if (this._updateWallClimb(dt, input, mods)) return;

    if (t.jumpBuffer <= 0) return;

    // 1) 蹬墙跑中 -> 蹬墙跳
    if (s.wallRunning) {
      this._wallJump(mods);
      return;
    }

    // 2) 地面 / coyote -> 普通跳或滑铲跳
    if (s.grounded || t.coyote > 0) {
      const slideJump = this._slideJump;
      const jumpSpeed = slideJump ? move.slideJumpVel : move.jumpVel;
      this.vel[1] = jumpSpeed * (mods.jumpVelMul || 1);
      if (slideJump) {
        // 继承滑铲全部水平动量并沿当前方向追加很小推力；本帧不会进入普通
        // 地面摩擦，所以 Ctrl/C + Space 可以稳定做出更高的滑铲跳。
        const speed = hspeed(this.vel);
        if (speed > 0.01) {
          const boost = move.slideJumpForwardBoost * (mods.slideSpeedMul || 1);
          this.vel[0] += this.vel[0] / speed * boost;
          this.vel[2] += this.vel[2] / speed * boost;
        }
      }
      s.grounded = false;
      t.coyote = 0;
      t.jumpBuffer = 0;
      s.airJumps = 0;
      if (CFG.debug.showNav) { /* 占位 */ }
      Events.emit('player:jump', { kind: slideJump ? 'slide' : 'jump' });
      Events.emit('audio:play', { name: 'jump', gain: slideJump ? 0.92 : 0.82, rate: slideJump ? 1.08 : 1 });
      return;
    }

    // 3) 空中：先尝试蹬墙跑起手跳，再尝试二段跳
    if (this._tryStartWallRun(mods, input)) {
      t.jumpBuffer = 0;
      this.vel[1] += move.jumpVel * 0.55;
      return;
    }

    // 4) 二段跳
    const maxAir = 1 + (mods.airJumpsAdd || 0);
    if (s.airJumps < maxAir) {
      s.airJumps++;
      const dj = move.doubleJumpVel * (mods.doubleJumpMul || 1);
      this.vel[1] = dj;
      // 沿输入方向额外推力，让二段跳能改变轨迹
      this._wishDir(input, WISH, true);
      const h = hspeed(this.vel);
      const boost = move.doubleJumpForwardBoost * (mods.doubleJumpMul || 1);
      this.vel[0] += WISH[0] * boost;
      this.vel[2] += WISH[2] * boost;
      void h;
      t.jumpBuffer = 0;
      Events.emit('player:jump', { kind: 'double' });
      Events.emit('audio:play', { name: 'jump', gain: 0.86, rate: 1.18 });
    }
  }

  // ---------------------------------------------------------------- 冲刺

  _tryDash(input, mods) {
    const move = CFG.move;
    const s = this.state;
    const t = this.t;
    if (t.dashCooldown > 0) return false;
    if (s.grounded) {
      // 地面冲刺无次数限制（仅冷却）
    } else {
      if (s.dashCharges <= 0) return false;
      s.dashCharges--;
    }
    // 方向：输入方向优先，否则视线方向
    this._wishDir(input, WISH, true);
    const h = Math.hypot(WISH[0], WISH[2]);
    if (h < 0.01) {
      this._dashDir[0] = this.forward[0]; this._dashDir[1] = 0; this._dashDir[2] = this.forward[2];
      const l = Math.hypot(this._dashDir[0], this._dashDir[2]) || 1;
      this._dashDir[0] /= l; this._dashDir[2] /= l;
    } else {
      this._dashDir[0] = WISH[0] / h; this._dashDir[1] = 0; this._dashDir[2] = WISH[2] / h;
    }
    s.dashing = true;
    Events.emit('player:dash', { start: true });
    t.dashTime = move.dashTime;
    t.dashCooldown = move.dashCooldown * (mods.dashCooldownMul || 1);
    // 保留部分原速度 + 冲刺速度
    const keep = move.dashPreserveVel;
    this.vel[0] = this.vel[0] * keep + this._dashDir[0] * move.dashSpeed * (mods.maxSpeedMul || 1);
    this.vel[2] = this.vel[2] * keep + this._dashDir[2] * move.dashSpeed * (mods.maxSpeedMul || 1);
    this.vel[1] = Math.max(this.vel[1] * 0.15, 0) + move.dashUpward;
    this._endSlide();
    this._endWallRun();
    Events.emit('fx:shake', { amount: 0.18, time: 0.16 });
    Events.emit('audio:play', { name: 'dash' });
    return true;
  }

  _updateDash(dt, input, mods) {
    const move = CFG.move;
    const s = this.state;
    const t = this.t;
    t.dashTime -= dt;
    // 冲刺期间维持速度（近似无重力），并允许轻微转向
    this._wishDir(input, WISH, true);
    const steer = 2.2 * dt;
    const cur = T_A;
    const cs = hspeed(this.vel) || 1;
    cur[0] = this.vel[0] / cs; cur[2] = this.vel[2] / cs;
    const wl = Math.hypot(WISH[0], WISH[2]);
    if (wl > 0.01) {
      const ndx = cur[0] + (WISH[0] / wl - cur[0]) * steer;
      const ndz = cur[2] + (WISH[2] / wl - cur[2]) * steer;
      const nl = Math.hypot(ndx, ndz) || 1;
      const sp = hspeed(this.vel);
      this.vel[0] = ndx / nl * sp;
      this.vel[2] = ndz / nl * sp;
    }
    // 重力极小
    this.vel[1] -= move.gravity * 0.12 * dt;
    // 轻微减速，避免冲刺后仍保持超高速
    const f = Math.max(0, 1 - 1.6 * dt);
    this.vel[0] *= f; this.vel[2] *= f;
    this._gravityHandled = true;
    if (t.dashTime <= 0) {
      s.dashing = false;
      Events.emit('player:dash', { start: false });
      Events.emit('audio:play', { name: 'dash_end', gain: 0.62 });
    }
  }

  // ---------------------------------------------------------------- 抓钩

  _updateGrapple(dt, input, mods) {
    const move = CFG.move;
    const g = this.grapple;
    const t = this.t;
    const s = this.state;

    // 抓钩是一次按键触发，不要求一直按住 Q；再次按 Q 或蹲下可主动脱离。
    if (input.grapplePressed) {
      if (g.active) this._releaseGrapple();
      else if (t.grappleCooldown <= 0) this._fireGrapple(mods);
    }
    if (!g.active) { s.grappleActive = false; return; }
    s.grappleActive = true;

    // 目标失效？
    if (g.attachedEnemy && (!g.attachedEnemy.alive)) { this._releaseGrapple(); return; }
    if (input.crouchPressed) { this._releaseGrapple(); return; }

    const attachedEnemy = g.attachedEnemy;
    const anchor = attachedEnemy ? attachedEnemy.pos : g.point;
    const toAnchor = T_A;
    // pos 的 x/z 本来就是胶囊中心；旧代码错误地各加了半个身高，导致绳索
    // 实际朝目标侧后方拉。敌人目标取胸口，静态锚点则使用真实命中点。
    toAnchor[0] = anchor[0] - this.pos[0];
    toAnchor[1] = anchor[1] + (attachedEnemy ? attachedEnemy.height * 0.52 : 0)
      - (this.pos[1] + this.currentHeight * 0.56);
    toAnchor[2] = anchor[2] - this.pos[2];
    const dist = Math.hypot(toAnchor[0], toAnchor[1], toAnchor[2]);
    if (dist > move.grappleRange * 1.35 * (mods.grappleRangeMul || 1) || dist < 0.2) {
      this._releaseGrapple();
      return;
    }

    // 视角持续脱离锚点时自动断钩，避免玩家转身后绳索仍无限期拉扯。
    const eyeDx = anchor[0] - this.eyePos[0];
    const eyeDy = anchor[1] + (attachedEnemy ? attachedEnemy.height * 0.52 : 0.12) - this.eyePos[1];
    const eyeDz = anchor[2] - this.eyePos[2];
    const eyeLen = Math.hypot(eyeDx, eyeDy, eyeDz) || 1;
    const aimDot = (this.forward[0] * eyeDx + this.forward[1] * eyeDy + this.forward[2] * eyeDz) / eyeLen;
    const breakCos = Math.cos(M.toRad(CFG.move.grappleBreakAngleDeg));
    if (aimDot < breakCos) g.offAimTime += dt;
    else g.offAimTime = Math.max(0, g.offAimTime - dt * 2.5);
    if (g.offAimTime >= CFG.move.grappleBreakAimTime) {
      this._releaseGrapple();
      return;
    }

    const nx = toAnchor[0] / dist, ny = toAnchor[1] / dist, nz = toAnchor[2] / dist;
    const accel = move.grappleAccel * (mods.grapplePullMul || 1);
    const pull = move.grapplePull * (mods.grapplePullMul || 1);

    // 弹簧收绳：朝锚点的径向速度目标为正，同时保留切向摆荡动量。
    const radialVel = this.vel[0] * nx + this.vel[1] * ny + this.vel[2] * nz;
    // toAnchor 指向锚点，正径向速度就是朝锚点移动；旧值为负导致钩锁向外推，
    // 看起来像“按了 Q 但完全没用”。
    // 钩中活体时不是把敌人当成静态墙：按兵种质量把闭合速度分给双方。
    // 重装更难拉动，轻型/虫群则更多地被拽向玩家；静态锚点保持原手感。
    let playerShare = 1;
    if (attachedEnemy) {
      playerShare = attachedEnemy.typeId === 'heavy' ? 0.75
        : (attachedEnemy.typeId === 'swarm' || attachedEnemy.typeId === 'flyer' ? 0.40 : 0.55);
    }
    const targetRadial = pull * playerShare;
    const err = targetRadial - radialVel;
    const a = M.clamp(err * 2.2, -accel, accel);
    this.vel[0] += nx * a * dt;
    this.vel[1] += ny * a * dt;
    this.vel[2] += nz * a * dt;

    if (attachedEnemy) {
      // EnemySystem 会在本物理步的 AI 决策之后消费这份牵引请求，再走敌人自身
      // 的扫掠/胶囊碰撞。因此双方会相向靠近，但敌人不会穿墙或瞬移进玩家体内。
      const gp = attachedEnemy.grapplePull || (attachedEnemy.grapplePull = {});
      gp.pending = true;
      gp.source = this;
      gp.targetSpeed = pull * (1 - playerShare);
      gp.accel = accel * (1 - playerShare);
      gp.minDistance = Math.max(move.grappleMinDist, this.radius + attachedEnemy.radius + 0.5);
    }

    // 摆荡时的轻微速度保留增益（Apex 抓钩的"越荡越快"）
    const retain = move.grappleSwingRetain;
    if (retain !== 1) {
      const f = 1 + (retain - 1) * dt * 4;
      this.vel[0] *= f; this.vel[2] *= f;
    }

    // 抵消部分重力（形成摆荡而不是坠落）
    this.vel[1] += move.gravity * 0.62 * dt;

    // 到锚点附近或速度过快则脱离
    const speed = Math.hypot(this.vel[0], this.vel[1], this.vel[2]);
    const detachDistance = attachedEnemy
      ? Math.max(move.grappleMinDist, this.radius + attachedEnemy.radius + 0.5)
      : move.grappleMinDist;
    if (dist < detachDistance || speed > move.grappleDetachSpeed * (mods.grappleDetachSpeedMul || 1)) {
      this._releaseGrapple();
      return;
    }

    g.distance = dist;
  }

  _fireGrapple(mods) {
    const move = CFG.move;
    const g = this.grapple;
    const t = this.t;
    const range = move.grappleRange * (mods.grappleRangeMul || 1);

    // 从眼睛沿视线发射（带一点吸附辅助）
    const origin = T_A;
    origin[0] = this.pos[0] + this.forward[0] * 0.5;
    origin[1] = this.pos[1] + this.currentHeight * 0.85;
    origin[2] = this.pos[2] + this.forward[2] * 0.5;
    const dir = T_B;
    dir[0] = this.forward[0]; dir[1] = this.forward[1]; dir[2] = this.forward[2];

    // 先问敌人系统有没有目标（由外部注入的钩子）
    let best = null;
    if (this.opts.queryGrappleTarget) {
      const e = this.opts.queryGrappleTarget(origin, dir, range);
      if (e) best = { point: e.point, enemy: e.enemy, dist: e.dist };
    }
    if (!best) {
      const hit = this.world.raycast(origin, dir, range, { hitTriangles: true, hitBoxes: true });
      if (hit.hit) best = { point: [hit.point[0], hit.point[1], hit.point[2]], enemy: null, dist: hit.t };
    }
    if (!best) {
      t.grappleCooldown = 0.15;
      Events.emit('audio:play', { name: 'grapple_fire' });
      return;
    }

    g.active = true;
    g.point[0] = best.point[0]; g.point[1] = best.point[1]; g.point[2] = best.point[2];
    g.distance = best.dist;
    g.restLength = best.dist;
    g.offAimTime = 0;
    g.attachedEnemy = best.enemy || null;
    t.grappleCooldown = move.grappleCooldown;
    Events.emit('audio:play', { name: 'grapple_fire' });
    Events.emit('audio:play', { name: 'grapple_hit' });
    Events.emit('player:grapple', { start: true, point: g.point, enemy: g.attachedEnemy });
  }

  _releaseGrapple() {
    const g = this.grapple;
    if (!g.active) return;
    if (g.attachedEnemy && g.attachedEnemy.grapplePull
      && g.attachedEnemy.grapplePull.source === this) {
      g.attachedEnemy.grapplePull.pending = false;
      g.attachedEnemy.grapplePull.source = null;
    }
    g.active = false;
    g.attachedEnemy = null;
    g.offAimTime = 0;
    this.state.grappleActive = false;
    Events.emit('player:grapple', { start: false, point: g.point, enemy: null });
    Events.emit('audio:play', { name: 'grapple_release', gain: 0.78 });
  }

  grappleTarget() {
    return this.grapple.active ? this.grapple : null;
  }

  // ---------------------------------------------------------------- 攀爬翻越

  /** 探测前方是否有可攀爬的台阶/平台 */
  _tryMantle(mods, fromClimb) {
    const move = CFG.move;
    const s = this.state;
    const t = this.t;
    if (t.mantleCooldown > 0 || s.mantling) return false;

    const h = this.currentHeight;
    const origin = T_A;
    origin[0] = this.pos[0]; origin[1] = this.pos[1] + h * 0.9; origin[2] = this.pos[2];
    const dir = T_B;
    dir[0] = this.forward[0]; dir[1] = 0; dir[2] = this.forward[2];
    const dl = Math.hypot(dir[0], dir[2]);
    if (dl < 0.3) return false;
    dir[0] /= dl; dir[2] /= dl;

    // 前方有墙？
    const wallHit = this.world.raycast(origin, dir, this.radius + move.mantleReach, { hitTriangles: true, hitBoxes: true });
    if (!wallHit.hit) return false;
    if (wallHit.normal[1] > 0.5) return false;   // 是地面不是墙

    // 从墙上方往下探，找可站立的顶面
    const probeTop = T_C;
    probeTop[0] = this.pos[0] + dir[0] * (wallHit.t + this.radius + 0.35);
    probeTop[1] = this.pos[1] + h + move.mantleMaxHeight * (mods.stepHeightAdd || 1);
    probeTop[2] = this.pos[2] + dir[2] * (wallHit.t + this.radius + 0.35);
    const down = T_D;
    down[0] = 0; down[1] = -1; down[2] = 0;
    const maxDown = move.mantleMaxHeight * (mods.stepHeightAdd || 1) + 1.2;
    const floorHit = this.world.raycast(probeTop, down, maxDown, { hitTriangles: true, hitBoxes: true });
    if (!floorHit.hit) return false;
    if (floorHit.normal[1] < 0.62) return false;

    const ledgeY = floorHit.point[1];
    const rise = ledgeY - this.pos[1];
    if (rise < 0.6 || rise > move.mantleMaxHeight * (mods.stepHeightAdd || 1)) return false;
    // 顶面要有空间（不要爬进墙里）
    const headTest = T_E;
    headTest[0] = floorHit.point[0];
    headTest[1] = ledgeY + h * 0.3;
    headTest[2] = floorHit.point[2];
    const blocked = this.world.raycast(headTest, down, 0.1, { hitBoxes: true, hitTriangles: true });
    void blocked;

    // 计算落点：越过边缘一点，避免卡在边上
    const end = this._mantle.end;
    end[0] = this.pos[0] + dir[0] * (wallHit.t + this.radius + 0.55);
    end[1] = ledgeY + 0.03;
    end[2] = this.pos[2] + dir[2] * (wallHit.t + this.radius + 0.55);
    this._mantle.start[0] = this.pos[0];
    this._mantle.start[1] = this.pos[1];
    this._mantle.start[2] = this.pos[2];
    this._mantle.t = 0;
    this._mantle.dur = Math.max(0.12, move.mantleTime * (fromClimb ? 0.7 : 1) * (mods.mantleSpeedMul || 1));
    this._setWallClimbing(false);
    this._endWallRun();
    s.mantling = true;
    s.grounded = false;
    this.vel[0] = 0; this.vel[1] = 0; this.vel[2] = 0;
    Events.emit('player:jump', { kind: 'mantle' });
    Events.emit('player:mantle', { start: true, fromClimb: !!fromClimb });
    Events.emit('audio:play', { name: 'mantle' });
    return true;
  }

  _updateMantle(dt) {
    const m = this._mantle;
    m.t += dt;
    const raw = M.clamp01(m.t / m.dur);
    // 先上升后前移的曲线，比线性自然
    const up = M.smoothstep(0, 0.68, raw);
    const fwd = M.smoothstep(0.22, 1, raw);
    this.pos[0] = M.lerp(m.start[0], m.end[0], fwd);
    this.pos[1] = M.lerp(m.start[1], m.end[1], up);
    this.pos[2] = M.lerp(m.start[2], m.end[2], fwd);
    if (raw >= 1) {
      this.state.mantling = false;
      this.t.mantleCooldown = CFG.move.mantleCooldown;
      this.vel[0] = 0; this.vel[1] = 0; this.vel[2] = 0;
      // 落点校正：贴到地面上
      this.world.snapToGround(this.pos, 0.02);
      Events.emit('player:mantle', { start: false });
      Events.emit('audio:play', { name: 'mantle_complete', gain: 0.76 });
    }
  }

  // ---------------------------------------------------------------- 积分与碰撞

  _wishDir(input, out, flatten) {
    const mx = input.moveX || 0;
    const my = input.moveY || 0;
    out[0] = this.forward[0] * my + this.right[0] * mx;
    out[1] = flatten ? 0 : this.forward[1] * my;
    out[2] = this.forward[2] * my + this.right[2] * mx;
    const l = Math.hypot(out[0], out[1], out[2]);
    if (l > 1e-5) { out[0] /= l; out[1] /= l; out[2] /= l; }
    else { out[0] = 0; out[1] = 0; out[2] = 0; }
    return out;
  }

  /**
   * 位置积分 + 碰撞求解。
   * 关键点：
   *  - 用球体扫掠检测高速运动（防穿透），然后回退到接触点。
   *  - 撞击后沿表面裁剪速度，保证贴墙滑行顺滑。
   *  - 台阶自动上抬。
   */
  _integrate(dt, noCollide) {
    if (noCollide || CFG.debug.noclip) {
      this.pos[0] += this.vel[0] * dt;
      this.pos[1] += this.vel[1] * dt;
      this.pos[2] += this.vel[2] * dt;
      this.state.grounded = false;
      return;
    }
    const s = this.state;
    const delta = T_E;
    delta[0] = this.vel[0] * dt;
    delta[1] = this.vel[1] * dt;
    delta[2] = this.vel[2] * dt;
    const dist = Math.hypot(delta[0], delta[1], delta[2]);

    const wasGrounded = s.grounded;
    const prevY = this.pos[1];

    if (dist > 1e-5) {
      // 滑铲允许在首次命中可行走坡面/坡折后继续消费剩余切向位移。
      // 普通移动维持一次 sweep，避免改变既有手感与碰撞成本。
      const sweeps = s.sliding ? 2 : 1;
      for (let sweepIndex = 0; sweepIndex < sweeps; sweepIndex++) {
        const segmentDist = Math.hypot(delta[0], delta[1], delta[2]);
        if (segmentDist <= 1e-5) break;
        // 用"身体中部"作为扫掠球心，能覆盖大部分碰撞情形
        const center = T_B;
        center[0] = this.pos[0];
        center[1] = this.pos[1] + this.currentHeight * 0.5;
        center[2] = this.pos[2];
        // 扫掠只需覆盖真实胶囊半径；旧版把身体高度的 42% 当作球半径
        // （约 0.76m），导致离墙很远就被判接触，反复推出后出现“粘墙”。
        const sweepR = this.radius * 1.05;
        const hit = this.world.sweepSphere(center, sweepR, delta, {});
        if (hit.hit) {
        // 退到接触点（留一点余量）
        const back = Math.max(0, Math.min(segmentDist, hit.t - 0.012));
        this.pos[0] += delta[0] / segmentDist * back;
        this.pos[1] += delta[1] / segmentDist * back;
        this.pos[2] += delta[2] / segmentDist * back;
        // 仅在速度朝向表面时裁剪；若玩家正主动离墙，不能把离墙速度
        // 也投影掉，否则会在贴墙后无法脱离。
        const into = this.vel[0] * hit.normal[0]
          + this.vel[1] * hit.normal[1] + this.vel[2] * hit.normal[2];
        if (into < 0) {
          const clipped = T_C;
          clipVelocity(this.vel, hit.normal, clipped, 0);
          this.vel[0] = clipped[0]; this.vel[1] = clipped[1]; this.vel[2] = clipped[2];
        }
        if (sweepIndex + 1 < sweeps) {
          // 余量投影到碰撞切面后继续扫掠。使用本段长度而不是首段 dist，
          // 因此连续坡折不会重复走过已经消费的距离。
          const usedFrac = M.clamp(back / segmentDist, 0, 1);
          delta[0] *= 1 - usedFrac;
          delta[1] *= 1 - usedFrac;
          delta[2] *= 1 - usedFrac;
          const intoDelta = delta[0] * hit.normal[0]
            + delta[1] * hit.normal[1] + delta[2] * hit.normal[2];
          if (intoDelta < 0) {
            delta[0] -= hit.normal[0] * intoDelta;
            delta[1] -= hit.normal[1] * intoDelta;
            delta[2] -= hit.normal[2] * intoDelta;
          }
          continue;
        }
        } else {
          this.pos[0] += delta[0];
          this.pos[1] += delta[1];
          this.pos[2] += delta[2];
        }
        break;
      }
    }

    // 精确推出求解（处理静止接触、角落、斜坡）
    const res = this.world.resolveCapsule(this.pos, this.radius, this.currentHeight, 4);
    // resolveCapsule 的接触迭代在夹角里可能选择朝下法线；最终位置必须再次满足
    // “胶囊底不低于可见地形”的硬约束。
    this.world.enforceCapsuleValidity(this.pos, this.radius, this.currentHeight);
    this._lastContacts = res.contacts;

    // 地面判定：既有"探测"也有"接触法线"
    let grounded = false;
    let groundNormal = GROUND_N;
    if (res.grounded) {
      grounded = true;
      groundNormal[0] = res.groundNormal[0];
      groundNormal[1] = res.groundNormal[1];
      groundNormal[2] = res.groundNormal[2];
      s.groundKind = 'contact';
    } else {
      const probeDist = s.sliding
        ? Math.max(CFG.move.groundSnapDist, CFG.move.slideGroundSnapDist || 0) + 0.06
        : CFG.move.groundSnapDist + 0.06;
      const probe = this.world.probeGround(this.pos, this.radius, this.currentHeight, probeDist);
      if (probe.grounded && this.vel[1] <= 0.6) {
        grounded = true;
        groundNormal[0] = probe.groundNormal[0];
        groundNormal[1] = probe.groundNormal[1];
        groundNormal[2] = probe.groundNormal[2];
        s.groundKind = 'probe';
        // 滑铲高速经过下坡坡折时主动向下贴面；普通移动继续沿用原来的探测判定。
        // probe 的起点比胶囊底高 0.02m，故只扣除这部分以保留接触余量。
        if (s.sliding) {
          const snap = Math.max(0, Math.min(
            CFG.move.slideGroundSnapDist || CFG.move.groundSnapDist, probe.distance - 0.02));
          this.pos[1] -= snap;
        }
      } else {
        s.groundKind = 'none';
      }
    }

    // 台阶自动上抬：水平移动被挡住但上方有空间时抬腿
    if (!grounded && wasGrounded) {
      // 尝试向上 0.45m 后再水平推进
      const stepH = CFG.move.stepHeight + (this.mods.move.stepHeightAdd || 0);
      const saveX = this.pos[0], saveY = this.pos[1], saveZ = this.pos[2];
      const upTest = T_D;
      upTest[0] = 0; upTest[1] = stepH + 0.05; upTest[2] = 0;
      this.pos[1] += stepH + 0.05;
      const after = this.world.resolveCapsule(this.pos, this.radius, this.currentHeight, 2);
      if (after.contacts > 0) {
        // 抬起来也卡住，回退
        this.pos[0] = saveX; this.pos[1] = saveY; this.pos[2] = saveZ;
      } else {
        // 抬起来没卡：看下方是否有地面
        const probe2 = this.world.probeGround(this.pos, this.radius, this.currentHeight, stepH + 0.2);
        if (probe2.grounded) {
          this.pos[1] -= Math.min(stepH + 0.05, probe2.distance + 0.02);
          grounded = true;
          s.groundKind = 'step';
          groundNormal[0] = probe2.groundNormal[0];
          groundNormal[1] = probe2.groundNormal[1];
          groundNormal[2] = probe2.groundNormal[2];
        } else {
          this.pos[0] = saveX; this.pos[1] = saveY; this.pos[2] = saveZ;
        }
      }
    }

    s.grounded = grounded;
    if (grounded) {
      s.groundNormal[0] = groundNormal[0];
      s.groundNormal[1] = groundNormal[1];
      s.groundNormal[2] = groundNormal[2];
      s.airJumps = 0;
      s.dashCharges = this._dashMax();
    }

    // 着陆处理
    if (grounded && !wasGrounded) {
      const impact = Math.abs(this.vel[1]);
      // 把垂直速度吸收掉，但保留水平动量（连跳的关键）
      if (this.vel[1] < 0) {
        this.vel[1] = 0;
      }
      // 连跳增益
      const bh = CFG.move.bunnyHopBoost;
      if (bh !== 1 && hspeed(this.vel) > 5) {
        this.vel[0] *= bh; this.vel[2] *= bh;
      }
      this._onLand(impact);
    }

    // 陡坡滑落
    if (grounded && groundNormal[1] < 0.5) {
      // 沿坡面下滑
      const n = groundNormal;
      const g = CFG.move.gravity;
      this.vel[0] += n[0] * n[1] * g * dt * 1.4;
      this.vel[2] += n[2] * n[1] * g * dt * 1.4;
      if (this.vel[1] > -1) this.vel[1] = -1;
    }

    // 长时间未落地 -> 记住最高点用于坠落伤害
    if (!grounded) {
      if (this.vel[1] > 0) this._fallStartY = Math.max(this._fallStartY, this.pos[1]);
      this.t.timeSinceGround = 0;
    }
    void prevY;
  }

  _onLand(impact) {
    const move = CFG.move;
    const s = this.state;
    s.lastLandImpact = impact;
    this.t.coyote = 0;
    const hard = impact > move.hardLandSpeed;
    Events.emit('player:land', { speed: impact, hard });
    Events.emit('audio:play', { name: hard ? 'land_hard' : 'land_soft', gain: M.clamp01(impact / 18) });
    // 相机下沉
    this._landDip = Math.min(CFG.cam.landDipMax, impact * 0.006);
    if (hard) Events.emit('fx:shake', { amount: M.clamp01((impact - move.hardLandSpeed) / 22) * 0.5, time: 0.2 });
    // 坠落伤害（impact_gel / 落地缓冲可减免甚至免疫）
    if (impact > move.fallDamageSpeed) {
      let resist = this.mods.move.landImpactResist || 0;
      resist = M.clamp01(resist);
      const dmg = (impact - move.fallDamageSpeed) * move.fallDamageScale
        * (this.mods.move.fallDamageMul || 1) * (1 - resist);
      if (dmg > 1) this.applyDamage(dmg, [0, -1, 0], null);
    }
    this._fallStartY = this.pos[1];
    this._endSlide();
    this._endWallRun();
    this._setWallClimbing(false);
  }

  /** 每步收尾：Coyote、滚转平滑、状态汇总 */
  _postStep(dt, input) {
    const s = this.state;
    const move = CFG.move;
    // Coyote time
    if (s.grounded) this.t.coyote = move.coyoteTime;
    if (this.t.lastWallNormalAge >= 0) this.t.lastWallNormalAge += dt;

    // 尝试起手蹬墙跑（在空中且贴着墙）
    if (!s.grounded && !s.wallRunning && !s.dashing && !s.mantling && !s.wallClimbing) {
      if (hspeed(this.vel) >= move.wallRunMinSpeed && this.vel[1] < 6.5) {
        this._tryStartWallRun(this.mods.move || {}, input);
      }
    }

    // 尝试自动翻越（贴墙 + 前方有沿）
    if (!s.grounded && !s.mantling && !s.wallRunning && !s.dashing) {
      const fwdSpeed = this.vel[0] * this.forward[0] + this.vel[2] * this.forward[2];
      if (fwdSpeed > 1.0 && this.pos[1] > -100) {
        // 仅在明显朝墙推进时尝试，避免误触发
        if (hspeed(this.vel) > 2.5) this._tryMantle(this.mods.move || {}, false);
      }
    }

    // 滚转回到基准
    const targetRoll = 0;
    if (!s.wallRunning) this.roll = M.damp(this.roll, targetRoll, 7, dt);

    // 状态汇总
    s.speed = Math.hypot(this.vel[0], this.vel[1], this.vel[2]);
    s.hspeed = hspeed(this.vel);
    s.vspeed = this.vel[1];
    s.grappleActive = this.grapple.active;
    if (s.mantling) s.moveState = 'MANTLE';
    else if (s.dashing) s.moveState = 'DASH';
    else if (this.grapple.active) s.moveState = 'GRAPPLE';
    else if (s.wallRunning) s.moveState = 'WALLRUN';
    else if (s.sliding) s.moveState = 'SLIDE';
    else if (s.grounded) s.moveState = 'GROUNDED';
    else s.moveState = 'AIR';

    // 护盾再生
    this._regenShield(dt);

    // 地图边界兜底：大部分原型没有外围墙，跑出地形网格就没有任何几何可碰撞，
    // 会直接掉进虚空且回不来。这里硬性夹回范围内，并把朝外的速度分量清零，
    // 否则玩家会一直贴着边界"顶着墙跑"。详见 world.clampToBounds 的注释。
    this._enforceBounds();
  }

  /** 把玩家夹回地图范围内；返回是否发生了夹取（供调试统计） */
  _enforceBounds() {
    const w = this.world;
    if (!w || typeof w.clampToBounds !== 'function') return false;
    // 收缩量 = 胶囊半径 + 余量，保证夹住之后身体完整在界内
    const pushed = w.clampToBounds(this.pos, (this.radius || 0.35) + 0.6);
    if (!pushed) return false;
    if (pushed & 1) this.vel[0] = 0;
    if (pushed & 2) this.vel[2] = 0;
    return true;
  }

  _regenShield(dt) {
    const G = CFG.gameplay;
    if (this._shieldRegenDelay > 0) { this._shieldRegenDelay -= dt; return; }
    if (this.shield < this.maxShield) {
      // Apex 风格：脱战延迟结束后按最大护盾百分比恢复，避免升级最大护盾后
      // 仍固定每秒 28 点导致恢复速度失衡。旧配置没有百分比字段时回退旧值。
      const baseRate = Number.isFinite(G.shieldRegenPercent)
        ? this.maxShield * G.shieldRegenPercent : G.shieldRegenRate;
      const rate = baseRate * (this.mods.move.shieldRegenMul || 1);
      this.shield = Math.min(this.maxShield, this.shield + rate * dt);
      if (this.shield >= this.maxShield) this.shieldBroken = false;
    }
  }

  // ================================================================ 伤害

  applyDamage(amount, dir, source) {
    if (!this.alive || amount <= 0) return 0;
    if (this.invulnTime > 0 && source !== null) return 0;
    if (CFG.debug.godMode) return 0;
    const G = CFG.gameplay;
    let remaining = amount;
    const mk = this.mods.move;

    // 低血量减伤（last_stand：低血时获得额外抗性）
    if (mk.lowHpDamageResistAdd > 0 && this.health / this.maxHealth < 0.35) {
      remaining *= (1 - M.clamp01(mk.lowHpDamageResistAdd));
    }

    // 护盾先扣
    if (this.shield > 0) {
      const absorbed = Math.min(this.shield, remaining);
      this.shield -= absorbed;
      remaining -= absorbed;
      if (this.shield <= 0 && !this.shieldBroken) {
        this.shieldBroken = true;
        Events.emit('audio:play', { name: 'shield_break' });
        Events.emit('fx:shake', { amount: 0.35, time: 0.3 });
      }
    }
    if (remaining > 0) this.health -= remaining;
    this._shieldRegenDelay = (G.shieldRegenDelay + G.shieldRegenDelayDamage) * (mk.shieldRegenDelayMul || 1);

    const dirv = dir ? new Float32Array([dir[0], dir[1], dir[2]]) : new Float32Array([0, 0, 0]);
    Events.emit('player:hurt', { amount, dir: dirv, hpAfter: Math.max(0, this.health) });
    Events.emit('fx:shake', { amount: M.clamp01(amount / 45) * 0.7, time: 0.25 });
    Events.emit('audio:play', { name: 'player_hurt' });

    if (this.health <= 0) {
      this.health = 0;
      // 不死鸟核心：致死免疫，按充能次数生效，用完后进入长冷却
      const charges = this._cheatDeathLeft || 0;
      const cdReady = (this._cheatDeathCooldown || 0) <= 0;
      if (charges > 0 && cdReady) {
        this._cheatDeathLeft = charges - 1;
        this._cheatDeathCooldown = 90 * (mk.cheatDeathCooldownMul || 1);
        this.health = this.maxHealth * 0.35;
        this.shield = this.maxShield * 0.5;
        this.invulnTime = 1.4;
        Events.emit('ui:message', { title: '应急协议启动', sub: '外骨骼强行重启', kind: 'warn' });
        Events.emit('audio:play', { name: 'objective_complete' });
        return amount;
      }
      this.alive = false;
      Events.emit('player:die', { source, pvp: source?.kind === 'player' });
      Events.emit('audio:play', { name: 'player_die' });
    }
    return amount;
  }

  heal(amount) {
    if (amount <= 0) return;
    const before = this.health;
    this.health = Math.min(this.maxHealth, this.health + amount);
    if (this.health > before) Events.emit('player:heal', { amount: this.health - before });
  }

  addShield(amount) {
    this.shield = Math.min(this.maxShield, this.shield + amount);
  }

  /** 装甲板：每块增加一个 25 点护盾格，本局最多额外增加两格（Apex 红甲共 125）。 */
  increaseShieldCapacity(amount = 25) {
    const room = Math.max(0, 50 - (this.armorShieldBonus || 0));
    const added = Math.min(room, Math.max(0, Math.round(amount / 25) * 25));
    if (added <= 0) return 0;
    this.armorShieldBonus = (this.armorShieldBonus || 0) + added;
    this.maxShield += added;
    this.shield = Math.min(this.maxShield, this.shield + added);
    return added;
  }

  resetArmorShieldBonus() {
    this.armorShieldBonus = 0;
    this.setModifiers(this.mods);
  }

  addImpulse(v) {
    this.vel[0] += v[0]; this.vel[1] += v[1]; this.vel[2] += v[2];
  }

  /** 重置空中能力（击杀奖励等） */
  refreshAirAbilities() {
    this.state.dashCharges = this._dashMax();
    this.state.airJumps = 0;
  }

  // ================================================================ 相机

  updateCamera(dt) {
    const cam = CFG.cam;
    const s = this.state;
    const move = CFG.move;

    // 眼高：滑铲最低、蹲伏次之
    let targetEye = cam.eyeHeight;
    if (s.sliding) targetEye = cam.slideEyeHeight;
    else if (s.crouching) targetEye = cam.crouchEyeHeight;
    if (!s.grounded) targetEye = cam.eyeHeight;

    this.eyeHeightOffset = dt > 0
      ? M.damp(this.eyeHeightOffset, targetEye, cam.eyeLerpRate, dt)
      : targetEye;

    // 速度 bob
    const speed = s.speed;
    const speedRef = cam.bobSpeedRef;
    if (s.grounded && speed > 0.6) {
      this.bobPhase += dt * cam.bobFreq * M.clamp(speed / speedRef, 0.4, 2.2);
      this.bobAmount = M.damp(this.bobAmount, cam.bobAmp * M.clamp01(speed / speedRef), 6, dt);
    } else {
      this.bobAmount = M.damp(this.bobAmount, 0, 6, dt);
    }
    const bobY = Math.sin(this.bobPhase * 2) * this.bobAmount;
    const bobX = Math.cos(this.bobPhase) * this.bobAmount * 0.6;

    // 落地下沉（弹簧）
    if (this._landDip > 0 && dt > 0) {
      this._landDip = M.damp(this._landDip, 0, 9, dt);
      if (this._landDip < 0.001) this._landDip = 0;
    }

    const eyeY = this.pos[1] + this.eyeHeightOffset + bobY - this._landDip;

    // 眼位（含 bob 横向与震动偏移）
    this.eyePos[0] = this.pos[0] + this.right[0] * bobX + this.shakeOffset[0];
    this.eyePos[1] = eyeY + this.shakeOffset[1];
    this.eyePos[2] = this.pos[2] + this.right[2] * bobX + this.shakeOffset[2];

    // 相机滚转：蹬墙跑/滑铲/侧移混合
    let rollTarget = this.roll;
    if (s.sliding) rollTarget += cam.slideRoll * M.sign(
      this.vel[0] * this.right[0] + this.vel[2] * this.right[2]) * -1;
    if (s.grounded && !s.sliding) {
      const strafe = this.vel[0] * this.right[0] + this.vel[2] * this.right[2];
      rollTarget += M.clamp(-strafe * 0.006, -cam.rollMax, cam.rollMax);
    }
    rollTarget += this.shakeRotation[2];
    this._rollVis = dt > 0 ? M.damp(this._rollVis, rollTarget, cam.rollRate, dt) : rollTarget;
    this.roll = dt > 0 ? M.damp(this.roll, s.wallRunning ? this.roll : 0, cam.rollRate, dt) : this.roll;

    // 重新计算基向量（含 roll）
    const savedRoll = this.roll;
    this.roll = this._rollVis;
    this.updateBasis();
    this.roll = savedRoll;

    // FOV：速度感 + 冲刺 + 开镜
    const fovCfg = CFG.render;
    const speedFov = M.clamp(speed / Math.max(1, fovCfg.fovSpeedRef), 0, 1.4) * fovCfg.fovSpeedBoost;
    const sprintFov = s.sprintFraction * fovCfg.fovSprintBoost;
    this.fovExtra = dt > 0
      ? M.damp(this.fovExtra, speedFov + sprintFov + this.shakeFov, 7, dt)
      : speedFov + sprintFov + this.shakeFov;

    void move;
  }

  /** 当前实际 FOV（与武器开镜相乘） */
  getFov(baseFov) {
    const b = baseFov == null ? CFG.render.fovDeg : baseFov;
    return (b + this.fovExtra) * this.adsFovMul;
  }

  setAdsFovMul(mul) {
    this.adsFovMul = mul == null ? 1 : mul;
  }

  /**
   * 设置动作移动倍率（ADS=0.5）。必须缩放运动系统的 wishSpeed，不能缩放
   * 输入轴；后者会被 _wishDir() 归一化掉，看似接线实际没有任何减速效果。
   */
  setActionMoveSpeedMul(mul) {
    const v = Number.isFinite(mul) ? mul : 1;
    this.actionMoveSpeedMul = M.clamp(v, 0.1, 1);
  }

  // ================================================================ 调试

  debugState() {
    const s = this.state;
    return {
      pos: [round(this.pos[0]), round(this.pos[1]), round(this.pos[2])],
      vel: [round(this.vel[0]), round(this.vel[1]), round(this.vel[2])],
      speed: round(s.speed),
      hspeed: round(s.hspeed),
      moveState: s.moveState,
      grounded: s.grounded,
      groundKind: s.groundKind,
      sliding: s.sliding,
      wallRunning: s.wallRunning,
      wallSide: s.wallSide,
      wallClimbing: s.wallClimbing,
      mantling: s.mantling,
      dashing: s.dashing,
      grapple: this.grapple.active,
      airJumps: s.airJumps,
      dashCharges: s.dashCharges,
      health: round(this.health),
      shield: round(this.shield),
      alive: this.alive,
      eyeHeight: round(this.eyeHeightOffset),
      fov: round(this.fovExtra),
      actionMoveSpeedMul: round(this.actionMoveSpeedMul),
      yaw: round(this.yaw),
      pitch: round(this.pitch),
      contacts: this._lastContacts,
    };
  }
}

function round(v) { return Math.round(v * 100) / 100; }

/** 默认修饰符（全部中性值），保证 player 在没有升级系统时也能跑。
 *
 * 键名以 upgrades.js 的 MODIFIER_DEFAULTS 为唯一事实来源（65 个键），
 * 这里只补上运动系统内部需要、而升级池没有暴露的"手感微调键"。
 * 这样升级系统算出来的 modifiers 可以被 player 直接、无转换地消费。
 */
export function defaultMods() {
  const base = MODIFIER_DEFAULTS;
  return {
    move: {
      // ---- 来自升级系统的键（照抄默认值，避免拼写漂移）
      walkSpeedMul: base.move.walkSpeedMul,
      sprintSpeedMul: base.move.sprintSpeedMul,
      sprintWindupMul: base.move.sprintWindupMul,
      maxSpeedMul: base.move.maxSpeedMul,
      slideSpeedMul: base.move.slideSpeedMul,
      slideFrictionMul: base.move.slideFrictionMul,
      slideDownhillMul: base.move.slideDownhillMul,
      wallRunTimeMul: base.move.wallRunTimeMul,
      wallRunStickMul: base.move.wallRunStickMul,
      wallJumpMul: base.move.wallJumpMul,
      wallClimbSpeedMul: base.move.wallClimbSpeedMul,
      grappleRangeMul: base.move.grappleRangeMul,
      grapplePullMul: base.move.grapplePullMul,
      dashCooldownMul: base.move.dashCooldownMul,
      doubleJumpMul: base.move.doubleJumpMul,
      airControlMul: base.move.airControlMul,
      airAccelMul: base.move.airAccelMul,
      gravityMul: base.move.gravityMul,
      jumpVelMul: base.move.jumpVelMul,
      mantleSpeedMul: base.move.mantleSpeedMul,
      bunnyHopMul: base.move.bunnyHopMul,
      shieldRegenRateMul: base.move.shieldRegenRateMul,
      shieldRegenDelayMul: base.move.shieldRegenDelayMul,
      cheatDeathCooldownMul: base.move.cheatDeathCooldownMul,
      dashChargesAdd: base.move.dashChargesAdd,
      stepHeightAdd: base.move.stepHeightAdd,
      landImpactResistAdd: base.move.landImpactResistAdd,
      maxHealthAdd: base.move.maxHealthAdd,
      maxShieldAdd: base.move.maxShieldAdd,
      lifestealOnKillAdd: base.move.lifestealOnKillAdd,
      healOnHeadshotKillAdd: base.move.healOnHeadshotKillAdd,
      lowHpDamageResistAdd: base.move.lowHpDamageResistAdd,
      healthOnSlideKillAdd: base.move.healthOnSlideKillAdd,
      cheatDeathAdd: base.move.cheatDeathAdd,
      dashResetOnKillAdd: base.move.dashResetOnKillAdd,
      thornsAdd: base.move.thornsAdd,

      // ---- 运动系统内部微调键（升级池未暴露，保留以便后续扩展与调试）
      crouchSpeedMul: 1,
      groundAccelMul: 1,
      airSpeedMul: 1,
      airProjCapMul: 1,
      airTurnAssistMul: 1,
      airJumpsAdd: 0,
      frictionMul: 1,
      gravityAirMul: CFG.move.gravityAirMul,
      dashSpeedMul: 1,
      slideBoostMul: 1,
      slideExitSpeedMul: 1,
      slideSteerMul: 1,
      slideMinSpeedMul: 1,
      slopeAccelMul: 1,
      wallRunSpeedMul: 1,
      wallRunMaxSpeedMul: 1,
      wallRunGravityMul: 1,
      wallRunMinSpeedMul: 1,
      wallRunBoostMul: 1,
      grappleAccelMul: 1,
      grappleDetachSpeedMul: 1,
      mantleHeightMul: 1,
      fallDamageMul: 1,
      /** 落地伤害减免：0 = 全额，>=1 = 完全免疫（来自 landImpactResistAdd） */
      landImpactResist: 0,
      /** 致死免疫剩余次数（来自 cheatDeathAdd），与 cheatDeath 布尔键互为兜底 */
      cheatDeathCharges: 0,
    },
    weapon: { ...base.weapon },
    meta: { ...base.meta },
  };
}

/** 把外来的 modifiers 归一化为 player 期望的形状（补默认值 + 旧键名别名） */
export function normalizeMods(mods) {
  const out = defaultMods();
  if (!mods) return out;
  const src = mods.move || {};
  const dst = out.move;
  // 只接受有限数值：任何 NaN/undefined 都会一路污染到物理与 HUD，必须在此拦截
  for (const k of Object.keys(dst)) {
    if (typeof src[k] === 'number' && Number.isFinite(src[k])) dst[k] = src[k];
  }
  // 语义换算：landImpactResistAdd 是"减免比例"，落到伤害计算用的倍率上
  if (Number.isFinite(src.landImpactResistAdd)) {
    dst.landImpactResist = M.clamp01(src.landImpactResistAdd);
  }
  if (Number.isFinite(src.cheatDeathAdd)) {
    dst.cheatDeathCharges = Math.max(0, Math.round(src.cheatDeathAdd));
  }
  // 旧键名别名（兼容早期版本的 modifiers 结构）
  if (Number.isFinite(src.slideDownhillBoostMul)) dst.slideDownhillMul = src.slideDownhillBoostMul;
  if (typeof src.dashResetOnKill === 'boolean') dst.dashResetOnKillAdd = src.dashResetOnKill ? 1 : 0;
  if (typeof src.cheatDeath === 'boolean') {
    dst.cheatDeathCharges = Math.max(dst.cheatDeathCharges, src.cheatDeath ? 1 : 0);
  }
  if (Number.isFinite(src.damageResist)) dst.lowHpDamageResistAdd = src.damageResist;
  if (Number.isFinite(src.lowHpResist)) dst.lowHpDamageResistAdd = src.lowHpResist;
  out.weapon = sanitizeGroup(out.weapon, mods.weapon);
  out.meta = sanitizeGroup(out.meta, mods.meta);
  return out;
}

/** 用外来对象覆盖一组键，但只接受有限数值（NaN/undefined 一律保持默认） */
function sanitizeGroup(base, incoming) {
  if (!incoming) return base;
  const out = { ...base };
  for (const k of Object.keys(out)) {
    const v = incoming[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export default Player;
