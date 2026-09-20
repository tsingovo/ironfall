// ==== core/input.js — 键鼠输入：动作映射 / 指针锁定 / 帧累积增量 ====
// 关键设计：
//  1) 键位可重绑定，动作名与 game 逻辑解耦。
//  2) 鼠标增量按帧累积，物理固定步消费同一份增量并按步数分摊（保证不同帧率手感一致）。
//  3) 支持"自动化模式"：无指针锁定时仍可读输入，供无头测试脚本注入。

import { clamp } from './math.js';

/** 默认动作 -> KeyboardEvent.code 映射（可重绑） */
export const ACTIONS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  crouch: ['ControlLeft', 'KeyC'],
  // 需求：默认冲刺键改为 V。
  // 注意 V 原本是近战，因此近战挪到相邻的 B（避开已占用的 R/B? —— B 是充能键，
  // 所以近战用 KeyF）。同时保留 ShiftLeft 作为等价键，老习惯不会失效。
  sprint: ['KeyV', 'ShiftLeft'],
  reload: ['KeyR'],
  charge: ['KeyB'],
  // Apex 风格：Q 是战术技能；IRONFALL 额外 dash 放 Alt，避免抢占核心键。
  dash: ['AltLeft'],
  grapple: ['KeyQ'],
  // 近战：因冲刺占用 V 而改到 F（F 原本空闲）
  melee: ['KeyF'],
  interact: ['KeyE'],
  // Apex 风格治疗键：轻按使用当前选中的药品，长按打开药品轮盘。
  heal: ['Digit5'],
  swap: [],
  weapon1: ['Digit1'],
  weapon2: ['Digit2'],
  // 3 固定为近战槽，4 为额外武器槽（默认哨兵），与搜打撤背包负载栏一致。
  weapon3: ['Digit3'],
  weapon4: ['Digit4'],
  upgrade1: ['Digit1'],
  upgrade2: ['Digit2'],
  upgrade3: ['Digit3'],
  pause: ['Escape'],
  map: ['KeyM'],
  stats: ['F3'],
  freecam: ['KeyN'],
  debugKill: ['KeyK'],
  fire: [],
  ads: [],
};

/** 鼠标按钮 -> 动作（0 左 1 中 2 右） */
const MOUSE_ACTIONS = {
  fire: [0],
  ads: [2],
};

const MAX_MOUSE_DELTA = 260;   // 单帧跳变保护（防抖 / 切窗口回来）
const MAX_PENDING_DELTA = 400; // 累积上限，避免卡顿后甩飞

const down = new Set();
const pressedSet = new Set();
const releasedSet = new Set();

const mouseBtnDown = [false, false, false, false, false];
const mouseBtnPressed = [false, false, false, false, false];
const mouseBtnReleased = [false, false, false, false, false];

let _dx = 0, _dy = 0, _wheel = 0;
let _locked = false;
let _automation = false;
let _canvas = null;
let _lastLockError = null;
/** 游玩中（用于决定是否吞掉浏览器快捷键）；由 game 设置 */
let _playing = false;
/** 菜单覆盖层打开中：屏蔽游戏动作输入；世界是否暂停由 Game 统一管理 */
let _menuBlocking = false;
/** 键盘事件收到过"真实"按键（用来区分合成事件与用户操作） */
let _sawRealKey = false;
/** 用户手势回调表（首次同步触发，保证音频能在手势内初始化） */
const gestureHandlers = [];

function fireGesture() {
  for (let i = gestureHandlers.length - 1; i >= 0; i--) {
    const h = gestureHandlers[i];
    try { h.fn(); } catch (_e) { /* 手势回调不允许打断输入处理 */ }
    if (!h.repeat) gestureHandlers.splice(i, 1);
  }
}

/** 动作 -> { codes:Set, mouse:Set } */
const bindings = new Map();
let sensitivity = 0.0012;   // 弧度/像素；低敏默认，约 0.069°/count
// 狙击镜独立灵敏度倍率。狙击枪的 4× 视野会放大手部抖动，默认降到
// 35%，同时保留普通腰射/机瞄的原有灵敏度。设置菜单可单独调整。
let sniperSensitivity = 0.35;
let invertY = false;
let sprintToggleEnabled = true;
let sprintHeld = false;     // 冲刺的切换状态
let _listeners = [];

function buildBindings() {
  bindings.clear();
  for (const name of Object.keys(ACTIONS)) {
    bindings.set(name, { codes: new Set(ACTIONS[name]), mouse: new Set(MOUSE_ACTIONS[name] || []) });
  }
}

// 模块加载时立即构建默认键位表。
// 这一点很关键：actionDown/actionPressed 全部依赖 bindings，
// 若等到 init() 才构建，而调用方忘了 init()，整个游戏会「完全收不到输入」
// 却没有任何报错 —— 极难排查。所以默认键位必须在模块求值时就可用。
buildBindings();

export const Input = {
  init(canvas) {
    _canvas = canvas || null;
    buildBindings();
    attach();
    return Input;
  },

  /** 每帧开始：清空"本帧按下/抬起"之外的瞬时状态由 endFrame 处理 */
  update(_dt) {
    // 目前无需插值；保留接口以便将来支持手柄
  },

  /** 每帧结束：清空 justPressed / justReleased 与鼠标增量 */
  endFrame() {
    pressedSet.clear();
    releasedSet.clear();
    for (let i = 0; i < 5; i++) { mouseBtnPressed[i] = false; mouseBtnReleased[i] = false; }
    _dx = 0; _dy = 0; _wheel = 0;
  },

  /**
   * 只消费鼠标增量（不清按键的按下/抬起边沿）。
   * 固定步循环里每个物理步都要消费一次增量，但边沿状态必须跨步保持，
   * 否则"本帧按下的键"会在第一个物理步之后消失 —— 会导致跳跃/换弹等边沿动作丢失。
   */
  consumeMouseDeltaOnly() {
    _dx = 0; _dy = 0; _wheel = 0;
  },

  // ------------------------------------------------------------ 指针锁定
  /**
   * 请求指针锁定。
   * 注意：不要传 `{unadjustedMovement:false}` —— 老版本浏览器不认识这个字典，
   * Chrome 会直接抛 TypeError，等于"点开始后鼠标完全不能转视角"。
   * 想用未加速移动的设备才需要传，且必须做特性检测。
   */
  requestLock() {
    if (_automation) return false;
    const el = _canvas;
    if (!el) return false;
    const fn = el.requestPointerLock || el.mozRequestPointerLock || el.webkitRequestPointerLock;
    if (!fn) { _lastLockError = 'NO_API'; _fallbackLook = true; return false; }
    try {
      // 部分实现返回 Promise（新版规范），失败时给出原因而不是静默无声
      const r = fn.call(el);
      if (r && typeof r.catch === 'function') {
        r.catch((e) => {
          _lastLockError = (e && e.name) || 'REJECTED';
          _fallbackLook = true;      // 锁定被拒 → 立刻启用兜底视角
          Input._syncBodyClasses();
        });
      }
      return true;
    } catch (e) {
      _lastLockError = (e && e.name) || 'THREW';
      // 退一步：不带参数再试一次（某些实现只接受无参调用）
      try { fn.call(el); return true; } catch (_e2) { _fallbackLook = true; return false; }
    }
  },

  exitLock() {
    if (document.exitPointerLock) document.exitPointerLock();
  },

  get locked() { return _locked || _automation; },
  get pointerLocked() { return _locked; },
  get automation() { return _automation; },
  /** 指针锁定最近一次失败原因（用于给玩家可见提示） */
  get lastLockError() { return _lastLockError; },
  /** 是否处于"指针锁定不可用"的兜底视角模式 */
  get fallbackLook() { return _fallbackLook; },
  setFallbackLook(b) { _fallbackLook = !!b; },
  get autoRecenter() { return _autoRecenter; },
  /** 光标贴边时自动把窗口挪回中心（默认关；只影响兜底模式） */
  setAutoRecenter(b) { _autoRecenter = !!b; },

  /**
   * 设置"是否在游玩中"。
   * 游玩中才吞浏览器快捷键；暂停/菜单里应该让浏览器正常工作（刷新、控制台）。
   */
  /**
   * 菜单面板打开时屏蔽"游戏动作"输入（移动/跳跃/开火/换弹…）。
   * 暂停与恢复由 Game 的 Escape 单一状态机负责；这里仅负责清理并隔离输入，
   * 避免关闭菜单后残留“一直按着 W”或在菜单里误开枪。
   */
  setMenuBlocking(b) {
    _menuBlocking = !!b;
    if (_menuBlocking) {
      // 清掉按下状态，避免关闭菜单后残留"一直按着 W"
      down.clear();
      pressedSet.clear();
      releasedSet.clear();
      for (let i = 0; i < 5; i++) { mouseBtnDown[i] = false; mouseBtnPressed[i] = false; mouseBtnReleased[i] = false; }
    }
  },
  get menuBlocking() { return _menuBlocking; },

  setPlaying(b) {
    _playing = !!b;
    Input._syncBodyClasses();
  },
  get playing() { return _playing; },

  /** 同步 body 上的指针锁定相关类名（供 CSS 控制系统光标） */
  _syncBodyClasses() {
    try {
      if (!document.body || !document.body.classList) return;
      const cl = document.body.classList;
      cl.toggle('is-playing', _playing);
      cl.toggle('pointer-locked', _locked);
      // 不再显示“点击进入战场”遮罩；锁定失败时直接进入兜底视角。
      cl.remove('needs-lock');
      cl.toggle('fallback-look', _playing && !_locked && _fallbackLook);
    } catch (_e) { /* 忽略 */ }
  },

  setAutomationMode(b) {
    _automation = !!b;
    if (_automation) {
      _locked = false;
      _playing = true;
    }
    Input._syncBodyClasses();
    return _automation;
  },

  // ------------------------------------------------------------ 键盘
  down(code) { return down.has(code); },
  pressed(code) { return pressedSet.has(code); },
  released(code) { return releasedSet.has(code); },

  actionDown(name) {
    const b = bindings.get(name);
    if (!b) return false;
    for (const c of b.codes) if (down.has(c)) return true;
    for (const m of b.mouse) if (mouseBtnDown[m]) return true;
    if (name === 'sprint') {
      for (const c of b.codes) if (down.has(c)) return true;
      if (sprintToggleEnabled && sprintHeld) return true;
    }
    return false;
  },

  actionPressed(name) {
    const b = bindings.get(name);
    if (!b) return false;
    for (const c of b.codes) if (pressedSet.has(c)) return true;
    for (const m of b.mouse) if (mouseBtnPressed[m]) return true;
    return false;
  },

  actionReleased(name) {
    const b = bindings.get(name);
    if (!b) return false;
    for (const c of b.codes) if (releasedSet.has(c)) return true;
    for (const m of b.mouse) if (mouseBtnReleased[m]) return true;
    return false;
  },

  setBinding(name, codes, mouseButtons) {
    let b = bindings.get(name);
    if (!b) { b = { codes: new Set(), mouse: new Set() }; bindings.set(name, b); }
    b.codes = new Set(codes || []);
    b.mouse = new Set(mouseButtons || []);
    ACTIONS[name] = (codes || []).slice();
  },

  getBindings() {
    const out = {};
    for (const [k, v] of bindings) out[k] = { codes: [...v.codes], mouse: [...v.mouse] };
    return out;
  },

  get sprintToggle() { return sprintToggleEnabled; },
  setSprintToggle(b) { sprintToggleEnabled = !!b; sprintHeld = false; },
  get sprintLatched() { return sprintHeld; },
  setSprintLatched(b) { sprintHeld = !!b; },

  // ------------------------------------------------------------ 鼠标
  get mouseDX() { return _dx; },
  get mouseDY() { return _dy; },
  get wheel() { return _wheel; },

  mouseDown(btn) { return !!mouseBtnDown[btn]; },
  mousePressed(btn) { return !!mouseBtnPressed[btn]; },
  mouseReleased(btn) { return !!mouseBtnReleased[btn]; },

  /** 消费本帧鼠标增量（读取后不清零，由 endFrame 统一清） */
  consumeMouseDelta(out2) {
    if (out2) { out2[0] = _dx; out2[1] = _dy; return out2; }
    return [_dx, _dy];
  },

  // ------------------------------------------------------------ 灵敏度
  get sensitivity() { return sensitivity; },
  setSensitivity(v) { sensitivity = clamp(Number(v) || 0, 0.00005, 0.01); },
  get sensitivityDegPerCount() { return sensitivity * 180 / Math.PI; },
  get sniperSensitivity() { return sniperSensitivity; },
  setSniperSensitivity(v) {
    const n = Number(v);
    sniperSensitivity = clamp(Number.isFinite(n) ? n : 0.35, 0.05, 1);
  },
  get invertY() { return invertY; },
  setInvertY(v) { invertY = !!v; },
  get rawInput() { return true; },

  // ------------------------------------------------------------ 自动化注入（无头测试）
  /** 供测试脚本直接注入状态；不经过 DOM */
  _injectKey(code, isDown) {
    if (isDown) {
      if (!down.has(code)) pressedSet.add(code);
      down.add(code);
    } else {
      if (down.has(code)) releasedSet.add(code);
      down.delete(code);
    }
  },
  _injectMouse(btn, isDown) {
    if (btn < 0 || btn > 4) return;
    if (isDown) { if (!mouseBtnDown[btn]) mouseBtnPressed[btn] = true; mouseBtnDown[btn] = true; }
    else { if (mouseBtnDown[btn]) mouseBtnReleased[btn] = true; mouseBtnDown[btn] = false; }
  },
  _injectLook(dx, dy) {
    _dx = clamp(_dx + dx, -MAX_PENDING_DELTA, MAX_PENDING_DELTA);
    _dy = clamp(_dy + dy, -MAX_PENDING_DELTA, MAX_PENDING_DELTA);
  },
  _injectWheel(d) { _wheel += d; },
  _resetAll() {
    down.clear(); pressedSet.clear(); releasedSet.clear();
    for (let i = 0; i < 5; i++) { mouseBtnDown[i] = false; mouseBtnPressed[i] = false; mouseBtnReleased[i] = false; }
    _dx = 0; _dy = 0; _wheel = 0; sprintHeld = false;
  },

  dispose() {
    for (const [t, fn, opt] of _listeners) {
      const target = t === 'keydown' || t === 'keyup' ? window : (_canvas || window);
      try { target.removeEventListener(t, fn, opt); } catch (_e) { /* 忽略 */ }
    }
    _listeners = [];
    _resetAll();
  },

  /**
   * 注册"用户手势"回调：在首次真实点击/按键时同步触发一次。
   *
   * 为什么需要：AudioContext 必须在用户手势的**同一个同步调用栈**里创建/恢复，
   * 否则会被浏览器拒绝并一直停在 suspended（表现为"完全没有音效"且不报错）。
   * 这个钩子保证我们能在最早的合法时机把音频拉起来。
   *
   * 返回取消注册函数。allowRepeat=true 时每次手势都会触发（用于持续重试恢复）。
   */
  onGesture(fn, allowRepeat) {
    if (typeof fn !== 'function') return () => {};
    gestureHandlers.push({ fn, repeat: !!allowRepeat });
    return () => {
      const i = gestureHandlers.indexOf(fn === null ? null : gestureHandlers.find((h) => h.fn === fn));
      if (i >= 0) gestureHandlers.splice(i, 1);
    };
  },
};

// ---------------------------------------------------------------- DOM 绑定

/**
 * 指针锁定失败时的鼠标视角兜底。
 *
 * 背景：`requestPointerLock()` 在部分环境会直接失败
 * （实测 headless Chrome 恒定返回 WrongDocumentError；某些扩展、远程桌面、
 *  嵌入式 WebView 同样会失败）。一旦失败便启用无锁定兜底，避免游戏失去视角控制。
 *
 * 兜底策略（仅在原生锁定不可用时启用，正常浏览器不会走到这里）：
 *   不要求指针锁定，直接读 mousemove 的原始位移来转视角，光标保持可见。
 *   代价是光标会撞到屏幕边缘，需要抬手重新滑 —— 可用但不如锁定顺手。
 *   可选 `setAutoRecenter(true)` 会在光标贴边时把窗口挪回中心以换取无限转动，
 *   默认关闭（移动窗口对用户来说过于突兀）。
 *
 * 这是"尽力而为"的降级模式，不是等价替代；README 里已说明。
 */
let _fallbackLook = false;
let _autoRecenter = false;
let _lastRecenter = 0;

function shouldUseFallbackLook() {
  // 自动化模式不需要（测试直接注入增量）
  return _playing && !_automation && !_locked && _fallbackLook;
}

/** 光标贴近屏幕边缘时把窗口挪回中心，换取继续转动的空间（可选） */
function maybeRecenter(e) {
  if (!_autoRecenter) return;
  const now = Date.now();
  if (now - _lastRecenter < 250) return;
  const nearEdge = e.screenX <= 2 || e.screenY <= 2
    || e.screenX >= window.screen.width - 3 || e.screenY >= window.screen.height - 3;
  if (!nearEdge) return;
  _lastRecenter = now;
  try {
    if (typeof window.moveTo === 'function') {
      // 目标：让光标回到视口中心
      window.moveTo(
        Math.round(e.screenX - window.innerWidth / 2),
        Math.round(e.screenY - window.innerHeight / 2)
      );
    }
  } catch (_err) { /* 多屏/权限受限：放弃自动回中，只是少了无限转动空间 */ }
}

function attach() {
  add('keydown', onKeyDown);
  add('keyup', onKeyUp);
  add('mousemove', onMouseMove);
  add('mousedown', onMouseDown);
  add('mouseup', onMouseUp);
  add('wheel', onWheel, { passive: false });
  add('contextmenu', onContextMenu);
  add('blur', onBlur);
  add('pointerlockchange', onLockChange);
  add('pointerlockerror', onLockError);
}

function add(type, fn, opt) {
  if (type === 'pointerlockchange' || type === 'pointerlockerror') {
    document.addEventListener(type, fn);
    _listeners.push([type, fn, undefined, document]);
    return;
  }
  const target = (type === 'keydown' || type === 'keyup' || type === 'blur') ? window : (_canvas || window);
  target.addEventListener(type, fn, opt);
  _listeners.push([type, fn, opt]);
}

/**
 * 游戏内需要吞掉默认行为的按键。
 * 目的：避免误触发浏览器自身行为（滚动、焦点跳转、快速查找、打印、下载…）。
 * 注意 Ctrl+W / Ctrl+T / Ctrl+N / F11 / F12 属于浏览器保留快捷键，
 * 网页**无法**拦截；独立启动器用 kiosk app 窗口隔离这些浏览器行为。
 */
const BLOCK_DEFAULT = new Set([
  'Space', 'Tab',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'PageUp', 'PageDown', 'Home', 'End',
  'F1', 'F3',
  'Slash', 'Quote', 'Backquote',
  'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide',
  'Minus', 'Equal',
]);

/**
 * 这些键在**游玩中**要阻止默认行为（未游玩时留给浏览器，便于刷新/开控制台调试）。
 * 例如 F5 刷新、Ctrl+S 保存页面、Ctrl+P 打印、Ctrl+D 收藏、Ctrl+F 查找、Ctrl+O 打开文件。
 */
const PLAY_BLOCK_CODES = new Set([
  'F5', 'F6', 'F7', 'Backspace',
  'KeyS', 'KeyP', 'KeyD', 'KeyF', 'KeyG', 'KeyO', 'KeyU', 'KeyJ', 'KeyH', 'KeyE', 'KeyL', 'KeyN', 'KeyT', 'KeyW', 'KeyR', 'KeyA', 'KeyB', 'KeyI', 'KeyK', 'KeyM', 'KeyQ', 'KeyV', 'KeyX', 'KeyY', 'KeyZ', 'KeyC',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0',
]);

function shouldBlock(e) {
  if (_locked) return true;                       // 指针锁定时一律吞掉（Tab/空格/方向键会破坏游戏）
  if (!_playing) return false;                    // 不在游玩中就不干扰浏览器
  if (e.code === 'F12') return false;             // 永远留一个开控制台的出口
  if (e.ctrlKey || e.metaKey) {
    // 游玩中拦住常见的浏览器动作；Ctrl+W/T/N 拦不住也无妨（浏览器优先）
    return PLAY_BLOCK_CODES.has(e.code);
  }
  if (e.altKey) return false;
  return BLOCK_DEFAULT.has(e.code) || PLAY_BLOCK_CODES.has(e.code);
}

function onKeyDown(e) {
  fireGesture();
  if (shouldBlock(e)) e.preventDefault();
  if (e.repeat) return;
  if (!down.has(e.code)) pressedSet.add(e.code);
  down.add(e.code);
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
    // 切换式冲刺：按下瞬间翻转
    if (sprintToggleEnabled) sprintHeld = !sprintHeld;
  }
}

function onKeyUp(e) {
  if (shouldBlock(e)) e.preventDefault();
  if (down.has(e.code)) releasedSet.add(e.code);
  down.delete(e.code);
}

function onMouseMove(e) {
  // 正常路径：指针已锁定，直接吃 movementX/Y
  if (_locked) {
    let dx = e.movementX || 0;
    let dy = e.movementY || 0;
    if (Math.abs(dx) > MAX_MOUSE_DELTA || Math.abs(dy) > MAX_MOUSE_DELTA) return;
    _dx = clamp(_dx + dx, -MAX_PENDING_DELTA, MAX_PENDING_DELTA);
    _dy = clamp(_dy + dy, -MAX_PENDING_DELTA, MAX_PENDING_DELTA);
    return;
  }
  // 兜底路径：指针锁定不可用，但仍要能转视角（光标保持可见）
  if (shouldUseFallbackLook()) {
    const dx = e.movementX || 0;
    const dy = e.movementY || 0;
    if (Math.abs(dx) > MAX_MOUSE_DELTA || Math.abs(dy) > MAX_MOUSE_DELTA) return;
    _dx = clamp(_dx + dx, -MAX_PENDING_DELTA, MAX_PENDING_DELTA);
    _dy = clamp(_dy + dy, -MAX_PENDING_DELTA, MAX_PENDING_DELTA);
    maybeRecenter(e);
  }
}

function onMouseDown(e) {
  fireGesture();
  const b = e.button;
  if (b < 5) {
    if (!mouseBtnDown[b]) mouseBtnPressed[b] = true;
    mouseBtnDown[b] = true;
  }
  // 游玩中左键用于开火，不要让浏览器把它当成文本选择/拖拽的起点
  if (_locked || _playing) e.preventDefault();
}

function onMouseUp(e) {
  const b = e.button;
  if (b < 5) {
    if (mouseBtnDown[b]) mouseBtnReleased[b] = true;
    mouseBtnDown[b] = false;
  }
}

function onWheel(e) {
  _wheel += Math.sign(e.deltaY);
  // 指针锁定失败而走 fallback look 时也仍在游玩，滚轮只能切枪，不能滚动页面。
  if (_locked || _playing) e.preventDefault();
}

function onContextMenu(e) {
  // 右键是 ADS；即使浏览器拒绝指针锁定，也不能弹出右键菜单/手势入口。
  if (_locked || _playing) e.preventDefault();
}

function onBlur() {
  // 失焦时释放所有键，避免"卡住前进"
  down.clear();
  for (let i = 0; i < 5; i++) { mouseBtnDown[i] = false; mouseBtnReleased[i] = true; }
  _dx = 0; _dy = 0;
}

function onLockChange() {
  _locked = document.pointerLockElement === _canvas;
  if (!_locked) {
    _lastLockError = _lastLockError || 'LOST';
    onBlur();
  } else {
    _lastLockError = null;
  }
  Input._syncBodyClasses();
}

function onLockError() {
  _locked = false;
  _lastLockError = 'LOCK_ERROR';
  // 指针锁定失败 —— 立刻切到"无锁定鼠标视角"兜底，保证游戏还能玩
  _fallbackLook = true;
  Input._syncBodyClasses();
}

export default Input;
