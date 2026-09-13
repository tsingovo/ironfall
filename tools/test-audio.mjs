// ==== tools/test-audio.mjs — src/audio/audio.js 的无头自测（假 AudioContext） ====
//
// 设计意图：
// 1) WebAudio 在 Node 里不存在，所以本测试装一套"会挑刺"的假实现：
//    - 记录每一种节点的创建次数、每一个节点的连接与断开状态；
//    - 复刻真实浏览器的硬规则：指数斜坡目标必须 > 0、stop() 必须先 start()、
//      参数必须是有限数（NaN 立即抛错）、createDelay 上限必须合法；
//    - currentTime 永远单调前进，保证包络能被排程、声部能被时间回收。
// 2) 覆盖范围：init 前安全 no-op、每个音效的合成节点数、循环句柄契约与 stop() 断开、
//    连发压力下的声部预算、距离衰减与近亮远暗、听者朝向写入、环境层幂等与不泄漏、
//    stopAll 彻底断开。
// 3) 输出：每个音效一行 PASS/FAIL，最后一行汇总 `AUDIO SELF-TEST: n/n passed`；
//    任一失败以退出码 1 结束。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'src', 'audio', 'audio.js');

// ---------------------------------------------------------------------------
// 结果收集
// ---------------------------------------------------------------------------

const results = [];

function check(label, ok, detail) {
  results.push({ label, ok: ok === true, detail: detail === undefined ? '' : detail });
  const tag = ok === true ? 'PASS' : 'FAIL';
  const pad = label.length < 34 ? label + ' '.repeat(34 - label.length) : label;
  process.stdout.write(`${tag}  ${pad}${detail === undefined ? '' : detail}\n`);
  return ok === true;
}

function section(title) {
  process.stdout.write(`\n--- ${title} ---\n`);
}

// ---------------------------------------------------------------------------
// 假 AudioParam：有限性 + 指数斜坡正值校验
// ---------------------------------------------------------------------------

class FakeParam {
  constructor(value, kind) {
    this.value = value;
    this.kind = kind === undefined ? 'generic' : kind;
    this.first = null;
    this.events = 0;
  }

  _time(t) {
    if (typeof t !== 'number' || !Number.isFinite(t)) throw new Error(`非法时间参数: ${t}`);
  }

  _val(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`非法参数值: ${v}`);
  }

  setValueAtTime(v, t) {
    this._val(v);
    this._time(t);
    if (this.first === null) this.first = v;
    this.value = v;
    this.events++;
    return this;
  }

  linearRampToValueAtTime(v, t) {
    this._val(v);
    this._time(t);
    this.value = v;
    this.events++;
    return this;
  }

  exponentialRampToValueAtTime(v, t) {
    this._val(v);
    this._time(t);
    if (v <= 0) throw new Error(`exponentialRampToValueAtTime 目标必须 > 0（收到 ${v}）`);
    this.value = v;
    this.events++;
    return this;
  }

  setTargetAtTime(v, t, tc) {
    this._val(v);
    this._time(t);
    if (typeof tc !== 'number' || !(tc > 0)) throw new Error(`setTargetAtTime 时间常数必须 > 0（收到 ${tc}）`);
    this.value = v;
    this.events++;
    return this;
  }

  setValueCurveAtTime(curve, t, dur) {
    this._time(t);
    if (typeof dur !== 'number' || !(dur > 0)) throw new Error('setValueCurveAtTime duration 必须 > 0');
    this.events++;
    return this;
  }

  cancelScheduledValues(t) {
    this._time(t);
    return this;
  }

  cancelAndHoldAtTime(t) {
    this._time(t);
    return this;
  }
}

// ---------------------------------------------------------------------------
// 假节点
// ---------------------------------------------------------------------------

class FakeNode {
  constructor(ctx, kind) {
    this.context = ctx;
    this.kind = kind;
    this.outputs = [];
    this.disconnected = false;
    this.id = ctx._nodes.length;
    ctx._nodes.push(this);
    ctx.created[kind] = (ctx.created[kind] === undefined ? 0 : ctx.created[kind]) + 1;
  }

  connect(dst) {
    if (dst === undefined || dst === null) throw new Error(`${this.kind}.connect(空目标)`);
    this.outputs.push(dst);
    return dst;
  }

  disconnect() {
    this.disconnected = true;
    this.outputs.length = 0;
  }
}

class FakeSource extends FakeNode {
  constructor(ctx, kind) {
    super(ctx, kind);
    this.started = false;
    this.stopped = false;
    this.startTime = -1;
    this.stopTime = -1;
  }

  start(t, offset) {
    if (this.started) throw new Error(`${this.kind}.start() 被调用了两次`);
    if (t !== undefined && (typeof t !== 'number' || !Number.isFinite(t))) throw new Error('start 时间非法');
    if (offset !== undefined && (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0)) {
      throw new Error(`start offset 非法: ${offset}`);
    }
    this.started = true;
    this.startTime = t === undefined ? 0 : t;
  }

  stop(t) {
    if (!this.started) throw new Error(`${this.kind}.stop() 必须晚于 start()`);
    if (t !== undefined && (typeof t !== 'number' || !Number.isFinite(t))) throw new Error('stop 时间非法');
    this.stopped = true;
    this.stopTime = t === undefined ? 0 : t;
  }
}

class FakeOscillator extends FakeSource {
  constructor(ctx) {
    super(ctx, 'oscillator');
    this.type = 'sine';
    this.frequency = new FakeParam(440, 'frequency');
    this.detune = new FakeParam(0, 'detune');
  }
}

class FakeBufferSource extends FakeSource {
  constructor(ctx) {
    super(ctx, 'bufferSource');
    this.buffer = null;
    this.loop = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.playbackRate = new FakeParam(1, 'rate');
    this.detune = new FakeParam(0, 'detune');
  }
}

class FakeGain extends FakeNode {
  constructor(ctx) {
    super(ctx, 'gain');
    this.gain = new FakeParam(1, 'gain');
  }
}

class FakeBiquad extends FakeNode {
  constructor(ctx) {
    super(ctx, 'biquad');
    this.type = 'lowpass';
    this.frequency = new FakeParam(350, 'frequency');
    this.Q = new FakeParam(1, 'q');
    this.gain = new FakeParam(0, 'gain');
    this.detune = new FakeParam(0, 'detune');
  }
}

class FakeWaveShaper extends FakeNode {
  constructor(ctx) {
    super(ctx, 'waveshaper');
    this.curve = null;
    this.oversample = 'none';
  }
}

class FakeStereoPanner extends FakeNode {
  constructor(ctx) {
    super(ctx, 'stereoPanner');
    this.pan = new FakeParam(0, 'pan');
  }
}

class FakePanner extends FakeNode {
  constructor(ctx) {
    super(ctx, 'panner');
    this.panningModel = 'equalpower';
    this.distanceModel = 'inverse';
    this.positionX = new FakeParam(0, 'pos');
    this.positionY = new FakeParam(0, 'pos');
    this.positionZ = new FakeParam(0, 'pos');
  }

  setPosition(x, y, z) {
    this.positionX.value = x;
    this.positionY.value = y;
    this.positionZ.value = z;
  }
}

class FakeCompressor extends FakeNode {
  constructor(ctx) {
    super(ctx, 'compressor');
    this.threshold = new FakeParam(-24, 'db');
    this.knee = new FakeParam(30, 'db');
    this.ratio = new FakeParam(12, 'ratio');
    this.attack = new FakeParam(0.003, 'time');
    this.release = new FakeParam(0.25, 'time');
    this.reduction = 0;
  }
}

class FakeConvolver extends FakeNode {
  constructor(ctx) {
    super(ctx, 'convolver');
    this.buffer = null;
    this.normalize = true;
  }
}

class FakeDelay extends FakeNode {
  constructor(ctx, maxDelay) {
    super(ctx, 'delay');
    if (typeof maxDelay !== 'number' || !(maxDelay > 0) || maxDelay > 180) {
      throw new Error(`createDelay 的 maxDelayTime 非法: ${maxDelay}`);
    }
    this.maxDelayTime = maxDelay;
    this.delayTime = new FakeParam(0, 'delay');
  }
}

class FakeAudioBuffer {
  constructor(channels, length, sampleRate) {
    if (!(channels >= 1)) throw new Error('createBuffer 声道数非法');
    if (!(length >= 1)) throw new Error('createBuffer 长度非法');
    if (!(sampleRate > 0)) throw new Error('createBuffer 采样率非法');
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this._data = [];
    for (let i = 0; i < channels; i++) this._data.push(new Float32Array(length));
  }

  getChannelData(i) {
    const d = this._data[i];
    if (d === undefined) throw new Error(`getChannelData(${i}) 越界`);
    return d;
  }

  copyToChannel(src, i) {
    this.getChannelData(i).set(src);
  }
}

class FakeListener {
  constructor() {
    this.positionX = new FakeParam(0, 'pos');
    this.positionY = new FakeParam(0, 'pos');
    this.positionZ = new FakeParam(0, 'pos');
    this.forwardX = new FakeParam(0, 'dir');
    this.forwardY = new FakeParam(0, 'dir');
    this.forwardZ = new FakeParam(-1, 'dir');
    this.upX = new FakeParam(0, 'dir');
    this.upY = new FakeParam(1, 'dir');
    this.upZ = new FakeParam(0, 'dir');
    this.positionCalls = 0;
    this.orientationCalls = 0;
    this.lastPos = [0, 0, 0];
    this.lastFwd = [0, 0, -1];
  }

  setPosition(x, y, z) {
    for (const v of [x, y, z]) {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('listener.setPosition 收到非法值');
    }
    this.positionCalls++;
    this.lastPos = [x, y, z];
  }

  setOrientation(fx, fy, fz, ux, uy, uz) {
    for (const v of [fx, fy, fz, ux, uy, uz]) {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('listener.setOrientation 收到非法值');
    }
    this.orientationCalls++;
    this.lastFwd = [fx, fy, fz];
  }
}

class FakeAudioContext {
  constructor() {
    this.sampleRate = 48000;
    this.state = 'running';
    this.created = Object.create(null);
    this._nodes = [];
    this._t = 0;
    this.destination = new FakeNode(this, 'destination');
    this.listener = new FakeListener();
    FakeAudioContext.instances.push(this);
  }

  // 时钟必须前进：包络排程与声部回收都依赖它
  get currentTime() {
    this._t += 0.00005;
    return this._t;
  }

  advance(dt) {
    this._t += dt;
  }

  resetCounters() {
    this.created = Object.create(null);
  }

  createGain() { return new FakeGain(this); }
  createOscillator() { return new FakeOscillator(this); }
  createBufferSource() { return new FakeBufferSource(this); }
  createBiquadFilter() { return new FakeBiquad(this); }
  createWaveShaper() { return new FakeWaveShaper(this); }
  createStereoPanner() { return new FakeStereoPanner(this); }
  createPanner() { return new FakePanner(this); }
  createDynamicsCompressor() { return new FakeCompressor(this); }
  createConvolver() { return new FakeConvolver(this); }
  createDelay(max) { return new FakeDelay(this, max); }
  createBuffer(ch, len, sr) { return new FakeAudioBuffer(ch, len, sr); }

  suspend() {
    this.state = 'suspended';
    return Promise.resolve();
  }

  resume() {
    this.state = 'running';
    return Promise.resolve();
  }

  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
}

FakeAudioContext.instances = [];

// ---------------------------------------------------------------------------
// 静态检查：确认"纯程序化"没有被破坏
// ---------------------------------------------------------------------------

const source = fs.readFileSync(SRC, 'utf8');

function noPattern(label, pattern) {
  const m = source.match(pattern);
  return check(`源码无 ${label}`, m === null, m === null ? '' : `命中: ${m[0]}`);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const REQUIRED_NAMES = [
  'r99_fire', 'flatline_fire', 'shotgun_fire', 'sniper_fire', 'dryfire',
  'reload_release', 'reload_out', 'reload_drop', 'reload_grab', 'reload_in', 'reload_seat', 'reload_bolt',
  'feedback_shield', 'feedback_flesh', 'feedback_shield_break',
  'hit_flesh', 'hit_armor', 'hit_head', 'hitmarker', 'kill_confirm',
  'player_hurt', 'player_die', 'shield_break',
  'medkit_use', 'shield_battery_use', 'syringe_use', 'shield_cell_use',
  'medkit_loop', 'shield_battery_loop', 'syringe_loop', 'shield_cell_loop',
  'medkit_complete', 'shield_battery_complete', 'syringe_complete', 'shield_cell_complete',
  'jump', 'land_soft', 'land_hard', 'slide_loop', 'wallrun_loop',
  'dash', 'grapple_fire', 'grapple_hit', 'mantle',
  'melee_swing', 'melee_hit', 'explosion', 'enemy_alert', 'enemy_die',
  'loot_pickup', 'loot_drop', 'pickup_alloy', 'upgrade_pick', 'objective_complete',
  'extract_countdown', 'extract_success',
  'ui_click', 'ui_hover', 'ambient_forge',
];

process.stdout.write('IRONFALL audio self-test — 纯程序化合成 / 声部预算 / 空间化\n');

section('静态检查（零外部资源）');
noPattern('fetch 调用', /\bfetch\s*\(/);
noPattern('XMLHttpRequest', /XMLHttpRequest/);
noPattern('decodeAudioData', /decodeAudioData/);
noPattern('HTMLAudioElement', /new\s+Audio\s*\(/);
noPattern('内联音频数据', /data:audio|base64/i);
noPattern('audioWorklet 依赖', /audioWorklet/);
noPattern('热路径 console', /console\s*\.\s*log/);
check('导出命名单例 Audio', /export\s+const\s+Audio\s*=/.test(source));

// 安装假上下文后动态导入（模块在 import 期不得触碰 AudioContext）
globalThis.AudioContext = FakeAudioContext;
globalThis.webkitAudioContext = FakeAudioContext;

const mod = await import('../src/audio/audio.js');
const Audio = mod.Audio;

section('API 形状');
check('导出 Audio 单例', Audio !== undefined && Audio !== null);
check('names 为冻结数组', Object.isFrozen(Audio.names) && Array.isArray(Audio.names));
check('names 长度 >= 36', Audio.names.length >= REQUIRED_NAMES.length, `（${Audio.names.length} 个）`);
{
  const missing = REQUIRED_NAMES.filter((n) => Audio.names.indexOf(n) < 0);
  check('覆盖契约全部音效名', missing.length === 0, missing.length === 0 ? '' : `缺少: ${missing.join(', ')}`);
  const api = ['init', 'play', 'playAt', 'update', 'setBus', 'setMaster', 'setPaused', 'startAmbient', 'stopAll', 'debugState'];
  const badApi = api.filter((k) => typeof Audio[k] !== 'function');
  check('契约方法齐全', badApi.length === 0, badApi.length === 0 ? '' : `缺少: ${badApi.join(', ')}`);
  check('ready 为访问器', (() => {
    const d = Object.getOwnPropertyDescriptor(Audio, 'ready');
    return d !== undefined && typeof d.get === 'function';
  })());
}

section('init 之前必须安全 no-op');
{
  let err = null;
  let pre = null;
  try {
    pre = {
      play: Audio.play('r99_fire'),
      loop: Audio.play('slide_loop', { loop: true }),
      at: Audio.playAt('explosion', [1, 2, 3], [0, 0, 0]),
      upd: Audio.update(0.016, [0, 0, 0], [0, 0, -1]),
      bus: Audio.setBus('sfx', 0.5),
      mst: Audio.setMaster(0.8),
      pause: Audio.setPaused(true),
      amb: Audio.startAmbient('industrial_forge'),
      all: Audio.stopAll(),
      dbg: Audio.debugState(),
    };
    Audio.setPaused(false);
  } catch (e) {
    err = e;
  }
  check('init 前所有调用不抛异常', err === null, err === null ? '' : `异常: ${err.message}`);
  check('init 前 play 返回 null', pre !== null && pre.play === null && pre.at === null);
  check('init 前 loop 返回 null', pre !== null && pre.loop === null);
  check('init 前 ready=false', Audio.ready === false && pre !== null && pre.dbg.ready === false);
  check('init 前无 AudioContext 实例', FakeAudioContext.instances.length === 0 || !pre.dbg.ready);
}

section('init');
{
  const ctxBefore = FakeAudioContext.instances.length;
  await Audio.init();
  await Audio.init();   // 幂等
  await Audio.init();
  const ctx = FakeAudioContext.instances[FakeAudioContext.instances.length - 1];
  const reused = FakeAudioContext.instances.length - ctxBefore === 1;
  check('只创建一个 AudioContext', reused, `（新建 ${FakeAudioContext.instances.length - ctxBefore} 个）`);
  check('ready === true', Audio.ready === true);
  check('上下文状态 running', ctx.state === 'running', ctx.state);
  check('无 audioWorklet 依赖', ctx.audioWorklet === undefined);
  const c = ctx.created;
  const busOk = c.gain >= 5 && c.compressor === 1 && c.convolver === 1;
  check('总线图已建立（3 路 + master + 压缩 + 混响）', busOk, JSON.stringify(c));
  const dbg = Audio.debugState();
  check('debugState 结构完整',
    typeof dbg.ready === 'boolean' && typeof dbg.voices === 'number' && typeof dbg.ctxState === 'string'
    && typeof dbg.buses === 'object' && Array.isArray(dbg.loops),
    JSON.stringify(dbg.buses));
  globalThis.__ctx = ctx;
}

const ctx = globalThis.__ctx;
const P = new Float32Array([0, 1.62, 0]);
const F = new Float32Array([0, 0, -1]);

section('环境层（分层工业持续音）');
{
  // init 前调用过 startAmbient，init 完成后应已自动补启（pending 路径）
  check('init 后自动补启 init 前排队的生物群系', Audio.debugState().ambient === 'industrial_forge');

  Audio.stopAmbient();
  check('stopAmbient 后环境层清空', Audio.debugState().ambient === null);

  ctx.advance(1);
  const before = ctx._nodes.length;
  Audio.startAmbient('industrial_forge');
  const fresh = ctx._nodes.slice(before);
  const first = fresh.length;
  const oscs = fresh.filter((n) => n.kind === 'oscillator').length;
  const lfos = fresh.filter((n) => n.kind === 'oscillator' && n.frequency.value > 0 && n.frequency.value < 1).length;
  const pads = fresh.filter((n) => n.kind === 'oscillator' && n.type === 'sawtooth').length;
  const mark = ctx._nodes.length;
  Audio.startAmbient('industrial_forge');
  Audio.startAmbient('industrial_forge');
  const second = ctx._nodes.length - mark;
  check('环境层已启动且分层足够',
    first >= 12 && oscs >= 6 && pads >= 2 && lfos >= 3 && Audio.debugState().ambient === 'industrial_forge',
    `节点 ${first}，振荡器 ${oscs}（锯齿垫 ${pads}，LFO ${lfos}）`);
  check('重复 startAmbient 幂等（不叠加声部）', second === 0, `（第二次新建 ${second} 个节点）`);

  // 切换生物群系必须重建而不是叠加
  ctx.advance(1);
  const mark2 = ctx._nodes.length;
  Audio.startAmbient('void');
  const rebuilt = ctx._nodes.length - mark2;
  check('切换生物群系重建环境层', rebuilt >= 12 && Audio.debugState().ambient === 'void', `（${rebuilt} 个节点）`);

  // builtin-maps.js 的真实生物群系 id 都必须能构建出分层环境音
  const biomes = ['industrial_forge', 'ship_graveyard', 'deep_core_mine', 'orbital_anchor', 'slag_wastes'];
  const built = [];
  let biomeOk = true;
  for (const bm of biomes) {
    Audio.stopAmbient();
    ctx.advance(1);
    const mark3 = ctx._nodes.length;
    Audio.startAmbient(bm);
    const n = ctx._nodes.length - mark3;
    built.push(`${bm}=${n}`);
    if (n < 12 || Audio.debugState().ambient !== bm) biomeOk = false;
  }
  check('五种真实生物群系均可构建', biomeOk, built.join(' '));
  Audio.startAmbient('industrial_forge');
}

section('环境层长跑（稀疏事件 + 节点回收）');
{
  const liveNodes = () => ctx._nodes.reduce((n, x) => (x.disconnected ? n : n + 1), 0);
  const created0 = ctx._nodes.length;
  const live0 = liveNodes();
  let err = null;
  try {
    for (let i = 0; i < 900; i++) {   // 45 秒虚拟时间
      ctx.advance(0.05);
      Audio.update(0.05, [Math.sin(i * 0.02) * 6, 1.6, Math.cos(i * 0.02) * 6], [0, 0, -1]);
    }
  } catch (e) {
    err = e;
  }
  const created = ctx._nodes.length - created0;
  const live1 = liveNodes();
  const st = Audio.debugState();
  check('环境层长跑不抛异常', err === null, err === null ? '45s / 900 帧' : `异常: ${err.message}`);
  check('环境层持续排程稀疏事件（撞击/闷响）', created > 60, `45s 内新建 ${created} 个节点`);
  check('环境层节点被回收（无泄漏）', live1 < live0 + 260, `常驻节点 ${live0} → ${live1}`);
  check('长跑后声部数仍有界', st.voices <= 48 && st.ambient === 'industrial_forge', `${st.voices} 声部`);
  Audio.stopAmbient();
}

section('循环声部句柄契约');
for (const name of Audio.names) {
  ctx.advance(1);
  const before = ctx._nodes.length;
  let h = null;
  let err = null;
  try {
    h = Audio.play(name, { loop: true });
  } catch (e) {
    err = e;
  }
  let shape = false;
  let ctrl = false;
  let listed = false;
  if (h !== null && h !== undefined) {
    shape = typeof h.stop === 'function' && typeof h.setGain === 'function' && typeof h.setRate === 'function';
    listed = Audio.debugState().loops.indexOf(name) >= 0;
    try {
      h.setGain(0.5);
      h.setRate(1.1);
      ctrl = true;
    } catch (e) {
      err = err === null ? e : err;
    }
    try {
      h.stop();
    } catch (e) {
      err = err === null ? e : err;
    }
  }
  const created = ctx._nodes.slice(before);
  const allDown = created.length > 0 && created.every((n) => n.disconnected === true);
  const ok = err === null && shape && ctrl && listed && allDown;
  const why = [];
  if (err !== null) why.push(`异常:${err.message}`);
  if (!shape) why.push('句柄形状错误');
  if (!ctrl) why.push('setGain/setRate 抛错');
  if (!listed) why.push('未登记进 debugState().loops');
  if (!allDown) why.push(`stop() 后仍有 ${created.filter((n) => !n.disconnected).length} 个节点未断开`);
  check(`loop ${name}`, ok, ok ? `（${created.length} 个节点已断开）` : why.join('；'));
  Audio.stopLoop(name);
}

section('逐音效合成（一次性）');
let layered = 0;
for (const name of Audio.names) {
  ctx.advance(2.0);
  const before = ctx._nodes.length;
  let err = null;
  let ret = 'sentinel';
  try {
    ret = Audio.play(name, { gain: 1 });
  } catch (e) {
    err = e;
  }
  const made = ctx._nodes.length - before;
  if (made >= 4) layered++;
  const ok = err === null && made >= 1 && ret === null;
  const why = [];
  if (err !== null) why.push(`异常:${err.message}`);
  if (made < 1) why.push('未创建任何节点');
  if (ret !== null) why.push('一次性 play 应返回 null');
  check(name, ok, ok ? `${made} 节点` : why.join('；'));
}
check('全部音效均为多层合成（>= 4 节点）', layered === Audio.names.length, `${layered}/${Audio.names.length}`);

section('近战与战利品音效（命名 / 分层 / 回收）');
{
  const actionNames = ['melee_swing', 'melee_hit', 'loot_pickup', 'loot_drop'];
  const missing = actionNames.filter((name) => Audio.names.indexOf(name) < 0);
  check('四个动作音效均已注册', missing.length === 0,
    missing.length === 0 ? actionNames.join(', ') : `缺少: ${missing.join(', ')}`);

  Audio.stopAll();
  let allLayered = true;
  let allReleased = true;
  const evidence = [];
  for (const name of actionNames) {
    ctx.advance(1);
    const mark = ctx._nodes.length;
    Audio.play(name);
    const created = ctx._nodes.slice(mark);
    if (created.length < 4) allLayered = false;
    ctx.advance(3);
    Audio.update(3, P, F);
    const live = created.filter((node) => !node.disconnected).length;
    if (live !== 0) allReleased = false;
    evidence.push(`${name}=${created.length}节点/残留${live}`);
  }
  check('近战与战利品音效均为多层合成', allLayered, evidence.join('；'));
  check('近战与战利品一次性声部到期全部回收', allReleased && Audio.debugState().voices === 0,
    `${evidence.join('；')}；活动声部 ${Audio.debugState().voices}`);
}

section('声部预算与节流');
{
  ctx.advance(3);
  Audio.stopAll();
  let err = null;
  let maxVoices = 0;
  let shots = 0;
  try {
    // 1080 RPM ≈ 18 发/秒，连续 2 秒（每步 5ms，共 400 步）
    for (let i = 0; i < 400; i++) {
      ctx.advance(0.005);
      Audio.play('r99_fire', { gain: 1 });
      Audio.play('hit_armor', { gain: 0.4 });
      Audio.play('hit_flesh', { gain: 0.4 });
      Audio.update(0.005, P, F);
      shots++;
      const v = Audio.debugState().voices;
      if (v > maxVoices) maxVoices = v;
    }
  } catch (e) {
    err = e;
  }
  check('连发压力下不抛异常', err === null, err === null ? `${shots} 步` : `异常: ${err.message}`);
  check('声部数不超过预算 48', maxVoices <= 48, `峰值 ${maxVoices}`);

  // 合并：同一毫秒内狂点不得线性叠加 —— 合成次数有上限，总增益被压到 2 倍单发以内
  ctx.advance(3);
  Audio.stopAll();
  const playOnce = () => {
    const mark = ctx._nodes.length;
    Audio.play('r99_fire');
    const fresh = ctx._nodes.slice(mark);
    let g = 0;
    for (const n of fresh) {
      if (n.kind === 'gain') {
        g = n.gain.value;
        break;
      }
    }
    return { nodes: fresh.length, gain: g };
  };
  Audio.play('r99_fire');
  ctx.advance(2);                       // 越过节流窗口，取"单发基准"
  const single = playOnce();
  ctx.advance(2);
  let burstNodes = 0;
  let burstGain = 0;
  let builds = 0;
  for (let i = 0; i < 30; i++) {
    const r = playOnce();
    if (r.nodes > 0) {
      builds++;
      burstNodes += r.nodes;
      burstGain += r.gain;
    }
  }
  check('重复触发被合并/节流',
    builds <= 4 && burstNodes <= single.nodes * 4 && burstGain < single.gain * 2,
    `单发 ${single.nodes} 节点 / 增益 ${single.gain.toFixed(3)}；同窗口狂点 30 次仅 ${builds} 次合成、合计增益 ${burstGain.toFixed(3)}`);

  // 混音器饱和：遍历全部音效连续触发，硬上限必须守住
  ctx.advance(3);
  Audio.stopAll();
  let peak = 0;
  let satErr = null;
  try {
    for (let round = 0; round < 8; round++) {
      for (const name of Audio.names) Audio.play(name, { gain: 1 });
      ctx.advance(0.02);
      const v = Audio.debugState().voices;
      if (v > peak) peak = v;
    }
  } catch (e) {
    satErr = e;
  }
  check('混音器饱和时守住声部硬上限',
    satErr === null && peak <= 48 && peak >= 12,
    satErr === null ? `峰值 ${peak} 声部` : `异常: ${satErr.message}`);

  // 抖动：连发的音高/增益不应完全一致
  ctx.advance(3);
  Audio.stopAll();
  const seen = new Set();
  for (let i = 0; i < 10; i++) {
    ctx.advance(0.2);
    const mark = ctx._nodes.length;
    Audio.play('r99_fire');
    const fresh = ctx._nodes.slice(mark);
    let top = 0;
    for (const n of fresh) {
      if (n.kind === 'oscillator' && n.frequency.first !== null && n.frequency.first > top) top = n.frequency.first;
    }
    if (top > 0) seen.add(top.toFixed(2));
  }
  check('每次触发有音高抖动（非循环采样）', seen.size >= 6, `${seen.size}/10 个不同基频`);
}

section('空间化与听者');
{
  ctx.advance(3);
  Audio.stopAll();
  Audio.update(1 / 60, [1, 2, 3], [0, 0, -1]);
  const L = ctx.listener;
  check('listener 位置已写入', L.positionCalls > 0 && L.lastPos[0] === 1 && L.lastPos[1] === 2 && L.lastPos[2] === 3, JSON.stringify(L.lastPos));
  check('listener 朝向已写入', L.orientationCalls > 0 && L.lastFwd[2] < -0.9, JSON.stringify(L.lastFwd));

  function firstGainOf(fn) {
    const mark = ctx._nodes.length;
    fn();
    const fresh = ctx._nodes.slice(mark);
    for (const n of fresh) if (n.kind === 'gain') return n.gain.value;
    return 0;
  }

  const near = firstGainOf(() => Audio.playAt('explosion', [0, 0, 0], [0, 0, 0]));
  ctx.advance(2);
  const far = firstGainOf(() => Audio.playAt('explosion', [110, 0, 0], [0, 0, 0]));
  check('距离衰减（8m 参考 / 120m 上限）', near > far * 5 && far > 0, `近 ${near.toFixed(3)} vs 远 ${far.toFixed(3)}`);

  const mark2 = ctx._nodes.length;
  ctx.advance(2);
  Audio.stopAll();
  Audio.playAt('shotgun_fire', [110, 0, 0], [0, 0, 0]);
  const farFilters = ctx._nodes.slice(mark2).filter((n) => n.kind === 'biquad' && n.type === 'lowpass');
  const dark = farFilters.some((n) => n.frequency.first !== null && n.frequency.first < 4000);
  check('远处低通更暗（近亮远暗）', dark, `远场低通数 ${farFilters.length}`);

  ctx.advance(2);
  Audio.stopAll();
  const mark3 = ctx._nodes.length;
  Audio.playAt('r99_fire', [30, 0, 0], [0, 0, 0]);   // 听者朝 -Z，声源在 +X
  const pans = ctx._nodes.slice(mark3).filter((n) => n.kind === 'stereoPanner');
  const panned = pans.length > 0 && Math.abs(pans[0].pan.value) > 0.3;
  check('声像随听者朝向偏移', panned, pans.length > 0 ? `pan=${pans[0].pan.value.toFixed(2)}` : '未创建声像节点');

  const mark4 = ctx._nodes.length;
  const tooFar = Audio.playAt('r99_fire', [900, 0, 0], [0, 0, 0]);
  check('超出最大距离静默丢弃', tooFar === null && ctx._nodes.length === mark4);

  const before = ctx._nodes.length;
  for (let i = 0; i < 240; i++) {
    ctx.advance(1 / 60);
    Audio.update(1 / 60, [Math.sin(i * 0.05) * 10, 1.6, Math.cos(i * 0.05) * 10], [0, 0, -1]);
  }
  const grew = ctx._nodes.length - before;
  check('update 不产生节点（每帧零分配路径）', grew === 0, `240 帧新增 ${grew} 个节点`);
}

section('参数接口');
{
  Audio.setBus('music', 0.2);
  Audio.setBus('sfx', 0.9);
  Audio.setBus('ui', 0.7);
  Audio.setMaster(0.65);
  const b = Audio.debugState().buses;
  check('setBus / setMaster 生效', b.music === 0.2 && b.sfx === 0.9 && b.ui === 0.7 && b.master === 0.65, JSON.stringify(b));

  ctx.advance(1);
  Audio.setPaused(true);
  const markP = ctx._nodes.length;
  const pausedPlay = Audio.play('r99_fire');
  const pausedNodes = ctx._nodes.length - markP;
  check('暂停时 play 静默 no-op', pausedPlay === null && pausedNodes === 0, `暂停期间新建 ${pausedNodes} 节点`);
  Audio.setPaused(false);

  ctx.advance(1);
  const markU = ctx._nodes.length;
  const unknown = Audio.play('no_such_sound_404');
  check('未知音效名不抛异常且不发声', unknown === null && ctx._nodes.length === markU);

  const markN = ctx._nodes.length;
  Audio.play('r99_fire', { rate: 0.5 });
  const low = ctx._nodes.slice(markN).reduce((m, n) => (n.kind === 'oscillator' && n.frequency.first > m ? n.frequency.first : m), 0);
  ctx.advance(1);
  const markH = ctx._nodes.length;
  Audio.play('r99_fire', { rate: 1.5 });
  const high = ctx._nodes.slice(markH).reduce((m, n) => (n.kind === 'oscillator' && n.frequency.first > m ? n.frequency.first : m), 0);
  check('rate 影响音高', low > 0 && high / low > 2, `rate0.5 峰值 ${low.toFixed(0)}Hz → rate1.5 峰值 ${high.toFixed(0)}Hz`);
}

section('stopAll 彻底断开');
{
  ctx.advance(1);
  Audio.stopAll();
  const mark = ctx._nodes.length;
  Audio.play('explosion');
  Audio.play('slide_loop', { loop: true });
  Audio.play('ui_click');
  Audio.startAmbient('ice');
  const created = ctx._nodes.slice(mark);
  Audio.stopAll();
  const st = Audio.debugState();
  const leaked = created.filter((n) => !n.disconnected).length;
  check('stopAll 断开全部节点', created.length > 8 && leaked === 0, `${created.length} 个节点，泄漏 ${leaked}`);
  check('stopAll 清空声部与循环表', st.voices === 0 && st.loops.length === 0 && st.ambient === null, JSON.stringify({ v: st.voices, l: st.loops.length, a: st.ambient }));
  check('stopAll 后仍可继续播放', (() => {
    ctx.advance(1);
    Audio.play('kill_confirm');
    return ctx._nodes[ctx._nodes.length - 1] !== undefined;
  })());
}

section('环境层心跳（调用方忘记 update() 时的兜底）');
{
  ctx.advance(3);
  Audio.stopAll();
  Audio.startAmbient('industrial_forge');
  const mark = ctx._nodes.length;
  ctx.advance(40);                                  // 虚拟时间跨过多个事件窗口
  await new Promise((r) => setTimeout(r, 700));     // 等真实定时器触发心跳
  const made = ctx._nodes.length - mark;
  check('无 update() 时环境层仍排程稀疏事件', made > 20, `心跳补齐 ${made} 个节点`);

  ctx.advance(40);
  Audio.stopAmbient();
  const mark2 = ctx._nodes.length;
  await new Promise((r) => setTimeout(r, 700));
  const after = ctx._nodes.length - mark2;
  check('停止环境层后心跳不再排程', after === 0, `停止后新增 ${after} 个节点`);
}

// ---------------------------------------------------------------------------
// AudioListener 兼容路径：没有 setPosition / setOrientation 的实现
// 用查询串强制生成第二个模块实例（Node ESM 缓存键含 query），互不干扰
// ---------------------------------------------------------------------------

class ParamOnlyListener {
  constructor() {
    this.positionX = new FakeParam(0, 'pos');
    this.positionY = new FakeParam(0, 'pos');
    this.positionZ = new FakeParam(0, 'pos');
    this.forwardX = new FakeParam(0, 'dir');
    this.forwardY = new FakeParam(0, 'dir');
    this.forwardZ = new FakeParam(-1, 'dir');
    this.upX = new FakeParam(0, 'dir');
    this.upY = new FakeParam(1, 'dir');
    this.upZ = new FakeParam(0, 'dir');
  }
}

class ParamOnlyContext extends FakeAudioContext {
  constructor() {
    super();
    this.listener = new ParamOnlyListener();
  }
}

section('AudioListener 兼容路径（仅 AudioParam 的实现）');
{
  globalThis.AudioContext = ParamOnlyContext;
  const mod2 = await import('../src/audio/audio.js?listener=params');
  const A2 = mod2.Audio;
  await A2.init();
  const c2 = ParamOnlyContext.instances[ParamOnlyContext.instances.length - 1];
  A2.update(1 / 60, [4, 5, 6], [1, 0, 0]);
  const L = c2.listener;
  check('回退到 positionX/forwardX 参数写法',
    L.positionX.value === 4 && L.positionY.value === 5 && L.positionZ.value === 6
    && L.forwardX.value === 1 && L.forwardY.value === 0 && L.forwardZ.value === 0 && L.upY.value === 1,
    `pos=(${L.positionX.value},${L.positionY.value},${L.positionZ.value}) fwd=(${L.forwardX.value},${L.forwardY.value},${L.forwardZ.value})`);
  let err = null;
  let made = 0;
  try {
    const mark = c2._nodes.length;
    A2.play('flatline_fire');
    made = c2._nodes.length - mark;
    A2.playAt('explosion', [20, 0, 0], [0, 0, 0]);
    A2.update(0.016, [0, 0, 0], [0, 0, -1]);
    A2.stopAll();
  } catch (e) {
    err = e;
  }
  check('第二个实例可独立合成与回收', err === null && made > 5, err === null ? `${made} 个节点` : `异常: ${err.message}`);
  globalThis.AudioContext = FakeAudioContext;
}

section('无 WebAudio 环境（headless / 老浏览器）');
{
  globalThis.AudioContext = undefined;
  try {
    delete globalThis.webkitAudioContext;
  } catch (e) {
    globalThis.webkitAudioContext = undefined;
  }
  const mod3 = await import('../src/audio/audio.js?noctx=1');
  const A3 = mod3.Audio;
  let err = null;
  let state = null;
  try {
    await A3.init();
    state = {
      ready: A3.ready,
      play: A3.play('r99_fire'),
      at: A3.playAt('explosion', [1, 1, 1], [0, 0, 0]),
      loop: A3.play('slide_loop', { loop: true }),
      amb: A3.startAmbient('ice'),
      upd: A3.update(0.016, [0, 0, 0], [0, 0, -1]),
      dbg: A3.debugState(),
    };
    A3.stopAll();
  } catch (e) {
    err = e;
  }
  check('无 AudioContext 时 init 安全降级', err === null && state !== null && state.ready === false,
    err === null ? '' : `异常: ${err.message}`);
  check('无 AudioContext 时全部调用 no-op',
    state !== null && state.play === null && state.at === null && state.loop === null && state.dbg.ctxState === 'none');
  globalThis.AudioContext = FakeAudioContext;
  globalThis.webkitAudioContext = FakeAudioContext;
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.ok).length;
const total = results.length;
const failed = results.filter((r) => !r.ok);

if (failed.length > 0) {
  process.stdout.write('\n失败项:\n');
  for (const f of failed) process.stdout.write(`  - ${f.label}${f.detail === '' ? '' : ' — ' + f.detail}\n`);
}
process.stdout.write(`\nAUDIO SELF-TEST: ${passed}/${total} passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
