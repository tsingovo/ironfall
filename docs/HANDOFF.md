# IRONFALL 当前交接（2026-09-15）

当前目标：通用邀请联机、晚加入/名单/动作同步、友伤与复活观战。代码已集成，2.1.0 本地包已构建，未发布未推送。

- 仓库为独立 Git，main；Gitee远端gitee。历史说明如下仅作参考，以代码为准。
- 通用连接入口 tools/room-connect.mjs create/join，房间schema tools/room-invite.mjs；邀请内仅公开证书，不读写私钥，不安装根证书，不关闭TLS验证。build-release默认包含通用邀请启动脚本，--friend仅旧模式。
- 协议为2，必须同版；SESSION晚加入与重新开局sid、名册回调刷新、暂停仍网络更新；nameplates由HUD世界投影遮挡。
- PvP死亡不计额度，PvE/环境第三次死亡淘汰，个人重生不清世界，全员淘汰后结算一次，房主重开。近战友伤尚未专门扩展，当前枪械hitscan覆盖友伤。
- 验证：test-room-invite、test-tunnel-regression、test-net-sync、test-lan-combat通过；test-hud 189/189；build-standalone/build-release通过。未完整真实双机实战。
- 下一步：用户双机测试列表、晚加入敌人、弹道钩锁名牌、第三次PvE观战与全队重开；若失败先记录双方BUILD/房主日志，勿把能入房等同于实战同步已全面验证。
- 产物 release/IRONFALL-2.1.0-offline.zip，不含个人endpoint/certificate/private key。旧friend包属于个人专用，不公开。

---
## 历史记录（端口/路径/版本可能过时）

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

## 2026-09-15 单入口联机 2.1.1
- 用户要求所有开房/邀请/加入在游戏内操作，发行包仅一个“开始游戏.cmd”。已接入 serve / serve-single 本机 POST 控制 API；仅允许 loopback、准确 Host/Origin，邀请仅公开证书，保留 TLS 验证。
- 大厅创建房间自动启动 18200；导出邀请选择完整地址/公开 crt；朋友选 JSON 确认后本机桥接连接。穿透客户端仍外部运行。旧开发脚本仅兼容维护，通用包不再包含它们。
- 修复测试用 LAN port:0 被默认值覆盖；桥接允许准确的游戏页面 Origin，拒绝缺失/外部 Origin；状态仅向指定 Origin 提供 CORS。
- 已验证：local-room-control、room-invite、tunnel-regression、net-sync、lan-combat、HUD 189/189、launch-version；解压实际发布包后启动 serve-single 并检查 BUILD/API 成功；ZIP 只有一个 CMD。未执行真实 GUI 或双机游玩，用户自行测试。
- 本地产物 release/IRONFALL-2.1.1-offline.zip，SHA256 9D10A4B0E132993AA3AE035C282375B423572E225C2A6ED08E8DCE905CDE7419。未 push、未发布。
- 保留所有未提交的 2.1.0 联机修改。后续关注真实多人体验与重新打开旧后台服务的生命周期；不要随意终止用户运行中的服务器。

## 2026-09-19 视野调整 2.1.2（本地未推送）
- 腰射及运动姿态枪体统一下移 0.18，ADS 按权重恢复以保持瞄具对齐，近战/治疗不动。
- 移除 weapon fire/hit 的 fx:shake 发射，不改变 _applyRecoil、射击定时、扣弹与伤害。
- test-fire-paths：打墙/敌人/天空 100ms 两发，22 发剩余，后坐力仍存在，无震动事件；test-weapon-lowering 全枪全姿态通过；启动版本检查通过。
- BUILD 更新为 2.1.2，避免复用旧发布包页面。完整视觉体验待用户测试。

## 2026-09-19 平滑后坐 2.1.3（本地未推送）
- 用户希望首发极小、连续射击越过阈值后加速上抬，停火减速至 0。_applyRecoil 只设目标角速度，_updateRecoil 指数解析积分速度和位移，不每发跳角度。
- CFG.recoil 集中参数：startShots=3、rampShots=7、singleShotScale=.035、acceleration=9、braking=22、burstResetSeconds=.30、maxPitchSpeedDeg=7。
- 停稳后将偏移转入 player.pitch/yaw，视觉连续且不反向回弹；切枪同样转移而非突兀归零。鼠标压枪保留。实际命中与相机仍共用 visPitch/visYaw。
- test-smooth-recoil 覆盖首发、阈值爬升、无瞬跳、松手减速、停稳无漂移、30/60/144 FPS、无真实开火不持续驱动；test-fire-paths、weapon-lowering、loot-weapons 29/29、net-sync 通过。
- 此改动未动射击定时/扣弹/伤害；真实游戏手感由用户测试。2.1.2 及本次代码均未提交/推送。

## 2026-09-19 恒速连射后坐 2.1.4（本地未推送）
- R99/平行/电能 constantSpeed=true，无发数阈值，驱动期间 pitch 速度即各自满强度速度；只积分角度不瞬跳，横向仍平滑沿轨迹。
- 停火按 braking 减速；单发狙/霰弹保留微量短脉冲。recoilProfile='devotion-ramp' 专属渐强配置已保留，但仓库无专注武器，未擅自新增。
- test-smooth-recoil 已覆盖三把连射枪恒速、专属渐强配置保留及已有单发/制动/FPS 测试；fire-paths 保持 100ms 两发 22 剩余。

## 2026-09-19 R99 后坐倍率 2.1.5（未推送）
- R99 recoilSpeedMul=2.5，在原基础限速之后乘倍率，腰射 4.2→10.5 度/秒，横向同倍率；ADS/配件既有乘数不变。其他枪默认为 1。
- test-smooth-recoil 新增腰射/ADS 精确 2.5 倍与其他枪不变断言。

## 2026-09-19 新敌人 2.1.6（未提交/推送）
- ENEMY_IDS 末尾追加 stalker / blastSpider，不替换旧类型；独立 hitrun/bomber 行为，不走通用枪手攻击。
- stalker 18m/s，.22秒挥刀前摇，基础50伤（不乘全局伤害倍率）；每次挥刀后必须距原目标超过60m再进入approach。绕障探测+实体碰撞，绿色限频尾迹。
- blastSpider 八足双节模型，接墙才贴壁关闭重力，法向贴附/切向爬升+原sweep/resolve。新增二次切向扫掠避免贴墙t=0卡住。近距蓄力1.1秒，5m范围50基础伤害，LOS墙遮挡；被杀取消爆炸，自爆不给击杀收益。
- 新怪在普通关选择权重合计约28.6%，boss层3/6/10合计90%；预算/并发上限未放开。
- 协议升级3，ENEMY_TUPLE=16，specialPhase/timer/wallNormal/slashT同步；host-only可靠special FX，房客仅播放不结算伤害。独立子代理仅改net模块和测试，已集成检查。
- 检查：special-enemies（含真实World 5m墙爬升+实体模型矩阵）、net-special-enemies、net-sync、lan-combat、grapple6/6、HUD189/189、audio222/222、fire-paths、smooth-recoil均通过。音频测试曾因新音效改变随机序列，在旧增益抖动断言失败；对照HEAD音频220/220通过，已按声明±8%增益波动校正测试上限，未改实际混音音量。
- 无GUI/双机实玩，遵照用户由其自行验收。发布包release/IRONFALL-2.1.6-offline.zip，本次及此前今日后坐修改均未推送。

- 收尾：main.js 排除自爆的玩家击杀广播；新增目标死亡后蜘蛛引信继续且不伤害死者测试，全部专项回归通过；重新打包并验证 ZIP 单入口、运行依赖、新怪代码及协议3均存在。

## 2026-09-21 checkpoint — BUILD 2.1.8（未提交）
- 保留并验证第六层卡死修复：stuckLastPos 与 reposition 历史隔离，F8 诊断。
- 十关统一 Boss → 任意撤离点立即通关；第一层 heavy 精英、第二层 shieldman 精英，600/900 HP；第十层也必须撤离。删除旧任务追踪。
- Boss 有效枪弹命中减速 25% / 0.35 秒，刷新不叠加；在物理水平位移应用，不累乘速度、不影响重力。飞行位移同时减速；瞬移不受影响。
- 玩家名字/离屏位置标记移除，以正常深度测试的细亮模型边缘替代。
- 新 Boss 专属模型/动作、蜘蛛刷怪限额、敌方可拦截追踪弹及主客机镜像已在源码；离线文件已重新生成。
- 本轮轻量检查通过：test-tier-bosses 27/27、boss-extraction、avatar-rim、boss-models、enemy-reposition-freeze、enemy-population、weapon-boss-interactions、hostile-projectiles、net-hostile-projectiles；diff --check 通过。
- 未做实际画面和双机游玩验收（用户负责测试）。仍需复核：部分专属攻击面向房主而非远程玩家；克隆罐生成点未保证中央；蜘蛛布雷未实现真正抛物线投掷；模型美观待用户评价。不要将这些描述为已完全按需求验收。
- 无 push / release；工作树保留全部未提交修改。README 已改当前规则。

## 2026-09-21 checkpoint — BUILD 2.1.9（未提交）
- 修复高台狙击手：只允许高于玩家至少 6m 的导航点，找不到时本轮不生成；蓄力不再被难度精度倍率压短，最后 0.5s 才冻结，因此静止目标可被锁中。
- 克隆罐仅累计玩家武器/近战/联机权威击杀；虚空、环境、Boss 范围技不计数，目标仍为每个罐子 100。
- 绿影蛛皇及所有战役 Boss 保存验证过的出生点；跌至 y<-40 自动安全回位，不再因虚空开局死亡。
- 熔岩守卫者追踪弹被击毁和命中玩家均播放爆炸声；命中追加 18m/s 水平、9.5m/s 垂直击飞。噩梦层该伤害减半。
- Boss 撤离统一改为任意信标内连续停留 2 秒；离开立即清空本次读条。
- 新增第 11 关“噩梦”：历代 10 种 Boss 各 2 只，共 20 只；Boss 生命统一 1800（第五关规格；克隆罐仍走 100 击杀机制），全层 Boss/小怪伤害减半。完成后进入第一关循环。十一关已接入地图、菜单、存档、联机层数与简报。
- 坦克蓝盾新增与 4.3m×2.8m 可视模型一致的定向射线碰撞平面，网络命中另以 0.60rad 正面角兜底。
- 新增 tools/test-feedback-20260921.mjs；本轮通过 meta 10/10、boss extraction、feedback、tier bosses 27/27、special enemies、hostile projectile、network snapshots、maps 571/571、HUD 190/190、launcher version。离线 dist/IRONFALL.html 已重建。
- 未做真人画面/手感/双机验收，仍由用户测试；未 commit/push/release。

## 2026-09-21 噩梦关降载与 240 FPS 默认值（未提交）
- 噩梦关完全禁止克隆哥布林：两个克隆罐不再各维持 50 只哥布林，移除该关最重的百实体 AI/碰撞负载；第 7 关原有 50 同存、累计玩家击杀 100 只的机制不变。
- 为避免噩梦关目标无法完成，噩梦克隆罐改为 1800 HP 可直接摧毁；此模式通过敌人快照标志同步给房客，联机命中仍由房主权威结算。
- 新安装的默认帧率上限由无上限改为 240 FPS，设置菜单仍保留无上限、60、120、144、240 档。已有明确保存的个人帧率设置不强制覆盖。
- 轻量回归：feedback（噩梦零哥布林/克隆罐可击杀）、tier-bosses 27/27（第 7 关未回归）、net-boss-presentation、modules 125/125。
