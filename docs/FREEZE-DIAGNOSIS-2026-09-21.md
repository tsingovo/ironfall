# 画面卡死诊断（2026-09-21）

基线：4229435。用户提供截图：场景黑屏，武器/HUD 仍可见，屏幕提示指针锁失败。

## 已确认根因与修复（收到 F8 报告后）

报告 `IRONFALL-diagnostic-2026-09-20T17-00-58-018Z.json` 显示：第六层，鼠标已锁定、未暂停、WebGL 上下文正常；连续抛出 `Cannot read properties of null (reading '0')`，栈为 `dist3 → EnemySystem._reposition → _updateAI → update → Game.stepPhysics → frame`。物理累加器已堆积至 3.47 秒，渲染帧未能完成。

新增 `_detectStuck` 与原有 `_reposition` 共用 `e.lastPos`：前者在飞行/蜘蛛/爬墙分支将其置 null，后者未判空就读取距离。物理更新在渲染之前，因此异常每帧重演，表现为画面冻结。该冲突由提交 4af4b08 引入。

修复：脱困检测改用独立 `stuckLastPos`，不再覆盖 AI 历史；绕行入口兼容旧空状态；对象池生成敌人时重置脱困计时、次数及失败落点。保留 DS 玩法。

验证：新增 `test-enemy-reposition-freeze.mjs` 在修复前复现相同异常，修复后通过；涵盖飞行敌人、上下墙、独立历史、对象池复用及 512 次完整 update。`test-bounds-stuck` 18/18、`test-tier-bosses` 24/24、`test-hybrid-boss` 通过。均为轻量逻辑测试，实际游玩交由用户复核；未推送/发行。

## 前期排查记录（收到报告前）

当时未复现用户的卡死，根因未确认；以下为当时证据和采证方案。

- 独立临时 Chrome、真实 RTX 4070 GPU、640×360 / 30 帧短测：正常 rAF 帧数持续增长；无 JavaScript / console error。
- 十层依次部署、短时开镜开火：无异常，相机 FOV 有限。没有做长时间战斗、真实指针锁/全屏或联机验证。
- 确认诊断缺口：`_renderSafely` 捕获异常后只写控制台，未进入全局 errors；物理异常没有同样的保护。持续异常可能反复跳过渲染，但这只是风险路径，不是已确认的本次根因。
- 未修改 DS 玩法，未杀用户游戏/服务器、未改存档，未推送/发布。

## 新增采证

- `src/core/diagnostics.js`：每秒保留最近六份轻量状态；记录物理/全局异常、被捕获的渲染异常、相机非有限值、WebGL 上下文丢失。
- 最近异常仅保存在本机 `ironfall.diagnostics.last.v1`；不上传网络，不覆盖存档。
- F8 独立于游戏帧循环导出 `IRONFALL-diagnostic-*.json`（通常在下载目录）；保留 NaN/Infinity 字符串而非错误转成 null。异常时有独立 DOM 提示按钮。
- 请重新打开本地开始游戏入口后复现；卡死当下按 F8。报告包括当前状态、最近状态和上次启动遗留异常，供进一步定位。
- 若整个 JS 线程/GPU 完全挂起，F8 也可能无法响应；此时需说明最后操作、Esc 是否有效，不能把无报告理解为无异常。

验证：`node tools/test-freeze-diagnostics.mjs` 通过；main.js 语法检查通过；接入后短时真实 GPU 十层渲染检查仍零异常。临时诊断浏览器已自动结束。
