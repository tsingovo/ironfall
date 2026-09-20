// ==== tools/test-menu-escape.mjs — 卡死类软锁的回归护栏 ====
//
// 针对用户反馈：「游戏老是鼠标视角丢失，导致画面卡死」。
// 定位到两个会让玩家**只能刷新页面**的死胡同：
//
//   A) 指针锁丢失立刻 openMenuPanel('settings',{freeze:true}) → paused=true。
//      浏览器在很多非玩家意图的情况下会短暂释放指针锁，于是"鼠标瞬断一下"
//      被放大成「视角不动 + 画面卡死」。—— 已在 main.js 用 400ms 宽限期修掉，
//      由 test-pointer-lock.mjs 锁住契约。
//
//   B) 联机全队失败时 Esc 完全失效。原代码：
//        if (menuKind === 'lan-dead' && !_allLanFailed) spectateLan();
//        else openMenuPanel('lan-dead', { freeze:false });
//      当 _allLanFailed=true 时：观战条件为假，而 openMenuPanel 因
//      `this.menuKind === kind`（已是 lan-dead）直接 return false —— 双分支都不做事，
//      Esc 变成空操作，玩家卡死在死亡界面。
//
// 这里用 fake game 直接驱动 _handleGlobalKeys，验证每种状态下 Esc 都有出路。
//
// 用法: node tools/test-menu-escape.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mainSrc = readFileSync(join(root, 'src', 'main.js'), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
};

// 从源码里抽出 _handleGlobalKeys 与 _syncMenuState，挂到一个 fake game 上跑。
// 这样测的是**真实实现**，不是复制一份逻辑（复制会随源码漂移而失去意义）。
function extractMethod(src, name) {
  const re = new RegExp(`\\n  ${name}\\s*\\([^)]*\\)\\s*\\{`);
  const m = re.exec(src);
  if (!m) throw new Error(`未找到方法 ${name}`);
  let i = m.index + m[0].length - 1;      // 指向 '{'
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error(`方法 ${name} 括号不平衡`);
}

const handleSrc = extractMethod(mainSrc, '_handleGlobalKeys');

/** 造一个 fake game：只提供 _handleGlobalKeys 会用到的字段与方法 */
function makeGame(overrides = {}) {
  const calls = [];
  const hud = {
    _menu: overrides.hudMenu ?? 'lan-dead',
    showMenu(k) { this._menu = k; calls.push('showMenu:' + k); },
  };
  const g = {
    hud,
    inventory: { open: false },
    _upgradeOpen: false,
    _playing: false,
    player: { alive: false },
    paused: false,
    menuKind: 'lan-dead',
    _allLanFailed: false,
    lan: { active: true },
    closeBackpack() { calls.push('closeBackpack'); },
    closeUpgradePanel() { calls.push('closeUpgradePanel'); },
    togglePauseMenu() { calls.push('togglePauseMenu'); },
    spectateLan() { calls.push('spectateLan'); },
    openMenuPanel(kind) { calls.push('openMenuPanel:' + kind); this.menuKind = kind; return true; },
    _syncMenuState() { calls.push('_syncMenuState'); },
    _debugFlags: {},
    debugFlags: { showOverlay: false },
    calls,
    ...overrides,
  };
  // 真实实现里的 Input / document 依赖做最小替身
  g.__deps = {
    Input: {
      actionPressed: (a) => a === 'pause',
      pressed: () => false,
      setPlaying() {}, setMenuBlocking() {},
    },
    document: { body: { classList: { add() {}, remove() {}, toggle() {} } } },
  };
  // 提取到的是**方法定义**语法（`_handleGlobalKeys() { ... }`）。
  // 只取 `{ ... }` 部分，配箭头函数 + call 绑定 this —— 不能用
  // `function { ... }`，匿名函数表达式缺名字是语法错误。
  const bodyStart = handleSrc.indexOf('{');
  const fnBody = handleSrc.slice(bodyStart);
  const factory = new Function('Input', 'document', 'Events', `
    const game = this;
    const _handleGlobalKeys = () => ${fnBody};
    return _handleGlobalKeys;
  `);
  const fn = factory.call(g, g.__deps.Input, g.__deps.document, { emit() {} });
  g._handleGlobalKeys = () => fn.call(g);
  return g;
}

console.log('\nEsc 在各状态下都必须有出路（不得变成空操作）');

// ── 1. 全队失败（本次修复的软锁场景）
{
  const g = makeGame({ _allLanFailed: true, menuKind: 'lan-dead', hudMenu: 'lan-dead', _playing: false });
  g._handleGlobalKeys();
  check('全队失败 + 死亡界面：Esc 不再是空操作', g.calls.length > 0,
    g.calls.join(' , ') || '什么都没做（软锁）');
  check('全队失败：Esc 把玩家带回主界面',
    g.calls.some((c) => c === 'showMenu:main') || g.calls.some((c) => c === 'openMenuPanel:main'),
    g.calls.join(' , '));
  check('全队失败：不会试图关闭面板（否则下一帧会被推回来）',
    !g.calls.some((c) => c.includes('close')), g.calls.join(' , '));
}

// ── 2. 还有活着的队友：Esc 应进入观战
{
  const g = makeGame({ _allLanFailed: false, menuKind: 'lan-dead' });
  g._handleGlobalKeys();
  check('未全队失败 + 已是死亡界面：Esc 进入观战',
    g.calls.includes('spectateLan'), g.calls.join(' , '));
}

// ── 3. 未全队失败且不在死亡界面：Esc 打开死亡面板
{
  const g = makeGame({ _allLanFailed: false, menuKind: null, hudMenu: null });
  g._handleGlobalKeys();
  check('未全队失败 + 不在死亡界面：Esc 打开死亡面板',
    g.calls.includes('openMenuPanel:lan-dead'), g.calls.join(' , '));
}

// ── 4. 非联机：Esc 走正常的暂停/关闭流程，不受影响
{
  const g = makeGame({ lan: { active: false }, player: { alive: true }, _playing: true, menuKind: null, hudMenu: null });
  g._handleGlobalKeys();
  check('单机游玩中：Esc 仍然是暂停菜单', g.calls.includes('togglePauseMenu'), g.calls.join(' , '));
}
{
  const g = makeGame({ lan: { active: false }, player: { alive: true }, _playing: false,
    menuKind: null, hudMenu: 'settings' });
  g._handleGlobalKeys();
  check('非游玩状态 + 有菜单：Esc 回到主界面', g.calls.includes('showMenu:main'), g.calls.join(' , '));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail > 0 ? 1 : 0;
