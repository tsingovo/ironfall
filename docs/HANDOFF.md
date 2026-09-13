# IRONFALL 交接文档

> 项目目录：`F:\桌面\codex桌面\ironfall`  
> 最后更新：2026-09-13（Esc/强化弹窗、补给、ADS、任务信标、楼梯、危险区、35 发弹匣、CMD 启动）  
> 本目录当前不是独立 Git 仓库；交接内容以源码和自动化结果为准。

---

## 1. 启动

### 玩家推荐方式：独立窗口

双击项目根目录：

```text
启动独立窗口游戏.cmd
```

短名入口 `开始游戏.cmd` 等价。

它会运行 `tools/launch-app.mjs`：

- 自动开启本地服务器，默认 `http://127.0.0.1:18080/`；
- 自动寻找 Chrome 或 Edge，并用 `--app= --start-maximized` 打开无标签栏、无地址栏的独立窗口；
- 使用独立配置目录 `%LOCALAPPDATA%\IRONFALL\app-profile`；
- 禁用 `OverscrollHistoryNavigation`，减少右键/横向滑动触发前进后退；
- 启动前只清理该专属 profile 的 Chrome/Edge 残留进程，避免隐藏进程吞掉新窗口，绝不影响用户日常浏览器；
- 本地服务器轻量常驻并由后续双击复用；启动过程写入项目根目录 `launch.log`。

这不是 Electron，也不是编译后的原生 exe；内核仍是 Chromium，因此系统/浏览器级 `Ctrl+W` 等快捷键无法由网页完全接管。

### 开发调试方式

```powershell
cd F:\桌面\codex桌面\ironfall
node tools\serve.mjs
# 打开 http://127.0.0.1:8080/
```

项目为纯 WebGL2 + 原生 ES Modules，零第三方依赖、零构建，不需要 `npm install`。

---

## 2. 本轮已修复的问题

### 2.1 枪、敌人和特效不显示：真正根因在实例渲染器

`src/engine/engine.js` 原来有三处组合故障：

1. `_drawBatch()` 虽计算批次偏移，却没有把偏移加到 `vertexAttribPointer()`；所有批次都从实例 VBO 的 offset 0 读取。
2. draw list 会回头合并不连续的同 mesh 批次，导致夹在中间的实例区间被覆盖。
3. 世界和枪械视图模型延迟到同一次 `flush()`；枪真正绘制前，独立相机已经恢复成世界相机。

现在：

- 每批实例属性从 `b.offset * 4` 的正确字节位置读取；
- 只合并紧邻且渲染状态完全相同的批次；
- 新增 `flushAndReset()`，世界 pass 与视图模型 pass 分开立即提交；
- `weapons.render()` 在视图模型相机仍生效时提交，并完整恢复相机矩阵与位置；
- 统计数据可跨多个 pass 累加。

验证：枪械 12/12 部件至少部分在屏幕内，7/12 完整在屏幕内；枪与手臂实际覆盖约 49 万像素。

### 2.2 出生视角卡在地下 / 移动穿地

`src/player.js` 在 `respawn()` 与常规胶囊碰撞解算后调用 `world.enforceCapsuleValidity()`，硬性保证胶囊最终位置合法。

验证：192 次长时间冲刺采样穿模 0 次；冲刺撞 10 面墙穿越 0 次；地形最小间隙约 `-0.02m`，在容差内。

### 2.3 敌人看不见

- 修复上述实例批次问题；
- `src/enemies.js` 六类敌人改成高饱和、高对比配色；
- `src/fx/enemy-markers.js` 默认开启高亮标记，修正朝相机偏移方向，并服从深度遮挡；
- lit shader 加最低环境亮度，避免背光模型变成纯黑；
- 开局导演把敌人生成在玩家前方的中近距离。

验证：两名隔离敌人的帧差约 22.9 万像素；开局 6/6 敌人在前方、6/6 在 30m 内、5/6 在视锥内。人工复核截图：`docs/verify/ui/V10-opening-wave.png`。

### 2.4 子弹轨迹看不见

除实例渲染修复外，曳光改为“深色宽轮廓 + 高饱和彩色光带 + 白色亮芯”三层结构，并保证最短可见长度；亮地板和暗背景下都能辨认。

`tools/headless-check.mjs` 现在包含真正隔离的像素测试：新建纯黑 WebGL2 framebuffer，只提交一条曳光后 `readPixels()`。最新实测 `514 px`、峰值 `255`，不再用 `tracerCount > 0` 代替画面验证。

### 2.5 Esc 设置菜单

旧实现中 Game 与 HUD 同时监听 Escape，第二次 Esc 会出现“先关闭、下一帧又打开”；而且全局按键处理位于 `paused` 早退之后。真机还可能优先消费 Esc、退出网页全屏或只解除指针锁而不把 `keydown` 交给页面。

现在：

- Escape 只由 Game 的单一状态机处理；
- 全局键处理在 paused 早退之前执行；
- 非预期 `pointerlockchange/fullscreenchange` 时自动进入设置菜单，覆盖浏览器吞掉 Esc 的情况；
- 游玩中 Esc：真正暂停世界、释放鼠标、直接显示设置菜单；
- 菜单中再次 Esc：关闭菜单、恢复世界并请求重新锁定鼠标；
- 已彻底删除故障的“点击进入战场”DOM/CSS 遮罩；窗口失焦仍会冻结式暂停；
- `startRun()` 现在同步设置 `Game._playing` 与 `Input.playing`，修复真机路径状态不一致；
- 菜单期间连 `lookX/lookY` 也强制归零，不再残留视角增量；
- 独立启动器使用 Chromium App 独立窗口自动最大化；`?standalone=1` 下不叠加网页 Fullscreen API，Esc 不再缩窗。

验证状态：`playing=true, paused=false, menuKind=null` → Esc 后 `playing=true, paused=true, menuKind=settings`。

### 2.6 地板与程序化模型透视

根因是高度场、圆柱、圆盘、楔形和网格平面的部分三角形绕序与外向法线相反。WebGL 开启背面剔除后会把面向玩家的正面直接丢弃，看起来像模型或地板透明。现已统一修成从外部观察为 CCW；碰撞地形同步朝上；敌人高亮标记也不再绕过深度测试。

### 2.7 鼠标 Y 轴方向

DOM 的 `movementY` 向下为正；默认设置下现在直接映射为“鼠标向上 → 抬头、鼠标向下 → 低头”。设置中的“Y 轴反转”开启后才反向。自动化同时验证正常和反转两条路径。

### 2.8 Apex 风格按键

| 操作 | 当前默认键位 |
|---|---|
| 移动 | `W A S D` |
| 疾跑 | `Shift`（切换式） |
| 跳跃 / 二段跳 / 墙爬衔接 | `Space` |
| 蹲伏 / 滑铲 | `Ctrl` 或 `C` |
| 开火 / 开镜 | 鼠标左键 / 右键 |
| 换弹 | `R` |
| 互动 | `E` |
| 战术技能 / 抓钩 | `Q`（按一下；再次按 Q 或蹲下脱离） |
| 武器槽 / 切枪 | `1`、`2` / 鼠标滚轮 |
| 近战 | `V` |
| IRONFALL 额外 Dash | `左 Alt`（不占用 Apex 的 Q） |
| 设置 / 暂停 | `Esc` |

键位事实来源是 `src/core/input.js`，菜单静态说明在 `src/ui/hud.js`，自动化语义映射在 `src/main.js`。

### 2.9 鼠标灵敏度

- 默认：`0.0012 rad/count`（约 `0.069°/count`）；
- 设置范围：`0.00005–0.006`；
- 步进：`0.00005`；
- 输入层硬范围：`0.00005–0.01`；
- 旧存档若记录了大于 `0.02` 的旧制灵敏度，会自动回落到 `0.0012`。

旧 UI 曾把 `0.2–10` 直接当弧度/像素保存，因此所谓最低档也极高；不要恢复旧量纲。

### 2.10 敌人尺寸、弹道与伤害平衡

- 普通人形敌人按 `ENEMY_HUMANOID_HEIGHT=1.8m` 精确对齐玩家站立胶囊；重装、无人机和虫群保留兵种尺寸；可视模型、碰撞半径/高度、命中盒与枪口高度同步；
- `ENEMY_DAMAGE_SCALE=0.35`：所有敌方近战、即时射线与飞行弹丸统一降至原值 35%，难度曲线仍继续生效；
- 玩家曳光从真实枪口出发，寿命提高到 `0.22–0.32s`，并使用深色轮廓、彩色光带、白色亮芯三层结构；
- 敌方 hitscan 也会提交可见曳光，命中玩家时在相机前 3.5m 截断，避免遮屏光柱；
- `tools/test-modules.mjs` 固化敌人缩放/伤害与全部武器曳光下限，`tools/headless-check.mjs` 使用 R-99 实际参数做离屏像素验证。

### 2.11 补给、弹匣、ADS、任务信标与场景可读性

- 补给站现在一次补满生命、护盾、所有武器弹匣与备弹，然后打开免费改件货架（合金只作奖励/统计展示）；
- R-99、Flatline、Volt 的基础弹匣统一为 35 发，备弹同步提高，35 发完整后坐力图谱已补齐；
- ADS 锚点远离相机，普通枪显示光学准具，Longbow 显示圆形瞄准镜暗角；
- 当前任务增加屏幕空间名称、距离、菱形与离屏箭头，撤离点使用蓝色标识；
- 楼梯单级从最高 1.4m 降到不超过 0.58m，玩家自动跨步为 0.64m；
- 地形不再按纯白实例色过曝；岩浆/酸液/冷却液/辐射/真空区各有独立高对比表面、边框和中心标记；
- 治疗轮盘使用原始鼠标 `movementX` 判定方向，左移选左侧医疗包、右移选右侧护盾电池；
- 有护甲敌人按“护盾 → 生命”顺序结算，返回 `shieldDamage/healthDamage`；护盾、破盾、肉体命中分别播放 `hit_armor`、`shield_break`、`hit_flesh`/`hit_head`；
- `5` 读条开始时播放独立的 `medkit_use` / `shield_battery_use` 音效，完成时追加 `medkit_complete` / `shield_battery_complete` 确认音。
- 轻按 `5` 始终使用轮盘当前选项，不会因为残血自动切换到医疗包；库存仍显示无限医疗包/电池。
- 所有武器备弹改为 `Infinity`（弹匣仍需换弹），HUD 以 `∞` 显示；`debugState()` 用 `reserveInfinite` 标志避免 JSON/数值哨兵污染。
- Longbow/Sentinel 开火后进入独立拉栓周期，`sniper_bolt` 音效在拉栓完成后即可再次扣扳机；Sentinel 自动换弹后可继续整匣充能。
- R-99 枪口焰关闭，仅保留曳光和音效；破盾音加入高频玻璃碎裂与颗粒层并提高增益。
- 修复贴墙：扫掠半径不再按身高放大，离墙速度不被错误裁剪；松开/反向输入会退出墙跑；浅坡法线噪声不再造成静止漂移。

### 2.12 强化弹窗软锁

合金不足时旧货架没有退出入口。现在面板提供“跳过并继续 (Esc)”按钮；Game 的 Esc 状态机优先关闭强化面板，恢复世界、鼠标和输入，不会在背后叠加设置菜单。端到端测试以 0 合金打开货架并验证 Esc 后 `upgradeOpen=false, paused=false, menuBlocking=false`。

---

## 3. 最终回归

应运行：

```powershell
node tools/test-modules.mjs
node tools/test-audio.mjs
node tools/test-upgrades.mjs
node tools/test-maps.mjs
node tools/test-hud.mjs
node tools/test-ui-input.mjs
node tools/headless-check.mjs
node tools/launch-app.mjs --dry-run
```

本轮结果：

| 测试 | 结果 |
|---|---:|
| 模块 / 契约 / CSS | 86/86 |
| 音频 | 147/147 |
| 升级 | 69/69 |
| 地图 / GLTF | 555/555 |
| HUD | 179/179 |
| UI / 输入 / 像素可见性 | 51/51 |
| 浏览器端物理 / 射击 / AI / 性能 | 84/84 |
| **合计** | **1169/1169** |

注意：`test-ui-input.mjs` 和 `headless-check.mjs` 会启动 Chrome；无头环境使用 SwiftShader，其 FPS 不代表真机性能。

升级货架测试曾偶发显示“只出 2 项”，最终确认是测试先保存了货架数组引用，随后 `pick()` 原地 `splice()`，最后才读取长度造成的假失败。测试现已在购买前拍快照；升级系统自身 400 轮抽取测试均能正常填满可用槽位。

---

## 4. 验证方法要求

本项目发生过“内部对象数量正常，但玩家画面完全不可见”的假通过。后续修改必须遵守：

1. 视觉功能不能只断言对象数、批次数或 `render()` 返回值；必须读取 framebuffer 像素或保存可人工复核的截图。
2. 隔离渲染严格遵循 `beginFrame → setCamera → draw/render → flush → readPixels`。
3. 世界和视图模型是不同相机 pass，切换相机前必须提交世界，恢复相机前必须提交视图模型。
4. 实例批次只能续接紧邻同状态绘制；`vertexAttribPointer` 必须包含批次字节偏移。
5. UI 可见性要检查实际 computed style / 像素，不能只检查 DOM 和 class 是否存在。

关键截图：

- `docs/verify/ui/V8-visibility.png`：枪械与敌人隔离可见性；
- `docs/verify/ui/V9-settings.png`：Esc 直接打开设置菜单；
- `docs/verify/ui/V6-upgrade.png`：强化货架含“跳过并继续”入口；
- `docs/verify/ui/V10-opening-wave.png`：开局敌人位置与可辨识度。

---

## 5. 仍需真机人工确认 / 非本轮范围

1. 指针锁定受浏览器权限控制，无头 Chrome 会拒绝，需真人点击画面确认锁鼠标与 Esc 后重锁体验。
2. 程序化音频的结构和节点回收已自动验证，但最终听感仍需真人试听。
3. 地图结构仍较密，后续若改善导航可读性，优先减少 `src/maps/builtin-maps.js` 的柱体、平台和箱体密度。
4. 当前无阴影与后处理，是性能取舍，不是本轮回归。

---

## 6. 关键文件

```text
启动独立窗口游戏.cmd       独立窗口入口
开始游戏.cmd               同一启动器的短名入口
tools/launch-app.mjs        本地服务器 + Chrome/Edge App 模式启动器
src/engine/engine.js        实例批次、偏移、flushAndReset、多 pass
src/main.js                 主循环、世界/枪械 pass、Esc 状态机、自动化映射
src/weapons.js              枪械、视图模型、开火与曳光
src/player.js               出生、移动、胶囊合法性
src/enemies.js              六兵种外观与 AI
src/fx/enemy-markers.js     默认开启的敌人高亮标记
src/fx/projectiles.js       曳光 / 弹丸 / 枪口火光
src/core/input.js           Apex 风格键位、鼠标灵敏度、指针锁定
src/ui/hud.js               HUD、设置、操作说明、菜单输入
tools/test-ui-input.mjs     UI、出生、枪/敌人真实像素、Esc 验证
tools/headless-check.mjs    物理/射击/AI/性能 + 独立曳光像素测试
docs/CONTRACTS.md           跨模块接口契约
```
