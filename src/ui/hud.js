// ==== ui/hud.js — IRONFALL 的 DOM HUD / 菜单 / 加载遮罩（零依赖、全字段防御） ====

// ── 设计意图 ────────────────────────────────────────────────────────────────
// 1) HUD 由 main.js 最早构造（此时多数子系统还不存在），因此 ctx 的每个字段都
//    必须当作「可选」处理；任何缺失都退化成占位显示，绝不抛异常。
// 2) DOM 树只在构造函数里建一次。render() 只写 textContent / style / classList，
//    并且用「变更检测缓存」（this._cache / this._styleCache）跳过没有变化的写入，
//    保证 300+ FPS 下不会产生多余的样式重算与布局抖动。
// 3) 伤害数字 / 击杀播报 / 提示条使用固定容量对象池循环复用：节点数恒定有界。
//    复用最旧槽位时先 removeChild 再 appendChild，既保证堆叠顺序又不新增节点。
// 4) 本文件刻意不 import 任何模块（契约允许 import core/*，但 HUD 不需要），
//    这样它可以在无头 Node 环境下配合最小 DOM mock 直接自测（tools/test-hud.mjs）。

// 玩家状态标签：速度表右侧的 chip 永远只取这 7 个值之一。
const STATE_CHIPS = ['GROUNDED', 'SLIDE', 'WALLRUN', 'AIR', 'GRAPPLE', 'MANTLE', 'DASH'];

// 元素池容量 —— 这是「DOM 节点不会无限增长」的硬上限。
const POOL_DAMAGE = 32;
const POOL_KILL = 6;
const POOL_TOAST = 8;
const POOL_OFFER = 3;
const POOL_ENEMY_VITAL = 8;

// 各类浮层存活时间（秒）
const DMG_LIFE = 0.95;
const KILL_LIFE = 5.2;
const TOAST_LIFE = 3.6;
const COMBO_WINDOW = 4.0;

// 速度表满量程（m/s）：60 m/s 为设计上限，条满即极限机动。
const SPEED_FULL = 60;

// 罗盘带宽（度）：120 度视野内的刻度条
const COMPASS_FOV = 140;

const RARITY_CN = { common: '常规', rare: '稀有', epic: '史诗', legendary: '传说' };
const RARITY_KEY = { common: 'common', rare: 'rare', epic: 'epic', legendary: 'legendary' };

const KIND_CN = { info: '情报', warn: '警告', good: '达成' };

// 制作名单（静态表；IRONFALL 是零第三方依赖实现，这里如实列出）
const CREDITS_LINES = [
  ['世界观 / 策划', '工业星际远征 · 钢铁远征舰队'],
  ['引擎', '自研 WebGL2 状态批处理渲染器'],
  ['运动系统', 'Apex 风格强化机动（滑铲 / 蹬墙跑 / 抓钩 / 冲刺）'],
  ['武器系统', 'R-99 手感弹道与后坐力模型'],
  ['地图', '程序化生成 · 5 生物群系 × 6 原型'],
  ['音效', '纯 WebAudio 程序化合成（无音频素材）'],
  ['界面', 'DOM + CSS 池化 HUD'],
  ['第三方依赖', '无'],
  ['操作', 'F3 调试 · Esc 暂停 · 详见「操作说明」'],
];

// 菜单静态描述：构造时一次性建 DOM，之后只切 class / 文本。
const MENU_SPEC = {
  main: {
    tag: 'IRONFALL // BUILD 2.0.2',
    title: '钢铁远征',
    sub: 'IRONFALL',
    note: '你是钢铁远征舰队熔炉世界里的拾荒者。搜刮、变强、活着撤离。',
    items: [
      { key: '1', label: '开始远征', sub: 'NEW EXPEDITION', intent: 'start_run', primary: true },
      { key: '2', label: '继续', sub: 'CONTINUE', intent: 'resume' },
      { key: '3', label: '战役选择', sub: 'TEN-MISSION CAMPAIGN', intent: 'open_campaign' },
      { key: '4', label: '局外军械库', sub: 'PERMANENT ARMORY', intent: 'open_armory' },
      { key: '5', label: '远征简报', sub: 'MISSION BRIEFING', intent: 'open_briefing' },
      { key: '6', label: '设置', sub: 'SETTINGS', intent: 'open_settings' },
      { key: '7', label: '操作说明', sub: 'CONTROLS', intent: 'open_help' },
      { key: '8', label: '制作名单', sub: 'CREDITS', intent: 'open_credits' },
    ],
  },
  campaign: {
    tag: 'CAMPAIGN // 01—10',
    title: '战役选择',
    sub: 'EXPEDITION TIERS',
    note: '撤离成功会解锁下一关。选择已解锁任务后立即部署。',
    campaign: true,
    items: Array.from({ length: 10 }, (_v, i) => ({
      key: String(i + 1), label: `第 ${i + 1} 关`, sub: 'LOCKED', intent: 'select_mission', tier: i + 1,
      primary: i === 0,
    })).concat([{ key: '0', label: '返回', sub: 'BACK', intent: 'open_main' }]),
  },
  armory: {
    tag: 'META ARMORY',
    title: '局外军械库',
    sub: 'PERMANENT UPGRADES',
    note: '使用撤离获得的远征点数购买；效果从下一次部署开始永久生效。',
    armory: true,
    items: [
      ['servo_legs', '伺服义肢'], ['plate_carrier', '复合装甲板'],
      ['cell_bank', '电容阵列'], ['scavenger', '拾荒者协议'],
      ['dash_module', '冲刺电容模组'], ['grapple_spool', '加长绞盘'],
      ['fire_control', '火控芯片'], ['trauma_kit', '战地医疗包'],
      ['extract_beacon', '撤离信标强化'], ['luck_chip', '幸运算法'],
    ].map((p, i) => ({ key: String(i + 1), label: p[1], sub: 'PURCHASE', intent: 'buy_perk', perkId: p[0] }))
      .concat([{ key: '0', label: '返回', sub: 'BACK', intent: 'open_main' }]),
  },
  pause: {
    tag: 'SYSTEM HALT',
    title: '已暂停',
    sub: 'PAUSED',
    note: '远征仍在继续，装甲维持待机。',
    items: [
      { key: '1', label: '继续', sub: 'RESUME', intent: 'resume', primary: true },
      { key: '2', label: '设置', sub: 'SETTINGS', intent: 'open_settings' },
      { key: '3', label: '操作说明', sub: 'CONTROLS', intent: 'open_help' },
      { key: '4', label: '放弃远征', sub: 'ABANDON RUN', intent: 'quit_to_menu', danger: true },
    ],
  },
  dead: {
    tag: 'EXOSUIT OFFLINE',
    title: '装甲失效',
    sub: 'KILLED IN ACTION',
    note: '动力骨架停机。回收记录已上传至钢铁远征档案。',
    stats: true,
    items: [
      { key: '1', label: '重新部署', sub: 'REDEPLOY', intent: 'restart', primary: true },
      { key: '2', label: '返回主菜单', sub: 'MAIN MENU', intent: 'quit_to_menu' },
    ],
  },
  extract: {
    tag: 'DROPSHIP INBOUND',
    title: '撤离成功',
    sub: 'EXTRACTION SUCCESS',
    note: '合金已入库，远征点数已结算。',
    stats: true,
    items: [
      { key: '1', label: '再次远征', sub: 'NEW EXPEDITION', intent: 'restart', primary: true },
      { key: '2', label: '返回主菜单', sub: 'MAIN MENU', intent: 'quit_to_menu' },
    ],
  },
  settings: {
    tag: 'CONFIG',
    title: '设置',
    sub: 'SETTINGS',
    note: '↑↓ 选择 · ←→ 调整 · Enter 确认 · Esc 返回',
    settings: true,
    items: [{ key: '1', label: '返回', sub: 'BACK', intent: 'close_menu', primary: true }],
  },
  help: {
    tag: 'FIELD MANUAL',
    title: '操作说明',
    sub: 'CONTROLS',
    note: '所有键位均可在 core/input.js 中重绑定。',
    keymap: true,
    items: [{ key: '1', label: '返回', sub: 'BACK', intent: 'close_menu', primary: true }],
  },
  // 剧情背景 / 本局任务简报：文案由 game 通过 setBriefing() 注入
  briefing: {
    tag: 'MISSION BRIEFING',
    title: '远征简报',
    sub: 'BACKGROUND',
    note: '钢铁远征舰队正在把整颗行星熔成战舰。你是被留在封锁区里的拾荒者。',
    briefing: true,
    items: [
      { key: '1', label: '开始远征', sub: 'DEPLOY', intent: 'start_run', primary: true },
      { key: '2', label: '返回', sub: 'BACK', intent: 'open_main', },
    ],
  },
  credits: {
    tag: 'ARCHIVE',
    title: '制作名单',
    sub: 'CREDITS',
    note: 'IRONFALL // 钢铁远征 —— 浏览器原生 WebGL2 实现，零第三方依赖。',
    credits: true,
    items: [{ key: '1', label: '返回', sub: 'BACK', intent: 'open_main', primary: true }],
  },
};

// 设置项描述：滑条 / 开关 / 下拉，改动后立刻通过 onIntent 回传。
const SETTINGS_SPEC = [
  { id: 'sensitivity', label: '鼠标灵敏度', sub: 'SENSITIVITY · RAD/COUNT', intent: 'set_sensitivity', type: 'range', min: 0.00005, max: 0.006, step: 0.00005, def: 0.0012 },
  { id: 'fov', label: '视野 FOV', sub: 'FIELD OF VIEW', intent: 'set_fov', type: 'range', min: 70, max: 120, step: 1, def: 100 },
  { id: 'sniperSensitivity', label: '狙击镜灵敏度', sub: 'SNIPER ADS · 4× MULTIPLIER', intent: 'set_sniper_sensitivity', type: 'range', min: 0.05, max: 1, step: 0.05, def: 0.35 },
  { id: 'volume', label: '音量', sub: 'MASTER VOLUME', intent: 'set_volume', type: 'range', min: 0, max: 1, step: 0.01, def: 0.8 },
  { id: 'invertY', label: 'Y 轴反转', sub: 'INVERT Y AXIS', intent: 'set_invert_y', type: 'toggle', def: false },
  { id: 'fpsCap', label: '帧率上限', sub: 'FPS CAP', intent: 'set_fps_cap', type: 'select', def: 0, options: [[0, '无上限'], [60, '60'], [120, '120'], [144, '144'], [240, '240']] },
  { id: 'quality', label: '画质', sub: 'QUALITY', intent: 'set_quality', type: 'select', def: 'high', options: [['low', '低'], ['medium', '中'], ['high', '高'], ['ultra', '极高']] },
  // 全屏能避免 Ctrl+W 等浏览器保留快捷键被误触，默认开启
  { id: 'autoFullscreen', label: '自动全屏', sub: 'AUTO FULLSCREEN', intent: 'set_auto_fullscreen', type: 'toggle', def: true },
];

// 键位表（操作说明菜单，静态文本，构造时生成）
const KEYMAP = [
  ['移动', 'W A S D'],
  ['跳跃 / 二段跳', 'Space'],
  ['蹲伏 / 滑铲', 'Ctrl / C'],
  ['疾跑（切换）', 'Shift'],
  ['冲刺 DASH（额外能力）', '左 Alt'],
  ['战术技能 / 抓钩', 'Q'],
  ['开火', '鼠标左键'],
  ['开镜 ADS', '鼠标右键'],
  ['换弹', 'R'],
  ['治疗 / 护盾电池', '5（长按打开轮盘）'],
  ['武器槽', '1 R-99 / 2 平行 / 3 近战 / 4 哨兵（滚轮切换）'],
  ['背包', 'Tab'],
  ['交互 / 补给站', 'E'],
  ['近战', 'V'],
  ['战术地图', 'M'],
  ['选择强化', '1 / 2 / 3'],
  ['刷新强化', 'R'],
  ['暂停', 'Esc'],
  ['调试面板', 'F3'],
];

// 结算统计行（阵亡 / 撤离共用）
const STAT_ROWS = [
  ['kills', '击杀'],
  ['headshots', '爆头'],
  ['damage', '总伤害'],
  ['time', '存活时长'],
  ['tier', '远征深度'],
  ['alloy', '合金'],
];

// ── 小工具（全部纯函数，hot path 无分配） ───────────────────────────────────
function num(v, fb = 0) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fb;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function clamp01(v) {
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(num(sec, 0)));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ':' + (r < 10 ? '0' : '') + r;
}

function fmtClock(sec) {
  const s = Math.max(0, Math.ceil(num(sec, 0)));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r;
}

function bearingDeg(dx, dz) {
  // 约定：-Z 为北（0°），+X 为东（90°），顺时针增大。
  const d = Math.atan2(dx, -dz) * 180 / Math.PI;
  return (d % 360 + 360) % 360;
}

function pad3(deg) {
  const d = Math.round(deg) % 360;
  return (d < 100 ? (d < 10 ? '00' : '0') : '') + (d < 0 ? d + 360 : d);
}

function dist2D(a, b) {
  if (!a || !b) return NaN;
  const dx = num(b[0]) - num(a[0]);
  const dz = num(b[2]) - num(a[2]);
  const d = Math.sqrt(dx * dx + dz * dz);
  return Number.isFinite(d) ? d : NaN;
}

// ==== HUD ====
export class HUD {
  /**
   * @param {HTMLElement|null} root 承载 HUD 的容器（可为 null，此时 HUD 进入「无 DOM」降级模式）
   * @param {object} ctx { player, weapons, enemies, director, run, upgrades, audio, engine, ... } 全部可选
   */
  constructor(root, ctx) {
    this.root = root || null;
    this.ctx = ctx || {};

    // 意图回调由 game 注入：hud.onIntent = (name, payload) => {}
    this.onIntent = null;

    // 元素索引：所有稳定 id 的元素都挂在这里，自动化脚本与自测都依赖它。
    this.el = Object.create(null);

    // 变更检测缓存：键 = 元素 id（+ 属性名）。只有值真的变了才写 DOM。
    this._cache = Object.create(null);
    this._styleCache = Object.create(null);

    this._listeners = [];      // 所有已绑定监听器，dispose() 时统一摘除
    this._disposed = false;
    this._visible = true;      // HUD 主体是否可见
    this._loading = false;     // 加载遮罩是否覆盖中
    this._built = false;

    this._menu = null;         // 当前菜单 kind（null = 无菜单；'upgrade' 为强化面板）
    this._menuItems = Object.create(null);
    this._navTargets = [];
    this._navIndex = 0;

    this._toasts = [];         // 提示条对象池
    this._toastIdx = 0;
    this._kills = [];          // 击杀播报对象池
    this._killIdx = 0;
    this._dmg = [];            // 伤害数字对象池
    this._dmgIdx = 0;
    // 最近受击敌人的世界空间状态条。固定池避免连射/多目标时创建 DOM。
    this._enemyVitals = [];
    this._enemyVitalIdx = 0;

    this._offers = [];         // 当前 3 选 1 强化
    this._offerIndex = -1;     // 高亮的强化下标（selectedOfferIndex）
    this._upgradeOpen = false;

    this._hm = null;           // 命中标记 { t, kind }
    this._hmTime = num(this.ctx.config && this.ctx.config.fx && this.ctx.config.fx.hitmarkerTime, 0.16);
    this._crossFlash = 0;      // 准心命中闪白剩余时间

    this._combo = 0;
    this._comboTimer = 0;

    this._objective = null;    // { label, done, total }
    this._objectivePoint = null;
    this._extract = null;      // 剩余秒数 | null
    this._extractPoint = null;
    this._extractShown = -1;
    this._alloy = null;        // 显式设置过则优先

    this._prompt = null;
    this._debugOn = false;

    // 治疗轮盘：节点只创建一次，长按 5 时切换状态/文本，避免高频创建 DOM。
    this._healWheel = { open: false, selected: 0 };

    this._xhair = { style: 'default', color: '', scale: 1 };

    // 帧率/帧时间：ctx.stats 缺失时用 update(dt) 自行做指数平均。
    this._frameMs = -1;
    this._fps = 0;
    this._debugAccum = 0;
    this._debugSample = true;  // 首次 render 就要填满调试面板
    this._rect = { w: 1920, h: 1080 };

    this._time = 0;
    this._errors = [];         // HUD 自身捕获的异常（有界，最多 5 条）
    this.lastError = null;

    // 设置项本地值（重新打开设置面板时回填；game 可覆盖）
    this.settings = Object.create(null);
    for (const s of SETTINGS_SPEC) this.settings[s.id] = s.def;
    this._seedSettings();

    this._statOverride = null;

    // 文档对象：优先用 root 所属文档，保证多文档/无头环境下也对。
    const doc = (this.root && this.root.ownerDocument) ||
      (typeof document !== 'undefined' ? document : null);
    this.doc = doc && typeof doc.createElement === 'function' ? doc : null;

    this._build();
  }

  // ── 只读状态 ─────────────────────────────────────────────────────────────
  /** 契约要求：只读。加载遮罩覆盖中或已销毁时为 false。 */
  get visible() {
    return !!this._built && this._visible && !this._loading && !this._disposed;
  }

  /** 当前高亮的强化下标；没有任何高亮时为 -1。 */
  get selectedOfferIndex() {
    return this._offerIndex;
  }

  // ── 设置初值：从已有子系统里尽力嗅探 ──────────────────────────────────────
  _seedSettings() {
    const c = this.ctx || {};
    const input = c.input;
    if (input && typeof input.getSensitivity === 'function') {
      try { this.settings.sensitivity = num(input.getSensitivity(), this.settings.sensitivity); } catch (e) { /* 忽略 */ }
    } else if (input && typeof input.sensitivity === 'number') {
      this.settings.sensitivity = input.sensitivity;
    }
    if (input && typeof input.invertY === 'boolean') this.settings.invertY = input.invertY;
    if (input && typeof input.getInvertY === 'function') {
      try { this.settings.invertY = !!input.getInvertY(); } catch (e) { /* 忽略 */ }
    }
    const cfg = c.config || c.CFG || null;
    if (cfg && cfg.render && Number.isFinite(cfg.render.fovDeg)) this.settings.fov = cfg.render.fovDeg;
    if (cfg && cfg.audio && Number.isFinite(cfg.audio.master)) this.settings.volume = cfg.audio.master;
    if (cfg && cfg.render && Number.isFinite(cfg.render.targetFpsCap)) this.settings.fpsCap = cfg.render.targetFpsCap;
    const s = c.settings;
    if (s && typeof s === 'object') {
      for (const spec of SETTINGS_SPEC) {
        if (s[spec.id] !== undefined) this.settings[spec.id] = s[spec.id];
      }
    }
  }

  // ── 建树（只此一次） ─────────────────────────────────────────────────────
  _build() {
    if (!this.doc || !this.root || typeof this.root.appendChild !== 'function') {
      this._built = false;
      return;
    }
    const el = this.el;
    const mk = (tag, id, cls) => this._mk(tag, id, cls);

    // 顶层：HUD 根（pointer-events:none，只有菜单/面板自己打开交互）
    el.root = mk('div', 'hud', 'hud');
    this._append(this.root, el.root);

    this._buildCrosshair(mk);
    this._buildTargeting(mk);
    this._buildTopBar(mk);
    this._buildVitals(mk);
    this._buildAmmo(mk);
    this._buildSpeed(mk);
    this._buildPools(mk);
    this._buildDebug(mk);
    this._buildUpgrade(mk);
    this._buildMenus(mk);
    this._buildLoading(mk);

    this._built = true;
  }

  _mk(tag, id, cls) {
    const doc = this.doc;
    if (!doc || typeof doc.createElement !== 'function') return null;
    const n = doc.createElement(tag);
    if (!n) return null;
    if (id) n.id = id;
    if (cls) n.className = cls;
    return n;
  }

  _append(parent, ...children) {
    if (!parent || typeof parent.appendChild !== 'function') return parent;
    for (let i = 0; i < children.length; i++) {
      if (children[i]) parent.appendChild(children[i]);
    }
    return parent;
  }

  // ── 子系统读取（每个都可能不存在） ───────────────────────────────────────
  _player() {
    const p = this.ctx && this.ctx.player;
    return p && typeof p === 'object' ? p : null;
  }

  _weapons() {
    const w = this.ctx && this.ctx.weapons;
    return w && typeof w === 'object' ? w : null;
  }

  _buildCrosshair(mk) {
    const el = this.el;
    el.crosshair = mk('div', 'hud-crosshair', 'hud-crosshair');
    // 四根准心线：只改 transform: translate*，不动布局。
    el.chTop = mk('i', 'hud-ch-line-top', 'hud-ch-line hud-ch-line--top');
    el.chBottom = mk('i', 'hud-ch-line-bottom', 'hud-ch-line hud-ch-line--bottom');
    el.chLeft = mk('i', 'hud-ch-line-left', 'hud-ch-line hud-ch-line--left');
    el.chRight = mk('i', 'hud-ch-line-right', 'hud-ch-line hud-ch-line--right');
    el.chDot = mk('i', 'hud-ch-dot', 'hud-ch-dot');
    el.hitmarker = mk('div', 'hud-hitmarker', 'hud-hitmarker');
    for (let i = 0; i < 4; i++) {
      this._append(el.hitmarker, mk('i', 'hud-hitmarker-line-' + i, 'hud-hitmarker-line hud-hitmarker-line--' + i));
    }
    this._append(el.crosshair, el.chTop, el.chBottom, el.chLeft, el.chRight, el.chDot, el.hitmarker);
    this._append(el.root, el.crosshair);
  }

  /** 屏幕空间任务信标 + ADS 光学准具。节点只构建一次，每帧仅更新样式/文本。 */
  _buildTargeting(mk) {
    const el = this.el;

    el.waypoint = mk('div', 'hud-waypoint', 'hud-waypoint');
    el.waypointIcon = mk('i', 'hud-waypoint-icon', 'hud-waypoint-icon');
    el.waypointLabel = mk('strong', 'hud-waypoint-label', 'hud-waypoint-label');
    el.waypointDistance = mk('span', 'hud-waypoint-distance', 'hud-waypoint-distance');
    this._append(el.waypoint, el.waypointIcon, el.waypointLabel, el.waypointDistance);

    el.ads = mk('div', 'hud-ads', 'hud-ads');
    el.adsShade = mk('i', 'hud-ads-shade', 'hud-ads-shade');
    el.adsRing = mk('i', 'hud-ads-ring', 'hud-ads-ring');
    el.adsLineH = mk('i', 'hud-ads-line-h', 'hud-ads-line hud-ads-line--h');
    el.adsLineV = mk('i', 'hud-ads-line-v', 'hud-ads-line hud-ads-line--v');
    el.adsDot = mk('i', 'hud-ads-dot', 'hud-ads-dot');
    this._append(el.ads, el.adsShade, el.adsRing, el.adsLineH, el.adsLineV, el.adsDot);

    el.healWheel = mk('div', 'hud-heal-wheel', 'hud-heal-wheel');
    el.healWheelTitle = mk('strong', 'hud-heal-wheel-title', 'hud-heal-wheel-title');
    el.healWheelHint = mk('span', 'hud-heal-wheel-hint', 'hud-heal-wheel-hint');
    el.healWheelTitle.textContent = '治疗轮盘';
    el.healWheelHint.textContent = '松开 5 使用 · 鼠标四向拨动 / 数字 1~4 选择';
    this._healSlots = [];
    const healDefs = [
      ['医疗包', '3.0 秒 · 生命全满', 'medkits', '+'],
      ['护盾电池', '2.5 秒 · 护盾全满', 'shieldBatteries', '◇'],
      ['注射器', '1.0 秒 · 生命 +25', 'syringes', '↑'],
      ['小型护盾电池', '1.0 秒 · 护盾 +25', 'shieldCells', '◇'],
    ];
    for (let i = 0; i < healDefs.length; i++) {
      const slot = mk('div', 'hud-heal-slot-' + i, 'hud-heal-slot hud-heal-slot--pos-' + i);
      const icon = mk('i', 'hud-heal-slot-' + i + '-icon', 'hud-heal-slot-icon');
      const name = mk('strong', 'hud-heal-slot-' + i + '-name', 'hud-heal-slot-name');
      const desc = mk('span', 'hud-heal-slot-' + i + '-desc', 'hud-heal-slot-desc');
      const count = mk('b', 'hud-heal-slot-' + i + '-count', 'hud-heal-slot-count');
      icon.textContent = healDefs[i][3];
      name.textContent = healDefs[i][0];
      desc.textContent = healDefs[i][1];
      this._append(slot, icon, name, desc, count);
      this._append(el.healWheel, slot);
      this._healSlots.push({ slot, count, key: healDefs[i][2] });
    }
    this._append(el.healWheel, el.healWheelTitle, el.healWheelHint);

    this._append(el.root, el.waypoint, el.ads, el.healWheel);
  }

  _buildTopBar(mk) {
    const el = this.el;
    el.top = mk('div', 'hud-top', 'hud-top');

    // 罗盘（唯一允许用 canvas 的部件之一）
    el.compassWrap = mk('div', 'hud-compass-wrap', 'hud-compass-wrap');
    el.compass = mk('canvas', 'hud-compass', 'hud-compass');
    if (el.compass) {
      el.compass.width = 360;
      el.compass.height = 28;
    }
    el.bearingObjective = mk('span', 'hud-bearing-objective', 'hud-bearing hud-bearing--objective');
    el.bearingExtract = mk('span', 'hud-bearing-extract', 'hud-bearing hud-bearing--extract');
    this._append(el.compassWrap, el.compass, el.bearingObjective, el.bearingExtract);

    // 目标进度
    el.objective = mk('div', 'hud-objective', 'hud-objective');
    el.objectiveLabel = mk('span', 'hud-objective-label', 'hud-objective-label');
    el.objectiveText = mk('span', 'hud-objective-text', 'hud-objective-text');
    el.objectiveFill = mk('i', 'hud-objective-fill', 'hud-objective-fill');
    const objBar = mk('div', 'hud-objective-bar', 'hud-objective-bar');
    this._append(objBar, el.objectiveFill);
    this._append(el.objective, el.objectiveLabel, el.objectiveText, objBar);

    // 撤离倒计时
    el.extraction = mk('div', 'hud-extraction', 'hud-extraction');
    el.extractionLabel = mk('span', 'hud-extraction-label', 'hud-extraction-label');
    el.extractionTime = mk('span', 'hud-extraction-time', 'hud-extraction-time');
    this._append(el.extraction, el.extractionLabel, el.extractionTime);

    this._append(el.top, el.compassWrap, el.objective, el.extraction);
    this._append(el.root, el.top);
  }

  _buildVitals(mk) {
    const el = this.el;
    el.vitals = mk('div', 'hud-vitals', 'hud-vitals');

    el.health = mk('div', 'hud-health', 'hud-health');
    const hpTrack = mk('div', 'hud-health-track', 'hud-health-track');
    el.healthFill = mk('i', 'hud-health-fill', 'hud-health-fill');
    this._append(hpTrack, el.healthFill);
    // 护盾是独立的叠加层：与生命条同轨但用冷色，且从右往左生长。
    el.shield = mk('div', 'hud-shield', 'hud-shield');
    el.shieldFill = mk('i', 'hud-shield-fill', 'hud-shield-fill');
    this._append(el.shield, el.shieldFill);
    el.healthText = mk('span', 'hud-health-text', 'hud-health-text');
    this._append(el.health, hpTrack, el.shield, el.healthText);

    // 左下角治疗物品栏：始终显示当前选择与四类道具库存，读条时显示进度。
    el.healInventory = mk('div', 'hud-heal-inventory', 'hud-heal-inventory');
    el.healInventoryTitle = mk('span', 'hud-heal-inventory-title', 'hud-heal-inventory-title');
    el.healInventoryTitle.textContent = '治疗物品 · 5';
    el.healInventoryItems = mk('div', 'hud-heal-inventory-items', 'hud-heal-inventory-items');
    this._healInventorySlots = [];
    const invDefs = [['医疗包', 'medkits'], ['护盾电池', 'shieldBatteries'], ['注射器', 'syringes'], ['小电', 'shieldCells']];
    for (let i = 0; i < invDefs.length; i++) {
      const item = mk('div', 'hud-heal-inventory-item-' + i, 'hud-heal-inventory-item');
      const name = mk('span', 'hud-heal-inventory-item-' + i + '-name', 'hud-heal-inventory-name');
      const count = mk('b', 'hud-heal-inventory-item-' + i + '-count', 'hud-heal-inventory-count');
      name.textContent = invDefs[i][0];
      this._append(item, name, count);
      this._append(el.healInventoryItems, item);
      this._healInventorySlots.push({ item, count, key: invDefs[i][1] });
    }
    el.healUse = mk('div', 'hud-heal-use', 'hud-heal-use');
    el.healUseFill = mk('i', 'hud-heal-use-fill', 'hud-heal-use-fill');
    el.healUseText = mk('span', 'hud-heal-use-text', 'hud-heal-use-text');
    this._append(el.healUse, el.healUseFill, el.healUseText);
    this._append(el.healInventory, el.healInventoryTitle, el.healInventoryItems, el.healUse);

    el.abilities = mk('div', 'hud-abilities', 'hud-abilities');
    const abilityDefs = [['dash', '冲刺', 'DASH'], ['grapple', '抓钩', 'GRAPPLE'], ['jump', '二段跳', 'JUMP']];
    this._ability = Object.create(null);
    for (const def of abilityDefs) {
      const key = def[0];
      const box = mk('div', 'hud-ability-' + key, 'hud-ability hud-ability--' + key);
      const name = mk('span', 'hud-ability-' + key + '-name', 'hud-ability-name');
      const label = mk('span', 'hud-ability-' + key + '-label', 'hud-ability-label');
      const sub = mk('span', 'hud-ability-' + key + '-sub', 'hud-ability-sub');
      const track = mk('div', 'hud-ability-' + key + '-track', 'hud-ability-track');
      const fill = mk('i', 'hud-ability-' + key + '-fill', 'hud-ability-fill');
      this._append(track, fill);
      this._append(box, name, label, sub, track);
      this._append(el.abilities, box);
      if (name) name.textContent = def[1] + ' · ' + def[2];
      if (label) label.textContent = '--';
      this._ability[key] = { box, name, label, sub, fill };
    }

    this._append(el.vitals, el.health, el.healInventory, el.abilities);
    this._append(el.root, el.vitals);
  }

  _buildAmmo(mk) {
    const el = this.el;
    el.ammo = mk('div', 'hud-ammo', 'hud-ammo');
    el.weaponName = mk('div', 'hud-weapon-name', 'hud-weapon-name');
    el.ammoCurrent = mk('span', 'hud-ammo-current', 'hud-ammo-current');
    const sep = mk('span', 'hud-ammo-sep', 'hud-ammo-sep');
    el.ammoReserve = mk('span', 'hud-ammo-reserve', 'hud-ammo-reserve');
    if (sep) sep.textContent = '/';
    const line = mk('div', 'hud-ammo-line', 'hud-ammo-line');
    el.ammoLine = line;
    this._append(line, el.ammoCurrent, sep, el.ammoReserve);
    // 哨兵充能条：只在当前武器支持 B 充能时显示。
    el.charge = mk('div', 'hud-charge', 'hud-charge');
    el.chargeLabel = mk('span', 'hud-charge-label', 'hud-charge-label');
    el.chargeTrack = mk('div', 'hud-charge-track', 'hud-charge-track');
    el.chargeFill = mk('i', 'hud-charge-fill', 'hud-charge-fill');
    this._append(el.chargeTrack, el.chargeFill);
    this._append(el.charge, el.chargeLabel, el.chargeTrack);
    el.reload = mk('div', 'hud-reload', 'hud-reload');
    el.reloadText = mk('span', 'hud-reload-text', 'hud-reload-text');
    // 进度环：两个被裁剪的半圆 + 同一角度旋转，纯 transform 动画。
    el.reloadRing = mk('div', 'hud-reload-ring', 'hud-ring');
    const track = mk('i', 'hud-reload-track', 'hud-ring-track');
    const halfR = mk('div', 'hud-reload-half-r', 'hud-ring-half hud-ring-half--r');
    const halfL = mk('div', 'hud-reload-half-l', 'hud-ring-half hud-ring-half--l');
    el.reloadArcR = mk('i', 'hud-reload-arc-r', 'hud-ring-arc');
    el.reloadArcL = mk('i', 'hud-reload-arc-l', 'hud-ring-arc');
    this._append(halfR, el.reloadArcR);
    this._append(halfL, el.reloadArcL);
    this._append(el.reloadRing, track, halfR, halfL);
    this._append(el.reload, el.reloadRing, el.reloadText);
    this._append(el.ammo, el.weaponName, line, el.charge, el.reload);
    this._append(el.root, el.ammo);
  }

  _buildSpeed(mk) {
    const el = this.el;
    el.speed = mk('div', 'hud-speed', 'hud-speed');
    el.speedValue = mk('span', 'hud-speed-value', 'hud-speed-value');
    const unit = mk('span', 'hud-speed-unit', 'hud-speed-unit');
    if (unit) unit.textContent = 'm/s';
    el.speedState = mk('span', 'hud-speed-state', 'hud-speed-state');
    const track = mk('div', 'hud-speed-track', 'hud-speed-track');
    el.speedFill = mk('i', 'hud-speed-fill', 'hud-speed-fill');
    this._append(track, el.speedFill);
    this._append(el.speed, el.speedValue, unit, el.speedState, track);
    this._append(el.root, el.speed);

    el.alloy = mk('div', 'hud-alloy', 'hud-alloy');
    el.alloyValue = mk('span', 'hud-alloy-value', 'hud-alloy-value');
    const alloyUnit = mk('span', 'hud-alloy-unit', 'hud-alloy-unit');
    if (alloyUnit) alloyUnit.textContent = '合金';
    this._append(el.alloy, el.alloyValue, alloyUnit);
    this._append(el.root, el.alloy);

    el.combo = mk('div', 'hud-combo', 'hud-combo');
    el.comboValue = mk('span', 'hud-combo-value', 'hud-combo-value');
    el.comboLabel = mk('span', 'hud-combo-label', 'hud-combo-label');
    if (el.comboLabel) el.comboLabel.textContent = '连杀';
    this._append(el.combo, el.comboValue, el.comboLabel);
    this._append(el.root, el.combo);
  }

  _buildPools(mk) {
    const el = this.el;

    // 提示条池：固定 8 个节点，复用最旧槽位（先摘后挂，节点数不变）。
    el.toasts = mk('div', 'hud-toasts', 'hud-toasts');
    for (let i = 0; i < POOL_TOAST; i++) {
      const box = mk('div', 'hud-toast-' + i, 'hud-toast');
      const title = mk('span', 'hud-toast-' + i + '-title', 'hud-toast-title');
      const sub = mk('span', 'hud-toast-' + i + '-sub', 'hud-toast-sub');
      this._append(box, title, sub);
      this._append(el.toasts, box);
      this._toasts.push({ el: box, title, sub, t: 0, life: TOAST_LIFE, on: false, kind: '' });
    }
    this._append(el.root, el.toasts);

    // 击杀播报池
    el.killfeed = mk('div', 'hud-killfeed', 'hud-killfeed');
    for (let i = 0; i < POOL_KILL; i++) {
      const box = mk('div', 'hud-kill-' + i, 'hud-kill');
      const text = mk('span', 'hud-kill-' + i + '-text', 'hud-kill-text');
      this._append(box, text);
      this._append(el.killfeed, box);
      this._kills.push({ el: box, text, t: 0, life: KILL_LIFE, on: false, kind: '' });
    }
    this._append(el.root, el.killfeed);

    // 伤害数字池（浮动 + 淡出）
    el.damageLayer = mk('div', 'hud-damage-numbers', 'hud-damage-layer');
    for (let i = 0; i < POOL_DAMAGE; i++) {
      const box = mk('div', 'hud-dmg-' + i, 'hud-dmg');
      this._append(el.damageLayer, box);
      this._dmg.push({ el: box, x: 0, y: 0, vx: 0, vy: 0, t: 0, life: DMG_LIFE, on: false, head: false });
    }
    this._append(el.root, el.damageLayer);

    // 最近命中敌人的护盾/生命双条；位置每帧只通过 transform 更新。
    el.enemyVitalsLayer = mk('div', 'hud-enemy-vitals', 'hud-enemy-vitals-layer');
    for (let i = 0; i < POOL_ENEMY_VITAL; i++) {
      const box = mk('div', 'hud-enemy-vital-' + i, 'hud-enemy-vital');
      const shieldTrack = mk('i', 'hud-enemy-vital-' + i + '-shield', 'hud-enemy-vital-track hud-enemy-vital-track--shield');
      const shieldFill = mk('b', 'hud-enemy-vital-' + i + '-shield-fill', 'hud-enemy-vital-fill');
      const healthTrack = mk('i', 'hud-enemy-vital-' + i + '-health', 'hud-enemy-vital-track hud-enemy-vital-track--health');
      const healthFill = mk('b', 'hud-enemy-vital-' + i + '-health-fill', 'hud-enemy-vital-fill');
      this._append(shieldTrack, shieldFill);
      this._append(healthTrack, healthFill);
      this._append(box, shieldTrack, healthTrack);
      this._append(el.enemyVitalsLayer, box);
      this._enemyVitals.push({
        el: box, shieldTrack, shieldFill, healthFill,
        enemy: null, lastHitAt: -99, occludedSince: null,
        anchor: new Float32Array(3), on: false,
      });
    }
    this._append(el.root, el.enemyVitalsLayer);

    // 交互提示
    el.prompt = mk('div', 'hud-prompt', 'hud-prompt');
    el.promptText = mk('span', 'hud-prompt-text', 'hud-prompt-text');
    this._append(el.prompt, el.promptText);
    this._append(el.root, el.prompt);
  }

  _buildDebug(mk) {
    const el = this.el;
    el.debug = mk('div', 'hud-debug', 'hud-debug');
    const head = mk('div', 'hud-debug-head', 'hud-debug-head');
    const title = mk('span', 'hud-debug-title', 'hud-debug-title');
    const hint = mk('span', 'hud-debug-hint', 'hud-debug-hint');
    if (title) title.textContent = 'DEBUG';
    if (hint) hint.textContent = 'F3';
    this._append(head, title, hint);
    this._append(el.debug, head);

    const rows = [
      ['fps', 'FPS'], ['frame', '帧时间'], ['draws', 'Draw Calls'], ['tris', '三角形'],
      ['entities', '实体数'], ['pos', '玩家坐标'], ['state', '运动状态'], ['errors', '捕获错误'],
    ];
    this._debugRows = Object.create(null);
    for (const r of rows) {
      const row = mk('div', 'hud-debug-row-' + r[0], 'hud-debug-row');
      const k = mk('span', 'hud-debug-k-' + r[0], 'hud-debug-k');
      const v = mk('span', 'hud-debug-' + r[0], 'hud-debug-v');
      if (k) k.textContent = r[1];
      this._append(row, k, v);
      this._append(el.debug, row);
      this._debugRows[r[0]] = v;
    }
    this._append(el.root, el.debug);
  }

  _buildUpgrade(mk) {
    const el = this.el;
    el.upgrade = mk('section', 'hud-upgrade', 'hud-upgrade');
    const head = mk('header', 'hud-upgrade-head', 'hud-upgrade-head');
    const t = mk('div', 'hud-upgrade-title', 'hud-upgrade-title');
    const s = mk('div', 'hud-upgrade-sub', 'hud-upgrade-sub');
    const alloyTag = mk('div', 'hud-upgrade-alloy', 'hud-upgrade-alloy');
    el.upgradeAlloy = mk('b', 'hud-upgrade-alloy-value', 'hud-upgrade-alloy-value');
    const alloyUnit = mk('span', 'hud-upgrade-alloy-unit', 'hud-upgrade-alloy-unit');
    if (t) t.textContent = '选择强化';
    if (s) s.textContent = 'SELECT AUGMENT';
    if (alloyUnit) alloyUnit.textContent = '合金';
    this._append(alloyTag, el.upgradeAlloy, alloyUnit);
    this._append(head, t, s, alloyTag);

    el.upgradeCards = mk('div', 'hud-upgrade-cards', 'hud-upgrade-cards');
    this._offerCards = [];
    for (let i = 0; i < POOL_OFFER; i++) {
      const card = mk('button', 'hud-upgrade-card-' + i, 'hud-offer');
      const rarity = mk('span', 'hud-offer-rarity-' + i, 'hud-offer-rarity');
      const name = mk('span', 'hud-offer-name-' + i, 'hud-offer-name');
      const desc = mk('span', 'hud-offer-desc-' + i, 'hud-offer-desc');
      const synergy = mk('span', 'hud-offer-synergy-' + i, 'hud-offer-synergy');
      const price = mk('span', 'hud-offer-price-' + i, 'hud-offer-price');
      const key = mk('span', 'hud-offer-key-' + i, 'hud-offer-key');
      if (key) key.textContent = String(i + 1);
      this._append(card, rarity, name, desc, synergy, price, key);
      this._append(el.upgradeCards, card);
      this._offerCards.push({ el: card, rarity, name, desc, synergy, price, key });
    }
    el.upgradeEmpty = mk('div', 'hud-upgrade-empty', 'hud-upgrade-empty');
    if (el.upgradeEmpty) el.upgradeEmpty.textContent = '暂无可用强化 · 继续战斗';

    const foot = mk('footer', 'hud-upgrade-foot', 'hud-upgrade-foot');
    el.upgradeReroll = mk('button', 'hud-upgrade-reroll', 'hud-upgrade-reroll');
    el.upgradeSkip = mk('button', 'hud-upgrade-skip', 'hud-upgrade-skip');
    el.upgradeHint = mk('span', 'hud-upgrade-hint', 'hud-upgrade-hint');
    if (el.upgradeReroll) el.upgradeReroll.textContent = '刷新 (R)';
    if (el.upgradeSkip) el.upgradeSkip.textContent = '跳过并继续 (Esc)';
    if (el.upgradeHint) el.upgradeHint.textContent = '1 / 2 / 3 选择 · ←→ 高亮 · Enter 确认 · R 刷新';
    this._append(foot, el.upgradeReroll, el.upgradeSkip, el.upgradeHint);
    this._append(el.upgrade, head, el.upgradeCards, el.upgradeEmpty, foot);
    this._append(el.root, el.upgrade);

    for (let i = 0; i < POOL_OFFER; i++) {
      const idx = i;
      this._bind(this._offerCards[i].el, 'click', () => this._pickOffer(idx));
      this._bind(this._offerCards[i].el, 'mouseenter', () => this._setOfferIndex(idx));
    }
    this._bind(el.upgradeReroll, 'click', () => {
      this._sfx('ui_click');
      this._intent('reroll_upgrade', { alloy: this._currentAlloy() });
    });
    this._bind(el.upgradeSkip, 'click', () => {
      this._sfx('ui_click');
      this._intent('skip_upgrade', {});
    });
  }

  _buildMenus(mk) {
    const el = this.el;
    el.menuOverlay = mk('div', 'menu-overlay', 'menu-overlay');
    this._append(el.menuOverlay, mk('div', 'menu-backdrop', 'menu-backdrop'));
    this._append(el.menuOverlay, mk('div', 'menu-scan', 'menu-scan'));
    this._menuPanels = Object.create(null);

    for (const kind of Object.keys(MENU_SPEC)) {
      const spec = MENU_SPEC[kind];
      const panel = mk('section', 'menu-' + kind, 'menu-panel menu-panel--' + kind);
      if (panel && panel.setAttribute) panel.setAttribute('data-menu', kind);
      const inner = mk('div', 'menu-' + kind + '-inner', 'menu-panel-inner');

      const head = mk('header', 'menu-' + kind + '-head', 'menu-head');
      const tag = mk('div', 'menu-' + kind + '-tag', 'menu-tag');
      const title = mk('h1', 'menu-' + kind + '-title', 'menu-title');
      const sub = mk('div', 'menu-' + kind + '-sub', 'menu-sub');
      const note = mk('p', 'menu-' + kind + '-note', 'menu-note');
      if (tag) tag.textContent = spec.tag;
      if (title) title.textContent = spec.title;
      if (sub) sub.textContent = spec.sub;
      if (note) note.textContent = spec.note || '';
      // 动态文本元素登记到 el 索引，render/_paintMenu 才能按 id 找到它们
      el['menu-' + kind + '-title'] = title;
      el['menu-' + kind + '-sub'] = sub;
      el['menu-' + kind + '-note'] = note;
      this._append(head, tag, title, sub, note);

      // 阵亡 / 撤离结算统计
      if (spec.stats) {
        const stats = mk('div', 'menu-' + kind + '-stats', 'menu-stats');
        for (const row of STAT_ROWS) {
          const line = mk('div', 'menu-' + kind + '-row-' + row[0], 'menu-stat');
          const k = mk('span', 'menu-' + kind + '-key-' + row[0], 'menu-stat-k');
          const v = mk('span', 'menu-' + kind + '-stat-' + row[0], 'menu-stat-v');
          if (k) k.textContent = row[1];
          el['menu-' + kind + '-stat-' + row[0]] = v;
          this._append(line, k, v);
          this._append(stats, line);
        }
        this._append(inner, head, stats);
      } else {
        this._append(inner, head);
      }

      // 设置面板
      if (spec.settings) {
        const body = mk('div', 'menu-settings-body', 'menu-settings-body');
        for (const cfgItem of SETTINGS_SPEC) {
          const row = mk('div', 'menu-settings-row-' + cfgItem.id, 'menu-setting');
          const label = mk('label', 'menu-settings-label-' + cfgItem.id, 'menu-setting-label');
          if (label) {
            label.textContent = cfgItem.label;
            if (label.setAttribute) label.setAttribute('for', 'menu-settings-input-' + cfgItem.id);
          }
          const control = this._buildSettingControl(mk, cfgItem);
          const value = mk('span', 'menu-settings-value-' + cfgItem.id, 'menu-setting-value');
          this._append(row, label, control, value);
          this._append(body, row);
          el['set-row-' + cfgItem.id] = row;
          el['set-input-' + cfgItem.id] = control;
          el['set-value-' + cfgItem.id] = value;
        }
        this._append(inner, body);
      }

      // 键位表
      if (spec.keymap) {
        const body = mk('div', 'menu-help-body', 'menu-help-body');
        for (let i = 0; i < KEYMAP.length; i++) {
          const row = mk('div', 'menu-help-row-' + i, 'menu-help-row');
          const k = mk('span', 'menu-help-key-' + i, 'menu-help-key');
          const d = mk('span', 'menu-help-desc-' + i, 'menu-help-desc');
          if (k) k.textContent = KEYMAP[i][1];
          if (d) d.textContent = KEYMAP[i][0];
          this._append(row, k, d);
          this._append(body, row);
        }
        this._append(inner, body);
      }

      // 远征简报（剧情背景 + 本局任务）：正文由 setBriefing() 注入
      if (spec.briefing) {
        const body = mk('div', 'menu-' + kind + '-body', 'menu-briefing-body');
        const world = mk('div', 'menu-' + kind + '-world', 'menu-briefing-world');
        const mission = mk('div', 'menu-' + kind + '-mission', 'menu-briefing-mission');
        const meta = mk('div', 'menu-' + kind + '-meta', 'menu-briefing-meta');
        this._append(body, world, mission, meta);
        this._append(inner, body);
        el['menu-' + kind + '-world'] = world;
        el['menu-' + kind + '-mission'] = mission;
        el['menu-' + kind + '-meta'] = meta;
      }

      // 制作名单（静态）
      if (spec.credits) {
        const body = mk('div', 'menu-' + kind + '-body', 'menu-credits-body');
        for (const line of CREDITS_LINES) {
          const row = mk('div', 'menu-' + kind + '-row-' + line[0], 'menu-credits-row');
          const k = mk('span', 'menu-' + kind + '-k-' + line[0], 'menu-credits-k');
          const v = mk('span', 'menu-' + kind + '-v-' + line[0], 'menu-credits-v');
          if (k) k.textContent = line[0];
          if (v) v.textContent = line[1];
          this._append(row, k, v);
          this._append(body, row);
        }
        this._append(inner, body);
      }

      // 菜单项
      const list = mk('nav', 'menu-' + kind + '-list', 'menu-list');
      const items = [];
      for (let i = 0; i < spec.items.length; i++) {
        const it = spec.items[i];
        const btn = mk('button', 'menu-' + kind + '-item-' + i, 'menu-item');
        if (it.primary) btn.classList.add('menu-item--primary');
        if (it.danger) btn.classList.add('menu-item--danger');
        const key = mk('span', 'menu-' + kind + '-item-' + i + '-key', 'menu-item-key');
        const label = mk('span', 'menu-' + kind + '-item-' + i + '-label', 'menu-item-label');
        const isub = mk('span', 'menu-' + kind + '-item-' + i + '-sub', 'menu-item-sub');
        if (key) key.textContent = it.key;
        if (label) label.textContent = it.label;
        if (isub) isub.textContent = it.sub;
        this._append(btn, key, label, isub);
        this._append(list, btn);
        const entry = { el: btn, spec: it, index: i, label, sub: isub };
        items.push(entry);
        this._bind(btn, 'click', () => this._activate({ type: 'item', item: it }));
        this._bind(btn, 'mouseenter', () => this._navToElement(btn));
      }
      this._menuItems[kind] = items;

      const foot = mk('footer', 'menu-' + kind + '-foot', 'menu-foot');
      if (foot) foot.textContent = '↑ ↓ 选择 · Enter 确认 · Esc 返回';
      this._append(inner, list, foot);
      this._append(panel, mk('div', 'menu-' + kind + '-frame', 'menu-panel-frame'), inner);
      this._append(el.menuOverlay, panel);
      this._menuPanels[kind] = panel;
    }

    this._append(el.root, el.menuOverlay);
    this._bind(this.doc, 'keydown', (e) => this._onKeyDown(e));
  }

  _buildSettingControl(mk, spec) {
    if (spec.type === 'range') {
      const input = mk('input', 'menu-settings-input-' + spec.id, 'menu-setting-range');
      if (input) {
        input.type = 'range';
        input.min = String(spec.min);
        input.max = String(spec.max);
        input.step = String(spec.step);
        if (input.setAttribute) {
          input.setAttribute('type', 'range');
          input.setAttribute('min', String(spec.min));
          input.setAttribute('max', String(spec.max));
          input.setAttribute('step', String(spec.step));
        }
      }
      this._bind(input, 'input', () => {
        const v = num(input && input.value, spec.def);
        this.settings[spec.id] = v;
        this._text(this.el['set-value-' + spec.id], this._fmtSetting(spec, v));
        this._intent(spec.intent, { value: v, id: spec.id });
      });
      return input;
    }
    if (spec.type === 'toggle') {
      const input = mk('input', 'menu-settings-input-' + spec.id, 'menu-setting-toggle');
      if (input) {
        input.type = 'checkbox';
        if (input.setAttribute) input.setAttribute('type', 'checkbox');
      }
      this._bind(input, 'change', () => {
        const v = !!(input && input.checked);
        this.settings[spec.id] = v;
        this._text(this.el['set-value-' + spec.id], this._fmtSetting(spec, v));
        this._intent(spec.intent, { value: v, id: spec.id });
      });
      return input;
    }
    const select = mk('select', 'menu-settings-input-' + spec.id, 'menu-setting-select');
    const opts = (spec.options || []);
    for (let i = 0; i < opts.length; i++) {
      const o = mk('option', 'menu-settings-option-' + spec.id + '-' + i, 'menu-setting-option');
      if (o) {
        o.value = String(opts[i][0]);
        o.textContent = String(opts[i][1]);
      }
      this._append(select, o);
    }
    this._bind(select, 'change', () => {
      const raw = select && select.value;
      const v = spec.id === 'fpsCap' ? num(raw, 0) : String(raw);
      this.settings[spec.id] = v;
      this._text(this.el['set-value-' + spec.id], this._fmtSetting(spec, v));
      this._intent(spec.intent, { value: v, id: spec.id });
    });
    return select;
  }

  _fmtSetting(spec, v) {
    if (spec.type === 'toggle') return v ? '开' : '关';
    if (spec.id === 'sensitivity') return num(v, 0.0012).toFixed(5);
    if (spec.id === 'sniperSensitivity') return Math.round(num(v, 0.35) * 100) + '%';
    if (spec.type === 'select') {
      const opts = spec.options || [];
      for (const o of opts) if (String(o[0]) === String(v)) return o[1];
      return String(v);
    }
    const step = num(spec.step, 1);
    if (step >= 1) return String(Math.round(num(v, 0)));
    return num(v, 0).toFixed(step < 0.05 ? 2 : 1);
  }

  _buildLoading(mk) {
    const el = this.el;
    const doc = this.doc;
    let overlay = null;
    if (doc && typeof doc.getElementById === 'function') {
      try { overlay = doc.getElementById('load-overlay'); } catch (e) { overlay = null; }
    }
    if (!overlay && this.root && typeof this.root.querySelector === 'function') {
      overlay = this.root.querySelector('#load-overlay');
    }
    this._ownsLoading = false;
    if (!overlay) {
      overlay = mk('div', 'load-overlay', 'load-overlay');
      this._ownsLoading = true;
    }
    el.loadOverlay = overlay;

    // index.html 里的静态遮罩结构可能不同：找到就复用，找不到就补建。
    const find = (sel, tag, id, cls) => {
      let n = null;
      if (overlay && typeof overlay.querySelector === 'function') n = overlay.querySelector(sel);
      if (!n) {
        n = mk(tag, id, cls);
        this._append(overlay, n);
      } else if (n.classList) {
        n.classList.add(cls);
      }
      return n;
    };
    el.loadFrame = find('#load-frame', 'div', 'load-frame', 'load-frame');
    el.loadTitle = find('#load-title', 'div', 'load-title', 'load-title');
    el.loadText = find('#load-text', 'div', 'load-text', 'load-text');
    el.loadTrack = find('#load-track', 'div', 'load-track', 'load-track');
    el.loadBar = find('#load-bar', 'i', 'load-bar', 'load-bar');
    el.loadPct = find('#load-pct', 'div', 'load-pct', 'load-pct');
    if (el.loadTitle && !el.loadTitle.textContent) el.loadTitle.textContent = '钢铁远征';
    if (el.loadText && !el.loadText.textContent) el.loadText.textContent = '正在装载熔炉世界…';
    if (el.loadPct && !el.loadPct.textContent) el.loadPct.textContent = '0%';
    this._append(el.loadTrack, el.loadBar);
    this._append(el.loadFrame, el.loadTitle, el.loadText, el.loadTrack, el.loadPct);
    if (this._ownsLoading) this._append(this.root, overlay);
  }

  // ── DOM 写入原语（全部带变更检测缓存） ────────────────────────────────────
  /** 文本缓存：键 = 元素 id；值相同则完全不碰 DOM。 */
  _text(el, value) {
    if (!el) return;
    const v = value == null ? '' : String(value);
    const key = el.id || 'anon';
    if (this._cache[key] === v) return;
    this._cache[key] = v;
    el.textContent = v;
  }

  /** 样式缓存：键 = 元素 id + 属性名。用于条填充、准心开合、进度环旋转等。 */
  _style(el, prop, value) {
    if (!el || !el.style) return;
    const v = String(value);
    const key = (el.id || 'anon') + '|' + prop;
    if (this._styleCache[key] === v) return;
    this._styleCache[key] = v;
    if (typeof el.style.setProperty === 'function') el.style.setProperty(prop, v);
    else el.style[prop] = v;
  }

  /** class 切换：以 classList 自身为准（contains 足够便宜，无需缓存）。 */
  _cls(el, cls, on) {
    if (!el || !el.classList) return;
    if (on) {
      if (!el.classList.contains(cls)) el.classList.add(cls);
    } else if (el.classList.contains(cls)) {
      el.classList.remove(cls);
    }
  }

  _bind(target, type, fn) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn);
    this._listeners.push({ target, type, fn });
  }

  _intent(name, payload) {
    const cb = this.onIntent;
    if (typeof cb !== 'function') return;
    try { cb(name, payload); } catch (err) { this._recordError(err); }
  }

  _sfx(name) {
    const a = this.ctx && this.ctx.audio;
    if (!a || typeof a.play !== 'function') return;
    try { a.play(name, { bus: 'ui' }); } catch (err) { /* 音频不可用不影响 UI */ }
  }

  _recordError(err) {
    const msg = err && err.message ? err.message : String(err);
    this.lastError = msg;
    this._errors.push({ message: msg, time: this._time });
    while (this._errors.length > 5) this._errors.shift();
  }

  // ── 更新（计时 / 池寿命；不写布局） ───────────────────────────────────────
  update(dt) {
    if (!this._built || this._disposed) return;
    try {
      // 单帧最多补偿 5 秒：切标签页回来时 dt 可能是几十秒，
      // 池寿命/连杀/撤离倒计时必须能一次走完，而不是被钳到几帧里慢慢耗。
      const d = clamp(num(dt, 0), 0, 5);
      this._time += d;

      // 帧率：优先用 game 提供的 stats，否则自行指数平均。
      if (d > 0) {
        const ms = d * 1000;
        this._frameMs = this._frameMs < 0 ? ms : this._frameMs + (ms - this._frameMs) * 0.08;
        this._fps = this._frameMs > 0 ? 1000 / this._frameMs : 0;
      }

      // 命中标记 / 准心闪光
      if (this._hm) {
        this._hm.t += d;
        if (this._hm.t >= this._hmTime) this._hm = null;
      }
      if (this._crossFlash > 0) this._crossFlash = Math.max(0, this._crossFlash - d);

      // 连杀计时
      if (this._combo > 0) {
        this._comboTimer -= d;
        if (this._comboTimer <= 0) {
          this._combo = 0;
          this._comboTimer = 0;
        }
      }

      // 伤害数字：上抛 + 淡出
      for (let i = 0; i < this._dmg.length; i++) {
        const s = this._dmg[i];
        if (!s.on) continue;
        s.t += d;
        if (s.t >= s.life) { s.on = false; continue; }
        s.vy += 280 * d;
        s.x += s.vx * d;
        s.y += s.vy * d;
      }

      // 击杀播报 / 提示条寿命
      for (let i = 0; i < this._kills.length; i++) {
        const s = this._kills[i];
        if (!s.on) continue;
        s.t += d;
        if (s.t >= s.life) { s.on = false; this._cls(s.el, 'hud-kill--on', false); }
      }
      for (let i = 0; i < this._toasts.length; i++) {
        const s = this._toasts[i];
        if (!s.on) continue;
        s.t += d;
        if (s.t >= s.life) { s.on = false; this._cls(s.el, 'hud-toast--on', false); }
      }

      // 撤离倒计时本地自走（game 再次调用 setExtraction 时会重新对齐）
      if (this._extract !== null) {
        this._extract = Math.max(0, this._extract - d);
      }

      // 采样节流：调试面板与 viewport 尺寸每 0.15s 更新一次即可。
      this._debugAccum += d;
      if (this._debugAccum >= 0.15) {
        this._debugAccum = 0;
        this._debugSample = true;   // 允许下一帧 render() 刷新调试文本
        const changed = this._refreshRect();
        if (changed) this._compassSig = '';
      }
    } catch (err) {
      this._recordError(err);
    }
  }

  _refreshRect() {
    const r = this.root;
    if (!r || typeof r.getBoundingClientRect !== 'function') return false;
    try {
      const b = r.getBoundingClientRect();
      if (b && num(b.width, 0) > 0 && num(b.height, 0) > 0) {
        const changed = b.width !== this._rect.w || b.height !== this._rect.h;
        this._rect.w = b.width;
        this._rect.h = b.height;
        return changed;
      }
    } catch (err) { /* 无头环境下忽略 */ }
    return false;
  }

  // ── 渲染（只写 textContent / style / classList） ──────────────────────────
  render() {
    if (!this._built || this._disposed) return;
    try {
      this._renderCrosshair();
      this._renderVitals();
      this._renderHealInventory();
      this._renderAmmo();
      this._renderSpeed();
      this._renderAbilities();
      this._renderObjective();
      this._renderExtraction();
      this._renderCounters();
      this._renderCompass();
      this._renderWaypoint();
      this._renderAdsOptic();
      this._renderHealWheel();
      this._renderPrompt();
      this._renderDamageNumbers();
      this._renderEnemyVitals();
      this._renderDebug();
    } catch (err) {
      this._recordError(err);
    }
  }

  _renderCrosshair() {
    const el = this.el;
    const w = this._weapons();
    const cur = w && w.current ? w.current : null;
    const spread = clamp(num(cur && cur.spread, 0), 0, 40);
    const gap = (4 + spread * 3.2) * this._xhair.scale;
    const hit = this._crossFlash > 0 || !!(this._hm && this._hm.kind && this._hm.kind !== 'normal');

    this._setCrosshairStyle();
    // 只改 transform：线条长度与粗细固定在 CSS 里，靠位移开合，避免布局抖动。
    this._style(el.chTop, 'transform', 'translate3d(-50%, ' + (-gap).toFixed(2) + 'px, 0)');
    this._style(el.chBottom, 'transform', 'translate3d(-50%, ' + gap.toFixed(2) + 'px, 0)');
    this._style(el.chLeft, 'transform', 'translate3d(' + (-gap).toFixed(2) + 'px, -50%, 0)');
    this._style(el.chRight, 'transform', 'translate3d(' + gap.toFixed(2) + 'px, -50%, 0)');
    this._cls(el.crosshair, 'hud-crosshair--wide', spread > 2.2);
    this._cls(el.crosshair, 'hud-crosshair--hit', hit);
    this._cls(el.crosshair, 'hud-crosshair--blocked', !!(cur && cur.reloading));

    // 命中标记：透明度按剩余寿命线性淡出
    if (el.hitmarker) {
      if (this._hm) {
        const k = clamp01(this._hm.t / this._hmTime);
        this._style(el.hitmarker, 'opacity', (1 - k).toFixed(3));
        this._style(el.hitmarker, 'transform', 'scale(' + (1 + k * 0.5).toFixed(3) + ')');
        this._cls(el.hitmarker, 'hud-hitmarker--on', true);
        this._cls(el.hitmarker, 'hud-hitmarker--headshot', this._hm.kind === 'headshot');
        this._cls(el.hitmarker, 'hud-hitmarker--kill', this._hm.kind === 'kill');
      } else {
        this._cls(el.hitmarker, 'hud-hitmarker--on', false);
        this._style(el.hitmarker, 'opacity', '0');
      }
    }
  }

  _setCrosshairStyle() {
    const el = this.el;
    const s = this._xhair;
    for (const k of ['default', 'dot', 'cross', 'circle', 'none']) {
      this._cls(el.crosshair, 'hud-crosshair--' + k, s.style === k);
    }
    this._style(el.crosshair, '--hud-xhair', s.color || 'var(--hud-cold)');
  }

  _renderVitals() {
    const el = this.el;
    const p = this._player();
    const maxHp = Math.max(1, num(p && p.maxHealth, num(p && p.maxHp, 100)));
    const maxSh = Math.max(1, num(p && p.maxShield, num(p && p.maxShieldHp, 100)));
    const hp = p ? clamp(num(p.health, maxHp), 0, maxHp) : maxHp;
    const sh = p ? clamp(num(p.shield, 0), 0, maxSh) : 0;
    const hk = hp / maxHp;
    const sk = sh / maxSh;

    this._style(el.healthFill, 'transform', 'scaleX(' + hk.toFixed(3) + ')');
    this._style(el.shieldFill, 'transform', 'scaleX(' + sk.toFixed(3) + ')');
    const shieldSegments = Math.max(1, Math.ceil(maxSh / 25));
    this._style(el.shield, '--hud-shield-segments', String(shieldSegments));
    this._style(el.shield, '--hud-shield-segment-width', `${(100 / shieldSegments).toFixed(4)}%`);
    this._text(el.healthText, `生命 ${Math.round(hp)} / ${Math.round(maxHp)} · 护盾 ${Math.round(sh)} / ${Math.round(maxSh)}`);
    this._cls(el.health, 'hud-health--critical', hk < 0.3 && hk > 0);
    this._cls(el.health, 'hud-health--dead', hk <= 0);
    this._cls(el.shield, 'hud-shield--on', sk > 0.001);
    this._cls(el.shield, 'hud-shield--low', sk > 0.001 && sk < 0.3);
  }

  _renderHealInventory() {
    const el = this.el;
    if (!el.healInventory || !this._healInventorySlots) return;
    const h = this.ctx && this.ctx.healing;
    const selected = h ? Math.max(0, Math.min(this._healInventorySlots.length - 1, h.selection | 0)) : 0;
    for (let i = 0; i < this._healInventorySlots.length; i++) {
      const s = this._healInventorySlots[i];
      this._cls(s.item, 'hud-heal-inventory-item--selected', i === selected);
      const raw = h ? h[s.key] : 0;
      const n = Number(raw);
      const label = raw === Infinity || !Number.isFinite(n) ? '∞' : String(Math.max(0, Math.floor(n)));
      this._text(s.count, label);
      this._cls(s.item, 'hud-heal-inventory-item--empty', label === '0');
    }
    const active = !!(h && h.useActive);
    const prog = active ? clamp01(num(h.useT, 0) / Math.max(0.01, num(h.useDuration, 1))) : 0;
    this._cls(el.healUse, 'hud-heal-use--on', active);
    this._style(el.healUseFill, 'transform', 'scaleX(' + prog.toFixed(3) + ')');
    const useLabels = ['医疗包使用中…', '护盾电池充能中…', '注射中…', '小型护盾充能中…'];
    this._text(el.healUseText, active ? (useLabels[h.useItem | 0] || '恢复中…') : '');
  }

  _renderAmmo() {
    const el = this.el;
    const w = this._weapons();
    const cur = w && w.current ? w.current : null;
    const def = cur && cur.def ? cur.def : null;

    if (!cur) {
      this._style(el.ammoLine, 'display', '');
      this._text(el.ammoCurrent, '--');
      this._text(el.ammoReserve, '--');
      this._text(el.weaponName, '未装备武器');
      this._cls(el.ammo, 'hud-ammo--empty', false);
      this._cls(el.ammo, 'hud-ammo--low', false);
      this._cls(el.reload, 'hud-reload--on', false);
      this._cls(el.charge, 'hud-charge--on', false);
      this._style(el.chargeFill, 'transform', 'scaleX(0)');
      this._style(el.reloadArcR, 'transform', 'rotate(0deg)');
      this._style(el.reloadArcL, 'transform', 'rotate(0deg)');
      return;
    }

    if (def && def.class === 'melee') {
      const knife = !!(cur.attachments && cur.attachments.melee === 'tactical_knife');
      this._text(el.weaponName, knife ? '战术刀' : '双拳');
      this._text(el.ammoCurrent, '');
      this._text(el.ammoReserve, '');
      this._style(el.ammoLine, 'display', 'none');
      this._cls(el.ammo, 'hud-ammo--low', false);
      this._cls(el.ammo, 'hud-ammo--empty', false);
      this._cls(el.ammo, 'hud-ammo--reloading', false);
      this._cls(el.reload, 'hud-reload--on', false);
      this._cls(el.charge, 'hud-charge--on', false);
      return;
    }
    this._style(el.ammoLine, 'display', '');

    const ammo = Math.max(0, Math.round(num(cur.ammo, 0)));
    const reserveRaw = cur.reserve;
    const reserveInfinite = reserveRaw === Infinity;
    const reserveNumber = Number(reserveRaw);
    const reserve = reserveInfinite ? Infinity
      : (Number.isFinite(reserveNumber) ? Math.max(0, Math.round(reserveNumber)) : 0);
    const mag = Math.max(1, Math.round(num(cur.magSize, num(def && def.magSize, 20))));
    const reloading = !!cur.reloading;
    const progress = clamp01(num(cur.reloadProgress, 0));

    this._text(el.ammoCurrent, String(ammo));
    this._text(el.ammoReserve, reserveInfinite ? '∞' : String(reserve));
    this._text(el.weaponName, (def && (def.nameCN || def.name)) || '未知武器');
    this._cls(el.ammo, 'hud-ammo--low', !reloading && ammo > 0 && ammo <= Math.max(1, Math.round(mag * 0.25)));
    this._cls(el.ammo, 'hud-ammo--empty', !reloading && ammo === 0);
    this._cls(el.ammo, 'hud-ammo--reloading', reloading);

    const chargeable = !!(def && def.chargeTime > 0);
    const chargeProgress = clamp01(num(cur.chargeProgress, 0));
    const chargeReady = !!cur.chargeReady;
    const charging = !!cur.charging;
    const chargeShots = Math.max(0, Math.floor(num(cur.chargeShotsRemaining, 0)));
    this._cls(el.charge, 'hud-charge--on', chargeable);
    this._cls(el.charge, 'hud-charge--ready', chargeable && chargeReady);
    this._cls(el.charge, 'hud-charge--charging', chargeable && charging);
    this._style(el.chargeFill, 'transform', 'scaleX(' + chargeProgress.toFixed(3) + ')');
    this._text(el.chargeLabel, chargeable
      ? (chargeReady ? `整匣强化 · 剩余 ${chargeShots} 发`
        : (charging ? '充能中…' : '按一下 B 充能整匣')) : '');

    // 换弹提示 + 进度环
    let tip = '';
    if (reloading) tip = '换弹中…';
    else if (ammo === 0 && (reserveInfinite || reserve > 0)) tip = '按 R 换弹';
    else if (ammo === 0) tip = '弹药耗尽';
    this._text(el.reloadText, tip);
    this._cls(el.reload, 'hud-reload--on', !!tip);
    this._cls(el.reload, 'hud-reload--running', reloading);
    if (reloading) {
      // 半个圆 + 同一个旋转角：右半圈负责 0~50%，左半圈负责 50~100%。
      const deg = progress * 360 - 495;
      const rot = 'rotate(' + deg.toFixed(1) + 'deg)';
      this._style(el.reloadArcR, 'transform', rot);
      this._style(el.reloadArcL, 'transform', rot);
    }
  }

  _renderSpeed() {
    const el = this.el;
    const p = this._player();
    let speed = 0;
    if (p) {
      const st = p.state || {};
      speed = num(st.speed, NaN);
      if (!Number.isFinite(speed)) {
        const v = p.vel;
        speed = v ? Math.sqrt(num(v[0]) * num(v[0]) + num(v[1]) * num(v[1]) + num(v[2]) * num(v[2])) : 0;
      }
      speed = clamp(num(speed, 0), 0, 999);
    }
    const chip = this._stateChip(p);
    this._text(el.speedValue, speed.toFixed(1));
    this._text(el.speedState, chip);
    this._style(el.speedFill, 'transform', 'scaleX(' + clamp01(speed / SPEED_FULL).toFixed(3) + ')');
    this._cls(el.speed, 'hud-speed--fast', speed > SPEED_FULL * 0.75);
    for (const s of STATE_CHIPS) this._cls(el.speed, 'hud-speed--' + s.toLowerCase(), chip === s);
  }

  /** 状态 chip 永远是 STATE_CHIPS 中的一个值（契约要求「恰好一个」）。 */
  _stateChip(p) {
    if (!p) return 'GROUNDED';
    const st = p.state || {};
    if (st.dashing) return 'DASH';
    if (st.mantling) return 'MANTLE';
    if (st.grappleActive) return 'GRAPPLE';
    if (st.wallRunning || st.wallClimbing) return 'WALLRUN';
    if (st.sliding) return 'SLIDE';
    if (st.grounded === false) return 'AIR';
    return 'GROUNDED';
  }

  _renderAbilities() {
    const p = this._player();
    const st = (p && p.state) || {};

    // 冲刺：按剩余次数/冷却恢复比例填充
    const charges = Math.max(0, num(st.dashCharges, num(p && p.dashCharges, 0)));
    const dashMax = Math.max(1, num(st.dashMaxCharges, num(p && p.dashMaxCharges, 1)));
    const dashCd = Math.max(0, num(st.dashCooldownLeft, num(p && p.dashCooldownLeft, 0)));
    const dashCdMax = Math.max(0.001, num(st.dashCooldown, num(p && p.dashCooldownMax, 0.9)));
    const dashK = charges > 0 ? 1 : clamp01(1 - dashCd / dashCdMax);
    this._abilityView('dash', p ? dashK : 0, p ? (charges > 0 ? 'READY' : dashCd.toFixed(1) + 's') : '--', p ? charges + '/' + dashMax : '--');

    // 抓钩
    const gActive = !!st.grappleActive;
    const gCd = Math.max(0, num(st.grappleCooldownLeft, num(p && p.grappleCooldownLeft, 0)));
    const gCdMax = Math.max(0.001, num(st.grappleCooldown, num(p && p.grappleCooldownMax, 2.4)));
    const gReady = !gActive && gCd <= 0.0001;
    const gK = gActive ? 1 : (gReady ? 1 : clamp01(1 - gCd / gCdMax));
    this._abilityView('grapple', p ? gK : 0, p ? (gActive ? 'ACTIVE' : (gReady ? 'READY' : gCd.toFixed(1) + 's')) : '--', '抓钩');

    // 二段跳：地面或还有空中次数即 READY
    const airJumps = Math.max(0, num(st.airJumps, num(p && p.airJumps, 0)));
    const jumpMax = Math.max(1, num(st.maxAirJumps, num(p && p.maxAirJumps, 1)));
    const grounded = st.grounded !== false;
    const jReady = !p || grounded || airJumps > 0;
    this._abilityView('jump', p ? (jReady ? 1 : 0) : 0, p ? (jReady ? 'READY' : 'EMPTY') : '--', p ? (grounded ? '地面' : airJumps + '/' + jumpMax) : '--');
  }

  _abilityView(key, k, label, sub) {
    const a = this._ability && this._ability[key];
    if (!a) return;
    this._style(a.fill, 'transform', 'scaleX(' + clamp01(k).toFixed(3) + ')');
    this._text(a.label, label);
    this._text(a.sub, sub === undefined ? '' : sub);
    this._cls(a.box, 'hud-ability--ready', label === 'READY');
    this._cls(a.box, 'hud-ability--cooling', label !== 'READY' && label !== '--');
  }

  _renderObjective() {
    const el = this.el;
    const o = this._objective || this._readObjective();
    if (!o || !o.label) {
      this._cls(el.objective, 'hud-objective--on', false);
      return;
    }
    const total = Math.max(1, num(o.total, 1));
    const done = clamp(num(o.done, 0), 0, total);
    this._cls(el.objective, 'hud-objective--on', true);
    this._text(el.objectiveLabel, o.label);
    this._text(el.objectiveText, done + ' / ' + total);
    this._style(el.objectiveFill, 'transform', 'scaleX(' + (done / total).toFixed(3) + ')');
    this._cls(el.objective, 'hud-objective--done', done >= total);
  }

  _readObjective() {
    const run = this.ctx && this.ctx.run;
    const o = run && (run.objective || run.currentObjective);
    if (o && typeof o === 'object') {
      return { label: o.label || o.name || '目标', done: num(o.done, num(o.progress, 0)), total: num(o.total, num(o.required, 1)) };
    }
    return null;
  }

  _renderExtraction() {
    const el = this.el;
    let secs = this._extract;
    if (secs === null || secs === undefined) {
      const run = this.ctx && this.ctx.run;
      const cand = run && (run.extractIn !== undefined ? run.extractIn : run.extractionTimer);
      if (Number.isFinite(cand)) secs = num(cand, 0);
    }
    if (secs === null || secs === undefined || !Number.isFinite(secs)) {
      this._cls(el.extraction, 'hud-extraction--on', false);
      this._extractShown = -1;
      return;
    }
    const shown = Math.ceil(Math.max(0, secs));
    this._cls(el.extraction, 'hud-extraction--on', true);
    if (this._extractShown !== shown) {
      this._extractShown = shown;
      this._text(el.extractionTime, fmtClock(shown));
    }
    this._text(el.extractionLabel, '撤离倒计时');
    this._cls(el.extraction, 'hud-extraction--urgent', shown <= 10);
  }

  _renderCounters() {
    const el = this.el;
    this._text(el.alloyValue, String(Math.max(0, Math.round(this._currentAlloy()))));
    this._cls(el.combo, 'hud-combo--on', this._combo >= 2);
    this._cls(el.combo, 'hud-combo--hot', this._combo >= 5);
    this._text(el.comboValue, String(this._combo));
    this._text(el.comboLabel, this._combo >= 5 ? '连杀 · 火力全开' : '连杀');
  }

  _currentAlloy() {
    if (this._alloy !== null) return this._alloy;
    const run = this.ctx && this.ctx.run;
    const c = this.ctx && this.ctx.upgrades;
    if (run && Number.isFinite(run.alloy)) return num(run.alloy, 0);
    if (c && Number.isFinite(c.alloy)) return num(c.alloy, 0);
    return 0;
  }

  // ── 罗盘（canvas 2D，唯一允许 canvas 的部件之一） ─────────────────────────
  _renderCompass() {
    const el = this.el;
    const canvas = el.compass;
    if (!canvas) return;
    if (!this._c2d) {
      if (typeof canvas.getContext !== 'function') return;
      try { this._c2d = canvas.getContext('2d'); } catch (err) { this._c2d = null; }
      if (!this._c2d) return;
    }
    const p = this._player();
    let yaw = p ? num(p.yaw, 0) : 0;
    const f = p && p.forward;
    if (f && Number.isFinite(num(f[0], NaN)) && Number.isFinite(num(f[2], NaN))) {
      yaw = Math.atan2(num(f[0], 0), -num(f[2], -1));
    }
    const camDeg = bearingDeg(Math.sin(yaw), -Math.cos(yaw));

    const w = Math.max(32, num(canvas.width, 360));
    const h = Math.max(8, num(canvas.height, 28));
    const obj = this._objectivePoint || this._readPoint('objective');
    const ext = this._extractPoint || this._readPoint('extract');
    const pos = p && p.pos ? p.pos : null;
    const objB = obj && pos ? bearingDeg(num(obj[0]) - num(pos[0]), num(obj[2]) - num(pos[2])) : NaN;
    const extB = ext && pos ? bearingDeg(num(ext[0]) - num(pos[0]), num(ext[2]) - num(pos[2])) : NaN;

    // 变更检测：朝向/方位/尺寸都没变就不重绘 canvas。
    const sig = camDeg.toFixed(1) + '|' + (Number.isFinite(objB) ? objB.toFixed(0) : '-') + '|' +
      (Number.isFinite(extB) ? extB.toFixed(0) : '-') + '|' + w + 'x' + h;
    if (this._compassSig === sig) return;
    this._compassSig = sig;

    const g = this._c2d;
    try {
      g.clearRect(0, 0, w, h);
      // 刻度：每 15° 一格，每 45° 加长
      for (let d = -COMPASS_FOV; d <= COMPASS_FOV; d += 15) {
        const rel = d;
        const x = w * 0.5 + (rel / (COMPASS_FOV * 0.5)) * (w * 0.5 - 6);
        if (x < 4 || x > w - 4) continue;
        const major = ((Math.round(camDeg) + d) % 45 + 45) % 45 === 0;
        g.fillStyle = major ? 'rgba(127,227,255,0.55)' : 'rgba(127,227,255,0.22)';
        g.fillRect(x, h * 0.5 - (major ? 8 : 4), 1, major ? 12 : 7);
      }
      // 方位角与目标/撤离方位
      const marks = [[objB, '#ffb03a'], [extB, '#7fe3ff']];
      for (const m of marks) {
        const b = m[0];
        if (!Number.isFinite(b)) continue;
        let rel = b - camDeg;
        while (rel > 180) rel -= 360;
        while (rel < -180) rel += 360;
        if (Math.abs(rel) > COMPASS_FOV * 0.5) continue;
        const x = w * 0.5 + (rel / (COMPASS_FOV * 0.5)) * (w * 0.5 - 6);
        g.fillStyle = m[1];
        g.beginPath();
        g.moveTo(x, h - 2);
        g.lineTo(x - 5, h - 10);
        g.lineTo(x + 5, h - 10);
        g.closePath();
        g.fill();
      }
      g.fillStyle = 'rgba(207,230,242,0.9)';
      g.fillRect(w * 0.5, 0, 1, h);
    } catch (err) {
      this._recordError(err);
    }

    // 文本方位（给自动化断言用，也方便玩家读）
    this._renderBearing(el.bearingObjective, '目标', objB, obj, pos, 'hud-bearing--none');
    this._renderBearing(el.bearingExtract, '撤离', extB, ext, pos, 'hud-bearing--none');
  }

  _renderBearing(el, tag, deg, point, pos, offCls) {
    if (!el) return;
    if (!Number.isFinite(deg)) {
      this._cls(el, offCls, true);
      this._text(el, tag + ' --');
      return;
    }
    this._cls(el, offCls, false);
    const d = dist2D(pos, point);
    const suffix = Number.isFinite(d) ? ' · ' + Math.round(d) + 'm' : '';
    this._text(el, tag + ' ' + pad3(deg) + '°' + suffix);
  }

  _readPoint(kind) {
    const c = this.ctx || {};
    const run = c.run;
    if (run) {
      try {
        // currentObjectivePoint() 在目标全部完成后会回退为撤离点；它只属于
        // “当前任务信标”，不能无条件用于 _readPoint('extract')，否则目标阶段
        // 顶部撤离方位会错误地与任务点重合。
        if (kind === 'objective' && typeof run.currentObjectivePoint === 'function') {
          const active = run.currentObjectivePoint();
          if (active && active.length >= 3) return active;
        }
      } catch (err) { /* 单局尚未开始 */ }
      if (kind === 'extract' && run.activeExtract && run.activeExtract.pos) {
        return run.activeExtract.pos;
      }
      const direct = kind === 'objective' ? (run.objectivePos || run.objectivePoint) : (run.extractPos || run.extractPoint);
      if (direct && direct.length >= 3) return direct;
    }
    const world = c.world;
    if (world) {
      try {
        if (kind === 'objective' && typeof world.objectives === 'function') {
          const list = world.objectives();
          if (list && list.length && list[0] && list[0].pos) return list[0].pos;
        }
        if (kind === 'extract' && typeof world.extractPoints === 'function') {
          const list = world.extractPoints();
          if (list && list.length && list[0] && list[0].pos) return list[0].pos;
        }
      } catch (err) { /* 世界尚未加载 */ }
    }
    return null;
  }

  /** 把当前任务点投影成始终可见的大号屏幕信标；离屏/背后时钉在边缘并显示箭头。 */
  _renderWaypoint() {
    const el = this.el;
    if (!el.waypoint) return;
    const c = this.ctx || {};
    const run = c.run;
    const p = this._player();
    const point = this._objectivePoint || this._readPoint('objective');
    if (!p || !point || !p.forward || !p.right || !p.up || !run) {
      this._cls(el.waypoint, 'hud-waypoint--on', false);
      return;
    }

    const phase = String(run.phase || '');
    const extracting = phase === 'extract_ready' || phase === 'extracting';
    const eye = p.eyePos || p.pos;
    if (!eye) { this._cls(el.waypoint, 'hud-waypoint--on', false); return; }
    const dx = num(point[0]) - num(eye[0]);
    const dy = num(point[1]) + (extracting ? 1.4 : 1.8) - num(eye[1]);
    const dz = num(point[2]) - num(eye[2]);
    const side = dx * num(p.right[0]) + dy * num(p.right[1]) + dz * num(p.right[2]);
    const up = dx * num(p.up[0]) + dy * num(p.up[1]) + dz * num(p.up[2]);
    const front = dx * num(p.forward[0]) + dy * num(p.forward[1]) + dz * num(p.forward[2]);
    const w = Math.max(320, this._rect.w);
    const h = Math.max(180, this._rect.h);
    const cfgFov = num(c.config && c.config.render && c.config.render.fovDeg, 100);
    let fov = cfgFov;
    try { if (typeof p.getFov === 'function') fov = num(p.getFov(cfgFov), cfgFov); } catch (err) { /* 忽略 */ }
    const tanV = Math.tan(clamp(fov, 45, 140) * Math.PI / 360) || 1;
    const aspect = w / h;
    let x;
    let y;
    let offscreen = front <= 0.15;
    if (!offscreen) {
      const nx = side / (front * tanV * aspect);
      const ny = up / (front * tanV);
      offscreen = Math.abs(nx) > 0.88 || Math.abs(ny) > 0.78;
      x = w * (0.5 + nx * 0.5);
      y = h * (0.5 - ny * 0.5);
    } else {
      x = side >= 0 ? w - 72 : 72;
      y = h * 0.52;
    }
    x = clamp(x, 72, w - 72);
    y = clamp(y, 100, h - 118);
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const label = extracting ? '撤离点' : (typeof run.currentObjectiveLabel === 'function'
      ? run.currentObjectiveLabel() : '任务地点');
    this._text(el.waypointIcon, offscreen ? (side >= 0 ? '▶' : '◀') : '◆');
    this._text(el.waypointLabel, label || '任务地点');
    this._text(el.waypointDistance, Math.round(d) + ' m');
    this._style(el.waypoint, 'transform', `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`);
    this._cls(el.waypoint, 'hud-waypoint--extract', extracting);
    this._cls(el.waypoint, 'hud-waypoint--offscreen', offscreen);
    this._cls(el.waypoint, 'hud-waypoint--on', true);
  }

  /**
   * ADS 辅助层：普通枪的镜框由 WebGL viewmodel 实际渲染，这里只锐化中心光点；
   * 狙击枪保留 4× 暗角/分划线。这样不会再出现一只与枪身脱离的 HUD 大圆环。
   */
  _renderAdsOptic() {
    const el = this.el;
    if (!el.ads) return;
    const w = this._weapons();
    const cur = w && w.current ? w.current : null;
    const t = clamp01(num(cur && (cur.adsProgress != null ? cur.adsProgress : cur.adsT), 0));
    const sniper = !!(cur && cur.def && cur.def.class === 'sniper');
    this._style(el.ads, 'opacity', t > 0.05 ? t.toFixed(3) : '0');
    this._cls(el.ads, 'hud-ads--on', t > 0.05);
    this._cls(el.ads, 'hud-ads--sniper', sniper);
    this._cls(el.crosshair, 'hud-crosshair--ads', t > 0.62);
  }

  /** 治疗轮盘只在长按 5 时显示；库存直接读取 Game.healing，避免状态不同步。 */
  _renderHealWheel() {
    const el = this.el;
    if (!el.healWheel) return;
    const h = this.ctx && this.ctx.healing;
    const open = !!(this._healWheel.open && h);
    this._cls(el.healWheel, 'hud-heal-wheel--on', open);
    if (!open) return;
    const selected = Math.max(0, Math.min(this._healSlots.length - 1, this._healWheel.selected | 0));
    for (let i = 0; i < this._healSlots.length; i++) {
      const s = this._healSlots[i];
      this._cls(s.slot, 'hud-heal-slot--selected', i === selected);
      const raw = h ? h[s.key] : 0;
      const n = Number(raw);
      const label = raw === Infinity || !Number.isFinite(n) ? '∞' : String(Math.max(0, Math.floor(n)));
      this._text(s.count, label);
      this._cls(s.slot, 'hud-heal-slot--empty', label === '0');
    }
  }

  /** 由 Game 在长按/松开 5 时调用。 */
  showHealWheel(selected, inventory) {
    if (!this._built || this._disposed) return;
    this._healWheel.open = true;
    this._healWheel.selected = Math.max(0, Math.min(this._healSlots.length - 1, selected | 0));
    if (inventory && this.ctx) this.ctx.healing = inventory;
  }

  hideHealWheel() {
    this._healWheel.open = false;
    if (this.el.healWheel) this._cls(this.el.healWheel, 'hud-heal-wheel--on', false);
  }

  _renderPrompt() {
    const el = this.el;
    const on = !!this._prompt;
    this._cls(el.prompt, 'hud-prompt--on', on);
    if (on) this._text(el.promptText, this._prompt);
  }

  _renderDamageNumbers() {
    for (let i = 0; i < this._dmg.length; i++) {
      const s = this._dmg[i];
      if (!s.on) {
        if (s.visible) {
          s.visible = false;
          this._cls(s.el, 'hud-dmg--on', false);
          this._style(s.el, 'opacity', '0');
        }
        continue;
      }
      s.visible = true;
      const k = clamp01(s.t / s.life);
      const op = k < 0.12 ? k / 0.12 : 1 - (k - 0.12) / 0.88;
      const scale = 1 + 0.35 * Math.max(0, 1 - k * 5);
      this._cls(s.el, 'hud-dmg--on', true);
      this._cls(s.el, 'hud-dmg--head', !!s.head);
      this._style(s.el, 'transform', 'translate3d(' + s.x.toFixed(1) + 'px, ' + s.y.toFixed(1) + 'px, 0) scale(' + scale.toFixed(3) + ')');
      this._style(s.el, 'opacity', op.toFixed(3));
    }
  }

  _renderDebug() {
    const el = this.el;
    if (!this._debugOn || !this._debugRows) return;
    // 调试文本按 0.15s 采样一次（update() 置位 _debugSample），
    // 避免每帧重写 8 行文本 —— 这也是变更检测缓存之外的额外节流。
    if (!this._debugSample) return;
    this._debugSample = false;

    const c = this.ctx || {};
    const stats = c.stats || (c.engine && c.engine.stats) || null;
    const fps = num(stats && stats.fps, this._fps);
    const frameMs = num(stats && stats.frameMs, this._frameMs < 0 ? 0 : this._frameMs);
    const draws = num(stats && stats.drawCalls, num(c.engine && c.engine.drawCalls, 0));
    const tris = num(stats && stats.triangles, num(c.engine && c.engine.triangles, 0));
    const ents = num(stats && stats.entities, this._entityCount());
    const p = this._player();
    const pos = p && p.pos ? p.pos : null;
    const posStr = pos
      ? num(pos[0]).toFixed(1) + ' , ' + num(pos[1]).toFixed(1) + ' , ' + num(pos[2]).toFixed(1)
      : '--';
    const errs = this._collectErrors();

    this._text(this._debugRows.fps, fps.toFixed(0));
    this._text(this._debugRows.frame, frameMs.toFixed(2) + ' ms');
    this._text(this._debugRows.draws, String(Math.round(draws)));
    this._text(this._debugRows.tris, String(Math.round(tris)));
    this._text(this._debugRows.entities, String(Math.round(ents)));
    this._text(this._debugRows.pos, posStr);
    this._text(this._debugRows.state, this._stateChip(p));
    this._text(this._debugRows.errors, errs.length ? errs[errs.length - 1] : '无');
    this._cls(el.debug, 'hud-debug--error', errs.length > 0);
  }

  _entityCount() {
    const c = this.ctx || {};
    const e = c.enemies;
    if (e) {
      if (typeof e.count === 'function') {
        try { return num(e.count(), 0); } catch (err) { /* 忽略 */ }
      }
      if (e.all && typeof e.all.length === 'number') return e.all.length;
    }
    const d = c.director;
    if (d && d.state) return num(d.state.aliveCount, 0);
    return 0;
  }

  _collectErrors() {
    const c = this.ctx || {};
    const out = [];
    const list = c.errors || (c.game && c.game.errors);
    if (list && typeof list.length === 'number') {
      for (let i = 0; i < list.length && i < 3; i++) {
        const e = list[i];
        if (e && e.message) out.push(String(e.message));
      }
    }
    for (let i = 0; i < this._errors.length; i++) out.push('[hud] ' + this._errors[i].message);
    return out;
  }

  // ── 各类池的写入接口 ─────────────────────────────────────────────────────
  toast(title, sub, kind) {
    if (!this._built || this._disposed || !this._toasts.length) return;
    try {
      const slot = this._toasts[this._toastIdx % this._toasts.length];
      this._toastIdx++;
      slot.t = 0;
      slot.on = true;
      const k = KIND_CN[kind] ? kind : 'info';
      if (slot.kind !== k) {
        this._cls(slot.el, 'hud-toast--info', k === 'info');
        this._cls(slot.el, 'hud-toast--warn', k === 'warn');
        this._cls(slot.el, 'hud-toast--good', k === 'good');
        slot.kind = k;
      }
      this._text(slot.title, title == null ? '' : title);
      this._text(slot.sub, sub == null ? '' : sub);
      // 复用最旧槽位：先摘后挂，保证顺序且节点总数不变。
      const box = this.el.toasts;
      if (box && slot.el.parentNode === box && typeof box.removeChild === 'function') box.removeChild(slot.el);
      this._append(box, slot.el);
      this._cls(slot.el, 'hud-toast--on', true);
    } catch (err) {
      this._recordError(err);
    }
  }

  addKill(text, kind) {
    if (!this._built || this._disposed || !this._kills.length) return;
    try {
      const slot = this._kills[this._killIdx % this._kills.length];
      this._killIdx++;
      slot.t = 0;
      slot.on = true;
      const k = kind || 'normal';
      if (slot.kind !== k) {
        for (const c of ['normal', 'headshot', 'kill', 'objective', 'warn', 'good']) {
          this._cls(slot.el, 'hud-kill--' + c, c === k);
        }
        slot.kind = k;
      }
      this._text(slot.text, text == null ? '' : text);
      const box = this.el.killfeed;
      if (box && slot.el.parentNode === box && typeof box.removeChild === 'function') box.removeChild(slot.el);
      this._append(box, slot.el);
      this._cls(slot.el, 'hud-kill--on', true);
      // 连杀：击杀类播报累计连杀，超时归零
      if (k === 'kill' || k === 'headshot') {
        this._combo++;
        this._comboTimer = COMBO_WINDOW;
      }
    } catch (err) {
      this._recordError(err);
    }
  }

  addDamageNumber(value, headshot, screenX, screenY) {
    if (!this._built || this._disposed || !this._dmg.length) return;
    try {
      const slot = this._dmg[this._dmgIdx % this._dmg.length];
      this._dmgIdx++;
      const r = this._rect;
      let x = Number.isFinite(screenX) ? num(screenX, 0) : r.w * 0.5;
      let y = Number.isFinite(screenY) ? num(screenY, 0) : r.h * 0.5 - 40;
      // 未给屏幕坐标时做一点散布，避免叠字
      if (!Number.isFinite(screenX)) x += (Math.random() - 0.5) * 70;
      if (!Number.isFinite(screenY)) y += (Math.random() - 0.5) * 24;
      slot.x = clamp(x, 8, Math.max(9, r.w - 8));
      slot.y = clamp(y, 8, Math.max(9, r.h - 8));
      slot.vx = (Math.random() - 0.5) * 44;
      slot.vy = -52 - Math.random() * 22;
      slot.t = 0;
      slot.on = true;
      slot.head = !!headshot;
      slot.visible = false;
      this._text(slot.el, String(Math.max(1, Math.round(num(value, 0)))));
    } catch (err) {
      this._recordError(err);
    }
  }

  /** 命中时显示/刷新敌人状态条；重复命中同一敌人不会占用新槽。 */
  trackEnemy(enemy) {
    if (!this._built || this._disposed || !enemy || !this._enemyVitals.length) return;
    let slot = null;
    for (const s of this._enemyVitals) {
      if (s.enemy === enemy) { slot = s; break; }
      if (!slot && !s.on) slot = s;
    }
    if (!slot) {
      slot = this._enemyVitals[this._enemyVitalIdx % this._enemyVitals.length];
      this._enemyVitalIdx++;
    }
    slot.enemy = enemy;
    slot.lastHitAt = this._time;
    slot.occludedSince = null;
    slot.on = true;
  }

  _renderEnemyVitals() {
    const engine = this.ctx && this.ctx.engine;
    const world = this.ctx && this.ctx.world;
    const player = this._player();
    const vp = engine && engine.viewProj;
    const eye = player && player.eyePos;
    const w = this._rect.w, h = this._rect.h;
    for (const slot of this._enemyVitals) {
      const enemy = slot.enemy;
      let visible = !!(slot.on && enemy && enemy.alive && (this._time - slot.lastHitAt) <= 1.0
        && vp && eye && w > 0 && h > 0);
      if (visible) {
        const a = slot.anchor;
        a[0] = enemy.pos[0];
        a[1] = enemy.pos[1] + num(enemy.height, 1.8) + 0.34;
        a[2] = enemy.pos[2];
        const cx = vp[0] * a[0] + vp[4] * a[1] + vp[8] * a[2] + vp[12];
        const cy = vp[1] * a[0] + vp[5] * a[1] + vp[9] * a[2] + vp[13];
        const cw = vp[3] * a[0] + vp[7] * a[1] + vp[11] * a[2] + vp[15];
        if (cw <= 0.05) visible = false;
        if (visible) {
          const nx = cx / cw, ny = cy / cw;
          if (nx < -1.08 || nx > 1.08 || ny < -1.08 || ny > 1.08) visible = false;
          else {
            const clear = !world || typeof world.lineOfSight !== 'function'
              || world.lineOfSight(eye, a, { hitBoxes: true, hitTriangles: true });
            if (clear) slot.occludedSince = null;
            else {
              if (slot.occludedSince == null) slot.occludedSince = this._time;
              // 短暂掠过掩体不会闪烁；连续遮挡满 0.4 秒才消失。
              if ((this._time - slot.occludedSince) >= 0.4) {
                visible = false;
                // 消失后不因敌人再次露头自动复现，必须由下一次实际命中重新激活。
                slot.on = false;
              }
            }
            if (visible) {
              const x = (nx * 0.5 + 0.5) * w;
              const y = (0.5 - ny * 0.5) * h;
              this._style(slot.el, 'transform', `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) translate(-50%,-100%)`);
              const shieldMax = Math.max(0, num(enemy.maxShield, 0));
              const shield = clamp(num(enemy.shield, 0), 0, shieldMax);
              const hpMax = Math.max(1, num(enemy.maxHp, 1));
              const hp = clamp(num(enemy.hp, 0), 0, hpMax);
              this._style(slot.shieldFill, 'transform', `scaleX(${(shieldMax > 0 ? shield / shieldMax : 0).toFixed(4)})`);
              const segments = Math.max(1, Math.ceil(shieldMax / 25));
              this._style(slot.shieldTrack, '--hud-shield-segments', String(segments));
              this._style(slot.shieldTrack, '--hud-shield-segment-width', `${(100 / segments).toFixed(4)}%`);
              this._style(slot.healthFill, 'transform', `scaleX(${(hp / hpMax).toFixed(4)})`);
              this._style(slot.shieldTrack, 'display', shieldMax > 0 ? 'block' : 'none');
            }
          }
        }
      }
      this._cls(slot.el, 'hud-enemy-vital--on', visible);
      if (!visible && (!enemy || !enemy.alive || (this._time - slot.lastHitAt) > 1.0)) {
        slot.on = false;
        slot.enemy = null;
        slot.occludedSince = null;
      }
    }
  }

  flashHitmarker(kind) {
    if (!this._built || this._disposed) return;
    const k = kind === 'headshot' || kind === 'kill' ? kind : 'normal';
    this._hm = { t: 0, kind: k };
    this._crossFlash = k === 'normal' ? 0.07 : 0.12;
  }

  setCrosshairStyle(s) {
    if (!s) return;
    if (typeof s === 'string') {
      this._xhair.style = s;
      this._xhair.color = '';
      this._xhair.scale = 1;
    } else if (typeof s === 'object') {
      if (typeof s.style === 'string') this._xhair.style = s.style;
      if (typeof s.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(s.color)) this._xhair.color = s.color;
      if (Number.isFinite(s.scale)) this._xhair.scale = clamp(num(s.scale, 1), 0.2, 4);
    }
    if (this._built && this.el.crosshair) {
      // 强制下一帧重算样式
      this._styleCache[(this.el.crosshair.id || 'anon') + '|--hud-xhair'] = null;
      this._setCrosshairStyle();
    }
  }

  setObjective(label, done, total) {
    this._objective = label ? { label: String(label), done: num(done, 0), total: num(total, 1) } : null;
  }

  setExtraction(secondsLeft) {
    if (secondsLeft === null || secondsLeft === undefined || !Number.isFinite(secondsLeft)) {
      this._extract = null;
      this._extractShown = -1;
    } else {
      this._extract = Math.max(0, num(secondsLeft, 0));
    }
  }

  setObjectivePoint(pos) { this._objectivePoint = pos && pos.length >= 3 ? pos : null; this._compassSig = ''; }
  setExtractionPoint(pos) { this._extractPoint = pos && pos.length >= 3 ? pos : null; this._compassSig = ''; }
  setAlloy(n) { this._alloy = Number.isFinite(n) ? Math.max(0, num(n, 0)) : null; }
  setRunStats(stats) { this._statOverride = stats && typeof stats === 'object' ? stats : null; }

  /**
   * 注入"远征简报"内容：世界观背景 + 本局任务。
   * 数据由 game 提供（任务阶梯里的 title/brief + 生物群系描述）。
   * 结构：{ world, mission, meta:[{k,v}], tier, mapName, biome }
   */
  setBriefing(info) {
    this._briefing = info && typeof info === 'object' ? info : null;
  }
  setVisible(b) { this._visible = !!b; }

  setPrompt(text) {
    this._prompt = text == null || text === '' ? null : String(text);
  }

  setDebugPanelVisible(b) {
    this._debugOn = !!b;
    if (this._built && this.el.debug) this._cls(this.el.debug, 'hud-debug--on', this._debugOn);
  }

  // ── 强化面板（3 选 1） ───────────────────────────────────────────────────
  showUpgradePanel(offers, alloy) {
    if (!this._built || this._disposed) return;
    try {
      if (Array.isArray(offers)) this._offers = offers.slice(0, POOL_OFFER);
      if (Number.isFinite(alloy)) this.setAlloy(alloy);
      this._upgradeOpen = true;
      this._offerIndex = -1;
      this._menu = 'upgrade';
      this._paintOffers();
      this._cls(this.el.upgrade, 'hud-upgrade--on', true);
      this._cls(this.el.upgrade, 'hud-upgrade--empty', this._offers.length === 0);
      this._refreshMenuClasses();
      this._resetNav();
    } catch (err) {
      this._recordError(err);
    }
  }

  hideUpgradePanel() {
    if (!this._built) return;
    this._upgradeOpen = false;
    this._offers = [];
    this._offerIndex = -1;
    if (this._menu === 'upgrade') this._menu = null;
    this._cls(this.el.upgrade, 'hud-upgrade--on', false);
    for (let i = 0; i < this._offerCards.length; i++) this._cls(this._offerCards[i].el, 'hud-offer--nav', false);
  }

  _paintOffers() {
    const alloy = this._currentAlloy();
    const freeUpgrades = !!(this.ctx && this.ctx.upgrades && this.ctx.upgrades.freeUpgrades);
    this._text(this.el.upgradeReroll, freeUpgrades ? '刷新（免费） (R)' : '刷新 (R)');
    this._text(this.el.upgradeAlloy, String(Math.round(alloy)));
    for (let i = 0; i < this._offerCards.length; i++) {
      const card = this._offerCards[i];
      const off = this._offers[i];
      if (!off) {
        this._cls(card.el, 'hud-offer--empty', true);
        this._text(card.rarity, '—');
        this._text(card.name, '空槽');
        this._text(card.desc, '没有可用强化');
        this._text(card.synergy, '');
        this._text(card.price, '');
        continue;
      }
      this._cls(card.el, 'hud-offer--empty', false);
      const def = off.def || off;
      const rarity = RARITY_KEY[off.rarity] || RARITY_KEY[def.rarity] || 'common';
      for (const rk of ['common', 'rare', 'epic', 'legendary']) {
        this._cls(card.el, 'hud-offer--' + rk, rk === rarity);
      }
      const price = num(off.price, num(def.price, 0));
       const locked = !freeUpgrades && (!!off.locked || price > alloy);
      this._cls(card.el, 'hud-offer--locked', locked);
      this._text(card.rarity, RARITY_CN[rarity] || '常规');
      this._text(card.name, def.nameCN || def.name || off.id || '未知强化');
      this._text(card.desc, def.desc || def.description || '');
      this._text(card.synergy, def.synergy || def.hint || '');
       this._text(card.price, freeUpgrades ? '免费' : (locked && price > alloy ? '合金不足 · ' + price : '合金 ' + price));
    }
  }

  _setOfferIndex(i) {
    if (i < 0 || i >= this._offers.length) {
      this._offerIndex = -1;
    } else {
      this._offerIndex = i;
    }
    for (let k = 0; k < this._offerCards.length; k++) {
      this._cls(this._offerCards[k].el, 'hud-offer--nav', k === this._offerIndex);
    }
  }

  _pickOffer(i) {
    const off = this._offers[i];
    if (!off) return;
    this._setOfferIndex(i);
    this._sfx('upgrade_pick');
    this._intent('pick_upgrade', { index: i, id: off.id, offer: off, price: num(off.price, 0) });
  }

  // ── 菜单 ────────────────────────────────────────────────────────────────
  showMenu(kind, payload) {
    if (!this._built || this._disposed) return;
    try {
      if (kind === 'upgrade') { this.showUpgradePanel(null, undefined); return; }
      if (!MENU_SPEC[kind]) return;
      if (payload && typeof payload === 'object') this._statOverride = payload;
      this._menu = kind;
      this._upgradeOpen = false;
      this._cls(this.el.upgrade, 'hud-upgrade--on', false);
      this._paintMenu(kind);
      this._refreshMenuClasses();
      this._resetNav();
    } catch (err) {
      this._recordError(err);
    }
  }

  hideMenu() {
    if (!this._built) return;
    this._menu = null;
    this._upgradeOpen = false;
    this._offers = [];
    this._offerIndex = -1;
    this._cls(this.el.upgrade, 'hud-upgrade--on', false);
    for (let i = 0; i < this._offerCards.length; i++) this._cls(this._offerCards[i].el, 'hud-offer--nav', false);
    this._refreshMenuClasses();
  }

  _refreshMenuClasses() {
    this._cls(this.el.menuOverlay, 'menu-overlay--on', !!(this._menu && this._menu !== 'upgrade'));
    for (const kind of Object.keys(this._menuPanels)) {
      this._cls(this._menuPanels[kind], 'menu-panel--on', this._menu === kind);
    }
  }

  _paintMenu(kind) {
    const spec = MENU_SPEC[kind];
    if (!spec) return;
    if (kind === 'extract' && this._statOverride) {
      const ok = this._statOverride.success !== false && this._statOverride.extracted !== false;
      this._text(this.el['menu-extract-title'], ok ? '撤离成功' : '撤离失败');
      this._text(this.el['menu-extract-sub'], ok ? 'EXTRACTION SUCCESS' : 'EXTRACTION FAILED');
      this._cls(this._menuPanels.extract, 'menu-panel--fail', !ok);
    }
    if (spec.stats) {
      const st = this._stats();
      this._text(this.el['menu-' + kind + '-stat-kills'], String(st.kills));
      this._text(this.el['menu-' + kind + '-stat-headshots'], String(st.headshots));
      this._text(this.el['menu-' + kind + '-stat-damage'], String(Math.round(st.damage)));
      this._text(this.el['menu-' + kind + '-stat-time'], fmtTime(st.time));
      this._text(this.el['menu-' + kind + '-stat-tier'], String(Math.round(st.tier)));
      this._text(this.el['menu-' + kind + '-stat-alloy'], String(Math.round(st.alloy)));
    }
    if (spec.settings) {
      for (const cfgItem of SETTINGS_SPEC) {
        const v = this.settings[cfgItem.id];
        const input = this.el['set-input-' + cfgItem.id];
        if (input) {
          if (cfgItem.type === 'toggle') input.checked = !!v;
          else if (input.value !== undefined) input.value = String(v);
        }
        this._text(this.el['set-value-' + cfgItem.id], this._fmtSetting(cfgItem, v));
      }
    }
    if (spec.campaign) {
      const meta = this.ctx && this.ctx.meta;
      const missions = (this.ctx && this.ctx.missions) || [];
      const unlocked = Math.max(1, Math.min(10, num(meta && meta.unlocked && meta.unlocked.tiers, 1)));
      for (const entry of (this._menuItems[kind] || [])) {
        const tier = entry.spec.tier;
        if (!tier) continue;
        const mission = missions[tier - 1] || {};
        const locked = tier > unlocked;
        this._text(entry.label, `第 ${tier} 关 · ${mission.title || '未知任务'}`);
        this._text(entry.sub, locked ? '未解锁' : (mission.world || '可部署'));
        entry.spec.disabled = locked;
        this._cls(entry.el, 'menu-item--disabled', locked);
      }
    }
    if (spec.armory) {
      const meta = this.ctx && this.ctx.meta;
      const perks = (this.ctx && this.ctx.perks) || {};
      const points = Math.max(0, num(meta && meta.points, 0));
      const stashItems = meta && meta.stash && meta.stash.items ? meta.stash.items : {};
      const stashCount = Object.values(stashItems).reduce((sum, n) => sum + Math.max(0, num(n, 0)), 0);
      this._text(this.el['menu-armory-note'], `远征点数：${points} · 仓库物资：${stashCount} 件。单击购买，永久生效。`);
      for (const entry of (this._menuItems[kind] || [])) {
        const id = entry.spec.perkId;
        if (!id) continue;
        const def = perks[id] || {};
        const level = Math.max(0, num(meta && meta.perks && meta.perks[id], 0));
        const max = Math.max(1, num(def.maxStacks, 1));
        const cost = meta && typeof meta.perkCost === 'function' ? meta.perkCost(id) : num(def.cost, 0);
        const full = level >= max;
        const affordable = !full && points >= cost;
        this._text(entry.label, `${def.name || entry.spec.label}  ${level}/${max}`);
        this._text(entry.sub, full ? '已满级' : `${cost} 点 · ${def.desc || ''}`);
        entry.spec.disabled = full || !affordable;
        this._cls(entry.el, 'menu-item--disabled', entry.spec.disabled);
      }
    }
    // 远征简报：把 game 注入的剧情与任务文案画上去
    if (spec.briefing) {
      const b = this._briefing || {};
      this._text(this.el['menu-' + kind + '-world'],
        b.world || '钢铁远征舰队把整支锻造舰队开进了星系边缘，用熔炉星港把行星直接熔成战舰。你是被留在封锁区里的拾荒者，穿着拼装的外骨骼，靠拆解远征军的设备换一条命。');
      this._text(this.el['menu-' + kind + '-mission'],
        b.mission || '十次远征，从熔炉星港的冷却渠一路打到轨道锚站。每次出发前你可以用远征点数改装外骨骼；每次活着回来，都能带出一点东西。');
      const meta = [];
      if (b.tier) meta.push('远征层数 ' + b.tier);
      if (b.biomeName) meta.push(b.biomeName);
      if (b.mapName) meta.push(b.mapName);
      if (b.objectives) meta.push('目标 ' + b.objectives + ' 项');
      this._text(this.el['menu-' + kind + '-meta'], meta.join('  ·  '));
    }
  }

  _stats() {
    const c = this.ctx || {};
    const r = c.run;
    const src = (r && (r.stats || r)) || {};
    const o = this._statOverride || {};
    const pickNum = (k, alt) => {
      if (Number.isFinite(o[k])) return num(o[k], 0);
      if (Number.isFinite(src[k])) return num(src[k], 0);
      if (alt && Number.isFinite(src[alt])) return num(src[alt], 0);
      return 0;
    };
    return {
      kills: pickNum('kills'),
      headshots: pickNum('headshots', 'headshotKills'),
      damage: pickNum('damage', 'damageDealt'),
      time: pickNum('time', 'timeSec') || pickNum('elapsed'),
      tier: pickNum('tier') || num(r && r.tier, 1),
      alloy: pickNum('alloy') || this._currentAlloy(),
    };
  }

  _resetNav() {
    this._navTargets = this._navTargetsFor(this._menu);
    this._navIndex = 0;
    this._applyNav();
  }

  _navTargetsFor(kind) {
    const out = [];
    if (!kind) return out;
    if (kind === 'settings') {
      for (const s of SETTINGS_SPEC) out.push({ type: 'setting', spec: s, el: this.el['set-row-' + s.id] });
    }
    const items = this._menuItems[kind] || [];
    for (const it of items) if (!it.spec.disabled) out.push({ type: 'item', item: it.spec, el: it.el });
    return out;
  }

  _applyNav() {
    for (let i = 0; i < this._navTargets.length; i++) {
      this._cls(this._navTargets[i].el, 'menu-item--nav', i === this._navIndex);
    }
  }

  _navToElement(el) {
    for (let i = 0; i < this._navTargets.length; i++) {
      if (this._navTargets[i].el === el) {
        this._navIndex = i;
        this._applyNav();
        return;
      }
    }
  }

  _moveNav(dir) {
    if (!this._navTargets.length) return;
    this._navIndex = (this._navIndex + dir + this._navTargets.length) % this._navTargets.length;
    this._applyNav();
    this._sfx('ui_hover');
  }

  _activate(target) {
    if (!target) return;
    if (target.type === 'setting') {
      const spec = target.spec;
      if (spec.type === 'toggle') {
        const input = this.el['set-input-' + spec.id];
        const v = input ? !input.checked : !this.settings[spec.id];
        this.settings[spec.id] = v;
        if (input) input.checked = v;
        this._text(this.el['set-value-' + spec.id], this._fmtSetting(spec, v));
        this._sfx('ui_click');
        this._intent(spec.intent, { value: v, id: spec.id });
      }
      return;
    }
    const item = target.item;
    if (!item || item.disabled) return;
    this._sfx('ui_click');
    this._intent(item.intent, { menu: this._menu, tier: item.tier, perkId: item.perkId });
  }

  _adjustNav(dir) {
    const t = this._navTargets[this._navIndex];
    if (!t || t.type !== 'setting') return;
    const spec = t.spec;
    const input = this.el['set-input-' + spec.id];
    if (spec.type === 'range') {
      const v = clamp(num(this.settings[spec.id], spec.def) + num(spec.step, 1) * dir, num(spec.min, 0), num(spec.max, 1));
      this.settings[spec.id] = v;
      if (input) input.value = String(v);
      this._text(this.el['set-value-' + spec.id], this._fmtSetting(spec, v));
      this._intent(spec.intent, { value: v, id: spec.id });
      return;
    }
    if (spec.type === 'select') {
      const opts = spec.options || [];
      let idx = 0;
      for (let i = 0; i < opts.length; i++) if (String(opts[i][0]) === String(this.settings[spec.id])) idx = i;
      idx = (idx + dir + opts.length) % opts.length;
      const v = spec.id === 'fpsCap' ? num(opts[idx][0], 0) : String(opts[idx][0]);
      this.settings[spec.id] = v;
      if (input) input.value = String(v);
      this._text(this.el['set-value-' + spec.id], this._fmtSetting(spec, v));
      this._intent(spec.intent, { value: v, id: spec.id });
      return;
    }
    this._activate(t);
  }

  _onKeyDown(e) {
    if (this._disposed || !e) return;
    const code = e.code || e.key;
    const prevent = () => { if (typeof e.preventDefault === 'function') e.preventDefault(); };

    if (code === 'F3') {
      this.setDebugPanelVisible(!this._debugOn);
      prevent();
      return;
    }
    if (!this._menu) return;

    if (code === 'Escape') {
      // Escape 由 Game 的单一状态机处理。这里若同时发 close_menu，会出现同一个
      // keydown 先关闭、下一帧又被 Game 重新打开的竞态。
      prevent();
      return;
    }
    if (this._menu === 'upgrade') {
      if (code === 'Digit1' || code === 'Digit2' || code === 'Digit3' || code === 'Numpad1' || code === 'Numpad2' || code === 'Numpad3') {
        const n = num(code.charAt(code.length - 1), 1) - 1;
        this._pickOffer(n);
        prevent();
        return;
      }
      if (code === 'KeyR') {
        this._sfx('ui_click');
        this._intent('reroll_upgrade', { alloy: this._currentAlloy() });
        prevent();
        return;
      }
      if (code === 'ArrowRight' || code === 'ArrowDown') { this._setOfferIndex(this._offerIndex + 1); prevent(); return; }
      if (code === 'ArrowLeft' || code === 'ArrowUp') { this._setOfferIndex(this._offerIndex - 1); prevent(); return; }
      if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space') {
        if (this._offerIndex >= 0) this._pickOffer(this._offerIndex);
        prevent();
        return;
      }
      return;
    }

    if (code === 'ArrowDown') { this._moveNav(1); prevent(); return; }
    if (code === 'ArrowUp') { this._moveNav(-1); prevent(); return; }
    if (code === 'ArrowRight') { this._adjustNav(1); prevent(); return; }
    if (code === 'ArrowLeft') { this._adjustNav(-1); prevent(); return; }
    if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space') {
      this._activate(this._navTargets[this._navIndex]);
      prevent();
      return;
    }
    // 数字键直接触发对应菜单项
    if (/^Digit[1-9]$/.test(code) && this._menu) {
      const idx = num(code.charAt(code.length - 1), 1) - 1;
      const items = this._menuItems[this._menu] || [];
      if (items[idx]) this._activate({ type: 'item', item: items[idx].spec });
      prevent();
    }
  }

  // ── 加载遮罩 ────────────────────────────────────────────────────────────
  showLoading(progress, text) {
    if (!this._built || this._disposed) { this._loading = true; return; }
    try {
      this._loading = true;
      const p = clamp01(num(progress, 0));
      this._cls(this.el.loadOverlay, 'load-overlay--done', false);
      this._style(this.el.loadBar, 'transform', 'scaleX(' + p.toFixed(4) + ')');
      this._text(this.el.loadPct, Math.round(p * 100) + '%');
      if (text != null) this._text(this.el.loadText, String(text));
    } catch (err) {
      this._recordError(err);
    }
  }

  hideLoading() {
    this._loading = false;
    if (!this._built || this._disposed) return;
    this._cls(this.el.loadOverlay, 'load-overlay--done', true);
  }

  // ── 销毁 ────────────────────────────────────────────────────────────────
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    // 1) 摘掉全部监听器
    for (let i = 0; i < this._listeners.length; i++) {
      const l = this._listeners[i];
      if (l.target && typeof l.target.removeEventListener === 'function') {
        l.target.removeEventListener(l.type, l.fn);
      }
    }
    this._listeners.length = 0;
    // 2) detach 所有节点
    const detach = (node, parent) => {
      if (node && parent && node.parentNode === parent && typeof parent.removeChild === 'function') {
        parent.removeChild(node);
      }
    };
    detach(this.el.root, this.root);
    if (this._ownsLoading) detach(this.el.loadOverlay, this.root);
    // 3) 清空引用与缓存，避免池里的节点被继续持有
    this._toasts.length = 0;
    this._kills.length = 0;
    this._dmg.length = 0;
    this._offers = [];
    this._cache = Object.create(null);
    this._styleCache = Object.create(null);
    this._hm = null;
  }
}

export default HUD;
