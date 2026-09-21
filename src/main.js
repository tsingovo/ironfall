// ==== main.js — 启动、主循环、系统编排、自动化测试钩子 ====
// 循环结构：
//   * 物理固定步 1/128 秒，累加器驱动，单帧最多 6 步（防死亡螺旋）
//   * 渲染帧率不设上限（rAF），相机在帧内对位置做插值 => 高帧率下画面依旧顺滑
//   * 每帧顺序：输入 → 物理 N 步 → 相机/后坐力 → 特效 → 世界/敌人/武器渲染 → HUD

import { CFG } from './core/config.js';
import * as M from './core/math.js';
import * as Events from './core/events.js';
import { Input } from './core/input.js';
import { installDiagnostics } from './core/diagnostics.js';
import { Engine } from './engine/engine.js';
import { createSharedMeshes } from './engine/fx-meshes.js';
import { World } from './world.js';
import { Player } from './player.js';
import { WeaponSystem, WEAPONS } from './weapons.js';
import { EnemySystem, ENEMY_TYPES, ENEMY_IDS } from './enemies.js';
import { Director } from './director.js';
import { Run, RUN_PHASE } from './run.js';
import { UpgradeSystem, RARITIES } from './upgrades.js';
import { Audio } from './audio/audio.js';
import { ParticleSystem } from './fx/particles.js';
import { DecalSystem } from './fx/decals.js';
import { ScreenShake } from './fx/screenshake.js';
import { EnemyMarkerSystem } from './fx/enemy-markers.js';
import { generateMap, MISSIONS, getMission, getBiome, BIOMES } from './maps/builtin-maps.js';
import { loadGLTF, gltfInstanceModels } from './fx/gltf.js';
import { HUD } from './ui/hud.js';
import { Save, MetaProgress, PERKS, CAMPAIGN_TIER_COUNT } from './save.js';
import { InventorySystem, LOOT_DEFS } from './inventory.js';
import { PlayerModelRenderer } from './player-model.js';
import { LanSession, LAN_PHASE } from './net/session.js';

const PHYS_DT = 1 / 128;
const MAX_STEPS_PER_FRAME = 6;

// 治疗轮盘固定顺序。索引同时供 HUD、背包和第一人称道具动作使用，不能再用
// “0 是药、其余全是电池”这种二选一判断，否则新增小药后会静默串错效果。
const HEALING_DEFS = Object.freeze([
  { id: 'medkit', key: 'medkits', name: '医疗包', target: 'health', amount: Infinity, duration: 3.0,
    startSound: 'medkit_use', loopSound: 'medkit_loop', completeSound: 'medkit_complete' },
  { id: 'shield_battery', key: 'shieldBatteries', name: '护盾电池', target: 'shield', amount: Infinity, duration: 2.5,
    startSound: 'shield_battery_use', loopSound: 'shield_battery_loop', completeSound: 'shield_battery_complete' },
  { id: 'syringe', key: 'syringes', name: '注射器', target: 'health', amount: 25, duration: 1.0,
    startSound: 'syringe_use', loopSound: 'syringe_loop', completeSound: 'syringe_complete' },
  { id: 'shield_cell', key: 'shieldCells', name: '小型护盾电池', target: 'shield', amount: 25, duration: 1.0,
    startSound: 'shield_cell_use', loopSound: 'shield_cell_loop', completeSound: 'shield_cell_complete' },
]);

/** 全局错误收集（自动化测试与调试面板都依赖它） */
export const errors = [];          // 注意：Game/boot 在文件末尾的 export 列表里统一导出。
                                   // 不要在这里写 `export class Game` —— Node 24.15(V8) 会把
                                   // "export class X {}" + "export { X }" 误判为重复导出（浏览器正常，
                                   // 但会让无头自测与静态检查无法导入本模块）。
function recordError(message, stack) {
  errors.push({ message: String(message), stack: stack ? String(stack).slice(0, 600) : '', time: Date.now() });
  if (errors.length > 40) errors.shift();
}

class Game {
  constructor(canvas, hudRoot) {
    this.canvas = canvas;
    this.hudRoot = hudRoot;
    this.engine = null;
    this.world = null;
    this.player = null;
    this.weapons = null;
    this.enemies = null;
    this.director = null;
    this.run = null;
    this.upgrades = null;
    this.particles = null;
    this.decals = null;
    this.shake = null;
    this.hud = null;
    this.inventory = null;
    this.playerModel = null;

    // Apex 风格治疗资源：轻按 5 使用当前选中道具，长按 5 打开轮盘并
    // 通过鼠标方向/数字键选择。每局重新补充，资源状态交给 HUD 只读展示。
    this.healing = {
      medkits: Infinity,
      shieldBatteries: Infinity,
      syringes: Infinity,
      shieldCells: Infinity,
      wheelOpen: false,
      selection: 0,
      holdTime: 0,
      useActive: false,
      useItem: 0,
      useT: 0,
      useDuration: 0,
    };

    this.running = false;
    this.paused = true;
    this.menuKind = 'main';
    // 独立启动器使用 Chromium 的 app 窗口并由系统最大化。这里不要再叠加网页
    // Fullscreen API；否则 Chromium 会优先用 Esc 退出网页全屏，表现成“按 Esc
    // 小窗化”，页面甚至可能收不到 Escape keydown。
    this.standalone = (() => {
      try { return new URLSearchParams(window.location.search).get('standalone') === '1'; }
      catch (_e) { return false; }
    })();
    this._playing = false;          // 明确的初始状态：还没开始游玩
    this._menuOpenShown = false;
    this.accumulator = 0;
    this.lastTime = 0;
    this.frameCount = 0;
    this.elapsed = 0;
    this.timeScale = 1;
    this.slowmoTimer = 0;
    this.slowmoScale = 1;
    this.automation = false;
    this.debugFlags = { showOverlay: false };

    this.meta = new MetaProgress();
    this.settings = this._loadSettings();

    // 局域网联机：会话对象在所有子系统建好之后才创建（init 里），这里只占位。
    // enemyTypeIds 是兵种槽表的唯一事实来源，必须两端顺序一致，因此用固定导出
    // 而不是运行时刷怪顺序。
    this.lan = null;
    this.enemyTypeIds = ENEMY_IDS;
    this._lanHudAcc = 0;

    this.tier = typeof this.meta.currentTier === 'function' ? this.meta.currentTier() : 1;
    this.mapIndex = this.tier - 1;
    this._ready = false;
    this._interp = 1;
    this._boundFrame = this.frame.bind(this);
    this._events = [];
    this._promptText = '';
    this._lastPlayerPos = new Float32Array(3);
    this._stuckCheckTimer = 0;
    this._pointerRelockTimer = 0;
    // 指针锁瞬时丢失的宽限计时（见 _onPointerLockLost）。
    // 浏览器会在很多**非玩家意图**的情况下短暂释放指针锁（重新请求的间隙、
    // chrome 短暂抢焦点、扩展介入…），原先一丢失就立刻弹设置菜单并冻结游戏，
    // 表现就是用户报的「鼠标视角丢失 + 画面卡死」。现在先给这段时间抢回锁。
    this._lockGraceTimer = 0;
    this._pendingAutoPause = false;
  }

  // ================================================================ 初始化

  async init() {
    // 输入必须在最前面初始化：绑定键位表、挂载 DOM 监听、准备指针锁定。
    // 漏掉这一步的后果是"游戏完全收不到输入且不报错"，所以放在第一行。
    Input.init(this.canvas);

    const engine = new Engine(this.canvas, { antialias: true });
    this.engine = engine;
    this.glInfo = engine.getInfo();
    createSharedMeshes(engine);

    // 世界
    const world = new World(engine);
    this.world = world;
    this.loadMission(this.mapIndex, { initial: true });

    // 玩家
    const player = new Player(world, engine, {
      queryGrappleTarget: (origin, dir, range) => (
        this.enemies ? this.enemies.queryGrappleTarget(origin, dir, range) : null
      ),
    });
    this.player = player;
    this.playerModel = new PlayerModelRenderer(engine, player);
    // 武器视图模型读取该只读引用，用于在治疗读条期间显示医疗包/护盾电池。
    player.healing = this.healing;

    // 敌人
    this.enemies = new EnemySystem(world, player, engine, {
      onKill: (enemy, headshot, opts) => this._onEnemyKill(enemy, headshot, opts),
    });

    // 特效
    this.particles = new ParticleSystem(engine, CFG.fx.maxParticles);
    this.decals = new DecalSystem(engine, CFG.fx.maxDecals);
    this.shake = new ScreenShake();
    // 敌人高亮标记：保持高对比，但必须服从深度遮挡，不能透过地板/墙体。
    this.enemyMarkers = new EnemyMarkerSystem(engine);

    // 武器
    this.weapons = new WeaponSystem(engine, world, player, { enemies: this.enemies });
    this.enemies.projectiles = this.weapons.projectiles;
    this.enemies.particles = this.particles;

    // 搜打撤式背包与地图掉落：独立于 HUD 暂停菜单，Tab 可直接开关。
    this.inventory = new InventorySystem(engine, this.hudRoot, { weapons: this.weapons, weaponDefs: WEAPONS });
    this.inventory.reset(world, this.mapSeed || 1);

    // 升级
    // 当前游戏内强化不再依赖合金：合金仍用于统计/奖励展示，但升级与刷新均免费。
    this.upgrades = new UpgradeSystem(player, this.weapons, { tier: this.tier, freeUpgrades: true });
    this.upgrades.addAlloy(0);

    // 导演与单局
    this.director = new Director(world, this.enemies, player, { particles: this.particles });
    this.run = new Run(world, player, this.enemies, { isMultiplayer: () => !!this.lan?.active });
    this.inventory.setGameplayContext({
      player,
      run: this.run,
      // 从背包双击无限药品时先关闭背包，再启动与 5 键完全相同的读条/减速/打断流程。
      onUseHealing: (index) => {
        if (this.inventory.open) this.closeBackpack();
        return this._startHealingUse(index);
      },
    });

    // 玩家出生
    player.respawn(this.findSpawn());
    this._applyModifiers();

    // HUD
    this.hud = new HUD(this.hudRoot, {
      player, weapons: this.weapons, enemies: this.enemies, director: this.director,
      run: this.run, upgrades: this.upgrades, audio: Audio, engine, world, input: Input,
      config: CFG, stats: engine.stats, errors, settings: this.settings, healing: this.healing,
      inventory: this.inventory, meta: this.meta, perks: PERKS, missions: MISSIONS,
    });
    this.hud.onIntent = (name, payload) => this._onIntent(name, payload);

    // 局域网联机会话：HUD 建立之后再创建，便于把提示/聊天直接送进 HUD。
    this.lan = new LanSession(this);
    this.lan.onNotice = (title, sub, kind) => { if (this.hud) this.hud.toast(title, sub, kind); };
    this.lan.onSessionStart = (info) => this._onLanSessionStart(info);
    this.lan.onRosterChange = () => this._pushLanHudState();
    this.lan.onChat = () => { this._pushLanHudState(); };

    // 点击画布 = 请求指针锁定 + 拉起音频。
    // 这是"鼠标不跟随"的兜底：菜单按钮点击时的手势可能不被浏览器认作画布手势，
    // 这里保证玩家在游戏画面上点一下就能恢复鼠标控制。
    this.canvas.addEventListener('click', () => {
      this._ensureAudio();
      if (this._playing && !this.paused && !Input.pointerLocked) this._requestPointerLockWithRetry();
    });
    // 指针锁定状态变化：浏览器会优先消费 Esc，真实环境里不保证页面能收到
    // Escape keydown。
    //
    // ⚠ 关键设计：**不要一丢失锁就弹菜单**。
    // 浏览器会在很多非玩家意图的情况下短暂释放指针锁（重新请求的间隙、
    // chrome 短暂抢焦点、扩展/输入法介入）。原先收到 pointerlockchange 就立刻
    // openMenuPanel('settings', { freeze: true }) → paused = true，
    // 玩家的体感就是「鼠标视角突然没了，然后画面卡死」，而且因为菜单是冻结的，
    // 他甚至不一定意识到自己能退出。
    //
    // 现在的策略：
    //   1. 锁丢失 → 先给 400ms 宽限期，期间尝试静默抢回（不打断游戏）
    //   2. 抢回来 → 什么都不做，玩家完全无感
    //   3. 抢不回 → 才按原来的逻辑进设置菜单（这才是真的被 Esc / 权限拦住了）
    //   4. 失焦导致的丢失 → 交给 _autoPause，不要弹菜单
    document.addEventListener('pointerlockchange', () => {
      if (Input.pointerLocked && this._pointerRelockTimer) {
        clearTimeout(this._pointerRelockTimer);
        this._pointerRelockTimer = 0;
      }
      if (Input.pointerLocked) {
        // 抢回来了：撤销宽限期
        if (this._lockGraceTimer) { clearTimeout(this._lockGraceTimer); this._lockGraceTimer = 0; }
        this._pendingAutoPause = false;
        this._syncMenuState();
        return;
      }
      this._onPointerLockLost();
      this._syncMenuState();
    });
    document.addEventListener('pointerlockerror', () => {
      this._syncMenuState();
      if (this.hud) {
        this.hud.toast('无法锁定鼠标', '请点击游戏画面，或检查浏览器权限设置', 'warn');
      }
    });
    // 非独立窗口中，浏览器可能先用 Esc 退出网页全屏且吞掉 keydown。
    // 监听全屏退出，仍然把玩家送进设置；独立 app 窗口不使用网页全屏，不会缩窗。
    //
    // 同样要走宽限期：退出全屏不一定伴随指针锁丢失（例如扩展或窗口管理器改了
    // 全屏状态），但直接冻结游戏会和指针锁丢失叠加成"卡死"。
    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement) return;
      if (this.settings.autoFullscreen === false) return;
      // 全屏退出时指针锁通常也已经/即将丢失，交给统一路径判定
      if (!Input.pointerLocked) this._onPointerLockLost();
      else this._syncMenuState();
    });
    // 失焦时暂停，避免"离开后还在被打"。
    // 标记 blurred 走宽限期：指针锁丢失与 blur 往往同时发生，若让
    // pointerlockchange 直接弹设置菜单，会把"切出去"变成"被冻结的设置界面"，
    // 而不是玩家预期的自动暂停。
    window.addEventListener('blur', () => {
      if (!this._playing || this.paused) return;
      if (!Input.pointerLocked) this._onPointerLockLost({ blurred: true });
      else this._autoPause();
    });

    this._wireEvents();
    // 等待外部模型导入完成，这样 init() 返回时场景已完整（也让无头自测有确定的时机）
    this._modelPromise = this._loadModelManifest();
    try { await this._modelPromise; } catch (_e) { /* 导入失败不影响启动 */ }

    // 生成首帧，置 ready
    this.renderFrame(0);
    this._ready = true;
    this.hud.hideLoading();
    this._feedBriefing();
    this.hud.showMenu('main');
    return this;
  }

  _loadSettings() {
    const saved = Save.loadSettings();
    const settings = {
      sensitivity: 0.0012,
      sniperSensitivity: 0.35,
      fov: CFG.render.fovDeg,
      volume: CFG.audio.master,
      invertY: false,
      fpsCap: 240,
      quality: 'high',
      autoFullscreen: true,   // 开始远征时自动全屏，规避 Ctrl+W 等浏览器保留快捷键
      playerName: '',         // 局域网联机昵称；留空时按房主/玩家自动取名
      servers: [],            // 直连过的服务器地址（最近优先，最多 8 个）
      ...(saved || {}),
    };
    if (typeof settings.playerName !== 'string') settings.playerName = '';
    settings.playerName = settings.playerName.replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, 12);
    if (!Array.isArray(settings.servers)) settings.servers = [];
    settings.servers = settings.servers
      .map((e) => String(typeof e === 'string' ? e : (e && e.address) || '').trim())
      .filter((a) => a.length > 0 && a.length < 64)
      .slice(0, 8);
    // 旧版 UI 把 0.2~10 直接当弧度/像素保存，导致最低档也快得不可用。
    if (!Number.isFinite(settings.sensitivity) || settings.sensitivity > 0.02) {
      settings.sensitivity = 0.0012;
    }
    // 狙击镜独立灵敏度倍率（4× 镜默认 35%），兼容旧存档中缺失/越界值。
    if (!Number.isFinite(settings.sniperSensitivity)
      || settings.sniperSensitivity < 0.05 || settings.sniperSensitivity > 1) {
      settings.sniperSensitivity = 0.35;
    }
    return settings;
  }

  applySettings(s) {
    const st = s || this.settings;
    Input.setSensitivity(st.sensitivity);
    Input.setSniperSensitivity(st.sniperSensitivity);
    Input.setInvertY(st.invertY);
    CFG.render.fovDeg = st.fov;
    CFG.audio.master = st.volume;
    Audio.setMaster(st.volume);
    CFG.render.targetFpsCap = st.fpsCap;
    CFG.render.maxPixelRatio = st.quality === 'low' ? 1.0 : (st.quality === 'medium' ? 1.25 : 1.5);
    Save.saveSettings(st);
  }

  async _loadModelManifest() {
    // 外部模型导入通道：public/models/manifest.json 可把 glb 放进场景
    try {
      const res = await fetch('public/models/manifest.json', { cache: 'no-cache' });
      if (!res.ok) return;
      const manifest = await res.json();
      const visuals = manifest.visuals || [];
      for (const entry of visuals) {
        try {
          const doc = await loadGLTF('public/models/' + entry.file);
          for (const placement of (entry.placements || [])) {
            this.world.importVisual(doc, {
              ...placement,
              id: entry.id,
              collision: entry.collision || { mode: 'none' },
            }, gltfInstanceModels, this.engine);
          }
        } catch (err) {
          recordError('模型导入失败 ' + entry.file + ': ' + (err && err.message), err && err.stack);
        }
      }
    } catch (_e) {
      // 没有 manifest 是正常情况
    }
  }

  _wireEvents() {
    const on = (type, fn) => this._events.push(Events.on(type, fn));

    on('audio:play', (p) => {
      // 注意：带 pos 的音效也必须把 rate 传下去。
      // 这里原来写的是 `playAt(p.name, p.pos, eyePos, { gain: p.gain })` —— 漏了 rate，
      // 于是所有**带位置**的音效（敌人脚步、敌人开火、各类命中）播放速率恒为 1，
      // 调用方传的 rate 被静默丢弃。playAt 本身是支持 rate 的。
      if (p.pos) Audio.playAt(p.name, p.pos, this.player.eyePos, { gain: p.gain, rate: p.rate });
      else Audio.play(p.name, { gain: p.gain, rate: p.rate });
    });
    // 禁用额外屏幕震动；武器 recoil 独立保留。
    on('fx:hitmarker', (p) => {
      if (this.hud) this.hud.flashHitmarker(p.kill ? 'kill' : 'normal');
    });
    on('hit:enemy', (p) => {
      if (!this.hud) return;
      // 只打在护盾上的“头部命中”不应伪装成爆头；只有实际扣到生命时
      // 才显示爆头颜色/样式，避免护盾受击和肉体受击反馈混淆。
      const fleshHeadshot = !!p.headshot && (!p.shieldHit || (p.healthDamage || 0) > 0);
      this.hud.flashHitmarker(p.kill ? 'kill' : (fleshHeadshot ? 'headshot' : 'normal'));
      this.hud.addDamageNumber(Math.round(p.damage), fleshHeadshot, p.point);
      this.hud.trackEnemy(p.enemy);
      // 空间化碰撞声由 EnemySystem 在命中位置播放；这里叠加不受距离衰减的
      // 玩家确认层，保证打盾、破盾、打肉在远距离也能立即区分。
      if (p.shieldHit) Audio.play('feedback_shield', { gain: 0.82 });
      if (p.shieldBreak) Audio.play('feedback_shield_break', { gain: 1.0 });
      if ((p.healthDamage || 0) > 0) Audio.play('feedback_flesh', { gain: fleshHeadshot ? 0.94 : 0.82, rate: fleshHeadshot ? 1.10 : 1 });
      if (p.kill) this.hud.addKill(this._killFeedText(p.enemy, fleshHeadshot), fleshHeadshot ? 'headshot' : 'normal');
    });
    on('hit:world', (p) => {
      if (this.particles) this.particles.emitBurst(p.point, p.normal, 'impact', {});
      if (this.decals) this.decals.add(p.point, p.normal, { kind: 'bullet' });
      if (this.run && typeof this.run.damageObjectiveAt === 'function') {
        this.run.damageObjectiveAt(p.point, p.damage || 1);
      }
    });
    on('player:land', (p) => {
      if (this.particles) {
        this.particles.emitBurst(
          [this.player.pos[0], this.player.pos[1] + 0.05, this.player.pos[2]],
          [0, 1, 0], 'land', { impact: p.speed });
      }
    });
    on('player:slide', (p) => {
      this._sliding = p.start;
      if (p.start) Audio.play('slide_loop', { loop: true, gain: 0.55 });
      else Audio.stopLoop('slide_loop');
    });
    on('player:wallrun', (p) => {
      this._wallrunning = p.start;
      if (p.start) Audio.play('wallrun_loop', { loop: true, gain: 0.48 });
      else Audio.stopLoop('wallrun_loop');
    });
    on('player:sprint', (p) => {
      if (p.start) Audio.play('sprint_loop', { loop: true, gain: 0.34 });
      else Audio.stopLoop('sprint_loop');
    });
    on('player:wallclimb', (p) => {
      if (p.start) Audio.play('wallclimb_loop', { loop: true, gain: 0.38 });
      else Audio.stopLoop('wallclimb_loop');
    });
    on('player:grapple', (p) => {
      if (p.start) Audio.play('grapple_loop', { loop: true, gain: 0.44 });
      else Audio.stopLoop('grapple_loop');
    });
    // 受伤仍有音效与 HUD 反馈，不再摇晃屏幕。
    on('player:die', (event) => this._handleDeath(event));
    // 敌人死亡不生成烟雾爆发，避免遮挡正在交火的后方目标。
    on('objective:progress', (p) => {
      if (this.hud) this.hud.setObjective(p.label, p.done, p.total);
    });
    on('objective:complete', (p) => {
      if (this.hud) this.hud.toast('目标完成', p.label, 'good');
    });
    on('objective:loot', (p) => {
      if (this.inventory && p && p.itemId) this.inventory.add(p.itemId, 1);
    });
    on('ui:message', (p) => {
      if (this.hud) this.hud.toast(p.title, p.sub, p.kind || 'info');
    });
    on('upgrade:offer', (p) => {
      if (this.hud && this._upgradeOpen) this.hud.showUpgradePanel(p.offers, this.upgrades.alloy);
    });
    on('run:end', (p) => this._onRunEnd(p));
    // 联机：房主把击杀（含击杀者）广播出去，供各端补击杀播报与本人掉落。
    on('enemy:die', (p) => {
      if (p?.byPlayer === false) return; // 自爆由特效和死亡快照同步，不发“玩家击杀”播报。
      if (!this.lan || !this.lan.isHost || !this.lan.active || !p || !p.enemy) return;
      const src = p.source;
      const by = typeof src === 'string' ? src : this.lan.selfId;
      this.lan.broadcastEnemyDeath(p.enemy, by, p.headshot);
    });
  }

  _killFeedText(enemy, headshot) {
    const t = ENEMY_TYPES[enemy.typeId];
    const name = t ? t.nameCN : '敌军';
    return headshot ? `爆头击毁 ${name}` : `击毁 ${name}`;
  }

  /**
   * 击杀结算。opts.source 是联机时的击杀者标识：字符串 = 某位房客的 peer id，
   * 因此奖励与掉落必须留给那位房客本机结算，房主不能替他吃掉。
   */
  _onEnemyKill(enemy, headshot, opts) {
    const source = opts && opts.source;
    if (typeof source === 'string') {
      // 击杀者是某位房客：击杀奖励由**那位房客本机**结算（吸血、冲刺重置等
      // 是他自己的角色状态），房主不能替他吃掉。
      //
      // 但**掉落物必须由房主生成** —— 掉落列表由房主统一广播给所有人
      // （见 net/session.js 的 _snapshotDrops）。早先这里直接 return，
      // 导致"房客击杀的敌人不掉东西"，队友和自己都看不到。
      if (this.inventory) this.inventory.spawnEnemyDrop(enemy, this.world);
      return;
    }
    this.applyKillRewards(headshot);
    if (this.inventory) this.inventory.spawnEnemyDrop(enemy, this.world);
    Audio.play('kill_confirm', { gain: 0.95 });
  }

  /** 击杀奖励（吸血、冲刺重置等）。房客在自己机器上调用同一套逻辑。 */
  applyKillRewards(headshot) {
    if (!this.player) return;
    const mods = this.player.mods.move;
    // 击杀类改件效果
    if (mods.dashResetOnKillAdd) this.player.refreshAirAbilities();
    if (mods.lifestealOnKillAdd) this.player.heal(mods.lifestealOnKillAdd);
    if (headshot && mods.healOnHeadshotKillAdd) this.player.heal(mods.healOnHeadshotKillAdd);
    if (this._sliding && mods.healthOnSlideKillAdd) this.player.heal(mods.healthOnSlideKillAdd);
  }

  /** 载入任务（地图 + 难度层） */
  loadMission(index, opts) {
    const o = opts || {};
    this.mapIndex = Math.max(0, index | 0);
    const mission = getMission(this.mapIndex) || MISSIONS[0];
    this.tier = mission.tier || 1;
    // 联机时地图种子必须来自房主：单机种子掺了本机存档进度（meta.stats.runs），
    // 两台机器各算各的就会生成不同的地图。
    const seed = Number.isFinite(o.seed)
      ? (o.seed | 0)
      : ((mission.seedBase || 1000) + (this.meta.stats.runs * 7919));
    this.mapSeed = seed;
    const mapData = generateMap({
      seed,
      missionId: mission.id,
      biome: mission.biome,
      archetype: mission.archetype,
      size: 320,
      tier: this.tier,
    });
    this.mapName = mapData.name || mission.title;
    mapData.objectives = []; // 十一关统一首领战后撤离，不再生成追踪任务。
    this.world.load(mapData);
    // 需求：切换关卡不重置背包与配件。
    // preserve 时 inventory.reset 只换地图掉落，不清空背包槽与已装配件。
    // （联机时房客也会走这条路径重载地图，所以两边都能保住自己的背包。）
    if (this.inventory) {
      this.inventory.reset(this.world, seed, { preserve: !!this._preserveOnNextLoad });
    }
    this._preserveOnNextLoad = false;
    this._spawnCache = null;   // 换图必须重算出生点
    const biome = getBiome(mission.biome) || BIOMES.industrial_forge;
    this.biome = biome;
    if (this.engine && biome && biome.palette) {
      // 地图 lighting 优先，缺失字段用生物群系调色板补齐
      const L = mapData.lighting || {};
      const pal = biome.palette;
      const vec = (a, b) => new Float32Array(a || b);
      this.engine.setLighting({
        sunDir: vec(L.sunDir, [-0.42, -0.82, -0.36]),
        sunColor: vec(L.sunColor, pal.sun),
        ambient: vec(L.ambient, pal.ambient),
        // 半球环境光的"地面反弹"用 ground，阴影里所以偏暖
        fill: vec(L.groundColor, pal.ground),
        fogColor: vec(L.fogColor, pal.fog),
        fogRange: [L.fogNear == null ? 80 : L.fogNear, L.fogFar == null ? 420 : L.fogFar],
        clearColor: vec(L.skyColor, pal.sky),
      });
      // 生物群系重力系数（深核/轨道站可以更"重"或更"轻"）
      CFG.move.gravity = 22.0 * (biome.gravityScale || 1);
    }
    if (this.run) this.run.gravityScale = biome ? (biome.gravityScale || 1) : 1;
    if (!o.initial && this.player) {
      this.player.respawn(this.findSpawn());
      this.enemies.clear();
    } else if (this.player) {
      // 首次载入也要备好出生点缓存（按索引缓存，见 findSpawn）
      this.findSpawn(0);
    }
    return mapData;
  }

  /**
   * 取本局的玩家出生点（带缓存）。
   *
   * 为什么要缓存：`world.findPlayerSpawn()` 为了找到"真正安全"的位置要做几十次
   * 射线检测与空间哈希查询。之前它被直接放在每帧/每次重生路径上调用，
   * 会明显拖慢帧率。现在每张地图只算一次。
   */
  findSpawn(index = 0) {
    // 联机时每位玩家要用不同的出生点，因此缓存必须按索引分开；
    // 只用单一缓存会让后加入的人被丢回 0 号点，与队友叠在一起。
    const i = Math.max(0, index | 0);
    if (!this._spawnCache) this._spawnCache = [];
    if (!this._spawnCache[i]) this._spawnCache[i] = this.world.findPlayerSpawn(i);
    return this._spawnCache[i];
  }

  /**
   * 本机玩家在队伍里的序号，用于分配互不重叠的出生点。
   * 单人/离线时恒为 0，与改造前的行为完全一致。
   */
  localSpawnIndex() {
    if (!this.lan || !this.lan.inSession) return 0;
    return Math.max(0, this.lan.squadList().findIndex((p) => p.self));
  }

  /** 本机是否为“房客”（联机局内、非房主）。非联机时恒为 false。 */
  _lanGuest() {
    return !!(this.lan && this.lan.active && !this.lan.isHost);
  }

  // ================================================================ 开局/重开

  /**
   * 请求进入全屏。
   *
   * 为什么需要（用户建议）：全屏状态下浏览器会把绝大多数保留快捷键交给页面，
   * 这是解决"误按 Ctrl+W 直接关掉游戏"的**根本办法** ——
   * 网页无法拦截 Ctrl+W，但全屏时浏览器本身不会再把它当成关闭标签页。
   *
   * 必须由用户手势触发（点击"开始远征"那一下正好满足条件）。
   * 失败不报错：某些环境/权限下会拒绝，游戏照常运行。
   */
  requestFullscreen() {
    if (this.automation || this.standalone) return false;
    try {
      const el = document.documentElement;
      if (!el || document.fullscreenElement || el.requestFullscreen == null) return false;
      const r = el.requestFullscreen({ navigationUI: 'hide' });
      if (r && typeof r.catch === 'function') r.catch(() => { /* 被拒绝就保持窗口模式 */ });
      return true;
    } catch (_e) { return false; }
  }

  /** 退出全屏（返回主菜单时用，避免卡在全屏里） */
  exitFullscreen() {
    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        const r = document.exitFullscreen();
        if (r && typeof r.catch === 'function') r.catch(() => {});
      }
    } catch (_e) { /* 忽略 */ }
  }

  /**
   * 开始/切换一局。
   *
   * @param opts.preserveProgress 切换关卡时保留背包、配件与强化加成。
   *   从主菜单"战役选择"或 ESC 菜单"切换关卡"进入时都带这个选项 ——
   *   换图不应该把玩家这一局攒的东西清空。
   *   不带时（首次部署、战败重开）保持原语义：一切从头开始。
   */
  startRun(opts) {
    const o = opts || {};
    const preserve = !!o.preserveProgress;
    this._preserveOnNextLoad = preserve;
    // 音频：必须在用户手势的同步调用栈里创建/恢复 AudioContext，
    // 否则浏览器会拒绝，表现为"完全没有音效且不报错"。
    this._ensureAudio();
    // 浏览器页模式使用 Fullscreen API；独立 app 窗口已经由启动器自动最大化，
    // 不能再叠加网页全屏，否则 Esc 会被 Chromium 抢走并把窗口缩小。
    if (this.settings.autoFullscreen !== false) this.requestFullscreen();

    this.player.pveDeaths = 0;
    this.player.eliminated = false;
    this._allLanFailed = false;
    this._lanSpectating = false;
    this.paused = false;
    this.menuKind = null;
    this._respawnTimer = 0;
    this._deadHandled = false;
    this._upgradeOpen = false;
    this._resetHealing();
    Input.setMenuBlocking(false);
    // 必须同时更新 Game 与 Input 两层状态。过去这里只改 Input，导致真实开始游戏后
    // this._playing 仍为 false：Esc 被 Chromium 吞掉时 pointerlockchange 兜底也会失效。
    this.setPlaying(true);
    if (this.hud) { this.hud.hideMenu(); this.hud.setVisible(true); }

    // 保留进度时不要重铸配装：玩家自己装好的配件不能被换关冲掉。
    if (!preserve && this.weapons && typeof this.weapons.resetLoadout === 'function') {
      this.weapons.resetLoadout();
    }
    // 联机时房主把本局种子随 SESSION 广播，双方必须用同一颗种子和同一张任务图；
    // _pendingLanStart 由 _onLanSessionStart 在房客侧填好。
    const lanStart = this._pendingLanStart;
    this._pendingLanStart = null;
    if (lanStart) {
      this.tier = Math.max(1, Math.min(CAMPAIGN_TIER_COUNT, lanStart.tier || 1));
      this.mapIndex = Math.max(0, lanStart.mapIndex | 0);
      this.loadMission(this.mapIndex, { seed: lanStart.seed });
    } else {
      this.loadMission(this.tier - 1, {});
    }
    const deploymentCarry = this._consumeDeploymentCarry();
    if (deploymentCarry && this.inventory) this.inventory.importCarry(deploymentCarry);
    this.player.resetArmorShieldBonus();
    this.player.respawn(this.findSpawn(this.localSpawnIndex()));
    this.enemies.clear();
    this.weapons.resetAmmo();
    this.weapons.stats.shotsFired = 0;
    this.weapons.stats.hits = 0;
    this.weapons.stats.headshots = 0;
    this.weapons.stats.damageDealt = 0;
    this.projectilesClear();
    this.particles.clear();
    this.decals.clear();
    this.shake.reset();

    // 保留进度时不要清空强化加成与合金（需求：切关不重置加成）。
    if (!preserve) {
      this.upgrades.reset();
      this.upgrades.alloy = 0;
    }
    this.upgrades.setTier ? this.upgrades.setTier(this.tier) : null;

    this.run.start(this.tier, this.mapIndex);
    this.director.start(this.run);
    this._applyModifiers();
    this._upgradeOpen = false;
    if (this.hud) {
      this.hud.hideUpgradePanel();
      this.hud.setObjective(this.run.currentObjectiveLabel(), 0, this.run.objectives.length);
      this.hud.setAlloy(0);
      this.hud.toast(`第 ${this.tier} 层 · ${this.mapName}`, this.missionBrief(), 'info');
    }
    this._requestPointerLockWithRetry();
    this._afterLanRunStart(true);
    return true;
  }

  /**
   * 联机开局后的收尾：
   *  · 房主：把权威模式装回敌人系统，并在**本局配置真的变了**时广播 SESSION。
   *  · 房客：切到复制模式（敌人不跑 AI），等待房主的敌人快照。
   * 非联机时整段是空操作。
   *
   * 这里按“配置是否变化”而不是“是否开局”来决定广播，是因为本方法同时服务于
   * `startRun()` 与 `retryRun()`：后者在房主阵亡重来时不该把全队拽回开局，
   * 只有战役推进到下一层（地图/种子变了）才需要重新下发。
   */
  _afterLanRunStart(forceAnnounce = false) {
    const lan = this.lan;
    if (!lan || !lan.inSession || !lan.online) {
      if (lan) lan.applyRoleToWorld();
      return;
    }
    lan.applyRoleToWorld();
    if (lan.isHost) {
      // startRun() 已经 director.start() 过了，这里不能再调一次：
      // director.start() 会重置 budget/phaseTime/_spawnHistory，重复调用虽然不会
      // 重复刷怪（spawnOpeningWave 有 _openingSpawned 保护），但会白白丢掉本帧状态。
      const prev = lan.sessionInfo;
      const changed = !prev || prev.seed !== this.mapSeed || prev.mapIndex !== this.mapIndex;
      if (changed || forceAnnounce) {
        lan.announceSession({
          mapIndex: this.mapIndex,
          seed: this.mapSeed,
          tier: this.tier,
          mapName: this.mapName,
        });
      }
    } else {
      // 房客不跑刷怪导演；敌人完全来自房主快照。
      this.director.stop();
      this.director.enabled = false;
    }
    if (this.hud) {
      this.hud.toast(
        lan.isHost ? '局域网房间已开局' : '已加入房主的远征',
        `${lan.peerCount} 人在线 · 延迟 ${lan.latency} ms`,
        'good',
      );
    }
  }

  /** 房客收到房主的 SESSION：用同一张图、同一颗种子开始本局 */
  _onLanSessionStart(info) {
    if (!this.lan) return;
    this._pendingLanStart = info;
    // 联机的层级推进由房主决定；房客本地残留的 _nextTier 必须清掉，
    // 否则它会在自己的 retryRun 里试图换一张房主没同意的图。
    this._nextTier = 0;
    if (this.hud) this.hud.hideMenu();
    this.startRun();
  }

  /** 把联机状态推给 HUD（限频，避免每帧构造对象） */
  _pushLanHudState() {
    if (!this.hud || typeof this.hud.setLanState !== 'function' || !this.lan) return;
    this.hud.setLanState(this.lan.lobbyState());
  }

  missionBrief() {
    const m = getMission(this.mapIndex);
    return m ? `${m.title}\n击败本层守关首领，再在任意绿色撤离信标内坚持 2 秒。` : '击败首领，在任意撤离点坚持 2 秒';
  }

  /** 把剧情背景 + 本局任务简报喂给 HUD 的「远征简报」面板 */
  _feedBriefing() {
    if (!this.hud) return;
    const m = getMission(this.tier - 1) || getMission(0);
    const biome = getBiome(m ? m.biome : 'industrial_forge') || BIOMES.industrial_forge;
    this.hud.setBriefing({
      world: (biome && biome.desc)
        ? `${biome.name}：${biome.desc}\n钢铁远征舰队把整支锻造舰队开进星系边缘，用星港把行星直接熔成战舰。你是被留在封锁区里的拾荒者，穿着拼装的外骨骼，靠拆解远征军的设备换一条命。`
        : undefined,
      mission: MISSIONS.map((mission) => `第 ${mission.tier} 层 · ${mission.title}\n守关首领：${['重装先锋','盾卫统领','绿影蛛皇','重盾机甲','神秘杀手','腐化龙','克隆哥布林大军','鬼火骑士','拳皇','熔岩守卫者','历代首领群 ×20'][mission.tier - 1]}。击败首领，再在任意绿色撤离点坚持 2 秒。`)
        .join('\n\n') + '\n\n十一层均须击败守关首领，再在任意绿色撤离点内坚持 2 秒。第十一层“噩梦”共有 20 个历代首领，全部击败并撤离后进入下一轮。',
      tier: this.tier,
      biomeName: biome ? biome.name : '',
      mapName: this.mapName || '',
      objectives: this.world ? (this.world.objectives() || []).length : 0,
    });
  }

  /**
   * 确保音频可用。刻意设计成"可反复调用、幂等"：
   *  - 在用户手势里同步创建/恢复 AudioContext
   *  - 若被浏览器拒绝，注册一次性手势回调，在下一次点击/按键时再试
   *  - 游戏跑起来之后每帧还会调 Audio.revive() 兜底
   */
  _ensureAudio() {
    try {
      const p = Audio.init();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          Audio.setMaster(this.settings.volume);
          Audio.setBus('sfx', CFG.audio.sfx);
          Audio.setBus('music', CFG.audio.music);
          Audio.setBus('ui', CFG.audio.ui);
          if (this.biome) Audio.startAmbient(this.biome.id);
        }).catch(() => { /* 音频不可用时静默降级 */ });
      }
    } catch (_e) { /* 无 WebAudio 环境 */ }
    // 再挂一次性手势钩子：首次点击/按键时把音频拉起来（幂等，已就绪时是空操作）
    if (!this._gestureHooked) {
      this._gestureHooked = true;
      Input.onGesture(() => {
        Audio.init().then(() => {
          Audio.setMaster(this.settings.volume);
          if (this.biome) Audio.startAmbient(this.biome.id);
        }).catch(() => {});
      });
    }
  }

  /** 同步菜单期间的鼠标样式；已按产品要求移除指针锁定遮罩。 */
  _syncMenuState() {
    // 直接问 HUD 当前是否开着菜单最可靠：paused 与 _menu 在某些路径下并不同步。
    const hudMenuOpen = !!(this.hud && this.hud._menu);
    const menuOpen = hudMenuOpen || this.paused || !!this.menuKind || !!this._upgradeOpen
      || !!(this.inventory && this.inventory.open);
    const bodyChanged = menuOpen !== this._menuOpenShown;
    if (!bodyChanged) return;
    this._menuOpenShown = menuOpen;
    try {
      document.body.classList.remove('needs-lock');
      document.body.classList.toggle('menu-open', !!menuOpen);
    } catch (_e) { /* 忽略 */ }
  }

  projectilesClear() {
    if (this.weapons && this.weapons.projectiles) this.weapons.projectiles.clear();
  }

  _applyModifiers() {
    const perkMods = this.meta.perkModifiers();
    const upMods = this.upgrades ? this.upgrades.modifiers : null;
    const merged = mergeModifiers(perkMods, upMods);
    this.player.setModifiers(merged);
    this.weapons.addModifiers(merged);
    if (this.run) this.run.setModifiers(merged);
    return merged;
  }

  openUpgradePanel() {
    if (!this.upgrades || !this.hud) return;
    const rng = M.mulberry32((Date.now() ^ (this.run ? this.run.runId * 7919 : 0)) >>> 0);
    const offers = this.upgrades.rollOffers(3, rng);
    this._upgradeOpen = true;
    this.paused = true;
    Input.setPlaying(false);
    Input.setMenuBlocking(true);
    Input.exitLock();
    this.hud.showMenu('upgrade');
    this.hud.showUpgradePanel(offers, this.upgrades.alloy);
    this.hud.setAlloy(this.upgrades.alloy);
    this._syncMenuState();
  }

  /** 关闭可选强化，不消费合金；Esc 与“跳过并继续”按钮共用。 */
  closeUpgradePanel() {
    if (!this._upgradeOpen) return false;
    this._upgradeOpen = false;
    this.paused = false;
    if (this.hud) {
      this.hud.hideUpgradePanel();
      this.hud.hideMenu();
    }
    Input.setMenuBlocking(false);
    Input.setPlaying(!!this._playing);
    this._syncMenuState();
    if (this._playing) this._requestPointerLockWithRetry();
    return true;
  }

  /** Tab 背包：冻结世界、释放鼠标，但不占用 HUD 的 Esc 设置菜单状态。 */
  openBackpack() {
    if (!this.inventory || !this._playing || this.menuKind || this._upgradeOpen) return false;
    if (this.healing) {
      if (this.healing.useActive) this._cancelHealingUse(false);
      this.healing.wheelOpen = false;
      this.healing.holdTime = 0;
      if (this.hud) this.hud.hideHealWheel();
    }
    this.paused = true;
    Input.setPlaying(true);          // 背包内仍阻止 Tab/数字键触发浏览器快捷行为
    Input.setMenuBlocking(true);
    Input.exitLock();
    this.inventory.setOpen(true, this.player);
    this._syncMenuState();
    Audio.play('ui_click', { gain: 0.45, rate: 1.08 });
    return true;
  }

  closeBackpack() {
    if (!this.inventory || !this.inventory.open) return false;
    this.inventory.setOpen(false, this.player);
    this.paused = false;
    Input.setMenuBlocking(false);
    Input.setPlaying(!!this._playing);
    this._syncMenuState();
    Audio.play('ui_click', { gain: 0.4, rate: 0.92 });
    if (this._playing) this._requestPointerLockWithRetry();
    return true;
  }

  pickUpgrade(id) {
    if (!this.upgrades) return false;
    const ok = this.upgrades.pick(id);
    if (ok) {
      this._applyModifiers();
      const picked = (this.upgrades.owned.slice(-1)[0] || {}).id || id;
      this.closeUpgradePanel();
      if (this.hud) {
        this.hud.toast('改件已安装', picked, 'good');
      }
    }
    return ok;
  }

  _onIntent(name, payload) {
    switch (name) {
      case 'start_run':
        if (this._nextTier) this.retryRun();
        else this.startRun();
        break;
      case 'restart':
      case 'retry':
        this.retryRun();
        break;
      case 'resume':
      case 'close_menu':
        if (this._playing) this.closeMenuPanel();
        else if (this.hud) this.hud.showMenu('main');
        break;
      case 'lan_respawn':
        this.respawnLan();
        break;
      case 'lan_spectate':
        this.spectateLan();
        break;
      case 'lan_restart':
        if (this._allLanFailed && this.lan?.isHost) {
          this.startRun();
        }
        break;
      case 'quit_to_menu':
        if (this.lan?.inSession) this.lan.leave();
        if (this.inventory) this.inventory.setOpen(false, this.player);
        this.setPlaying(false);
        this.paused = true;
        this.menuKind = 'main';
        this._respawnTimer = 0;
        this.director.stop();
        if (this.hud) {
          this.hud.showMenu('main');
          this.hud.setVisible(false);
        }
        Input.exitLock();
        break;
      case 'quit_game':
        // 独立 Chromium app 窗口通常允许由明确用户点击关闭。先完整释放游戏状态，
        // 即使浏览器策略拒绝 window.close，也不会留下锁鼠标/持续开火状态。
        if (this.inventory) this.inventory.setOpen(false, this.player);
        this.setPlaying(false);
        this.paused = true;
        this.director.stop();
        Input.exitLock();
        this.exitFullscreen();
        try {
          window.close();
        } catch (_e) { /* 下方提示兜底 */ }
        setTimeout(() => {
          if (!window.closed && this.hud) {
            this.hud.toast('浏览器阻止了自动关闭', '请按 Alt+F4 退出独立游戏窗口', 'warn');
          }
        }, 180);
        break;
      case 'pick_upgrade':
        this.pickUpgrade(payload && payload.id);
        break;
      case 'skip_upgrade':
        this.closeUpgradePanel();
        break;
      case 'reroll_upgrade':
        if (this.upgrades && this.hud) {
          const rng = M.mulberry32((Date.now() * 2654435761) >>> 0);
          const offers = this.upgrades.reroll(rng);
          this.hud.showUpgradePanel(offers, this.upgrades.alloy);
        }
        break;
      case 'set_sensitivity':
        this.settings.sensitivity = payload.value;
        this.applySettings();
        break;
      case 'set_sniper_sensitivity':
        this.settings.sniperSensitivity = payload.value;
        this.applySettings();
        break;
      case 'set_fov':
        this.settings.fov = payload.value;
        this.applySettings();
        break;
      case 'set_volume':
        this.settings.volume = payload.value;
        this.applySettings();
        break;
      case 'set_invert_y':
        this.settings.invertY = payload.value;
        this.applySettings();
        break;
      case 'set_fps_cap':
        this.settings.fpsCap = payload.value;
        this.applySettings();
        break;
      case 'set_quality':
        this.settings.quality = payload.value;
        this.applySettings();
        this.engine.setSize(this.canvas.clientWidth || window.innerWidth,
          this.canvas.clientHeight || window.innerHeight, CFG.render.maxPixelRatio);
        break;
      case 'set_auto_fullscreen':
        this.settings.autoFullscreen = !!payload.value;
        // 立刻生效：打开就进全屏，关掉就退出（全屏可避免 Ctrl+W 等浏览器快捷键误触）
        if (this.settings.autoFullscreen) this.requestFullscreen();
        else this.exitFullscreen();
        break;
      case 'open_settings':
        if (this._playing) this.openMenuPanel('settings', { freeze: true });
        else this.hud.showMenu('settings');
        break;
      case 'open_help':
        if (this._playing) this.openMenuPanel('help', { freeze: true });
        else this.hud.showMenu('help');
        break;
      case 'open_credits':
        this.hud.showMenu('credits');
        break;
      case 'open_briefing':
        this._feedBriefing();
        this.hud.showMenu('briefing');
        break;
      case 'open_campaign':
        if (this.hud) this.hud.showMenu('campaign');
        break;
      case 'open_switch_tier':
        // ESC 菜单里的"切换关卡"入口：游玩中打开，冻结游戏但不退房。
        if (this._playing) this.openMenuPanel('switch_tier', { freeze: true });
        else if (this.hud) this.hud.showMenu('switch_tier');
        break;
      case 'switch_tier': {
        // 游玩中直接换关：**保留背包、配件与强化加成**，只换地图重新部署。
        // 联机时房主换关会经 _afterLanRunStart 广播新的 SESSION，
        // 房客自动重载同一张图（他们的背包同样保留）。
        const tier = Math.max(1, Math.min(CAMPAIGN_TIER_COUNT, Number(payload && payload.tier) | 0));
        if (this.menuKind) this.closeMenuPanel();
        this._switchTierKeepProgress(tier);
        break;
      }
      case 'select_mission': {
        const tier = Math.max(1, Math.min(CAMPAIGN_TIER_COUNT, Number(payload && payload.tier) | 0));
        // 需求：**关卡无条件开放，不锁定**。
        // 早先这里会拦下"超出已解锁层数"的选择并提示"任务尚未解锁"，
        // 现在十一关随时可以直接部署，方便测试与跳关。
        // 仍然记录当前层，因为导演的难度缩放与结算都读它。
        //
        // 从主菜单进来时也保留背包/配件/加成（与 ESC 菜单的切换关卡一致）——
        // 换图不该把玩家这一局攒的东西清空。
        if (typeof this.meta.setCurrentTier === 'function') this.meta.setCurrentTier(tier);
        this.meta.persist();
        this._switchTierKeepProgress(tier);
        break;
      }
      case 'open_armory':
        if (this.hud) this.hud.showMenu('armory');
        break;
      case 'buy_perk': {
        const id = payload && payload.perkId;
        if (this.meta.buy(id)) {
          this.meta.persist();
          this._applyModifiers();
          if (this.hud) {
            this.hud.toast('永久改件已安装', PERKS[id] ? PERKS[id].name : id, 'good');
            this.hud.showMenu('armory');
          }
        } else if (this.hud) {
          const need = this.meta.perkCost(id);
          this.hud.toast('无法购买', Number.isFinite(need) ? `需要 ${need} 远征点数` : '该改件已满级', 'warn');
        }
        break;
      }
      case 'open_main':
        if (this.hud) this.hud.showMenu('main');
        break;
      // ------------------------------------------------------------ 局域网联机
      case 'open_lan':
        if (this.hud) {
          this._pushLanHudState();
          if (this._playing) this.openMenuPanel('lan', { freeze: true });
          else this.hud.showMenu('lan');
        }
        break;
      case 'lan_set_name': {
        const name = String((payload && payload.value) || '').slice(0, 12);
        this.settings.playerName = name;
        this.applySettings();
        if (this.lan) this.lan.selfName = name || this.lan.selfName;
        this._pushLanHudState();
        break;
      }
      case 'lan_host':
        this._lanConnect(true);
        break;
      case 'lan_join':
        this._lanConnect(false);
        break;
      // 公网直连：连到页面之外的服务器。地址里可带 #房间名。
      case 'lan_direct_connect': {
        const addr = String((payload && payload.value) || '').trim();
        if (!addr) {
          if (this.hud) this.hud.toast('请输入服务器地址', '例如 1.2.3.4:18200 或 game.example.com', 'warn');
          break;
        }
        this._lanConnectTo(addr);
        break;
      }
      case 'lan_refresh_servers':
        this._lanRefreshServers();
        break;
      case 'lan_leave':
        if (this.lan) {
          this.lan.leave();
          if (this.hud) this.hud.toast('已退出局域网', '', 'info');
          this._pushLanHudState();
        }
        break;
      case 'lan_start':
        // 与上游 start_run 保持同一语义：上一局结束后应推进到下一层，而不是
        // 就地重开当前层（_nextTier 由 _onRunEnd 设置）。
        if (this.lan && this.lan.isHost && this.lan.online) {
          if (this._nextTier) this.retryRun();
          else this.startRun();
        } else if (this.hud) {
          this.hud.toast('只有房主可以开局', '请等待房主开始远征', 'warn');
        }
        break;
      case 'lan_chat':
        if (this.lan && this.lan.online) this.lan.sendChat((payload && payload.value) || '');
        this._pushLanHudState();
        break;
      default:
        break;
    }
  }

  /** 房主创建房间 / 房客加入房间的统一入口 */
  async _lanConnect(asHost) {
    if (!this.lan) return false;
    if (this.lan.inSession || this.lan.phase === LAN_PHASE.CONNECTING) {
      if (this.hud) this.hud.toast('已经在房间里', '', 'info');
      return false;
    }
    if (asHost) {
      try {
        const room = this.hud?.el?.['lan-room-name']?.value || 'default';
        const r = await fetch('/__room/host', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room }) });
        const result = await r.json();
        if (!r.ok || result.error) throw new Error(result.error || '启动失败');
        return await this._lanConnectTo(result.address);
      } catch (e) {
        this.hud?.toast('开房服务启动失败', e.message + '；请从新版“开始游戏”进入', 'warn');
        return false;
      }
    }
    const entered = this.hud?.el?.['lan-direct-input']?.value?.trim();
    if (entered) return this._lanConnectTo(entered);
    if (location.hostname === '127.0.0.1') return this._lanConnectTo('http://127.0.0.1:18200#' + (this.hud?.el?.['lan-room-name']?.value || 'default'));
    this._pushLanHudState();
    if (this.hud) this.hud.toast('正在连接局域网服务器…', this.lan._t.url, 'info');
    const name = this.settings.playerName || (asHost ? '房主' : '玩家');
    const ok = asHost ? await this.lan.host(name) : await this.lan.join(name);
    if (this.hud) {
      this.hud.toast(
        ok ? (this.lan.isHost ? '房间已创建' : '已加入房间') : '联机失败',
        ok ? `把地址发给同网段的朋友：${location.origin}/` : this.lan.joinError,
        ok ? 'good' : 'warn',
      );
    }
    this.lan.applyRoleToWorld();
    this._pushLanHudState();
    return ok;
  }

  /**
   * 公网直连：连到页面之外的服务器。
   * 连上后把地址记进 settings.servers（最近使用），下次在大厅列表里直接点。
   */
  async _lanConnectTo(address) {
    if (!this.lan) return false;
    if (this.lan.inSession || this.lan.phase === LAN_PHASE.CONNECTING) {
      if (this.hud) this.hud.toast('已经在房间里', '请先退出当前房间', 'info');
      return false;
    }
    this._pushLanHudState();
    if (this.hud) this.hud.toast('正在直连服务器…', address, 'info');
    const name = this.settings.playerName || '玩家';
    const ok = await this.lan.connectTo(address, 'guest', name);
    if (ok) {
      this._rememberServer(address);
      if (this.hud) this.hud.toast('已直连服务器', `${this.lan.serverLabel || address} · 房间 ${this.lan.roomId}`, 'good');
    } else if (this.hud) {
      this.hud.toast('直连失败', this.lan.joinError || '无法连接', 'warn');
    }
    this.lan.applyRoleToWorld();
    this._pushLanHudState();
    return ok;
  }

  /** 刷新服务器列表的在线状态 */
  async _lanRefreshServers() {
    if (!this.lan) return false;
    const list = this._knownServers();
    if (this.hud) this.hud.toast('正在探测服务器…', `${list.length} 个地址`, 'info');
    await this.lan.probeServers(list);
    this._pushLanHudState();
    const online = (this.lan.serverStatus || []).filter((s) => s.ok).length;
    if (this.hud) this.hud.toast('服务器探测完成', `${online}/${list.length} 在线`, online ? 'good' : 'warn');
    return true;
  }

  /**
   * 服务器列表 = 本页面所在服务器 + 玩家保存过的地址。
   * 本页面这一项总是排在最前，因为“加入房间/创建房间”走的就是它。
   */
  _knownServers() {
    const out = [];
    if (this.lan) {
      const self = this.lan.selfServerAddress();
      if (self) out.push(self);
    }
    const saved = Array.isArray(this.settings.servers) ? this.settings.servers : [];
    for (const entry of saved) {
      const addr = typeof entry === 'string' ? entry : (entry && entry.address);
      if (addr && !out.includes(addr)) out.push(addr);
    }
    return out.slice(0, 12);
  }

  /** 记录最近直连过的服务器（最多 8 个，最近用的排最前） */
  _rememberServer(address) {
    const addr = String(address || '').trim();
    if (!addr) return;
    const saved = Array.isArray(this.settings.servers) ? this.settings.servers.slice() : [];
    const rest = saved.filter((e) => (typeof e === 'string' ? e : e && e.address) !== addr);
    rest.unshift(addr);
    this.settings.servers = rest.slice(0, 8);
    this.applySettings();
  }

  _onRunEnd(p) {
    const st = p.stats || {};
    // 只有成功撤离才把有限物资、稀有枪械与已装配件写入局外仓库；阵亡则全部丢失。
    if (p.extracted && this.inventory && typeof this.inventory.exportCarry === 'function'
      && typeof this.meta.storeCarry === 'function') {
      this.meta.storeCarry(this.inventory.exportCarry());
    }
    const earned = this.meta.recordRun({
      extracted: p.extracted,
      tier: this.tier,
      kills: st.kills || 0,
      headshots: st.headshots || 0,
      time: st.time || 0,
      alloy: this.run ? this.run.alloy : 0,
      score: this.run ? this.run.score : 0,
    });
    // 十一关战役不是只存在于数据表：成功撤离后“再次远征”会自动进入下一关，
    // 也可从主菜单的战役选择重玩任意已解锁关卡。
    this._nextTier = p.extracted
      ? (typeof this.meta.currentTier === 'function' ? this.meta.currentTier() : Math.min(CAMPAIGN_TIER_COUNT, this.tier + 1))
      : this.tier;
    this.director.stop();
    if (this.inventory) this.inventory.setOpen(false, this.player);
    this.paused = true;
    this.menuKind = p.extracted ? 'extract' : 'dead';
    this.setPlaying(false);
    Input.exitLock();
    if (this.hud) {
      this.hud.setRunStats({
        kills: st.kills || 0, headshots: st.headshots || 0,
        damage: Math.round(st.damageDealt || 0), time: st.time || 0,
        tier: this.tier, alloy: this.run ? this.run.alloy : 0,
      });
      this.hud.showMenu(p.extracted ? 'extract' : 'dead');
      if (p.extracted) this.hud.toast('撤离成功', `获得 ${earned} 远征点数`, 'good');
      else this.hud.toast('外骨骼失效', '信号中断……', 'warn');
    }
    Audio.play(p.extracted ? 'extract_success' : 'player_die');
    if (p.extracted && this.tier === CAMPAIGN_TIER_COUNT) {
      this.menuKind = 'main';
      this.hud.showMenu('main');
      this.hud.setVisible(false);
      this.hud.el['menu-main-note'].textContent =
        `战役结算：击杀 ${st.kills || 0} · 获得 ${earned} 远征点数，战利品已入库。` +
        '二十个噩梦首领相继倒下，伪装成求救信号的战斗记录终于停止循环。' +
        '你从 N-0 带回了完整的敌军档案，但远征仍未结束——下一轮从第一层开始，保留局外成长与仓库。';
    }
    // 阵亡时也起自动重生倒计时，避免卡在结算界面
    if (!p.extracted) this._respawnTimer = 12;
  }

  /**
   * 渲染一帧，并兜住异常 —— 单帧错误不得让整局变成"画面卡死"。
   *
   * 背景：frame() 在最开头就重新调度了 rAF，所以"抛异常导致循环停摆"其实不会发生；
   * 真正的问题是**每帧都抛**的异常会让画面永久定格在最后一帧，同时 HUD/输入同步
   * 全部跳过，玩家的体感与"卡死"完全一致（本项目真实踩过：cameraPos is not defined
   * 直接导致白屏）。
   *
   * 这里做三件事：
   *   1. 吞掉异常，保证本帧余下的收尾逻辑（Input.endFrame 等）仍会执行
   *   2. 限频上报（每秒最多一条），避免每帧刷爆控制台反而拖慢游戏
   *   3. 记到 debugFlags，供 F3 面板与自动化诊断读取
   */
  _renderSafely(dt) {
    try {
      this.renderFrame(dt);
      this._renderErrorCount = 0;
      return true;
    } catch (err) {
      this._renderErrorCount = (this._renderErrorCount || 0) + 1;
      this._lastRenderError = err;
      const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      if (!this._renderErrorLoggedAt || now - this._renderErrorLoggedAt > 1000) {
        this._renderErrorLoggedAt = now;
        recordError('渲染异常: ' + String(err?.message || err), err?.stack);
        this.diagnostics?.record('渲染异常', err);
        // eslint-disable-next-line no-console
        console.error('[IRONFALL] 渲染帧异常（已兜住，游戏继续）:', err);
      }
      return false;
    }
  }

  /** 从仓库原子取出全部上次战利品，作为下一次部署物资。 */
  _consumeDeploymentCarry() {
    if (!this.meta || typeof this.meta.stashSnapshot !== 'function'
      || typeof this.meta.consumeCarry !== 'function') return null;
    const snap = this.meta.stashSnapshot();
    const items = { ...(snap.items || {}) };
    const attachments = snap.lastExtractedLoadout || {};
    // 已装配件在仓库数量里也占一个实体；把它从普通背包清单中剔除，避免双扣。
    for (const slots of Object.values(attachments)) {
      for (const itemId of Object.values(slots || {})) {
        if (!itemId || !items[itemId]) continue;
        items[itemId]--;
        if (items[itemId] <= 0) delete items[itemId];
      }
    }
    if (!Object.keys(items).length && !Object.keys(attachments).length) return null;
    const carry = this.meta.consumeCarry({ items, attachments });
    if (carry) this.meta.persist();
    return carry;
  }

  // ================================================================ 循环

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    requestAnimationFrame(this._boundFrame);
  }

  stop() {
    this.running = false;
    this._stopHealingAudio();
  }

  /**
   * 打开菜单面板。游戏内菜单默认真正暂停并释放鼠标，行为与 Apex 一致。
   */
  openMenuPanel(kind, opts) {
    if (this.lan?.active && !this.player.alive && !this._allLanFailed) kind = 'lan-dead';
    const o = opts || {};
    if (this.menuKind === kind) return false;
    if (this.inventory && this.inventory.open) this.inventory.setOpen(false, this.player);
    if (this.healing) {
      if (this.healing.useActive) this._cancelHealingUse(false);
      this.healing.wheelOpen = false;
      this.healing.holdTime = 0;
      if (this.hud && typeof this.hud.hideHealWheel === 'function') this.hud.hideHealWheel();
    }
    this.menuKind = kind;
    this._menuFreeze = o.freeze !== false;
    this.paused = this._menuFreeze;
    Input.setPlaying(false);
    Input.setMenuBlocking(true);      // 关键：菜单期间屏蔽移动/开火等游戏动作
    Input.exitLock();
    if (this.hud) this.hud.showMenu(kind);
    this._syncMenuState();
    return true;
  }

  /** 关闭菜单面板并恢复操作 */
  closeMenuPanel() {
    if (!this.menuKind) return false;
    this.menuKind = null;
    this.paused = false;
    this._menuFreeze = false;
    Input.setMenuBlocking(false);
    Input.setPlaying(!!this._playing);
    if (this.hud) this.hud.hideMenu();
    this._syncMenuState();
    if (this._playing) {
      if (this.settings.autoFullscreen !== false && !document.fullscreenElement) this.requestFullscreen();
      this._requestPointerLockWithRetry();
    }
    return true;
  }

  /** Esc：游玩中直接打开设置；已在菜单里则关闭 */
  togglePauseMenu() {
    if (this.menuKind) return this.closeMenuPanel();
    if (!this.player || !this._playing) return false;
    return this.openMenuPanel('settings', { freeze: true });
  }

  /** 冻结式暂停（失焦时用） */
  pauseGame(freeze) {
    if (this.menuKind) return false;
    return this.openMenuPanel('pause', { freeze: freeze !== false });
  }

  /** 窗口失焦时自动冻结（否则玩家切出去后会在后台被打死） */
  _autoPause() {
    if (!this._playing || this.paused || this.menuKind) return;
    this.pauseGame(true);
  }

  /**
   * 游玩中的全局按键处理。
   *
   * Esc 语义：
   *   · 游玩中按 Esc → 暂停、释放鼠标并直接打开设置
   *   · 菜单中按 Esc → 关闭菜单回到游玩
   *   · 菜单里「设置」= 鼠标灵敏度 / FOV / 音量 / Y 轴反转 / 帧率上限 / 画质
   *   · 游玩中按 Tab → 直接打开设置面板（快捷键入口）
   *
   * 注意：这里**不再用 `_playing` 做前置条件** —— 早期版本在"继续游戏"等
   * 进入路径下 `_playing` 可能为假，导致 Esc 完全没反应。
   */
  _handleGlobalKeys() {
    if (Input.actionPressed('pause')) {
      if (this.lan?.active && !this.player.alive) {
        if (this._allLanFailed) {
          // 全队已失败：既不能观战（没有活着的队友），也不能靠
          // openMenuPanel('lan-dead') 再开一次 —— menuKind 已经是 lan-dead，
          // openMenuPanel 会因 `this.menuKind === kind` 直接 return false。
          // 早先这里落进死胡同：**Esc 完全失效，玩家只能刷新页面**，
          // 体感就是"画面卡死"。
          //
          // 注意不能调 closeMenuPanel()：全队失败时 _playing 为 false，
          // 关掉菜单后 _updateLanDeathState 下一帧又会把 lan-dead 推回来，
          // 形成"关掉又弹回"的循环。所以只**换菜单内容**，让玩家能回到主界面
          // 重新部署 / 重开房间。
          if (this.hud && this.hud._menu !== 'main') {
            this.hud.showMenu('main');
            this.menuKind = null;
            this._syncMenuState();
          }
          return;
        }
        if (this.menuKind === 'lan-dead') this.spectateLan();
        else this.openMenuPanel('lan-dead', { freeze: false });
        return;
      }
      // 背包优先消费 Esc：只关闭背包，不在其背后再打开设置菜单。
      if (this.inventory && this.inventory.open) {
        this.closeBackpack();
        return;
      }
      // 强化货架是可选内容；无论有没有合金，Esc 都必须先关闭它并继续游戏，
      // 不能在其背后再打开设置菜单造成双层弹窗软锁。
      if (this._upgradeOpen) {
        this.closeUpgradePanel();
        return;
      }
      if (this._playing && this.player && this.menuKind !== 'dead' && this.menuKind !== 'extract') {
        this.togglePauseMenu();
      } else if (!this._playing && this.hud && this.hud._menu && this.hud._menu !== 'main') {
        this.hud.showMenu('main');
      }
      return;
    }
    if (Input.pressed('Tab') && this.player && this._playing) {
      if (this.inventory && this.inventory.open) this.closeBackpack();
      else if (!this.menuKind && !this._upgradeOpen) this.openBackpack();
      return;
    }
    // F3：调试面板
    if (Input.pressed('F3') && this.hud) {
      this.debugFlags.showOverlay = !this.debugFlags.showOverlay;
      this.hud.setDebugPanelVisible(this.debugFlags.showOverlay);
    }
  }

  /** 由 HUD 的按钮/菜单触发：开始游玩时的统一状态切换 */
  setPlaying(b) {
    this._playing = !!b;
    Input.setPlaying(this._playing);
  }

  /**
   * 玩家阵亡后的重生流程。
   * 之前只弹了菜单、没有真正的重生入口，玩家会卡在死亡状态里出不去。
   */
  retryRun() {
    if (this.lan?.active && !this.player.alive) return this.respawnLan();
    if (this._respawnTimer > 0 || !this.player) {
      // 正常路径
    }
    if (this.weapons && typeof this.weapons.resetLoadout === 'function') this.weapons.resetLoadout();
    // 联机：换图/换种子只能由房主决定。房客本地重掷会立刻和房主的地图错位，
    // 因此房客只重开当前这张图；房主推进到下一层后会重新广播 SESSION，房客再跟随。
    const lanGuest = this._lanGuest();
    if (this._nextTier && this._nextTier !== this.tier && !lanGuest) {
      this.tier = this._nextTier;
      this.mapIndex = this.tier - 1;
      this.loadMission(this.mapIndex, {});
    }
    this._nextTier = 0;
    this.player.respawn(this.findSpawn());
    this.player.pveDeaths = 0;
    this.player.eliminated = false;
    this._allLanFailed = false;
    this._lanSpectating = false;
    this.player.health = this.player.maxHealth;
    this.player.shield = this.player.maxShield;
    this.enemies.clear();
    this.weapons.resetAmmo();
    const deploymentCarry = this._consumeDeploymentCarry();
    if (this.inventory) this.inventory.reset(this.world, (this.mapSeed || 1) ^ Date.now(), { carry: deploymentCarry });
    this._resetHealing();
    this.particles.clear();
    this.decals.clear();
    this.shake.reset();
    this.run.start(this.tier, this.mapIndex);
    this.director.start(this.run);
    this._respawnTimer = 0;
    this._deadHandled = false;
    this.paused = false;
    this.menuKind = null;
    if (this.hud) {
      this.hud.hideMenu();
      this.hud.setVisible(true);
      this.hud.toast('外骨骼已重启', `第 ${this.tier} 层 · ${this.mapName}`, 'info');
    }
    this.setPlaying(true);
    Input.setMenuBlocking(false);
    this._requestPointerLockWithRetry();
    this._afterLanRunStart(true);
  }

  /**
   * 返回游戏时先立即锁鼠标；若浏览器这次请求没有生效，1 秒后在游戏仍可操作且
   * 指针仍未锁定的前提下自动补发一次。菜单/背包重新打开后回调会自行失效。
   */
  /**
   * 指针锁丢失的处理：先给宽限期尝试抢回，失败才进菜单。
   *
   * 抽成独立方法是因为有两个入口：pointerlockchange，以及浏览器吞掉 Esc 时的兜底。
   *
   * 为什么需要宽限期：浏览器释放指针锁的原因很多，其中大部分与玩家意图无关
   * （重新请求间隙、chrome 抢焦点、扩展介入）。一丢失就 freeze 会把"鼠标瞬断一下"
   * 放大成"游戏卡死"，这是用户实测反馈的核心体验问题。
   */
  _onPointerLockLost(options) {
    const o = options || {};
    // 已经不在游玩状态 / 已经有面板打开：不需要任何补救
    if (!this._playing || this.paused || this.menuKind || this._upgradeOpen
      || (this.inventory && this.inventory.open) || this.automation) {
      return;
    }
    // 失焦导致的丢失：交给自动暂停，别弹设置菜单（那会盖掉玩家真正想看的界面）
    if (o.blurred) {
      this._pendingAutoPause = true;
    }
    if (this._lockGraceTimer) return;               // 宽限期已在进行中
    const GRACE_MS = 400;
    this._lockGraceTimer = setTimeout(() => {
      this._lockGraceTimer = 0;
      // 宽限期内如果已经回到游戏状态，就什么都不做
      if (!this._playing || this.paused || this.menuKind || this._upgradeOpen
        || (this.inventory && this.inventory.open) || this.automation) return;

      if (this._pendingAutoPause) {
        this._pendingAutoPause = false;
        this._autoPause();
        return;
      }
      // 先静默抢一次锁；能抢回来就完全无感
      if (!Input.pointerLocked) {
        const ok = Input.requestLock();
        if (ok) {
          // 再给一次机会：requestLock 是异步生效的，下一轮 pointerlockchange
          // 若成功会自行清掉宽限状态。
          this._pointerRelockTimer = setTimeout(() => {
            this._pointerRelockTimer = 0;
            if (!Input.pointerLocked && this._playing && !this.paused && !this.menuKind
              && !this._upgradeOpen && !(this.inventory && this.inventory.open)
              && !this.automation) {
              // 确实抢不回来：这才提示玩家（进设置菜单 = 冻结游戏）
              this.openMenuPanel('settings', { freeze: true });
            }
          }, 400);
          return;
        }
      }
      this.openMenuPanel('settings', { freeze: true });
    }, GRACE_MS);
  }

  _requestPointerLockWithRetry() {
    if (!this._playing || this.paused || this.menuKind || this._upgradeOpen
      || (this.inventory && this.inventory.open)) return false;
    const requested = Input.requestLock();
    if (this._pointerRelockTimer) clearTimeout(this._pointerRelockTimer);
    this._pointerRelockTimer = setTimeout(() => {
      this._pointerRelockTimer = 0;
      if (this._playing && !this.paused && !this.menuKind && !this._upgradeOpen
        && !(this.inventory && this.inventory.open) && !Input.pointerLocked) {
        Input.requestLock();
      }
    }, 1000);
    return requested;
  }

  /** 重置本局治疗资源与轮盘状态。 */
  _resetHealing() {
    this._stopHealingAudio();
    if (!this.healing) {
      this.healing = {
        medkits: Infinity, shieldBatteries: Infinity, syringes: Infinity, shieldCells: Infinity,
        wheelOpen: false, selection: 0, holdTime: 0,
        useActive: false, useItem: 0, useT: 0, useDuration: 0,
      };
    } else {
      this.healing.shieldBatteries = Infinity;
      this.healing.medkits = Infinity;
      this.healing.syringes = Infinity;
      this.healing.shieldCells = Infinity;
      this.healing.wheelOpen = false;
      this.healing.selection = 0;
      this.healing.holdTime = 0;
      this.healing.useActive = false;
      this.healing.useItem = 0;
      this.healing.useT = 0;
      this.healing.useDuration = 0;
    }
    if (this.hud && typeof this.hud.hideHealWheel === 'function') this.hud.hideHealWheel();
  }

  _stopHealingAudio() {
    for (const def of HEALING_DEFS) Audio.stopLoop(def.loopSound);
  }

  _cancelHealingUse(showToast = true) {
    const h = this.healing;
    if (!h || !h.useActive) { this._stopHealingAudio(); return false; }
    h.useActive = false;
    h.useT = 0;
    h.useDuration = 0;
    this._stopHealingAudio();
    if (showToast && this.hud) this.hud.toast('使用取消', '切枪、换弹、开火或开镜打断了治疗', 'warn');
    return true;
  }

  /** 返回轮盘当前选中的道具；轻按 5 不再根据“残血/缺盾”偷偷切换。 */
  _defaultHealingSelection() {
    const h = this.healing;
    if (!h) return 0;
    // 选择状态由长按轮盘/左右拨动/数字键显式改变，并在本局持续保留。
    // 这样玩家已经选中电池时，即使生命值见底，轻按 5 仍会使用电池，
    // 不会被“智能”逻辑抢走输入；目标已满时则正常提示无法使用。
    return Math.max(0, Math.min(HEALING_DEFS.length - 1, h.selection | 0));
  }

  /** 使用一个治疗道具；返回是否真的消耗了资源。 */
  _useHealingItem(index) {
    const p = this.player;
    const h = this.healing;
    if (!p || !h || !p.alive) return false;
    const def = HEALING_DEFS[Math.max(0, Math.min(HEALING_DEFS.length - 1, index | 0))];
    const stock = h[def.key];
    const before = def.target === 'health' ? p.health : p.shield;
    const max = def.target === 'health' ? p.maxHealth : p.maxShield;
    if (!(stock > 0) || before >= max - 0.01) {
      if (this.hud) this.hud.toast('无法使用', `${def.target === 'health' ? '生命值' : '护盾'}已满或没有${def.name}`, 'warn');
      return false;
    }
    if (Number.isFinite(stock)) h[def.key] = Math.max(0, stock - 1);
    const amount = Number.isFinite(def.amount) ? def.amount : max;
    if (def.target === 'health') p.heal(amount);
    else p.addShield(amount);
    const after = def.target === 'health' ? p.health : p.shield;
    const restored = Math.max(0, Math.round(after - before));
    const remain = Number.isFinite(h[def.key]) ? h[def.key] : '∞';
    if (this.hud) this.hud.toast(def.name, `${def.target === 'health' ? '生命' : '护盾'} +${restored} · 剩余 ${remain}`, 'good');
    Events.emit('audio:play', { name: def.completeSound, gain: 1.0 });
    Events.emit('ui:message', { title: `${def.name}已使用`, sub: `${def.target === 'health' ? '生命' : '护盾'}恢复至 ${Math.round(after)}`, kind: 'good' });
    return true;
  }

  /** 开始使用道具，完成前只减速不改变生命/护盾。 */
  _startHealingUse(index) {
    const p = this.player;
    const h = this.healing;
    if (!p || !h || !p.alive) return false;
    const safeIndex = Math.max(0, Math.min(HEALING_DEFS.length - 1, index | 0));
    const def = HEALING_DEFS[safeIndex];
    const current = def.target === 'health' ? p.health : p.shield;
    const max = def.target === 'health' ? p.maxHealth : p.maxShield;
    const valid = h[def.key] > 0 && current < max - 0.01;
    if (!valid) {
      if (this.hud) this.hud.toast('无法使用', `${def.target === 'health' ? '生命值' : '护盾'}已满`, 'warn');
      return false;
    }
    h.useActive = true;
    h.useItem = safeIndex;
    h.useT = 0;
    h.useDuration = def.duration;
    // 读条一开始就给出明确的听觉反馈（被打断时玩家也能知道正在使用）。
    Events.emit('audio:play', {
      name: def.startSound, gain: def.id === 'medkit' ? 1.45 : 1.05,
    });
    this._stopHealingAudio();
    Audio.play(def.loopSound, {
      loop: true, gain: def.id === 'medkit' ? 1.25 : (def.target === 'shield' ? 0.92 : 0.98),
    });
    if (this.hud) this.hud.toast(`正在使用${def.name}`, `${def.duration.toFixed(1)} 秒读条 · 完成前移动速度降低`, 'info');
    return true;
  }

  /** 处理 5 键轻按/长按与轮盘选择。必须在 Player.step 前调用，避免轮盘期间移动视角。 */
  _updateHealingInput(dt, input) {
    const h = this.healing;
    if (!h || !input) return;

    // 读条期间再次按 5 不叠加第二个道具；开火/开镜会取消当前读条。
    if (h.useActive) {
      if (input.fire || input.ads || input.slot1Pressed || input.slot2Pressed
        || input.slot3Pressed || input.slot4Pressed || input.swapPressed || input.reloadPressed) {
        this._cancelHealingUse(true);
      } else {
        h.useT += dt;
        input.moveX *= 0.35;
        input.moveY *= 0.35;
        if (h.useT >= h.useDuration) {
          this._stopHealingAudio();
          this._useHealingItem(h.useItem);
          h.useActive = false;
          h.useT = 0;
          h.useDuration = 0;
        }
      }
      return;
    }

    if (input.healPressed) {
      h.holdTime = 0;
      h.wheelOpen = false;
      h.selection = this._defaultHealingSelection();
    }
    if (input.healDown) {
      h.holdTime += dt;
      // 0.28s 是“轻按使用”和“长按轮盘”的分界，接近 Apex 的手感。
      if (h.holdTime >= 0.28) h.wheelOpen = true;
      if (h.wheelOpen) {
        // 轮盘期间允许 1~4 直接点选，也支持鼠标沿四个方向快速拨动选择。
        if (input.slot1Pressed) h.selection = 0;
        if (input.slot2Pressed) h.selection = 1;
        if (input.slot3Pressed) h.selection = 2;
        if (input.slot4Pressed) h.selection = 3;
        // 低灵敏度下单个像素也要能立即换项，避免左右拨动感觉迟钝。
        // 轮盘选择必须看“鼠标在屏幕上的原始位移”，不能复用 lookX：lookX
        // 为了符合镜头控制已经做过一次水平反向，直接拿它会把左右手势翻转。
        // movementX < 0 就是鼠标左移（医疗包在左侧），> 0 就是右移（电池）。
        const wheelDx = Input.mouseDX;
        const wheelDy = Input.mouseDY;
        if (Math.max(Math.abs(wheelDx), Math.abs(wheelDy)) > 0.4) {
          if (Math.abs(wheelDx) >= Math.abs(wheelDy)) h.selection = wheelDx < 0 ? 0 : 1;
          else h.selection = wheelDy < 0 ? 2 : 3;
        }
        // 数字键仅用于轮盘选项，不能同时触发切枪。
        input.slot1Pressed = false; input.slot2Pressed = false; input.slot3Pressed = false; input.slot4Pressed = false;
        input.swapPressed = false;
        input.moveX = 0; input.moveY = 0;
        input.lookX = 0; input.lookY = 0;
      }
      if (this.hud && h.wheelOpen) this.hud.showHealWheel(h.selection, h);
    } else if (input.healReleased) {
      // 轻按开始自动选择；长按松开开始使用轮盘当前选择。读条完成前不改变资源。
      this._startHealingUse(h.wheelOpen ? h.selection : this._defaultHealingSelection());
      h.wheelOpen = false;
      h.holdTime = 0;
      if (this.hud) this.hud.hideHealWheel();
    }

  }

  /** 阵亡后的收尾：弹结算菜单 + 起倒计时自动重生 */
  _handleDeath(event = {}) {
    if (this.lan?.active) return this._handleLanDeath(event);
    if (this._deadHandled) return;
    this._deadHandled = true;
    this._cancelHealingUse(false);
    if (this.inventory) this.inventory.setOpen(false, this.player);
    this.director.stop();
    this.paused = true;
    this.menuKind = 'dead';
    this.setPlaying(false);       // 菜单里要让浏览器快捷键恢复工作
    Input.exitLock();
    if (this.hud) {
      const st = this.run ? this.run.stats : {};
      this.hud.setRunStats({
        kills: st.kills || 0, headshots: st.headshots || 0,
        damage: Math.round(st.damageDealt || 0), time: st.time || 0,
        tier: this.tier, alloy: this.run ? this.run.alloy : 0,
      });
      this.hud.showMenu('dead');
    }
    // 12 秒后自动重开，避免玩家以为游戏卡死
    this._respawnTimer = 12;
  }

  getLanDeathState() {
    return { pveDeaths: this.player.pveDeaths || 0, eliminated: !!this.player.eliminated,
      canRespawn: !this.player.alive && !this.player.eliminated && !this._allLanFailed,
      allFailed: !!this._allLanFailed, isHost: !!this.lan?.isHost,
      spectating: !!this._lanSpectating, targetName: this._lanSpectateTarget?.name || '' };
  }

  _handleLanDeath(event) {
    if (this._deadHandled) return;
    this._deadHandled = true;
    if (!event.pvp) this.player.pveDeaths = (this.player.pveDeaths || 0) + 1;
    this.player.eliminated = this.player.pveDeaths > 2;
    this._cancelHealingUse(false);
    this.player._releaseGrapple?.();
    if (this.inventory) this.inventory.setOpen(false, this.player);
    this._upgradeOpen = false;
    this._respawnTimer = 0;
    this.paused = false; // Host must keep AI/snapshots alive while dead.
    this._lanSpectating = true;
    this.menuKind = 'lan-dead';
    this.setPlaying(false);
    Input.setMenuBlocking(true);
    Input.exitLock();
    this.hud?.setLanDeathState?.(this.getLanDeathState());
    this.hud?.showMenu('lan-dead');
    this.hud?.toast(event.pvp ? '被玩家击杀' : '战斗阵亡',
      event.pvp ? '不计失败次数，可重新部署' : `敌人 / 环境阵亡 ${this.player.pveDeaths}/3${this.player.eliminated ? ' · 本局仅可观战' : ' · 可重新部署'}`, 'warn');
  }

  respawnLan() {
    if (!this.lan?.active || this.player.alive || this.player.eliminated || this._allLanFailed) return false;
    // Preserve map, objective progress, enemies, inventory and death allowance.
    this.player.respawn(this.findSpawn(this.localSpawnIndex()));
    this.weapons.resetAmmo();
    this._resetHealing();
    this._deadHandled = false;
    this._lanSpectating = false;
    this._lanSpectateTarget = null;
    this.paused = false;
    this.menuKind = null;
    this.setPlaying(true);
    Input.setMenuBlocking(false);
    this.hud?.hideMenu();
    this._requestPointerLockWithRetry();
    return true;
  }

  spectateLan() {
    if (!this.lan?.active || this.player.alive || this._allLanFailed) return false;
    this._lanSpectating = true;
    this.menuKind = null;
    this.paused = false;
    this.setPlaying(true); // Esc opens the death / redeploy panel again.
    this.hud?.hideMenu();
    Input.setMenuBlocking(false);
    this._requestPointerLockWithRetry();
    return true;
  }

  _updateLanDeathState() {
    if (!this.lan?.active) return;
    const peers = this.lan.players || [];
    this._lanSpectateTarget = this._lanSpectating ? peers.find(p => p.alive && !p.eliminated) || null : null;
    if (!this._allLanFailed && this.player.eliminated && peers.every(p => p.eliminated)) {
      this._allLanFailed = true;
      this.director.stop();
      this.menuKind = 'lan-dead';
      this.setPlaying(false);
      Input.setMenuBlocking(true);
      Input.exitLock();
      // Settle exactly once, only after everyone exhausts their PvE allowance.
      this.run.end(false);
      this.paused = false;
      this._respawnTimer = 0;
      this.menuKind = 'lan-dead';
      this.hud?.showMenu('lan-dead');
    }
    this.hud?.setLanDeathState?.(this.getLanDeathState());
  }

  frame(now) {
    if (!this.running) return;
    requestAnimationFrame(this._boundFrame);

    const nowMs = typeof now === 'number' ? now : performance.now();
    // 帧率上限（设置里的「帧率上限」）。
    //
    // 之前这个设置**只被赋值、从未被读取** —— 选了 60 帧也照样跑无上限，
    // 属于「看起来有的功能其实没接线」。这里补上真正的节流：
    // 未到最小帧间隔就跳过本帧全部工作（物理与渲染都不跑）。
    // 无头自动化测试会把 fpsCap 设成 30 来压低 CPU 占用。
    const cap = CFG.render.targetFpsCap | 0;
    if (cap > 0 && this._capLastMs) {
      // 留 1ms 容差：计时抖动不该把本该跑的帧丢掉（否则实际帧率会掉一半）
      if (nowMs - this._capLastMs < (1000 / cap) - 1) return;
    }
    this._capLastMs = nowMs;

    let dt = (nowMs - this.lastTime) / 1000;
    this.lastTime = nowMs;
    if (!isFinite(dt) || dt < 0) dt = 0;
    // 单帧最大 0.25 秒，避免切标签回来一次性跑爆物理
    if (dt > 0.25) dt = 0.25;

    // Esc 必须在 paused 早退之前处理，否则打开菜单后永远收不到第二次 Esc。
    this._handleGlobalKeys();

    if (this.lan) this.lan.update(dt);
    this._updateLanDeathState();

    if (this.paused && !(this.lan?.active && !['main', 'extract', 'dead'].includes(this.menuKind))) {
      // 暂停时仍然渲染（菜单背景），但不推进物理。
      // 同时同步 body 类名，让菜单期间恢复系统光标。
      this._syncMenuState();
      this._renderSafely(dt);
      Input.endFrame();
      return;
    }

    this.elapsed += dt;

    // 全局按键已在暂停判定前处理。
    void this.menuKind;

    // 阵亡后的自动重生倒计时（同时刷新 HUD 上的倒计时显示）
    if (this._respawnTimer > 0) {
      this._respawnTimer -= dt;
      if (this.hud && this.hud.setExtraction) {
        this.hud.setExtraction(Math.max(0, this._respawnTimer));
      }
      if (this._respawnTimer <= 0) {
        this._respawnTimer = 0;
        this.retryRun();
        Input.endFrame();
        return;
      }
      this._renderSafely(dt);
      Input.endFrame();
      return;
    }

    // 音频保活：上下文可能因浏览器策略停在 suspended（表现为完全没声音）
    if ((this.frameCount & 31) === 0) {
      try { Audio.revive(); } catch (_e) { /* 忽略 */ }
    }
    this._syncMenuState();

    // 慢动作
    if (this.slowmoTimer > 0) {
      this.slowmoTimer -= dt;
      this.timeScale = this.slowmoScale;
      if (this.slowmoTimer <= 0) this.timeScale = 1;
    } else if (CFG.debug.slowMotion > 0) {
      this.timeScale = CFG.debug.slowMotion;
    } else {
      this.timeScale = 1;
    }

    const scaledDt = dt * this.timeScale;

    // 联机会话每帧推进：发送自身状态、房主广播敌人快照、房客插值远程敌人。
    // 必须在物理步之前调用，让本帧的 enemies.update 用上最新的插值目标。
    // Network update runs before pause/death handling above.

    // ---- 固定步物理
    // 视角增量按"本帧实际执行的物理步数"均摊，保证不同帧率下转头速度一致。
    this.accumulator += scaledDt;
    const inputState = this.readInput();
    const pendingLookX = inputState.lookX;
    const pendingLookY = inputState.lookY;
    const planSteps = Math.min(MAX_STEPS_PER_FRAME, Math.floor(this.accumulator / PHYS_DT));
    const lookPerStepX = planSteps > 0 ? pendingLookX / planSteps : 0;
    const lookPerStepY = planSteps > 0 ? pendingLookY / planSteps : 0;
    inputState.lookX = 0;
    inputState.lookY = 0;

    let steps = 0;
    while (this.accumulator >= PHYS_DT && steps < MAX_STEPS_PER_FRAME) {
      inputState.lookX = lookPerStepX;
      inputState.lookY = lookPerStepY;
      this.stepPhysics(PHYS_DT, inputState);
      this.accumulator -= PHYS_DT;
      steps++;
    }
    if (steps >= MAX_STEPS_PER_FRAME) this.accumulator = 0;

    // ---- 渲染帧
    // 单帧异常绝不能冻死整局：rAF 在 frame() 开头就已重新调度，但一帧里抛出的
    // 异常会让这一帧之后的 HUD/输入同步全部跳过；如果异常每帧都发生（例如某个
    // 访问了 undefined 的属性），画面就会定格在最后一帧，玩家体感是"画面卡死"。
    // 这里兜住并限频上报，至少保证循环活着、玩家还能按 Esc 退出。
    this._renderSafely(dt);
    // 固定步频低于显示刷新率时，某些渲染帧可能还没有物理步（例如 240Hz
    // 显示器上的每隔一帧）。不能在这里清掉 justPressed/鼠标增量，否则 1/2/3
    // 切枪、R 换弹等边沿动作会随机丢失，玩家就会感觉“要按好几下才切上”。
    // 等下一帧真正执行物理步后再统一清理；暂停/重生分支仍按原逻辑清理。
    if (steps > 0) Input.endFrame();
    this.frameCount++;
  }

  /** 读取一份输入快照（本帧所有物理步共用，保证手感一致） */
  readInput() {
    const sens = Input.sensitivity;
    const currentDef = this.weapons && this.weapons.current && this.weapons.current.def;
    // 仅对狙击镜 ADS 降低视角灵敏度；普通枪/腰射保持全局灵敏度。
    const lookMul = currentDef && currentDef.class === 'sniper' && Input.actionDown('ads')
      ? Input.sniperSensitivity : 1;
    const dy = Input.invertY ? -Input.mouseDY : Input.mouseDY;
    const lookSteps = 1;
    const inp = this._inp || (this._inp = {
      moveX: 0, moveY: 0, jump: false, jumpPressed: false, jumpReleased: false,
      crouch: false, crouchPressed: false, sprint: false, fire: false, ads: false,
      reloadPressed: false, chargeDown: false, chargePressed: false, chargeReleased: false,
      dashPressed: false, grappleDown: false, grapplePressed: false,
      lookX: 0, lookY: 0, swapPressed: false, slot1Pressed: false, slot2Pressed: false, slot3Pressed: false, slot4Pressed: false,
      interactPressed: false, interactDown: false, healDown: false, healPressed: false, healReleased: false,
    });
    inp.moveX = (Input.actionDown('right') ? 1 : 0) - (Input.actionDown('left') ? 1 : 0);
    inp.moveY = (Input.actionDown('forward') ? 1 : 0) - (Input.actionDown('back') ? 1 : 0);
    inp.jump = Input.actionDown('jump');
    inp.jumpPressed = Input.actionPressed('jump');
    inp.jumpReleased = Input.actionReleased('jump');
    inp.crouch = Input.actionDown('crouch');
    inp.crouchPressed = Input.actionPressed('crouch');
    inp.sprint = Input.actionDown('sprint');
    inp.fire = Input.actionDown('fire');
    inp.ads = Input.actionDown('ads');
    inp.reloadPressed = Input.actionPressed('reload');
    inp.chargeDown = Input.actionDown('charge');
    inp.chargePressed = Input.actionPressed('charge');
    inp.chargeReleased = Input.actionReleased('charge');
    inp.dashPressed = Input.actionPressed('dash');
    inp.grappleDown = Input.actionDown('grapple');
    inp.grapplePressed = Input.actionPressed('grapple');
    inp.swapPressed = Input.actionPressed('swap') || Input.wheel !== 0;
    inp.slot1Pressed = Input.actionPressed('weapon1');
    inp.slot2Pressed = Input.actionPressed('weapon2');
    inp.slot3Pressed = Input.actionPressed('weapon3');
    inp.slot4Pressed = Input.actionPressed('weapon4');
    inp.interactDown = Input.actionDown('interact');
    inp.interactPressed = Input.actionPressed('interact');
    inp.healDown = Input.actionDown('heal');
    inp.healPressed = Input.actionPressed('heal');
    inp.healReleased = Input.actionReleased('heal');
    // 鼠标增量在固定步内被消费一次（逐步分摊到物理步）
    inp.lookX = -Input.mouseDX * sens * lookMul * lookSteps;
    // DOM movementY：向下为正；Player.look 的正 dy 表示向下看，所以这里不取反。
    inp.lookY = dy * sens * lookMul * lookSteps;
    if (Input.menuBlocking) {
      inp.moveX = 0; inp.moveY = 0;
      inp.jump = false; inp.jumpPressed = false; inp.jumpReleased = false;
      inp.crouch = false; inp.crouchPressed = false; inp.sprint = false;
      inp.fire = false; inp.ads = false; inp.reloadPressed = false;
      inp.chargeDown = false; inp.chargePressed = false; inp.chargeReleased = false;
      inp.dashPressed = false;
      inp.grappleDown = false; inp.grapplePressed = false; inp.swapPressed = false;
      inp.slot1Pressed = false; inp.slot2Pressed = false; inp.slot3Pressed = false; inp.slot4Pressed = false;
      inp.interactDown = false; inp.interactPressed = false;
      inp.healDown = false; inp.healPressed = false; inp.healReleased = false;
      inp.lookX = 0; inp.lookY = 0;
    }
    return inp;
  }

  /** 单个固定物理步。input 的 lookX/lookY 已由调用方按步数均摊。 */
  stepPhysics(dt, input) {
    const p = this.player;
    if (this.lan?.active && !p.alive) {
      this.enemies.update(dt, p);
      if (!this._lanGuest() && !this._allLanFailed) this.director.update(dt);
      this.run.objectiveInteractDown = false;
      if (!this._allLanFailed) this.run.update(dt, p);
      return;
    }

    // 可选：记录最近若干物理步的输入与状态，用于排查"某段序列之后手感异常"的问题。
    // 默认关闭，零开销（只多一次 null 判断）。
    if (this.trace) {
      this.trace.push({
        n: this.trace.length,
        moveX: input.moveX, moveY: input.moveY, fire: !!input.fire,
        jump: !!input.jump, crouch: !!input.crouch, sprint: !!input.sprint,
        dash: !!input.dashPressed, grapple: !!input.grapplePressed,
        hs: +p.state.hspeed.toFixed(2), y: +p.pos[1].toFixed(2),
        grounded: p.state.grounded, state: p.state.moveState,
        ammo: this.weapons.current.ammo, reloading: this.weapons.current.reloading,
        paused: this.paused, upgradeOpen: !!this._upgradeOpen,
      });
      if (this.trace.length > 400) this.trace.shift();
    }

    // 治疗键必须先处理：长按轮盘期间屏蔽移动/视角，松开再消费道具。
    this._updateHealingInput(dt, input);

    // 哨兵整匣充能是带读条的重操作；按 B 的首帧以及后续充能期间都降速，
    // 让玩家能明显感到“正在充能”，但仍可以转身/换位。
    const currentWeaponState = this.weapons && this.weapons.state
      ? this.weapons.state.get(this.weapons.slots[this.weapons.slotIndex].id) : null;
    if (currentWeaponState && (currentWeaponState.charging || input.chargePressed)) {
      const currentDef = this.weapons.current && this.weapons.current.def;
      if (currentDef && currentDef.chargeTime > 0) {
        input.moveX *= 0.35;
        input.moveY *= 0.35;
      }
    }

    // ADS 移速按开镜进度平滑过渡：完全开镜时严格为腰射移动速度的 50%。
    // 倍率直接进入 Player 的 wishSpeed，不能缩放输入轴（方向计算会归一化）。
    const currentWeapon = this.weapons && this.weapons.current;
    const adsProgress = currentWeapon ? (currentWeapon.adsT || 0) : 0;
    const adsMoveMul = currentWeapon && currentWeapon.def
      ? (currentWeapon.def.adsMoveMul == null ? 0.5 : currentWeapon.def.adsMoveMul) : 1;
    p.setActionMoveSpeedMul(M.lerp(1, adsMoveMul, adsProgress));

    // 武器与运动系统各自需要独立的输入对象引用（武器会读同一份）
    p.step(dt, input);

    // 武器（每个物理步推进，保证 1080 RPM 在任何帧率下都准）
    this.weapons.update(dt, input);

    // 敌人与导演
    this.enemies.update(dt, p);
    // 房客不跑刷怪导演：刷怪是房主的权威行为，房客只接收敌人快照。
    if (!this._lanGuest()) this.director.update(dt);
    // 任务进度：把"所有正在交互的玩家"交给 run。
    // 单机时只有本机玩家；联机房主会追加各房客的远程代理（带 interacting + netId），
    // 这样队友按住 E 也能推进进度 —— 修「队友无法做任务 / 进度不共享」。
    // 客机不参与计算（authoritativeObjectives=false），只显示房主广播的权威进度，避免两端分歧。
    this.run.objectiveInteractDown = !!input.interactDown;
    this.run.authoritativeObjectives = !this._lanGuest();
    this.run.objectiveInteractors = this._objectiveInteractors(p, input);
    this.run.update(dt, p);

    if (this.inventory) this.inventory.update(dt, p);

    // 危险区域伤害
    this._hazardDamage(dt);

    // 目标交互
    this._interact(dt, input);

    // 未拾取的升级机会
    if (this.run.pendingUpgradeOffer && !this._upgradeOpen && this.player.alive) {
      this.run.pendingUpgradeOffer = false;
      this.openUpgradePanel();
    }

    // NaN 哨兵（默认关闭）：在物理步边界抓第一个非有限值，附带当时的上下文。
    // 数值污染一旦发生就会沿 HUD 扩散，事后很难回溯，所以留一个可开启的探针。
    if (this.nanSentinel && !this._nanReport) {
      const bad = findNonFinite(this.weapons.state.get(this.weapons.slots[this.weapons.slotIndex].id), 'weaponState');
      if (bad) {
        this._nanReport = {
          where: bad,
          input: { moveX: input.moveX, moveY: input.moveY, fire: input.fire, ads: input.ads, lookX: input.lookX },
          adsTimeMul: this.weapons.mods.weapon.adsTimeMul,
          modsNotFinite: Object.keys(this.weapons.mods.weapon).filter((k) => !Number.isFinite(this.weapons.mods.weapon[k])),
          defId: this.weapons.slots[this.weapons.slotIndex].id,
          st: JSON.parse(JSON.stringify(this.weapons.state.get(this.weapons.slots[this.weapons.slotIndex].id))),
        };
      }
    }
  }

  /**
   * 汇总"正在交互任务的玩家"，交给 run 做进度推进。
   *
   * 单机：只有本机玩家。
   * 联机房主：本机玩家 + 各房客的远程代理。远程代理上的 `interacting` 来自
   *   该房客上报的 INTERACT 标志（net/session.js 写入），`netId` 用于告诉 HUD
   *   "是队友在推"而不是自己。
   *
   * 返回的数组按物理步复用，避免每步分配。
   */
  _objectiveInteractors(p, input) {
    const list = this._interactorBuf || (this._interactorBuf = []);
    list.length = 0;
    if (!p) return list;
    p.interacting = !!(input && input.interactDown);
    list.push(p);
    // 房主才需要把队友算进来；客机的进度以房主广播为准，不参与计算。
    if (!this._lanGuest() && this.lan && this.lan.remotes) {
      for (const r of this.lan.remotes.values()) {
        if (!r || !r.alive || r.stale) continue;
        list.push(r);
      }
    }
    return list;
  }

  /**
   * 切换到指定关卡并**保留背包 / 配件 / 强化加成**，只换地图重新部署。
   *
   * 这是主菜单"战役选择"与 ESC 菜单"切换关卡"共用的落地实现 ——
   * 两条路径的行为必须一致，否则玩家会发现"从主菜单换关会清空背包"。
   *
   * 联机：房主换关后 _afterLanRunStart 会检测到 mapIndex/seed 变化并广播
   * 新的 SESSION，房客据此重载同一张图（他们的背包同样走 preserve 路径保留）。
   */
  _switchTierKeepProgress(tier) {
    const next = Math.max(1, Math.min(CAMPAIGN_TIER_COUNT, Number(tier) | 0)) || 1;
    this.tier = next;
    this.mapIndex = next - 1;
    if (this.hud) this.hud.hideMenu();
    this.startRun({ preserveProgress: true });
    return true;
  }

  _interact(dt, input) {
    const run = this.run;
    const p = this.player;
    // 地面物资优先于同位置的补给站，避免玩家面前有掉落物却总打开货架。
    if (this.inventory && this.inventory.nearDrop && input.interactPressed) {
      const got = this.inventory.pickupNearest(p);
      if (this.hud) {
        if (got.ok) this.hud.toast('已拾取', `${got.def.name} ×${got.added}`, 'good');
        else if (got.reason === 'full') this.hud.toast('背包已满', '按 Tab 整理或丢弃物品', 'warn');
      }
      if (got.ok) Audio.play('loot_pickup', { gain: 0.68, rate: 1.0 });
      input.interactPressed = false;
    }
    // 补给站：一次性交互同时补满生命、护盾与全部武器弹药，再打开升级面板。
    // 旧版只打开改件货架，名字叫“补给站”却完全不给补给，是用户反馈的直接根因。
    if (run.nearSupplyStation && input.interactPressed) {
      run.nearSupplyStation.used = true;
      const hpBefore = p.health;
      const shieldBefore = p.shield;
      p.heal(Math.max(0, p.maxHealth - p.health));
      p.addShield(Math.max(0, p.maxShield - p.shield));
      const ammoReport = this.weapons.refillAmmo();
      // 兼容未来有限库存：补给站可补充治疗消耗品；当前药品/电池为无限库存，
      // 因而不会被错误地截断为 4。生命/护盾本体仍立即补满。
      if (this.healing) {
        if (Number.isFinite(this.healing.medkits)) this.healing.medkits = Math.min(4, this.healing.medkits + 1);
        if (Number.isFinite(this.healing.shieldBatteries)) this.healing.shieldBatteries = Math.min(4, this.healing.shieldBatteries + 1);
        if (Number.isFinite(this.healing.syringes)) this.healing.syringes = Math.min(8, this.healing.syringes + 2);
        if (Number.isFinite(this.healing.shieldCells)) this.healing.shieldCells = Math.min(8, this.healing.shieldCells + 2);
      }
      if (this.hud) {
        const restored = Math.round((p.health - hpBefore) + (p.shield - shieldBefore));
        this.hud.toast('补给完成', `生命/护盾 +${restored} · 弹药与治疗道具已补满`, 'good');
        this.hud.setAlloy(this.upgrades.alloy);
      }
      Events.emit('ui:message', {
        title: '补给完成', sub: `生命、护盾与 ${ammoReport.weapons} 把武器弹药已补满`, kind: 'good',
      });
      this.openUpgradePanel();
    }
    // 撤离提示
    if (!this._promptText) this._promptText = '';
    let prompt = '';
    if (this.inventory && this.inventory.nearDrop) {
      const d = this.inventory.nearDrop;
      const def = d && d.itemId ? LOOT_DEFS[d.itemId] : null;
      const name = def ? def.name : '物资';
      const effect = def ? (def.effect || def.desc) : '';
      prompt = `[E] 拾取 ${name}${d.count > 1 ? ' ×' + d.count : ''}${effect ? ` — ${effect}` : ''}`;
    } else if (run.nearSupplyStation) prompt = '[E] 补满生命 / 护盾 / 弹药并打开改件货架';
    else if (run.nearObjective && !run.nearObjective.done) {
      const o = run.nearObjective;
      prompt = o.type === 'destroy'
        ? `射击摧毁目标… ${Math.round(o.progress * 100)}%`
        : `[E] ${o.type === 'recover' ? '拿取物资' : (o.type === 'capture' ? '夺取设备' : '执行破坏')}… ${Math.round(o.progress * 100)}%`;
    } else if (run.phase === RUN_PHASE.EXTRACTING) {
      prompt = `撤离中 ${(run.extractProgress * 100).toFixed(0)}%`;
    } else if (run.phase === RUN_PHASE.EXTRACT_READY) {
      prompt = '前往撤离点';
    }
    if (prompt !== this._promptText) {
      this._promptText = prompt;
      if (this.hud) this.hud.setPrompt(prompt);
    }
    void dt;
  }

  _hazardDamage(dt) {
    const hazards = this.world.hazards();
    if (!hazards || hazards.length === 0) return;
    const p = this.player;
    const h = this.world.hazardAt(p.pos);
    if (!h) { this._inHazard = false; return; }
    // dps 由地图给（生成器的 strength 就是每秒伤害）
    const dmg = (h.dps || 8) * dt;
    p.applyDamage(dmg, [0, -1, 0], null);
    if (!this._inHazard) {
      this._inHazard = true;
      if (this.hud) this.hud.toast('进入危险区', h.label || '高温/辐射区域 —— 立即离开', 'warn');
    }
    if (this.particles && Math.random() < dt * 10) {
      const kind = h.kind === 'lava' || h.kind === 'heat' ? 'impact' : 'shield';
      this.particles.emitBurst(p.pos, [0, 1, 0], kind, {});
    }
  }

  /** 渲染一帧 */
  renderFrame(dt) {
    const e = this.engine;
    const p = this.player;
    const w = this.weapons;

    // ---- 相机：位置插值 + 后坐力 + 震动
    this.shake.update(dt);
    p.shakeOffset[0] = this.shake.offset[0];
    p.shakeOffset[1] = this.shake.offset[1];
    p.shakeOffset[2] = this.shake.offset[2];
    p.shakeRotation[0] = this.shake.rotation[0];
    p.shakeRotation[1] = this.shake.rotation[1];
    p.shakeRotation[2] = this.shake.rotation[2];
    p.shakeFov = this.shake.fovOffset;
    p.updateCamera(dt);

    // 武器后坐力叠加到相机朝向（视觉通道）
    const rec = w.getCameraRecoil();
    const shakeYaw = this.shake.rotation[1];
    const shakePitch = this.shake.rotation[0];
    const viewYaw = p.yaw + rec.yaw + shakeYaw;
    const viewPitch = M.clamp(p.pitch + rec.pitch + shakePitch, -CFG.cam.pitchLimit, CFG.cam.pitchLimit);
    const fwd = VIEW_FWD;
    M.dirFromAngles(viewYaw, viewPitch, fwd);

    // 用 viewPitch/viewYaw 重算基向量用于相机（含 roll）
    const cp = Math.cos(viewPitch), sp = Math.sin(viewPitch);
    const cy = Math.cos(p.roll), sy = Math.sin(p.roll);
    const up = VIEW_UP;
    up[0] = sy * sp * cy + 0 * -sy;
    // 简化：由 forward 与 roll 构造 up
    buildUpFromForward(fwd, p.roll, up);

    const fov = p.getFov(CFG.render.fovDeg);
    e.setSize(this.canvas.clientWidth || window.innerWidth,
      this.canvas.clientHeight || window.innerHeight, CFG.render.maxPixelRatio);
    e.beginFrame();
    const spectator = this._lanSpectateTarget;
    if (spectator) {
      const pitch = spectator.pitch || 0, yaw = spectator.yaw || 0;
      fwd[0] = -Math.sin(yaw) * Math.cos(pitch);
      fwd[1] = Math.sin(pitch);
      fwd[2] = -Math.cos(yaw) * Math.cos(pitch);
      buildUpFromForward(fwd, 0, up);
      // 观战相机前移一小段：直接坐在队友眼球位置时，近裁剪面会切进他身边的任务
      // 模型 / 墙体，表现为"视角被卡在模型里"。沿视线前移 0.35m 即可脱出，
      // 同时与第一人称观感基本一致（不会明显"飘在身前"）。
      const EYE_FWD = 0.35;
      VIEW_POS[0] = spectator.eyePos[0] + fwd[0] * EYE_FWD;
      VIEW_POS[1] = spectator.eyePos[1] + fwd[1] * EYE_FWD;
      VIEW_POS[2] = spectator.eyePos[2] + fwd[2] * EYE_FWD;
    } else {
      VIEW_POS[0] = p.eyePos[0];
      VIEW_POS[1] = p.eyePos[1];
      VIEW_POS[2] = p.eyePos[2];
    }
    e.setCamera(VIEW_POS, fwd, up, fov, CFG.render.near, CFG.render.far);
    this.hud?.setLanNameplates?.(this.lan?.nameplates?.() || [], e);
    void cp; void sy;

    // ---- 世界与敌人
    this.world.render(e);
    if (this.inventory) this.inventory.render(e);
    if (this.playerModel) this.playerModel.render(e, dt);
    // 联机队友的第三人称模型：世界 pass 内提交，与敌人共用同一套实例批次约束。
    if (this.lan) this.lan.renderAvatars(e, dt);
    this.enemies.render(e);
    // 敌人标记已默认开启；高亮仍参与深度测试，不能透过地板或墙体。
    if (this.enemyMarkers.enabled) {
      this.enemyMarkers.render(e, this.enemies, this.world, p.eyePos);
    }

    // ---- 特效
    this.particles.update(dt);
    this.decals.update(dt);
    this.particles.render(e, p.right, p.up, p.forward);
      this.decals.render(e, fwd);
      w.projectiles.render(e);
      w.projectiles.renderGrapple(e, p);

    // ---- 音频听者与每帧内务（环境层排程、循环声部跟随）
    Audio.update(dt, p.eyePos, p.forward);

    // 世界 pass 必须在切换到视图模型相机前提交。过去所有几何都延迟到最后一次
    // flush，枪在真正绘制前已恢复世界相机，因而会完全离开视野。
    e.flushAndReset();

    // ---- 武器视图模型（独立相机 + 独立深度）
    if (p.alive) w.render(e);
    e.endFrame();

    // ---- HUD
    if (this.hud) {
      const hpbs = this.enemies.getHealthBars();
      this.hud.update(dt);
      this.hud.setAlloy(this.upgrades ? this.upgrades.alloy : 0);
      // 联机状态限频推送（8 Hz）：每帧构造状态对象会白白产生垃圾。
      if (this.lan && this.lan.phase !== 'off') {
        this._lanHudAcc += dt;
        if (this._lanHudAcc >= 0.125) {
          this._lanHudAcc = 0;
          this._pushLanHudState();
        }
      }
      this.hud.render();
      void hpbs;
    }

    // 调试线
    if (CFG.debug.showCollision) this._drawDebugCollision();
  }

  _drawDebugCollision() {
    const e = this.engine;
    const p = this.player;
    const c = [0.2, 1.0, 0.4];
    e.drawLine(
      [p.pos[0], p.pos[1], p.pos[2]],
      [p.pos[0], p.pos[1] + p.currentHeight, p.pos[2]], c);
    e.drawWireBox(
      [p.pos[0] - p.radius, p.pos[1], p.pos[2] - p.radius],
      [p.pos[0] + p.radius, p.pos[1] + p.currentHeight, p.pos[2] + p.radius], c);
    for (const en of this.enemies.all) {
      if (!en.alive) continue;
      e.drawWireBox(
        [en.pos[0] - en.radius, en.pos[1], en.pos[2] - en.radius],
        [en.pos[0] + en.radius, en.pos[1] + en.height, en.pos[2] + en.radius],
        [1.0, 0.3, 0.2]);
    }
  }

  // ================================================================ 调试/自动化

  setAutomationMode(b) {
    this.automation = !!b;
    Input.setAutomationMode(b);
    return this.automation;
  }

  /**
   * 无头推进：不依赖真实帧率，直接跑固定步。
   *
   * script 为分段输入数组，支持两种写法（可混用）：
   *   { seconds, moveX, moveY, jump, crouch, sprint, fire, ads, charge, dash, grapple,
   *     reload, swap, interact, heal, lookX, lookY }
   *   { seconds, keys: ['KeyW','Space'] }    —— 走真实 Input 通道
   *
   * 语义型字段会被翻译成按键注入 Input（因此自动化测试同时覆盖输入层），
   * 只有 lookX/lookY 这种连续量直接写进输入快照。
   */
  simulate(seconds, script) {
    const total = Math.max(0, seconds || 0);
    const wasPaused = this.paused;
    this.paused = false;
    // 自动化推进期间强制处于可操作状态，否则任何弹窗/死亡都会让整段模拟变成空转，
    // 表现为"输入毫无反应"这种极难定位的现象。
    this._upgradeOpen = false;
    if (this.hud) this.hud.hideUpgradePanel();
    const steps = Math.round(total / PHYS_DT);

    const base = this._simInput || (this._simInput = {
      moveX: 0, moveY: 0, jump: false, jumpPressed: false, jumpReleased: false,
      crouch: false, crouchPressed: false, sprint: false, fire: false, ads: false,
      reloadPressed: false, chargeDown: false, chargePressed: false, chargeReleased: false,
      dashPressed: false, grappleDown: false, grapplePressed: false,
      lookX: 0, lookY: 0, swapPressed: false, slot1Pressed: false, slot2Pressed: false, slot3Pressed: false, slot4Pressed: false,
      interactPressed: false, interactDown: false, healDown: false, healPressed: false, healReleased: false,
    });

    const segments = Array.isArray(script) && script.length > 0 ? script : [{ seconds: total }];
    const bounds = [];
    let acc = 0;
    for (const s of segments) {
      const n = Math.max(1, Math.round((s.seconds || 0) / PHYS_DT));
      bounds.push({ start: acc, end: acc + n, s });
      acc += n;
    }

    // 按键状态由语义字段推导；"按下的瞬间"只在一段开始时注入一次。
    // 注意：这里不用 keyState 去重 —— 去重会让同一个键在下一段无法再次产生"按下"边沿，
    // 导致连续两次 simulate() 里的跳跃/冲刺/换弹全部失效。改成"先抬起再按下"来显式制造边沿。
    const want = {};
    let lastSeg = null;

    let step = 0;

    while (step < steps) {
      let seg = bounds[bounds.length - 1].s;
      let segStart = bounds[bounds.length - 1].start;
      let segEnd = bounds[bounds.length - 1].end;
      for (const b of bounds) {
        if (step >= b.start && step < b.end) { seg = b.s; segStart = b.start; segEnd = b.end; break; }
      }
      const isSegStart = segStart === step;

      // ---- 组装这一段的期望按键集合
      const keys = seg.keys;
      want.KeyW = keys ? keys.includes('KeyW') : (seg.moveY || 0) > 0.4;
      want.KeyS = keys ? keys.includes('KeyS') : (seg.moveY || 0) < -0.4;
      want.KeyD = keys ? keys.includes('KeyD') : (seg.moveX || 0) > 0.4;
      want.KeyA = keys ? keys.includes('KeyA') : (seg.moveX || 0) < -0.4;
      want.Space = keys ? keys.includes('Space') : !!seg.jump;
      want.ControlLeft = keys ? keys.includes('ControlLeft') : !!seg.crouch;
      want.ShiftLeft = keys ? keys.includes('ShiftLeft') : !!seg.sprint;
      want.KeyQ = keys ? keys.includes('KeyQ') : !!seg.grapple;
      want.KeyE = keys ? keys.includes('KeyE') : !!seg.interact;
      want.AltLeft = keys ? keys.includes('AltLeft') : !!seg.dash;
      want.KeyR = keys ? keys.includes('KeyR') : !!seg.reload;
      want.KeyB = keys ? keys.includes('KeyB') : !!seg.charge;
      want.Digit5 = keys ? keys.includes('Digit5') : !!seg.heal;

      // ---- 应用按键：进入新段时先全部抬起，再按下本段需要的键（制造干净的边沿）
      if (seg !== lastSeg) {
        for (const code of Object.keys(want)) Input._injectKey(code, false);
        lastSeg = seg;
      }
      for (const code of Object.keys(want)) Input._injectKey(code, want[code]);

      Input._injectMouse(0, !!seg.fire);
      Input._injectMouse(2, !!seg.ads);
      if (seg.swap && isSegStart) Input._injectWheel(1);

      // ---- 连续量（视角）按剩余步数均摊
      const remaining = Math.max(1, segEnd - step);
      const lx = (seg.lookX || 0) / remaining;
      const ly = (seg.lookY || 0) / remaining;
      // lookX/lookY 以"弧度"给出，换算成像素增量交给 Input（readInputInto 会再乘灵敏度）
      if (lx || ly) Input._injectLook(-lx / Input.sensitivity, ly / Input.sensitivity);

      // ---- 从 Input 读取这一物理步的真实输入（与真机路径完全一致）
      this.readInputInto(base);
      this.stepPhysics(PHYS_DT, base);

      Input.endFrame();
      step++;
    }

    // 收尾：抬起所有按键，避免键盘状态泄漏到后续的真实游玩或下一次调用
    Input._resetAll();
    base.moveX = 0; base.moveY = 0;
    base.jump = base.jumpPressed = base.jumpReleased = false;
    base.crouch = base.crouchPressed = false;
    base.sprint = base.fire = base.ads = false;
    base.chargeDown = base.chargePressed = base.chargeReleased = false;
    base.dashPressed = base.grapplePressed = base.grappleDown = false;
    base.reloadPressed = base.swapPressed = base.slot1Pressed = base.slot2Pressed = base.slot3Pressed = base.slot4Pressed =
      base.interactPressed = base.interactDown = false;
    base.healDown = base.healPressed = base.healReleased = false;
    base.lookX = 0; base.lookY = 0;

    // 视图相关的量也推进一次（相机/插值/HUD）
    for (let i = 0; i < 3; i++) this.renderFrame(1 / 120);
    this.paused = wasPaused;
    return this.debugState();
  }

  /** 从 Input 读取一份输入快照写入 out（readInput 的零分配版本） */
  readInputInto(out) {
    const sens = Input.sensitivity;
    const dy = Input.invertY ? -Input.mouseDY : Input.mouseDY;
    const currentDef = this.weapons && this.weapons.current && this.weapons.current.def;
    const lookMul = currentDef && currentDef.class === 'sniper' && Input.actionDown('ads')
      ? Input.sniperSensitivity : 1;
    // 连续视角量先写入；Game 暂停时不会推进物理。
    out.lookX = -Input.mouseDX * sens * lookMul;
    out.lookY = dy * sens * lookMul;
    // 菜单覆盖层期间屏蔽游戏动作，避免在菜单里误开枪/误跳
    if (Input.menuBlocking) {
      // 菜单打开后连视角增量也必须归零。过去这里只屏蔽移动/开火，某些旁路
      // 仍可能消费 Esc 前积累的 mousemove，造成“菜单出现但视角还被拖住”的错觉。
      out.lookX = 0; out.lookY = 0;
      out.moveX = 0; out.moveY = 0;
      out.jump = false; out.jumpPressed = false; out.jumpReleased = false;
      out.crouch = false; out.crouchPressed = false;
      out.sprint = false; out.fire = false; out.ads = false;
      out.reloadPressed = false;
      out.chargeDown = false; out.chargePressed = false; out.chargeReleased = false;
      out.dashPressed = false;
      out.grappleDown = false; out.grapplePressed = false;
      out.swapPressed = false; out.slot1Pressed = false; out.slot2Pressed = false; out.slot3Pressed = false; out.slot4Pressed = false;
      out.interactDown = false; out.interactPressed = false;
      out.healDown = false; out.healPressed = false; out.healReleased = false;
      return out;
    }
    out.moveX = (Input.actionDown('right') ? 1 : 0) - (Input.actionDown('left') ? 1 : 0);
    out.moveY = (Input.actionDown('forward') ? 1 : 0) - (Input.actionDown('back') ? 1 : 0);
    out.jump = Input.actionDown('jump');
    out.jumpPressed = Input.actionPressed('jump');
    out.jumpReleased = Input.actionReleased('jump');
    out.crouch = Input.actionDown('crouch');
    out.crouchPressed = Input.actionPressed('crouch');
    out.sprint = Input.actionDown('sprint');
    out.fire = Input.actionDown('fire');
    out.ads = Input.actionDown('ads');
    out.reloadPressed = Input.actionPressed('reload');
    out.chargeDown = Input.actionDown('charge');
    out.chargePressed = Input.actionPressed('charge');
    out.chargeReleased = Input.actionReleased('charge');
    out.dashPressed = Input.actionPressed('dash');
    out.grappleDown = Input.actionDown('grapple');
    out.grapplePressed = Input.actionPressed('grapple');
    out.swapPressed = Input.actionPressed('swap') || Input.wheel !== 0;
    out.slot1Pressed = Input.actionPressed('weapon1');
    out.slot2Pressed = Input.actionPressed('weapon2');
    out.slot3Pressed = Input.actionPressed('weapon3');
    out.slot4Pressed = Input.actionPressed('weapon4');
    out.interactDown = Input.actionDown('interact');
    out.interactPressed = Input.actionPressed('interact');
    out.healDown = Input.actionDown('heal');
    out.healPressed = Input.actionPressed('heal');
    out.healReleased = Input.actionReleased('heal');
    return out;
  }

  renderOnce() {
    this.renderFrame(1 / 120);
    return {
      drawCalls: this.engine.stats.drawCalls,
      triangles: this.engine.stats.triangles,
      instances: this.engine.stats.instances,
      batches: this.engine.stats.batches,
    };
  }

  /** 测量一段时间的实际渲染帧率（用于自动化性能验证） */
  async measureFps(ms) {
    const duration = ms || 1500;
    const start = performance.now();
    let frames = 0;
    let worst = 0;
    let last = start;
    const wasPaused = this.paused;
    this.paused = false;
    return new Promise((resolve) => {
      const tick = () => {
        const now = performance.now();
        const dt = now - last;
        last = now;
        if (frames > 0) worst = Math.max(worst, dt);
        frames++;
        this.renderFrame(Math.min(0.05, dt / 1000));
        if (now - start < duration) {
          requestAnimationFrame(tick);
        } else {
          const elapsed = now - start;
          this.paused = wasPaused;
          resolve({
            frames,
            ms: Math.round(elapsed),
            fps: Math.round((frames / elapsed) * 1000 * 10) / 10,
            worstFrameMs: Math.round(worst * 100) / 100,
            drawCalls: this.engine.stats.drawCalls,
            triangles: this.engine.stats.triangles,
          });
        }
      };
      requestAnimationFrame(tick);
    });
  }

  debugState() {
    return {
      ready: this._ready,
      fps: Math.round(this.engine ? this.engine.stats.fps : 0),
      fpsAvg: Math.round(this.engine ? this.engine.stats.fpsAvg : 0),
      frameMs: this.engine ? Math.round(this.engine.stats.frameMs * 100) / 100 : 0,
      cpuMs: this.engine ? Math.round(this.engine.stats.cpuMs * 100) / 100 : 0,
      drawCalls: this.engine ? this.engine.stats.drawCalls : 0,
      triangles: this.engine ? this.engine.stats.triangles : 0,
      instances: this.engine ? this.engine.stats.instances : 0,
      batches: this.engine ? this.engine.stats.batches : 0,
      entities: this.enemies ? this.enemies.aliveCount() : 0,
      particles: this.particles ? this.particles.count : 0,
      decals: this.decals ? this.decals.aliveCount : 0,
      projectiles: this.weapons ? this.weapons.projectiles.aliveCount : 0,
      playerPos: this.player ? [round2(this.player.pos[0]), round2(this.player.pos[1]), round2(this.player.pos[2])] : null,
      playerSpeed: this.player ? Math.round(this.player.state.speed * 100) / 100 : 0,
      playerState: this.player ? this.player.state.moveState : 'none',
      playerDetail: this.player ? this.player.debugState() : null,
      weaponId: this.weapons ? this.weapons.current.id : null,
      ammo: this.weapons ? this.weapons.current.ammo : 0,
      weapon: this.weapons ? this.weapons.debugState() : null,
      inventory: this.inventory ? this.inventory.debugState() : null,
      healing: this.healing ? {
        medkits: this.healing.medkits,
        shieldBatteries: this.healing.shieldBatteries,
        syringes: this.healing.syringes,
        shieldCells: this.healing.shieldCells,
        wheelOpen: this.healing.wheelOpen,
        selection: this.healing.selection,
      } : null,
      runPhase: this.run ? this.run.phase : 'none',
      lan: this.lan ? this.lan.debugState() : null,
      run: this.run ? this.run.debugState() : null,
      director: this.director ? this.director.debugState() : null,
      enemies: this.enemies ? this.enemies.debugState() : null,
      world: this.world ? this.world.debugState() : null,
      map: this.mapName,
      tier: this.tier,
      paused: this.paused,
      mapIndex: this.mapIndex,
      errors: errors.slice(-8),
      errorCount: errors.length,
    };
  }
}

// ---------------------------------------------------------------- 工具

const VIEW_FWD = new Float32Array(3);
const VIEW_UP = new Float32Array(3);
// 相机位置（每帧复用）。观战时会在这里写入前移后的坐标，
// 正常游玩时写入玩家眼位。**必须有模块级声明** ——
// 早先只在分支里赋值没有声明，导致 "cameraPos is not defined" 让游戏直接白屏。
const VIEW_POS = new Float32Array(3);

function round2(v) { return Math.round(v * 100) / 100; }

/** 找到对象里第一个非有限数值，返回 "路径=值" 或 null（NaN 探针用） */
function findNonFinite(obj, path) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'number' && !Number.isFinite(v)) return `${path}.${k}=${v}`;
    if (v && typeof v === 'object' && !ArrayBuffer.isView(v) && !Array.isArray(v)) {
      const sub = findNonFinite(v, `${path}.${k}`);
      if (sub) return sub;
    }
  }
  return null;
}

/** 由前方向 + roll 构造上向量 */
function buildUpFromForward(fwd, roll, out) {
  // 取一个与 fwd 不平行的参考轴
  let ux = 0, uy = 1, uz = 0;
  if (Math.abs(fwd[1]) > 0.985) { ux = 1; uy = 0; uz = 0; }
  // right = normalize(cross(fwd, up_ref))
  let rx = fwd[1] * uz - fwd[2] * uy;
  let ry = fwd[2] * ux - fwd[0] * uz;
  let rz = fwd[0] * uy - fwd[1] * ux;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  // up = cross(right, fwd)
  let ux2 = ry * fwd[2] - rz * fwd[1];
  let uy2 = rz * fwd[0] - rx * fwd[2];
  let uz2 = rx * fwd[1] - ry * fwd[0];
  // 施加 roll
  const c = Math.cos(roll), s = Math.sin(roll);
  out[0] = ux2 * c + rx * s;
  out[1] = uy2 * c + ry * s;
  out[2] = uz2 * c + rz * s;
  return out;
}

/** 合并两套 modifiers（乘算键相乘，加算键相加） */
function mergeModifiers(a, b) {
  const out = { move: {}, weapon: {}, meta: {} };
  for (const group of ['move', 'weapon', 'meta']) {
    const ga = (a && a[group]) || {};
    const gb = (b && b[group]) || {};
    const keys = new Set([...Object.keys(ga), ...Object.keys(gb)]);
    for (const k of keys) {
      const va = ga[k];
      const vb = gb[k];
      if (va == null) { out[group][k] = vb; continue; }
      if (vb == null) { out[group][k] = va; continue; }
      if (k.endsWith('Mul')) out[group][k] = va * vb;
      else if (typeof va === 'boolean' || typeof vb === 'boolean') out[group][k] = (va || vb) ? 1 : 0;
      else out[group][k] = va + vb;
    }
  }
  return out;
}

// ---------------------------------------------------------------- 启动

let game = null;

async function boot() {
  const canvas = document.getElementById('game-canvas');
  const hudRoot = document.getElementById('hud-root') || document.body;
  if (!canvas) {
    recordError('缺少 #game-canvas 元素', null);
    return;
  }

  // 全局错误收集
  window.addEventListener('error', (ev) => {
    recordError(ev.message, ev.error && ev.error.stack);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    recordError('未处理的 Promise 拒绝: ' + (ev.reason && ev.reason.message ? ev.reason.message : ev.reason),
      ev.reason && ev.reason.stack);
  });

  try {
    game = new Game(canvas, hudRoot);
    await game.init();
    game.applySettings(game.settings);
    game.diagnostics = installDiagnostics(game);
    game.start();
    window.__IRONFALL__ = {
      game,
      CFG,
      Engine,
      World,
      Player,
      WeaponSystem,
      EnemySystem,
      Director,
      Run,
      UpgradeSystem,
      WEAPONS,
      ENEMY_TYPES,
      MISSIONS,
      BIOMES,
      RARITIES,
      Input,
      Events,
      Audio,
      errors,
      ready: true,
      // 自动化辅助
      simulate: (sec, script) => game.simulate(sec, script),
      renderOnce: () => game.renderOnce(),
      measureFps: (ms) => game.measureFps(ms),
      setAutomationMode: (b) => game.setAutomationMode(b),
      startRun: () => game.startRun(),
      debugState: () => game.debugState(),
      version: '1.0.0',
    };
    // 加载遮罩交还给 HUD
    const overlay = document.getElementById('load-overlay');
    if (overlay) overlay.classList.remove('load-overlay--static');
  } catch (err) {
    recordError('启动失败: ' + (err && err.message ? err.message : err), err && err.stack);
    const overlay = document.getElementById('load-overlay');
    if (overlay) {
      const t = document.getElementById('load-text');
      if (t) t.textContent = '启动失败：' + (err && err.message ? err.message : '未知错误');
    }
    // 仍然暴露错误信息供自动化读取
    window.__IRONFALL__ = { errors, ready: false, bootError: String(err && err.message) };
  }
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}

export { Game, boot, mergeModifiers };
