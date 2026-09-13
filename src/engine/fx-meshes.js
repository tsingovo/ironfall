// ==== engine/fx-meshes.js — 特效共享网格库 ====
// 粒子、曳光、枪口火光、贴花、敌人、道具都从这里取"单位形状"，避免重复创建网格。
// 单位形状配合实例矩阵完成缩放/朝向 —— 这是低 draw call 的关键。

import * as Geo from './geometry.js';

/**
 * 创建整套共享网格并挂到 engine 上。
 * engine.userXxxMesh 是本项目约定的取用点（world/particles/enemies 都靠它）。
 */
export function createSharedMeshes(engine) {
  const m = {
    // 世界结构
    cube: engine.createMesh(Geo.unitCube()),
    cylinder: engine.createMesh(Geo.unitCylinder(14, true, true)),
    cylinderThin: engine.createMesh(Geo.unitCylinder(10, true, true)),
    cylinder6: engine.createMesh(Geo.unitCylinder(6, true, true)),
    sphere: engine.createMesh(Geo.unitSphere(12, 8)),
    sphereLow: engine.createMesh(Geo.unitSphere(8, 5)),
    cone: engine.createMesh(Geo.unitCone(12)),
    wedge: engine.createMesh(Geo.unitWedge()),
    quad: engine.createMesh(Geo.unitQuad()),
    disc: engine.createMesh(Geo.unitDisc(20)),
    plane: engine.createMesh(Geo.unitPlane()),

    // 特效
    tracer: engine.createMesh(Geo.unitCube()),
    stretch: engine.createMesh(Geo.unitCube()),
    flash: engine.createMesh(Geo.unitCone(8)),
    spark: engine.createMesh(Geo.unitCube()),
    billboard: engine.createMesh(Geo.unitQuad()),
    ring: engine.createMesh(Geo.unitDisc(24)),
    decal: engine.createMesh(Geo.unitQuad()),
  };

  for (const k of Object.keys(m)) {
    engine['user' + k.charAt(0).toUpperCase() + k.slice(1) + 'Mesh'] = m[k];
  }
  engine.sharedMeshes = m;
  return m;
}

/** 释放整套共享网格 */
export function destroySharedMeshes(engine) {
  if (!engine.sharedMeshes) return;
  for (const k of Object.keys(engine.sharedMeshes)) {
    engine.destroyMesh(engine.sharedMeshes[k]);
  }
  engine.sharedMeshes = null;
}

export default createSharedMeshes;
