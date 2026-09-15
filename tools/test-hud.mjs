// ==== tools/test-hud.mjs — IRONFALL HUD 自测（手写最小 DOM mock，零依赖） ====
//
// 运行：node tools/test-hud.mjs
// 覆盖：
//   G1  构造 + 全部稳定元素 id
//   G2  缺失 ctx 的防御性（HUD 必须永不抛异常）
//   G3  600 帧 update/render 压力（含 0 弹药 / 空备弹 / 换弹 / 死亡 / 60m/s / 负护盾 等边界）
//   G4  菜单：全部 showMenu(kind) 变体 + 键盘导航 + 点击 + 意图回调
//   G5  toast 队列有界（200 次调用，旧节点被回收复用）
//   G6  伤害数字 / 命中标记对象池
//   G7  DOM 节点预算（压力前后完全一致）
//   G8  变更检测缓存（无变化时零 DOM 写入）
//   G9  styles/hud.css 解析：括号平衡 / 重复选择器 / 规则数 / 仅 transform+opacity 动画
//   G10 dispose：监听器全摘、节点全摘、之后调用安全
//   G11 加载遮罩（接管 index.html 静态遮罩 / 创建 / 销毁语义）

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { HUD } from '../src/ui/hud.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = resolve(HERE, '..', 'styles', 'hud.css');

// ═══════════════════════════════════════════════════════════════════════════
// 0. 极简断言框架
// ═══════════════════════════════════════════════════════════════════════════
let totalPass = 0;
let totalFail = 0;
let current = null;
const groupStats = [];

function group(title) {
  current = { title, pass: 0, fail: 0 };
  groupStats.push(current);
  process.stdout.write('\n── ' + title + ' ──\n');
}

function check(name, cond, detail) {
  if (cond) {
    current.pass++;
    totalPass++;
    process.stdout.write('  PASS  ' + name + (detail ? '  [' + detail + ']' : '') + '\n');
  } else {
    current.fail++;
    totalFail++;
    process.stdout.write('  FAIL  ' + name + (detail ? '  [' + detail + ']' : '') + '\n');
  }
  return !!cond;
}

function eq(name, actual, expected) {
  return check(name, actual === expected, 'got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected));
}

function noThrow(name, fn) {
  try {
    fn();
    return check(name, true);
  } catch (err) {
    return check(name, false, 'threw: ' + (err && err.stack ? err.stack.split('\n')[0] : err));
  }
}

function section(text) {
  process.stdout.write('  · ' + text + '\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. 手写最小 DOM mock
// ═══════════════════════════════════════════════════════════════════════════
const mockStats = { created: 0, textWrites: 0, styleWrites: 0, listeners: 0 };
const canvasCalls = [];

function makeStyle() {
  // 契约要求：style 是「带 setProperty 的普通对象」
  const style = {};
  Object.defineProperty(style, 'setProperty', {
    value: (k, v) => { style[k] = String(v); mockStats.styleWrites++; },
    enumerable: false,
  });
  Object.defineProperty(style, 'getPropertyValue', {
    value: (k) => (style[k] === undefined ? '' : style[k]),
    enumerable: false,
  });
  Object.defineProperty(style, 'removeProperty', {
    value: (k) => { delete style[k]; },
    enumerable: false,
  });
  return style;
}

class MockNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.nodeName = this.tagName;
    this.nodeType = 1;
    this.id = '';
    this._classes = new Set();
    this._text = '';
    this._html = '';
    this.children = [];
    this.childNodes = this.children;
    this.parentNode = null;
    this.ownerDocument = null;
    this.attributes = new Map();
    this.style = makeStyle();
    this.value = '';
    this.checked = false;
    this.type = '';
    this.min = '';
    this.max = '';
    this.step = '';
    this.width = 0;
    this.height = 0;
    this.disabled = false;
    this._listeners = new Map();
    const set = this._classes;
    this.classList = {
      add: (...names) => { for (const n of names) set.add(String(n)); },
      remove: (...names) => { for (const n of names) set.delete(String(n)); },
      toggle: (n, force) => {
        const has = set.has(String(n));
        const want = force === undefined ? !has : !!force;
        if (want) set.add(String(n)); else set.delete(String(n));
        return want;
      },
      contains: (n) => set.has(String(n)),
      item: (i) => [...set][i] || null,
      get length() { return set.size; },
      get value() { return [...set].join(' '); },
    };
    mockStats.created++;
  }

  get className() { return [...this._classes].join(' '); }

  set className(v) {
    this._classes.clear();
    for (const n of String(v == null ? '' : v).split(/\s+/)) if (n) this._classes.add(n);
  }

  get textContent() {
    if (this._text !== '') return this._text;
    if (this.children.length === 0) return '';
    let s = '';
    for (const c of this.children) s += c.textContent;
    return s;
  }

  set textContent(v) {
    mockStats.textWrites++;
    this._text = v == null ? '' : String(v);
    for (const c of this.children) c.parentNode = null;
    this.children.length = 0;
  }

  get innerHTML() { return this._html; }

  // 契约要求：innerHTML 只存不解析
  set innerHTML(v) { this._html = String(v == null ? '' : v); }

  appendChild(child) {
    if (!child) throw new Error('appendChild(null)');
    if (child.parentNode === this) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
    } else if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i < 0) throw new Error('removeChild: node is not a child (id=' + this.id + ')');
    this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  setAttribute(name, value) {
    const v = String(value);
    this.attributes.set(name, v);
    if (name === 'id') this.id = v;
    else if (name === 'class') this.className = v;
    else if (name === 'type' || name === 'min' || name === 'max' || name === 'step' || name === 'value') this[name] = v;
    else if (name === 'checked') this.checked = true;
  }

  getAttribute(name) {
    if (name === 'id') return this.id || null;
    if (name === 'class') return this.className || null;
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) { return this.attributes.has(name) || (name === 'id' && !!this.id); }

  removeAttribute(name) { this.attributes.delete(name); }

  _matches(sel) {
    const s = String(sel).trim();
    if (!s) return false;
    if (s[0] === '#') return this.id === s.slice(1);
    if (s[0] === '.') return this._classes.has(s.slice(1));
    return this.tagName === s.toUpperCase();
  }

  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (c._matches(sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  querySelector(sel) {
    const all = this.querySelectorAll(sel);
    return all.length ? all[0] : null;
  }

  getBoundingClientRect() {
    return { x: 0, y: 0, width: 1920, height: 1080, top: 0, left: 0, right: 1920, bottom: 1080 };
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
    mockStats.listeners++;
  }

  removeEventListener(type, fn) {
    const s = this._listeners.get(type);
    if (s && s.delete(fn)) mockStats.listeners--;
  }

  listenerCount() {
    let n = 0;
    for (const s of this._listeners.values()) n += s.size;
    return n;
  }

  dispatchEvent(evt) {
    const e = typeof evt === 'string' ? { type: evt } : evt;
    if (!e.type) throw new Error('dispatchEvent: missing type');
    if (!e.target) e.target = this;
    if (typeof e.preventDefault !== 'function') e.preventDefault = () => { e.defaultPrevented = true; };
    if (typeof e.stopPropagation !== 'function') e.stopPropagation = () => {};
    const set = this._listeners.get(e.type);
    if (set) for (const fn of [...set]) fn(e);
    return !e.defaultPrevented;
  }

  click() { return this.dispatchEvent({ type: 'click' }); }

  focus() { this.focused = true; }

  getContext(kind) {
    if (String(kind) !== '2d') return null;
    if (!this._ctx) this._ctx = makeCtx2d(this, canvasCalls);
    return this._ctx;
  }
}

function makeCtx2d(canvas, rec) {
  const target = {
    canvas,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    globalCompositeOperation: 'source-over',
    filter: 'none',
    measureText: (t) => { rec.push('measureText'); return { width: String(t).length * 6 }; },
    createLinearGradient: () => { rec.push('createLinearGradient'); return { addColorStop() {} }; },
    createRadialGradient: () => { rec.push('createRadialGradient'); return { addColorStop() {} }; },
    getImageData: () => { rec.push('getImageData'); return { data: new Uint8ClampedArray(4) }; },
    createPattern: () => { rec.push('createPattern'); return null; },
  };
  const METHODS = [
    'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'arcTo',
    'ellipse', 'rect', 'roundRect', 'fill', 'stroke', 'clip', 'save', 'restore', 'translate', 'rotate',
    'scale', 'transform', 'setTransform', 'resetTransform', 'fillText', 'strokeText', 'setLineDash',
    'getLineDash', 'drawImage', 'quadraticCurveTo', 'bezierCurveTo', 'putImageData', 'isPointInPath',
  ];
  for (const m of METHODS) target[m] = (...args) => { rec.push(m); return undefined; };
  // 未知方法一律变成「录制 no-op」，任何 2D 调用都不会让 HUD 崩掉
  return new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === 'symbol') return undefined;
      const fn = (...args) => { rec.push(String(k)); return undefined; };
      t[k] = fn;
      return fn;
    },
    set(t, k, v) { rec.push('set:' + String(k)); t[k] = v; return true; },
  });
}

function makeDocument() {
  const doc = new MockNode('#document');
  doc.nodeType = 9;
  doc.createElement = (tag) => {
    const n = new MockNode(tag);
    n.ownerDocument = doc;
    if (String(tag).toLowerCase() === 'canvas') {
      n.width = 300;
      n.height = 150;
    }
    return n;
  };
  doc.createTextNode = (t) => {
    const n = new MockNode('#text');
    n.nodeType = 3;
    n.textContent = t;
    return n;
  };
  doc.getElementById = (id) => doc.querySelector('#' + id);
  doc.documentElement = doc.createElement('html');
  doc.body = doc.createElement('body');
  doc.appendChild(doc.documentElement);
  doc.appendChild(doc.body);
  return doc;
}

function makeRoot(doc) {
  const root = new MockNode('div');
  root.id = 'hud-root';
  root.ownerDocument = doc;
  doc.body.appendChild(root);
  return root;
}

function countNodes(node) {
  let n = 1;
  for (const c of node.children) n += countNodes(c);
  return n;
}

function countClass(root, cls) {
  return root.querySelectorAll('.' + cls).length;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. 假上下文（完整 ctx）与随机源
// ═══════════════════════════════════════════════════════════════════════════
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(0x1F0FA11);
const rand = (lo, hi) => lo + (hi - lo) * rng();
const randInt = (lo, hi) => Math.floor(rand(lo, hi + 1));

function makeWorld() {
  return {
    objectives: () => [{ id: 'core_a', pos: new Float32Array([52, 0, -38]) }],
    extractPoints: () => [{ pos: new Float32Array([140, 0, 141]), radius: 6 }],
  };
}

function makeCtx() {
  const player = {
    pos: new Float32Array([12.5, 0.2, -30.75]),
    vel: new Float32Array([8, 0, -3]),
    forward: new Float32Array([0.2, 0, -0.98]),
    yaw: 0.2,
    pitch: 0.02,
    health: 100,
    shield: 100,
    maxHealth: 100,
    maxShield: 100,
    alive: true,
    state: {
      grounded: true,
      sliding: false,
      crouching: false,
      sprinting: false,
      wallRunning: false,
      wallClimbing: false,
      mantling: false,
      dashing: false,
      grappleActive: false,
      airJumps: 1,
      maxAirJumps: 1,
      dashCharges: 2,
      dashMaxCharges: 2,
      dashCooldownLeft: 0,
      dashCooldown: 0.9,
      grappleCooldownLeft: 0,
      grappleCooldown: 2.4,
      speed: 0,
      sprintFraction: 0,
      lastLandImpact: 0,
      wallSide: 0,
      groundNormal: new Float32Array([0, 1, 0]),
      wallNormal: new Float32Array([0, 0, 0]),
    },
  };
  const weapons = {
    def: {
      id: 'r99', name: 'R-99', nameCN: 'R-99 冲锋枪', magSize: 20, reserveMax: 180,
      hipSpreadBase: 0.55, spreadMax: 4.2,
    },
    current: { def: null, ammo: 20, reserve: 180, reloading: false, reloadProgress: 0, spread: 0.55 },
    equip() {},
    debugState() { return {}; },
  };
  weapons.current.def = weapons.def;
  const enemies = {
    all: [{ id: 1 }, { id: 2 }, { id: 3 }],
    count() { return this.all.length; },
  };
  const director = {
    threat: 0.42,
    state: { phase: 'build', waveIndex: 3, budget: 12.5, aliveCount: 3, intensity: 0.6, nextWaveIn: 8.2 },
  };
  const run = {
    tier: 2,
    alloy: 340,
    phase: 'build',
    stats: { kills: 17, headshots: 6, damage: 4820.5, timeSec: 372, tier: 2, alloy: 340 },
  };
  const upgrades = {
    alloy: 340,
    owned: [{ id: 'slide_speed', stacks: 2 }],
    rollOffers() { return []; },
    modifiers: { move: {}, weapon: {}, meta: {} },
  };
  const audio = { ready: true, played: [], play(name, opts) { this.played.push(name); } };
  const engine = { stats: { fps: 144, frameMs: 6.94, drawCalls: 214, triangles: 486_000 }, drawCalls: 214, triangles: 486_000 };
  const config = { fx: { hitmarkerTime: 0.16 }, render: { fovDeg: 100, targetFpsCap: 0 } };
  const input = {
    sensitivity: 3.2,
    invertY: false,
    getSensitivity() { return this.sensitivity; },
    getInvertY() { return this.invertY; },
  };
  return {
    player, weapons, enemies, director, run, upgrades, audio, engine, config, input,
    healing: { medkits: Infinity, shieldBatteries: Infinity, syringes: Infinity, shieldCells: Infinity, selection: 0 },
    world: makeWorld(),
    errors: [],
  };
}

function makeOffers() {
  return [
    { id: 'dmg_up', rarity: 'rare', price: 60, locked: false, def: { nameCN: '枪管增压', desc: '武器伤害 +12%', synergy: '与「弹匣扩容」协同' } },
    { id: 'slide_boost', rarity: 'epic', price: 120, locked: false, def: { nameCN: '滑铲推进器', desc: '滑铲初速 +25%', synergy: '' } },
    { id: 'legend_apex', rarity: 'legendary', price: 400, locked: false, def: { nameCN: '远征核心', desc: '击杀后刷新冲刺', synergy: '与「连杀增伤」协同' } },
  ];
}

const STATE_CHIPS = ['GROUNDED', 'SLIDE', 'WALLRUN', 'AIR', 'GRAPPLE', 'MANTLE', 'DASH'];

// 需要自动化能找到的稳定 id 清单
const REQUIRED_IDS = [
  'hud', 'hud-crosshair', 'hud-ch-line-top', 'hud-ch-line-bottom', 'hud-ch-line-left', 'hud-ch-line-right',
  'hud-ch-dot', 'hud-hitmarker', 'hud-hitmarker-line-0', 'hud-hitmarker-line-1', 'hud-hitmarker-line-2',
  'hud-hitmarker-line-3', 'hud-top', 'hud-compass', 'hud-bearing-objective', 'hud-bearing-extract',
  'hud-objective', 'hud-objective-label', 'hud-objective-text', 'hud-objective-fill', 'hud-extraction',
  'hud-extraction-label', 'hud-extraction-time', 'hud-vitals', 'hud-health', 'hud-health-fill',
  'hud-health-text', 'hud-shield', 'hud-shield-fill', 'hud-abilities', 'hud-ability-dash',
  'hud-ability-dash-fill', 'hud-ability-dash-label', 'hud-ability-grapple', 'hud-ability-grapple-fill',
  'hud-ability-grapple-label', 'hud-ability-jump', 'hud-ability-jump-fill', 'hud-ability-jump-label',
  'hud-ammo', 'hud-ammo-current', 'hud-ammo-reserve', 'hud-weapon-name', 'hud-reload', 'hud-reload-text',
  'hud-reload-ring', 'hud-reload-arc-r', 'hud-reload-arc-l', 'hud-speed', 'hud-speed-value',
  'hud-speed-state', 'hud-speed-fill', 'hud-alloy', 'hud-alloy-value', 'hud-combo', 'hud-combo-value',
  'hud-killfeed', 'hud-damage-numbers', 'hud-prompt', 'hud-prompt-text', 'hud-debug', 'hud-debug-fps',
  'hud-debug-frame', 'hud-debug-draws', 'hud-debug-tris', 'hud-debug-entities', 'hud-debug-pos',
  'hud-debug-state', 'hud-debug-errors', 'hud-upgrade', 'hud-upgrade-alloy-value', 'hud-upgrade-card-0',
  'hud-upgrade-card-1', 'hud-upgrade-card-2', 'hud-offer-name-0', 'hud-offer-name-1', 'hud-offer-name-2',
  'hud-offer-desc-0', 'hud-offer-price-0', 'hud-offer-rarity-0', 'hud-offer-synergy-0', 'hud-offer-key-0',
  'hud-upgrade-reroll', 'hud-upgrade-skip', 'hud-upgrade-hint', 'hud-upgrade-empty', 'menu-overlay', 'menu-main',
  'menu-main-item-0', 'menu-main-item-1', 'menu-main-item-2', 'menu-main-item-3', 'menu-main-item-4', 'menu-main-item-5',
  'menu-briefing', 'menu-briefing-world', 'menu-briefing-mission', 'menu-briefing-meta',
  'menu-credits', 'menu-credits-row-引擎', 'menu-credits-row-第三方依赖',
  'menu-pause', 'menu-pause-item-0', 'menu-dead', 'menu-dead-stats', 'menu-dead-stat-kills',
  'menu-dead-stat-time', 'menu-dead-item-0', 'menu-extract', 'menu-extract-title', 'menu-extract-stats',
  'menu-settings', 'menu-settings-input-sensitivity', 'menu-settings-input-fov', 'menu-settings-input-volume',
  'menu-settings-input-invertY', 'menu-settings-input-fpsCap', 'menu-settings-input-quality',
  'menu-settings-value-sensitivity', 'menu-help', 'menu-help-row-0', 'load-overlay', 'load-bar',
  'load-text', 'load-pct', 'hud-heal-wheel', 'hud-heal-wheel-title', 'hud-heal-wheel-hint',
];
for (let i = 0; i < 4; i++) {
  REQUIRED_IDS.push('hud-heal-slot-' + i, 'hud-heal-slot-' + i + '-icon',
    'hud-heal-slot-' + i + '-name', 'hud-heal-slot-' + i + '-desc', 'hud-heal-slot-' + i + '-count');
}
for (let i = 0; i < 8; i++) REQUIRED_IDS.push('hud-toast-' + i);
for (let i = 0; i < 6; i++) REQUIRED_IDS.push('hud-kill-' + i);
for (let i = 0; i < 32; i++) REQUIRED_IDS.push('hud-dmg-' + i);

// ═══════════════════════════════════════════════════════════════════════════
// G1 — 构造与元素 id
// ═══════════════════════════════════════════════════════════════════════════
const doc = makeDocument();
const root = makeRoot(doc);
const ctx = makeCtx();
const hud = new HUD(root, ctx);

group('G1 构造与稳定元素 id');
{
  const missing = REQUIRED_IDS.filter((id) => !root.querySelector('#' + id));
  check('HUD 构造成功，全部 ' + REQUIRED_IDS.length + ' 个稳定 id 均存在', missing.length === 0,
    missing.length ? 'missing: ' + missing.slice(0, 8).join(', ') : 'ok');
  eq('HUD 构造后无异常记录', hud.lastError, null);
  eq('visible 默认为 true', hud.visible, true);
  eq('selectedOfferIndex 默认为 -1', hud.selectedOfferIndex, -1);
  hud.showHealWheel(2, ctx.healing);
  hud._renderHealWheel();
  check('治疗轮盘渲染四项（含注射器与小型护盾电池）', hud._healSlots.length === 4,
    hud._healSlots.map((s) => s.slot.children[1] && s.slot.children[1].textContent).join(' / '));
  check('轮盘可明确选中注射器', root.querySelector('#hud-heal-slot-2').classList.contains('hud-heal-slot--selected'));
  eq('注射器无限数量显示为 ∞', root.querySelector('#hud-heal-slot-2-count').textContent, '∞');
  hud.showHealWheel(3, ctx.healing);
  hud._renderHealWheel();
  check('轮盘可明确选中小型护盾电池', root.querySelector('#hud-heal-slot-3').classList.contains('hud-heal-slot--selected'));
  hud.hideHealWheel();

  const api = ['update', 'render', 'showMenu', 'hideMenu', 'toast', 'dispose', 'setCrosshairStyle',
    'flashHitmarker', 'addDamageNumber', 'addKill', 'setObjective', 'setExtraction', 'showUpgradePanel',
    'hideUpgradePanel', 'setPrompt', 'setDebugPanelVisible', 'showLoading', 'hideLoading',
    'setObjectivePoint', 'setExtractionPoint', 'setAlloy', 'setRunStats'];
  const missingApi = api.filter((m) => typeof hud[m] !== 'function');
  check('公开 API 完整（' + api.length + ' 项）', missingApi.length === 0, missingApi.join(','));
  check('onIntent 默认可用（null 安全）', hud.onIntent === null);

  const intents = [];
  hud.onIntent = (name, payload) => intents.push({ name, payload });

  hud.update(0.016);
  hud.render();
  eq('首次 update/render 后无异常', hud.lastError, null);
  check('canvas 罗盘确实被绘制', canvasCalls.length > 0, canvasCalls.length + ' 次 2D 调用');

  hud.setDebugPanelVisible(true);
  hud.update(0.016);
  hud.render();
  check('F3 调试面板写入 FPS', /^\d+$/.test(root.querySelector('#hud-debug-fps').textContent),
    root.querySelector('#hud-debug-fps').textContent);
  check('F3 调试面板写入实体数', /^\d+$/.test(root.querySelector('#hud-debug-entities').textContent),
    root.querySelector('#hud-debug-entities').textContent);
  check('F3 调试面板写入玩家坐标', root.querySelector('#hud-debug-pos').textContent.includes(','),
    root.querySelector('#hud-debug-pos').textContent);
  hud.setDebugPanelVisible(false);
}

const baselineNodes = countNodes(root);
const baselineCreated = mockStats.created;
let createdBeforeStress = 0;   // G3 压力开始前的节点创建快照（供 G7 断言）
section('构造后 DOM 节点数 = ' + baselineNodes + '，已创建节点累计 = ' + baselineCreated);

// ═══════════════════════════════════════════════════════════════════════════
// G2 — 防御性：缺失 ctx
// ═══════════════════════════════════════════════════════════════════════════
group('G2 缺失 ctx 的防御性（永不抛异常）');
{
  noThrow('new HUD(root, {}) 不抛异常', () => {
    const d2 = makeDocument();
    const r2 = makeRoot(d2);
    const h2 = new HUD(r2, {});
    eq('  空 ctx：visible 仍为 true', h2.visible, true);
    noThrow('  空 ctx：update/render 不抛异常', () => { h2.update(0.016); h2.render(); });
    eq('  空 ctx：无异常记录', h2.lastError, null);
    noThrow('  空 ctx：全菜单遍历不抛异常', () => {
      for (const k of ['main', 'pause', 'upgrade', 'dead', 'extract', 'settings', 'help', 'bogus', null]) {
        h2.showMenu(k);
        h2.render();
      }
      h2.hideMenu();
    });
    noThrow('  空 ctx：池接口不抛异常', () => {
      h2.toast('标题', '副标题', 'warn');
      h2.addKill('敌人被消灭', 'kill');
      h2.addDamageNumber(11, true, 10, 10);
      h2.addDamageNumber(NaN, false, undefined, undefined);
      h2.flashHitmarker('headshot');
      h2.setCrosshairStyle('dot');
      h2.setCrosshairStyle({ style: 'circle', color: '#ffb03a', scale: 1.5 });
      h2.setObjective('摧毁热核中继', 1, 3);
      h2.setExtraction(42);
      h2.setPrompt('按 F 补给');
      h2.showUpgradePanel(makeOffers(), 500);
      h2.hideUpgradePanel();
      h2.showLoading(0.5, '装载中');
      h2.hideLoading();
      h2.render();
    });
    eq('  空 ctx：全流程后无异常记录', h2.lastError, null);
    h2.dispose();
  });

  noThrow('new HUD(null, {}) 不抛异常（无 DOM 降级模式）', () => {
    const h3 = new HUD(null, {});
    eq('  无 root：visible = false', h3.visible, false);
    noThrow('  无 root：所有方法安全', () => {
      h3.update(0.016); h3.render(); h3.showMenu('main'); h3.hideMenu(); h3.toast('a', 'b', 'info');
      h3.addKill('x', 'kill'); h3.addDamageNumber(1, false, 3, 3); h3.flashHitmarker('kill');
      h3.setCrosshairStyle('cross'); h3.setObjective('o', 1, 2); h3.setExtraction(3);
      h3.showUpgradePanel(makeOffers(), 10); h3.hideUpgradePanel(); h3.setPrompt('p');
      h3.setDebugPanelVisible(true); h3.showLoading(0.1); h3.hideLoading(); h3.dispose();
    });
    eq('  无 root：无异常记录', h3.lastError, null);
  });

  noThrow('new HUD(root) 省略 ctx 不抛异常', () => {
    const d4 = makeDocument();
    const r4 = makeRoot(d4);
    const h4 = new HUD(r4);
    h4.update(0.016);
    h4.render();
    eq('  省略 ctx：无异常记录', h4.lastError, null);
    h4.dispose();
  });

  noThrow('子系统抛异常时 HUD 只记录不外抛', () => {
    const d5 = makeDocument();
    const r5 = makeRoot(d5);
    const boom = {
      get player() { throw new Error('player subsystem offline'); },
      get weapons() { throw new Error('weapons subsystem offline'); },
    };
    const h5 = new HUD(r5, boom);
    noThrow('  毒药 ctx：update/render 不抛异常', () => { h5.update(0.016); h5.render(); });
    check('  毒药 ctx：异常被捕获并记录', typeof h5.lastError === 'string', String(h5.lastError));
    h5.dispose();
  });

  const missingWeapon = makeCtx();
  missingWeapon.weapons.current = null;
  const d6 = makeDocument();
  const r6 = makeRoot(d6);
  const h6 = new HUD(r6, missingWeapon);
  h6.update(0.016);
  h6.render();
  eq('未装备武器时弹药显示占位符', r6.querySelector('#hud-ammo-current').textContent, '--');
  eq('未装备武器时无异常', h6.lastError, null);
  h6.dispose();
}

// ═══════════════════════════════════════════════════════════════════════════
// G3 — 600 帧压力（含边界用例）
// ═══════════════════════════════════════════════════════════════════════════
group('G3 600 帧 update/render 压力 + 边界用例');
{
  const p = ctx.player;
  const cur = ctx.weapons.current;
  createdBeforeStress = mockStats.created;
  let chipOk = true;
  let chipMismatch = '';
  let ammoOk = true;
  let shieldOk = true;
  let nodeOk = true;
  let maxNodes = 0;
  let createdDuring = 0;
  let throwCount = 0;
  const chipsSeen = new Set();
  const edgeHits = { zeroAmmo: 0, emptyReserve: 0, reloading: 0, dead: 0, maxSpeed: 0, negShield: 0, nanFields: 0 };

  const FRAMES = 600;
  for (let f = 0; f < FRAMES; f++) {
    const mode = f % 7;
    const st = p.state;
    let expectChip = 'GROUNDED';
    // 先复位到普通状态
    p.health = rand(0, 100);
    p.shield = rand(0, 100);
    p.alive = true;
    cur.ammo = randInt(0, 20);
    cur.reserve = randInt(0, 180);
    cur.reloading = false;
    cur.reloadProgress = 0;
    cur.spread = rand(0, 4.2);
    st.grounded = true; st.sliding = false; st.wallRunning = false; st.wallClimbing = false;
    st.mantling = false; st.dashing = false; st.grappleActive = false;
    st.dashCharges = 2; st.dashCooldownLeft = 0; st.grappleCooldownLeft = 0; st.airJumps = 1;
    st.speed = rand(0, 24);
    p.maxHealth = 100; p.maxShield = 100;

    if (mode === 0) {                       // 0 弹药 + 空备弹
      cur.ammo = 0; cur.reserve = 0; edgeHits.zeroAmmo++; edgeHits.emptyReserve++;
    } else if (mode === 1) {                // 换弹中
      cur.ammo = 0; cur.reserve = randInt(1, 180); cur.reloading = true;
      cur.reloadProgress = rng(); edgeHits.reloading++; edgeHits.zeroAmmo++;
    } else if (mode === 2) {                // 死亡
      p.health = 0; p.shield = 0; p.alive = false; cur.ammo = 0; cur.reserve = 0;
      st.grounded = false; expectChip = 'AIR'; edgeHits.dead++;
    } else if (mode === 3) {                // 60 m/s 极限速度 + 冲刺
      st.speed = 60; st.dashing = true; st.dashCharges = 0; st.dashCooldownLeft = rand(0, 0.9);
      expectChip = 'DASH'; edgeHits.maxSpeed++;
    } else if (mode === 4) {                // 负护盾 + 负生命
      p.shield = -12.5; p.health = -40; edgeHits.negShield++;
    } else if (mode === 5) {                // 字段缺失 / NaN
      cur.spread = NaN; cur.ammo = undefined; cur.reserve = null; st.speed = NaN;
      p.health = NaN; p.shield = undefined; p.maxHealth = undefined; p.maxShield = undefined;
      edgeHits.nanFields++;
    } else {
      // 状态 chip 全量扫描：顺带验证优先级 DASH > MANTLE > GRAPPLE > WALLRUN > SLIDE > AIR > GROUNDED
      const sweep = Math.floor(f / 7) % 7;
      if (sweep === 1) { st.sliding = true; expectChip = 'SLIDE'; }
      else if (sweep === 2) { st.wallRunning = true; st.sliding = true; expectChip = 'WALLRUN'; }
      else if (sweep === 3) { st.grounded = false; expectChip = 'AIR'; }
      else if (sweep === 4) { st.grappleActive = true; st.grounded = false; expectChip = 'GRAPPLE'; }
      else if (sweep === 5) { st.mantling = true; st.grappleActive = true; expectChip = 'MANTLE'; }
      else if (sweep === 6) { st.dashing = true; st.mantling = true; expectChip = 'DASH'; }
    }

    // 每帧制造一点 UI 活动
    if (f % 37 === 0) hud.addDamageNumber(rand(8, 60), rng() > 0.7, rand(200, 1600), rand(200, 800));
    if (f % 53 === 0) hud.flashHitmarker(['normal', 'headshot', 'kill'][f % 3]);
    if (f % 71 === 0) hud.addKill('清剿机兵 #' + f, ['kill', 'headshot', 'normal', 'warn'][f % 4]);
    if (f % 89 === 0) hud.toast('目标更新', '前往热核中继', ['info', 'warn', 'good'][f % 3]);
    if (f % 97 === 0) hud.setObjective('摧毁热核中继', f % 4, 4);
    if (f % 101 === 0) hud.setExtraction(f % 3 === 0 ? null : rand(0, 90));
    if (f % 113 === 0) hud.setPrompt(f % 2 ? '按 F 使用补给站' : null);
    if (f % 127 === 0) hud.setCrosshairStyle(['default', 'dot', 'cross', 'circle'][f % 4]);
    if (f % 149 === 0) hud.setObjectivePoint(new Float32Array([rand(-80, 80), 0, rand(-80, 80)]));

    try {
      hud.update(rand(0.001, 0.05));
      hud.render();
    } catch (err) {
      throwCount++;
    }

    const chip = root.querySelector('#hud-speed-state').textContent;
    chipsSeen.add(chip);
    if (chip !== expectChip) { chipOk = false; chipMismatch = 'frame ' + f + ' got ' + chip + ' want ' + expectChip; }
    if (!STATE_CHIPS.includes(chip)) chipOk = false;
    const ammoText = root.querySelector('#hud-ammo-current').textContent;
    if (!/^(\d+|--)$/.test(ammoText)) ammoOk = false;
    const shieldTf = root.querySelector('#hud-shield-fill').style.transform || '';
    const m = /scaleX\(([-\d.]+)\)/.exec(shieldTf);
    if (m && Number(m[1]) < 0) shieldOk = false;
    if (f % 50 === 0) {
      const n = countNodes(root);
      if (n > maxNodes) maxNodes = n;
      if (n > baselineNodes) nodeOk = false;
    }
  }
  createdDuring = mockStats.created - createdBeforeStress;

  eq('600 帧无异常抛出', throwCount, 0);
  eq('600 帧后 lastError 仍为 null', hud.lastError, null);
  check('状态 chip 与优先级推导完全一致', chipOk, chipMismatch || 'ok');
  check('状态 chip 始终是契约 7 值之一', STATE_CHIPS.every((c) => chipsSeen.has(c)), [...chipsSeen].join(' '));
  check('弹药文本始终是数字或占位符', ammoOk);
  check('护盾填充始终非负（负护盾被钳制）', shieldOk);
  check('压力期间节点数从未超过基线', nodeOk, 'max=' + maxNodes + ' baseline=' + baselineNodes);
  eq('压力期间未创建任何新 DOM 节点', createdDuring, 0);
  section('边界用例覆盖：0 弹药 ' + edgeHits.zeroAmmo + ' 次 / 空备弹 ' + edgeHits.emptyReserve +
    ' 次 / 换弹 ' + edgeHits.reloading + ' 次 / 死亡 ' + edgeHits.dead +
    ' 次 / 60m/s ' + edgeHits.maxSpeed + ' 次 / 负护盾 ' + edgeHits.negShield +
    ' 次 / NaN 字段 ' + edgeHits.nanFields + ' 次');
  section('状态 chip 全覆盖：' + [...chipsSeen].join(' / '));
}

// ═══════════════════════════════════════════════════════════════════════════
// G4 — 菜单
// ═══════════════════════════════════════════════════════════════════════════
group('G4 菜单：变体 / 键盘导航 / 点击 / 意图');
{
  const intents = [];
  hud.onIntent = (name, payload) => intents.push({ name, payload });
  const overlay = root.querySelector('#menu-overlay');

  for (const kind of ['main', 'pause', 'dead', 'extract', 'settings', 'help']) {
    intents.length = 0;
    hud.showMenu(kind);
    const panel = root.querySelector('#menu-' + kind);
    check('showMenu(' + kind + ') 只点亮对应面板',
      panel.classList.contains('menu-panel--on') && overlay.classList.contains('menu-overlay--on'),
      panel.className);
    const items = panel.querySelectorAll('.menu-item');
    check('  ' + kind + ' 含可点击菜单项 (' + items.length + ')', items.length >= 1);
    const nav = panel.querySelectorAll('.menu-item--nav');
    eq('  ' + kind + ' 默认高亮第一项', nav.length, 1);
  }

  // 键盘：↓ 移动高亮，Enter 触发意图
  hud.showMenu('main');
  intents.length = 0;
  const mainItems = root.querySelector('#menu-main').querySelectorAll('.menu-item');
  doc.dispatchEvent({ type: 'keydown', code: 'ArrowDown', key: 'ArrowDown' });
  check('ArrowDown 移动高亮', mainItems[1].classList.contains('menu-item--nav'));
  doc.dispatchEvent({ type: 'keydown', code: 'Enter', key: 'Enter' });
  eq('Enter 触发 resume 意图', intents.length && intents[0].name, 'resume');
  intents.length = 0;
  doc.dispatchEvent({ type: 'keydown', code: 'ArrowUp', key: 'ArrowUp' });
  doc.dispatchEvent({ type: 'keydown', code: 'Enter', key: 'Enter' });
  eq('ArrowUp 回到首项后 Enter 触发 start_run', intents.length && intents[0].name, 'start_run');

  // 点击
  // 2.0 主菜单：战役与局外军械库是真实入口，后续项目依次后移。
  intents.length = 0;
  mainItems[5].click();
  eq('点击菜单项发出 open_settings', intents.length && intents[0].name, 'open_settings');

  // 计划简报项
  intents.length = 0;
  mainItems[4].click();
  eq('点击「远征简报」发出 open_briefing', intents.length && intents[0].name, 'open_briefing');

  // 数字键
  intents.length = 0;
  doc.dispatchEvent({ type: 'keydown', code: 'Digit7', key: '7' });
  eq('数字键 7 触发 open_help', intents.length && intents[0].name, 'open_help');

  intents.length = 0;
  doc.dispatchEvent({ type: 'keydown', code: 'Digit8', key: '8' });
  eq('数字键 8 触发 open_lan', intents.length && intents[0].name, 'open_lan');

  intents.length = 0;
  doc.dispatchEvent({ type: 'keydown', code: 'Digit9', key: '9' });
  eq('数字键 9 触发 open_credits', intents.length && intents[0].name, 'open_credits');

  // 数字键 0 映射到第 10 项（退出游戏）
  intents.length = 0;
  doc.dispatchEvent({ type: 'keydown', code: 'Digit0', key: '0' });
  eq('数字键 0 触发 quit_game', intents.length && intents[0].name, 'quit_game');

  // Esc
  intents.length = 0;
  doc.dispatchEvent({ type: 'keydown', code: 'Escape', key: 'Escape' });
  eq('Esc 不重复发菜单意图（由 Game 单一状态机处理）', intents.length, 0);

  // 暂停菜单：放弃远征
  hud.showMenu('pause');
  intents.length = 0;
  root.querySelector('#menu-pause-item-3').click();
  eq('暂停菜单发出 quit_to_menu', intents.length && intents[0].name, 'quit_to_menu');

  intents.length = 0;
  root.querySelector('#menu-pause-item-4').click();
  eq('暂停菜单提供退出游戏并发出 quit_game', intents.length && intents[0].name, 'quit_game');

  hud.showMenu('main');
  intents.length = 0;
  root.querySelector('#menu-main-item-7').click();
  eq('主菜单提供局域网联机并发出 open_lan', intents.length && intents[0].name, 'open_lan');

  intents.length = 0;
  root.querySelector('#menu-main-item-8').click();
  eq('主菜单仍提供制作名单', intents.length && intents[0].name, 'open_credits');

  intents.length = 0;
  root.querySelector('#menu-main-item-9').click();
  eq('主菜单提供退出游戏并发出 quit_game', intents.length && intents[0].name, 'quit_game');

  // 阵亡统计
  ctx.run.stats = { kills: 23, headshots: 9, damage: 7350, timeSec: 611, tier: 3, alloy: 512 };
  hud.showMenu('dead');
  hud.render();
  eq('阵亡面板写入击杀数', root.querySelector('#menu-dead-stat-kills').textContent, '23');
  eq('阵亡面板写入时长', root.querySelector('#menu-dead-stat-time').textContent, '10:11');
  eq('阵亡面板写入合金', root.querySelector('#menu-dead-stat-alloy').textContent, '512');

  // 撤离结算（成功 / 失败）
  hud.showMenu('extract', { success: true, kills: 30, headshots: 11, damage: 9001, timeSec: 480, tier: 4, alloy: 800 });
  eq('撤离成功标题', root.querySelector('#menu-extract-title').textContent, '撤离成功');
  hud.showMenu('extract', { success: false });
  eq('撤离失败标题', root.querySelector('#menu-extract-title').textContent, '撤离失败');
  hud.showMenu('extract', { extracted: true });
  eq('extracted:true 视为成功', root.querySelector('#menu-extract-title').textContent, '撤离成功');

  // 设置：滑条 / 开关 / 下拉
  hud.showMenu('settings');
  const sens = root.querySelector('#menu-settings-input-sensitivity');
  sens.value = '0.0015';
  intents.length = 0;
  sens.dispatchEvent({ type: 'input' });
  eq('滑条 input 发出 set_sensitivity', intents.length && intents[0].name, 'set_sensitivity');
  eq('  set_sensitivity 携带数值', intents.length && intents[0].payload.value, 0.0015);
  eq('  灵敏度读数同步', root.querySelector('#menu-settings-value-sensitivity').textContent, '0.00150');

  const inv = root.querySelector('#menu-settings-input-invertY');
  inv.checked = true;
  intents.length = 0;
  inv.dispatchEvent({ type: 'change' });
  eq('Y 轴反转发出 set_invert_y', intents.length && intents[0].name, 'set_invert_y');
  eq('  set_invert_y 携带布尔值', intents.length && intents[0].payload.value, true);

  const cap = root.querySelector('#menu-settings-input-fpsCap');
  cap.value = '144';
  intents.length = 0;
  cap.dispatchEvent({ type: 'change' });
  eq('帧率上限发出 set_fps_cap', intents.length && intents[0].name, 'set_fps_cap');
  eq('  set_fps_cap 数值化', intents.length && intents[0].payload.value, 144);

  const vol = root.querySelector('#menu-settings-input-volume');
  vol.value = '0.35';
  intents.length = 0;
  vol.dispatchEvent({ type: 'input' });
  eq('音量滑条发出 set_volume', intents.length && intents[0].name, 'set_volume');

  const fov = root.querySelector('#menu-settings-input-fov');
  fov.value = '110';
  intents.length = 0;
  fov.dispatchEvent({ type: 'input' });
  eq('FOV 滑条发出 set_fov', intents.length && intents[0].name, 'set_fov');

  // 键盘调整设置
  hud.showMenu('settings');
  intents.length = 0;
  doc.dispatchEvent({ type: 'keydown', code: 'ArrowRight', key: 'ArrowRight' });
  eq('→ 调整当前设置项并发出意图', intents.length && intents[0].name, 'set_sensitivity');
  doc.dispatchEvent({ type: 'keydown', code: 'ArrowDown', key: 'ArrowDown' });
  intents.length = 0;
  doc.dispatchEvent({ type: 'keydown', code: 'ArrowRight', key: 'ArrowRight' });
  eq('↓ 后 → 调整 FOV', intents.length && intents[0].name, 'set_fov');

  // 帮助菜单键位表
  hud.showMenu('help');
  check('操作说明含键位表', root.querySelector('#menu-help').querySelectorAll('.menu-help-row').length >= 15);

  // 未知 kind 被忽略
  hud.hideMenu();
  hud.showMenu('nope');
  check('未知菜单 kind 被安全忽略', !overlay.classList.contains('menu-overlay--on'));
  eq('未知 kind 不产生异常', hud.lastError, null);

  // 升级面板 3 选 1
  hud.showMenu('upgrade');
  eq('showMenu(upgrade) 不显示菜单遮罩', overlay.classList.contains('menu-overlay--on'), false);
  hud.showUpgradePanel(makeOffers(), 300);
  hud.render();
  check('强化面板点亮', root.querySelector('#hud-upgrade').classList.contains('hud-upgrade--on'));
  eq('强化面板合金数', root.querySelector('#hud-upgrade-alloy-value').textContent, '300');
  eq('强化 1 名称', root.querySelector('#hud-offer-name-0').textContent, '枪管增压');
  eq('强化 1 价格', root.querySelector('#hud-offer-price-0').textContent, '合金 60');
  check('强化 1 稀有度着色 (rare)', root.querySelector('#hud-upgrade-card-0').classList.contains('hud-offer--rare'));
  check('强化 3 稀有度着色 (legendary)', root.querySelector('#hud-upgrade-card-2').classList.contains('hud-offer--legendary'));
  check('强化 3 价格超出合金 → 标记锁定', root.querySelector('#hud-upgrade-card-2').classList.contains('hud-offer--locked'));
  check('强化 1 协同提示可见', root.querySelector('#hud-offer-synergy-0').textContent.includes('协同'));
  eq('初始 selectedOfferIndex = -1', hud.selectedOfferIndex, -1);

  intents.length = 0;
  doc.dispatchEvent({ type: 'keydown', code: 'Digit2', key: '2' });
  eq('数字键 2 选择第二个强化', intents.length && intents[0].name, 'pick_upgrade');
  eq('  pick_upgrade 携带下标', intents.length && intents[0].payload.index, 1);
  eq('  pick_upgrade 携带 id', intents.length && intents[0].payload.id, 'slide_boost');
  eq('selectedOfferIndex 更新为 1', hud.selectedOfferIndex, 1);

  doc.dispatchEvent({ type: 'keydown', code: 'ArrowRight', key: 'ArrowRight' });
  eq('→ 高亮下一个强化', hud.selectedOfferIndex, 2);
  doc.dispatchEvent({ type: 'keydown', code: 'Enter', key: 'Enter' });
  eq('Enter 确认高亮强化', intents[intents.length - 1].payload.index, 2);

  intents.length = 0;
  doc.dispatchEvent({ type: 'keydown', code: 'KeyR', key: 'r' });
  eq('R 发出 reroll_upgrade', intents.length && intents[0].name, 'reroll_upgrade');

  intents.length = 0;
  root.querySelector('#hud-upgrade-reroll').click();
  eq('点击刷新按钮发出 reroll_upgrade', intents.length && intents[0].name, 'reroll_upgrade');

  intents.length = 0;
  root.querySelector('#hud-upgrade-skip').click();
  eq('点击“跳过并继续”发出 skip_upgrade', intents.length && intents[0].name, 'skip_upgrade');

  intents.length = 0;
  root.querySelector('#hud-upgrade-card-0').click();
  eq('点击强化卡发出 pick_upgrade', intents.length && intents[0].name, 'pick_upgrade');
  eq('  点击卡片选中下标 0', hud.selectedOfferIndex, 0);

  hud.hideUpgradePanel();
  check('hideUpgradePanel 关闭面板', !root.querySelector('#hud-upgrade').classList.contains('hud-upgrade--on'));
  eq('hideUpgradePanel 重置 selectedOfferIndex', hud.selectedOfferIndex, -1);

  hud.showMenu('dead');
  hud.hideMenu();
  check('hideMenu 关闭遮罩', !overlay.classList.contains('menu-overlay--on'));
  check('hideMenu 后无面板残留高亮', countClass(root, 'menu-panel--on') === 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// G5 — toast 队列有界
// ═══════════════════════════════════════════════════════════════════════════
group('G5 toast 队列有界（200 次调用）');
{
  const cont = root.querySelector('#hud-toasts');
  const before = countNodes(root);
  const createdBefore = mockStats.created;
  const kinds = ['info', 'warn', 'good', 'bogus-kind'];
  for (let i = 0; i < 200; i++) {
    hud.toast('提示 #' + i, '子系统报告 ' + i, kinds[i % kinds.length]);
    if (i % 25 === 0) {
      hud.update(0.4);
      hud.render();
    }
  }
  const after = countNodes(root);
  eq('toast 容器子节点数恒定 = 8', cont.children.length, 8);
  check('toast 容器子节点数 <= 池容量', cont.children.length <= 8, String(cont.children.length));
  eq('200 次 toast 未创建新节点', mockStats.created - createdBefore, 0);
  eq('200 次 toast 后总节点数不变', after, before);
  check('旧节点被回收复用（含最新一条）',
    cont.children.some((c) => c.querySelector('.hud-toast-title').textContent === '提示 #199'),
    cont.querySelector('.hud-toast-title').textContent);
  eq('活跃 toast 数不超过池容量', countClass(root, 'hud-toast--on') <= 8 ? countClass(root, 'hud-toast--on') : -1,
    countClass(root, 'hud-toast--on'));
  hud.update(6);
  hud.render();
  eq('全部过期后活跃 toast = 0（旧节点被摘除）', countClass(root, 'hud-toast--on'), 0);
  eq('过期后节点数仍不变', countNodes(root), before);
}

// ═══════════════════════════════════════════════════════════════════════════
// G6 — 伤害数字 / 命中标记
// ═══════════════════════════════════════════════════════════════════════════
group('G6 伤害数字与命中标记');
{
  const layer = root.querySelector('#hud-damage-numbers');
  const before = countNodes(root);
  const createdBefore = mockStats.created;
  let overPool = false;
  let maxActive = 0;
  for (let i = 0; i < 300; i++) {
    const useCoords = i % 3 !== 0;
    hud.addDamageNumber(randInt(8, 120), i % 5 === 0, useCoords ? rand(-500, 2600) : undefined, useCoords ? rand(-200, 1400) : undefined);
    hud.update(0.016);
    hud.render();
    const active = countClass(root, 'hud-dmg--on');
    if (active > maxActive) maxActive = active;
    if (active > 32) overPool = true;
    if (layer.children.length !== 32) overPool = true;
  }
  eq('伤害数字层容量恒定 = 32', layer.children.length, 32);
  check('同屏活跃伤害数字从未超过 32', !overPool, 'max active=' + maxActive);
  eq('300 次伤害数字未创建新节点', mockStats.created - createdBefore, 0);
  eq('伤害数字未增加总节点数', countNodes(root), before);
  check('最新伤害数字文本已写入',
    layer.children.some((c) => /^\d+$/.test(c.textContent)), layer.children[0].textContent);

  hud.update(2);
  hud.render();
  eq('过期后伤害数字全部落池', countClass(root, 'hud-dmg--on'), 0);

  const hm = root.querySelector('#hud-hitmarker');
  hud.flashHitmarker('normal');
  hud.render();
  check('普通命中标记点亮', hm.classList.contains('hud-hitmarker--on'));
  check('普通命中不带爆头样式', !hm.classList.contains('hud-hitmarker--headshot'));
  hud.flashHitmarker('headshot');
  hud.render();
  check('爆头命中标记样式', hm.classList.contains('hud-hitmarker--headshot') && hm.classList.contains('hud-hitmarker--on'));
  hud.flashHitmarker('kill');
  hud.render();
  check('击杀命中标记样式', hm.classList.contains('hud-hitmarker--kill') && hm.classList.contains('hud-hitmarker--on'));
  hud.update(1);
  hud.render();
  check('命中标记按寿命自动熄灭', !hm.classList.contains('hud-hitmarker--on'));
  eq('命中标记 opacity 归零', hm.style.opacity, '0');

  // 连杀计数
  const comboVal = root.querySelector('#hud-combo-value');
  for (let i = 0; i < 4; i++) hud.addKill('机兵被摧毁 #' + i, 'kill');
  hud.update(0.016);
  hud.render();
  eq('连杀计数累加', comboVal.textContent, '4');
  check('连杀 >= 2 时点亮', root.querySelector('#hud-combo').classList.contains('hud-combo--on'));
  hud.update(5);
  hud.render();
  eq('连杀窗口过期后归零', comboVal.textContent, '0');

  // 击杀播报池
  const feed = root.querySelector('#hud-killfeed');
  const createdBefore2 = mockStats.created;
  for (let i = 0; i < 80; i++) hud.addKill('清剿目标 #' + i, ['kill', 'headshot', 'normal', 'objective'][i % 4]);
  eq('击杀播报池容量恒定 = 6', feed.children.length, 6);
  eq('80 次击杀播报未创建新节点', mockStats.created - createdBefore2, 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// G7 — 节点预算
// ═══════════════════════════════════════════════════════════════════════════
group('G7 DOM 节点预算');
{
  const now = countNodes(root);
  const created = mockStats.created - createdBeforeStress;
  eq('压力测试后节点总数 == 构造基线', now, baselineNodes);
  eq('压力测试后累计创建节点数 == 压力前快照', created, 0);
  // In-game invitation form adds a fixed set of labelled controls; growth checks above remain unchanged.
  check('节点总数处于合理预算内 (<930)', now < 930, '节点数 = ' + now);
  section('构造基线节点数 = ' + baselineNodes + '；压力后 = ' + now + '；新增 = ' + created);
  section('其中：toast 8 / 击杀播报 6 / 伤害数字 32 为固定池节点');
}

// ═══════════════════════════════════════════════════════════════════════════
// G8 — 变更检测缓存
// ═══════════════════════════════════════════════════════════════════════════
group('G8 变更检测缓存（无变化时零 DOM 写入）');
{
  const d8 = makeDocument();
  const r8 = makeRoot(d8);
  const c8 = makeCtx();
  const h8 = new HUD(r8, c8);
  h8.update(0.016);
  h8.render();
  const t0 = mockStats.textWrites;
  const s0 = mockStats.styleWrites;
  h8.render();
  h8.render();
  const t1 = mockStats.textWrites;
  const s1 = mockStats.styleWrites;
  eq('连续 render() 无状态变化 → 0 次文本写入', t1 - t0, 0);
  eq('连续 render() 无状态变化 → 0 次样式写入', s1 - s0, 0);

  // 状态真的改变时必须写入
  c8.weapons.current.ammo = 7;
  c8.player.health = 42;
  h8.render();
  check('状态变化后文本被更新', mockStats.textWrites - t1 >= 2, 'writes=' + (mockStats.textWrites - t1));

  // 调试面板开启时也要保持缓存语义
  h8.setDebugPanelVisible(true);
  h8.update(0.2);
  h8.render();
  const t2 = mockStats.textWrites;
  const s2 = mockStats.styleWrites;
  h8.render();
  eq('调试面板开启时重复 render 仍 0 文本写入', mockStats.textWrites - t2, 0);
  eq('调试面板开启时重复 render 仍 0 样式写入', mockStats.styleWrites - s2, 0);

  // 罗盘：朝向不变时不重绘 canvas
  const calls0 = canvasCalls.length;
  h8.render();
  eq('罗盘朝向未变时不重绘 canvas', canvasCalls.length - calls0, 0);
  c8.player.yaw += 0.4;
  // 朝向由 forward 主导（契约：forward 是相机基向量），转身时两者一起变
  c8.player.forward[0] = Math.sin(c8.player.yaw);
  c8.player.forward[2] = -Math.cos(c8.player.yaw);
  h8.render();
  check('罗盘朝向改变后重绘 canvas', canvasCalls.length - calls0 > 0, (canvasCalls.length - calls0) + ' 次调用');

  eq('缓存测试期间无异常', h8.lastError, null);
  h8.dispose();
}

// ═══════════════════════════════════════════════════════════════════════════
// G9 — CSS 解析检查
// ═══════════════════════════════════════════════════════════════════════════
group('G9 styles/hud.css 结构检查');
{
  let css = '';
  noThrow('读取 styles/hud.css', () => { css = readFileSync(CSS_PATH, 'utf8'); });
  check('CSS 文件非空', css.length > 1000, css.length + ' 字节');

  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0;
  let minDepth = 0;
  for (const ch of stripped) {
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth < minDepth) minDepth = depth; }
  }
  eq('花括号平衡（无多余 } ）', minDepth, 0);
  eq('花括号平衡（结尾闭合为 0）', depth, 0);

  const rules = parseCss(stripped);
  const declRules = rules.filter((r) => r.body.trim() !== '');
  section('CSS 规则数 = ' + declRules.length + '（其中顶层规则 ' + declRules.filter((r) => r.context === '').length + '）');

  // 重复选择器（同一上下文内）
  const seen = new Map();
  const dups = [];
  for (const r of declRules) {
    for (const sel of r.selector.split(',')) {
      const key = r.context + '||' + sel.replace(/\s+/g, ' ').trim();
      if (seen.has(key)) dups.push(key);
      else seen.set(key, true);
    }
  }
  eq('无重复选择器（同一上下文内）', dups.length, 0, dups.slice(0, 5).join(' | '));

  check('未使用 @import', !/@import/.test(css));
  check('未引用任何外部 URL', !/url\(\s*['"]?https?:/i.test(css));
  check('字体栈为系统字体（含 Barlow Condensed 回退链）',
    css.includes("'Barlow Condensed', 'Rajdhani', 'Segoe UI', system-ui, sans-serif"));
  check('调色板自定义属性齐全',
    ['--hud-base:', '--hud-cold:', '--hud-warn:', '--hud-amber:'].every((v) => css.includes(v)));
  check('调色板取值符合设计规范',
    css.includes('#0b0e12') && css.includes('#7fe3ff') && css.includes('#ff5a4a') && css.includes('#ffb03a'));
  check('前缀规范：hud- / menu- / load-',
    declRules.filter((r) => r.context === '').every((r) =>
      r.selector.split(',').every((s) => /^(#hud|#menu|#load|:root|\.hud-|\.menu-|\.load-)/.test(s.trim()))));

  // 只允许 transform / opacity 动画
  const badTransitions = [];
  const badKeyframes = [];
  for (const r of declRules) {
    for (const decl of r.body.split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const prop = decl.slice(0, i).trim().toLowerCase();
      const val = decl.slice(i + 1).trim();
      if (prop === 'transition' || prop === 'transition-property') {
        for (const part of val.split(',')) {
          const token = part.trim().split(/\s+/)[0];
          if (token && token !== 'transform' && token !== 'opacity' && token !== 'none') {
            badTransitions.push(r.selector + ' { ' + prop + ': ' + val + ' }');
          }
        }
      }
      if (r.context.startsWith('@keyframes')) {
        if (prop !== 'transform' && prop !== 'opacity') badKeyframes.push(r.context + ' ' + r.selector + ' { ' + prop + ' }');
      }
    }
  }
  eq('transition 只作用于 transform / opacity', badTransitions.length, 0, badTransitions.slice(0, 3).join(' | '));
  eq('@keyframes 只动画 transform / opacity', badKeyframes.length, 0, badKeyframes.slice(0, 3).join(' | '));

  const noLayoutAnim = declRules.every((r) => {
    if (!r.context.startsWith('@keyframes')) return true;
    return !/(^|;)\s*(width|height|top|left|right|bottom|margin|padding)\s*:/.test(r.body);
  });
  check('@keyframes 未动画布局属性', noLayoutAnim);
}

function parseCss(src) {
  const rules = [];
  const stack = [];
  let buf = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '{') {
      stack.push(buf.trim());
      buf = '';
    } else if (ch === '}') {
      const head = stack.pop() || '';
      const body = buf;
      buf = '';
      rules.push({ selector: head, body, context: stack.join(' >> ') });
    } else {
      buf += ch;
    }
    i++;
  }
  return rules;
}

// ═══════════════════════════════════════════════════════════════════════════
// G10 — dispose
// ═══════════════════════════════════════════════════════════════════════════
group('G10 dispose：监听器与节点全部摘除');
{
  const d10 = makeDocument();
  const r10 = makeRoot(d10);
  const c10 = makeCtx();
  const listenersBefore = mockStats.listeners;
  const h10 = new HUD(r10, c10);
  const intents = [];
  h10.onIntent = (name) => intents.push(name);
  h10.update(0.016);
  h10.render();
  check('构造后注册了监听器', mockStats.listeners > listenersBefore, '+' + (mockStats.listeners - listenersBefore));

  h10.showMenu('main');
  r10.querySelector('#menu-main-item-0').click();
  eq('销毁前点击可以发出意图', intents.length, 1);

  h10.dispose();
  eq('dispose 后监听器全部摘除', mockStats.listeners, listenersBefore);
  eq('dispose 后 root 无子节点', r10.children.length, 0);
  eq('dispose 后 visible = false', h10.visible, false);

  intents.length = 0;
  d10.dispatchEvent({ type: 'keydown', code: 'F3', key: 'F3' });
  d10.dispatchEvent({ type: 'keydown', code: 'ArrowDown', key: 'ArrowDown' });
  eq('dispose 后键盘事件不再产生意图', intents.length, 0);

  noThrow('dispose 后所有方法调用安全', () => {
    h10.update(0.016); h10.render(); h10.showMenu('main'); h10.hideMenu(); h10.toast('a', 'b', 'info');
    h10.addKill('x', 'kill'); h10.addDamageNumber(5, true, 1, 1); h10.flashHitmarker('kill');
    h10.setCrosshairStyle('dot'); h10.setObjective('o', 1, 2); h10.setExtraction(9);
    h10.showUpgradePanel(makeOffers(), 10); h10.hideUpgradePanel(); h10.setPrompt('p');
    h10.setDebugPanelVisible(true); h10.showLoading(0.2); h10.hideLoading(); h10.dispose();
  });
  eq('重复 dispose 幂等', r10.children.length, 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// G11 — 加载遮罩
// ═══════════════════════════════════════════════════════════════════════════
group('G11 加载遮罩（接管 index.html 静态遮罩）');
{
  // 场景 A：index.html 已带静态遮罩 → HUD 复用它，dispose 时不得删除
  const dA = makeDocument();
  const rA = makeRoot(dA);
  const staticOverlay = dA.createElement('div');
  staticOverlay.id = 'load-overlay';
  staticOverlay.className = 'load-overlay';
  const staticText = dA.createElement('div');
  staticText.id = 'load-text';
  staticText.textContent = '初始化…';
  staticOverlay.appendChild(staticText);
  rA.appendChild(staticOverlay);

  const hA = new HUD(rA, makeCtx());
  eq('复用 index.html 的静态遮罩节点', hA.el.loadOverlay === staticOverlay, true);
  noThrow('showLoading(0.42, ...) 不抛异常', () => hA.showLoading(0.42, '生成熔炉世界…'));
  eq('进度百分比写入', rA.querySelector('#load-pct').textContent, '42%');
  eq('进度条 scaleX 写入', rA.querySelector('#load-bar').style.transform, 'scaleX(0.4200)');
  eq('加载文案写入', rA.querySelector('#load-text').textContent, '生成熔炉世界…');
  eq('加载中 visible = false', hA.visible, false);
  hA.hideLoading();
  check('hideLoading 标记完成态', rA.querySelector('#load-overlay').classList.contains('load-overlay--done'));
  eq('加载完成 visible = true', hA.visible, true);
  hA.dispose();
  check('dispose 不删除 index.html 的静态遮罩', rA.querySelector('#load-overlay') !== null);

  // 场景 B：没有静态遮罩 → HUD 自建并在 dispose 时移除
  const dB = makeDocument();
  const rB = makeRoot(dB);
  const hB = new HUD(rB, makeCtx());
  check('自建加载遮罩', rB.querySelector('#load-overlay') !== null);
  hB.showLoading(1, '完成');
  eq('100% 进度', rB.querySelector('#load-pct').textContent, '100%');
  hB.dispose();
  eq('dispose 移除自建遮罩', rB.querySelector('#load-overlay'), null);
}

// ═══════════════════════════════════════════════════════════════════════════
// 汇总
// ═══════════════════════════════════════════════════════════════════════════
hud.dispose();

process.stdout.write('\n── 分组结果 ──\n');
for (const g of groupStats) {
  const verdict = g.fail === 0 ? 'PASS' : 'FAIL';
  process.stdout.write('  ' + verdict + '  ' + g.title + '  (' + g.pass + '/' + (g.pass + g.fail) + ')\n');
}
process.stdout.write('\nHUD SELF-TEST: ' + totalPass + '/' + (totalPass + totalFail) + ' passed\n');
process.exit(totalFail === 0 ? 0 : 1);
