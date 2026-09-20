// ==== audio/audio.js — 纯程序化 WebAudio 音效合成、空间化与总线混音 ====
//
// 设计意图：
// 1) 全部声音由振荡器 / 白噪声 / 粉噪声 / 双二阶滤波 / 波形整形 / 包络实时合成，
//    零音频文件、零内联编码数据、零网络请求，因此加载即用、可被无头自测覆盖。
// 2) 每个音效都是「瞬态 + 主体 + 尾巴」的多层叠合：瞬态给“脆”，主体给“体感”，
//    尾巴给“空间”；武器之间靠频谱重心、层数与包络长度区分性格（R-99 是高频机械咬合，
//    Flatline 是中频厚重，和平使者是宽频爆散，长弓是“鞭响 + 金属余韵”）。
// 3) 声部预算（48）+ 同名并发上限 + 最小间隔节流 + 同名合并增益，
//    保证 1080 RPM（18 发/秒）连射时不会把混音器打爆，也不会叠成糊音。
// 4) 每次触发都做 ±4% 音高、±8% 增益、±10% 滤波偏移抖动，
//    让连发听起来是“一梭子子弹”而不是“一个循环采样”。
// 5) 热路径（update）零分配：只做声部回收、听者朝向写入与稀疏的环境事件排程。
//
// 依赖：无。只允许 import core/*，本模块刻意零依赖以便独立自测。

// ---------------------------------------------------------------------------
// 0. 常量
// ---------------------------------------------------------------------------

const REF_DIST = 8;            // 参考距离：此距离内不做距离衰减
const MAX_DIST = 120;          // 最大可闻距离
const MAX_VOICES = 48;         // 同时活跃声部上限
const OPEN_CUT = 20000;        // 贴脸时的低通截止（等于“全开”）
const MIN_CUT = 420;           // 最远时的低通截止（远处只剩闷响）
const GAIN_VAR = 0.08;         // 每次触发增益抖动
const BRIGHT_VAR = 0.1;        // 每次触发滤波中心抖动
const PITCH_VAR = 0.04;        // 每次触发音高抖动（±4%）
const LOOP_MAX = 1800;         // 持续音的兜底停止时间（秒），防止真实浏览器里泄漏
const PRUNE_SLACK = 0.6;       // 节点回收的安全余量（秒）
const AMBIENT_PUMP_IDLE = 0.9; // 心跳兜底判定：update() 静默超过该秒数就由定时器接管
const AMBIENT_PUMP_MS = 500;   // 心跳间隔（真实时间，仅环境层启用时存在）

// 金属共振分音比例：非谐分音是“金属”与“乐音”的分界线
const METAL_PARTIALS = [1, 1.71, 2.43, 3.17, 4.09, 5.33];
const METAL_PARTIALS_HI = [1, 2.07, 3.41, 4.77, 6.12, 7.9];

// ---------------------------------------------------------------------------
// 1. 内部工具：确定性 PRNG / 小数学
// ---------------------------------------------------------------------------

let _seed = 0x1f3a5c7d;

function srand(seed) {
  _seed = (seed >>> 0) || 1;
}

// xorshift32 → [0,1)：比 Math.random 快，且自测可复现
function rnd() {
  let x = _seed;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  _seed = x >>> 0;
  return _seed / 4294967296;
}

function rr(a, b) {
  return a + (b - a) * rnd();
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function noop() {}

// ---------------------------------------------------------------------------
// 2. 模块状态
// ---------------------------------------------------------------------------

let ctx = null;
let _ready = false;
let _paused = false;
let _initPromise = null;

// 混音图：sfx/music/ui → master → compressor → pauseGain → destination
let masterGain = null;
let comp = null;
let pauseGain = null;
let sfxBus = null;
let musicBus = null;
let uiBus = null;
let verbBus = null;
let _verbReady = false;

let _mst = 0.85;
const _busGain = { sfx: 1.0, music: 0.55, ui: 0.85 };

// 听者状态（复用 Float32Array，update 不分配）
const listenerPos = new Float32Array(3);
const listenerFwd = new Float32Array(3);
let _lsMode = 0;               // 0=未探测 1=setPosition/setOrientation 2=AudioParam
let _listenerInit = false;

// 噪声缓冲只建一次（2 秒足够所有噪声层随机取样）
let whiteBuf = null;
let pinkBuf = null;

// 声部池
const voices = [];
const voicePool = [];
let voiceCount = 0;
const nameCount = Object.create(null);
const stats = Object.create(null);
const loopHandles = Object.create(null);

// 复用参数对象：所有 builder 必须在同一次调用内读完，禁止跨调用持有
const _p = { pi: 1, br: 1, r1: 0.5, r2: 0.5, r3: 0.5 };
const _att = { gain: 1, cut: 0, pan: 0 };
const _tmpOpts = { gain: 1, pan: 0, cut: 0, rate: 1, bus: null, loop: false, pos: null };
const _ambOpts = { gain: 1, pan: 0, rate: 1, bus: 'music' };

// 环境层状态
const ambient = {
  v: null, active: false, biome: '', preset: null,
  nextClang: 0, nextThump: 0, lastPump: -1e9,
};
let pendingAmbient = null;
let ambientTimer = null;

// 波形整形曲线缓存（tanh 饱和：工业风的“脏”）
const curveCache = new Map();

// ---------------------------------------------------------------------------
// 3. 声部簿记（预算 / 池化 / 回收）
// ---------------------------------------------------------------------------

function allocVoice(name) {
  let v = voicePool.pop();
  if (v === undefined) {
    v = {
      name: '', def: null, out: null, in: null, lp: null, pan: null,
      nodes: [], ends: [], srcs: [],
      sustained: false, dying: false, endTime: Infinity, unitGain: 1, baseGain: 1, rate: 1,
      repeatEvery: 0, nextRepeat: 0, nextPrune: 0, nextEvent: 0, priority: 0,
    };
  }
  v.name = name;
  v.def = null;
  v.out = null;
  v.in = null;
  v.lp = null;
  v.pan = null;
  v.nodes.length = 0;
  v.ends.length = 0;
  v.srcs.length = 0;
  v.sustained = false;
  v.dying = false;
  v.endTime = Infinity;
  v.unitGain = 1;
  v.baseGain = 1;
  v.rate = 1;
  v.repeatEvery = 0;
  v.nextRepeat = 0;
  v.nextPrune = 0;
  v.nextEvent = 0;
  v.priority = 0;
  voiceCount++;
  const c = nameCount[name];
  nameCount[name] = (c === undefined ? 0 : c) + 1;
  voices.push(v);
  return v;
}

function track(v, node, end) {
  v.nodes.push(node);
  v.ends.push(end);
  return node;
}

function trackSrc(v, node, end) {
  v.srcs.push(node);
  return track(v, node, end);
}

// 断开并停止一个声部的所有节点；这是唯一允许的销毁路径
function killVoiceNodes(v) {
  const srcs = v.srcs;
  for (let i = 0; i < srcs.length; i++) {
    const s = srcs[i];
    if (s !== null && typeof s.stop === 'function') {
      try { s.stop(0); } catch (e) { /* 已停止的源再次 stop 是安全的，忽略 */ }
    }
  }
  srcs.length = 0;
  const ns = v.nodes;
  for (let i = 0; i < ns.length; i++) {
    const n = ns[i];
    if (n !== null && typeof n.disconnect === 'function') {
      try { n.disconnect(); } catch (e) { /* 忽略重复断开 */ }
    }
  }
  ns.length = 0;
  v.ends.length = 0;
}

function releaseAt(i) {
  const v = voices[i];
  const last = voices.length - 1;
  if (i !== last) voices[i] = voices[last];
  voices.pop();
  killVoiceNodes(v);
  const c = nameCount[v.name];
  if (c !== undefined) {
    if (c <= 1) delete nameCount[v.name];
    else nameCount[v.name] = c - 1;
  }
  voiceCount--;
  v.out = null;
  v.in = null;
  v.lp = null;
  v.pan = null;
  if (v === ambient.v) {
    ambient.v = null;
    ambient.active = false;
  }
  voicePool.push(v);
}

function releaseVoiceByRef(v) {
  for (let i = 0; i < voices.length; i++) {
    if (voices[i] === v) {
      releaseAt(i);
      return true;
    }
  }
  return false;
}

// 时间回收：一次性声部到点即销毁（update / play 时调用）
function pruneVoices(now) {
  for (let i = voices.length - 1; i >= 0; i--) {
    const v = voices[i];
    if (v.sustained) continue;
    if (v.endTime <= now) releaseAt(i);
  }
}

// 持续音内部的临时节点回收（脚步、环境撞击等），保持节点数有界
function pruneNodes(v, now) {
  if (now < v.nextPrune) return;
  v.nextPrune = now + 1;
  const ns = v.nodes;
  const es = v.ends;
  let w = 0;
  for (let i = 0; i < ns.length; i++) {
    const e = es[i];
    if (e < now - PRUNE_SLACK) {
      const n = ns[i];
      if (n !== null && typeof n.disconnect === 'function') {
        try { n.disconnect(); } catch (e2) { /* 忽略 */ }
      }
      ns[i] = null;
    } else {
      if (w !== i) {
        ns[w] = ns[i];
        es[w] = e;
        ns[i] = null;
      }
      w++;
    }
  }
  ns.length = w;
  es.length = w;
}

// 抢占（同名并发超限）：快速淡出，避免“咔”声，随后由时间回收真正释放
function stealVoice(v, now) {
  const g = v.out;
  if (g !== null && g.gain !== null) {
    try {
      if (typeof g.gain.cancelScheduledValues === 'function') g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(g.gain.value, now);
      g.gain.linearRampToValueAtTime(0.0001, now + 0.006);
    } catch (e) { /* 忽略 */ }
  }
  v.dying = true;
  v.sustained = false;
  v.endTime = now + 0.008;
}

function oldestVoiceOf(name, now) {
  let best = null;
  for (let i = 0; i < voices.length; i++) {
    const v = voices[i];
    if (v.name !== name) continue;
    if (v.sustained || v.dying) continue;
    if (best === null || v.endTime < best.endTime) best = v;
  }
  return best;
}

// 预算耗尽：立即释放一个最不重要的声部。这里必须“立刻”腾出槽位，
// 否则标记待死的声部会在下一次抢占中被反复复活，声部上限形同虚设。
function reclaimOne(priority) {
  let best = null;
  for (let i = 0; i < voices.length; i++) {
    const v = voices[i];
    if (v.sustained || v.dying) continue;
    if (v.priority > priority) continue;
    if (best === null || v.endTime < best.endTime) best = v;
  }
  if (best === null) return false;
  releaseVoiceByRef(best);
  return true;
}

// ---------------------------------------------------------------------------
// 4. 合成工具包（全部为内部函数，节点一律追踪以便 stop() 能彻底断开）
// ---------------------------------------------------------------------------

function gainNode(v, end, value) {
  const g = ctx.createGain();
  g.gain.value = value === undefined ? 1 : value;
  return track(v, g, end);
}

/**
 * 双二阶滤波器的安全频率上限。
 * 采样率 48kHz 时奈奎斯特是 24kHz，超过会被浏览器夹紧并打印 warning；
 * 我们主动夹到 0.45×采样率，既消除告警也避免滤波器行为失真。
 */
function safeFreq(hz) {
  const nyquist = (ctx && ctx.sampleRate ? ctx.sampleRate : 48000) * 0.45;
  const v = Number.isFinite(hz) ? hz : 1;
  return Math.min(Math.max(1, v), nyquist);
}

function filt(v, end, type, freq, q, gainDb) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = safeFreq(freq);
  if (q !== undefined && q !== null && f.Q !== undefined) f.Q.value = q;
  if (gainDb !== undefined && f.gain !== undefined) f.gain.value = gainDb;
  return track(v, f, end);
}

function shaper(v, end, amount) {
  const ws = ctx.createWaveShaper();
  ws.curve = shaperCurve(amount);
  if (ws.oversample !== undefined) ws.oversample = '2x';
  return track(v, ws, end);
}

function shaperCurve(amount) {
  const key = Math.round(clamp(amount, 1, 40) * 2) / 2;
  let c = curveCache.get(key);
  if (c !== undefined) return c;
  const n = 1024;
  c = new Float32Array(n);
  const norm = Math.tanh(key) || 1;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * key) / norm;
  }
  curveCache.set(key, c);
  return c;
}

// 噪声源：缓存缓冲 + 随机取样偏移 → 同一段噪声每次听感都不同
function srcNoise(v, t0, dur, kind, rate, end) {
  const b = noiseBuf(kind);
  const s = ctx.createBufferSource();
  s.buffer = b;
  s.loop = true;
  const r = rate === undefined ? 1 : rate;
  s.playbackRate.value = r;
  s.__src = 'buf';
  s.__baseRate = r;
  trackSrc(v, s, end);
  s.start(t0, rnd() * (b.duration * 0.9));
  s.stop(end);
  return s;
}

// 持续振荡器（环境层 / 循环音用），一次性振荡器由 tone() 负责
function oscNode(v, type, freq, detune, end, t0) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = Math.max(0.01, freq);
  o.detune.value = detune || 0;
  o.__src = 'osc';
  o.__baseDetune = detune || 0;
  trackSrc(v, o, end);
  o.start(t0);
  o.stop(end);
  return o;
}

// 统一打击包络：静音 → attack 到峰值 → 指数衰减到近乎静音
function env(param, t0, peak, attack, dur, hold) {
  const a = Math.max(0.0004, attack === undefined ? 0.001 : attack);
  const h = hold === undefined ? 0 : hold;
  const dec = Math.max(0.004, dur - a - h);
  const pk = Math.max(0.0002, peak);
  param.setValueAtTime(0.0001, t0);
  if (attack === 0) param.setValueAtTime(pk, t0);
  else param.linearRampToValueAtTime(pk, t0 + a);
  if (h > 0) param.setValueAtTime(pk, t0 + a + h);
  param.exponentialRampToValueAtTime(0.0001, t0 + a + h + dec);
  return t0 + a + h + dec;
}

// 音调层：可选频率下坠、可选滤波器、可选过载
function tone(v, t0, o) {
  const dur = o.dur === undefined ? 0.2 : o.dur;
  const end = t0 + dur + 0.04;
  const osc = ctx.createOscillator();
  osc.type = o.type === undefined ? 'sine' : o.type;
  const f0 = Math.max(1, o.freq);
  osc.frequency.setValueAtTime(f0, t0);
  if (o.to !== undefined && o.to !== f0) {
    const tt = t0 + (o.sweepTime === undefined ? dur : o.sweepTime);
    const f1 = Math.max(1, o.to);
    if (o.linear === true) osc.frequency.linearRampToValueAtTime(f1, tt);
    else osc.frequency.exponentialRampToValueAtTime(f1, tt);
  }
  const det = o.detune === undefined ? 0 : o.detune;
  osc.detune.value = det;
  if (o.detuneTo !== undefined) {
    osc.detune.setValueAtTime(det, t0);
    osc.detune.linearRampToValueAtTime(o.detuneTo, t0 + dur);
  }
  osc.__src = 'osc';
  osc.__baseDetune = det;
  trackSrc(v, osc, end);
  const g = gainNode(v, end, 0);
  env(g.gain, t0, o.gain === undefined ? 0.2 : o.gain, o.attack, dur, o.hold);
  let node = osc;
  if (o.drive !== undefined) {
    const ws = shaper(v, end, o.drive);
    node.connect(ws);
    node = ws;
  }
  if (o.filter !== undefined) {
    const f = filt(v, end, o.filter, o.fq === undefined ? 1200 : o.fq, o.q);
    node.connect(f);
    node = f;
  }
  node.connect(g);
  g.connect(o.dest === undefined ? v.in : o.dest);
  osc.start(t0);
  osc.stop(end);
  return g;
}

// 噪声层：带通/低通/高通 + 可选频率扫动，是“爆音 / 摩擦 / 气流”的通用骨架
function noiseBurst(v, t0, o) {
  const dur = o.dur === undefined ? 0.1 : o.dur;
  const end = t0 + dur + 0.04;
  const type = o.type === undefined ? 'bandpass' : o.type;
  const f0 = Math.max(1, o.freq === undefined ? 1200 : o.freq);
  const s = srcNoise(v, t0, dur, o.pink === true ? 'pink' : 'white', o.rate, end);
  const f = filt(v, end, type, f0, o.q);
  if (o.to !== undefined && o.to !== f0) {
    const tt = t0 + (o.sweepTime === undefined ? dur : o.sweepTime);
    f.frequency.setValueAtTime(safeFreq(f0), t0);
    f.frequency.exponentialRampToValueAtTime(safeFreq(o.to), tt);
  }
  const g = gainNode(v, end, 0);
  env(g.gain, t0, o.gain === undefined ? 0.3 : o.gain, o.attack, dur);
  let node = f;
  if (o.drive !== undefined) {
    const ws = shaper(v, end, o.drive);
    node.connect(ws);
    node = ws;
  }
  s.connect(f);
  node.connect(g);
  g.connect(o.dest === undefined ? v.in : o.dest);
  return g;
}

// 极短瞬态：枪机、撞针、金属碰击的“脆”
function click(v, t0, o) {
  return noiseBurst(v, t0, {
    freq: o.freq === undefined ? 3200 : o.freq,
    q: o.q === undefined ? 0.9 : o.q,
    dur: o.dur === undefined ? 0.01 : o.dur,
    gain: o.gain === undefined ? 0.5 : o.gain,
    attack: o.attack === undefined ? 0.0005 : o.attack,
    type: o.type === undefined ? 'bandpass' : o.type,
    pink: o.pink,
    rate: o.rate,
    dest: o.dest,
  });
}

// 低频体感层：正弦快速下坠 + 可选过载 → 枪声“打在胸口”的那一下
function thump(v, t0, o) {
  const dur = o.dur === undefined ? 0.12 : o.dur;
  const end = t0 + dur + 0.05;
  const osc = ctx.createOscillator();
  osc.type = o.type === undefined ? 'sine' : o.type;
  const f0 = Math.max(1, o.from === undefined ? 180 : o.from);
  const f1 = Math.max(1, o.to === undefined ? 50 : o.to);
  osc.frequency.setValueAtTime(f0, t0);
  osc.frequency.exponentialRampToValueAtTime(f1, t0 + dur * (o.sweep === undefined ? 0.85 : o.sweep));
  osc.__src = 'osc';
  osc.__baseDetune = 0;
  trackSrc(v, osc, end);
  const g = gainNode(v, end, 0);
  env(g.gain, t0, o.gain === undefined ? 0.5 : o.gain, o.attack === undefined ? 0.0015 : o.attack, dur);
  let node = osc;
  if (o.drive !== undefined) {
    const ws = shaper(v, end, o.drive);
    node.connect(ws);
    node = ws;
  }
  if (o.lp !== undefined) {
    const f = filt(v, end, 'lowpass', o.lp, 0.7);
    node.connect(f);
    node = f;
  }
  node.connect(g);
  g.connect(o.dest === undefined ? v.in : o.dest);
  osc.start(t0);
  osc.stop(end);
  return g;
}

// 爆音前沿：全频噪声 + 快速下沉的低通，给枪声一个“推”的瞬间
function impulse(v, t0, o) {
  const dur = o.dur === undefined ? 0.04 : o.dur;
  const end = t0 + dur + 0.04;
  const f0 = o.freq === undefined ? 6000 : o.freq;
  const s = srcNoise(v, t0, dur, 'white', o.rate, end);
  const lp = filt(v, end, 'lowpass', f0, o.q === undefined ? 0.8 : o.q);
  lp.frequency.setValueAtTime(Math.max(1, f0), t0);
  lp.frequency.exponentialRampToValueAtTime(Math.max(1, o.to === undefined ? 400 : o.to), t0 + dur);
  const hp = filt(v, end, 'highpass', o.hp === undefined ? 80 : o.hp, 0.7);
  const g = gainNode(v, end, 0);
  env(g.gain, t0, o.gain === undefined ? 0.6 : o.gain, o.attack === undefined ? 0.0006 : o.attack, dur);
  s.connect(lp);
  lp.connect(hp);
  hp.connect(g);
  g.connect(o.dest === undefined ? v.in : o.dest);
  return g;
}

// 气流 / 挥动：带通中心频率扫过一段距离，钟形包络
function whoosh(v, t0, o) {
  const dur = o.dur === undefined ? 0.25 : o.dur;
  const end = t0 + dur + 0.05;
  const from = Math.max(1, o.from === undefined ? 300 : o.from);
  const to = Math.max(1, o.to === undefined ? 2600 : o.to);
  const s = srcNoise(v, t0, dur, o.pink === true ? 'pink' : 'white', o.rate, end);
  const f = filt(v, end, 'bandpass', from, o.q === undefined ? 2.2 : o.q);
  f.frequency.setValueAtTime(from, t0);
  f.frequency.exponentialRampToValueAtTime(to, t0 + dur * 0.55);
  f.frequency.exponentialRampToValueAtTime(Math.max(1, from * 0.7), t0 + dur);
  const g = gainNode(v, end, 0);
  const atk = o.attack === undefined ? dur * 0.3 : o.attack;
  env(g.gain, t0, o.gain === undefined ? 0.35 : o.gain, atk, dur);
  s.connect(f);
  f.connect(g);
  g.connect(o.dest === undefined ? v.in : o.dest);
  return g;
}

// 金属共振：噪声经多个非谐分音带通 → 钢板/弹壳/机械的“当啷”
function metalResonance(v, t0, o) {
  const base = o.base === undefined ? 1200 : o.base;
  const dur = o.dur === undefined ? 0.3 : o.dur;
  const gain = o.gain === undefined ? 0.25 : o.gain;
  const end = t0 + dur + 0.06;
  const parts = o.partials === undefined ? METAL_PARTIALS : o.partials;
  const q = o.q === undefined ? 12 : o.q;
  const s = srcNoise(v, t0, dur, 'white', o.rate, end);
  const g = gainNode(v, end, 0);
  env(g.gain, t0, gain, o.attack === undefined ? 0.0008 : o.attack, dur);
  for (let i = 0; i < parts.length; i++) {
    const f = filt(v, end, 'bandpass', base * parts[i] * rr(0.985, 1.015), q * (1 + i * 0.15));
    const pg = gainNode(v, end, Math.pow(0.62, i));
    s.connect(f);
    f.connect(pg);
    pg.connect(g);
  }
  if (o.ping === true) {
    for (let i = 0; i < 2; i++) {
      const f = base * (2.02 + i * 1.41) * rr(0.99, 1.01);
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = f;
      osc.__src = 'osc';
      osc.__baseDetune = 0;
      trackSrc(v, osc, end);
      const pg = gainNode(v, end, 0);
      env(pg.gain, t0, gain * (i === 0 ? 0.16 : 0.09), 0.001, dur * (i === 0 ? 0.7 : 0.45));
      osc.connect(pg);
      pg.connect(g);
      osc.start(t0);
      osc.stop(end);
    }
  }
  g.connect(o.dest === undefined ? v.in : o.dest);
  return g;
}

// 细碎金属声：弹壳落地、齿轮、弹簧 —— 用一串随机微点击堆出“机械感”
function rattle(v, t0, o) {
  const n = o.count === undefined ? 5 : o.count;
  const gain = o.gain === undefined ? 0.18 : o.gain;
  const decay = o.decay === undefined ? 0.72 : o.decay;
  const dmin = o.gapMin === undefined ? 0.008 : o.gapMin;
  const dmax = o.gapMax === undefined ? 0.04 : o.gapMax;
  let t = t0;
  for (let i = 0; i < n; i++) {
    click(v, t, {
      freq: (o.freq === undefined ? 3000 : o.freq) * rr(0.78, 1.28) * _p.br,
      q: o.q === undefined ? 6 : o.q,
      dur: o.dur === undefined ? 0.02 : o.dur,
      gain: gain * Math.pow(decay, i),
    });
    t += rr(dmin, dmax);
  }
}

// LFO → AudioParam（增益起伏 / 滤波呼吸 / AM 颤音）
function lfoTo(v, t0, param, freq, depth, end) {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = Math.max(0.001, freq);
  osc.__src = 'osc';
  osc.__baseDetune = 0;
  trackSrc(v, osc, end);
  const g = gainNode(v, end, depth);
  osc.connect(g);
  g.connect(param);
  osc.start(t0);
  osc.stop(end);
  return osc;
}

// 延迟拍击：给狙击/爆炸一个“远处厂房回弹”的尾巴
function delaySlap(v, t0, o) {
  const time = o.time === undefined ? 0.11 : o.time;
  const fb = o.feedback === undefined ? 0.35 : o.feedback;
  const dur = o.dur === undefined ? 0.6 : o.dur;
  const end = t0 + dur + 0.1;
  const d = ctx.createDelay(Math.max(0.05, time * 4));
  d.delayTime.value = time;
  track(v, d, end);
  const lp = filt(v, end, 'lowpass', o.lp === undefined ? 2600 : o.lp, 0.8);
  const fbg = gainNode(v, end, clamp(fb, 0, 0.85));
  const out = gainNode(v, end, o.mix === undefined ? 0.3 : o.mix);
  d.connect(lp);
  lp.connect(fbg);
  fbg.connect(d);
  lp.connect(out);
  out.connect(o.dest === undefined ? v.in : o.dest);
  const s = srcNoise(v, t0, 0.07, 'white', 1, end);
  const sg = gainNode(v, end, 0);
  env(sg.gain, t0, 0.6, 0.001, 0.07);
  s.connect(sg);
  sg.connect(d);
  return d;
}

// 混响回送（程序化 IR 卷积）：让爆炸/狙击/金属撞击有“厂房空间”
function verbSend(v, end, amount) {
  if (!_verbReady || amount <= 0) return null;
  const g = gainNode(v, end, amount);
  v.out.connect(g);
  g.connect(verbBus);
  return g;
}

// ---------------------------------------------------------------------------
// 5. 噪声缓冲与环境 IR（各建一次）
// ---------------------------------------------------------------------------

function noiseBuf(kind) {
  if (kind === 'pink') {
    if (pinkBuf === null) pinkBuf = makeNoiseBuffer('pink', 2);
    return pinkBuf;
  }
  if (whiteBuf === null) whiteBuf = makeNoiseBuffer('white', 2);
  return whiteBuf;
}

function makeNoiseBuffer(kind, seconds) {
  const sr = ctx.sampleRate || 48000;
  const len = Math.max(64, Math.floor(sr * seconds));
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  if (kind === 'pink') {
    // Paul Kellet 粉噪声近似：低频更厚，像机械轰鸣与风声
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = rnd() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else {
    for (let i = 0; i < len; i++) d[i] = rnd() * 2 - 1;
  }
  return buf;
}

function makeIR(seconds, decay) {
  const sr = ctx.sampleRate || 48000;
  const len = Math.max(256, Math.floor(sr * seconds));
  const buf = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      d[i] = (rnd() * 2 - 1) * Math.pow(1 - t, decay);
    }
    // 稀疏早期反射：模拟厂房金属墙面的硬反射
    for (let k = 0; k < 7; k++) {
      const pos = Math.floor(len * (0.004 + rnd() * 0.32));
      if (pos < len) d[pos] += (rnd() * 2 - 1) * 0.5 * Math.pow(0.72, k);
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// 6. 音效表（契约第 15 节的 36 个 + 扩展武器/治疗反馈音效）
//    顺序即 Audio.names 的顺序；契约内的名字保持原有相对次序
// ---------------------------------------------------------------------------

// 组合式构建：把已有音效的层叠按时间偏移拼成序列（换弹三阶段等）
function subBuild(name, v, t0, p) {
  const d = SOUNDS[name];
  if (d !== undefined && typeof d.build === 'function') d.build(v, t0, p);
}

// --- 共用层：肉体命中（hit_flesh / hit_head 复用） ---
function fleshImpact(v, t0, g) {
  thump(v, t0, { from: 230, to: 68, dur: 0.09, gain: 0.5 * g, drive: 2 });
  noiseBurst(v, t0, { freq: 760, to: 320, q: 0.9, dur: 0.13, gain: 0.42 * g, type: 'lowpass' });
  noiseBurst(v, t0 + 0.004, { freq: 900, to: 260, q: 3, dur: 0.15, gain: 0.22 * g });
}

// --- 共用层：人声（呼气/闷哼），带共振峰，避免变成“蜂鸣” ---
function vocalGrunt(v, t0, g, f0, dur) {
  const end = t0 + dur + 0.06;
  const src = ctx.createOscillator();
  src.type = 'sawtooth';
  src.frequency.setValueAtTime(f0, t0);
  src.frequency.exponentialRampToValueAtTime(Math.max(20, f0 * 0.78), t0 + dur);
  src.__src = 'osc';
  src.__baseDetune = 0;
  trackSrc(v, src, end);
  const ws = shaper(v, end, 5);
  const mix = gainNode(v, end, 0);
  env(mix.gain, t0, 0.24 * g, 0.012, dur);
  src.connect(ws);
  const formants = [430, 980, 2400];
  const fg = [1.0, 0.6, 0.28];
  for (let i = 0; i < formants.length; i++) {
    const f = filt(v, end, 'bandpass', formants[i] * rr(0.96, 1.04), 6);
    const fgn = gainNode(v, end, fg[i]);
    ws.connect(f);
    f.connect(fgn);
    fgn.connect(mix);
  }
  mix.connect(v.in);
  src.start(t0);
  src.stop(end);
}

// --- 共用层：远处机械撞击（环境用） ---
function machineryThump(v, t0, gain) {
  const end = t0 + 1.2;
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(rr(44, 54), t0);
  o.frequency.exponentialRampToValueAtTime(rr(23, 30), t0 + 0.7);
  o.__src = 'osc';
  o.__baseDetune = 0;
  trackSrc(v, o, end);
  const g = gainNode(v, end, 0);
  env(g.gain, t0, gain, 0.02, 0.9);
  o.connect(g);
  g.connect(v.out);
  o.start(t0);
  o.stop(end);
  noiseBurst(v, t0, { freq: 170, to: 70, q: 0.8, dur: 0.5, gain: gain * 0.5, type: 'lowpass' });
  metalResonance(v, t0 + 0.012, { base: rr(240, 430), dur: 0.9, gain: gain * 0.22, q: 16 });
}

const SOUNDS = {

  // ---------------- 武器 ----------------

  // R-99：1080 RPM。设计目标＝“紧、脆、快、有体感”。
  // 高频机械咬合（瞬态 + 4kHz 脆点）+ 双失谐中频主体 + 正弦低频下坠 + 金属尾音
  r99_fire: {
    bus: 'sfx', gain: 0.55, dur: 0.2, limit: 6, minGap: 0.005, mergeMax: 3,
    priority: 2, pitchVar: 0.04, brightVar: 0.12, loopRepeat: 0.056, verb: 0.1,
    build(v, t0, p) {
      const pi = p.pi, br = p.br;
      impulse(v, t0, { freq: 7200 * br, to: 900, hp: 220, dur: 0.03, gain: 0.5 });
      click(v, t0, { freq: 4300 * br, q: 0.9, dur: 0.009, gain: 0.5 });
      tone(v, t0, {
        type: 'sawtooth', freq: 620 * pi, to: 152 * pi, dur: 0.055, gain: 0.3,
        filter: 'lowpass', fq: 2100 * br, q: 1.3,
      });
      tone(v, t0, {
        type: 'square', freq: 468 * pi, to: 133 * pi, dur: 0.045, gain: 0.16,
        detune: 9, filter: 'bandpass', fq: 1400 * br, q: 0.9,
      });
      thump(v, t0, { from: 196 * pi, to: 58 * pi, dur: 0.1, gain: 0.6, drive: 3 });
      noiseBurst(v, t0 + 0.005, { freq: 2600 * br, to: 900, q: 0.7, dur: 0.09, gain: 0.15 });
      metalResonance(v, t0 + 0.004, {
        base: 3200 * pi, dur: 0.07, gain: 0.07, q: 18, partials: METAL_PARTIALS_HI,
      });
    },
  },

  // Flatline：重步枪。中低频更厚、包络更长、带明显过载“脏”感
  flatline_fire: {
    bus: 'sfx', gain: 0.68, dur: 0.32, limit: 5, minGap: 0.02, mergeMax: 3,
    priority: 2, pitchVar: 0.035, brightVar: 0.1, loopRepeat: 0.1, verb: 0.16,
    build(v, t0, p) {
      const pi = p.pi, br = p.br;
      impulse(v, t0, { freq: 5200 * br, to: 500, hp: 120, dur: 0.045, gain: 0.55 });
      click(v, t0, { freq: 2500 * br, q: 0.8, dur: 0.014, gain: 0.45 });
      tone(v, t0, {
        type: 'sawtooth', freq: 300 * pi, to: 88 * pi, dur: 0.1, gain: 0.4,
        drive: 9, filter: 'lowpass', fq: 1300 * br, q: 2.2,
      });
      tone(v, t0, {
        type: 'sawtooth', freq: 202 * pi, to: 70 * pi, dur: 0.12, gain: 0.22,
        detune: -14, filter: 'lowpass', fq: 900 * br, q: 1.4,
      });
      thump(v, t0, { from: 165 * pi, to: 46 * pi, dur: 0.2, gain: 0.85, drive: 4 });
      noiseBurst(v, t0, { freq: 880 * br, to: 380, q: 0.9, dur: 0.14, gain: 0.3 });
      noiseBurst(v, t0 + 0.02, { freq: 1700 * br, to: 600, q: 0.7, dur: 0.24, gain: 0.14, type: 'lowpass' });
    },
  },

  // 和平使者：宽频爆散 + 极低频轰鸣 + 弹丸与机件的碎响
  shotgun_fire: {
    bus: 'sfx', gain: 0.85, dur: 0.7, limit: 3, minGap: 0.05, mergeMax: 2,
    priority: 3, pitchVar: 0.03, brightVar: 0.1, loopRepeat: 0.6, verb: 0.35,
    build(v, t0, p) {
      const br = p.br, pi = p.pi;
      impulse(v, t0, { freq: 9500 * br, to: 700, hp: 160, dur: 0.05, gain: 0.8, q: 1.1 });
      noiseBurst(v, t0, {
        freq: 6000 * br, to: 420, q: 1.0, dur: 0.3, gain: 0.7, drive: 16,
        type: 'lowpass', sweepTime: 0.22,
      });
      thump(v, t0, { from: 118 * pi, to: 33 * pi, dur: 0.45, gain: 1.0, drive: 5, sweep: 0.7 });
      noiseBurst(v, t0 + 0.03, { freq: 900, to: 300, q: 0.6, dur: 0.5, gain: 0.22, type: 'lowpass' });
      rattle(v, t0 + 0.05, { count: 6, freq: 3600, gain: 0.1, decay: 0.7, gapMin: 0.012, gapMax: 0.045, dur: 0.05, q: 9 });
    },
  },

  // 长弓：蓄力狙击。极脆的鞭响 + 金属余韵 + 延迟拍击（远处厂房回弹）
  sniper_fire: {
    bus: 'sfx', gain: 0.9, dur: 1.0, limit: 3, minGap: 0.06, mergeMax: 2,
    priority: 3, pitchVar: 0.025, brightVar: 0.08, loopRepeat: 0.9, verb: 0.34,
    build(v, t0, p) {
      const br = p.br, pi = p.pi;
      impulse(v, t0, { freq: 12000 * br, to: 1400, hp: 400, dur: 0.02, gain: 0.85, q: 1.4 });
      noiseBurst(v, t0, { freq: 6400 * br, to: 620, q: 4, dur: 0.14, gain: 0.5, sweepTime: 0.11 });
      tone(v, t0, {
        type: 'sawtooth', freq: 880 * pi, to: 150 * pi, dur: 0.07, gain: 0.22,
        drive: 7, filter: 'lowpass', fq: 2600 * br, q: 1.6,
      });
      thump(v, t0, { from: 148 * pi, to: 38 * pi, dur: 0.32, gain: 0.9, drive: 4 });
      metalResonance(v, t0 + 0.008, {
        base: 2400 * pi, dur: 0.7, gain: 0.16, q: 22, ping: true,
      });
      delaySlap(v, t0 + 0.05, { time: 0.11, feedback: 0.34, mix: 0.24, dur: 0.7 });
      noiseBurst(v, t0 + 0.06, { freq: 520, to: 190, q: 0.6, dur: 0.5, gain: 0.14, type: 'lowpass' });
    },
  },

  // Volt：能量冲锋枪。与 R-99 的实弹机械感相反 —— 电容放电的高频撕扯 + 环调制毛刺，
  // 但保留同样的低频推力，保证连发时仍有"打点"
  volt_fire: {
    bus: 'sfx', gain: 0.5, dur: 0.24, limit: 6, minGap: 0.005, mergeMax: 3,
    priority: 2, pitchVar: 0.045, brightVar: 0.14, loopRepeat: 0.067, verb: 0.18,
    build(v, t0, p) {
      const pi = p.pi, br = p.br;
      // 放电瞬态：极高、极短的"啪"
      impulse(v, t0, { freq: 11000 * br, to: 2200, hp: 700, dur: 0.012, gain: 0.42, q: 1.6 });
      // 电浆主体：方波快速下坠经高 Q 带通，再过一级环调制增益 → 合成器放电
      const end = t0 + 0.14;
      const zap = ctx.createOscillator();
      zap.type = 'square';
      zap.frequency.setValueAtTime(1500 * pi, t0);
      zap.frequency.exponentialRampToValueAtTime(420 * pi, t0 + 0.05);
      zap.__src = 'osc';
      zap.__baseDetune = 0;
      trackSrc(v, zap, end);
      const bp = filt(v, end, 'bandpass', 2200 * br, 5.5);
      const zg = gainNode(v, end, 0);
      env(zg.gain, t0, 0.2, 0.0008, 0.07);
      const amg = gainNode(v, end, 1);
      lfoTo(v, t0, amg.gain, 132, 0.45, end);
      zap.connect(bp);
      bp.connect(zg);
      zg.connect(amg);
      amg.connect(v.in);
      zap.start(t0);
      zap.stop(end);
      // 枪机：中频短促，保留"武器"而不是"法术"的手感
      tone(v, t0, {
        type: 'sawtooth', freq: 420 * pi, to: 150 * pi, dur: 0.04, gain: 0.14,
        filter: 'lowpass', fq: 1700 * br, q: 1.1,
      });
      thump(v, t0, { from: 168 * pi, to: 54 * pi, dur: 0.09, gain: 0.46, drive: 3 });
      metalResonance(v, t0 + 0.003, {
        base: 4200 * pi, dur: 0.06, gain: 0.08, q: 20, partials: METAL_PARTIALS_HI,
      });
      noiseBurst(v, t0 + 0.004, { freq: 5200 * br, to: 2600, q: 1.0, dur: 0.07, gain: 0.12, type: 'highpass' });
    },
  },

  // 空仓：撞针打空 —— 小、干、带一点点腔体回响
  dryfire: {
    bus: 'sfx', gain: 0.4, dur: 0.1, limit: 3, minGap: 0.03, priority: 1,
    pitchVar: 0.04, brightVar: 0.12,
    build(v, t0, p) {
      const br = p.br;
      click(v, t0, { freq: 2400 * br, q: 1.1, dur: 0.008, gain: 0.4 });
      metalResonance(v, t0 + 0.001, { base: 3800 * br, dur: 0.05, gain: 0.2, q: 16, partials: METAL_PARTIALS_HI });
      thump(v, t0, { from: 150, to: 88, dur: 0.05, gain: 0.14 });
    },
  },

  // 换弹第一拍：拇指压下卡榫。高频机械瞬态与枪身低频回响分层，
  // 即使 0.6 秒的 R-99 快速换弹也能听清动作起点。
  reload_release: {
    bus: 'sfx', gain: 0.82, dur: 0.16, limit: 3, minGap: 0.035, priority: 2,
    pitchVar: 0.025, brightVar: 0.08, verb: 0.08,
    build(v, t0, p) {
      const br = p.br;
      click(v, t0, { freq: 4700 * br, q: 11, dur: 0.012, gain: 0.46 });
      click(v, t0 + 0.018, { freq: 2600 * br, q: 8, dur: 0.018, gain: 0.30 });
      metalResonance(v, t0 + 0.008, { base: 3300 * br, dur: 0.11, gain: 0.22, q: 19, partials: METAL_PARTIALS_HI });
      thump(v, t0 + 0.004, { from: 132, to: 68, dur: 0.07, gain: 0.20 });
    },
  },

  // 卸弹匣：金属刮擦 + 卡榫弹开 + 落手的闷响
  reload_out: {
    bus: 'sfx', gain: 0.68, dur: 0.34, limit: 2, minGap: 0.05, priority: 1,
    pitchVar: 0.03, brightVar: 0.1, verb: 0.12,
    build(v, t0, p) {
      const br = p.br;
      noiseBurst(v, t0, { freq: 1400 * br, to: 2700, q: 2.2, dur: 0.14, gain: 0.26 });
      click(v, t0 + 0.02, { freq: 3200 * br, q: 7, dur: 0.02, gain: 0.2 });
      click(v, t0 + 0.1, { freq: 2600 * br, q: 9, dur: 0.03, gain: 0.26 });
      thump(v, t0 + 0.12, { from: 95, to: 52, dur: 0.14, gain: 0.3 });
      metalResonance(v, t0 + 0.1, { base: 1500 * br, dur: 0.2, gain: 0.16, q: 14 });
      rattle(v, t0 + 0.15, { count: 3, freq: 4200, gain: 0.07, decay: 0.7, gapMin: 0.01, gapMax: 0.03 });
    },
  },

  // 旧弹匣脱手落下：先是近处塑料金属撞击，再以短促跳动收尾。
  reload_drop: {
    bus: 'sfx', gain: 0.78, dur: 0.34, limit: 3, minGap: 0.04, priority: 2,
    pitchVar: 0.045, brightVar: 0.12, verb: 0.16,
    build(v, t0, p) {
      const br = p.br;
      thump(v, t0, { from: 115, to: 48, dur: 0.12, gain: 0.42, drive: 1.8 });
      click(v, t0 + 0.006, { freq: 2300 * br, q: 5, dur: 0.024, gain: 0.34 });
      metalResonance(v, t0 + 0.01, { base: 1750 * br, dur: 0.22, gain: 0.24, q: 13, ping: true });
      rattle(v, t0 + 0.075, { count: 4, freq: 3100, gain: 0.09, decay: 0.68, gapMin: 0.018, gapMax: 0.045 });
      noiseBurst(v, t0, { freq: 720, to: 330, q: 0.8, dur: 0.11, gain: 0.18, type: 'lowpass' });
    },
  },

  // 从胸前/腰侧抽出新弹匣：布料擦动、手套抓握和弹药轻微晃动。
  reload_grab: {
    bus: 'sfx', gain: 0.72, dur: 0.30, limit: 3, minGap: 0.04, priority: 2,
    pitchVar: 0.035, brightVar: 0.1, verb: 0.08,
    build(v, t0, p) {
      const br = p.br;
      noiseBurst(v, t0, { freq: 820 * br, to: 1450, q: 1.3, dur: 0.18, gain: 0.28, pink: true });
      click(v, t0 + 0.045, { freq: 2850 * br, q: 6, dur: 0.018, gain: 0.28 });
      rattle(v, t0 + 0.06, { count: 4, freq: 3800, gain: 0.065, decay: 0.72, gapMin: 0.012, gapMax: 0.035 });
      thump(v, t0 + 0.035, { from: 104, to: 58, dur: 0.10, gain: 0.19 });
    },
  },

  // 插弹匣：更重的一记“咔哒” + 弹簧抖动 + 到位锁定
  reload_in: {
    bus: 'sfx', gain: 0.74, dur: 0.4, limit: 2, minGap: 0.05, priority: 1,
    pitchVar: 0.03, brightVar: 0.1, verb: 0.14,
    build(v, t0, p) {
      const br = p.br;
      thump(v, t0, { from: 122, to: 48, dur: 0.16, gain: 0.45, drive: 2 });
      noiseBurst(v, t0, { freq: 900, to: 400, q: 0.8, dur: 0.12, gain: 0.24, type: 'lowpass' });
      rattle(v, t0 + 0.03, { count: 6, freq: 3400, gain: 0.09, decay: 0.76, gapMin: 0.012, gapMax: 0.05, dur: 0.04, q: 8 });
      click(v, t0 + 0.2, { freq: 3000 * br, q: 10, dur: 0.03, gain: 0.3 });
      metalResonance(v, t0 + 0.2, { base: 3200 * br, dur: 0.12, gain: 0.22, q: 18, partials: METAL_PARTIALS_HI });
    },
  },

  // 弹匣拍紧并确认锁定：比插入声更短、更硬，明确告诉玩家弹匣已经到位。
  reload_seat: {
    bus: 'sfx', gain: 0.88, dur: 0.24, limit: 3, minGap: 0.04, priority: 3,
    pitchVar: 0.025, brightVar: 0.08, verb: 0.10,
    build(v, t0, p) {
      const br = p.br;
      thump(v, t0, { from: 148, to: 56, dur: 0.095, gain: 0.43, drive: 2.2 });
      click(v, t0 + 0.004, { freq: 3900 * br, q: 10, dur: 0.017, gain: 0.46 });
      metalResonance(v, t0 + 0.008, { base: 2600 * br, dur: 0.16, gain: 0.30, q: 17, ping: true, partials: METAL_PARTIALS_HI });
      noiseBurst(v, t0, { freq: 1150, to: 540, q: 0.9, dur: 0.08, gain: 0.20, type: 'lowpass' });
    },
  },

  // 拉栓：两段式金属咬合 —— 前段刮擦，后段重击＋弹簧回弹
  reload_bolt: {
    bus: 'sfx', gain: 0.72, dur: 0.4, limit: 2, minGap: 0.05, priority: 1,
    pitchVar: 0.03, brightVar: 0.1, verb: 0.16,
    build(v, t0, p) {
      const br = p.br;
      noiseBurst(v, t0, { freq: 1800 * br, to: 3400, q: 2.6, dur: 0.06, gain: 0.22 });
      click(v, t0, { freq: 3600 * br, q: 8, dur: 0.015, gain: 0.26 });
      metalResonance(v, t0 + 0.09, { base: 1800 * br, dur: 0.22, gain: 0.34, q: 14, ping: true });
      thump(v, t0 + 0.09, { from: 118, to: 58, dur: 0.1, gain: 0.3 });
      noiseBurst(v, t0 + 0.11, { freq: 4600, to: 2600, q: 0.9, dur: 0.09, gain: 0.14, type: 'highpass' });
      rattle(v, t0 + 0.13, { count: 4, freq: 2600, gain: 0.07, decay: 0.7, gapMin: 0.01, gapMax: 0.035 });
    },
  },

  // 栓动狙击枪专用拉栓：先拉动枪机，再以清脆的锁定声收尾。
  // 与普通换弹的 reload_bolt 区分开，保证每次开火后玩家都能听到“已送弹”。
  sniper_bolt: {
    bus: 'sfx', gain: 0.82, dur: 0.46, limit: 3, minGap: 0.045, priority: 3,
    pitchVar: 0.025, brightVar: 0.1, verb: 0.12,
    build(v, t0, p) {
      const br = p.br;
      noiseBurst(v, t0, { freq: 1500 * br, to: 3200, q: 3.0, dur: 0.09, gain: 0.28 });
      click(v, t0 + 0.015, { freq: 3900 * br, q: 9, dur: 0.018, gain: 0.34 });
      // 枪机前后运动的低频摩擦与中频金属共振
      tone(v, t0 + 0.035, {
        type: 'sawtooth', freq: 280 * p.pi, to: 110 * p.pi, dur: 0.16,
        gain: 0.22, filter: 'lowpass', fq: 1700 * br, q: 2.2,
      });
      metalResonance(v, t0 + 0.10, {
        base: 2100 * p.pi, dur: 0.28, gain: 0.3, q: 17, ping: true,
        partials: METAL_PARTIALS_HI,
      });
      thump(v, t0 + 0.11, { from: 135, to: 52, dur: 0.13, gain: 0.32, drive: 2 });
      click(v, t0 + 0.22, { freq: 5200 * br, q: 12, dur: 0.024, gain: 0.30, type: 'highpass' });
      rattle(v, t0 + 0.24, { count: 3, freq: 3400, gain: 0.09, decay: 0.64, gapMin: 0.014, gapMax: 0.035 });
    },
  },

  // 完整换弹序列（契约 11.1 的 def.reloadSound 默认值）：卸匣 → 插匣 → 拉栓。
  // 组合已有三阶段，保证一次性播放时也有完整的机械叙事
  r99_reload: {
    bus: 'sfx', gain: 0.76, dur: 1.5, limit: 1, minGap: 0.3, priority: 2,
    pitchVar: 0.03, brightVar: 0.08, verb: 0.16,
    build(v, t0, p) {
      subBuild('reload_out', v, t0, p);
      subBuild('reload_in', v, t0 + 0.46, p);
      subBuild('reload_bolt', v, t0 + 0.92, p);
    },
  },

  // ---------------- 命中 ----------------

  // ---------------- 脚步声（需求 9）----------------
  //
  // 需求：「所有怪物以及玩家增加脚步声」。
  //
  // 设计要点：
  //   · 脚步声是**高频重复**音（跑起来每秒 2~3 步），所以 gain 必须压得低、
  //     并且靠 minGap + limit 做节流，否则会和枪声抢注意力、也会糊成一片噪音。
  //   · 玩家自己的最响（贴身反馈），敌人按体型分三档：
  //     重型落地更闷更沉、轻型（虫群/爆蛛）更碎更尖。
  //   · pitchVar 给得比其他音效大，让连续脚步不会听起来像机械循环。
  //   · 每次触发时调用方会传随机 rate，配合 pitchVar 得到自然的步态变化。
  footstep_player: {
    bus: 'sfx', gain: 0.34, dur: 0.18, limit: 3, minGap: 0.12, priority: 1,
    pitchVar: 0.14, brightVar: 0.2,
    build(v, t0, p) {
      const br = p.br;
      // 鞋底拍击：低频闷响 + 短促宽频噪声
      thump(v, t0, { from: 150 * p.pi, to: 62 * p.pi, dur: 0.09, gain: 0.3, drive: 1.6 });
      noiseBurst(v, t0, {
        freq: 1500 * br, to: 520, q: 0.9, dur: 0.07, gain: 0.16, type: 'bandpass',
      });
      // 外骨骼的金属部件轻响，让"机械外骨骼"这个设定有声音依据
      click(v, t0 + 0.012, { freq: 3400 * br, q: 1.4, dur: 0.005, gain: 0.07, type: 'highpass' });
    },
  },

  // 重型敌人（重装兵 / 盾卫 / 蛛皇）：更沉、更闷、尾音更长
  footstep_heavy: {
    bus: 'sfx', gain: 0.3, dur: 0.3, limit: 3, minGap: 0.14, priority: 1,
    pitchVar: 0.12, brightVar: 0.16,
    build(v, t0, p) {
      thump(v, t0, { from: 96 * p.pi, to: 42 * p.pi, dur: 0.16, gain: 0.34, drive: 2.2 });
      noiseBurst(v, t0, { freq: 700 * p.br, to: 260, q: 0.8, dur: 0.13, gain: 0.13, type: 'lowpass' });
    },
  },

  // 轻型敌人（虫群 / 爆蛛 / 无人机）：更碎、更尖、更短
  footstep_light: {
    bus: 'sfx', gain: 0.22, dur: 0.11, limit: 3, minGap: 0.1, priority: 1,
    pitchVar: 0.22, brightVar: 0.28,
    build(v, t0, p) {
      const br = p.br;
      noiseBurst(v, t0, { freq: 2600 * br, to: 1100, q: 1.1, dur: 0.05, gain: 0.14, type: 'bandpass' });
      click(v, t0, { freq: 4200 * br, q: 1.6, dur: 0.004, gain: 0.1, type: 'highpass' });
    },
  },

  hit_flesh: {
    bus: 'sfx', gain: 0.5, dur: 0.24, limit: 6, minGap: 0.006, mergeMax: 3,
    priority: 2, pitchVar: 0.04, brightVar: 0.12,
    build(v, t0, p) {
      fleshImpact(v, t0, 1);
      noiseBurst(v, t0 + 0.01, { freq: 500, to: 200, q: 1.2, dur: 0.16, gain: 0.12, type: 'lowpass' });
    },
  },

  hit_armor: {
    bus: 'sfx', gain: 0.5, dur: 0.38, limit: 6, minGap: 0.006, mergeMax: 3,
    priority: 2, pitchVar: 0.04, brightVar: 0.14, verb: 0.18,
    build(v, t0, p) {
      const br = p.br;
      click(v, t0, { freq: 4200 * br, q: 1.0, dur: 0.008, gain: 0.55, type: 'highpass' });
      metalResonance(v, t0, { base: 1500 * br, dur: 0.3, gain: 0.4, q: 13, ping: true });
      thump(v, t0, { from: 190, to: 78, dur: 0.08, gain: 0.26, drive: 2 });
      noiseBurst(v, t0 + 0.01, { freq: 5200 * br, to: 2200, q: 0.8, dur: 0.1, gain: 0.14, type: 'highpass' });
    },
  },

  // 非空间化的玩家命中确认层：与敌人位置处的材质碰撞声叠加，远距离也清晰。
  feedback_shield: {
    bus: 'sfx', gain: 0.58, dur: 0.18, limit: 6, minGap: 0.012, mergeMax: 3,
    priority: 3, pitchVar: 0.025, brightVar: 0.08,
    build(v, t0, p) {
      const br = p.br;
      click(v, t0, { freq: 5200 * br, q: 9, dur: 0.010, gain: 0.40, type: 'highpass' });
      tone(v, t0, { type: 'sine', freq: 980 * p.pi, to: 680 * p.pi, dur: 0.09, gain: 0.22 });
      metalResonance(v, t0 + 0.006, { base: 3100 * br, dur: 0.14, gain: 0.20, q: 18 });
      noiseBurst(v, t0, { freq: 4300 * br, to: 2400, q: 1.1, dur: 0.07, gain: 0.11, type: 'highpass' });
    },
  },

  feedback_flesh: {
    bus: 'sfx', gain: 0.56, dur: 0.17, limit: 6, minGap: 0.012, mergeMax: 3,
    priority: 3, pitchVar: 0.035, brightVar: 0.08,
    build(v, t0, p) {
      thump(v, t0, { from: 176 * p.pi, to: 72 * p.pi, dur: 0.09, gain: 0.33, drive: 1.5 });
      noiseBurst(v, t0, { freq: 760, to: 260, q: 1.0, dur: 0.12, gain: 0.22, type: 'lowpass', pink: true });
      click(v, t0 + 0.005, { freq: 1800 * p.br, q: 2.2, dur: 0.015, gain: 0.24 });
      tone(v, t0 + 0.008, { type: 'triangle', freq: 310 * p.pi, to: 170 * p.pi, dur: 0.10, gain: 0.13 });
    },
  },

  // 大声、玻璃质感的破盾确认，和普通打盾的短促电子“叮”明显不同。
  feedback_shield_break: {
    bus: 'sfx', gain: 0.92, dur: 0.52, limit: 4, minGap: 0.035, priority: 4,
    pitchVar: 0.02, brightVar: 0.1, verb: 0.24,
    build(v, t0, p) {
      const br = p.br;
      for (let i = 0; i < 5; i++) {
        tone(v, t0 + i * 0.012, { type: 'sine', freq: (2450 + i * 720) * br, to: (1500 + i * 430) * br,
          dur: 0.20 + i * 0.025, gain: 0.12 / (1 + i * 0.13) });
      }
      impulse(v, t0, { freq: 9200 * br, to: 1800, hp: 900, dur: 0.08, gain: 0.34 });
      noiseBurst(v, t0 + 0.015, { freq: 6800 * br, to: 2400, q: 1.4, dur: 0.30, gain: 0.24, type: 'highpass' });
      metalResonance(v, t0, { base: 4200 * br, dur: 0.42, gain: 0.26, q: 21, ping: true, partials: METAL_PARTIALS_HI });
    },
  },

  hit_head: {
    bus: 'sfx', gain: 0.6, dur: 0.3, limit: 5, minGap: 0.006, mergeMax: 3,
    priority: 3, pitchVar: 0.04, brightVar: 0.12,
    build(v, t0, p) {
      const br = p.br;
      fleshImpact(v, t0, 1.15);
      click(v, t0, { freq: 5200 * br, q: 1.2, dur: 0.007, gain: 0.5, type: 'highpass' });
      thump(v, t0 + 0.004, { from: 128, to: 44, dur: 0.14, gain: 0.5, drive: 3 });
      noiseBurst(v, t0 + 0.006, { freq: 3000 * br, to: 1200, q: 1.4, dur: 0.09, gain: 0.16 });
    },
  },

  // 命中标记：UI 反馈，必须“干、短、准”，不能盖住枪声
  hitmarker: {
    bus: 'ui', gain: 0.32, dur: 0.09, limit: 4, minGap: 0.012, priority: 2,
    pitchVar: 0.03, brightVar: 0.08,
    build(v, t0, p) {
      const pi = p.pi;
      tone(v, t0, { type: 'triangle', freq: 1480 * pi, dur: 0.03, gain: 0.24, attack: 0.001 });
      tone(v, t0, { type: 'sine', freq: 2960 * pi, dur: 0.05, gain: 0.14, attack: 0.001 });
      click(v, t0, { freq: 6000, q: 1.0, dur: 0.006, gain: 0.14, type: 'highpass' });
    },
  },

  // 击杀确认：两音上行 + 金属颗粒，给“击杀”一个明确的句号
  kill_confirm: {
    bus: 'ui', gain: 0.42, dur: 0.3, limit: 3, minGap: 0.04, priority: 3,
    pitchVar: 0.02, brightVar: 0.06, verb: 0.14,
    build(v, t0, p) {
      const pi = p.pi;
      tone(v, t0, { type: 'triangle', freq: 880 * pi, dur: 0.08, gain: 0.26, attack: 0.002 });
      tone(v, t0 + 0.055, { type: 'triangle', freq: 1320 * pi, dur: 0.16, gain: 0.26, attack: 0.002 });
      tone(v, t0 + 0.055, { type: 'sine', freq: 2640 * pi, dur: 0.12, gain: 0.08, attack: 0.002 });
      metalResonance(v, t0 + 0.05, { base: 2100 * pi, dur: 0.2, gain: 0.12, q: 18, partials: METAL_PARTIALS_HI });
      thump(v, t0, { from: 140, to: 70, dur: 0.07, gain: 0.14 });
    },
  },

  // ---------------- 玩家 ----------------

  player_hurt: {
    bus: 'sfx', gain: 0.62, dur: 0.36, limit: 3, minGap: 0.05, priority: 3,
    pitchVar: 0.05, brightVar: 0.1,
    build(v, t0, p) {
      const br = p.br;
      noiseBurst(v, t0, { freq: 900 * br, to: 300, q: 0.8, dur: 0.16, gain: 0.42, type: 'lowpass' });
      thump(v, t0, { from: 172, to: 56, dur: 0.12, gain: 0.42, drive: 3 });
      vocalGrunt(v, t0 + 0.02, 1, rr(120, 148), 0.26);
      click(v, t0, { freq: 2600 * br, q: 1.0, dur: 0.01, gain: 0.18 });
    },
  },

  player_die: {
    bus: 'sfx', gain: 0.8, dur: 1.8, limit: 1, minGap: 0.2, priority: 4,
    pitchVar: 0.03, brightVar: 0.08, verb: 0.45,
    build(v, t0, p) {
      const pi = p.pi;
      tone(v, t0, {
        type: 'sawtooth', freq: 320 * pi, to: 42 * pi, dur: 1.1, gain: 0.3,
        drive: 6, filter: 'lowpass', fq: 1200, q: 2.6, sweepTime: 0.9,
      });
      thump(v, t0, { from: 68 * pi, to: 26 * pi, dur: 1.3, gain: 0.5, sweep: 0.6 });
      noiseBurst(v, t0, { freq: 4200, to: 260, q: 0.7, dur: 1.2, gain: 0.26, type: 'lowpass', sweepTime: 1.0 });
      vocalGrunt(v, t0 + 0.02, 1.2, 118, 0.5);
      // 心跳式余震：生命流失的听觉隐喻
      thump(v, t0 + 0.75, { from: 96, to: 44, dur: 0.3, gain: 0.3 });
      thump(v, t0 + 1.15, { from: 84, to: 40, dur: 0.35, gain: 0.2 });
    },
  },

  shield_break: {
    // 破盾是战斗信息音，整体比普通护盾命中高约一倍；高频玻璃碎裂层
    // 让玩家即使在连射中也能明确听到“盾已碎”。
    bus: 'sfx', gain: 1.12, dur: 0.74, limit: 2, minGap: 0.08, priority: 4,
    pitchVar: 0.04, brightVar: 0.14, verb: 0.3,
    build(v, t0, p) {
      const pi = p.pi, br = p.br;
      // 清脆的破盾确认音：先上行玻璃质高频，再接碎裂颗粒，和普通金属命中区分。
      tone(v, t0, {
        type: 'triangle', freq: 2600 * pi, to: 5200 * pi, dur: 0.14, gain: 0.22,
        attack: 0.001, filter: 'bandpass', fq: 3600 * br, q: 5,
      });
      tone(v, t0, {
        type: 'square', freq: 1800 * pi, to: 220 * pi, dur: 0.26, gain: 0.24,
        filter: 'bandpass', fq: 1600 * br, q: 4,
      });
      // 玻璃裂纹的“上行尖啸 + 断裂回落”，使用高 Q 频带而不是单纯金属 ping。
      tone(v, t0 + 0.012, {
        type: 'sine', freq: 6900 * pi, to: 2400 * pi, dur: 0.30, gain: 0.38,
        attack: 0.0005, filter: 'bandpass', fq: 5200 * br, q: 10,
      });
      tone(v, t0 + 0.045, {
        type: 'triangle', freq: 4700 * pi, to: 9800 * pi, dur: 0.11, gain: 0.28,
        attack: 0.0004, filter: 'highpass', fq: 2900 * br, q: 1.2,
      });
      thump(v, t0, { from: 205 * pi, to: 40 * pi, dur: 0.3, gain: 0.5, drive: 3 });
      // 碎片：随机高频带通短爆，模拟能量护盾的玻璃质碎裂
      for (let i = 0; i < 7; i++) {
        click(v, t0 + rr(0.015, 0.34), {
          freq: rr(2600, 9000), q: rr(6, 14), dur: rr(0.02, 0.06),
          gain: 0.22 * (1 - i / 9),
        });
      }
      rattle(v, t0 + 0.05, {
        count: 12, freq: 6200, gain: 0.18, decay: 0.78,
        gapMin: 0.008, gapMax: 0.035, dur: 0.035, q: 12,
      });
      noiseBurst(v, t0, { freq: 7000 * br, to: 1500, q: 1.2, dur: 0.12, gain: 0.3, type: 'highpass' });
    },
  },

  // 治疗道具：短促的启动确认音，读条完成时播放，避免和枪声混在一起。
  // 两种道具保持明显音色差异：医疗包偏温暖/低频，护盾电池偏清亮/金属。
  medkit_use: {
    bus: 'sfx', gain: 0.58, dur: 0.46, limit: 2, minGap: 0.08, priority: 2,
    pitchVar: 0.03, brightVar: 0.08,
    build(v, t0, p) {
      const pi = p.pi;
      thump(v, t0, { from: 150 * pi, to: 72 * pi, dur: 0.16, gain: 0.34 });
      tone(v, t0 + 0.02, { type: 'triangle', freq: 420 * pi, to: 620 * pi, dur: 0.2, gain: 0.2, attack: 0.004 });
      noiseBurst(v, t0 + 0.03, { freq: 780, to: 330, q: 0.8, dur: 0.24, gain: 0.16, type: 'lowpass' });
      click(v, t0 + 0.11, { freq: 2300 * p.br, q: 4, dur: 0.028, gain: 0.16 });
    },
  },

  shield_battery_use: {
    bus: 'sfx', gain: 0.64, dur: 0.54, limit: 2, minGap: 0.08, priority: 2,
    pitchVar: 0.03, brightVar: 0.1, verb: 0.16,
    build(v, t0, p) {
      const pi = p.pi, br = p.br;
      tone(v, t0, { type: 'sine', freq: 640 * pi, to: 1180 * pi, dur: 0.28, gain: 0.2, attack: 0.003 });
      tone(v, t0 + 0.06, { type: 'triangle', freq: 1280 * pi, to: 2140 * pi, dur: 0.24, gain: 0.14, attack: 0.003 });
      metalResonance(v, t0 + 0.03, { base: 1900 * br, dur: 0.34, gain: 0.18, q: 14, ping: true });
      click(v, t0 + 0.16, { freq: 6200 * br, q: 8, dur: 0.024, gain: 0.2, type: 'highpass' });
    },
  },

  // 小药启动更短、更贴近手部操作：护帽弹开 + 注射器活塞预压。
  syringe_use: {
    bus: 'sfx', gain: 0.66, dur: 0.30, limit: 2, minGap: 0.06, priority: 2,
    pitchVar: 0.025, brightVar: 0.08,
    build(v, t0, p) {
      const pi = p.pi, br = p.br;
      click(v, t0, { freq: 5100 * br, q: 7, dur: 0.022, gain: 0.24, type: 'highpass' });
      noiseBurst(v, t0 + 0.018, { freq: 1800 * br, to: 620, q: 1.2, dur: 0.16, gain: 0.18, type: 'bandpass' });
      tone(v, t0 + 0.035, { type: 'triangle', freq: 360 * pi, to: 610 * pi, dur: 0.18, gain: 0.16, attack: 0.003 });
      thump(v, t0 + 0.08, { from: 126 * pi, to: 72 * pi, dur: 0.11, gain: 0.18 });
    },
  },

  shield_cell_use: {
    bus: 'sfx', gain: 0.68, dur: 0.34, limit: 2, minGap: 0.06, priority: 2,
    pitchVar: 0.025, brightVar: 0.09, verb: 0.1,
    build(v, t0, p) {
      const pi = p.pi, br = p.br;
      click(v, t0, { freq: 6900 * br, q: 9, dur: 0.025, gain: 0.24, type: 'highpass' });
      tone(v, t0 + 0.015, { type: 'sine', freq: 780 * pi, to: 1480 * pi, dur: 0.22, gain: 0.17, attack: 0.002 });
      metalResonance(v, t0 + 0.045, { base: 2300 * br, dur: 0.22, gain: 0.13, q: 16, ping: true });
      noiseBurst(v, t0 + 0.03, { freq: 4100 * br, to: 2500, q: 1, dur: 0.18, gain: 0.08, type: 'highpass' });
    },
  },

  // 读条持续声：与启动/完成提示分离。使用真正的 sustained 声部，打断时可立即
  // stopLoop，避免把短启动音粗暴重复成“哔哔哔”。
  medkit_loop: {
    bus: 'sfx', gain: 0.34, dur: 0.5, limit: 1, loopLimit: 1, priority: 2,
    sustained: true, pitchVar: 0.01, brightVar: 0.05,
    buildLoop(v, t0, p) {
      const end = t0 + LOOP_MAX;
      const cloth = srcNoise(v, t0, LOOP_MAX, 'pink', 1, end);
      const lp = filt(v, end, 'lowpass', 720 * p.br, 0.75);
      const cg = gainNode(v, end, 0.13);
      cloth.connect(lp); lp.connect(cg); cg.connect(v.in);
      const pump = oscNode(v, 'triangle', 94 * p.pi, 0, end, t0);
      const pg = gainNode(v, end, 0.075);
      pump.connect(pg); pg.connect(v.in);
      lfoTo(v, t0, pg.gain, 2.15, 0.055, end);
      lfoTo(v, t0, lp.frequency, 0.72, 150, end);
    },
  },

  shield_battery_loop: {
    bus: 'sfx', gain: 0.38, dur: 0.5, limit: 1, loopLimit: 1, priority: 2,
    sustained: true, pitchVar: 0.008, brightVar: 0.06, verb: 0.08,
    buildLoop(v, t0, p) {
      const end = t0 + LOOP_MAX;
      const hum = oscNode(v, 'sine', 188 * p.pi, 0, end, t0);
      const hg = gainNode(v, end, 0.105);
      hum.connect(hg); hg.connect(v.in);
      const charge = oscNode(v, 'triangle', 760 * p.pi, 0, end, t0);
      const bp = filt(v, end, 'bandpass', 1220 * p.br, 5.5);
      const eg = gainNode(v, end, 0.075);
      charge.connect(bp); bp.connect(eg); eg.connect(v.in);
      const fizz = srcNoise(v, t0, LOOP_MAX, 'white', 1, end);
      const hp = filt(v, end, 'highpass', 3100 * p.br, 0.8);
      const fg = gainNode(v, end, 0.025);
      fizz.connect(hp); hp.connect(fg); fg.connect(v.in);
      lfoTo(v, t0, charge.frequency, 0.45, 180, end);
      lfoTo(v, t0, eg.gain, 3.1, 0.045, end);
    },
  },

  syringe_loop: {
    bus: 'sfx', gain: 0.40, dur: 0.5, limit: 1, loopLimit: 1, priority: 2,
    sustained: true, pitchVar: 0.008, brightVar: 0.05,
    buildLoop(v, t0, p) {
      const end = t0 + LOOP_MAX;
      const fluid = srcNoise(v, t0, LOOP_MAX, 'pink', 1, end);
      const bp = filt(v, end, 'bandpass', 1080 * p.br, 2.1);
      const fg = gainNode(v, end, 0.10);
      fluid.connect(bp); bp.connect(fg); fg.connect(v.in);
      const plunger = oscNode(v, 'triangle', 132 * p.pi, 0, end, t0);
      const pg = gainNode(v, end, 0.055);
      plunger.connect(pg); pg.connect(v.in);
      lfoTo(v, t0, fg.gain, 3.6, 0.045, end);
      lfoTo(v, t0, bp.frequency, 0.7, 260, end);
    },
  },

  shield_cell_loop: {
    bus: 'sfx', gain: 0.42, dur: 0.5, limit: 1, loopLimit: 1, priority: 2,
    sustained: true, pitchVar: 0.008, brightVar: 0.05, verb: 0.08,
    buildLoop(v, t0, p) {
      const end = t0 + LOOP_MAX;
      const hum = oscNode(v, 'sine', 246 * p.pi, 0, end, t0);
      const hg = gainNode(v, end, 0.09);
      hum.connect(hg); hg.connect(v.in);
      const charge = oscNode(v, 'triangle', 1060 * p.pi, 0, end, t0);
      const cg = gainNode(v, end, 0.06);
      charge.connect(cg); cg.connect(v.in);
      const fizz = srcNoise(v, t0, LOOP_MAX, 'white', 1, end);
      const hp = filt(v, end, 'highpass', 3900 * p.br, 0.9);
      const fg = gainNode(v, end, 0.018);
      fizz.connect(hp); hp.connect(fg); fg.connect(v.in);
      lfoTo(v, t0, charge.frequency, 0.62, 230, end);
      lfoTo(v, t0, cg.gain, 4.0, 0.035, end);
    },
  },

  // 读条完成确认：比启动音更短、更明亮，让玩家明确知道效果已经真正生效。
  medkit_complete: {
    bus: 'sfx', gain: 0.62, dur: 0.42, limit: 2, minGap: 0.08, priority: 3,
    pitchVar: 0.02, brightVar: 0.08,
    build(v, t0, p) {
      const pi = p.pi;
      tone(v, t0, { type: 'triangle', freq: 540 * pi, to: 820 * pi, dur: 0.18, gain: 0.22, attack: 0.002 });
      tone(v, t0 + 0.10, { type: 'sine', freq: 820 * pi, to: 1240 * pi, dur: 0.2, gain: 0.18, attack: 0.002 });
      thump(v, t0, { from: 118, to: 58, dur: 0.12, gain: 0.18 });
      click(v, t0 + 0.11, { freq: 3200 * p.br, q: 5, dur: 0.025, gain: 0.18 });
    },
  },

  shield_battery_complete: {
    bus: 'sfx', gain: 0.7, dur: 0.5, limit: 2, minGap: 0.08, priority: 3,
    pitchVar: 0.02, brightVar: 0.08, verb: 0.18,
    build(v, t0, p) {
      const pi = p.pi, br = p.br;
      tone(v, t0, { type: 'sine', freq: 980 * pi, to: 1680 * pi, dur: 0.2, gain: 0.2, attack: 0.001 });
      tone(v, t0 + 0.08, { type: 'triangle', freq: 1680 * pi, to: 2860 * pi, dur: 0.24, gain: 0.16, attack: 0.001 });
      metalResonance(v, t0 + 0.08, { base: 2600 * br, dur: 0.32, gain: 0.2, q: 18, ping: true });
      click(v, t0 + 0.18, { freq: 7600 * br, q: 9, dur: 0.026, gain: 0.22, type: 'highpass' });
    },
  },

  syringe_complete: {
    bus: 'sfx', gain: 0.68, dur: 0.34, limit: 2, minGap: 0.06, priority: 3,
    pitchVar: 0.02, brightVar: 0.07,
    build(v, t0, p) {
      const pi = p.pi, br = p.br;
      click(v, t0, { freq: 4200 * br, q: 6, dur: 0.024, gain: 0.22, type: 'highpass' });
      tone(v, t0 + 0.02, { type: 'triangle', freq: 610 * pi, to: 1080 * pi, dur: 0.20, gain: 0.19, attack: 0.002 });
      tone(v, t0 + 0.095, { type: 'sine', freq: 1120 * pi, dur: 0.18, gain: 0.12, attack: 0.002 });
      thump(v, t0, { from: 112, to: 66, dur: 0.10, gain: 0.16 });
    },
  },

  shield_cell_complete: {
    bus: 'sfx', gain: 0.72, dur: 0.40, limit: 2, minGap: 0.06, priority: 3,
    pitchVar: 0.02, brightVar: 0.07, verb: 0.14,
    build(v, t0, p) {
      const pi = p.pi, br = p.br;
      tone(v, t0, { type: 'sine', freq: 1120 * pi, to: 2060 * pi, dur: 0.22, gain: 0.20, attack: 0.001 });
      tone(v, t0 + 0.075, { type: 'triangle', freq: 2020 * pi, to: 3300 * pi, dur: 0.22, gain: 0.13, attack: 0.001 });
      metalResonance(v, t0 + 0.08, { base: 3000 * br, dur: 0.28, gain: 0.17, q: 19, ping: true });
      click(v, t0 + 0.14, { freq: 8200 * br, q: 10, dur: 0.024, gain: 0.20, type: 'highpass' });
    },
  },

  // ---------------- 玩家动作阶段 ----------------

  sprint_start: {
    bus: 'sfx', gain: 0.42, dur: 0.24, limit: 2, minGap: 0.1, priority: 1,
    pitchVar: 0.035, brightVar: 0.1,
    build(v, t0, p) {
      whoosh(v, t0, { from: 360 * p.pi, to: 1380 * p.pi, dur: 0.18, q: 1.2, gain: 0.2, attack: 0.025 });
      thump(v, t0, { from: 116, to: 62, dur: 0.11, gain: 0.24 });
      click(v, t0 + 0.025, { freq: 2300 * p.br, q: 2, dur: 0.025, gain: 0.12 });
    },
  },

  // 疾跑进行音只创建一个持续声部；步点由 update 稀疏排程，不在物理帧重建。
  sprint_loop: {
    bus: 'sfx', gain: 0.28, dur: 0.5, limit: 1, loopLimit: 1, priority: 1,
    sustained: true, pitchVar: 0.01, brightVar: 0.08,
    buildLoop(v, t0, p) {
      const end = t0 + LOOP_MAX;
      const cloth = srcNoise(v, t0, LOOP_MAX, 'pink', 1, end);
      const lp = filt(v, end, 'lowpass', 620 * p.br, 0.8);
      const cg = gainNode(v, end, 0.12);
      cloth.connect(lp);
      lp.connect(cg);
      cg.connect(v.in);
      lfoTo(v, t0, cg.gain, 1.7, 0.035, end);
      v.nextEvent = t0 + 0.08;
    },
    onUpdate(v, now) {
      if (now < v.nextEvent) return;
      v.nextEvent = now + rr(0.24, 0.31);
      const t = now + 0.004;
      thump(v, t, { from: 108, to: 54, dur: 0.1, gain: 0.28 });
      noiseBurst(v, t, { freq: 720, to: 210, q: 0.8, dur: 0.11, gain: 0.24, type: 'lowpass' });
      click(v, t + 0.006, { freq: 2100 * rr(0.88, 1.12), q: 2.4, dur: 0.02, gain: 0.1 });
    },
  },

  sprint_end: {
    bus: 'sfx', gain: 0.34, dur: 0.2, limit: 2, minGap: 0.1, priority: 1,
    pitchVar: 0.035, brightVar: 0.08,
    build(v, t0, p) {
      whoosh(v, t0, { from: 1100 * p.pi, to: 300 * p.pi, dur: 0.16, q: 1.1, gain: 0.16, attack: 0.01 });
      noiseBurst(v, t0 + 0.015, { freq: 760 * p.br, to: 220, q: 0.8, dur: 0.13, gain: 0.18, type: 'lowpass' });
      thump(v, t0 + 0.03, { from: 92, to: 48, dur: 0.09, gain: 0.18 });
    },
  },

  jump: {
    bus: 'sfx', gain: 0.4, dur: 0.26, limit: 3, minGap: 0.06, priority: 1,
    pitchVar: 0.05, brightVar: 0.12,
    build(v, t0, p) {
      const pi = p.pi;
      whoosh(v, t0, { from: 480 * pi, to: 1900 * pi, dur: 0.18, q: 1.2, gain: 0.26, attack: 0.03 });
      thump(v, t0, { from: 128, to: 62, dur: 0.1, gain: 0.2 });
      noiseBurst(v, t0 + 0.02, { freq: 2200, to: 900, q: 0.8, dur: 0.12, gain: 0.1, type: 'highpass' });
    },
  },

  land_soft: {
    bus: 'sfx', gain: 0.4, dur: 0.2, limit: 3, minGap: 0.05, priority: 1,
    pitchVar: 0.05, brightVar: 0.12,
    build(v, t0, p) {
      noiseBurst(v, t0, { freq: 420, to: 180, q: 0.8, dur: 0.12, gain: 0.34, type: 'lowpass' });
      thump(v, t0, { from: 132, to: 58, dur: 0.1, gain: 0.3 });
      click(v, t0 + 0.01, { freq: 2600 * p.br, q: 8, dur: 0.02, gain: 0.1 });
    },
  },

  land_hard: {
    bus: 'sfx', gain: 0.7, dur: 0.5, limit: 2, minGap: 0.06, priority: 3,
    pitchVar: 0.04, brightVar: 0.1, verb: 0.2,
    build(v, t0, p) {
      const br = p.br, pi = p.pi;
      impulse(v, t0, { freq: 4200 * br, to: 300, hp: 60, dur: 0.06, gain: 0.5 });
      noiseBurst(v, t0, { freq: 1000 * br, to: 260, q: 0.7, dur: 0.2, gain: 0.5, type: 'lowpass', drive: 6 });
      thump(v, t0, { from: 152 * pi, to: 36 * pi, dur: 0.32, gain: 0.9, drive: 4, sweep: 0.6 });
      metalResonance(v, t0 + 0.01, { base: 900 * br, dur: 0.34, gain: 0.24, q: 12 });
      rattle(v, t0 + 0.05, { count: 5, freq: 3400, gain: 0.08, decay: 0.72, gapMin: 0.012, gapMax: 0.05 });
    },
  },

  slide_start: {
    bus: 'sfx', gain: 0.52, dur: 0.28, limit: 2, minGap: 0.08, priority: 2,
    pitchVar: 0.035, brightVar: 0.12,
    build(v, t0, p) {
      noiseBurst(v, t0, { freq: 2400 * p.br, to: 520, q: 1.1, dur: 0.22, gain: 0.34, type: 'bandpass' });
      whoosh(v, t0, { from: 520 * p.pi, to: 1500 * p.pi, dur: 0.18, q: 1.4, gain: 0.16, attack: 0.02 });
      thump(v, t0, { from: 124, to: 58, dur: 0.13, gain: 0.3 });
      click(v, t0 + 0.012, { freq: 3400 * p.br, q: 4, dur: 0.025, gain: 0.16 });
    },
  },

  // 滑铲循环：砂轮摩擦 —— 宽带噪声 + 低频轰鸣，带通中心由慢 LFO 摆动出颗粒感
  slide_loop: {
    bus: 'sfx', gain: 0.5, dur: 0.5, limit: 1, loopLimit: 1, priority: 2,
    sustained: true, pitchVar: 0.01, brightVar: 0.1, verb: 0.12,
    buildLoop(v, t0, p) {
      const end = t0 + LOOP_MAX;
      const pi = p.pi, br = p.br;
      const s = srcNoise(v, t0, LOOP_MAX, 'white', pi, end);
      const bp = filt(v, end, 'bandpass', 1350 * br, 1.5);
      const bg = gainNode(v, end, 0.34);
      s.connect(bp);
      bp.connect(bg);
      bg.connect(v.in);
      // 金属尖叫：峰值滤波让摩擦带上“刮钢”的音色
      const pk = filt(v, end, 'peaking', 2600 * br, 1.1, 9);
      bp.connect(pk);
      const pg = gainNode(v, end, 0.3);
      pk.connect(pg);
      pg.connect(v.in);
      // 低频轰鸣：滑铲时地面传导的震动
      const s2 = srcNoise(v, t0, LOOP_MAX, 'pink', 1, end);
      const lp = filt(v, end, 'lowpass', 210, 0.9);
      const lg = gainNode(v, end, 0.85);
      s2.connect(lp);
      lp.connect(lg);
      lg.connect(v.in);
      lfoTo(v, t0, bp.frequency, 0.63, 200, end);
      lfoTo(v, t0, lg.gain, 0.31, 0.25, end);
      v.rate = pi;
    },
  },

  slide_end: {
    bus: 'sfx', gain: 0.42, dur: 0.24, limit: 2, minGap: 0.08, priority: 1,
    pitchVar: 0.04, brightVar: 0.1,
    build(v, t0, p) {
      noiseBurst(v, t0, { freq: 1500 * p.br, to: 260, q: 1, dur: 0.18, gain: 0.28, type: 'bandpass' });
      tone(v, t0, { type: 'triangle', freq: 380 * p.pi, to: 130 * p.pi, dur: 0.15, gain: 0.1 });
      thump(v, t0 + 0.025, { from: 90, to: 44, dur: 0.11, gain: 0.22 });
    },
  },

  wallrun_start: {
    bus: 'sfx', gain: 0.48, dur: 0.28, limit: 2, minGap: 0.1, priority: 2,
    pitchVar: 0.035, brightVar: 0.12, verb: 0.12,
    build(v, t0, p) {
      whoosh(v, t0, { from: 420 * p.pi, to: 2200 * p.pi, dur: 0.22, q: 1.5, gain: 0.25, attack: 0.025 });
      noiseBurst(v, t0, { freq: 1200 * p.br, to: 460, q: 1.2, dur: 0.18, gain: 0.22, type: 'bandpass' });
      metalResonance(v, t0 + 0.018, { base: 980 * p.br, dur: 0.2, gain: 0.12, q: 10 });
      thump(v, t0, { from: 122, to: 60, dur: 0.1, gain: 0.22 });
    },
  },

  // 蹬墙跑循环：风噪 + 靴底周期性踏面 + 墙体金属振动
  wallrun_loop: {
    bus: 'sfx', gain: 0.45, dur: 0.5, limit: 1, loopLimit: 1, priority: 2,
    sustained: true, pitchVar: 0.01, brightVar: 0.1, verb: 0.18,
    buildLoop(v, t0, p) {
      const end = t0 + LOOP_MAX;
      const pi = p.pi, br = p.br;
      const wind = srcNoise(v, t0, LOOP_MAX, 'pink', 1, end);
      const wl = filt(v, end, 'lowpass', 760 * br, 0.8);
      const wg = gainNode(v, end, 0.5);
      wind.connect(wl);
      wl.connect(wg);
      wg.connect(v.in);
      const vib = oscNode(v, 'sawtooth', 46 * pi, 0, end, t0);
      const vb = filt(v, end, 'bandpass', 320 * pi, 5.5);
      const vg = gainNode(v, end, 0.16);
      vib.connect(vb);
      vb.connect(vg);
      vg.connect(v.in);
      const vib2 = oscNode(v, 'sawtooth', 92 * pi, 6, end, t0);
      const vb2 = filt(v, end, 'bandpass', 700 * pi, 7);
      const vg2 = gainNode(v, end, 0.07);
      vib2.connect(vb2);
      vb2.connect(vg2);
      vg2.connect(v.in);
      lfoTo(v, t0, wl.frequency, 0.13, 220, end);
      v.nextEvent = t0 + 0.1;
    },
    // 周期性脚步：由 update 排程，避免用采样循环
    onUpdate(v, now) {
      if (now < v.nextEvent) return;
      v.nextEvent = now + rr(0.28, 0.36);
      const t = now + 0.004;
      click(v, t, { freq: 2600 * rr(0.85, 1.2), q: 1.4, dur: 0.03, gain: 0.16 });
      noiseBurst(v, t, { freq: 900, to: 300, q: 1.1, dur: 0.09, gain: 0.15, type: 'lowpass' });
      metalResonance(v, t + 0.006, { base: 640 * rr(0.9, 1.1), dur: 0.22, gain: 0.06, q: 9 });
    },
  },

  wallrun_end: {
    bus: 'sfx', gain: 0.4, dur: 0.24, limit: 2, minGap: 0.1, priority: 1,
    pitchVar: 0.04, brightVar: 0.1,
    build(v, t0, p) {
      whoosh(v, t0, { from: 1600 * p.pi, to: 360 * p.pi, dur: 0.2, q: 1.2, gain: 0.2, attack: 0.008 });
      noiseBurst(v, t0 + 0.01, { freq: 1100 * p.br, to: 260, q: 0.9, dur: 0.17, gain: 0.2, type: 'lowpass' });
      click(v, t0 + 0.025, { freq: 2700 * p.br, q: 3, dur: 0.03, gain: 0.14 });
    },
  },

  wallclimb_start: {
    bus: 'sfx', gain: 0.42, dur: 0.25, limit: 2, minGap: 0.1, priority: 1,
    pitchVar: 0.04, brightVar: 0.12,
    build(v, t0, p) {
      noiseBurst(v, t0, { freq: 1700 * p.br, to: 520, q: 1.4, dur: 0.18, gain: 0.28, type: 'bandpass' });
      metalResonance(v, t0 + 0.01, { base: 760 * p.br, dur: 0.2, gain: 0.1, q: 9 });
      thump(v, t0, { from: 106, to: 54, dur: 0.11, gain: 0.2 });
    },
  },

  wallclimb_loop: {
    bus: 'sfx', gain: 0.3, dur: 0.5, limit: 1, loopLimit: 1, priority: 1,
    sustained: true, pitchVar: 0.01, brightVar: 0.1,
    buildLoop(v, t0, p) {
      const end = t0 + LOOP_MAX;
      const scrape = srcNoise(v, t0, LOOP_MAX, 'white', 1, end);
      const bp = filt(v, end, 'bandpass', 980 * p.br, 1.6);
      const sg = gainNode(v, end, 0.2);
      scrape.connect(bp);
      bp.connect(sg);
      sg.connect(v.in);
      lfoTo(v, t0, bp.frequency, 1.2, 180, end);
      v.nextEvent = t0 + 0.12;
    },
    onUpdate(v, now) {
      if (now < v.nextEvent) return;
      v.nextEvent = now + rr(0.3, 0.42);
      const t = now + 0.004;
      noiseBurst(v, t, { freq: 1300, to: 360, q: 1.2, dur: 0.13, gain: 0.18, type: 'bandpass' });
      click(v, t + 0.008, { freq: 3100, q: 4, dur: 0.025, gain: 0.12 });
      thump(v, t, { from: 88, to: 48, dur: 0.09, gain: 0.14 });
    },
  },

  wallclimb_end: {
    bus: 'sfx', gain: 0.34, dur: 0.2, limit: 2, minGap: 0.1, priority: 1,
    pitchVar: 0.04, brightVar: 0.1,
    build(v, t0, p) {
      noiseBurst(v, t0, { freq: 1200 * p.br, to: 240, q: 1, dur: 0.15, gain: 0.22, type: 'bandpass' });
      tone(v, t0, { type: 'triangle', freq: 300 * p.pi, to: 110 * p.pi, dur: 0.14, gain: 0.08 });
      click(v, t0 + 0.015, { freq: 2200 * p.br, q: 3, dur: 0.024, gain: 0.1 });
    },
  },

  dash: {
    bus: 'sfx', gain: 0.55, dur: 0.38, limit: 2, minGap: 0.08, priority: 2,
    pitchVar: 0.04, brightVar: 0.12, verb: 0.16,
    build(v, t0, p) {
      const pi = p.pi;
      whoosh(v, t0, { from: 300 * pi, to: 2900 * pi, dur: 0.3, q: 2.4, gain: 0.34, attack: 0.07 });
      tone(v, t0, { type: 'sine', freq: 180 * pi, to: 520 * pi, dur: 0.16, gain: 0.14, sweepTime: 0.09 });
      tone(v, t0 + 0.09, { type: 'sine', freq: 520 * pi, to: 130 * pi, dur: 0.16, gain: 0.12 });
      thump(v, t0, { from: 92, to: 48, dur: 0.14, gain: 0.34 });
      noiseBurst(v, t0 + 0.16, { freq: 2400, to: 900, q: 0.8, dur: 0.16, gain: 0.1, type: 'highpass' });
    },
  },

  dash_end: {
    bus: 'sfx', gain: 0.38, dur: 0.22, limit: 2, minGap: 0.08, priority: 1,
    pitchVar: 0.035, brightVar: 0.1,
    build(v, t0, p) {
      whoosh(v, t0, { from: 1800 * p.pi, to: 320 * p.pi, dur: 0.18, q: 1.2, gain: 0.2, attack: 0.008 });
      tone(v, t0, { type: 'sine', freq: 430 * p.pi, to: 120 * p.pi, dur: 0.16, gain: 0.1 });
      thump(v, t0 + 0.035, { from: 86, to: 44, dur: 0.1, gain: 0.18 });
    },
  },

  grapple_fire: {
    bus: 'sfx', gain: 0.58, dur: 0.45, limit: 2, minGap: 0.08, priority: 2,
    pitchVar: 0.04, brightVar: 0.1, verb: 0.14,
    build(v, t0, p) {
      const pi = p.pi, br = p.br;
      noiseBurst(v, t0, { freq: 5200 * br, to: 1400, q: 0.9, dur: 0.24, gain: 0.34, type: 'highpass', attack: 0.004 });
      metalResonance(v, t0, { base: 900 * br, dur: 0.13, gain: 0.22, q: 15 });
      tone(v, t0, {
        type: 'sawtooth', freq: 400 * pi, to: 118 * pi, dur: 0.26, gain: 0.14,
        filter: 'bandpass', fq: 700 * br, q: 5,
      });
      thump(v, t0, { from: 150, to: 70, dur: 0.09, gain: 0.24 });
    },
  },

  grapple_hit: {
    bus: 'sfx', gain: 0.6, dur: 0.55, limit: 2, minGap: 0.06, priority: 2,
    pitchVar: 0.04, brightVar: 0.12, verb: 0.26,
    build(v, t0, p) {
      const pi = p.pi, br = p.br;
      metalResonance(v, t0, { base: 2200 * br, dur: 0.36, gain: 0.38, q: 16, ping: true });
      thump(v, t0, { from: 176 * pi, to: 58 * pi, dur: 0.12, gain: 0.4, drive: 2 });
      // 缆绳张力：两个微失谐三角波快速衰减
      tone(v, t0 + 0.01, { type: 'triangle', freq: 640 * pi, to: 470 * pi, dur: 0.2, gain: 0.16, filter: 'bandpass', fq: 1200, q: 4 });
      tone(v, t0 + 0.01, { type: 'triangle', freq: 648 * pi, to: 455 * pi, dur: 0.22, gain: 0.12 });
      click(v, t0, { freq: 5000 * br, q: 1.1, dur: 0.008, gain: 0.3, type: 'highpass' });
    },
  },

  grapple_loop: {
    bus: 'sfx', gain: 0.36, dur: 0.5, limit: 1, loopLimit: 1, priority: 2,
    sustained: true, pitchVar: 0.01, brightVar: 0.08, verb: 0.12,
    buildLoop(v, t0, p) {
      const end = t0 + LOOP_MAX;
      const cable = oscNode(v, 'triangle', 118 * p.pi, 0, end, t0);
      const bp = filt(v, end, 'bandpass', 720 * p.br, 5.5);
      const cg = gainNode(v, end, 0.16);
      cable.connect(bp);
      bp.connect(cg);
      cg.connect(v.in);
      const wind = srcNoise(v, t0, LOOP_MAX, 'pink', 1, end);
      const wl = filt(v, end, 'lowpass', 920 * p.br, 0.8);
      const wg = gainNode(v, end, 0.14);
      wind.connect(wl);
      wl.connect(wg);
      wg.connect(v.in);
      lfoTo(v, t0, bp.frequency, 0.8, 95, end);
      v.nextEvent = t0 + 0.2;
    },
    onUpdate(v, now) {
      if (now < v.nextEvent) return;
      v.nextEvent = now + rr(0.42, 0.62);
      const t = now + 0.004;
      metalResonance(v, t, { base: rr(760, 980), dur: 0.16, gain: 0.06, q: 12 });
      click(v, t, { freq: rr(2400, 3600), q: 4, dur: 0.018, gain: 0.08 });
    },
  },

  grapple_release: {
    bus: 'sfx', gain: 0.48, dur: 0.34, limit: 2, minGap: 0.08, priority: 2,
    pitchVar: 0.035, brightVar: 0.1, verb: 0.12,
    build(v, t0, p) {
      whoosh(v, t0, { from: 1700 * p.pi, to: 420 * p.pi, dur: 0.24, q: 1.4, gain: 0.22, attack: 0.01 });
      tone(v, t0, { type: 'triangle', freq: 620 * p.pi, to: 170 * p.pi, dur: 0.22, gain: 0.12, filter: 'bandpass', fq: 820, q: 4 });
      metalResonance(v, t0 + 0.025, { base: 920 * p.br, dur: 0.22, gain: 0.14, q: 13 });
      click(v, t0, { freq: 4200 * p.br, q: 4, dur: 0.018, gain: 0.16 });
    },
  },

  mantle: {
    bus: 'sfx', gain: 0.5, dur: 0.6, limit: 2, minGap: 0.1, priority: 1,
    pitchVar: 0.05, brightVar: 0.1,
    build(v, t0, p) {
      const pi = p.pi;
      noiseBurst(v, t0, { freq: 620 * pi, to: 1500 * pi, q: 1.3, dur: 0.24, gain: 0.26 });
      vocalGrunt(v, t0, 0.7, 138, 0.24);
      thump(v, t0 + 0.18, { from: 138, to: 62, dur: 0.14, gain: 0.32 });
      noiseBurst(v, t0 + 0.18, { freq: 800, to: 300, q: 0.9, dur: 0.16, gain: 0.2, type: 'lowpass' });
      click(v, t0 + 0.19, { freq: 2400, q: 4, dur: 0.03, gain: 0.12 });
    },
  },

  mantle_complete: {
    bus: 'sfx', gain: 0.42, dur: 0.28, limit: 2, minGap: 0.1, priority: 1,
    pitchVar: 0.04, brightVar: 0.1,
    build(v, t0, p) {
      thump(v, t0, { from: 118, to: 52, dur: 0.14, gain: 0.3 });
      noiseBurst(v, t0, { freq: 820 * p.br, to: 260, q: 0.9, dur: 0.18, gain: 0.25, type: 'lowpass' });
      click(v, t0 + 0.012, { freq: 2600 * p.br, q: 4, dur: 0.025, gain: 0.13 });
      tone(v, t0 + 0.025, { type: 'triangle', freq: 280 * p.pi, to: 160 * p.pi, dur: 0.13, gain: 0.07 });
    },
  },

  // ---------------- 战斗事件 ----------------

  // 近战挥击：先有短促空气切割，再以护臂伺服的机械啮合收尾。
  melee_swing: {
    bus: 'sfx', gain: 0.58, dur: 0.34, limit: 3, minGap: 0.07, priority: 2,
    pitchVar: 0.045, brightVar: 0.12, verb: 0.08,
    build(v, t0, p) {
      const pi = p.pi, br = p.br;
      whoosh(v, t0, { from: 340 * pi, to: 3600 * pi, dur: 0.22, q: 1.35, gain: 0.4, attack: 0.045 });
      noiseBurst(v, t0 + 0.025, { freq: 5200 * br, to: 1400, q: 1.1, dur: 0.18, gain: 0.16, type: 'highpass', attack: 0.025 });
      tone(v, t0 + 0.11, { type: 'triangle', freq: 720 * pi, to: 270 * pi, dur: 0.16, gain: 0.1, filter: 'bandpass', fq: 980 * br, q: 5 });
      click(v, t0 + 0.135, { freq: 4300 * br, q: 4, dur: 0.018, gain: 0.12 });
    },
  },

  // 近战命中：低频实体冲击和短金属破裂并存，与纯挥空明显区分。
  melee_hit: {
    bus: 'sfx', gain: 0.76, dur: 0.52, limit: 4, minGap: 0.055, priority: 3,
    pitchVar: 0.035, brightVar: 0.1, verb: 0.2,
    build(v, t0, p) {
      const pi = p.pi, br = p.br;
      impulse(v, t0, { freq: 6200 * br, to: 520, hp: 80, dur: 0.045, gain: 0.52, q: 0.9 });
      thump(v, t0, { from: 168 * pi, to: 42 * pi, dur: 0.24, gain: 0.72, drive: 4, sweep: 0.5 });
      noiseBurst(v, t0 + 0.006, { freq: 1800 * br, to: 260, q: 0.8, dur: 0.22, gain: 0.4, type: 'lowpass', drive: 5 });
      metalResonance(v, t0 + 0.012, { base: 1080 * br, dur: 0.38, gain: 0.22, q: 13 });
      rattle(v, t0 + 0.04, { count: 4, freq: 3600 * br, gain: 0.055, decay: 0.68, gapMin: 0.012, gapMax: 0.045, dur: 0.05 });
    },
  },

  explosion: {
    bus: 'sfx', gain: 1.0, dur: 2.0, limit: 3, minGap: 0.08, priority: 5,
    pitchVar: 0.025, brightVar: 0.08, verb: 0.5,
    build(v, t0, p) {
      const pi = p.pi, br = p.br;
      impulse(v, t0, { freq: 8000 * br, to: 500, hp: 90, dur: 0.05, gain: 0.9, q: 1.0 });
      noiseBurst(v, t0, {
        freq: 5000 * br, to: 170, q: 1.1, dur: 0.95, gain: 0.8, type: 'lowpass',
        drive: 22, sweepTime: 0.75,
      });
      thump(v, t0, { from: 96 * pi, to: 23 * pi, dur: 1.1, gain: 1.0, drive: 5, sweep: 0.6 });
      noiseBurst(v, t0 + 0.1, { freq: 200, to: 90, q: 0.7, dur: 1.5, gain: 0.3, type: 'lowpass' });
      // 碎片：金属残骸在 0.05~0.75s 内陆续落地
      for (let i = 0; i < 8; i++) {
        metalResonance(v, t0 + rr(0.05, 0.75), {
          base: rr(700, 4200), dur: rr(0.2, 0.7), gain: 0.12 * (1 - i / 12), q: rr(10, 22),
          partials: i % 2 === 0 ? METAL_PARTIALS : METAL_PARTIALS_HI,
        });
      }
      rattle(v, t0 + 0.2, { count: 6, freq: 5200, gain: 0.06, decay: 0.75, gapMin: 0.02, gapMax: 0.09, dur: 0.06 });
    },
  },

  spider_charge: {
    bus: 'sfx', gain: 0.85, dur: 1.1, limit: 6, minGap: 0.04, priority: 5,
    pitchVar: 0, brightVar: 0, verb: 0.1,
    build(v,t0,p) {
      const end=t0+1.1;
      const osc=oscNode(v,'triangle',380,0,end,t0);
      osc.frequency.exponentialRampToValueAtTime(1700,end-0.02);
      const g=gainNode(v,end,0);
      env(g.gain,t0,1.1,0.02,0.35);
      osc.connect(g); g.connect(v.in);
      for(let i=0;i<6;i++) thump(v,t0+i*0.16,{from:130+i*25,to:80,dur:0.08,gain:0.25});
    },
  },

  enemy_alert: {
    bus: 'sfx', gain: 0.48, dur: 0.5, limit: 3, minGap: 0.15, priority: 2,
    pitchVar: 0.05, brightVar: 0.1, verb: 0.2,
    build(v, t0, p) {
      const pi = p.pi, br = p.br;
      // 双失谐方波 + 38Hz 幅度调制 → 合成器式的“非人”警报
      const a = ctx.createOscillator();
      a.type = 'square';
      a.frequency.setValueAtTime(720 * pi, t0);
      a.frequency.exponentialRampToValueAtTime(430 * pi, t0 + 0.38);
      a.__src = 'osc';
      a.__baseDetune = 0;
      trackSrc(v, a, t0 + 0.5);
      const b = ctx.createOscillator();
      b.type = 'square';
      b.frequency.setValueAtTime(726 * pi, t0);
      b.frequency.exponentialRampToValueAtTime(425 * pi, t0 + 0.38);
      b.__src = 'osc';
      b.__baseDetune = 0;
      trackSrc(v, b, t0 + 0.5);
      const mix = gainNode(v, t0 + 0.5, 0.18);
      lfoTo(v, t0, mix.gain, 38, 0.16, t0 + 0.5);
      const bp = filt(v, t0 + 0.5, 'bandpass', 1200 * br, 2.6);
      const ws = shaper(v, t0 + 0.5, 8);
      const g = gainNode(v, t0 + 0.5, 0);
      env(g.gain, t0, 0.5, 0.006, 0.44);
      a.connect(ws);
      b.connect(ws);
      ws.connect(bp);
      bp.connect(mix);
      mix.connect(g);
      g.connect(v.in);
      a.start(t0);
      a.stop(t0 + 0.5);
      b.start(t0);
      b.stop(t0 + 0.5);
      noiseBurst(v, t0, { freq: 3200 * br, to: 900, q: 1.1, dur: 0.16, gain: 0.12 });
    },
  },

  enemy_die: {
    bus: 'sfx', gain: 0.6, dur: 1.0, limit: 3, minGap: 0.05, priority: 3,
    pitchVar: 0.04, brightVar: 0.1, verb: 0.3,
    build(v, t0, p) {
      const pi = p.pi, br = p.br;
      tone(v, t0, {
        type: 'sawtooth', freq: 600 * pi, to: 88 * pi, dur: 0.52, gain: 0.24,
        drive: 8, filter: 'bandpass', fq: 900 * br, q: 3.4, sweepTime: 0.45,
      });
      noiseBurst(v, t0, { freq: 5000 * br, to: 1800, q: 1.0, dur: 0.3, gain: 0.12, type: 'highpass' });
      // 机械解体：零件陆续掉落 + 最后一记闷响
      for (let i = 0; i < 6; i++) {
        metalResonance(v, t0 + rr(0.08, 0.6), {
          base: rr(800, 3200), dur: rr(0.12, 0.4), gain: 0.14 * (1 - i / 9), q: rr(10, 20),
        });
      }
      thump(v, t0 + 0.62, { from: 118, to: 44, dur: 0.3, gain: 0.44, drive: 3 });
      noiseBurst(v, t0 + 0.62, { freq: 700, to: 240, q: 0.8, dur: 0.24, gain: 0.2, type: 'lowpass' });
    },
  },

  // 通用战利品拾取：明亮上行音阶 + 磁吸扣合，不与合金专属音混淆。
  loot_pickup: {
    bus: 'sfx', gain: 0.52, dur: 0.38, limit: 4, minGap: 0.045, priority: 2,
    pitchVar: 0.025, brightVar: 0.08, verb: 0.16,
    build(v, t0, p) {
      const pi = p.pi, br = p.br;
      tone(v, t0, { type: 'sine', freq: 620 * pi, to: 1120 * pi, dur: 0.16, gain: 0.18, attack: 0.002 });
      tone(v, t0 + 0.065, { type: 'triangle', freq: 1120 * pi, to: 1780 * pi, dur: 0.2, gain: 0.14, attack: 0.002 });
      metalResonance(v, t0 + 0.07, { base: 1760 * br, dur: 0.24, gain: 0.12, q: 17, ping: true });
      click(v, t0 + 0.055, { freq: 6100 * br, q: 7, dur: 0.022, gain: 0.15, type: 'highpass' });
      thump(v, t0, { from: 104, to: 58, dur: 0.1, gain: 0.12 });
    },
  },

  // 战利品落地：下降音高、外壳磕碰和数次短促滚动，明确表达“物品已掉出”。
  loot_drop: {
    bus: 'sfx', gain: 0.55, dur: 0.62, limit: 5, minGap: 0.05, priority: 2,
    pitchVar: 0.045, brightVar: 0.12, verb: 0.24,
    build(v, t0, p) {
      const pi = p.pi, br = p.br;
      tone(v, t0, { type: 'triangle', freq: 840 * pi, to: 210 * pi, dur: 0.3, gain: 0.15, filter: 'bandpass', fq: 980 * br, q: 4 });
      thump(v, t0 + 0.035, { from: 138 * pi, to: 48 * pi, dur: 0.18, gain: 0.36, drive: 2 });
      noiseBurst(v, t0 + 0.03, { freq: 1300 * br, to: 240, q: 0.85, dur: 0.2, gain: 0.24, type: 'lowpass' });
      metalResonance(v, t0 + 0.025, { base: 720 * br, dur: 0.48, gain: 0.22, q: 12 });
      rattle(v, t0 + 0.12, { count: 5, freq: 2800 * br, gain: 0.065, decay: 0.7, gapMin: 0.025, gapMax: 0.085, dur: 0.055 });
    },
  },

  pickup_alloy: {
    bus: 'sfx', gain: 0.5, dur: 0.45, limit: 4, minGap: 0.04, priority: 1,
    pitchVar: 0.03, brightVar: 0.08, verb: 0.22,
    build(v, t0, p) {
      const pi = p.pi;
      // 非谐分音叠成“合金”的清脆音色
      tone(v, t0, { type: 'sine', freq: 1180 * pi, dur: 0.22, gain: 0.2, attack: 0.001 });
      tone(v, t0 + 0.012, { type: 'sine', freq: 1770 * pi, dur: 0.2, gain: 0.13, attack: 0.001 });
      tone(v, t0 + 0.024, { type: 'triangle', freq: 2650 * pi, dur: 0.16, gain: 0.07, attack: 0.001 });
      tone(v, t0, { type: 'sine', freq: 300 * pi, to: 180 * pi, dur: 0.09, gain: 0.14 });
      click(v, t0, { freq: 7000, q: 8, dur: 0.03, gain: 0.08 });
    },
  },

  upgrade_pick: {
    bus: 'ui', gain: 0.7, dur: 0.8, limit: 2, minGap: 0.15, priority: 3,
    pitchVar: 0.02, brightVar: 0.06, verb: 0.32,
    build(v, t0, p) {
      const notes = [523.25, 659.25, 987.77];
      for (let i = 0; i < notes.length; i++) {
        const t = t0 + i * 0.06;
        tone(v, t, { type: 'triangle', freq: notes[i], dur: 0.24, gain: 0.2, attack: 0.002 });
        tone(v, t, { type: 'sawtooth', freq: notes[i] * 0.5, dur: 0.2, gain: 0.07, filter: 'lowpass', fq: 1800, q: 1.2 });
      }
      whoosh(v, t0, { from: 400, to: 4200, dur: 0.4, q: 1.6, gain: 0.16, attack: 0.12 });
      thump(v, t0, { from: 80, to: 118, dur: 0.3, gain: 0.26 });
      tone(v, t0 + 0.16, { type: 'sine', freq: 2637, dur: 0.5, gain: 0.05, attack: 0.005 });
      tone(v, t0 + 0.18, { type: 'sine', freq: 3951, dur: 0.45, gain: 0.035, attack: 0.005 });
    },
  },

  objective_complete: {
    bus: 'ui', gain: 0.75, dur: 1.6, limit: 1, minGap: 0.3, priority: 4,
    pitchVar: 0.02, brightVar: 0.05, verb: 0.4,
    build(v, t0, p) {
      const chord = [110, 164.81, 220, 277.18];
      const gl = [1, 0.6, 0.5, 0.32];
      for (let i = 0; i < chord.length; i++) {
        tone(v, t0, {
          type: 'sawtooth', freq: chord[i], dur: 1.35, gain: 0.14 * gl[i],
          attack: 0.12, hold: 0.35, filter: 'lowpass', fq: 1500, q: 1.2,
        });
      }
      metalResonance(v, t0, { base: 700, dur: 0.95, gain: 0.26, q: 20, ping: true });
      whoosh(v, t0, { from: 300, to: 3600, dur: 0.6, q: 1.4, gain: 0.16, attack: 0.25 });
      thump(v, t0, { from: 58, to: 46, dur: 1.0, gain: 0.32, attack: 0.05 });
    },
  },

  extract_countdown: {
    bus: 'ui', gain: 0.5, dur: 0.36, limit: 2, minGap: 0.08, priority: 2,
    pitchVar: 0.02, brightVar: 0.05, verb: 0.14,
    build(v, t0, p) {
      tone(v, t0, { type: 'square', freq: 880, dur: 0.09, gain: 0.16, filter: 'bandpass', fq: 1400, q: 2.2 });
      tone(v, t0, { type: 'sine', freq: 1760, dur: 0.06, gain: 0.1 });
      click(v, t0, { freq: 5000, q: 1.0, dur: 0.006, gain: 0.16, type: 'highpass' });
      tone(v, t0 + 0.15, { type: 'square', freq: 659.25, dur: 0.1, gain: 0.14, filter: 'bandpass', fq: 1100, q: 2.2 });
      thump(v, t0 + 0.15, { from: 120, to: 70, dur: 0.08, gain: 0.14 });
    },
  },

  boss_arrive: {
    bus: 'ui', gain: 0.85, dur: 2.0, limit: 1, minGap: 3, priority: 5,
    build(v, t0) {
      thump(v, t0, { from: 100, to: 32, dur: 1.4, gain: 0.5 });
      for (let i = 0; i < 3; i++) {
        tone(v, t0 + i * 0.4, { type: 'sawtooth', freq: 110, to: 82, dur: 0.65, gain: 0.16, filter: 'lowpass', fq: 650, q: 2 });
      }
    },
  },
  boss_defeat: {
    bus: 'ui', gain: 0.9, dur: 1.8, limit: 1, minGap: 1, priority: 5,
    build(v, t0) {
      thump(v, t0, { from: 150, to: 25, dur: 1.2, gain: 0.55 });
      [220, 330, 440, 660].forEach((freq, i) => {
        tone(v, t0 + i * 0.18, { type: 'triangle', freq, dur: 0.7, gain: 0.2 });
      });
    },
  },
  extract_success: {
    bus: 'ui', gain: 0.85, dur: 1.7, limit: 1, minGap: 0.3, priority: 5,
    pitchVar: 0.015, brightVar: 0.05, verb: 0.45,
    build(v, t0, p) {
      const notes = [440, 554.37, 659.25, 880];
      for (let i = 0; i < notes.length; i++) {
        const t = t0 + i * 0.07;
        tone(v, t, { type: 'triangle', freq: notes[i], dur: 0.3, gain: 0.18, attack: 0.004 });
        tone(v, t, { type: 'sawtooth', freq: notes[i] * 0.5, dur: 0.3, gain: 0.07, filter: 'lowpass', fq: 2200, q: 1.4 });
      }
      // 铺底：两个微失谐锯齿构成“胜利”和声垫
      tone(v, t0, { type: 'sawtooth', freq: 220, dur: 1.3, gain: 0.1, attack: 0.3, hold: 0.3, filter: 'lowpass', fq: 2400, q: 1.1 });
      tone(v, t0, { type: 'sawtooth', freq: 221.5, dur: 1.3, gain: 0.08, attack: 0.3, hold: 0.3, filter: 'lowpass', fq: 2400, q: 1.1 });
      metalResonance(v, t0, { base: 1320, dur: 0.8, gain: 0.2, q: 22, ping: true });
      thump(v, t0, { from: 60, to: 72, dur: 0.9, gain: 0.36, attack: 0.06 });
      tone(v, t0 + 0.35, { type: 'sine', freq: 3520, dur: 0.8, gain: 0.05, attack: 0.02 });
    },
  },

  // ---------------- UI ----------------

  ui_click: {
    bus: 'ui', gain: 0.3, dur: 0.08, limit: 3, minGap: 0.02, priority: 1,
    pitchVar: 0.03, brightVar: 0.06,
    build(v, t0, p) {
      click(v, t0, { freq: 2600, q: 0.8, dur: 0.006, gain: 0.28, type: 'highpass' });
      tone(v, t0, { type: 'triangle', freq: 1240 * p.pi, dur: 0.03, gain: 0.14, attack: 0.001 });
    },
  },

  ui_hover: {
    bus: 'ui', gain: 0.18, dur: 0.06, limit: 2, minGap: 0.02, priority: 1,
    pitchVar: 0.03, brightVar: 0.06,
    build(v, t0, p) {
      tone(v, t0, { type: 'sine', freq: 1840 * p.pi, dur: 0.035, gain: 0.1, attack: 0.004 });
      click(v, t0, { freq: 6200, q: 1.2, dur: 0.004, gain: 0.05, type: 'highpass' });
    },
  },

  // ---------------- 环境 ----------------

  // 熔炉星港的一记远处锻锤：极低频轰鸣 + 长金属共振 + 蒸汽
  ambient_forge: {
    bus: 'music', gain: 0.6, dur: 2.2, limit: 3, minGap: 0.5, priority: 3,
    pitchVar: 0.06, brightVar: 0.12, verb: 0.6,
    build(v, t0, p) {
      const pi = p.pi, br = p.br;
      thump(v, t0, { from: 74 * pi, to: 26 * pi, dur: 0.95, gain: 0.6, drive: 3, sweep: 0.6 });
      noiseBurst(v, t0, { freq: 640 * br, to: 200, q: 0.8, dur: 0.5, gain: 0.24, type: 'lowpass' });
      metalResonance(v, t0 + 0.01, { base: 320 * pi, dur: 1.6, gain: 0.3, q: 20, ping: true });
      metalResonance(v, t0 + 0.06, { base: 900 * pi, dur: 1.0, gain: 0.14, q: 16, partials: METAL_PARTIALS_HI });
      noiseBurst(v, t0 + 0.05, { freq: 4200 * br, to: 2600, q: 0.9, dur: 1.1, gain: 0.1, type: 'highpass', attack: 0.25 });
    },
  },
};

// names 必须冻结，且顺序与契约第 15 节一致
const NAMES = Object.freeze(Object.keys(SOUNDS));

// 预建节流状态表：避免首次触发时分配对象
for (let i = 0; i < NAMES.length; i++) {
  stats[NAMES[i]] = { last: -1e9, count: 0 };
}

// ---------------------------------------------------------------------------
// 7. 空间化
// ---------------------------------------------------------------------------

// 反距离衰减 + 近亮远暗的低通 + 基于听者朝向的立体声定位（全部写入 out，零分配）
function computeAtt(pos, out) {
  const dx = pos[0] - listenerPos[0];
  const dy = pos[1] - listenerPos[1];
  const dz = pos[2] - listenerPos[2];
  const d2 = dx * dx + dy * dy + dz * dz;
  const d = Math.sqrt(d2) < 0.001 ? 0.001 : Math.sqrt(d2);

  let att;
  if (d <= REF_DIST) att = 1;
  else att = REF_DIST / (REF_DIST + (d - REF_DIST));
  const fadeStart = MAX_DIST * 0.85;
  if (d > fadeStart) att *= clamp(1 - (d - fadeStart) / (MAX_DIST - fadeStart), 0, 1);

  const t = clamp((d - REF_DIST) / (MAX_DIST - REF_DIST), 0, 1);
  const k = 1 - t;
  const cut = MIN_CUT + (OPEN_CUT - MIN_CUT) * k * k;

  // 听者右向量 = (-fwd.z, 0, fwd.x)
  let fx = listenerFwd[0];
  let fz = listenerFwd[2];
  const fl = Math.sqrt(fx * fx + fz * fz);
  if (fl > 0.0001) {
    fx /= fl;
    fz /= fl;
  } else {
    fx = 0;
    fz = -1;
  }
  const inv = 1 / d;
  const pan = clamp((dx * inv) * (-fz) + (dz * inv) * fx, -1, 1) * 0.8;

  out.gain = att;
  out.cut = cut;
  out.pan = pan;
  return out;
}

function applyListener() {
  const L = ctx.listener;
  if (!L) return;
  if (_lsMode === 0) {
    if (typeof L.setPosition === 'function') _lsMode = 1;
    else if (L.positionX !== undefined) _lsMode = 2;
    else _lsMode = 3;
  }
  const px = listenerPos[0], py = listenerPos[1], pz = listenerPos[2];
  const fx = listenerFwd[0], fy = listenerFwd[1], fz = listenerFwd[2];
  if (_lsMode === 1) {
    try {
      L.setPosition(px, py, pz);
      L.setOrientation(fx, fy, fz, 0, 1, 0);
    } catch (e) { _lsMode = 3; }
  } else if (_lsMode === 2) {
    L.positionX.value = px;
    L.positionY.value = py;
    L.positionZ.value = pz;
    if (L.forwardX !== undefined) {
      L.forwardX.value = fx;
      L.forwardY.value = fy;
      L.forwardZ.value = fz;
      L.upX.value = 0;
      L.upY.value = 1;
      L.upZ.value = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// 8. 参数抖动
// ---------------------------------------------------------------------------

function rollParams(def, rate) {
  const pv = def.pitchVar === undefined ? PITCH_VAR : def.pitchVar;
  const bv = def.brightVar === undefined ? BRIGHT_VAR : def.brightVar;
  _p.pi = (rate === undefined || rate <= 0 ? 1 : rate) * rr(1 - pv, 1 + pv);
  _p.br = rr(1 - bv, 1 + bv);
  _p.r1 = rnd();
  _p.r2 = rnd();
  _p.r3 = rnd();
  return _p;
}

// ---------------------------------------------------------------------------
// 9. 播放核心
// ---------------------------------------------------------------------------

function busFor(defBus, override) {
  const n = override === undefined || override === null ? defBus : override;
  if (n === 'music') return musicBus;
  if (n === 'ui') return uiBus;
  return sfxBus;
}

// 通道条：out(声部增益) → [远处低通] → [声像] → 总线
function wireVoice(v, cut, pan, busNode, end) {
  v.out = ctx.createGain();
  v.out.gain.value = v.baseGain;
  v.in = v.out;
  track(v, v.out, end);
  let tail = v.out;
  if (cut > 0 && cut < OPEN_CUT * 0.92) {
    v.lp = filt(v, end, 'lowpass', cut, 0.7);
    tail.connect(v.lp);
    tail = v.lp;
  }
  if (pan !== 0 && typeof ctx.createStereoPanner === 'function') {
    const sp = ctx.createStereoPanner();
    sp.pan.value = clamp(pan, -1, 1);
    v.pan = track(v, sp, end);
    tail.connect(v.pan);
    tail = v.pan;
  } else if (pan !== 0 && typeof ctx.createPanner === 'function') {
    const pn = ctx.createPanner();
    pn.panningModel = 'equalpower';
    if (pn.positionX !== undefined) pn.positionX.value = clamp(pan, -1, 1);
    v.pan = track(v, pn, end);
    tail.connect(v.pan);
    tail = v.pan;
  }
  tail.connect(busNode);
}

function setParam(param, value, t, tc) {
  if (param === null || param === undefined) return;
  if (typeof param.setTargetAtTime === 'function') param.setTargetAtTime(value, t, tc === undefined ? 0.02 : tc);
  else param.value = value;
}

function applyRate(v, r) {
  const rate = r > 0 ? r : 0.01;
  v.rate = rate;
  const shift = 1200 * Math.log(rate) / Math.LN2;
  const ns = v.nodes;
  for (let i = 0; i < ns.length; i++) {
    const n = ns[i];
    if (n === null) continue;
    if (n.__src === 'osc') {
      if (n.detune !== undefined) n.detune.value = (n.__baseDetune || 0) + shift;
    } else if (n.__src === 'buf') {
      if (n.playbackRate !== undefined) n.playbackRate.value = (n.__baseRate || 1) * rate;
    }
  }
}

function makeLoopHandle(name, v) {
  const h = {
    name,
    voice: v,
    active: true,
    stop() {
      if (!this.active) return;
      this.active = false;
      if (loopHandles[name] === this) delete loopHandles[name];
      releaseVoiceByRef(v);
    },
    setGain(g) {
      if (!this.active) return;
      const gg = g > 0 ? g : 0;
      v.baseGain = v.unitGain * gg;
      if (v.out !== null && ctx !== null) setParam(v.out.gain, v.baseGain, ctx.currentTime, 0.03);
    },
    setRate(r) {
      if (!this.active) return;
      applyRate(v, r);
    },
  };
  return h;
}

// 循环声部的重复触发（把一次性音效真的“循环”起来）
function retrigger(v, now) {
  v.nextRepeat = now + v.repeatEvery;
  const def = v.def;
  if (def === null) return;
  const p = rollParams(def, v.rate);
  def.build(v, now + 0.004, p);
}

function play(name, opts) {
  if (!_ready || ctx === null || _paused) return null;
  if (ctx.state === 'closed') return null;
  const def = SOUNDS[name];
  if (def === undefined) return null;   // 未知音效静默忽略，绝不抛错
  const o = opts === undefined || opts === null ? null : opts;
  const isLoop = o !== null && o.loop === true;
  const now = ctx.currentTime;

  // 距离衰减（opts.pos 存在时按最近一次 update 的听者计算）
  let distGain = 1;
  let cut = 0;
  let pan = 0;
  if (o !== null && o.pos !== undefined && o.pos !== null) {
    computeAtt(o.pos, _att);
    distGain = _att.gain;
    cut = _att.cut;
    pan = _att.pan;
    if (distGain <= 0.0006 && !isLoop) return null;
  }
  if (o !== null && o.cut !== undefined) cut = o.cut;
  if (o !== null && o.pan !== undefined) pan = o.pan;

  pruneVoices(now);

  // 同名循环：幂等，重复调用只更新增益，不叠加声部
  if (isLoop && loopHandles[name] !== undefined) {
    const ex = loopHandles[name];
    if (o !== null && o.gain !== undefined) ex.setGain(o.gain);
    return ex;
  }

  // 节流与合并：几毫秒内的重复触发按指数衰减增益，超过阈值直接丢弃
  let mergeGain = 1;
  if (!isLoop) {
    const st = stats[name];
    const gap = def.minGap === undefined ? 0.008 : def.minGap;
    if (now - st.last < gap) {
      st.count++;
      mergeGain = 1 / (1 + st.count * 1.6);
      const mx = def.mergeMax === undefined ? 3 : def.mergeMax;
      if (st.count > mx) return null;
    } else {
      st.count = 0;
      st.last = now;
    }
  }

  // 同名并发上限
  const limit = isLoop
    ? (def.loopLimit === undefined ? 1 : def.loopLimit)
    : (def.limit === undefined ? 4 : def.limit);
  const cnt = nameCount[name];
  if (cnt !== undefined && cnt >= limit) {
    const old = oldestVoiceOf(name, now);
    if (old !== null) stealVoice(old, now);
    else if (!isLoop) return null;
  }

  // 全局声部预算：超限时立即释放一个不重要的声部，保证硬上限
  if (voiceCount >= MAX_VOICES) {
    const pr = def.priority === undefined ? 1 : def.priority;
    if (!reclaimOne(pr) && !isLoop) return null;
  }

  const rate = o !== null && o.rate !== undefined ? o.rate : 1;
  const userGain = o !== null && o.gain !== undefined ? o.gain : 1;
  const p = rollParams(def, rate);

  const v = allocVoice(name);
  v.def = def;
  v.sustained = isLoop;   // 只有循环调用才是持续声部，一次性调用必须能被时间回收
  v.priority = def.priority === undefined ? 1 : def.priority;
  v.unitGain = def.gain * distGain * userGain * mergeGain;
  v.baseGain = v.unitGain * rr(1 - GAIN_VAR, 1 + GAIN_VAR);
  const span = isLoop ? LOOP_MAX : (def.dur === undefined ? 0.5 : def.dur) + 0.35;
  v.endTime = v.sustained ? Infinity : now + span;

  const busNode = busFor(def.bus, o === null ? undefined : o.bus);
  if (busNode === null) {
    releaseVoiceByRef(v);
    return null;
  }

  try {
    wireVoice(v, cut, pan, busNode, v.sustained ? now + LOOP_MAX : v.endTime);
    // 持续音型音效（slide_loop / wallrun_loop）没有一次性 builder：
    // 直接以循环 builder 兜底，保证 play(name) 在任何名字上都有合理行为
    const builder = typeof def.build === 'function' ? def.build : def.buildLoop;
    if (!isLoop && def.verb !== undefined && def.verb > 0) verbSend(v, v.endTime, def.verb);
    if (isLoop) {
      if (def.sustained === true && typeof def.buildLoop === 'function') {
        // 专用持续音：由 onUpdate 排程细节事件，不重复构建
        def.buildLoop(v, now + 0.004, p);
      } else {
        // 一次性音效被要求循环：按 repeatEvery 反复重新合成
        builder(v, now + 0.004, p);
        v.repeatEvery = def.loopRepeat === undefined ? Math.max(0.12, (def.dur || 0.4) * 0.9) : def.loopRepeat;
        v.nextRepeat = now + v.repeatEvery;
      }
      if (def.verb !== undefined && def.verb > 0) verbSend(v, now + LOOP_MAX, def.verb);
      const h = makeLoopHandle(name, v);
      loopHandles[name] = h;
      return h;
    }
    builder(v, now + 0.004, p);
    return null;
  } catch (e) {
    // 合成失败不能让游戏崩溃：销毁半成品声部并静默降级
    releaseVoiceByRef(v);
    return null;
  }
}

function playAt(name, pos, lpos, opts) {
  if (!_ready || ctx === null || _paused) return null;
  if (pos === undefined || pos === null) return play(name, opts);
  if (lpos !== undefined && lpos !== null) {
    listenerPos[0] = lpos[0];
    listenerPos[1] = lpos[1];
    listenerPos[2] = lpos[2];
    _listenerInit = true;
  }
  computeAtt(pos, _att);
  if (_att.gain <= 0.0006) return null;
  _tmpOpts.gain = (opts !== undefined && opts !== null && opts.gain !== undefined ? opts.gain : 1) * _att.gain;
  _tmpOpts.pan = _att.pan;
  _tmpOpts.cut = _att.cut;
  _tmpOpts.rate = opts !== undefined && opts !== null && opts.rate !== undefined ? opts.rate : 1;
  _tmpOpts.bus = opts !== undefined && opts !== null && opts.bus !== undefined ? opts.bus : null;
  _tmpOpts.loop = opts !== undefined && opts !== null && opts.loop === true;
  _tmpOpts.pos = null;
  return play(name, _tmpOpts);
}

// ---------------------------------------------------------------------------
// 10. 环境层（低频轰鸣 + 失谐锯齿垫 + 随机金属撞击 + 远处机械闷响）
// ---------------------------------------------------------------------------

const AMBIENT_PRESETS = {
  industrial_forge: {
    sub: 38.0, sub2: 39.6, subGain: 0.3,
    padRoot: 55, padFifth: 82.41, padCut: 330, padQ: 3.5, padGain: 0.085, padDetune: 7,
    airCut: 520, airGain: 0.05,
    clangMin: 4.5, clangMax: 13, clangGain: 0.5,
    thumpMin: 2.0, thumpMax: 5.5, thumpGain: 0.3, verb: 0.5,
  },
  ice: {
    sub: 31.0, sub2: 31.9, subGain: 0.24,
    padRoot: 65.41, padFifth: 98.0, padCut: 540, padQ: 5, padGain: 0.06, padDetune: 11,
    airCut: 1500, airGain: 0.09,
    clangMin: 8, clangMax: 20, clangGain: 0.24,
    thumpMin: 4, thumpMax: 10, thumpGain: 0.18, verb: 0.62,
  },
  desert: {
    sub: 33.0, sub2: 34.1, subGain: 0.22,
    padRoot: 49.0, padFifth: 73.42, padCut: 220, padQ: 2.6, padGain: 0.06, padDetune: 9,
    airCut: 900, airGain: 0.08,
    clangMin: 9, clangMax: 22, clangGain: 0.18,
    thumpMin: 3, thumpMax: 8, thumpGain: 0.2, verb: 0.35,
  },
  void: {
    sub: 27.0, sub2: 27.7, subGain: 0.34,
    padRoot: 41.2, padFifth: 61.74, padCut: 180, padQ: 4, padGain: 0.075, padDetune: 14,
    airCut: 380, airGain: 0.02,
    clangMin: 12, clangMax: 30, clangGain: 0.3,
    thumpMin: 6, thumpMax: 14, thumpGain: 0.16, verb: 0.7,
  },
  // 舰骸坟场：空心船体的金属回响，撞击更频繁更亮
  scrapyard: {
    sub: 34.5, sub2: 35.9, subGain: 0.26,
    padRoot: 46.25, padFifth: 69.3, padCut: 260, padQ: 4.5, padGain: 0.07, padDetune: 12,
    airCut: 380, airGain: 0.06,
    clangMin: 3.5, clangMax: 9, clangGain: 0.44,
    thumpMin: 2.5, thumpMax: 7, thumpGain: 0.26, verb: 0.62,
  },
  // 深核矿脉：最沉的次低频 + 高频次的钻掘闷响
  mine: {
    sub: 26.0, sub2: 27.1, subGain: 0.4,
    padRoot: 43.65, padFifth: 65.4, padCut: 200, padQ: 3.2, padGain: 0.07, padDetune: 8,
    airCut: 300, airGain: 0.04,
    clangMin: 6, clangMax: 16, clangGain: 0.3,
    thumpMin: 1.5, thumpMax: 4, thumpGain: 0.42, verb: 0.7,
  },
  // 熔渣荒原：粗粝的风噪 + 远处闷爆
  slag: {
    sub: 30.0, sub2: 30.8, subGain: 0.24,
    padRoot: 51.9, padFifth: 77.8, padCut: 240, padQ: 2.4, padGain: 0.055, padDetune: 10,
    airCut: 1100, airGain: 0.1,
    clangMin: 7, clangMax: 18, clangGain: 0.2,
    thumpMin: 3, thumpMax: 9, thumpGain: 0.3, verb: 0.4,
  },
};

// 生物群系 → 环境层预设（匹配 builtin-maps.js 的真实 id，未知 id 回退熔炉星港）
function pickPreset(biome) {
  const b = biome.toLowerCase();
  if (b.indexOf('ice') >= 0 || b.indexOf('frozen') >= 0 || b.indexOf('tundra') >= 0 || b.indexOf('snow') >= 0) return AMBIENT_PRESETS.ice;
  if (b.indexOf('desert') >= 0 || b.indexOf('sand') >= 0 || b.indexOf('dune') >= 0) return AMBIENT_PRESETS.desert;
  if (b.indexOf('void') >= 0 || b.indexOf('space') >= 0 || b.indexOf('orbital') >= 0 || b.indexOf('station') >= 0) return AMBIENT_PRESETS.void;
  if (b.indexOf('graveyard') >= 0 || b.indexOf('wreck') >= 0 || b.indexOf('ship') >= 0) return AMBIENT_PRESETS.scrapyard;
  if (b.indexOf('mine') >= 0 || b.indexOf('core') >= 0 || b.indexOf('deep') >= 0 || b.indexOf('drill') >= 0) return AMBIENT_PRESETS.mine;
  if (b.indexOf('slag') >= 0 || b.indexOf('waste') >= 0 || b.indexOf('ash') >= 0) return AMBIENT_PRESETS.slag;
  return AMBIENT_PRESETS.industrial_forge;
}

function startAmbient(biome) {
  const b = typeof biome === 'string' && biome.length > 0 ? biome : 'industrial_forge';
  if (!_ready || ctx === null) {
    pendingAmbient = b;   // init 之前调用：记下来，等上下文就绪再开
    return;
  }
  if (ambient.v !== null) {
    if (ambient.biome === b) return;   // 幂等：重复调用不叠加声部
    stopAmbient();
  }
  const preset = pickPreset(b);
  const now = ctx.currentTime;
  const end = now + LOOP_MAX;
  const v = allocVoice('ambient');
  v.sustained = true;
  v.priority = 0;
  v.unitGain = 1;
  v.baseGain = 1;
  v.endTime = Infinity;
  v.out = ctx.createGain();
  v.out.gain.value = 1;
  v.in = v.out;
  track(v, v.out, Infinity);
  v.out.connect(musicBus);

  // 1) 次低频轰鸣：两个微失谐正弦互相拍频，慢 LFO 让它“呼吸”
  const s1 = oscNode(v, 'sine', preset.sub, 0, end, now);
  const s2 = oscNode(v, 'sine', preset.sub2, 0, end, now);
  const sg = gainNode(v, end, preset.subGain * 0.7);
  s1.connect(sg);
  s2.connect(sg);
  sg.connect(v.out);
  lfoTo(v, now, sg.gain, 0.047, preset.subGain * 0.45, end);

  // 2) 两个缓慢失谐的锯齿垫：共享低通 + 五度分音 → 工业持续音
  const plp = filt(v, end, 'lowpass', preset.padCut, preset.padQ);
  const pg = gainNode(v, end, preset.padGain);
  const p1 = oscNode(v, 'sawtooth', preset.padRoot, -preset.padDetune, end, now);
  const p2 = oscNode(v, 'sawtooth', preset.padRoot * 1.006, preset.padDetune, end, now);
  const p3 = oscNode(v, 'sawtooth', preset.padFifth, preset.padDetune * 0.5, end, now);
  const p3g = gainNode(v, end, 0.45);
  p1.connect(plp);
  p2.connect(plp);
  p3.connect(p3g);
  p3g.connect(plp);
  plp.connect(pg);
  pg.connect(v.out);
  lfoTo(v, now, plp.frequency, 0.031, preset.padCut * 0.32, end);
  lfoTo(v, now, pg.gain, 0.019, preset.padGain * 0.35, end);

  // 3) 气流 / 远处机械底噪
  const an = srcNoise(v, now, LOOP_MAX, 'pink', 0.85, end);
  const alp = filt(v, end, 'lowpass', preset.airCut, 0.7);
  const ag = gainNode(v, end, preset.airGain);
  an.connect(alp);
  alp.connect(ag);
  ag.connect(v.out);
  lfoTo(v, now, alp.frequency, 0.023, preset.airCut * 0.5, end);

  ambient.v = v;
  ambient.biome = b;
  ambient.preset = preset;
  ambient.active = true;
  ambient.nextClang = now + rr(preset.clangMin, preset.clangMax);
  ambient.nextThump = now + rr(preset.thumpMin, preset.thumpMax);
  ambient.lastPump = now;
  ensureAmbientTimer();
}

function stopAmbient() {
  const v = ambient.v;
  ambient.v = null;
  ambient.active = false;
  ambient.biome = '';
  ambient.preset = null;
  clearAmbientTimer();
  if (v !== null) releaseVoiceByRef(v);
}

// 稀疏事件排程：金属撞击用完整的 ambient_forge 声部（走 music 总线），机械闷响叠加在环境声部上
function updateAmbient(now) {
  const v = ambient.v;
  const preset = ambient.preset;
  if (v === null || preset === null) return;
  ambient.lastPump = now;   // 心跳兜底据此判断 update() 是否仍在被调用
  if (now >= ambient.nextClang) {
    ambient.nextClang = now + rr(preset.clangMin, preset.clangMax);
    _ambOpts.gain = preset.clangGain * rr(0.55, 1.0);
    _ambOpts.pan = rr(-0.8, 0.8);
    _ambOpts.rate = rr(0.85, 1.15);
    play('ambient_forge', _ambOpts);
  }
  if (now >= ambient.nextThump) {
    ambient.nextThump = now + rr(preset.thumpMin, preset.thumpMax);
    machineryThump(v, now + 0.02, preset.thumpGain * rr(0.65, 1.1));
  }
}

// ---------------------------------------------------------------------------
// 11. 初始化与混音
// ---------------------------------------------------------------------------

function buildGraph() {
  sfxBus = ctx.createGain();
  musicBus = ctx.createGain();
  uiBus = ctx.createGain();
  masterGain = ctx.createGain();
  pauseGain = ctx.createGain();

  sfxBus.gain.value = _busGain.sfx;
  musicBus.gain.value = _busGain.music;
  uiBus.gain.value = _busGain.ui;
  masterGain.gain.value = _mst;
  pauseGain.gain.value = 1;

  // 母线压缩：连发与爆炸的瞬态不再削顶，整体更“厚”
  comp = ctx.createDynamicsCompressor();
  if (comp.threshold !== undefined) comp.threshold.value = -9;
  if (comp.knee !== undefined) comp.knee.value = 14;
  if (comp.ratio !== undefined) comp.ratio.value = 4.2;
  if (comp.attack !== undefined) comp.attack.value = 0.004;
  if (comp.release !== undefined) comp.release.value = 0.16;

  sfxBus.connect(masterGain);
  musicBus.connect(masterGain);
  uiBus.connect(masterGain);
  masterGain.connect(comp);
  comp.connect(pauseGain);
  pauseGain.connect(ctx.destination);

  // 程序化脉冲响应 + 卷积混响（只在需要“空间”的音效上回送，不铺满全局）
  if (typeof ctx.createConvolver === 'function') {
    const cv = ctx.createConvolver();
    cv.buffer = makeIR(1.5, 2.4);
    if (cv.normalize !== undefined) cv.normalize = true;
    verbBus = ctx.createGain();
    verbBus.gain.value = 0.5;
    verbBus.connect(cv);
    cv.connect(masterGain);
    _verbReady = true;
  }
}

function doInit() {
  if (_initPromise !== null) return _initPromise;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof AC !== 'function') {
    // 无 WebAudio 的环境（无头 / 老浏览器）：保持 ready=false，所有调用静默 no-op
    _initPromise = Promise.resolve();
    return _initPromise;
  }
  _initPromise = new Promise((resolve) => {
    let c = null;
    try {
      c = new AC();
    } catch (e) {
      c = null;
    }
    if (c === null) {
      resolve();
      return;
    }
    ctx = c;
    srand(0x5eed1a3b);
    try {
      buildGraph();
      noiseBuf('white');
      noiseBuf('pink');
      _ready = true;
    } catch (e) {
      _ready = false;
      ctx = null;
      resolve();
      return;
    }
    const done = () => {
      if (pendingAmbient !== null) {
        const b = pendingAmbient;
        pendingAmbient = null;
        startAmbient(b);
      }
      resolve();
    };
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      try {
        const r = ctx.resume();
        if (r !== undefined && r !== null && typeof r.then === 'function') {
          r.then(done, done);
          return;
        }
      } catch (e) { /* 浏览器拒绝恢复：保持挂起，后续手势再试 */ }
    }
    done();
  });
  return _initPromise;
}

function init() {
  if (_ready && ctx !== null) {
    // 已就绪：顺带尝试从挂起状态恢复（浏览器要求用户手势）
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      try {
        const r = ctx.resume();
        if (r !== undefined && r !== null && typeof r.then === 'function') return r.then(noop, noop);
      } catch (e) { /* 忽略 */ }
    }
    return Promise.resolve();
  }
  return doInit();
}

/**
 * 轻量级"保活"：每帧调用也不会有额外开销。
 *
 * 背景（用户实测"没有音效"）：AudioContext 必须在**用户手势内**创建/恢复。
 * 如果首次 resume 因为时序问题被浏览器拒绝，上下文会一直停在 suspended，
 * 表现就是"游戏有画面但完全没有声音"，而且不报任何错。
 * 这里在游戏真正跑起来之后持续重试恢复，一旦成功就自动补上环境音。
 */
function revive() {
  if (!_ready || ctx === null) return false;
  if (ctx.state === 'running') return true;
  if (typeof ctx.resume === 'function') {
    try {
      const r = ctx.resume();
      if (r && typeof r.then === 'function') {
        r.then(() => {
          if (ctx && ctx.state === 'running' && pendingAmbient !== null) {
            const b = pendingAmbient;
            pendingAmbient = null;
            startAmbient(b);
          }
        }, noop);
      }
    } catch (e) { /* 忽略，下次再试 */ }
  }
  return ctx.state === 'running';
}

/** 当前上下文状态（'running' / 'suspended' / 'none'），供 UI 提示与自测读取 */
function contextState() {
  return ctx === null ? 'none' : (ctx.state || 'unknown');
}

function setMaster(gain) {
  _mst = clamp(gain === undefined ? _mst : gain, 0, 4);
  if (masterGain !== null && ctx !== null) setParam(masterGain.gain, _mst, ctx.currentTime, 0.03);
}

function setBus(name, gain) {
  const g = clamp(gain === undefined ? 1 : gain, 0, 4);
  if (name === 'master') {
    setMaster(g);
    return;
  }
  if (name === 'music') {
    _busGain.music = g;
    if (musicBus !== null && ctx !== null) setParam(musicBus.gain, g, ctx.currentTime, 0.03);
    return;
  }
  if (name === 'ui') {
    _busGain.ui = g;
    if (uiBus !== null && ctx !== null) setParam(uiBus.gain, g, ctx.currentTime, 0.03);
    return;
  }
  _busGain.sfx = g;
  if (sfxBus !== null && ctx !== null) setParam(sfxBus.gain, g, ctx.currentTime, 0.03);
}

function setPaused(b) {
  _paused = b === true;
  if (!_ready || ctx === null || pauseGain === null) return;
  setParam(pauseGain.gain, _paused ? 0 : 1, ctx.currentTime, 0.02);
  try {
    if (_paused) {
      if (ctx.state === 'running' && typeof ctx.suspend === 'function') {
        const r = ctx.suspend();
        if (r !== undefined && r !== null && typeof r.catch === 'function') r.catch(noop);
      }
    } else if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      const r = ctx.resume();
      if (r !== undefined && r !== null && typeof r.catch === 'function') r.catch(noop);
    }
  } catch (e) { /* 挂起失败不影响静音闸门 */ }
}

function stopAll() {
  for (let i = voices.length - 1; i >= 0; i--) releaseAt(i);
  for (const k in loopHandles) {
    const h = loopHandles[k];
    if (h !== undefined) h.active = false;
    delete loopHandles[k];
  }
  clearAmbientTimer();
  ambient.v = null;
  ambient.active = false;
  ambient.biome = '';
  ambient.preset = null;
}

function update(dt, lpos, lfwd) {
  if (dt !== undefined && dt !== null && lpos === undefined && lfwd === undefined && typeof dt === 'object') {
    // 容错：允许 update(listenerPos, listenerForward) 的误用形式
    lfwd = lpos;
    lpos = dt;
    dt = 0.016;
  }
  if (lpos !== undefined && lpos !== null) {
    listenerPos[0] = lpos[0];
    listenerPos[1] = lpos[1];
    listenerPos[2] = lpos[2];
    _listenerInit = true;
  }
  if (lfwd !== undefined && lfwd !== null) {
    const fx = lfwd[0], fy = lfwd[1], fz = lfwd[2];
    const l = Math.sqrt(fx * fx + fy * fy + fz * fz);
    if (l > 0.0001) {
      listenerFwd[0] = fx / l;
      listenerFwd[1] = fy / l;
      listenerFwd[2] = fz / l;
    }
  }
  if (!_ready || ctx === null) return;
  applyListener();
  if (_paused) return;

  let step = typeof dt === 'number' && dt > 0 ? dt : 0.016;
  if (step > 0.25) step = 0.25;   // 长时间挂起后不让环境事件一次补发

  const now = ctx.currentTime;
  pruneVoices(now);
  pumpSustained(now, step);
  updateAmbient(now);
}

// 持续音（循环声部）的每帧维护：重复触发、自定义调制、过期节点回收
function pumpSustained(now, step) {
  for (let i = 0; i < voices.length; i++) {
    const v = voices[i];
    if (!v.sustained) continue;
    if (v.repeatEvery > 0 && now >= v.nextRepeat) retrigger(v, now);
    if (v.def !== null && typeof v.def.onUpdate === 'function') v.def.onUpdate(v, now, step);
    pruneNodes(v, now);
  }
}

// 心跳兜底：调用方忘记每帧 update() 时，环境层依然会排程稀疏事件、循环声部依然会重复触发
function ambientPump() {
  if (!_ready || ctx === null || _paused) return;
  if (ambient.v === null) {
    clearAmbientTimer();
    return;
  }
  const now = ctx.currentTime;
  if (now - ambient.lastPump < AMBIENT_PUMP_IDLE) return;   // update() 正常在跑，交给它
  pruneVoices(now);
  pumpSustained(now, AMBIENT_PUMP_IDLE);
  updateAmbient(now);
}

function ensureAmbientTimer() {
  if (ambientTimer !== null || typeof setInterval !== 'function') return;
  ambientTimer = setInterval(ambientPump, AMBIENT_PUMP_MS);
  // Node 环境（自测）下不阻止进程退出
  if (ambientTimer !== null && typeof ambientTimer.unref === 'function') ambientTimer.unref();
}

function clearAmbientTimer() {
  if (ambientTimer === null) return;
  if (typeof clearInterval === 'function') clearInterval(ambientTimer);
  ambientTimer = null;
}

function debugState() {
  const loops = [];
  for (const k in loopHandles) {
    const h = loopHandles[k];
    if (h !== undefined && h.active === true) loops.push(k);
  }
  return {
    ready: _ready,
    voices: voiceCount,
    ctxState: ctx === null ? 'none' : ctx.state,
    buses: {
      master: masterGain === null ? _mst : masterGain.gain.value,
      sfx: sfxBus === null ? _busGain.sfx : sfxBus.gain.value,
      music: musicBus === null ? _busGain.music : musicBus.gain.value,
      ui: uiBus === null ? _busGain.ui : uiBus.gain.value,
    },
    loops,
    ambient: ambient.active ? ambient.biome : null,
    paused: _paused,
    listener: _listenerInit,
  };
}

// ---------------------------------------------------------------------------
// 12. 对外单例
// ---------------------------------------------------------------------------

export const Audio = {
  init,
  revive,
  contextState,
  get ready() { return _ready; },
  play,
  playAt,
  update,
  setBus,
  setMaster,
  setPaused,
  startAmbient,
  stopAmbient,
  stopAll,
  setLoopGain(name, g) {
    const h = loopHandles[name];
    if (h !== undefined) h.setGain(g);
  },
  stopLoop(name) {
    const h = loopHandles[name];
    if (h !== undefined) h.stop();
  },
  get names() { return NAMES; },
  debugState,
};
