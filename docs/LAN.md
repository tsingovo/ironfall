# IRONFALL 局域网联机（LAN CO-OP）

> 版本：随 2.0.6 分支 `feat/LAN` 引入
> 目标：同一路由器下的 2–4 人合作打一局搜打撤远征，零第三方依赖、零构建步骤。

---

## 1. 玩家怎么用

### 房主

双击项目根目录的：

```text
开始联机.cmd
```

它会：

1. 启动 `tools/lan-server.mjs`，绑定 `0.0.0.0:18200`（可用 `IRONFALL_PORT` 覆盖）；
2. 打印本机与局域网地址，例如：
   ```text
   IRONFALL 局域网服务器已启动
     本机:   http://127.0.0.1:18200/
     局域网: http://192.168.1.5:18200/   （以太网）
   ```
3. 顺带打开本机的无边框游戏窗口。

进入游戏后：**主菜单 → 8 局域网联机 → 1 创建房间 → 3 开始远征**。

### 房客

用 Chrome / Edge 打开房主给出的**局域网地址**（例如 `http://192.168.1.5:18200/`），然后
**主菜单 → 8 局域网联机 → 2 加入房间**。

房客不需要输入任何 IP：客户端的 WebSocket 地址直接从页面地址推导（`ws://<同一个 host>/ws`）。

房主点“开始远征”后，房客会自动收到开局广播并加载**完全相同的任务与地图**。

### 命令行

```powershell
node tools/lan-server.mjs 18200            # 只开服务器，不开窗口
node tools/lan-server.mjs 18200 --open     # 顺便打开本机游戏窗口（= 开始联机.cmd）
node tools/lan-server.mjs 18200 --host 0.0.0.0
```

---

## 2. 权威模型：各自模拟自己的玩家 + 房主权威世界

这是本项目**刻意选择**的模型，不是权衡后的折中。

```
        房主浏览器                          房客浏览器
 ┌───────────────────────┐          ┌───────────────────────┐
 │ 真实 Player（自己）    │          │ 真实 Player（自己）    │
 │ EnemySystem（权威 AI） │          │ EnemySystem（复制模式）│
 │ Director（权威刷怪）   │          │ 无导演                 │
 │ RemotePlayer 代理 ×N   │          │ RemotePlayer 代理 ×N   │
 └───────────┬───────────┘          └───────────┬───────────┘
             │  敌人快照 20 Hz / 单局状态 2 Hz    │
             │  命中申报 / 伤害转发              │
             └──────────► tools/lan-server.mjs ◄─┘
                        （只做静态站点 + 房间中继，
                          完全不参与游戏模拟）
```

- **每个客户端权威地模拟自己的玩家。** 因此移动手感与单机**逐帧一致**，没有预测误差、
  没有回滚、没有“橡皮筋”。
- **房主权威地模拟敌人与导演。** 房客的敌人不跑 AI，只按快照插值显示。
- **敌人伤害由房主判定，转发给本人结算。** 房主为每位房客维护一个 `RemotePlayer` 代理，
  敌人 AI 选中它并调用 `applyDamage()` 时，代理把伤害通过网络发给那位房客本人执行。
- **命中由开枪的一方判定，房主结算。** 房客开火命中后把「敌人 id + 原始伤害 + 命中点」
  上报，房主用自己那份权威血量重算护盾/生命分配。

### 为什么不让房主模拟所有人

本项目有三处硬性障碍，使得“房主模拟全部玩家”会立刻出错，且都不是小改动能绕过的：

1. **事件总线是进程级单例。** `src/core/events.js` 的 `emit()` 同步广播给所有监听者。
   `src/run.js:92-106` 会把任何 `player:hurt` / `player:die` 计入本机单局统计，
   并且任何一个 `player:die` 都会 `this.end(false)` 结束**本机**远征。
   房主一旦模拟第二个 `Player`，房客阵亡就会结束房主的局。
2. **`eyePos` 是渲染相位产物。** 它由 `Player.updateCamera(dt)` 以**可变帧间隔**写入，
   并且掺入了屏幕震动/落地下沉/速度摇摆；而它同时被抓钩判定和子弹起点读取
   （`weapons.js` 的 `_fire` 用 `player.eyePos` 作为射线原点）。跨机复现这一项不可行。
3. **后坐力与 RNG 流无法复现。** `_aimDir()` = `yaw/pitch + recoil.visYaw/visPitch`，
   而后坐力由每实例的 `mulberry32(0xC0FFEE)` 累积产生，且该 RNG 每个物理步都会被
   视角模型的呼吸动画消耗一次。两端的步数一旦不同，弹道就永久发散。

“各自模拟自己”天然规避了全部三点，代价只是**不能做玩家之间的物理碰撞**
（队友之间可以互相穿过）。对本作的 PvE 搜打撤玩法，这个代价可以接受。

---

## 3. 协议

传输：WebSocket（文本帧 JSON）。服务器对游戏消息**不透明**，只做房间内转发。

信封（由 `tools/lan-server.mjs` 产生）：`hello` / `welcome` / `roster` / `peer_left` /
`chat` / `ping` / `pong` / `error` / `game`。

游戏消息（`data.k`，见 `src/net/protocol.js`）：

| k | 方向 | 频率 | 内容 |
|---|---|---|---|
| `ps` | 每人 → 全体 | 30 Hz | 自身玩家状态元组（16 个数字） |
| `es` | 房主 → 房客 | 20 Hz | 敌人快照（每只 9 个数字） |
| `run` | 房主 → 房客 | 2 Hz | 单局阶段 / 目标进度 / 撤离读条 |
| `sess` | 房主 → 房客 | 一次 | 地图配置 `{mapIndex, seed, tier, mapName}` |
| `hit` | 房客 → 房主 | 按需 | 命中申报（敌人 id、原始伤害、命中点、法线） |
| `dmg` | 房主 → 单个房客 | 按需 | 敌人对该玩家造成的伤害 |
| `ev` | 房主 → 全体 | 按需 | 离散世界事件（敌人死亡 / 提示 / 结算） |
| `chat` | 任意 → 全体 | 按需 | 队伍文字 |

玩家状态元组（`PLAYER_TUPLE = 16`）：

```
x y z  yaw pitch  vx vy vz  health shield  moveStateIdx flags weaponIdx hspeed maxHealth maxShield
```

- 位置 2 位小数（1 cm）、角度 4 位小数（≈0.006°）：在 30 Hz 下远高于视觉需要。
- `flags` 位：`ALIVE GROUNDED CROUCHING SLIDING ADS RELOADING FIRING GRAPPLE SPRINTING`。

敌人快照元组（`ENEMY_TUPLE = 9`）：

```
id typeSlot x y z yaw hp shield flags
```

兵种槽表用 `ENEMY_IDS` 的**固定导出顺序**，不能用运行时刷怪顺序（那会随当局变化）。

---

## 4. 一致性保障

### 4.1 同一张地图

`generateMap({seed, biome, archetype, size, tier})` 是纯 PRNG 的确定性函数，
且产物是纯 JSON 数据。房主只需广播 `{mapIndex, seed, tier}`：

- 单机种子掺了本机存档进度（`mission.seedBase + meta.stats.runs * 7919`），
  所以**必须**由房主下发，不能让各端自己算。`Game.loadMission(index, {seed})` 支持覆盖。
- `tools/test-lan-map.mjs` 把这条前提变成可执行断言：同种子两次生成逐字段一致、
  改种子确实换图、产物可 JSON 往返、全部 10 关都能复现。

### 4.2 出生点不重叠

`Game.localSpawnIndex()` 取自己在**服务器名册中的序号**，再交给
`World.findPlayerSpawn(index)`。

> 注意：`LanSession.squadList()` 必须按服务器名册顺序返回，**不能**总把自己排第一。
> 早期版本正是这样写的，结果双方都拿到 0 号出生点，两人完全重叠。
> 端到端测试里的「两人出生点不重叠」就是为了钉死这个回归。

### 4.3 掉落

`InventorySystem.spawnEnemyDrop()` 的掉落表**只由 `enemy.id` 决定**，落地高度来自
同种子地图的 `world.groundHeight()`。因此“击杀归谁”这件事只需要广播一个
“是谁打死的”，击杀者本机即可复现出完全相同的掉落，不需要任何掉落同步消息。

---

## 5. 已知边界（本轮范围）

1. **队友之间没有物理碰撞**，可以互相穿过（见 §2 的取舍）。
2. **`Run`（单局目标/撤离）仍是半同步**：房主广播目标进度与阶段，房客照抄显示；
   但撤离读条与结算仍是各人自己的，不做“全队必须一起撤离”。
3. **敌人对玩家的仇恨是就近选择**（带 20% 迟滞，避免两名队友距离接近时来回换目标）。
   没有仇恨值/嘲讽等高级机制。
4. **断线不做存档恢复**：房客掉线后房主保留其代理一小段时间并显示“离线”，
   重连会作为新成员加入。
5. **上限 4 人**（`MAX_PEERS_PER_ROOM`），超出会被服务器以 `room_full` 拒绝。
6. 房客不跑刷怪导演，因此**房客本机的 `director` 一直处于停止状态**；这是预期行为，
   端到端测试里有对应断言。

---

## 6. 开发与验证

```powershell
node tools/test-lan-server.mjs   # 服务器：帧编解码 / 房间 / 房主转移 / 中继（30 项）
node tools/test-lan-map.mjs      # 同图：生成确定性 / JSON 往返 / 十关可复现（22 项）
node tools/test-lan.mjs          # 端到端：两个真实 Chrome 客户端（45 项）
```

`tools/test-lan.mjs` 会起一个真实的局域网服务器和两个互相独立的 Chrome 实例，
走完整链路：建房 → 加入 → 聊天 → 开局 → 同图同种子 → 互相看见 → 队友模型像素可见
→ 敌人同步 → 命中转发 → 敌人伤害转发 → 运行期无异常。

截图输出在 `docs/verify/lan/`（该目录不入库）。

> 队友可见性是**像素级**验证的：先测同机位连拍的帧间噪声基线，再关掉队友渲染测一次
> 差异，后者必须显著大于前者。只数“亮像素”是错的——深色队友模型反而会让亮像素变少
> （第一次实测 delta = −4173），这一点已经写进测试注释。

---

## 7. 关键文件

```text
tools/lan-server.mjs        零依赖局域网服务器：静态站点 + WebSocket 帧实现 + 房间中继
tools/test-lan-server.mjs   服务器自测（含 RFC 6455 帧编解码用例）
tools/test-lan-map.mjs      同图确定性校验
tools/test-lan.mjs          双客户端端到端验证
开始联机.cmd                房主一键入口（lan-server + --open）
src/net/transport.js        WebSocket 传输：握手、心跳、延迟、自动重连
src/net/protocol.js         消息种类、位标志、紧凑编解码（只 import core/*）
src/net/session.js          会话：大厅、玩家复制、敌人同步、命中/伤害转发
src/net/avatar.js           队友第三人称模型（整身 21 部件，单次 drawInstanced 合批）
src/enemies.js              联机改造：网络 id、多玩家目标选择、复制模式、命中申报
src/main.js                 接入点：种子下发、出生点序号、主循环钩子、联机 intent
src/ui/hud.js               「局域网联机」菜单面板、队友列表、队伍聊天
```
