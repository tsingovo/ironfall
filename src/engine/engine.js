// ==== engine/engine.js — WebGL2 渲染引擎（状态批处理 + 实例化） ====
// 性能设计（这是高帧率的核心）：
//   1) 每帧按提交顺序收集绘制请求，只把紧邻且状态完全相同的实例合并成批次。
//      不能回头合并不连续批次，否则中间实例在 staging buffer 中会被覆盖。
//   2) 实例数据先写入 CPU 端 staging 数组，帧末一次性 bufferSubData 上传（1 次拷贝）。
//   3) 零每帧分配：staging 数组按需增长，批次结构复用。
//   4) 少量 shader 变体（lit / unlit / additive），程序编译一次缓存复用。
//   5) 着色为平直 Lambert + 半球环境光 + 边缘光 + 距离雾 + 程序化面板细节，
//      低多边形模型也能有工业质感，且像素开销极小。

import {
  m4, m4Identity, m4Mul, m4Perspective, m4ViewFromDir, m4FrustumPlanes,
  frustumSphereAt, m4Compose, clamp, lerp, damp, toRad,
} from '../core/math.js';

const FLOATS_PER_INSTANCE = 20; // mat4(16) + tint(4)
const VS_FLOATS = 8;            // pos(3) + normal(3) + uv(2)

// ---------------------------------------------------------------- 着色器

const COMMON_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUv;
layout(location=3) in vec4 iM0;
layout(location=4) in vec4 iM1;
layout(location=5) in vec4 iM2;
layout(location=6) in vec4 iM3;
layout(location=7) in vec4 iTint;
uniform mat4 uViewProj;
out vec3 vWorld;
out vec3 vNormal;
out vec3 vTint;
out vec2 vUv;
void main() {
  vec4 wp = iM0 * aPos.x + iM1 * aPos.y + iM2 * aPos.z + iM3;
  vWorld = wp.xyz;
  mat3 nm = mat3(iM0.xyz, iM1.xyz, iM2.xyz);
  vec3 n = nm * aNormal;
  float nl = length(n);
  vNormal = nl > 1e-6 ? n / nl : vec3(0.0, 1.0, 0.0);
  vTint = iTint.rgb;
  vUv = aUv;
  gl_Position = uViewProj * wp;
}`;

const COMMON_FS_HEAD = `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in vec3 vTint;
in vec2 vUv;
out vec4 fragColor;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uFogColor;
uniform vec2 uFogRange;
uniform vec3 uCameraPos;
uniform vec3 uFillColor;
`;

const FRAG_LIT = `void main() {
  vec3 N = normalize(vNormal);
  float ndl = max(dot(N, -uSunDir), 0.0);
  // 半球环境光：工业场景冷顶暖地。
  // 这里的环境项刻意给得比物理"正确"更亮 —— 低模场景里室内墙面若只吃微弱环境光
  // 会糊成纯黑，玩家看不清结构（这是可玩性问题，不是画面问题）。
  float hemi = N.y * 0.5 + 0.5;
  vec3 ambient = mix(uFillColor, uAmbient, hemi) * 1.45 + uAmbient * 0.35;
  // 保底环境亮度：不让背光面糊成纯黑，否则结构与敌人都失去轮廓。
  vec3 col = vTint * (ambient + vec3(0.14) + uSunColor * ndl * 1.15);
  // 边缘光强化轮廓（低模靠它出形）
  vec3 V = normalize(uCameraPos - vWorld);
  float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
  col += vTint * rim * 0.30;
  // 程序化面板细节：世界空间三平面，给大块面加机械分格。
  // 格距约 4m；远处按距离淡出，避免高频网格在远景产生摩尔纹。
  vec3 wp = vWorld * 0.25;
  vec3 trip = abs(N);
  trip = trip / max(dot(trip, vec3(1.0)), 1e-4);
  float grid = 0.0;
  grid += trip.x * max(abs(fract(wp.z) - 0.5), abs(fract(wp.y) - 0.5));
  grid += trip.y * max(abs(fract(wp.x) - 0.5), abs(fract(wp.z) - 0.5));
  grid += trip.z * max(abs(fract(wp.x) - 0.5), abs(fract(wp.y) - 0.5));
  float d = distance(uCameraPos, vWorld);
  float gridFade = 1.0 - smoothstep(35.0, 110.0, d);
  col *= 1.0 + (0.80 + 0.44 * smoothstep(0.28, 0.52, grid) - 1.0) * gridFade;
  float panel = step(0.93, fract(wp.y * 0.5 + wp.x * 0.07 + wp.z * 0.03));
  col *= 1.0 + panel * 0.10 * gridFade;
  // 距离雾
  float fog = clamp((d - uFogRange.x) / max(uFogRange.y - uFogRange.x, 1.0), 0.0, 1.0);
  col = mix(col, uFogColor, fog * fog * (3.0 - 2.0 * fog));
  fragColor = vec4(col, 1.0);
}`;

const FRAG_UNLIT = `void main() {
  vec3 col = vTint;
  float d = distance(uCameraPos, vWorld);
  float fog = clamp((d - uFogRange.x) / max(uFogRange.y - uFogRange.x, 1.0), 0.0, 0.5);
  col = mix(col, uFogColor, fog * fog);
  fragColor = vec4(col, 1.0);
}`;

const FRAG_ADDITIVE = `void main() {
  fragColor = vec4(vTint, 1.0);
}`;

const FRAG_UNLIT_ALPHA = `void main() {
  float d = distance(uCameraPos, vWorld);
  float fog = clamp((d - uFogRange.x) / max(uFogRange.y - uFogRange.x, 1.0), 0.0, 0.5);
  vec3 col = mix(vTint, uFogColor, fog * fog);
  fragColor = vec4(col, 1.0);
}`;

const LINE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aColor;
uniform mat4 uViewProj;
out vec3 vColor;
void main() {
  vColor = aColor;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const LINE_FS = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 fragColor;
void main() { fragColor = vec4(vColor, 1.0); }`;

// ---------------------------------------------------------------- 批处理

class Batch {
  constructor() {
    this.mesh = null;
    this.program = 0;
    this.offset = 0;
    this.count = 0;
    this.capacity = 0;
    this.depthWrite = true;
    this.cull = true;
    this.noDepthTest = false;
  }
}

/**
 * 绘制列表：按提交顺序把紧邻且渲染状态相同的请求合成批次。
 * 用小数组线性查找（每帧组合数 < 64，比 Map 更快且零 GC）。
 */
class DrawList {
  constructor() {
    this.batches = [];
    this.active = null;
    this._used = 0;
  }

  reset() {
    for (let i = 0; i < this._used; i++) this.batches[i].count = 0;
    this._used = 0;
    this.active = null;
  }

  get usedBatches() {
    return this._used;
  }

  /** 只续接紧邻的同状态绘制，防止回头追加时覆盖中间批次的实例数据。 */
  begin(mesh, program, depthWrite, cull, noDepthTest) {
    const a = this.active;
    if (a && a.mesh === mesh && a.program === program &&
        a.depthWrite === depthWrite && a.cull === cull &&
        a.noDepthTest === noDepthTest) {
      return a;
    }
    const b = this.batches[this._used] || new Batch();
    b.mesh = mesh;
    b.program = program;
    b.offset = 0;
    b.count = 0;
    b.depthWrite = depthWrite;
    b.cull = cull;
    b.noDepthTest = noDepthTest;
    if (!this.batches[this._used]) this.batches.push(b);
    this._used++;
    this.active = b;
    return b;
  }
}

// ---------------------------------------------------------------- 引擎

export class Engine {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: opts.antialias !== false,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
      desynchronized: true,
      preserveDrawingBuffer: false,
      failIfMajorPerformanceCaveat: false,
    });
    if (!gl) throw new Error('WEBGL2_UNAVAILABLE');
    this.gl = gl;

    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpuInfo = dbg ? {
      vendor: gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL),
      renderer: gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL),
    } : { vendor: 'unknown', renderer: 'unknown' };

    this.caps = {
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxSamples: gl.getParameter(gl.MAX_SAMPLES),
      maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
      anisotropics: gl.getExtension('EXT_texture_filter_anisotropic') ? true : false,
      timerQuery: gl.getExtension('EXT_disjoint_timer_query_webgl2') ? true : false,
    };

    this.width = canvas.width || 1;
    this.height = canvas.height || 1;
    this.aspect = this.width / this.height;
    this.dpr = 1;

    // 矩阵与相机
    this.view = m4();
    this.proj = m4();
    this.viewProj = m4();
    this.viewProjNoJitter = m4();
    this.cameraPos = new Float32Array(3);
    this.cameraForward = new Float32Array([0, 0, -1]);
    this.cameraUp = new Float32Array([0, 1, 0]);
    this.frustum = new Float32Array(24);
    this.fovDeg = 100;
    this.near = 0.06;
    this.far = 1200;

    // 光照/雾
    this.sunDir = new Float32Array([-0.42, -0.82, -0.36]);
    this.sunColor = new Float32Array([1.0, 0.87, 0.72]);
    this.ambient = new Float32Array([0.18, 0.21, 0.28]);
    this.fillColor = new Float32Array([0.10, 0.09, 0.085]);
    this.fogColor = new Float32Array([0.075, 0.09, 0.12]);
    this.fogRange = new Float32Array([80, 460]);
    this.clearColor = new Float32Array([0.045, 0.055, 0.075, 1]);

    // 统计
    this.stats = {
      drawCalls: 0, triangles: 0, instances: 0, frameMs: 0, cpuMs: 0,
      fps: 0, fpsAvg: 0, batches: 0, uploadedBytes: 0,
    };

    this._staging = new Float32Array(FLOATS_PER_INSTANCE * 2048);
    this._stagingCursor = 0;
    this._instanceVbo = gl.createBuffer();
    this._instanceCapacity = 2048;
    gl.bindBuffer(gl.ARRAY_BUFFER, this._instanceVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this._staging.byteLength, gl.DYNAMIC_DRAW);

    this.drawList = new DrawList();
    this._meshId = 0;
    this._meshes = [];
    this._programs = {};
    this._fpsSamples = new Float32Array(60);
    this._fpsIdx = 0;
    this._frameStart = 0;
    this._lastFrameTime = 0;
    this._lineCapacity = 4096;
    this._lineVbo = gl.createBuffer();
    this._lineCpu = new Float32Array(6 * this._lineCapacity);
    this._lineColorCpu = new Float32Array(6 * this._lineCapacity);
    this._lineInterleaved = new Float32Array(12 * this._lineCapacity);
    this._lineCount = 0;
    this._lineVao = gl.createVertexArray();
    gl.bindVertexArray(this._lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._lineVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this._lineInterleaved.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribDivisor(0, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.vertexAttribDivisor(1, 0);
    gl.bindVertexArray(null);
    this.boundViewport = [0, 0, 0, 0];

    // 世界坐标平移（相机相对渲染用不到，但保留接口）
    this.initGL();
  }

  initGL() {
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.clearColor(this.clearColor[0], this.clearColor[1], this.clearColor[2], 1);
    gl.clearDepth(1);
    this.programs.lit = this._compile(COMMON_VS, COMMON_FS_HEAD + FRAG_LIT);
    this.programs.unlit = this._compile(COMMON_VS, COMMON_FS_HEAD + FRAG_UNLIT);
    this.programs.additive = this._compile(COMMON_VS, COMMON_FS_HEAD + FRAG_ADDITIVE);
    this.programs.line = this._compile(LINE_VS, LINE_FS);
    this.programNames = ['lit', 'unlit', 'additive', 'line'];
    this._programIds = {
      lit: 0,
      unlit: 1,
      additive: 2,
      line: 3,
    };
  }

  get programs() {
    return this._programs;
  }

  _compile(vsSrc, fsSrc, attrs) {
    const gl = this.gl;
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsSrc);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(vs);
      gl.deleteShader(vs);
      throw new Error('SHADER_VERTEX_COMPILE_FAILED: ' + log);
    }
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fsSrc);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(fs);
      gl.deleteShader(fs);
      gl.deleteShader(vs);
      throw new Error('SHADER_FRAGMENT_COMPILE_FAILED: ' + log);
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      throw new Error('SHADER_LINK_FAILED: ' + log);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    // 缓存 uniform 位置
    const uniforms = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(prog, i);
      if (!info) continue;
      const name = info.name.replace(/\[0\]$/, '');
      uniforms[name] = gl.getUniformLocation(prog, name);
    }
    return { program: prog, uniforms };
  }

  // ------------------------------------------------------------ 尺寸

  setSize(w, h, dpr) {
    const gl = this.gl;
    this.dpr = dpr == null ? (window.devicePixelRatio || 1) : dpr;
    const pw = Math.max(1, Math.floor(w * this.dpr));
    const ph = Math.max(1, Math.floor(h * this.dpr));
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    this.width = pw;
    this.height = ph;
    this.aspect = pw / ph;
    gl.viewport(0, 0, pw, ph);
    this.boundViewport = [0, 0, pw, ph];
  }

  /** 使用显式视口（视图模型渲染用） */
  setViewport(x, y, w, h) {
    this.gl.viewport(x, y, w, h);
    this.boundViewport = [x, y, w, h];
  }

  get pixelWidth() { return this.width; }
  get pixelHeight() { return this.height; }

  // ------------------------------------------------------------ 帧

  beginFrame() {
    const gl = this.gl;
    this._frameStart = performance.now();
    this.stats.drawCalls = 0;
    this.stats.triangles = 0;
    this.stats.instances = 0;
    this.stats.batches = 0;
    this.stats.uploadedBytes = 0;
    this._stagingCursor = 0;
    this._lineCount = 0;
    this.drawList.reset();
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  /**
   * 提交所有批次。必须在场景绘制完成后调用。
   * 上传实例数据 → 逐批次 instanced draw。
   */
  flush() {
    const gl = this.gl;
    const dl = this.drawList;
    if (this._stagingCursor > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this._instanceVbo);
      if (this._stagingCursor * 4 > this._instanceCapacity * FLOATS_PER_INSTANCE * 4) {
        // 扩容
        gl.bufferData(gl.ARRAY_BUFFER, this._stagingCursor * 4 * 2, gl.DYNAMIC_DRAW);
        this._instanceCapacity = this._stagingCursor * 2 / FLOATS_PER_INSTANCE;
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._staging, 0, this._stagingCursor);
      this.stats.uploadedBytes += this._stagingCursor * 4;
    }

    for (let i = 0; i < dl.usedBatches; i++) {
      const b = dl.batches[i];
      if (b.count === 0) continue;
      this._drawBatch(b);
    }
    this.stats.batches += dl.usedBatches;
  }

  /** 提交当前队列并开启一个不清颜色/深度缓冲的新渲染 pass。 */
  flushAndReset() {
    this.flush();
    this._stagingCursor = 0;
    this.drawList.reset();
  }

  _drawBatch(b) {
    const gl = this.gl;
    const mesh = b.mesh;
    const prog = this._programs[b.program] || this._programs.lit;
    gl.useProgram(prog.program);
    this._setCameraUniforms(prog);
    if (b.cull) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
    gl.depthMask(b.depthWrite);
    // 穿墙提示：忽略深度测试，但也不写深度
    if (b.noDepthTest) gl.disable(gl.DEPTH_TEST); else gl.enable(gl.DEPTH_TEST);
    if (b.program === 'additive') {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
    } else {
      gl.disable(gl.BLEND);
    }

    gl.bindVertexArray(mesh.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._instanceVbo);
    // 实例属性指针：每次绑定 VBO 后需要重设（VAO 里记录了 buffer，但这里统一重设更安全）
    const stride = FLOATS_PER_INSTANCE * 4;
    for (let a = 0; a < 4; a++) {
      gl.enableVertexAttribArray(3 + a);
      gl.vertexAttribDivisor(3 + a, 1);
    }
    gl.enableVertexAttribArray(7);
    gl.vertexAttribDivisor(7, 1);

    // 每个批次从自己在实例 VBO 中的区间读取。旧实现计算了 first 却未使用，
    // 结果所有批次都从 offset=0 读到地形矩阵。
    const byteBase = b.offset * 4;
    for (let a = 0; a < 4; a++) {
      gl.vertexAttribPointer(3 + a, 4, gl.FLOAT, false, stride, byteBase + a * 16);
    }
    gl.vertexAttribPointer(7, 4, gl.FLOAT, false, stride, byteBase + 64);
    const idxType = mesh.indexType;
    gl.drawElementsInstanced(gl.TRIANGLES, mesh.indexCount, idxType, 0, b.count);
    this.stats.drawCalls++;
    this.stats.instances += b.count;
    this.stats.triangles += (mesh.indexCount / 3) * b.count;
  }

  endFrame() {
    const gl = this.gl;
    // 调试线（在批次之后绘制，深度测试保留）
    if (this._lineCount > 0) this._drawLines();
    this.stats.cpuMs = performance.now() - this._frameStart;
    const now = performance.now();
    if (this._lastFrameTime > 0) {
      const dt = now - this._lastFrameTime;
      this.stats.frameMs = dt;
      const fps = dt > 0 ? 1000 / dt : 0;
      this.stats.fps = fps;
      this._fpsSamples[this._fpsIdx] = fps;
      this._fpsIdx = (this._fpsIdx + 1) % this._fpsSamples.length;
      let sum = 0;
      for (let i = 0; i < this._fpsSamples.length; i++) sum += this._fpsSamples[i];
      this.stats.fpsAvg = sum / this._fpsSamples.length;
    }
    this._lastFrameTime = now;
    gl.bindVertexArray(null);
  }

  // ------------------------------------------------------------ 相机

  setCamera(pos, forward, up, fovDeg, near, far) {
    this.cameraPos[0] = pos[0]; this.cameraPos[1] = pos[1]; this.cameraPos[2] = pos[2];
    this.cameraForward[0] = forward[0]; this.cameraForward[1] = forward[1]; this.cameraForward[2] = forward[2];
    this.cameraUp[0] = up[0]; this.cameraUp[1] = up[1]; this.cameraUp[2] = up[2];
    this.fovDeg = fovDeg;
    this.near = near;
    this.far = far;
    m4ViewFromDir(pos, forward, up, this.view);
    // 供公告板类特效（敌人标记等）取用相机的右/上向量
    if (!this.cameraRight) { this.cameraRight = new Float32Array(3); }
    this.cameraRight[0] = this.view[0]; this.cameraRight[1] = this.view[4]; this.cameraRight[2] = this.view[8];
    this.cameraUp[0] = this.view[1]; this.cameraUp[1] = this.view[5]; this.cameraUp[2] = this.view[9];
    // 垂直 FOV：配置的是水平 FOV（Apex 习惯），按宽高比换算
    const hFov = toRad(fovDeg);
    const vFov = 2 * Math.atan(Math.tan(hFov * 0.5) / this.aspect);
    m4Perspective(vFov, this.aspect, near, far, this.proj);
    m4Mul(this.proj, this.view, this.viewProj);
    this.viewProjNoJitter.set(this.viewProj);
    m4FrustumPlanes(this.viewProj, this.frustum);
  }

  /** 相机滚动/俯仰抖动叠加：直接给定基向量时用这个（视图模型/晃动） */
  setCameraBasis(pos, right, up, forward, fovDeg, near, far) {
    this.cameraPos[0] = pos[0]; this.cameraPos[1] = pos[1]; this.cameraPos[2] = pos[2];
    this.cameraForward[0] = forward[0]; this.cameraForward[1] = forward[1]; this.cameraForward[2] = forward[2];
    this.cameraUp[0] = up[0]; this.cameraUp[1] = up[1]; this.cameraUp[2] = up[2];
    const m = this.view;
    m[0] = right[0]; m[1] = up[0]; m[2] = -forward[0]; m[3] = 0;
    m[4] = right[1]; m[5] = up[1]; m[6] = -forward[1]; m[7] = 0;
    m[8] = right[2]; m[9] = up[2]; m[10] = -forward[2]; m[11] = 0;
    m[12] = -(right[0] * pos[0] + right[1] * pos[1] + right[2] * pos[2]);
    m[13] = -(up[0] * pos[0] + up[1] * pos[1] + up[2] * pos[2]);
    m[14] = forward[0] * pos[0] + forward[1] * pos[1] + forward[2] * pos[2];
    m[15] = 1;
    this.fovDeg = fovDeg;
    const hFov = toRad(fovDeg);
    const vFov = 2 * Math.atan(Math.tan(hFov * 0.5) / this.aspect);
    m4Perspective(vFov, this.aspect, near, far, this.proj);
    m4Mul(this.proj, this.view, this.viewProj);
    this.viewProjNoJitter.set(this.viewProj);
    m4FrustumPlanes(this.viewProj, this.frustum);
  }

  inFrustumSphere(c, r) {
    return frustumSphereAt(this.frustum, c[0], c[1], c[2], r);
  }

  /** 用世界坐标 AABB 做剔除（中心 + 半径近似） */
  inFrustumBox(min, max, pad = 0) {
    const cx = (min[0] + max[0]) * 0.5;
    const cy = (min[1] + max[1]) * 0.5;
    const cz = (min[2] + max[2]) * 0.5;
    const r = Math.hypot(max[0] - cx, max[1] - cy, max[2] - cz) + pad;
    return frustumSphereAt(this.frustum, cx, cy, cz, r);
  }

  // ------------------------------------------------------------ 光照

  setLighting(biome) {
    this.sunDir.set(biome.sunDir || this.sunDir);
    this.sunColor.set(biome.sunColor || this.sunColor);
    this.ambient.set(biome.ambient || this.ambient);
    this.fillColor.set(biome.fill || this.fillColor);
    this.fogColor.set(biome.fogColor || this.fogColor);
    this.fogRange.set(biome.fogRange || this.fogRange);
    this.clearColor.set(biome.clearColor || this.clearColor);
    const gl = this.gl;
    gl.clearColor(this.clearColor[0], this.clearColor[1], this.clearColor[2], 1);
  }

  _setCameraUniforms(prog) {
    const gl = this.gl;
    const u = prog.uniforms;
    if (u.uViewProj) gl.uniformMatrix4fv(u.uViewProj, false, this.viewProj);
    if (u.uSunDir) gl.uniform3fv(u.uSunDir, this.sunDir);
    if (u.uSunColor) gl.uniform3fv(u.uSunColor, this.sunColor);
    if (u.uAmbient) gl.uniform3fv(u.uAmbient, this.ambient);
    if (u.uFillColor) gl.uniform3fv(u.uFillColor, this.fillColor);
    if (u.uFogColor) gl.uniform3fv(u.uFogColor, this.fogColor);
    if (u.uFogRange) gl.uniform2fv(u.uFogRange, this.fogRange);
    if (u.uCameraPos) gl.uniform3fv(u.uCameraPos, this.cameraPos);
  }

  // ------------------------------------------------------------ 网格

  createMesh(data) {
    const gl = this.gl;
    const vcount = data.positions.length / 3;
    const interleaved = new Float32Array(vcount * VS_FLOATS);
    const hasN = !!data.normals;
    const hasUv = !!data.uvs;
    for (let i = 0; i < vcount; i++) {
      const o = i * VS_FLOATS;
      interleaved[o] = data.positions[i * 3];
      interleaved[o + 1] = data.positions[i * 3 + 1];
      interleaved[o + 2] = data.positions[i * 3 + 2];
      if (hasN) {
        interleaved[o + 3] = data.normals[i * 3];
        interleaved[o + 4] = data.normals[i * 3 + 1];
        interleaved[o + 5] = data.normals[i * 3 + 2];
      } else {
        interleaved[o + 3] = 0; interleaved[o + 4] = 1; interleaved[o + 5] = 0;
      }
      if (hasUv) {
        interleaved[o + 6] = data.uvs[i * 2];
        interleaved[o + 7] = data.uvs[i * 2 + 1];
      }
    }

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, interleaved, gl.STATIC_DRAW);

    const idx32 = data.indices instanceof Uint32Array;
    const ebo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.indices, gl.STATIC_DRAW);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const stride = VS_FLOATS * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 24);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
    gl.bindVertexArray(null);

    const mesh = {
      id: ++this._meshId,
      vao,
      vbo,
      ebo,
      vertexCount: vcount,
      indexCount: data.indices.length,
      indexType: idx32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
      triangleCount: data.indices.length / 3,
      lodLevels: null,
      name: data.name || 'mesh',
      bounds: computeBounds(data.positions),
    };
    this._meshes.push(mesh);
    return mesh;
  }

  destroyMesh(mesh) {
    if (!mesh) return;
    const gl = this.gl;
    gl.deleteVertexArray(mesh.vao);
    gl.deleteBuffer(mesh.vbo);
    gl.deleteBuffer(mesh.ebo);
    const i = this._meshes.indexOf(mesh);
    if (i >= 0) this._meshes.splice(i, 1);
  }

  /** 从 GLTF 图元创建网格（导入模型通道用） */
  createMeshFromGLTF(prim) {
    return this.createMesh({
      positions: prim.positions,
      normals: prim.normals,
      uvs: prim.uvs,
      indices: prim.indices instanceof Uint32Array ? prim.indices : new Uint32Array(prim.indices),
      name: prim.name || 'gltf',
    });
  }

  // ------------------------------------------------------------ 绘制 API

  _allocInstances(count) {
    const need = this._stagingCursor + count * FLOATS_PER_INSTANCE;
    if (need > this._staging.length) {
      let cap = this._staging.length;
      while (cap < need) cap *= 2;
      const next = new Float32Array(cap);
      next.set(this._staging.subarray(0, this._stagingCursor));
      this._staging = next;
    }
    const off = this._stagingCursor;
    this._stagingCursor = need;
    return off;
  }

  /**
   * 预留 N 个连续实例槽位，返回起始 float 偏移。
   * 由粒子/弹道等批量渲染使用，保证批次区间连续。
   */
  reserveInstances(count) {
    return this._allocInstances(count);
  }

  /** 直接写入 staging（配合 reserveInstances 使用） */
  get staging() { return this._staging; }

  /** 向指定批次追加 count 个实例占位，返回可写的起始偏移 */
  reserveInBatch(mesh, count, opts) {
    if (!mesh || count <= 0) return -1;
    const progName = opts?.program === 'additive' ? 'additive' : (opts && opts.unlit ? 'unlit' : 'lit');
    const noDepthTest = !!(opts && opts.noDepthTest);
    const b = this.drawList.begin(mesh, progName,
      opts ? opts.depthWrite !== false : true,
      opts ? opts.cull !== false : true,
      noDepthTest);
    if (b.count === 0) b.offset = this._stagingCursor;
    const end = b.offset + b.count * FLOATS_PER_INSTANCE + count * FLOATS_PER_INSTANCE;
    if (end > this._stagingCursor) this._stagingCursor = end;
    if (this._stagingCursor > this._staging.length) {
      let cap = this._staging.length;
      while (cap < this._stagingCursor) cap *= 2;
      const next = new Float32Array(cap);
      next.set(this._staging.subarray(0, Math.min(this._staging.length, cap)));
      this._staging = next;
    }
    const off = b.offset + b.count * FLOATS_PER_INSTANCE;
    b.count += count;
    return off;
  }

  /**
   * 绘制单个网格实例。
   * opts: { color:[r,g,b,a], unlit:boolean, emissive:number, cull:boolean, depthWrite:boolean }
   * 实现上复用 drawInstanced 的连续分配逻辑，避免实例数据在 staging 中被打散。
   */
  drawMesh(mesh, modelMatrix, opts) {
    if (!mesh) return;
    const scratch = this._singleScratch || (this._singleScratch = new Float32Array(16));
    scratch.set(modelMatrix);
    this.drawInstanced(mesh, scratch, 1, opts);
  }

  /**
   * 批量绘制同一网格的多个实例（推荐路径，单次调用）。
   * modelMatrices: Float32Array(N*16)；opts.colors: Float32Array(N*4) 可为 null。
   */
  drawInstanced(mesh, modelMatrices, count, opts) {
    if (!mesh || count <= 0) return;
    const progName = opts && opts.unlit ? 'unlit' : 'lit';
    const noDepthTest = !!(opts && opts.noDepthTest);
    const b = this.drawList.begin(mesh, progName,
      opts ? opts.depthWrite !== false : true,
      opts ? opts.cull !== false : true,
      noDepthTest);
    if (b.count === 0) b.offset = this._stagingCursor;
    const addFloats = count * FLOATS_PER_INSTANCE;
    const end = b.offset + b.count * FLOATS_PER_INSTANCE + addFloats;
    if (end > this._stagingCursor) this._stagingCursor = end;
    if (this._stagingCursor > this._staging.length) {
      let cap = this._staging.length;
      while (cap < this._stagingCursor) cap *= 2;
      const next = new Float32Array(cap);
      next.set(this._staging.subarray(0, Math.min(this._staging.length, cap)));
      this._staging = next;
    }
    const colors = opts && opts.colors ? opts.colors : null;
    const baseColor = (opts && opts.color) || WHITE4;
    const emissive = (opts && opts.emissive) || 0;
    const er = emissive * 0.9, eg = emissive * 0.75, eb = emissive * 0.5;
    const st = this._staging;
    let off = b.offset + b.count * FLOATS_PER_INSTANCE;
    for (let i = 0; i < count; i++) {
      const mo = i * 16;
      st[off] = modelMatrices[mo]; st[off + 1] = modelMatrices[mo + 1];
      st[off + 2] = modelMatrices[mo + 2]; st[off + 3] = modelMatrices[mo + 3];
      st[off + 4] = modelMatrices[mo + 4]; st[off + 5] = modelMatrices[mo + 5];
      st[off + 6] = modelMatrices[mo + 6]; st[off + 7] = modelMatrices[mo + 7];
      st[off + 8] = modelMatrices[mo + 8]; st[off + 9] = modelMatrices[mo + 9];
      st[off + 10] = modelMatrices[mo + 10]; st[off + 11] = modelMatrices[mo + 11];
      st[off + 12] = modelMatrices[mo + 12]; st[off + 13] = modelMatrices[mo + 13];
      st[off + 14] = modelMatrices[mo + 14]; st[off + 15] = modelMatrices[mo + 15];
      if (colors) {
        const co = i * 4;
        st[off + 16] = colors[co] + er;
        st[off + 17] = colors[co + 1] + eg;
        st[off + 18] = colors[co + 2] + eb;
        st[off + 19] = colors[co + 3];
      } else {
        st[off + 16] = baseColor[0] + er;
        st[off + 17] = baseColor[1] + eg;
        st[off + 18] = baseColor[2] + eb;
        st[off + 19] = baseColor.length > 3 ? baseColor[3] : 1;
      }
      off += FLOATS_PER_INSTANCE;
    }
    b.count += count;
  }

  /**
   * 复用型动态实例缓冲：调用方持有一个 Float32Array，填入 N 个矩阵后一次性提交。
   * 返回缓冲对象（按需增长），供粒子/弹道系统零分配使用。
   */
  getInstanceBuffer(capacity) {
    if (!this._sharedModelBuf || this._sharedModelBuf.length < capacity * 16) {
      this._sharedModelBuf = new Float32Array(Math.max(capacity * 16, 256));
    }
    return this._sharedModelBuf;
  }

  // ------------------------------------------------------------ 调试线

  /** 追加一条线段到延迟绘制队列（在 endFrame 中绘制） */
  drawLine(a, b, color) {
    if (this._lineCount >= 4096) return;
    const i = this._lineCount * 6;
    this._lineCpu[i] = a[0]; this._lineCpu[i + 1] = a[1]; this._lineCpu[i + 2] = a[2];
    this._lineCpu[i + 3] = b[0]; this._lineCpu[i + 4] = b[1]; this._lineCpu[i + 5] = b[2];
    this._lineColorCpu[i] = color[0]; this._lineColorCpu[i + 1] = color[1]; this._lineColorCpu[i + 2] = color[2];
    this._lineColorCpu[i + 3] = color[0]; this._lineColorCpu[i + 4] = color[1]; this._lineColorCpu[i + 5] = color[2];
    this._lineCount++;
  }

  drawLines(vertices, colors, count) {
    for (let i = 0; i < count; i++) {
      const p = i * 6;
      const a = [vertices[p], vertices[p + 1], vertices[p + 2]];
      const b = [vertices[p + 3], vertices[p + 4], vertices[p + 5]];
      const c = [colors[i * 6], colors[i * 6 + 1], colors[i * 6 + 2]];
      this.drawLine(a, b, c);
    }
  }

  /** 画一个线框盒（调试碰撞体） */
  drawWireBox(min, max, color) {
    const c = [
      [min[0], min[1], min[2]], [max[0], min[1], min[2]], [max[0], min[1], max[2]], [min[0], min[1], max[2]],
      [min[0], max[1], min[2]], [max[0], max[1], min[2]], [max[0], max[1], max[2]], [min[0], max[1], max[2]],
    ];
    const e = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    for (const [i, j] of e) this.drawLine(c[i], c[j], color);
  }

  _drawLines() {
    const gl = this.gl;
    const prog = this._programs.line;
    gl.useProgram(prog.program);
    if (prog.uniforms.uViewProj) gl.uniformMatrix4fv(prog.uniforms.uViewProj, false, this.viewProj);
    // 填充持久化交错缓冲（pos3 + color3，每顶点 24 字节）
    const inter = this._lineInterleaved;
    for (let i = 0; i < this._lineCount; i++) {
      const s = i * 6, d = i * 12;
      inter[d] = this._lineCpu[s]; inter[d + 1] = this._lineCpu[s + 1]; inter[d + 2] = this._lineCpu[s + 2];
      inter[d + 3] = this._lineColorCpu[s]; inter[d + 4] = this._lineColorCpu[s + 1]; inter[d + 5] = this._lineColorCpu[s + 2];
      inter[d + 6] = this._lineCpu[s + 3]; inter[d + 7] = this._lineCpu[s + 4]; inter[d + 8] = this._lineCpu[s + 5];
      inter[d + 9] = this._lineColorCpu[s + 3]; inter[d + 10] = this._lineColorCpu[s + 4]; inter[d + 11] = this._lineColorCpu[s + 5];
    }
    gl.bindVertexArray(this._lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._lineVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, inter, 0, this._lineCount * 12);
    gl.disable(gl.CULL_FACE);
    gl.drawArrays(gl.LINES, 0, this._lineCount * 2);
    gl.bindVertexArray(null);
    this.stats.drawCalls++;
  }

  // ------------------------------------------------------------ 深度清除（视图模型）

  clearDepthOnly() {
    const gl = this.gl;
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
  }

  /** 清屏（用于视图模型之前的深度重置） */
  setClearColor(c) {
    this.clearColor[0] = c[0]; this.clearColor[1] = c[1];
    this.clearColor[2] = c[2]; this.clearColor[3] = c.length > 3 ? c[3] : 1;
    const gl = this.gl;
    gl.clearColor(this.clearColor[0], this.clearColor[1], this.clearColor[2], 1);
  }

  getInfo() {
    return {
      gpu: this.gpuInfo,
      caps: this.caps,
      meshCount: this._meshes.length,
      programs: this.programNames,
    };
  }
}

const WHITE4 = new Float32Array([1, 1, 1, 1]);

function computeBounds(positions) {
  const min = new Float32Array([Infinity, Infinity, Infinity]);
  const max = new Float32Array([-Infinity, -Infinity, -Infinity]);
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  if (!isFinite(min[0])) { min.fill(0); max.fill(0); }
  return { min, max };
}

export default Engine;
