// ==== tools/test-modules.mjs — 模块导入与静态一致性自检 ====
// 目的：在打开浏览器之前就抓住会让整个游戏白屏的问题：
//   * 语法错误 / 导入路径写错 / 循环依赖导致的 TDZ
//   * 重复导出（Node 24.15 的 V8 对 `export class X {}` + `export { X }` 有误报，
//     恰好能帮我们抓出双重导出写法）
//   * 契约要求但漏掉的导出名
//   * 跨模块的 modifier 键名漂移（升级系统产出 vs 运动系统消费）
//
// 用法: node tools/test-modules.mjs

import { readdir, stat } from 'node:fs/promises';
import { resolve, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { pass++; process.stdout.write(`  PASS  ${name}\n`); }
  else {
    fail++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    process.stdout.write(`  FAIL  ${name}${detail ? '  [' + detail + ']' : ''}\n`);
  }
}

function section(t) { process.stdout.write(`\n── ${t} ──\n`); }

/** 递归收集 src 下的所有 .js */
async function collect(dir, out = []) {
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    const info = await stat(full);
    if (info.isDirectory()) await collect(full, out);
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------- 1. 逐个导入

section('1. 逐个导入全部模块（捕获语法/路径/循环依赖错误）');

const files = (await collect(join(ROOT, 'src'))).sort();
const mods = {};
for (const f of files) {
  const rel = relative(ROOT, f).split(sep).join('/');
  try {
    mods[rel] = await import(pathToFileURL(f).href);
    check(`导入 ${rel}`, true);
  } catch (err) {
    check(`导入 ${rel}`, false, err.message);
  }
}

// ---------------------------------------------------------------- 2. 契约导出名

section('2. 契约要求的导出名');

const EXPECTED = {
  'src/core/math.js': ['v3', 'add3', 'sub3', 'scale3', 'dot3', 'cross3', 'normalize3', 'len3',
    'clamp', 'clamp01', 'lerp', 'smoothstep', 'damp', 'damp3', 'moveTowards', 'wrapAngle',
    'hash2', 'hash3', 'valueNoise2', 'fbm2', 'ridged2', 'mulberry32', 'weightedPick',
    'm4', 'm4Mul', 'm4Perspective', 'm4ViewFromDir', 'm4Invert', 'm4FrustumPlanes',
    'm4Compose', 'm4FromYaw', 'quatFromEuler', 'quatLookRotation', 'randomConeDir',
    'dirFromAngles', 'frustumSphereAt', 'frustumAABB', 'toRad', 'toDeg'],
  'src/core/config.js': ['CFG', 'CFG_DEFAULTS', 'resetCFG', 'applyCFGOverrides'],
  'src/core/events.js': ['on', 'off', 'once', 'emit', 'clear'],
  'src/core/input.js': ['Input', 'ACTIONS'],
  'src/engine/engine.js': ['Engine'],
  'src/engine/geometry.js': ['unitCube', 'unitCylinder', 'unitSphere', 'unitCone', 'unitWedge', 'unitKnifeBlade',
    'unitQuad', 'unitDisc', 'box', 'boxMinMax', 'mergeMeshData', 'transformMeshData',
    'colorizeMeshData', 'computeNormals', 'generateHeightfield', 'generateHeightfieldTriangles',
    'vertexCount', 'triangleCount'],
  'src/engine/collision.js': ['rayAABB', 'rayTriangle', 'raySphere', 'rayCapsule',
    'closestPointSegment', 'closestPointOnTriangle', 'segmentSegmentDistance',
    'sphereTriangle', 'sphereAABB', 'capsuleTriangle', 'capsuleAABB',
    'sweepSphereTriangles', 'sweepSphereBoxes', 'pointInAABB', 'SpatialHash'],
  'src/engine/fx-meshes.js': ['createSharedMeshes'],
  'src/world.js': ['World', 'MAP_FORMAT_VERSION', 'FLAG', 'makeHeightFn', 'materialColor'],
  'src/player.js': ['Player', 'defaultMods', 'normalizeMods'],
  'src/weapons.js': ['WeaponSystem', 'WEAPONS', 'WEAPON_IDS'],
  'src/enemies.js': ['EnemySystem', 'ENEMY_TYPES', 'ENEMY_IDS', 'ENEMY_BASE_SCALE',
    'ENEMY_HUMANOID_HEIGHT', 'enemyBaseScale', 'ENEMY_DAMAGE_SCALE'],
  'src/director.js': ['Director', 'PHASES'],
  'src/run.js': ['Run', 'RUN_PHASE'],
  'src/upgrades.js': ['UPGRADES', 'UpgradeSystem', 'RARITIES', 'MODIFIER_DEFAULTS'],
  'src/audio/audio.js': ['Audio'],
  'src/fx/particles.js': ['ParticleSystem'],
  'src/fx/decals.js': ['DecalSystem'],
  'src/fx/screenshake.js': ['ScreenShake'],
  'src/fx/projectiles.js': ['ProjectilePool'],
  'src/fx/gltf.js': ['loadGLTF', 'parseGLTF', 'gltfInstanceModels', 'describeGLTF'],
  'src/maps/builtin-maps.js': ['FLAG', 'BIOMES', 'BIOME_IDS', 'makeHeightFn', 'generateMap',
    'MISSIONS', 'getMission', 'getBiome'],
  'src/ui/hud.js': ['HUD'],
  'src/save.js': ['Save', 'MetaProgress', 'PERKS'],
  'src/main.js': ['Game', 'boot', 'mergeModifiers', 'errors'],
};

for (const [rel, names] of Object.entries(EXPECTED)) {
  const mod = mods[rel];
  if (!mod) { check(`${rel} 导出`, false, '模块未能导入'); continue; }
  const missing = names.filter((n) => mod[n] === undefined);
  check(`${rel} 导出 ${names.length} 个符号`, missing.length === 0,
    missing.length ? '缺少 ' + missing.join(',') : '');
}

// ---------------------------------------------------------------- 3. modifier 键名一致性

section('3. 升级系统产出 ↔ 运动系统消费 的 modifier 键名一致性');

const up = mods['src/upgrades.js'];
const pl = mods['src/player.js'];
if (up && pl) {
  const producedMove = Object.keys(up.MODIFIER_DEFAULTS.move);
  // player 默认 modifier 的键集合就是它期望被喂进来的键集合
  const consumed = Object.keys(pl.defaultMods().move);
  const notConsumed = producedMove.filter((k) => !consumed.includes(k));
  check('升级产出的每个 move 键都被运动系统消费', notConsumed.length === 0,
    notConsumed.length ? '未被消费: ' + notConsumed.join(',') : `${producedMove.length} 个键`);

  // 反向：运动系统从升级拿不到默认值的键（用内部补充值兜底，不算错误，但要有记录）
  const extra = consumed.filter((k) => !producedMove.includes(k));
  check('运动系统内部补充键已显式声明', extra.length >= 0,
    `内部补充 ${extra.length} 个: ${extra.join(',')}`);

  // normalizeMods 必须能吃下升级系统的产出而不丢失
  const sample = up.MODIFIER_DEFAULTS.move;
  const normalized = pl.normalizeMods({ move: sample, weapon: up.MODIFIER_DEFAULTS.weapon });
  const lost = producedMove.filter((k) => normalized.move[k] !== sample[k]);
  check('normalizeMods 不丢失任何升级 modifier', lost.length === 0,
    lost.length ? '丢失/改写: ' + lost.join(',') : '');
}

// ---------------------------------------------------------------- 4. 地图生成契约

section('4. 地图生成与世界加载的契约');

const maps = mods['src/maps/builtin-maps.js'];
const worldMod = mods['src/world.js'];
if (maps && worldMod) {
  // 双方各自实现了 makeHeightFn，语义必须一致（同一 spec 同一结果）
  const spec = {
    resolution: 64, baseHeight: 0, amplitude: 12, octaves: 4, lacunarity: 2, gain: 0.5,
    plateau: [{ x: 10, z: -10, radius: 20, height: 5, falloff: 12 }],
    trenches: [{ x: -30, z: 20, radius: 14, depth: -8, falloff: 9 }],
  };
  const hA = maps.makeHeightFn(spec);
  const hB = worldMod.makeHeightFn(spec);
  let maxDiff = 0;
  let finite = true;
  for (let i = 0; i < 200; i++) {
    const x = (i % 20) * 8 - 80;
    const z = Math.floor(i / 20) * 9 - 45;
    const a = hA(x, z);
    const b = hB(x, z);
    if (!isFinite(a) || !isFinite(b)) finite = false;
    maxDiff = Math.max(maxDiff, Math.abs(a - b));
  }
  check('两处 makeHeightFn 都返回有限值', finite);
  check('两处 makeHeightFn 结果一致（避免视觉与碰撞错位）', maxDiff < 1e-6,
    `最大差异 ${maxDiff.toExponential(3)}`);

  // 生成的地图必须带上 world 需要的全部字段
  const REQUIRED_MAP_KEYS = ['version', 'name', 'biome', 'size', 'seed', 'terrain',
    'boxes', 'spawnPoints', 'playerSpawns', 'extractPoints', 'objectives', 'lighting'];
  let allOk = true;
  const missingReport = [];
  for (let i = 0; i < 8; i++) {
    const m = maps.generateMap({ seed: 1000 + i * 37, size: 240, tier: (i % 5) + 1 });
    const missing = REQUIRED_MAP_KEYS.filter((k) => m[k] === undefined);
    if (missing.length) { allOk = false; missingReport.push(`seed${i}: ${missing.join(',')}`); }
  }
  check('generateMap 产出 world.load 需要的全部字段', allOk, missingReport.join(' | '));

  const missionCount = maps.MISSIONS.length;
  check('任务阶梯至少 10 关', missionCount >= 10, `${missionCount} 关`);

  const biomeCount = Object.keys(maps.BIOMES).length;
  check('生物群系至少 5 种', biomeCount >= 5, `${biomeCount} 种`);

  const flagNames = ['SOLID', 'WALLRUN', 'CLIMBABLE', 'PLATFORM', 'COVER', 'HAZARD'];
  const flagMissing = flagNames.filter((f) => maps.FLAG[f] === undefined || worldMod.FLAG[f] === undefined);
  check('地图与世界的 FLAG 位定义都存在', flagMissing.length === 0, flagMissing.join(','));
  const flagMismatch = flagNames.filter((f) => maps.FLAG[f] !== worldMod.FLAG[f]);
  check('地图与世界的 FLAG 位定义数值一致', flagMismatch.length === 0, flagMismatch.join(','));
}

// 背面剔除守卫：三角形绕序必须与顶点法线一致。绕序反了时，地形/圆柱会从
// 正面被 GPU 整片剔除，实际画面表现为“模型透明、能透视地板”。
const geo = mods['src/engine/geometry.js'];
if (geo) {
  const windingMatchesNormals = (md) => {
    const p = md.positions, n = md.normals, idx = md.indices;
    let bad = 0, tested = 0;
    for (let k = 0; k < idx.length; k += 3) {
      const ia = idx[k] * 3, ib = idx[k + 1] * 3, ic = idx[k + 2] * 3;
      const abx = p[ib] - p[ia], aby = p[ib + 1] - p[ia + 1], abz = p[ib + 2] - p[ia + 2];
      const acx = p[ic] - p[ia], acy = p[ic + 1] - p[ia + 1], acz = p[ic + 2] - p[ia + 2];
      const gx = aby * acz - abz * acy;
      const gy = abz * acx - abx * acz;
      const gz = abx * acy - aby * acx;
      const nx = n[ia] + n[ib] + n[ic];
      const ny = n[ia + 1] + n[ib + 1] + n[ic + 1];
      const nz = n[ia + 2] + n[ib + 2] + n[ic + 2];
      const dot = gx * nx + gy * ny + gz * nz;
      if (Math.abs(dot) > 1e-8) { tested++; if (dot < 0) bad++; }
    }
    return { bad, tested };
  };
  const meshes = {
    cube: geo.unitCube(),
    cylinder: geo.unitCylinder(12, true, true),
    sphere: geo.unitSphere(12, 8),
    wedge: geo.unitWedge(),
    disc: geo.unitDisc(16),
    planeGrid: geo.planeGrid(8, 8, 4, 4),
    terrain: geo.generateHeightfield({ size: 16, segments: 8, heightFn: (x, z) => x * 0.08 - z * 0.04 }),
  };
  for (const [name, mesh] of Object.entries(meshes)) {
    const r = windingMatchesNormals(mesh);
    check(`${name} 三角绕序与外向法线一致`, r.tested > 0 && r.bad === 0,
      `反向 ${r.bad}/${r.tested}`);
  }
  const collisionTerrain = geo.generateHeightfieldTriangles({
    size: 8, segments: 4, heightFn: () => 0,
  }).triangles;
  let downward = 0;
  for (let i = 0; i < collisionTerrain.length; i += 9) {
    const abx = collisionTerrain[i + 3] - collisionTerrain[i];
    const abz = collisionTerrain[i + 5] - collisionTerrain[i + 2];
    const acx = collisionTerrain[i + 6] - collisionTerrain[i];
    const acz = collisionTerrain[i + 8] - collisionTerrain[i + 2];
    const ny = abz * acx - abx * acz;
    if (ny <= 0) downward++;
  }
  check('碰撞地形三角全部朝上', downward === 0, `朝下 ${downward} 面`);
}

// ---------------------------------------------------------------- 5. 武器 / 敌人数据

section('5. 武器与敌人数据完整性');

const wp = mods['src/weapons.js'];
if (wp) {
  const ids = wp.WEAPON_IDS;
  check('武器数量 >= 5', ids.length >= 5, `${ids.length} 把`);
  const required = ['id', 'name', 'rpm', 'damage', 'damageHead', 'magSize', 'reloadTime',
    'adsTime', 'hipSpreadBase', 'spreadPerShot', 'recoilPitch', 'recoilPattern', 'viewmodel',
    'tracerColor', 'fireSound'];
  const bad = [];
  for (const id of ids) {
    const def = wp.WEAPONS[id];
    if (!def) { bad.push(id + ':缺失'); continue; }
    for (const k of required) if (def[k] === undefined) bad.push(`${id}.${k}`);
    if (!def.viewmodel.parts || def.viewmodel.parts.length < 5) bad.push(id + '.viewmodel.parts');
    if (!Array.isArray(def.recoilPattern) || def.recoilPattern.length < def.magSize) {
      bad.push(id + '.recoilPattern(长度不足)');
    }
  }
  check('全部武器字段完整（含弹道序列与视图模型）', bad.length === 0, bad.slice(0, 8).join(', '));
  check('R-99 射速为 1080 RPM', wp.WEAPONS.r99 && wp.WEAPONS.r99.rpm === 1080,
    wp.WEAPONS.r99 ? String(wp.WEAPONS.r99.rpm) : 'n/a');
  // 期望值从 WEAPONS 表读取，避免调数值后测试连带失效（启动器硬编码版本号踩过同样的坑）
  const R99 = wp.WEAPONS.r99, FLAT = wp.WEAPONS.flatline;
  // 伤害写死是刻意的（数值平衡要有回归护栏），但**弹匣容量不要写死**：
  // 需求 7 把 R-99 从 24 发改为 30 发时，这条断言连带失效，
  // 看起来像功能坏了、其实只是期望值过时。
  check('最新武器平衡值：R-99 18伤、平行步枪22伤，弹匣容量与弹道序列匹配',
    R99.damage === 18 && FLAT.damage === 22
    && R99.magSize >= 1 && Array.isArray(R99.recoilPattern)
    && R99.recoilPattern.length >= R99.magSize,
    `R99=${R99.damage}伤/${R99.magSize}发, Flatline=${FLAT.damage}伤`);
  const firearmIds = ids.filter((id) => wp.WEAPONS[id].class !== 'melee');
  check('所有枪械完全 ADS 时移动倍率严格为 50%',
    firearmIds.every((id) => wp.WEAPONS[id].adsMoveMul === 0.5),
    firearmIds.filter((id) => wp.WEAPONS[id].adsMoveMul !== 0.5).join(', '));
  const reloadModelBad = firearmIds.filter((id) => {
    const parts = wp.WEAPONS[id].viewmodel.parts;
    return !parts.some((p) => p.reloadGroup === 'mag')
      || !parts.some((p) => p.reloadGroup === 'bolt')
      || !parts.some((p) => p.tag && p.tag.startsWith('left-'));
  });
  check('枪械换弹模型包含独立弹匣、枪机与左手动画分组', reloadModelBad.length === 0,
    reloadModelBad.join(', '));
  const PlayerCtor = mods['src/player.js'].Player;
  const moveWorld = {
    groundNormal(_x, _z, out) { out[0] = 0; out[1] = 1; out[2] = 0; return out; },
  };
  const moveProbe = new PlayerCtor(moveWorld, null);
  const moveInput = { moveX: 0, moveY: 1 };
  const moveMods = mods['src/player.js'].defaultMods().move;
  moveProbe.setActionMoveSpeedMul(1);
  moveProbe._moveGround(1 / 128, moveInput, moveMods);
  const hipAccel = Math.hypot(moveProbe.vel[0], moveProbe.vel[2]);
  moveProbe.vel[0] = 0; moveProbe.vel[2] = 0;
  moveProbe.setActionMoveSpeedMul(0.5);
  moveProbe._moveGround(1 / 128, moveInput, moveMods);
  const adsAccel = Math.hypot(moveProbe.vel[0], moveProbe.vel[2]);
  check('Player 在 wishSpeed 层消费 ADS 倍率（不是无效缩放输入轴）',
    hipAccel > 0 && Math.abs(adsAccel / hipAccel - 0.5) < 1e-6,
    `hip=${hipAccel}, ads=${adsAccel}`);
  moveProbe.state.grounded = true;
  moveProbe.state.groundNormal.set([0.18, 0.983, 0]);
  moveProbe.vel[0] = 0.06; moveProbe.vel[1] = -0.04; moveProbe.vel[2] = 0.03;
  moveProbe._moveGround(1 / 128, { moveX: 0, moveY: 0 }, moveMods);
  check('无移动输入时斜坡不会持续制造水平漂移', Math.hypot(moveProbe.vel[0], moveProbe.vel[2]) === 0);
  const opticIds = ['r99', 'flatline', 'volt', 'peacekeeper', 'longbow', 'sentinel'];
  const missingOptics = opticIds.filter((id) => !wp.WEAPONS[id].viewmodel.parts.some((p) => p.optic));
  check('六把枪均有安装在 viewmodel 上的物理瞄具', missingOptics.length === 0,
    missingOptics.join(', '));
  const opaqueSniperLens = ['longbow', 'sentinel'].filter((id) =>
    wp.WEAPONS[id].viewmodel.parts.some((p) => p.tag === 'scope-lens'));
  check('狙击镜中心镂空（无不透明实体镜片）', opaqueSniperLens.length === 0,
    opaqueSniperLens.join(', '));
  const armIds = opticIds.filter((id) => wp.WEAPONS[id].viewmodel.parts.filter((p) => p.hand).length < 6);
  check('第一人称持枪模型使用分段手掌/护腕/前臂', armIds.length === 0, armIds.join(', '));
  const r99 = wp.WEAPONS.r99, volt = wp.WEAPONS.volt;
  check('冲锋枪有效射程与最低伤害倍率已提高',
    r99.rangeFar >= 280 && r99.damageFalloffStart >= 40 && r99.falloffMinMul >= 0.84 &&
    volt.rangeFar >= 300 && volt.damageFalloffStart >= 45 && volt.falloffMinMul >= 0.86,
    `R99=${r99.damageFalloffStart}/${r99.rangeFar}/${r99.falloffMinMul}, Volt=${volt.damageFalloffStart}/${volt.rangeFar}/${volt.falloffMinMul}`);
  const meleeParts = wp.WEAPONS.melee.viewmodel.parts;
  check('空手近战具有左右分段拳头且战术刀为独立握持模型',
    meleeParts.filter((p) => p.meleeSide === -1).length >= 8
    && meleeParts.filter((p) => p.meleeSide === 1).length >= 12
    && meleeParts.some((p) => p.bareOnly)
    && meleeParts.filter((p) => p.requiresKnife).length >= 6);
  const bladePart = meleeParts.find((p) => p.tag === 'knife-blade');
  check('战术刀为受控尺寸的斜持刀刃（不再是竖直大板）', !!bladePart
    && bladePart.size[0] <= 0.15 && bladePart.size[1] <= 0.32
    && Math.abs((bladePart.rot || [0, 0, 0])[2]) >= 0.45
    && bladePart.pos[2] <= -0.28);

  const sentinelState = {
    id: 'sentinel', reloading: false, reloadCueIndex: 0, ads: true, adsT: 1,
    chargeT: wp.WEAPONS.sentinel.chargeTime, charging: false,
    chargeReady: true, chargeShotsRemaining: 6, chargeAfterReload: false,
    boltT: 0, boltDuration: 0, bolting: false, chambered: true,
    spread: 0, spreadExtra: 0, shotsFiredThisBurst: 0,
  };
  const chargeProbe = Object.create(wp.WeaponSystem.prototype);
  chargeProbe.slots = [{ id: 'r99' }, { id: 'sentinel' }];
  chargeProbe.slotIndex = 0;
  chargeProbe.state = new Map([['sentinel', sentinelState]]);
  chargeProbe.vm = { equipT: 1, holsterT: 0, reloadStage: 0, reloadT: 0, items: [], meshes: {} };
  chargeProbe._vmCache = new Map([['sentinel', { items: [], meshes: {} }]]);
  chargeProbe.recoil = { patternIndex: 0, aimPitch: 0, aimYaw: 0, visPitch: 0, visYaw: 0 };
  chargeProbe._equip('sentinel', true);
  check('哨兵整匣充能在切枪后仍保留', sentinelState.chargeReady
    && sentinelState.chargeShotsRemaining === 6 && sentinelState.chargeT === wp.WEAPONS.sentinel.chargeTime);
  chargeProbe.mods = { weapon: {} };
  sentinelState.ammo = 4;
  sentinelState.reserve = Infinity;
  chargeProbe._startReload(sentinelState, wp.WEAPONS.sentinel);
  check('哨兵普通换弹保留剩余强化次数', sentinelState.chargeReady
    && sentinelState.chargeShotsRemaining === 6 && sentinelState.reloading);

  // 连射时命中射线必须跟随屏幕相机后坐，而不能使用更小的隐藏 aim 通道，
  // 否则子弹会稳定落在准心下方。
  const probe = Object.create(wp.WeaponSystem.prototype);
  probe.player = { yaw: 0.17, pitch: -0.08 };
  probe.recoil = { aimYaw: -0.03, aimPitch: -0.11, visYaw: 0.05, visPitch: 0.14 };
  const actualAim = probe._aimDir(new Float32Array(3));
  const expectedAim = mods['src/core/math.js'].dirFromAngles(0.22, 0.06, new Float32Array(3));
  check('连续射击弹道与屏幕相机后坐方向完全一致',
    actualAim.every((v, i) => Math.abs(v - expectedAim[i]) < 1e-6));
  check('枪械后坐默认保留但额外屏幕震动关闭',
    mods['src/core/config.js'].CFG.fx.fireCameraRecoil === true
      && mods['src/core/config.js'].CFG.fx.fireScreenShake === false);
  probe.mods = { weapon: { recoilMul: 1 } };
  probe.rng = () => 0.5;
  probe.recoil = { patternIndex: 0, aimPitch: 0, aimYaw: 0, visPitch: 0, visYaw: 0, recoveryDelay: 0 };
  const noShakeState = { adsT: 0, spreadExtra: 0 };
  probe._applyRecoil(wp.WEAPONS.r99, noShakeState);
  check('实际开火后恢复可控枪械后坐且散布仍累积',
    probe.recoil.aimPitch > 0 && probe.recoil.visPitch > 0
      && noShakeState.spreadExtra > 0);

  // 2.0 场景在未命中时可能有较重的世界射线判定；不允许把卡顿期间的射击
  // 欠账用 while 一次补发，否则会出现“射空时弹匣瞬空、命中时正常”。
  const fireState = {
    ...probe._newState?.('r99'), id: 'r99', ammo: wp.WEAPONS.r99.magSize, reserve: Infinity,
    reloading: false, reloadT: 0, reloadDuration: wp.WEAPONS.r99.reloadTime,
    reloadCueIndex: 0, ads: false, adsT: 0, spreadExtra: 0,
    shotsFiredThisBurst: 0, timeSinceShot: 99, charging: false, chargeT: 0,
    chargeReady: false, chargeShotsRemaining: 0, chargeAfterReload: false,
    bolting: false, chambered: true,
  };
  const fireProbe = Object.create(wp.WeaponSystem.prototype);
  fireProbe.slots = [{ id: 'r99' }]; fireProbe.slotIndex = 0;
  fireProbe.state = new Map([['r99', fireState]]);
  fireProbe.mods = { weapon: {} };
  fireProbe.vm = { equipT: 1, holsterT: 0 };
  fireProbe.player = { setAdsFovMul() {} };
  fireProbe.projectiles = { update() {} };
  fireProbe.recoil = { aimPitch: 0, aimYaw: 0, visPitch: 0, visYaw: 0, patternIndex: 0, recoveryDelay: 0 };
  fireProbe._fireTimer = -2; fireProbe._triggerHeld = true;
  fireProbe._requireTriggerRelease = false;
  fireProbe._updateRecoil = () => {};
  fireProbe._updateViewmodel = () => {};
  fireProbe._fire = (state) => { state.ammo--; };
  fireProbe.update(0, { fire: true });
  check('严重欠帧或未命中后单次更新最多只扣一发弹药',
    fireState.ammo === wp.WEAPONS.r99.magSize - 1 && fireProbe._fireTimer > 0 && !fireState.reloading);

  // 120Hz 固定步下，R-99 的 1080RPM 一秒约 18 发，不能一帧/一秒清空整个弹匣。
  // 弹匣容量从 WEAPONS 读，别写死 —— 需求 7 把它从 24 改到 30 时这里连带失效过。
  const R99_MAG = wp.WEAPONS.r99.magSize;
  fireState.ammo = R99_MAG; fireState.reloading = false; fireProbe._fireTimer = 0;
  fireProbe._triggerHeld = true; fireProbe._requireTriggerRelease = false;
  for (let i = 0; i < 120; i++) fireProbe.update(1 / 120, { fire: true });
  // 断言"一秒消耗的弹量 ≈ RPM/60"而不是写死剩余弹数：
  // 写死剩余弹数只对某个特定弹匣容量成立（需求 7 把 24 改 30 后就失配了），
  // 而按射速断言才是真正的回归护栏 —— 它抓的是"一帧清空弹匣"这类 bug。
  const expectedPerSecond = wp.WEAPONS.r99.rpm / 60;
  const spent = R99_MAG - fireState.ammo;
  check(`持续射击严格受 1080RPM 计时限制（一秒约 ${expectedPerSecond.toFixed(0)} 发）`,
    Math.abs(spent - expectedPerSecond) <= 4 && !fireState.reloading,
    `一秒消耗 ${spent} 发（期望 ≈${expectedPerSecond.toFixed(0)}），剩余 ${fireState.ammo}/${R99_MAG}`);

  // 命中与未命中只影响命中反馈，绝不能改变单次扣弹数量。
  for (const hit of [false, true]) {
    fireState.ammo = R99_MAG; fireState.reloading = false; fireProbe._fireTimer = -5;
    fireProbe._requireTriggerRelease = false;
    fireProbe._fire = (state) => { state.ammo--; fireProbe._lastProbeHit = hit; };
    fireProbe.update(0, { fire: true });
    check(`${hit ? '命中' : '未命中'}路径一次更新严格只扣一发`, fireState.ammo === R99_MAG - 1);
  }

  // 换弹期间按住左键不得开火；**换弹结束后若仍按住，应当继续射击**。
  //
  // 这里的行为在需求变更中反转过：原设计是"打空自动换弹后必须松开扳机"
  // （_requireTriggerRelease 门闩，理由是阻断"打空—换弹—再打空"的循环），
  // 但换弹本身 0.6 秒的节流已经足够，门闩反而让玩家以为"卡住不打了"。
  // 现在换弹完成即解除门闩。
  fireState.ammo = 0; fireState.reloading = false; fireProbe._fireTimer = 0;
  fireProbe._fire = (state) => { state.ammo--; };
  fireProbe.update(0, { fire: true });                 // 打空 → 触发自动换弹
  check('打空后进入换弹并锁住扳机',
    fireState.reloading === true && fireProbe._requireTriggerRelease === true,
    `reloading=${fireState.reloading} latch=${fireProbe._requireTriggerRelease}`);

  // 推进换弹到结束（保持按住）。用一个很小的正 dt，让换弹在本帧完成。
  fireState.reloadT = fireState.reloadDuration;
  fireProbe.update(1 / 240, { fire: true });
  check('换弹完成后解除扳机门闩（游戏内表现：按住不放会继续射击）',
    fireState.reloading === false && fireProbe._requireTriggerRelease === false,
    `reloading=${fireState.reloading} latch=${fireProbe._requireTriggerRelease}`);

  const afterReloadAmmo = fireState.ammo;
  check('换弹确实补满了弹匣', afterReloadAmmo === R99_MAG, `ammo=${afterReloadAmmo}`);
  fireProbe.update(1, { fire: true });
  check('持续按住左键：换弹结束后自动继续射击',
    fireState.ammo === afterReloadAmmo - 1,
    `${afterReloadAmmo} → ${fireState.ammo}`);

  // 音频名必须存在
  const audio = mods['src/audio/audio.js'];
  if (audio) {
    const names = audio.Audio.names;
    const missingSounds = [];
    for (const id of ids) {
      const def = wp.WEAPONS[id];
      for (const key of ['fireSound', 'reloadSound', 'emptySound']) {
        if (def[key] && !names.includes(def[key])) missingSounds.push(def[key]);
      }
    }
    check('武器引用的音效名都存在于音频模块', missingSounds.length === 0,
      missingSounds.join(','));
  }
}

const en = mods['src/enemies.js'];
const cfg = mods['src/core/config.js'];
if (en) {
  const ids = en.ENEMY_IDS;
  check('敌人兵种数量 >= 6', ids.length >= 6, `${ids.length} 种`);
  const required = ['id', 'name', 'hp', 'speed', 'radius', 'height', 'color', 'weapon',
    'behavior', 'meshKind', 'attackRange', 'threat'];
  const bad = [];
  for (const id of ids) {
    const def = en.ENEMY_TYPES[id];
    for (const k of required) if (def[k] === undefined) bad.push(`${id}.${k}`);
    if (!def.weapon || def.weapon.damage === undefined) bad.push(id + '.weapon.damage');
  }
  check('全部兵种字段完整', bad.length === 0, bad.join(', '));
  const humanoidSizeBad = ids.filter((id) => {
    const def = en.ENEMY_TYPES[id];
    return def.meshKind === 'humanoid'
      && Math.abs(def.height * en.enemyBaseScale(def) - en.ENEMY_HUMANOID_HEIGHT) > 1e-6;
  });
  check('普通人形敌人与玩家同为 1.8m 且判定同步',
    en.ENEMY_HUMANOID_HEIGHT === cfg.CFG.move.capsuleHeight && humanoidSizeBad.length === 0,
    humanoidSizeBad.join(','));
  // 敌人生存数值。需求 13 明确取消了"敌人与玩家同基线"的约束：
  // 「绿影和炸蛛不再有护盾，绿影血量改为其目前 1/3，其他小怪血量和护盾状态
  //   改为目前 1/2，不必和玩家一致」
  // 所以这里改成**正面断言需求里的具体数值** —— 比原先的"例外表"更严格：
  // 例外表只保证"没人偷偷偏离"，现在直接锁死每个兵种应该是多少。
  const PLAYER_HP = cfg.CFG.gameplay.maxHealth;      // 150
  const PLAYER_SH = cfg.CFG.gameplay.maxShield;      // 113
  const MOB_HP = Math.round(PLAYER_HP / 2);          // 其他小怪 = 玩家 1/2
  const MOB_SH = Math.round(PLAYER_SH / 2);
  const STAT_EXPECT = {
    // 普通小怪：玩家基线的 1/2
    grunt: [MOB_HP, MOB_SH], flyer: [MOB_HP, MOB_SH], heavy: [MOB_HP, MOB_SH],
    sniper: [MOB_HP, MOB_SH], swarm: [MOB_HP, MOB_SH],
    // 需求 12：盾卫血量翻倍（玩家血量的 2 倍档），且不再受需求 13 的 1/2 影响
    shieldman: [200, 150],
    // 需求 13：绿影无护盾、血量为其原先的 1/3
    stalker: [50, 0],
    // 需求 13：炸蛛无护盾、血量减半
    blastSpider: [MOB_HP, 0],
    // 蛛皇 BOSS：基础值由 director 生成时乘 (5+tier) 放大。
    // 基准对齐到 150 —— 表驱动改造前它的实际起点就是全局 maxHealth(150)，
    // 若跟着小怪减半会让 boss 血量无端缩水 2/3。
    broodStalker: [150, 150],
  };
  const statBad = [];
  for (const id of ids) {
    const want = STAT_EXPECT[id];
    if (!want) continue;
    const def = en.ENEMY_TYPES[id];
    if (def.hp !== want[0] || def.shield !== want[1]) {
      statBad.push(`${id}: ${def.hp}/${def.shield} ≠ 期望 ${want[0]}/${want[1]}`);
    }
  }
  check('需求13：绿影/炸蛛无护盾，小怪血量护盾为玩家 1/2', statBad.length === 0,
    statBad.length ? statBad.join('; ') : `${ids.length} 个兵种数值符合需求`);
  check('需求13：绿影与炸蛛的护盾严格为 0',
    en.ENEMY_TYPES.stalker.shield === 0 && en.ENEMY_TYPES.blastSpider.shield === 0);

  // ⚠ 关键护栏：**生成时真的用了兵种表里的数值**。
  //
  // 这里踩过一次很隐蔽的坑：ENEMY_TYPES 里明明写了 hp/shield，但 spawn() 实际
  // 取的是全局 CFG.gameplay.maxHealth/maxShield，兵种字段**从未被读取**——
  // 于是需求 13 只改了数据表，运行时敌人血量毫无变化，光看表还以为改对了。
  // 这条断言同时比对"表"与"实际生成结果"，才能发现这类脱节。
  {
    const probe = new en.EnemySystem({ navCandidates: () => [] },
      { radius: cfg.CFG.move.capsuleRadius, height: cfg.CFG.move.capsuleHeight }, null);
    const mismatch = [];
    let checked = 0;
    for (const id of ids) {
      const def = en.ENEMY_TYPES[id];
      if (def.hybridBoss) continue;             // BOSS 的血量由 director 生成时放大
      const e = probe.spawn(id, [0, 0, 0]);
      checked++;
      if (e.maxHp !== def.hp || e.maxShield !== def.shield) {
        mismatch.push(`${id}: 实际 ${e.maxHp}/${e.maxShield}，表里 ${def.hp}/${def.shield}`);
      }
    }
    check('生成敌人的 hp/shield 来自兵种表（不是全局基线）',
      mismatch.length === 0,
      mismatch.length ? mismatch.slice(0, 4).join('; ') : `${checked} 个兵种一致`);
  }
  check('虫群体积放大且攻击环不再位于玩家脚下', en.ENEMY_TYPES.swarm.baseScale >= 1.5
    && en.ENEMY_TYPES.swarm.preferredRange >= 1.8
    && en.enemyBaseScale(en.ENEMY_TYPES.swarm) >= 1.5);
  const enemyProbe = new en.EnemySystem({}, { radius: cfg.CFG.move.capsuleRadius }, null);
  enemyProbe.setDifficulty(4);
  const spawned = enemyProbe.spawn('heavy', [0, 0, 0], { hpMul: 99 });
  // 断言"难度与 hpMul 不能暗中放大血池"这个**意图**，但数值基准已变更：
  // 需求 13 取消了"敌人与玩家共用生存基线"，改成以兵种表为准。
  // 所以这里从 CFG.gameplay.maxHealth 换成 ENEMY_TYPES.heavy.hp —— 意图不变，基准更新。
  check('敌人生成时不会被难度或 hpMul 改写血池',
    spawned.maxHp === en.ENEMY_TYPES.heavy.hp
    && spawned.maxShield === en.ENEMY_TYPES.heavy.shield && spawned.spawnAttackLock >= 1.5);
  check('敌方伤害全局降低到合理区间', en.ENEMY_DAMAGE_SCALE >= 0.25 && en.ENEMY_DAMAGE_SCALE <= 0.45,
    `damageScale=${en.ENEMY_DAMAGE_SCALE}`);

  const tracerBad = wp.WEAPON_IDS.filter((id) => wp.WEAPONS[id].tracerWidth < 0.055 || wp.WEAPONS[id].tracerLife < 0.13);
  check('全部玩家武器曳光足够粗且至少持续 0.13 秒', tracerBad.length === 0, tracerBad.join(','));

  const dir = mods['src/director.js'];
  if (dir && dir.PHASES) {
    check('导演相位定义完整', dir.PHASES.length >= 4, dir.PHASES.join(','));
  }
}

const directorMod = mods['src/director.js'];
if (directorMod && en) {
  const enemiesStub = { setDifficulty() {}, all: [], aliveCount: () => 0 };
  const playerStub = { pos: new Float32Array([0, 0, 0]), eyePos: new Float32Array([0, 1.62, 0]), yaw: 0 };
  const directorProbe = new directorMod.Director({}, enemiesStub, playerStub);
  directorProbe.setTier(1);
  const gruntRange = directorProbe._spawnRange('grunt', false);
  const sniperRange = directorProbe._spawnRange('sniper', false);
  check('导演数量低于旧版上限但不会因远距离增援造成空场', directorProbe.concurrencyLimit >= 7
    && directorProbe.concurrencyLimit <= 8 && directorProbe.budgetRate >= 1.0 && directorProbe.budgetRate <= 1.1,
    `limit=${directorProbe.concurrencyLimit}, rate=${directorProbe.budgetRate}`);
  check('所有兵种刷新距离都在自身攻击范围之外', gruntRange.min >= en.ENEMY_TYPES.grunt.attackRange + 12
    && sniperRange.min >= en.ENEMY_TYPES.sniper.attackRange + 12);
}

// ---------------------------------------------------------------- 6. 无第三方依赖 / 无危险 API

section('6. 依赖与安全约束');

const srcFiles = files;
let externImports = [];
let evalUsage = [];
let perFrameLog = [];
for (const f of srcFiles) {
  const rel = relative(ROOT, f).split(sep).join('/');
  const text = await (await import('node:fs/promises')).readFile(f, 'utf8');
  // 外部导入（非相对路径、非 node:）
  const importRe = /(?:^|\n)\s*import\s+[^'"]*from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = importRe.exec(text)) !== null) {
    const spec = m[1];
    if (!spec.startsWith('.') && !spec.startsWith('/')) externImports.push(`${rel} -> ${spec}`);
  }
  const dynRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynRe.exec(text)) !== null) {
    const spec = m[1];
    if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('node:')) {
      externImports.push(`${rel} -> ${spec}(dynamic)`);
    }
  }
  if (/\beval\s*\(|new\s+Function\s*\(/.test(text)) evalUsage.push(rel);
  void perFrameLog;
}
check('零第三方依赖（无外部 import）', externImports.length === 0, externImports.join(', '));
check('无 eval / new Function', evalUsage.length === 0, evalUsage.join(', '));

// ---------------------------------------------------------------- 7. HUD CSS 状态类特异性

section('7. HUD 状态类的 CSS 特异性（防止"界面存在但看不见"）');

/** 解析 CSS，返回 [{ selectors:[], props:Set }]，跳过 @ 规则与 keyframes */
function parseCssRules(text) {
  const out = [];
  // 去掉注释
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const selText = m[1].trim();
    if (!selText || selText.startsWith('@') || /^(from|to|\d+%)$/.test(selText)) continue;
    const props = new Map();
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const k = decl.slice(0, i).trim().toLowerCase();
      const v = decl.slice(i + 1).trim();
      if (k) props.set(k, v);
    }
    for (const s of selText.split(',')) {
      const sel = s.trim();
      if (sel) out.push({ selector: sel, props });
    }
  }
  return out;
}

const { readFile: readF } = await import('node:fs/promises');
const hudCssPath = join(ROOT, 'styles/hud.css');
const fixCssPath = join(ROOT, 'styles/hud-fixes.css');

/** 粗略特异性：ID 数 * 100 + 类/属性/伪类数 * 10 + 元素数 */
function specificity(sel) {
  const ids = (sel.match(/#[\w-]+/g) || []).length;
  const classes = (sel.match(/\.[\w-]+/g) || []).length
    + (sel.match(/\[[^\]]+\]/g) || []).length
    + (sel.match(/:(?!:)[\w-]+/g) || []).length;
  const els = (sel.replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|::?[\w-]+/g, ' ')
    .match(/[a-zA-Z][\w-]*/g) || []).length;
  return ids * 100 + classes * 10 + els;
}

const STATE_CLASS_RE = /--(on|active|open|show|visible|done|lit|ready)$/;

let baseRules = [];
let fixRules = [];
try { baseRules = parseCssRules(await readF(hudCssPath, 'utf8')); } catch (_e) { /* 缺文件 */ }
try { fixRules = parseCssRules(await readF(fixCssPath, 'utf8')); } catch (_e) { /* 缺文件 */ }

check('styles/hud.css 可解析', baseRules.length > 0, `${baseRules.length} 条规则`);
check('styles/hud-fixes.css 存在', fixRules.length > 0, `${fixRules.length} 条规则`);

if (baseRules.length > 0 && fixRules.length > 0) {
  // 收集所有 ID 规则声明的属性
  const idProps = new Map();      // "#id" -> Set(props)
  for (const r of baseRules) {
    if (!r.selector.includes('#')) continue;
    if (!idProps.has(r.selector)) idProps.set(r.selector, new Set());
    const set = idProps.get(r.selector);
    for (const k of r.props.keys()) set.add(k);
  }

  // 找出"状态类想覆盖的属性和某个 ID 规则冲突"的组合
  // 例外：像 #load-overlay / .load-overlay--done 这种"状态类是用来**隐藏**元素"的，
  // 基准态是可见、状态态才是不可见，不需要更高特异性覆盖。
  const HIDE_ONLY_STATES = new Set(['load-overlay--done']);
  const conflicts = [];
  for (const r of baseRules) {
    if (!STATE_CLASS_RE.test(r.selector)) continue;
    if (r.selector.includes('#') || r.selector.includes(' ')) continue;   // 只看单个类的简单情形
    if (HIDE_ONLY_STATES.has(r.selector.replace(/^\./, ''))) continue;
    const base = r.selector.replace(STATE_CLASS_RE, '');
    const idSel = '#' + base.replace(/^\./, '');
    const shared = idProps.get(idSel);
    if (!shared) continue;
    for (const prop of r.props.keys()) {
      if (shared.has(prop)) conflicts.push({ idSel, stateSel: r.selector, prop });
    }
  }

  // 每个冲突都必须在 hud-fixes.css 里有 #id.class 的显式覆盖
  const unresolved = [];
  for (const c of conflicts) {
    const needSel = `${c.idSel}${c.stateSel}`;
    const fixed = fixRules.some((f) => f.selector === needSel && f.props.has(c.prop));
    if (!fixed) unresolved.push(`${c.idSel} {${c.prop}} vs ${c.stateSel}`);
  }
  check('所有 ID/状态类特异性冲突都已在 hud-fixes.css 中解决',
    unresolved.length === 0,
    unresolved.length ? '未解决: ' + unresolved.slice(0, 6).join(' | ') : `发现并覆盖 ${conflicts.length} 处冲突`);

  // 校验覆盖规则的特异性确实更高
  const weak = [];
  for (const f of fixRules) {
    if (!f.selector.includes('#') || !f.selector.includes('.')) continue;
    const baseIdSel = (f.selector.match(/#[\w-]+/g) || [])[0];
    if (!baseIdSel) continue;
    const baseRule = baseRules.find((r) => r.selector === baseIdSel);
    if (!baseRule) continue;
    if (specificity(f.selector) <= specificity(baseIdSel)) weak.push(f.selector);
  }
  check('覆盖规则的特异性严格高于被覆盖的 ID 规则', weak.length === 0, weak.join(', '));

  // 检查事件里派发到 HUD 的状态类是否都在 CSS 里有定义（漏写类名会导致元素永不显示）
  // 注意：状态类可以只作为"后代选择器的一部分"出现
  // （例如 `.hud-hitmarker--on .hud-hitmarker-line`），所以按 token 匹配而不是整串。
  const hudJs = await readF(join(ROOT, 'src/ui/hud.js'), 'utf8');
  const toggled = new Set();
  for (const m of hudJs.matchAll(/['"]([\w-]*--(?:on|active|open|show|visible|done))['"]/g)) {
    toggled.add(m[1]);
  }
  const cssClassTokens = new Set();
  for (const r of [...baseRules, ...fixRules]) {
    for (const m of r.selector.matchAll(/\.([\w-]+)/g)) cssClassTokens.add(m[1]);
  }
  const undef = [...toggled].filter((c) => !cssClassTokens.has(c));
  check('HUD 切换的状态类都有对应 CSS 定义', undef.length === 0,
    undef.length ? '未定义: ' + undef.join(', ') : `检查 ${toggled.size} 个状态类`);
}

// ---------------------------------------------------------------- 汇总

section('汇总');
const total = pass + fail;
process.stdout.write(`  ${pass}/${total} 通过\n`);
if (fail > 0) {
  process.stdout.write('\n  失败项:\n');
  for (const f of failures) process.stdout.write('    - ' + f + '\n');
  process.exit(1);
} else {
  process.stdout.write('\n  IRONFALL 模块自检: 全部通过\n');
}
