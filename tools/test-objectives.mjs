import { Run } from '../src/run.js';
const worldObjectives = [
  { id:'d', type:'destroy', label:'摧毁', pos:[0,0,0], radius:3, hp:40 },
  { id:'r', type:'recover', label:'回收', pos:[10,0,0], radius:3 },
];
const world = {
  objectives:()=>worldObjectives,
  extractPoints:()=>[{pos:[20,0,0],radius:3}],
  supplyStations:()=>[],
};
const player={pos:[0,0,0],state:{grounded:true,speed:0},alive:true};
const enemies={};
const run=new Run(world,player,enemies,{});
run.start(1,0); run.phase='objectives';
let pass=0, fail=0;
const ok=(name,v)=>{console.log(`${v?'PASS':'FAIL'}  ${name}`); v?pass++:fail++;};
run.objectiveInteractDown=true; run.update(2,player);
ok('destroy 目标不会靠站圈自动完成', run.objectives[0].progress===0);
ok('射击点附近可真实伤害 destroy 目标', run.damageObjectiveAt([0,0,0],20) && run.objectives[0].hp===20);
run.damageObjectiveAt([0,0,0],25);
ok('射击伤害足够后 destroy 完成且世界模型同步', run.objectives[0].done && worldObjectives[0].done);
player.pos=[10,0,0]; run.objectiveInteractDown=false; run.update(3,player);
ok('recover 未按 E 不自动增长', run.objectives[1].progress===0);
run.objectiveInteractDown=true; for(let i=0;i<8;i++) run.update(1,player);
ok('recover 按住 E 完成真实拿取流程', run.objectives[1].done);
run.dispose();
console.log(`OBJECTIVE SELF-TEST: ${pass}/${pass+fail} passed`); if(fail) process.exit(1);
