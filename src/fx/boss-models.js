// Dedicated low-poly silhouettes, in metres at scale=1; forward is local -Z.
// All parts use existing shared meshes. No opaque pretend-transparent shield panel.
const C = {
  steel:[.19,.23,.28], dark:[.035,.045,.052], blue:[.16,.72,1],
  green:[.18,.58,.12], dragon:[.055,.12,.075], membrane:[.12,.33,.16],
  bone:[.76,.8,.61], ghost:[.22,.29,.37], fire:[.26,.95,.74],
  fur:[.49,.29,.12], glove:[.83,.065,.04], rock:[.12,.075,.055], lava:[1,.29,.025],
};
function part(name, offset, size, color, extra={}) {
  return {name,mesh:'cube',offset,size,color,bossModel:true,...extra};
}
function ball(name,p,s,c,extra={}) { return part(name,p,s,c,{mesh:'sphere',...extra}); }
// A box aligned between two endpoints (only used in Y/Z or X/Y planes).
function link(name,a,b,width,depth,color,extra={}) {
  const dx=b[0]-a[0],dy=b[1]-a[1],dz=b[2]-a[2];
  return part(name,a.map((v,i)=>(v+b[i])/2),[width,Math.hypot(dx,dy,dz),depth],color,
    {rot:[Math.atan2(dz,Math.hypot(dx,dy)),0,-Math.atan2(dx,dy)],...extra});
}
const sides=[-1,1];
const tank=[
  part('hull',[0,1,0],[2.7,.9,3.7],C.steel),
  part('frontSlope',[0,1.35,-1.5],[2.5,.48,.9],C.steel,{rot:[-.3,0,0]}),
  part('turret',[0,2.05,-.15],[1.7,.8,1.7],C.steel),
  part('hatch',[0,2.54,.1],[.85,.14,.75],C.dark),
  part('barrel',[0,2.15,-2.1],[.32,.32,2.4],C.dark),
  part('muzzle',[0,2.15,-3.28],[.58,.55,.24],C.blue),
  ...sides.flatMap(s=>[
    part('track'+s,[s*1.58,.55,0],[.68,.95,4.05],C.dark),
    ...[-1.35,-.45,.45,1.35].map((z,i)=>ball('wheel'+s+i,[s*1.94,.55,z],[.08,.64,.64],C.steel)),
    part('shieldSide'+s,[s*2.12,1.6,-3.55],[.075,2.8,.065],C.blue),
    part('shieldEmitter'+s,[s*1.16,1.75,-1.55],[.27,.35,.32],C.blue),
  ]),
  ...[.2,3].map((y,i)=>part('shieldEdge'+i,[0,y,-3.55],[4.3,.075,.065],C.blue)),
  // Sparse scan lines preserve the view of the turret and moving treads.
  ...[.85,1.55,2.25].map((y,i)=>part('shieldScan'+i,[0,y,-3.55],[4.2,.025,.025],C.blue)),
  // Faint additive energy field: background remains visible; never writes depth.
  part('shieldField',[0,1.6,-3.55],[4.2,2.8,.018],[.015,.06,.12],{additive:true}),
];
const slender=[
  part('waist',[0,5.85,0],[.62,.7,.43],C.dark),
  part('ribcage',[0,7.65,0],[.91,3,.5],C.dark),
  part('neck',[0,9.45,0],[.23,.7,.24],C.dark),
  ball('facelessHead',[0,10.15,0],[.66,1.3,.59],C.dark),
  ...sides.flatMap(s=>[
    link('longThigh'+s,[s*.3,5.8,0],[s*.45,2.9,.1],.25,.28,C.dark),
    link('longShin'+s,[s*.45,2.9,.1],[s*.5,.2,0],.19,.22,C.dark),
    part('foot'+s,[s*.5,.12,-.23],[.29,.24,.75],C.dark),
    link('upperArm'+s,[s*.52,8.95,0],[s*.9,5.7,0],.22,.25,C.dark,{group:'smash',pivot:[s*.52,8.95,0]}),
    link('longForearm'+s,[s*.9,5.7,0],[s*.95,2.5,-.1],.18,.21,C.dark,{group:'smash',pivot:[s*.52,8.95,0]}),
    part('hand'+s,[s*.95,2.25,-.1],[.28,.65,.18],C.dark,{group:'smash',pivot:[s*.52,8.95,0]}),
  ]),
];
const dragon=[
  ball('haunch',[0,1.95,.65],[1.7,1.9,2.7],C.dragon),
  ball('chest',[0,2.2,-.5],[1.6,1.7,2.2],C.dragon),
  link('neck',[0,2.1,-1],[0,3.2,-2.1],.68,.8,C.dragon),
  ball('head',[0,3.35,-2.25],[.95,.9,1.2],C.dragon),
  part('snout',[0,3.15,-2.94],[.65,.5,.95],C.dragon),
  link('tailBase',[0,1.7,1.35],[0,1.1,3.3],.65,.7,C.dragon),
  link('tailTip',[0,1.1,3.3],[0,1.55,5.1],.22,.3,C.dragon),
  ...sides.flatMap(s=>[
    ball('eye'+s,[s*.4,3.52,-2.65],[.13,.14,.2],C.green),
    link('horn'+s,[s*.3,3.6,-1.9],[s*.55,4.15,-1.3],.16,.2,C.bone),
    ...[-.8,1].flatMap((z,i)=>[
      link('dragonLeg'+s+i,[s*.6,1.9,z],[s*1.03,.65,z+.25],.35,.42,C.dragon),
      part('claw'+s+i,[s*1.03,.5,z-.12],[.46,.27,.75],C.bone),
    ]),
    link('wingSpar'+s,[s*.6,2.75,-.45],[s*4.5,3,-.95],.18,.21,C.dragon,{group:'wing',side:s,pivot:[s*.6,2.75,-.45]}),
    // Overlapping tapered fingers form a bat-wing fan, not aircraft rectangle wings.
    ...[0,1,2].map(i=>part('wingMembrane'+s+i,[s*(2.7-i*.33),2.77,.05+i*.64],
      [.055,3.2-i*.8,1.02],C.membrane,{mesh:'wedge',rot:[0,s*(-.12-i*.18),s*Math.PI/2],group:'wing',side:s,pivot:[s*.6,2.75,-.45]})),
  ]),
  ...[0,1,2,3].map(i=>part('dorsalSpike'+i,[0,3.05-i*.13,-.2+i*.65],[.24,.6,.4],C.green,{mesh:'cone'})),
];
const goblin=[
  ball('belly',[0,.5,0],[.44,.51,.31],C.green),
  ball('goblinHead',[0,.91,-.04],[.46,.4,.35],C.green),
  part('loincloth',[0,.29,0],[.36,.22,.3],C.dark),
  part('nose',[0,.88,-.26],[.14,.13,.22],C.green),
  ...sides.flatMap(s=>[
    part('ear'+s,[s*.29,.99,0],[.27,.12,.14],C.green,{rot:[0,0,s*.45]}),
    part('eye'+s,[s*.12,.98,-.215],[.075,.065,.04],C.bone),
    part('goblinArm'+s,[s*.29,.51,0],[.13,.43,.14],C.green,{group:'gait',side:s,pivot:[s*.28,.72,0]}),
    part('goblinLeg'+s,[s*.13,.15,0],[.14,.3,.17],C.green,{group:'gait',side:-s,pivot:[s*.13,.3,0]}),
  ]),
];
const vat=[
  part('base',[0,.22,0],[3.1,.44,3.1],C.dark),
  part('cap',[0,2.4,0],[3.1,.38,3.1],C.steel),
  part('fluid',[0,.62,0],[2.6,.3,2.6],C.green),
  ...sides.flatMap(s=>sides.map(t=>part('post'+s+t,[s*1.32,1.34,t*1.32],[.16,2,.16],C.green))),
  ...[.85,1.8].flatMap((y,i)=>sides.flatMap(s=>[
    part('rimX'+i+s,[0,y,s*1.32],[2.65,.055,.055],C.green),
    part('rimZ'+i+s,[s*1.32,y,0],[.055,.055,2.65],C.green),
  ])),
  ...goblin.map(p=>({...p,name:'specimen_'+p.name,offset:p.offset.map((v,i)=>v*1.2+(i===1?.65:0)),size:p.size.map(v=>v*1.2),group:'specimen'})),
];
const centaur=[
  ball('horseBody',[0,1.2,.35],[1.3,1.05,2.8],C.ghost),
  part('humanTorso',[0,2.13,-.68],[.83,1.15,.54],C.ghost),
  ball('helmet',[0,2.79,-.7],[.55,.5,.55],C.ghost),
  part('visor',[0,2.82,-1],[.4,.1,.05],C.fire),
  link('tail',[0,1.4,1.7],[0,.5,2.35],.21,.27,C.fire),
  part('lance',[.79,2.05,-2.3],[.09,.09,5.1],C.bone),
  part('spearhead',[.79,2.05,-4.95],[.34,.68,.34],C.fire,{mesh:'cone',rot:[-Math.PI/2,0,0]}),
  ...sides.flatMap(s=>[
    part('riderArm'+s,[s*.59,2.08,-.8],[.22,.72,.26],C.ghost),
    ...[-.65,1.25].map((z,i)=>part('horseLeg'+s+i,[s*.48,.5,z],[.24,1,.28],C.ghost,
      {group:'gallop',side:s*(i?1:-1),pivot:[s*.48,1,z]})),
  ]),
];
const kangaroo=[
  ball('body',[0,1.05,.15],[.98,1.35,.8],C.fur),
  ball('pouch',[0,.91,-.29],[.59,.6,.25],[.7,.47,.25]),
  link('tailBase',[0,.75,.4],[0,.23,1.6],.43,.45,C.fur),
  link('tailTip',[0,.23,1.6],[0,.15,2.6],.16,.2,C.fur),
  ...sides.flatMap(s=>[
    ball('head'+s,[s*.32,1.9,-.1],[.53,.53,.47],C.fur),
    ball('muzzle'+s,[s*.32,1.78,-.35],[.31,.23,.38],C.fur),
    ...[-1,1].map((t,i)=>part('ear'+s+i,[s*.32+t*.14,2.29,-.03],[.12,.5,.13],C.fur,{rot:[0,0,t*.18]})),
    ball('haunch'+s,[s*.46,.59,.2],[.51,.83,.66],C.fur),
    part('longFoot'+s,[s*.46,.12,-.37],[.3,.24,.95],C.fur,{group:'hop',side:s}),
    link('boxingArm'+s,[s*.43,1.44,0],[s*.68,1.38,-.57],.2,.23,C.fur,{group:'punch',side:s}),
    ball('glove'+s,[s*.68,1.4,-.75],[.51,.47,.51],C.glove,{group:'punch',side:s}),
  ]),
];
const lava=[
  part('basaltChest',[0,2.55,0],[1.95,1.55,1.04],C.rock),
  part('moltenCore',[0,2.5,-.56],[.52,.82,.1],C.lava),
  part('waist',[0,1.65,0],[1.1,.45,.74],C.rock),
  part('head',[0,3.58,-.05],[.85,.78,.7],C.rock),
  part('eyeSlit',[0,3.64,-.415],[.68,.09,.06],C.lava),
  ...sides.flatMap(s=>[
    part('shoulder'+s,[s*1.15,3.1,0],[.8,.85,1],C.rock,{rot:[0,0,s*.22]}),
    part('crag'+s,[s*1.28,3.72,0],[.42,.65,.5],C.rock,{mesh:'cone',rot:[0,0,-s*.25]}),
    part('arm'+s,[s*1.28,2.35,0],[.59,1.1,.66],C.rock,{group:'throw',side:s,pivot:[s*1.15,3.1,0]}),
    part('fist'+s,[s*1.35,1.65,-.18],[.76,.74,.78],C.rock,{group:'throw',side:s,pivot:[s*1.15,3.1,0]}),
    part('armCrack'+s,[s*1.28,2.35,-.345],[.52,.11,.045],C.lava,{group:'throw',side:s,pivot:[s*1.15,3.1,0]}),
    part('leg'+s,[s*.55,.95,0],[.64,1.45,.76],C.rock),
    part('kneeCrack'+s,[s*.55,1.05,-.4],[.52,.13,.04],C.lava),
    part('foot'+s,[s*.55,.18,-.18],[.84,.36,1.05],C.rock),
  ]),
];
export const BOSS_SHAPES={shieldMech:tank,slenderKiller:slender,corruptDragon:dragon,cloneVat:vat,ghostKnight:centaur,boxer:kangaroo,lavaGuardian:lava,cloneGoblin:goblin};
export function getBossShape(type) { return BOSS_SHAPES[type.bossKind] || (type.cloneOf==='tier7Vat'?goblin:null); }
export function bossModelRadius(en) {
  const kind=en.type.bossKind;
  return ({shieldMech:5,slenderKiller:12,corruptDragon:8,cloneVat:3,ghostKnight:6,boxer:4,lavaGuardian:5}[kind] || 2)*(en.scale||1);
}
/** Pure animation: never changes shared part definitions or combat state. */
export function poseBossPart(en,p) {
  if (!p.bossModel) return p;
  let rx=0,rz=0,dz=0,dy=0;
  const age=en.age||0, phase=en.animPhase||age*8;
  if (p.group==='smash' && en.smashPhase==='smash') {
    const progress=1-Math.max(0,en.smashT||0)/(en.type.smashTime||1.5);
    rx=progress<.7 ? progress/.7*2.65 : 2.65*(1-(progress-.7)/.3);
  }
  if(p.group==='wing') rz=p.side*(en.divePhase==='dive' ? -.95 : Math.sin(age*5)*.38);
  if(p.group==='gallop') rx=Math.sin(phase)*p.side*(en.chargePhase==='charge'?.7:.18);
  if(p.group==='gait') rx=Math.sin(phase)*p.side*.4;
  if(p.group==='hop' && en.grounded===false) {rx=-.35;dy=.18;}
  if(p.group==='punch') dz=-.6*Math.max(0,Math.min(1,((en.punchT||0)-.6)/.4));
  if(p.group==='throw') rx=1.2*Math.max(0,Math.min(1,((en.seedT||0)-((en.type.seedSpiderCooldown||5)-.5))/.5));
  if(p.group==='specimen')dy=Math.sin(age*2)*.08;
  if(!rx&&!rz&&!dz&&!dy)return p;
  const pivot=p.pivot||p.offset, x=p.offset[0]-pivot[0],y=p.offset[1]-pivot[1],z=p.offset[2]-pivot[2];
  const yy=y*Math.cos(rx)-z*Math.sin(rx),zz=y*Math.sin(rx)+z*Math.cos(rx);
  return {...p,offset:[pivot[0]+x*Math.cos(rz)-yy*Math.sin(rz),pivot[1]+x*Math.sin(rz)+yy*Math.cos(rz)+dy,pivot[2]+zz+dz],
    rot:[(p.rot?.[0]||0)+rx,p.rot?.[1]||0,(p.rot?.[2]||0)+rz]};
}
