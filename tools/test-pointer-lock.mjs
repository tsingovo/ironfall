// ==== tools/test-pointer-lock.mjs — 指针锁丢失不得立刻冻结游戏 ====
//
// 针对用户反馈：「游戏老是鼠标视角丢失，导致画面卡死」。
//
// 根因：pointerlockchange 一收到"锁丢失"就立刻 openMenuPanel('settings',{freeze:true})，
// 也就是 paused = true。但浏览器释放指针锁的原因里，大部分与玩家意图无关
// （重新请求的间隙、chrome 抢焦点、扩展介入、失焦），于是"鼠标瞬断一下"被放大成
// 「视角不动 + 画面卡死」。
//
// ⚠ 验证方式的诚实说明：
// 无头 Chrome 里 requestPointerLock() 恒定失败（WrongDocumentError），
// 因此**无法**用自动化真实地端到端验证指针锁行为 —— 这一点在项目里早有记录。
// 所以这里验证的是**源码契约**：核心是"任何事件处理器都不得在锁丢失时同步冻结游戏"，
// 以及宽限期机制确实存在。真实手感仍需在真机上人工确认。
//
// 用法: node tools/test-pointer-lock.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(root, p), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
};

const main = read('src/main.js');
const input = read('src/core/input.js');

console.log('\n指针锁丢失的处理（需求：视角丢失不得导致画面卡死）');

// ── 1. 宽限期机制存在
check('实现了锁丢失的宽限期处理 _onPointerLockLost', /_onPointerLockLost\s*\(/.test(main));
check('宽限期有正向时长', /GRACE_MS\s*=\s*\d+/.test(main),
  (/GRACE_MS\s*=\s*(\d+)/.exec(main) || [])[0] || '未找到');

// ── 2. 核心契约：pointerlockchange 处理器不得同步弹冻结菜单
{
  // 抓出 pointerlockchange 的处理体（到下一个 addEventListener 为止）
  const idx = main.indexOf("addEventListener('pointerlockchange'");
  const body = idx >= 0 ? main.slice(idx, idx + 1800) : '';
  const end = body.indexOf('addEventListener(', 10);
  const handler = end > 0 ? body.slice(0, end) : body;

  check('pointerlockchange 处理器存在', idx >= 0);
  check('锁丢失时不直接 openMenuPanel（改为走宽限期）',
    !/openMenuPanel\s*\(\s*'settings'/.test(handler),
    /openMenuPanel\s*\(\s*'settings'/.test(handler) ? '仍在同步冻结游戏' : '已改为延迟判定');
  check('锁丢失时调用 _onPointerLockLost', /_onPointerLockLost\s*\(/.test(handler));
}

// ── 3. fullscreenchange 也不得同步冻结
{
  const idx = main.indexOf("addEventListener('fullscreenchange'");
  const body = idx >= 0 ? main.slice(idx, idx + 900) : '';
  const end = body.indexOf('addEventListener(', 10);
  const handler = end > 0 ? body.slice(0, end) : body;
  check('fullscreenchange 不直接 openMenuPanel', !/openMenuPanel\s*\(\s*'settings'/.test(handler));
}

// ── 4. 失焦走宽限期而不是直接弹菜单
{
  const idx = main.indexOf("addEventListener('blur'");
  const body = idx >= 0 ? main.slice(idx, idx + 700) : '';
  const end = body.indexOf('addEventListener(', 10);
  const handler = end > 0 ? body.slice(0, end) : body;
  check('blur 处理器不直接弹设置菜单', !/openMenuPanel\s*\(\s*'settings'/.test(handler));
  check('blur 且未持锁时走 _onPointerLockLost（标记 blurred）',
    /_onPointerLockLost\s*\(\s*\{\s*blurred/.test(handler));
}

// ── 5. 宽限期结束后才允许弹菜单（确认那段代码仍在 _onPointerLockLost 内部）
{
  const idx = main.indexOf('_onPointerLockLost(options)');
  const body = idx >= 0 ? main.slice(idx, idx + 2600) : '';
  check('_onPointerLockLost 内部最终会 openMenuPanel（抢不回锁才提示）',
    /openMenuPanel\s*\(\s*'settings'/.test(body));
}

// ── 6. 菜单/面板打开时不得抢锁（否则会和玩家的操作打架）
{
  // 注意要定位**方法定义**而不是第一个调用点：调用点是 `this._requestPointerLockWithRetry();`，
  // 直接 indexOf('_requestPointerLockWithRetry()') 会命中调用处，切片就是空的。
  const defIdx = main.search(/\n\s+_requestPointerLockWithRetry\s*\(\s*\)\s*\{/);
  const body = defIdx >= 0 ? main.slice(defIdx, defIdx + 1400) : '';
  check('找到 _requestPointerLockWithRetry 的定义', defIdx >= 0);
  check('重试抢锁前会检查菜单/背包/升级面板状态',
    /menuKind/.test(body) && /_upgradeOpen/.test(body) && /inventory/.test(body),
    body ? '' : '未取到方法体');
}
{
  const defIdx = main.indexOf('_onPointerLockLost(options)');
  const body = defIdx >= 0 ? main.slice(defIdx, defIdx + 1400) : '';
  check('_onPointerLockLost 在自动化模式下不干预', /automation/.test(body));
}

// ── 7. 兜底视角仍然保留（原生锁定不可用时的降级路径不能被删掉）
check('保留无锁定的兜底视角实现', /_fallbackLook/.test(input));
check('保留 pointerlockerror 的可见提示', /pointerlockerror/.test(main) && /无法锁定鼠标/.test(main));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n注意：这是源码契约测试。指针锁的真实行为必须在真机上人工确认 ——');
  console.log('无头 Chrome 的 requestPointerLock() 恒定失败，自动化测不了这一层。');
}
process.exitCode = fail > 0 ? 1 : 0;
