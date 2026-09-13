# IRONFALL — 模块接口契约 (v1)

> 本文档是各模块的**唯一事实来源**。任何模块只能通过这里定义的接口互相调用。
> 项目：`F:\桌面\codex桌面\ironfall`
> 技术栈：**纯 WebGL2 + 原生 ES Modules，零第三方依赖，零构建步骤**。
> 运行方式：任意静态服务器指向项目根目录（`node tools/serve.mjs`），浏览器打开 `index.html`。

---

## 0. 全局约定

### 0.1 坐标与单位
- 右手坐标系，**Y 轴向上**，米为单位。
- `+X` 右，`+Y` 上，`-Z` 前方（相机默认朝 `-Z`）。
- 角度一律使用弧度。俯仰角 `pitch` 正为抬头；偏航角 `yaw` 绕 Y 轴，`0` 时朝 `-Z`。
- 玩家站立高度 `1.8m`，眼高 `1.62m`。

### 0.2 帧与时序
- 物理固定步长 `PHYS_DT = 1/128` 秒，主循环用累加器跑固定步，**最多 6 步/帧**（防止死亡螺旋）。
- 渲染帧率不设上限（`requestAnimationFrame`），目标 120+ FPS。
- 所有面向玩家的时长用秒；所有调参倾向"手感"而非"真实"。

### 0.3 Vec3 表示
- 统一使用 **`Float32Array(3)`** 或 `{x,y,z}` 均可传入函数；**凡是从函数返回的向量一律是 `Float32Array(3)`**（避免 GC）。
- `math.js` 中所有函数在可选 `out` 参数存在时**写入 out 并返回 out**，否则分配新 `Float32Array(3)`。

### 0.4 模块导入路径
所有内部导入必须带 `.js` 后缀，使用相对路径。示例如下，**不得偏离**：

```js
import * as M from '../core/math.js';
import { CFG } from '../core/config.js';
import * as Events from '../core/events.js';
```

### 0.5 依赖方向（严格单向，禁止反向 import）
```
core/*  ←  engine/*  ←  world.js  ←  player.js / weapons.js / enemies.js
                                        ↓
                               run.js / director.js / upgrades.js
                                        ↓
                                   main.js  →  ui/hud.js
audio/*  ui/*  fx/*  可被上层任意 import，但自己只能 import core/*
```

- `core/*` **不得** import 任何其它项目模块。
- `engine/*` 只能 import `core/*`。
- `audio/audio.js`、`ui/hud.js`、`fx/gltf.js` 只能 import `core/*`。
- `world.js` 只能 import `core/*` 与 `engine/*`。

### 0.6 禁止事项
- 禁止 `eval` / `new Function`（CSP 与调试友好）。
- 禁止在物理步内分配数组/对象（热路径零 GC）。
- 禁止 `console.log` 在每帧路径中输出。
- 禁止 `import` 外部 URL。
- 所有文件必须是**严格模式 ES module**（`"use strict"` 非必需，ESM 默认严格）。

### 0.7 代码风格
- 2 空格缩进，单引号，语句必带分号。
- 中文注释用于**设计意图**，英文用于标识符。
- 每个文件顶部写一行 `// ==== 模块名 — 一句话职责 ====`。

---

## 1. `core/math.js`

无状态数学库。全部为导出函数。

```js
// 构造
export function v3(x = 0, y = 0, z = 0) -> Float32Array(3)
export function copy3(a, out) -> out
export function set3(out, x, y, z) -> out
export function clone3(a) -> Float32Array(3)
export function zero3(out) -> out

// 运算
export function add3(a, b, out) -> out
export function sub3(a, b, out) -> out
export function mul3(a, b, out) -> out            // 逐分量乘
export function scale3(a, s, out) -> out
export function addScaled3(a, b, s, out) -> out   // out = a + b*s
export function neg3(a, out) -> out
export function dot3(a, b) -> number
export function cross3(a, b, out) -> out
export function len3(a) -> number
export function lenSq3(a) -> number
export function dist3(a, b) -> number
export function distSq3(a, b) -> number
export function normalize3(a, out) -> out         // 零向量返回 (0,0,0)
export function lerp3(a, b, t, out) -> out
export function min3(a, b, out) -> out
export function max3(a, b, out) -> out

// 标量
export function clamp(x, lo, hi) -> number
export function clamp01(x) -> number
export function lerp(a, b, t) -> number
export function smoothstep(e0, e1, x) -> number
export function damp(a, b, lambda, dt) -> number  // 指数趋近，帧率无关
export function damp3(a, b, lambda, dt, out) -> out
export function moveTowards(cur, target, maxDelta) -> number
export function moveTowards3(a, b, maxDelta, out) -> out
export function sign(x) -> number
export function approx(a, b, eps = 1e-6) -> boolean
export function toRad(deg) -> number
export function toDeg(rad) -> number
export function wrapAngle(a) -> number            // 归一化到 [-PI, PI]
export function angleLerp(a, b, t) -> number      // 走最短弧

// 哈希噪声（确定性，用于程序化生成）
export function hash2(x, y) -> number             // [0,1)
export function hash3(x, y, z) -> number          // [0,1)
export function valueNoise2(x, y) -> number       // [0,1]，双线性插值
export function fbm2(x, y, octaves = 4, lacunarity = 2, gain = 0.5) -> number  // ~[0,1]
export function mulberry32(seed) -> function(): number  // PRNG
```

### 矩阵（列主序 `Float32Array(16)`，与 WebGL 一致）
```js
export function m4() -> Float32Array(16)              // 单位阵
export function m4Identity(out) -> out
export function m4Mul(a, b, out) -> out               // out = a * b（a 后乘 b）
export function m4Perspective(fovyRad, aspect, near, far, out) -> out
export function m4Ortho(l, r, b, t, n, f, out) -> out
export function m4LookAt(eye, center, up, out) -> out
export function m4FromTranslation(t, out) -> out
export function m4FromTranslationScale(t, s, out) -> out  // s 为 number 或 vec3
export function m4FromTranslationQuatScale(t, q, s, out) -> out
export function m4Invert(a, out) -> out               // 通用 4x4 求逆
export function m4TransformPoint(m, p, out) -> out    // 含平移
export function m4TransformDir(m, p, out) -> out      // 不含平移
export function m4FrustumPlanes(m, outPlanes /* Float32Array(24) */) -> outPlanes

// 四元数 Float32Array(4) = (x,y,z,w)
export function quat() -> Float32Array(4)
export function quatFromAxisAngle(axis, angle, out) -> out
export function quatFromEuler(pitch, yaw, roll, out) -> out   // 顺序 YXZ（先偏航）
export function quatMul(a, b, out) -> out
export function quatSlerp(a, b, t, out) -> out
export function quatRotate(q, v, out) -> out
export function quatNormalize(q, out) -> out
export function quatLookRotation(forward, up, out) -> out
```

---

## 2. `core/config.js`

导出单个冻结对象 `CFG`。所有可调手感参数集中在 `CFG.move` / `CFG.weapon` / `CFG.cam` / `CFG.fx` / `CFG.ai`。
`CFG` 是**可写的浅层对象**（允许运行时调参），但键名固定。至少包含：

```js
export const CFG = {
  render:  { fovDeg, near, far, fovSprintBoost, maxPixelRatio, shadows, fogNear, fogFar, fogColor, clearColor, targetFpsCap },
  cam:     { eyeHeight, crouchEyeHeight, slideEyeHeight, bobAmp, bobFreq, rollMax, tiltAmount, shakeDecay, fovKick },
  move:    { walkSpeed, sprintSpeed, crouchSpeed, slideSpeed, slideBoost, slideFriction, slideMinSpeed, slideExitSpeed,
             groundAccel, groundDecel, airAccel, airMaxSpeed, airControl, friction, stopSpeed, gravity, terminalVel,
             jumpVel, doubleJumpVel, coyoteTime, jumpBuffer, dashSpeed, dashTime, dashCooldown, dashAirCharges,
             wallRunMinSpeed, wallRunGravity, wallRunStick, wallRunTime, wallJumpUp, wallJumpOut, wallJumpForward,
             wallClimbSpeed, wallClimbTime, mantleMaxHeight, mantleTime, mantleReach,
             grappleRange, grappleSpeed, grappleAccel, grapplePull, grappleCooldown, grappleDetachSpeed,
             slopeAccel, slopeMaxAngle, maxSlopeAngle, stepHeight, slideDownhillBoost, bunnyHopBoost },
  weapon:  { ...见 weapons.js 的 def 字段... },
  ai:      { ...见 enemies.js... },
  fx:      { hitmarkerTime, damageNumbers, tracers, impactDecals, bloodColor, screenShakeScale },
  gameplay:{ maxHealth, maxShield, shieldRegenDelay, shieldRegenRate, maxHeat, heatPerKill, heatDecay, ... },
  audio:   { master, sfx, music },
};
export function resetCFG() -> void   // 恢复出厂默认（深拷贝默认值）
export const CFG_DEFAULTS = { ... }  // 冻结的原始默认值
```

---

## 3. `core/events.js`

极简同步事件总线（避免每帧数组分配）。

```js
export function on(type, fn) -> function   // 返回取消订阅函数
export function off(type, fn) -> void
export function once(type, fn) -> void
export function emit(type, payload) -> void
export function clear(type) -> void
```

### 事件类型表（payload 结构固定）
| type | payload |
|---|---|
| `'player:spawn'` | `{ pos:Float32Array(3) }` |
| `'player:land'` | `{ speed:number, hard:boolean }` |
| `'player:jump'` | `{ kind:'jump'\|'double'\|'wall'\|'mantle' }` |
| `'player:slide'` | `{ start:boolean }` |
| `'player:wallrun'` | `{ start:boolean, side:-1\|1 }` |
| `'player:hurt'` | `{ amount:number, dir:Float32Array(3), hpAfter:number }` |
| `'player:die'` | `{}` |
| `'player:heal'` | `{ amount:number }` |
| `'weapon:fire'` | `{ def, ammo:number }` |
| `'weapon:reload'` | `{ def, start:boolean, duration:number }` |
| `'weapon:ads'` | `{ on:boolean }` |
| `'weapon:switch'` | `{ def }` |
| `'weapon:empty'` | `{ def }` |
| `'hit:enemy'` | `{ damage:number, headshot:boolean, kill:boolean, point:Float32Array(3), enemy:object }` |
| `'hit:player'` | `{ damage:number, point:Float32Array(3), source:object }` |
| `'hit:world'` | `{ point:Float32Array(3), normal:Float32Array(3) }` |
| `'enemy:spawn'` | `{ enemy:object }` |
| `'enemy:die'` | `{ enemy:object, pos:Float32Array(3), byPlayer:boolean }` |
| `'run:start'` | `{ runId:number, tier:number }` |
| `'run:end'` | `{ extracted:boolean, stats:object }` |
| `'objective:progress'` | `{ done:number, total:number, label:string }` |
| `'objective:complete'` | `{ label:string }` |
| `'upgrade:offer'` | `{ offers:Array }` |
| `'upgrade:picked'` | `{ id:string }` |
| `'fx:shake'` | `{ amount:number, time:number }` |
| `'fx:hitmarker'` | `{ kill:boolean }` |
| `'fx:damageNumber'` | `{ value:number, headshot:boolean, pos:Float32Array(3) }` |
| `'ui:message'` | `{ title:string, sub:string, kind:'info'\|'warn'\|'good' }` |
| `'audio:play'` | `{ name:string, pos?:Float32Array(3), gain?:number, rate?:number }` |
| `'time:slowmo'` | `{ scale:number, time:number }` |

---

## 4. `core/input.js`

```js
export const Input = {
  init(canvas) -> void,            // 绑定 keyboard/mouse/wheel/pointerlock
  update(dt) -> void,              // 每帧开始调用，滚动"本帧按下/抬起"状态
  endFrame() -> void,              // 每帧结束调用，清空 justPressed/justReleased 累积
  requestLock() -> void,           // 请求指针锁定（用户手势内调用）
  exitLock() -> void,
  get locked() -> boolean,
  get pointerLocked() -> boolean,  // 同 locked

  // 键盘：key 为 KeyboardEvent.code（'KeyW'，'Space'，'ShiftLeft'…）
  down(code) -> boolean,
  pressed(code) -> boolean,        // 本帧首次按下
  released(code) -> boolean,

  // 动作（可重绑定）：动作名 -> 键位数组，见 CONFIG 默认表
  actionDown(name) -> boolean,
  actionPressed(name) -> boolean,
  actionReleased(name) -> boolean,
  setBinding(name, codes, mouseButtons = []) -> void,
  getBindings() -> object,

  // 鼠标
  mouseDX -> number,               // 本帧累积位移（像素）
  mouseDY -> number,
  wheel -> number,
  mouseDown(btn) -> boolean,       // 0 左 1 中 2 右
  mousePressed(btn) -> boolean,
  mouseReleased(btn) -> boolean,

  // 设备辅助
  get sensitivity() -> number,
  setSensitivity(v) -> void,
  get invertY() -> boolean,
  setInvertY(v) -> void,
  get rawInput() -> boolean,       // 是否使用 movementX/Y
  consumeMouseDelta(out2) -> void, // out2 = Float32Array(2)，并清零累积
  endFrame_() -> void,
};

export const ACTIONS = {
  forward:['KeyW'], back:['KeyS'], left:['KeyA'], right:['KeyD'],
  jump:['Space'], crouch:['ControlLeft','KeyC'], sprint:['ShiftLeft'],
  reload:['KeyR'], dash:['AltLeft'], grapple:['KeyQ'], melee:['KeyV'],
  interact:['KeyE'], weapon1:['Digit1'], weapon2:['Digit2'], upgrade1:['Digit1'], upgrade2:['Digit2'], upgrade3:['Digit3'],
  pause:['Escape'], map:['KeyM'], fire:['Mouse0'], ads:['Mouse1'],
};
```

要点：
- 指针锁定时监听 `mousemove` 的 `movementX/movementY`；若浏览器给出异常大的跳变（>250px）则丢弃该帧（防抖）。
- `sprint` 默认**切换式**：`actionPressed('sprint')` 切换 `sprintToggle`；同时保留按住判定 `CFG` 开关。
- 必须调用 `preventDefault` 阻止 `Space/Tab/方向键/滚轮` 默认行为。

---

## 5. `engine/engine.js`

```js
export class Engine {
  constructor(canvas, opts = {})        // 获取 webgl2 上下文；失败时 throw Error('WEBGL2_UNAVAILABLE')
  readonly gl: WebGL2RenderingContext
  readonly width: number
  readonly height: number
  readonly aspect: number
  readonly dpr: number
  readonly caps: { maxTextureSize, maxSamples, ... }

  setSize(w, h, dpr) -> void            // 处理 canvas.width/height 与视口
  beginFrame() -> void                  // 清屏、重置统计
  endFrame() -> void
  setCamera(pos, forward, up, fovDeg, near, far) -> void   // 记录 view/proj/viewProj + 视锥
  readonly view: Float32Array(16)
  readonly proj: Float32Array(16)
  readonly viewProj: Float32Array(16)
  readonly cameraPos: Float32Array(3)
  readonly frustum: Float32Array(24)
  inFrustumSphere(c, r) -> boolean

  // 网格
  createMesh(data) -> Mesh             // data: {positions:Float32Array, normals:Float32Array, colors:Float32Array|null, uvs:Float32Array|null, indices:Uint32Array|Uint16Array}
  createMeshFromGLTF(prim) -> Mesh
  destroyMesh(mesh) -> void
  drawMesh(mesh, modelMatrix, opts = {}) -> void           // opts: {color:[r,g,b,a], unlit:boolean, emissive:number}
  drawInstanced(mesh, modelMatrices /* Float32Array(N*16) */, count, opts = {}) -> void
  readonly instanceBuffer: InstanceBuffer                  // 复用缓冲，避免每帧分配

  // 批次（可选的高层 API）
  beginBatch(mesh) -> void
  pushInstance(modelMatrix, color /* [r,g,b,a] */) -> void
  endBatch() -> void

  // 调试线
  drawLine(a, b, color) -> void
  drawLines(vertices /* Float32Array(N*3) */, colors /* Float32Array(N*3) */, count) -> void

  // 统计
  readonly stats: { drawCalls, triangles, instances, frameMs, cpuMs, gpuMsApprox, fps, fpsAvg }
}
```

渲染要求：
- **单着色器家族**：顶点属性 `aPos(vec3) aNormal(vec3) aColor(vec3)` + 实例属性 `aModel(mat4) aTint(vec4)`。用 `#define` 变体（unlit / fog / emissive）编译少量程序并缓存。
- **平直着色**：法线由几何生成阶段提供（面法线），着色器使用简单 Lambert + 半球环境光 + 边缘光 + 距离雾。工业风冷色调。
- 顶点色与实例 tint 相乘。
- 深度测试开启，背面剔除默认开启（`cull:false` 选项可关）。
- `drawInstanced` 必须**不产生每帧分配**：内部使用预分配的 staging `Float32Array`，按需增长。
- 提供 `engine.programs` 无障碍访问以便调试。

---

## 6. `engine/geometry.js`

程序化网格生成（低多边形，仅够用）。全部返回 `{positions, normals, colors, uvs, indices}` 结构。

```js
export function box(w, h, d, color) -> MeshData            // 以原点为中心
export function boxMinMax(min, max, color) -> MeshData
export function planeGrid(w, d, segX, segZ, color) -> MeshData
export function cylinder(rTop, rBottom, h, segments, color) -> MeshData   // 轴为 Y，原点在几何中心
export function sphere(r, segments, rings, color) -> MeshData
export function capsule(r, h, segments, color) -> MeshData
export function cone(r, h, segments, color) -> MeshData
export function quad(a, b, c, d, color) -> MeshData       // 四个 vec3 逆时针
export function mergeMeshData(list /* MeshData[] */) -> MeshData
export function transformMeshData(md, modelMatrix) -> MeshData
export function colorizeMeshData(md, color) -> MeshData
export function generateHeightfield({ size, segments, heightFn, colorFn }) -> MeshData
export function generateLattice(heightFn, sampleFn, segX, segZ, sizeX, sizeZ, originX, originZ) -> MeshData
export function vertexCount(md) -> number
export function triangleCount(md) -> number
```

约定：`MeshData` 中 `colors` 可为 `null`（引擎回退到实例 tint）。顶点绕序 **逆时针为正**（CCW front face）。

---

## 7. `engine/collision.js`

纯几何。无状态、不可变。

```js
// 射线 vs 三角/盒
export function rayAABB(origin, dir, min, max) -> {t, normal}|null
export function rayTriangle(origin, dir, a, b, c) -> {t, u, v}|null     // 双面
export function raySphere(origin, dir, center, r) -> {t, normal}|null
export function rayCapsule(origin, dir, p0, p1, r) -> {t, normal}|null

// 点/球 vs 三角
export function closestPointOnTriangle(p, a, b, c, out) -> out          // 返回 out，写入最近点
export function sphereTriangle(center, r, a, b, c) -> {point, normal, depth}|null
export function sphereAABB(center, r, min, max) -> {point, normal, depth}|null

// 胶囊（用线段 p0-p1 + 半径 r 表示）扫掠与分离
export function capsuleTriangle(p0, p1, r, a, b, c) -> {point, normal, depth}|null
export function capsuleAABB(p0, p1, r, min, max) -> {point, normal, depth}|null

// 扫掠球（防穿透）
export function sphereCastTriangle(center, r, delta, a, b, c) -> {t, point, normal}|null
export function sphereCastAABB(center, r, delta, min, max) -> {t, point, normal}|null

// 工具
export function closestPointSegment(p, a, b, out) -> out
export function segmentSegmentDistance(p1, q1, p2, q2) -> {s, t, dist}
export function pointInAABB(p, min, max) -> boolean
export function aabbOverlapSphere(min, max, c, r) -> boolean
export function expandAABB(out6, min, max, pad) -> out6                 // out6 = Float32Array(6)
export function capsuleBounds(pos, height, radius, out6) -> out6
```

### 空间加速
```js
export class SpatialHash {
  constructor(cellSize = 8)
  clear() -> void
  insertBox(id, min, max) -> void
  insertTri(id, a, b, c) -> void          // 用三角形 AABB 插入
  queryBox(min, max, out /* array */) -> out   // 返回 id 列表（复用 out，清空后填充）
  querySphere(c, r, out) -> out
  queryRay(origin, dir, maxT, out) -> out      // 用 DDA 走格
}
```

要求：零 GC 热路径（`query*` 复用调用方传入的数组），cell 用 `Map<number, Array>`，key = 整数编码 `((ix+32768)<<16)|(iy+32768)`。

---

## 8. `world.js`

```js
export const MAP_FORMAT_VERSION = 1;

export class World {
  constructor(engine, opts = {})

  // 载入地图：data 可以是 BuiltinMap 返回的 JSON 对象或从 .json 解析的对象
  load(mapData) -> void
  unload() -> void

  // 渲染
  render(engine) -> void
  buildStaticMeshes() -> void

  // 碰撞查询（供 player/enemies 使用）
  readonly triangles: Float32Array | null        // 每 9 个 float 一个三角形
  readonly triangleCount: number
  readonly boxes: Array<{ min:Float32Array(3), max:Float32Array(3), flags:number, id:number }>
  readonly hash: SpatialHash

  // 便捷查询
  groundHeight(x, z) -> number                   // 地形高度（不含盒子）
  groundNormal(x, z, out) -> out
  sampleSlope(x, z) -> number                    // 0=平地，1=垂直
  isWallrunSurface(normal) -> boolean            // |n.y| < 0.34
  isWalkable(normal, maxSlopeCos) -> boolean

  // 射线（含三角与盒子），返回 {hit, t, point, normal, boxId, triIndex}
  raycast(origin, dir, maxDist, opts = {}) -> object
  // 胶囊碰撞求解：pos 为胶囊底部中点；返回解算后的 pos 与累积法线
  resolveCapsule(posOut, radius, height, iterations = 4) -> { grounded, groundNormal, contacts:number }
  // 地面探测
  probeGround(pos, radius, height, maxDist = 0.35) -> { grounded, groundNormal, distance }

  // 出生点 / 目标点
  spawnPoints() -> Array<Float32Array(3)>         // 敌人出生
  playerSpawns() -> Array<Float32Array(3)>
  extractPoints() -> Array<{ pos:Float32Array(3), radius:number }>
  objectives() -> Array<object>
  randomOpenPoint(rng, minDistFromPlayer, out) -> out

  // 可见性/导航辅助
  lineOfSight(a, b, opts = {}) -> boolean
  randomNavPoint(rng) -> Float32Array(3)

  // 外来模型导入（见第 9 节）
  importVisual(gltfDoc, placement) -> void
  readonly importedCount: number
}
```

### 8.1 地图 JSON 格式（`MAP_FORMAT_VERSION = 1`）
```jsonc
{
  "version": 1,
  "name": "IRONFALL-01 // 熔炉星港",
  "biome": "industrial_forge",         // 见 builtin-maps.js 的生物群系列表
  "size": 320,                          // 正方形边长（米）
  "seed": 1337,
  "terrain": {
    "resolution": 96,                   // 每边采样数，网格 = (resolution-1)^2 * 2 三角形
    "baseHeight": 0,
    "amplitude": 14,
    "octaves": 4,
    "lacunarity": 2.0,
    "gain": 0.5,
    "plateau": [ { "x": 0, "z": 0, "radius": 40, "height": 2, "falloff": 18 } ],
    "trenches": [ { "x": 60, "z": -30, "radius": 16, "depth": -10, "falloff": 10 } ]
  },
  "boxes": [
    { "min": [-8, 0, -8], "max": [8, 6, 8], "flags": 1, "material": "concrete" }
    // flags 位：1=可碰撞 2=可蹬墙 4=可攀爬 8=可破坏(预留) 16=平台 32=掩体
  ],
  "platforms": [ { "pos": [0, 6, 0], "size": [10, 0.5, 10], "angle": 0.3, "flags": 17 } ],
  "catwalks": [ { "points": [[0,8,0],[30,8,-20]], "width": 2.5, "flags": 17 } ],
  "walls": [ { "points": [[-20,0,10],[-20,10,10]], "height": 8, "thickness": 1.2, "flags": 3 } ],
  "props": [ { "type": "crate", "pos": [4,0,4], "scale": 1.5, "yaw": 0.4 } ],
  "spawnPoints": [ [10, 0, 10] ],
  "playerSpawns": [ [0, 0, 0] ],
  "extractPoints": [ { "pos": [140, 0, 140], "radius": 6 } ],
  "objectives": [ { "id":"core_a", "type":"destroy", "label":"摧毁热核中继", "pos":[50,0,-40], "radius":5, "required":true } ],
  "lighting": { "sunDir": [-0.4, -0.8, -0.3], "sunColor": [1.0,0.86,0.7], "ambient": [0.16,0.19,0.26], "fogColor": [0.09,0.11,0.15], "fogNear": 60, "fogFar": 320 }
}
```
- `min`/`max` 为世界空间 AABB 角点（`max.y > min.y`）。
- `flags` 缺省为 `1`。位定义见 `builtin-maps.js` 导出的 `FLAG`。
- 所有坐标为米，Y 向上。

### 8.2 地形高度函数
`World` 依据 `terrain` 段构造高度函数 `h(x,z)`，必须**确定性**（同 seed 同结果），并导出：
```js
export function makeHeightFn(terrainSpec) -> function(x, z): number
```
地形网格与 `groundHeight()` 必须使用**同一函数**，误差 < 1e-3。

---

## 9. `fx/gltf.js` + 模型导入通道

`fx/gltf.js` 为**零依赖最小 GLTF/GLB 加载器**（仅视觉，不含动画、蒙皮、材质 PBR；取 baseColorFactor 与位置/法线/索引）。

```js
export async function loadGLTF(url) -> GLTFDocument
// GLTFDocument: { meshes: Array<{name, prims: Array<{positions, normals, colors, indices, material}>}>, nodes: Array<{name, mesh, matrix:Float32Array(16), children:number[]}>, scenes: [{nodes:number[]}], json:object }
export function gltfInstanceModels(doc) -> Array<{ meshIndex:number, matrix:Float32Array(16) }>  // 展平为 (mesh, worldMatrix) 列表
export function describeGLTF(doc) -> { meshes:number, triangles:number, nodes:number }
```

**导入通道要求（面向未来美术资源）**：
1. 把 `.glb` / `.gltf` 放入 `public/models/`。
2. 编辑 `public/models/manifest.json`：
```jsonc
{
  "visuals": [
    { "id": "tower_a", "file": "tower_a.glb", "category": "structure",
      "placements": [ { "pos": [10,0,-20], "yaw": 0.5, "scale": 1.0 } ],
      "collision": { "mode": "none" }   // "none" | "box" | "aabbPerNode"
    }
  ],
  "replace": { "prop.crate": "crate_hd.glb" }   // 键为程序化模型 ID
}
```
3. `main.js` 启动时 `loadModelManifest()` → 对每个条目 `loadGLTF` → `world.importVisual`。
4. **碰撞策略**：`collision.mode === 'none'` 时模型纯装饰；`'box'` 时用模型 AABB 生成一个碰撞盒；`'aabbPerNode'` 时每个网格节点生成一个 AABB。程序化几何体始终保留为**碰撞权威**，导入模型只替换**渲染**。
5. `replace` 表用于在不改地图的前提下用高模替换某个程序化道具（例如 `prop.crate`、`prop.barrel`、`prop.pipe`）。替换后原程序化网格不绘制。

模型规范（写入 README）：单位米，Y 向上，原点在几何中心底部（脚底），面朝 `-Z`，单文件 GLB，三角面 < 50k。

---

## 10. `player.js`

Apex 风格强化运动系统。**这是项目的核心，必须做到位。**

```js
export class Player {
  constructor(world, engine, opts = {})

  // 状态（只读语义，外部可读）
  readonly pos: Float32Array(3)             // 胶囊底部中点
  readonly vel: Float32Array(3)
  readonly eyePos: Float32Array(3)
  readonly forward: Float32Array(3)
  readonly right: Float32Array(3)
  yaw: number
  pitch: number
  roll: number                               // 相机滚转（视觉）
  readonly state: {
    grounded: boolean, groundNormal: Float32Array(3),
    sliding: boolean, crouching: boolean, sprinting: boolean,
    wallRunning: boolean, wallSide: -1|1|0, wallNormal: Float32Array(3),
    wallClimbing: boolean, mantling: boolean, dashing: boolean,
    airJumps: number, dashCharges: number, grappleActive: boolean,
    speed: number, sprintFraction: number, lastLandImpact: number,
  }
  health: number
  shield: number
  alive: boolean

  setInput(input) -> void
  step(dt, input) -> void                    // 固定步长调用
  updateCamera(dt) -> void                   // 更新 eyePos/forward/roll/震动
  look(dx, dy) -> void                       // 鼠标增量（已乘灵敏度）
  applyDamage(amount, dir, source) -> void
  heal(amount) -> void
  respawn(pos) -> void
  teleport(pos) -> void
  addImpulse(v) -> void
  setModifiers(mods) -> void                 // 来自 upgrades.js 的属性乘区
  grappleTarget() -> object|null             // 当前抓钩目标（用于画绳）
  debugState() -> object
}
```

### 10.1 必须实现的运动机制（每项都要有独立的调参项）
1. **基础移动**：Quake 风格 `accelerate()`（`groundAccel` / `airAccel`），带 `stopSpeed` 摩擦。
2. **冲刺/疾跑**：`sprintSpeed`，有加速斜坡（~0.35s 到满速），影响 FOV 与相机滚转。
3. **滑铲**：地面+速度阈值触发；给 `slideBoost` 初速；下坡加速（`slopeAccel` 沿坡向投影），上坡减速；`slideFriction` 递减；低于 `slideExitSpeed` 或松开蹲下退出；滑铲时眼高降低、FOV 略增、相机贴地。
4. **蹬墙跑**：`|n.y| < 0.34` 视为可蹬墙面；需速度 > `wallRunMinSpeed`；重力替换为 `wallRunGravity`；向墙施加 `wallRunStick`；有 `wallRunTime` 上限与冷却；相机向墙侧滚转 `tiltAmount`；墙跑时冷却 `dashAirCharges` 重置。
5. **蹬墙跳**：`wallJumpUp` + `wallJumpOut` + 沿墙前进方向的 `wallJumpForward` 合成，跳出后短暂禁止重新贴同一面墙。
6. **墙爬**：贴墙且按住前+跳跃时以 `wallClimbSpeed` 上升 `wallClimbTime` 秒，可銜接攀爬。
7. **攀爬/翻越 (mantle)**：前方有高度差在 `mantleMaxHeight` 内的可站立面时，0.25s 内插值登顶，期间无重力、无碰撞（用曲线 `smoothstep`）。
8. **二段跳**：`doubleJumpVel`，落地重置；`coyoteTime` 与 `jumpBuffer` 必须实现（手感关键）。
9. **冲刺 (dash)**：`dashTime` 内沿输入方向（或视线方向）以 `dashSpeed` 位移，期间近似无重力、保留水平速度、相机 FOV 冲击；`dashAirCharges` 空中次数。
10. **抓钩 (grapple)**：按一下 `Q` 发射，射线找 `grappleRange` 内的表面/敌人；命中后自动保持并施加朝锚点的弹簧力（`grappleAccel` + `grapplePull`），保留原速度以形成摆荡（**不要**直接把速度设向目标）；到 `grappleDetachSpeed`、近距离、再次按 `Q` 或蹲下时脱离，脱离保留动量。
11. **边坡加速**：下坡时沿坡面切向加速度 `slopeAccel`，上坡衰减；`slideDownhillBoost` 让滑铲下坡明显加速。
12. **空中变向**：`airControl` 允许空中转向；实现 Apex 式的"速度矢量对齐"——`airAccel` 在速度方向与输入方向夹角大于 90° 时提供额外转向（tap-strafe 手感），但设上限避免失控。
13. **兔子跳/连跳**：落地瞬间保留水平速度（`bunnyHopBoost` 可选增益），跳跃不清零水平速度。
14. **台阶 (step-up)**：`stepHeight` 自动上台阶（<=0.45m）。
15. **碰撞**：胶囊（`radius=0.35`，`height=1.8`），迭代求解 `world.resolveCapsule`，最多 4 次；必须能正确处理角落、斜坡不抖动、贴墙不穿插。
16. **相机**：眼高随姿态插值；速度感知的 bob（振幅随速度）；落地冲击 dolly；受伤/开火/爆炸共享震动通道（见 `fx/screenshake.js`）；滚转来自墙跑与侧向移动。
17. **生命/护盾**：护盾先扣，`shieldRegenDelay` 后按 `shieldRegenRate` 恢复。
18. **`debugState()`** 用于 HUD 显示速度、状态位、冷却。

---

## 11. `weapons.js`

R-99 手感的武器与射击系统。

```js
export const WEAPONS = { /* id -> def */ };
export const WEAPON_IDS = ['r99', 'flatline', 'peacekeeper', 'longbow', 'volt'];

export class WeaponSystem {
  constructor(engine, world, player, opts = {})
  equip(id) -> void
  next() -> void
  prev() -> void
  update(dt, input) -> void           // 处理开火/换弹/切枪/开镜/viewmodel 动画
  render(engine) -> void              // 画第一人称 viewmodel（可含手部）
  get current() -> object             // { def, ammo, reserve, reloading, reloadProgress, spread, ... }
  hitscan(origin, dir, damage, opts) -> object   // 命中判定：先敌人后世界
  addModifiers(mods) -> void
  debugState() -> object
}
```

### 11.1 武器定义字段（`def`）
```js
{
  id:'r99', name:'R-99', nameCN:'R-99 冲锋枪', class:'smg',
  rpm: 1080,                       // 每分钟射速（R-99 手感核心：极快）
  damage: 11, damageHead: 15, damageLeg: 9,
  pellets: 1,
  rangeFar: 90, damageFalloffStart: 22, damageFalloffEnd: 55, falloffMinMul: 0.62,
  magSize: 35, reserveMax: Infinity, reloadTime: 0.60, reloadEmptyTime: 0.60,
  adsTime: 0.14, adsSpreadMul: 0.42, adsMoveMul: 0.72, adsFovMul: 0.85,
  hipSpreadBase: 0.55,             // 度
  spreadPerShot: 0.16,             // 每发增加（度）
  spreadMax: 4.2,
  spreadDecay: 3.0,                // 度/秒 恢复
  spreadMoveMul: 1.9, spreadAirMul: 2.6, spreadCrouchMul: 0.72,
  recoilPitch: 0.34,               // 每发抬头（度）
  recoilYaw: 0.16,                 // 随机水平（度）
  recoilPattern: [[0,0],[0.1,-0.05],...],  // 固定弹道序列（Apex 风格可背弹道），长度 == magSize
  recoilRecovery: 7.5,             // 度/秒 回落
  recoilVisualMul: 1.6,            // 视觉后坐（相机）
  recoilAimMul: 0.45,              // 实际准心偏移比例
  muzzleFlashScale: 1.0, muzzleColor:[1.0,0.82,0.42],
  tracerColor:[1.0,0.78,0.35], tracerWidth:0.022, tracerLife:0.045,
  bulletSpeed: 320,                // 弹道视觉速度（m/s）
  fireSound:'r99_fire', reloadSound:'r99_reload', emptySound:'dryfire',
  viewmodel: { /* 见 11.3 */ },
  equipTime: 0.35, holsterTime: 0.28,
  adsSwayMul: 0.35,
}
```

### 11.2 手感硬性要求
- **射速**：`fireInterval = 60/rpm`；在固定步内累计计时器，允许"跨步补发"以匹配真实 RPM（不允许因帧率丢发）。
- **后坐力**：双通道 —— `recoilAim`（真实影响弹道/准心，倍率 `recoilAimMul`）与 `recoilVisual`（相机抬升，`recoilVisualMul`）；两者分别以 `recoilRecovery` 回落。`recoilPattern` 提供确定性弹道序列（第 N 发固定偏移），越打越垂直后坐 + 水平摇摆。
- **散布**：`spread` 由 基础 + 连发累积 + 移动/空中倍率 组成，随 `spreadDecay` 恢复；开镜乘 `adsSpreadMul`。散布表现为**锥内随机方向**，同时**准心动态扩张**（通过 `get current().spread` 供 HUD 使用）。
- **弹道**：视觉使用高速抛射体（`fx/projectiles.js`），命中判定使用**即时射线**（hitscan）以保证判定干脆；两者终点必须一致（用同一次 `Math.random` 之外的确定性抖动：先算方向，弹道按方向飞）。
- **命中反馈**：命中标记（`fx:hitmarker`）、伤害数字、击中特效、击杀提示音、命中音（区分护甲/肉体/爆头）。
- **换弹**：空仓换弹更慢（`reloadEmptyTime`）；换弹可被切枪打断；换弹动画：弹匣下沉 → 移除 → 插入 → 拉栓。
- **开镜**：`adsTime` 内插值 FOV 与 viewmodel 位置到"机瞄对齐"（viewmodel 的 `adsPos`/`adsRot`）；开镜降低散布与移动速度。
- **准心**：由 HUD 依据 `current().spread` 动态开合。

### 11.3 viewmodel（程序化低模）
`def.viewmodel` 描述一组程序化部件，用 `engine/geometry.js` 生成：
```js
viewmodel: {
  parts: [
    { shape:'box', size:[0.10,0.13,0.62], pos:[0,0,0], rot:[0,0,0], color:[0.16,0.17,0.19] },
    { shape:'cylinder', r:0.028, h:0.34, pos:[0,0.055,-0.30], rot:[Math.PI/2,0,0], color:[0.09,0.09,0.10] },
    { shape:'box', size:[0.07,0.18,0.10], pos:[0,-0.14,-0.06], color:[0.13,0.14,0.16] },  // 弹匣
    ...
  ],
  hipPos:[0.20,-0.19,-0.42], hipRot:[0, -0.06, 0], hipScale:1,
  adsPos:[0, -0.088, -0.30], adsRot:[0,0,0],
  sprintPos:[0.24,-0.26,-0.36], sprintRot:[0.28,-0.5,0.18],
  slidePos:[0.26,-0.32,-0.40], slideRot:[0.45,-0.7,0.3],
  muzzleLocal:[0, 0.055, -0.62],       // 枪口在 viewmodel 空间的局部位置
  shellEjectLocal:[0.05, 0.02, -0.12],
}
```
- viewmodel 渲染使用**独立相机**（当前水平 `fov=85°`，near `0.01`），在世界 pass 提交后立即切换并单独提交，且清除深度以避免穿墙。
- 必须有的程序化动画：待机呼吸、走路摆动（随速度）、冲刺低位摆动、滑铲大幅倾斜、开火后坐（位置+旋转，回落）、换弹分阶段、开镜移动、切枪进出、空中/蹬墙跑的位移。

### 11.4 `fx/projectiles.js`（视觉弹道）
```js
export class ProjectilePool {
  constructor(engine, capacity = 512)
  spawn(origin, dir, speed, opts) -> void     // opts: {color, width, life, damage, ownerId, gravity}
  update(dt, world) -> void                   // 移动 + 碰撞检测（射线步进）
  render(engine) -> void                      // 用拉伸的薄长方体/线段渲染
  clear() -> void
  spawnTracer(a, b, opts) -> void             // 瞬时曳光（无需物理）
}
```
命中时 `emit('hit:world'|'hit:enemy')` 并生成撞击特效。

---

## 12. `enemies.js`

```js
export const ENEMY_TYPES = { grunt, shieldman, flyer, heavy, sniper, swarm };
export class EnemySystem {
  constructor(world, player, engine, opts = {})
  spawn(typeId, pos, opts = {}) -> object       // 返回 enemy 实例
  update(dt, player) -> void
  render(engine) -> void
  readonly all: Array<object>
  count() -> number
  damage(enemy, amount, headshot, hitPoint, hitNormal) -> object   // 返回 {killed, damage, shieldDamage, healthDamage, shieldHit, shieldBreak}
  raycastEnemies(origin, dir, maxDist) -> {enemy, t, point, normal, headshot}|null
  explosion(pos, radius, damage) -> void
  clear() -> void
  setDifficulty(scalar) -> void
  debugState() -> object
}
```
**enemy 实例字段**：`{ id, type, pos, vel, hp, maxHp, radius, height, alive, state, yaw, target, fireCooldown, hitboxes:[{name,min,max,offset,multiplier}], speed, color, meshKind, alertness, spawnTime }`
**hitbox 约定**：`head`（倍率 1.0，头部用 `multiplier` 表示额外倍率，由武器 `damageHead` 提供）、`body`、`legs`。

AI 要求：
- 三种基本行为：`idle → alert → engage → reposition → flee`；有**感知**（视锥 + 射线可见性 + 听觉半径）。
- 会走地形（沿坡贴地、不穿墙），使用 `world.resolveCapsule`。
- 分层射击：有预瞄延迟、点射节奏、精度随难度/距离衰减，低难度故意打偏。
- 近战型会冲刺扑击；飞行型走直线并上下浮动；重型有护盾需先破盾；狙击型远距离蓄力并有激光预警。
- 死亡有解体/爆散粒子（`fx/particles.js`）。
- 难度标量 `setDifficulty` 影响：血量倍率、伤害倍率、射速、精度、同时活跃数量上限。

---

## 13. `director.js` — 刷怪与节奏导演

```js
export class Director {
  constructor(world, enemies, player, opts = {})
  start(runState) -> void
  update(dt) -> void
  stop() -> void
  setTier(tier) -> void                // 远征深度 1..N，影响强度
  readonly threat: number               // 0..1 当前威胁度
  readonly state: { phase, waveIndex, budget, aliveCount, intensity, nextWaveIn }
  debugState() -> object
}
```
- **强度预算制**：每秒累积 `budget += rate(tier, threat)`，敌方单位消耗预算；同时活跃单位上限随 tier 增长。
- **相位**：`intro → build → peak → respite → build …`，有明确的"呼吸感"（约 45–75 秒一个循环）。
- **压力反馈**：玩家近期 DPS 高 / 血量高 → 提升强度；玩家低血量连续受击 → 降低强度并给喘息（Apex/Left4Dead 式导演）。
- 刷怪必须在**玩家视野外**且距离 > 25m 的合法点，优先 `world.spawnPoints()`，回退 `world.randomNavPoint()`。
- 目标推进：完成 `world.objectives()` 后进入撤离阶段，`extractPoints` 激活，玩家进入范围并滞留 N 秒即撤离成功。

---

## 14. `upgrades.js` — 肉鸽升级与局内经济

```js
export const UPGRADES = { /* id -> def */ };
export class UpgradeSystem {
  constructor(player, weapons, opts = {})
  rollOffers(count = 3, rng) -> Array<offer>     // offer = { id, def, rarity, price, locked }
  pick(id) -> boolean
  reroll(rng) -> Array<offer>
  get owned() -> Array<{id, stacks}>
  applyAll() -> void                             // 重新计算 player/weapons 的 modifiers
  get modifiers() -> object                      // 传给 player.setModifiers / weapons.addModifiers
  reset() -> void
}
```
**Modifiers 结构（唯一契约）**：
```js
{
  move:   { walkSpeedMul, sprintSpeedMul, airAccelMul, gravityMul, jumpVelMul, dashChargesAdd,
            wallRunTimeMul, grappleRangeMul, slideFrictionMul, maxHealthAdd, ... },  // 未列出的键缺省 1 / 0
  weapon: { damageMul, rpmMul, magSizeAdd, reloadTimeMul, spreadMul, recoilMul, adsTimeMul, ... },
  meta:   { luckAdd, priceMul, ... }
}
```
- 稀有度：`common / rare / epic / legendary`，颜色 `#9aa7b4 / #4aa3ff / #b06bff / #ffb03a`。
- 至少 **24 个升级**，覆盖：机动（滑铲加速、蹬墙跑时长、抓钩距离、二段跳、冲刺次数、空中控制、下坡加速）、武器（伤害、射速、弹匣、换弹、散布、后坐力、穿透）、生存（护盾、回盾延迟、吸血、击杀回血）、机制（击杀刷新冲刺、爆头回弹、连杀增伤、暴击率、弹药拾取）。
- 局内经济：击杀掉落**合金**（`alloy`），在**补给站**（`extractPoints` 之外的 `supplyStations`）消费；撤离成功后合金与"远征点数"持久化到 `save.js`。

---

## 15. `audio/audio.js`

```js
export const Audio = {
  init() -> Promise<void>,          // 在用户手势内调用，创建 AudioContext
  get ready() -> boolean,
  play(name, opts = {}) -> void,    // opts: { pos, gain, rate, bus:'sfx'|'music'|'ui' }
  playAt(name, pos, listenerPos, opts = {}) -> void,   // 含距离衰减
  update(dt, listenerPos, listenerForward) -> void,
  setBus(name, gain) -> void,
  setMaster(gain) -> void,
  setPaused(b) -> void,
  startAmbient(biome) -> void,
  stopAll() -> void,
  readonly names: string[],          // 所有可用音效名
};
```
- **纯程序化合成**（WebAudio 振荡器 + 噪声 + 滤波器 + 包络），禁止加载音频文件。
- 必须包含（至少）：`r99_fire`（短促爆裂、有体感低频）、`flatline_fire`、`shotgun_fire`、`sniper_fire`、`sniper_bolt`、`dryfire`、`reload_out`/`reload_in`/`reload_bolt`、`hit_flesh`、`hit_armor`、`hit_head`、`hitmarker`、`kill_confirm`、`player_hurt`、`player_die`、`shield_break`（高频玻璃碎裂、明显大于普通护盾命中）、`jump`、`land_soft`/`land_hard`、`slide_loop`、`wallrun_loop`、`dash`、`grapple_fire`/`grapple_hit`、`mantle`、`explosion`、`enemy_alert`、`enemy_die`、`pickup_alloy`、`upgrade_pick`、`objective_complete`、`extract_countdown`、`extract_success`、`ui_click`/`ui_hover`、`ambient_forge`（低频轰鸣 + 金属共振）。
- 治疗反馈扩展音效：`medkit_use`、`shield_battery_use`（开始读条）与 `medkit_complete`、`shield_battery_complete`（完成确认）；有甲敌人应按护盾命中 → 破盾 → 肉体命中的结算顺序触发对应音效。
- 循环音（`slide_loop`/`wallrun_loop`）需实现 `startLoop(name)`/`stopLoop(name)` 或 `setLoopGain(name, g)`；契约：`play(name, {loop:true})` 返回 handle `{stop(), setGain(g), setRate(r)}`。`play` 在非 loop 时返回 `null`。

---

## 16. `fx/screenshake.js` / `fx/particles.js` / `fx/decals.js`

```js
// screenshake.js
export class ScreenShake {
  constructor()
  add(amount, time, opts = {}) -> void       // opts: {freq, falloff:'linear'|'exp', axis}
  update(dt) -> void
  offset: Float32Array(3)                     // 每帧位置偏移
  rotation: Float32Array(3)                   // 每帧旋转偏移（弧度）
  kick(amount) -> void                        // FOV 冲击
  fovOffset: number
  reset() -> void
}

// particles.js —— 池化，零 GC
export class ParticleSystem {
  constructor(engine, capacity = 4096)
  emit(kind, opts) -> void                    // kind: 'spark'|'smoke'|'blood'|'debris'|'shield'|'muzzle'|'ring'|'dust'|'explosion'
  emitBurst(pos, normal, kind, opts) -> void
  update(dt) -> void
  render(engine) -> void                      // 实例化渲染（billboard 或拉伸四边形）
  clear() -> void
  readonly aliveCount: number
}

// decals.js —— 弹孔贴花
export class DecalSystem {
  constructor(engine, capacity = 256)
  add(point, normal, opts = {}) -> void       // opts: {size, color, kind}
  update(dt) -> void
  render(engine) -> void                      // 略偏移表面的薄四边形，按法线朝向
  clear() -> void
}
```

---

## 17. `fx/gltf.js` — 见第 9 节

---

## 18. `ui/hud.js`

```js
export class HUD {
  constructor(root /* HTMLElement */, ctx /* { player, weapons, enemies, director, run, upgrades, audio } */)
  update(dt) -> void
  render() -> void                  // 更新 DOM 文本/样式（避免每帧重建 DOM）
  showMenu(kind) -> void            // 'main'|'pause'|'upgrade'|'dead'|'extract'|'settings'|'help'
  hideMenu() -> void
  toast(title, sub, kind) -> void
  readonly visible: boolean
}
```
- **DOM + CSS**（非 canvas），`transform`/`opacity` 动画，避免布局抖动。
- 必备元素：动态准心（随 `spread` 开合、命中时闪红/白）、弹药（当前/备弹，大字）、生命+护盾条、技能冷却（冲刺/抓钩/二段跳）、速度表（m/s + 状态标签 `GROUNDED/WALLRUN/SLIDE/AIR/GRAPPLE`）、击杀播报、伤害数字（浮动）、命中标记、连杀计数、目标进度、撤离倒计时、合金数量、升级选购面板（3 选 1，含稀有度色）、小地图/罗盘（含目标与撤离点方位）、FPS/帧时间/实体数调试面板（F3）、操作说明。
- 文本语言：**简体中文**（武器名可附英文）。字体用系统无衬线，工业风配色：底色 `#0b0e12`，主色 `#7fe3ff`，警告 `#ff5a4a`，强调 `#ffb03a`。

---

## 19. `save.js`

```js
export const Save = {
  load() -> object,                 // 缺省返回默认档
  save(state) -> void,
  reset() -> void,
  readonly metaKey: 'ironfall.meta.v1',
  addMetaKey: 'ironfall.meta.v1',   // 持久化元进度
  runKey: 'ironfall.run.v1',
};
export class MetaProgress {
  constructor()
  addAlloy(n) -> void
  addPoints(n) -> void
  buy(perkId) -> boolean
  readonly alloy: number
  readonly points: number
  readonly perks: object
  readonly stats: { runs, extractions, kills, deaths, bestTier, bestTime, bestKills }
  toJSON() -> object
  fromJSON(o) -> void
}
```

---

## 20. `main.js`

启动、主循环、系统编排、调试面板。

```js
export class Game {
  constructor(canvas, hudRoot)
  async init() -> Promise<void>
  start() -> void
  stop() -> void
  step(dtFixed) -> void             // 固定步：player.step / weapons.update / enemies.update / director.update
  frame(dtRender) -> void           // 渲染帧：camera、插值、fx.update、hud.update
  restartRun(seed) -> void
  debugState() -> object
}
export const game = ...             // 单例，便于控制台调试
window.__IRONFALL__ = { game, CFG, Engine, World, ... }   // 自动化测试钩子
```

**自动化测试钩子（必须存在，用于无头验证）**：
- `window.__IRONFALL__.game`
- `game.debugState()` 返回 `{ fps, frameMs, drawCalls, triangles, entities, playerPos, playerSpeed, playerState, weaponId, ammo, runPhase, threat, errors: [] }`
- `window.__IRONFALL__.ready === true` 在首帧渲染后置位。
- `window.__IRONFALL__.errors`：捕获的未处理错误数组 `{message, stack, time}`（同时监听 `window.onerror` 与 `unhandledrejection`）。
- `game.setAutomationMode(b)`：关闭指针锁定要求、允许程序化输入、固定 FOV、禁用随机种子漂移。
- `window.__IRONFALL__.simulate(seconds, inputScript)`：无头环境推进固定步（不依赖真实帧率），`inputScript` 为 `[{t, key, down}]` 或 `{move:[x,y], yaw, pitch, fire:boolean, jump:boolean, dash:boolean, crouch:boolean, grapple:boolean}` 数组。返回 `debugState()`。
- `window.__IRONFALL__.renderOnce()`：强制渲染一帧并返回结果。

---

## 21. 文件清单与负责人

| 路径 | 内容 |
|---|---|
| `index.html` | 入口、CSS 引入、加载遮罩 |
| `styles/*.css` | HUD、菜单、加载页样式 |
| `src/core/math.js` | 数学库 |
| `src/core/config.js` | 全部调参 |
| `src/core/events.js` | 事件总线 |
| `src/core/input.js` | 输入 |
| `src/engine/engine.js` | WebGL2 引擎 |
| `src/engine/geometry.js` | 程序化网格 |
| `src/engine/collision.js` | 碰撞数学 + 空间哈希 |
| `src/world.js` | 世界、地图格式、渲染与碰撞查询 |
| `src/maps/builtin-maps.js` | 4 张程序化地图 + 生物群系 + `FLAG` |
| `src/player.js` | 运动系统 |
| `src/weapons.js` | 武器系统 + viewmodel |
| `src/enemies.js` | 敌人与 AI |
| `src/director.js` | 刷怪导演 |
| `src/upgrades.js` | 肉鸽升级 |
| `src/fx/projectiles.js` | 视觉弹道 |
| `src/fx/particles.js` | 粒子 |
| `src/fx/decals.js` | 贴花 |
| `src/fx/screenshake.js` | 屏幕震动 |
| `src/fx/gltf.js` | GLTF 加载器 |
| `src/audio/audio.js` | 程序化音频 |
| `src/ui/hud.js` | HUD |
| `src/save.js` | 存档与元进度 |
| `src/main.js` | 主循环 |
| `tools/serve.mjs` | 静态服务器 |
| `tools/headless-check.mjs` | 无头验证 |
| `public/models/manifest.json` | 模型导入清单 |
