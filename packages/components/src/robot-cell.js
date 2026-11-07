import * as THREE from 'three';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';

/* ArrayMultiplier's robot factory (theme robot_factory): a six-axis industrial arm takes one whole row of
   gears from the infeed conveyor behind it with a row of suction cups and sets it down on the pallet, row
   after row, so "rows × gears in a row" is built in front of the child. The pallet sits on a rotary indexing
   table that turns it a quarter turn (rows become columns). Painted castings, machined steel and brass,
   rubber and aluminium under a real warehouse HDRI, at true size: no toy robot. Rows alternate steel and
   brass so they can be counted. */

const P = 0.14;                 // pitch of the slots on the pallet (m)
const TABLE = 0.72;             // table top
const PLATE = TABLE + 0.1 + 0.03; // pallet top (rotary table 0.1, tooling plate 0.03)
const GEAR_T = 0.024;           // gear thickness
const L1 = 1.0, L2 = 0.95, L3 = 0.31, HS = 0.78, OS = 0.18; // upper arm, forearm, wrist to cup tips, shoulder height and offset
const ease = t => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);

const G = {};
/** A cylinder with rounded edges (lathe), so its rims catch the light like a real casting. */
function roundCyl(r, h, f = Math.min(r, h) * 0.18, seg = 40){
  const pts = [new THREE.Vector2(0, -h / 2)];
  for(let i = 0; i <= 6; i++){ const a = -Math.PI / 2 + i / 6 * Math.PI / 2; pts.push(new THREE.Vector2(r - f + Math.cos(a) * f, -h / 2 + f + Math.sin(a) * f)); }
  for(let i = 0; i <= 6; i++){ const a = i / 6 * Math.PI / 2; pts.push(new THREE.Vector2(r - f + Math.cos(a) * f, h / 2 - f + Math.sin(a) * f)); }
  pts.push(new THREE.Vector2(0, h / 2));
  return new THREE.LatheGeometry(pts, seg);
}
function gearGeometry(){
  if(G.gear) return G.gear;
  const teeth = 16, ro = 0.05, ri = 0.043, s = new THREE.Shape();
  for(let i = 0; i < teeth; i++){
    const a0 = i / teeth * Math.PI * 2, w = Math.PI * 2 / teeth;
    const pts = [[ri, a0], [ro, a0 + w * 0.18], [ro, a0 + w * 0.45], [ri, a0 + w * 0.63]];
    pts.forEach(([r, a], k) => { const x = Math.cos(a) * r, y = Math.sin(a) * r; i === 0 && k === 0 ? s.moveTo(x, y) : s.lineTo(x, y); });
  }
  s.closePath();
  const hole = new THREE.Path(); hole.absarc(0, 0, 0.011, 0, Math.PI * 2, true); s.holes.push(hole);
  // lightening holes, like a real machined gear
  for(let k = 0; k < 5; k++){ const a = k / 5 * Math.PI * 2, h = new THREE.Path(); h.absarc(Math.cos(a) * 0.027, Math.sin(a) * 0.027, 0.0065, 0, Math.PI * 2, true); s.holes.push(h); }
  const g = new THREE.ExtrudeGeometry(s, { depth: GEAR_T - 0.004, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.0015, bevelSegments: 2, curveSegments: 10 });
  g.rotateX(-Math.PI / 2); g.translate(0, 0.002, 0); g.userData.shared = true;
  return (G.gear = g);
}
function canvasTex(w, h, draw, { repeat = [1, 1], srgb = true } = {}){
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 8; return t;
}
/** Sealed concrete: mottled grey with fine grain, and a matching roughness map (rubbed areas are shinier). */
function concrete(){
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const paint = (g, w, h, base, spread) => {
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    for(let i = 0; i < 900; i++){ const r = 6 + rnd() * 60, v = Math.round(spread * (rnd() - 0.5));
      g.fillStyle = `rgba(${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${Math.abs(v) / 900})`;
      g.beginPath(); g.arc(rnd() * w, rnd() * h, r, 0, Math.PI * 2); g.fill(); }
    const id = g.getImageData(0, 0, w, h);
    for(let i = 0; i < id.data.length; i += 4){ const n = (rnd() - 0.5) * 18; id.data[i] += n; id.data[i + 1] += n; id.data[i + 2] += n; }
    g.putImageData(id, 0, 0);
  };
  return {
    map: canvasTex(512, 512, (g, w, h) => paint(g, w, h, '#8f8d88', 60), { repeat: [10, 10] }),
    rough: canvasTex(512, 512, (g, w, h) => paint(g, w, h, '#7a7a7a', 90), { repeat: [10, 10], srgb: false }),
  };
}

export function createRobotCell({ world, params, reduced, sun, hooks }){
  const { r, c } = params, W = c * P, D = r * P;
  const cell = new THREE.Group(); world.add(cell);
  const pickables = [];
  const shadow = o => o.traverse(n => { if(n.isMesh){ n.castShadow = true; n.receiveShadow = true; } });

  /* ---------- materials ---------- */
  const paint = new THREE.MeshPhysicalMaterial({ color: 0xf0a020, roughness: 0.38, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.22 });
  const cast = new THREE.MeshStandardMaterial({ color: 0x3a3d41, roughness: 0.55, metalness: 0.25 });
  const black = new THREE.MeshStandardMaterial({ color: 0x141517, roughness: 0.62 });
  const steel = new THREE.MeshStandardMaterial({ color: 0xc9cdd1, roughness: 0.24, metalness: 1 });
  const alu = new THREE.MeshStandardMaterial({ color: 0xd6dade, roughness: 0.36, metalness: 1 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xd8b25a, roughness: 0.3, metalness: 1 });
  const gearSteel = new THREE.MeshStandardMaterial({ color: 0xb9bec4, roughness: 0.27, metalness: 1 });
  const hose = new THREE.MeshStandardMaterial({ color: 0x2b6cc4, roughness: 0.45 });
  const belt = new THREE.MeshStandardMaterial({ color: 0x1d1f21, roughness: 0.85,
    map: canvasTex(256, 64, (g, w, h) => { g.fillStyle = '#2a2c2e'; g.fillRect(0, 0, w, h); g.fillStyle = '#1a1b1d'; for(let x = 0; x < w; x += 16) g.fillRect(x, 0, 3, h); }, { repeat: [6, 1] }) });

  /* ---------- floor: sealed concrete, safety tape round the cell ---------- */
  const cc = concrete();
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ map: cc.map, roughnessMap: cc.rough, roughness: 0.7, metalness: 0, color: 0xd8d6d0 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; cell.add(floor);
  const tape = canvasTex(256, 32, (g, w, h) => { g.fillStyle = '#f2c200'; g.fillRect(0, 0, w, h); g.fillStyle = '#151515'; for(let x = -h; x < w; x += 48){ g.beginPath(); g.moveTo(x, h); g.lineTo(x + 24, h); g.lineTo(x + 24 + h, 0); g.lineTo(x + h, 0); g.fill(); } });
  const zb = -Math.max(W, D) / 2 - 0.62, zc = zb - 0.9; // robot base, infeed conveyor
  const area = { x0: -Math.max(W, D) / 2 - 0.9, x1: Math.max(W, D) / 2 + 0.9, z0: zc - 0.45, z1: Math.max(W, D) / 2 + 0.5 };
  for(const [x0, z0, x1, z1] of [[area.x0, area.z1, area.x1, area.z1], [area.x0, area.z0, area.x1, area.z0], [area.x0, area.z0, area.x0, area.z1], [area.x1, area.z0, area.x1, area.z1]]){
    const len = Math.hypot(x1 - x0, z1 - z0), t = tape.clone(); t.repeat.set(len / 0.5, 1); t.needsUpdate = true;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.075), new THREE.MeshStandardMaterial({ map: t, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -2 }));
    m.rotation.x = -Math.PI / 2; m.rotation.z = Math.atan2(-(z1 - z0), x1 - x0); m.position.set((x0 + x1) / 2, 0.002, (z0 + z1) / 2); m.receiveShadow = true; cell.add(m);
  }

  /* ---------- table with the rotary indexing table and the pallet ---------- */
  const span = Math.max(W, D) + 0.3;
  const table = new THREE.Group(); cell.add(table);
  const top = new THREE.Mesh(new RoundedBoxGeometry(span + 0.3, 0.05, span + 0.3, 2, 0.01), cast); top.position.y = TABLE - 0.025; table.add(top);
  for(const sx of [-1, 1]) for(const sz of [-1, 1]){ const leg = new THREE.Mesh(new RoundedBoxGeometry(0.07, TABLE - 0.05, 0.07, 2, 0.008), steel); leg.position.set(sx * (span / 2 + 0.05), (TABLE - 0.05) / 2, sz * (span / 2 + 0.05)); table.add(leg); }
  const turn = new THREE.Mesh(roundCyl(span / 2 * 0.98, 0.1, 0.012, 64), cast); turn.position.y = TABLE + 0.05; table.add(turn);
  shadow(table);
  const tray = new THREE.Group(); tray.position.y = PLATE; cell.add(tray);
  const plate = new THREE.Mesh(new RoundedBoxGeometry(W + 0.1, 0.03, D + 0.1, 2, 0.006), alu); plate.position.y = -0.015; tray.add(plate);
  // a locating pin in every slot: empty slots stay visible and countable
  const pins = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.009, 0.009, 0.03, 12), steel, r * c);
  const at = (i, j) => new THREE.Vector3(-W / 2 + P / 2 + j * P, 0, -D / 2 + P / 2 + i * P);
  { const m4 = new THREE.Matrix4(); let k = 0; for(let i = 0; i < r; i++) for(let j = 0; j < c; j++){ const p = at(i, j); m4.makeTranslation(p.x, 0.015, p.z); pins.setMatrixAt(k++, m4); } }
  tray.add(pins); shadow(tray);
  const gearMat = i => (i % 2 ? brass : gearSteel);
  const parts = [];
  for(let i = 0; i < r; i++) for(let j = 0; j < c; j++){
    const m = new THREE.Mesh(gearGeometry(), gearMat(i)); const p = at(i, j);
    m.position.set(p.x, 0, p.z); m.rotation.y = ((i * 5 + j * 3) % 7) * 0.13;
    m.castShadow = true; m.receiveShadow = true; m.userData = { kind: 'cube', row: i + 1, col: j + 1 };
    tray.add(m); parts.push(m); pickables.push(m);
  }

  /* ---------- infeed conveyor behind the robot: a row of gears on a carrier arrives for each pick ---------- */
  const conv = new THREE.Group(); conv.position.set(0, 0, zc); cell.add(conv);
  const CL = Math.max(2.2, W + 1.6), CT = 0.8;
  const beltM = new THREE.Mesh(new THREE.BoxGeometry(CL, 0.04, 0.24), belt); beltM.position.y = CT - 0.02; conv.add(beltM);
  for(const s of [-1, 1]){ const rail = new THREE.Mesh(new RoundedBoxGeometry(CL + 0.04, 0.07, 0.03, 2, 0.006), alu); rail.position.set(0, CT - 0.01, s * 0.135); conv.add(rail); }
  for(let x = -CL / 2 + 0.2; x <= CL / 2 - 0.2; x += 0.6) for(const s of [-1, 1]){ const leg = new THREE.Mesh(new THREE.BoxGeometry(0.04, CT - 0.04, 0.04), steel); leg.position.set(x, (CT - 0.04) / 2, s * 0.12); conv.add(leg); }
  const carrier = new THREE.Group(); carrier.position.y = CT; conv.add(carrier);
  const carrierPlate = new THREE.Mesh(new RoundedBoxGeometry(W + 0.04, 0.012, 0.12, 2, 0.004), alu); carrierPlate.position.y = 0.006; carrier.add(carrierPlate);
  const queued = [];
  for(let j = 0; j < c; j++){ const m = new THREE.Mesh(gearGeometry(), gearSteel); m.position.set(-W / 2 + P / 2 + j * P, 0.012, 0); carrier.add(m); queued.push(m); }
  shadow(conv);

  /* ---------- stack light: green while the cell runs ---------- */
  const lamp = new THREE.Group(); lamp.position.set(area.x1 - 0.15, 0, zb); cell.add(lamp);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1.6, 12), steel); pole.position.y = 0.8; lamp.add(pole);
  const lights = [0x2ecc40, 0xffb000, 0xe0261b].map((col, k) => {
    const m = new THREE.Mesh(roundCyl(0.04, 0.07, 0.008, 24), new THREE.MeshPhysicalMaterial({ color: col, emissive: col, emissiveIntensity: 0.05, roughness: 0.2, transmission: 0, clearcoat: 1 }));
    m.position.y = 1.64 + k * 0.075; lamp.add(m); return m;
  });
  shadow(lamp);

  /* ---------- the arm: base, turret (axis 1), shoulder (2), elbow (3), wrist pitch (5), tool roll (6) ---------- */
  const robot = new THREE.Group(); robot.position.set(0, 0, zb); cell.add(robot);
  const base = new THREE.Mesh(new RoundedBoxGeometry(0.72, 0.1, 0.72, 2, 0.02), cast); base.position.y = 0.05; robot.add(base);
  const bolts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.018, 0.018, 0.02, 6), steel, 8);
  { const m4 = new THREE.Matrix4(); for(let k = 0; k < 8; k++){ const a = k / 8 * Math.PI * 2 + Math.PI / 8; m4.makeTranslation(Math.cos(a) * 0.31, 0.11, Math.sin(a) * 0.31); bolts.setMatrixAt(k, m4); } }
  robot.add(bolts);
  const j1 = new THREE.Group(); j1.position.y = 0.1; robot.add(j1);
  const turret = new THREE.Mesh(roundCyl(0.3, 0.34, 0.05, 48), paint); turret.position.y = 0.17; j1.add(turret);
  const yoke = new THREE.Mesh(new RoundedBoxGeometry(0.46, 0.36, 0.42, 3, 0.07), paint); yoke.position.set(0, 0.48, OS * 0.6); j1.add(yoke);
  const m1 = new THREE.Mesh(roundCyl(0.1, 0.22, 0.02), cast); m1.rotation.z = Math.PI / 2; m1.position.set(0.3, 0.26, -0.14); j1.add(m1);
  const j2 = new THREE.Group(); j2.position.set(0, HS - 0.1, OS); j1.add(j2);
  const sh = new THREE.Mesh(roundCyl(0.2, 0.52, 0.04), paint); sh.rotation.z = Math.PI / 2; j2.add(sh);
  const m2 = new THREE.Mesh(roundCyl(0.12, 0.2, 0.02), cast); m2.rotation.z = Math.PI / 2; m2.position.x = -0.36; j2.add(m2);
  const cap2 = new THREE.Mesh(roundCyl(0.09, 0.04, 0.01), black); cap2.rotation.z = Math.PI / 2; cap2.position.x = -0.48; j2.add(cap2);
  const upper = new THREE.Mesh(new RoundedBoxGeometry(0.2, L1 + 0.1, 0.28, 3, 0.06), paint); upper.position.set(0.16, L1 / 2, 0); j2.add(upper);
  // cable harness along the upper arm
  const harness = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(-0.27, -0.05, -0.12), new THREE.Vector3(-0.2, L1 * 0.35, -0.2), new THREE.Vector3(-0.2, L1 * 0.7, -0.18), new THREE.Vector3(-0.12, L1 + 0.02, -0.12)]), 24, 0.025, 10), black);
  j2.add(harness);
  const j3 = new THREE.Group(); j3.position.set(0, L1, 0); j2.add(j3);
  const el = new THREE.Mesh(roundCyl(0.15, 0.42, 0.03), paint); el.rotation.z = Math.PI / 2; el.position.x = 0.02; j3.add(el);
  const m3 = new THREE.Mesh(roundCyl(0.1, 0.24, 0.02), cast); m3.rotation.x = Math.PI / 2; m3.position.set(-0.05, -0.04, -0.22); j3.add(m3);
  const fore = new THREE.Mesh(new RoundedBoxGeometry(0.17, L2 - 0.1, 0.19, 3, 0.05), paint); fore.position.set(-0.02, (L2 - 0.1) / 2 + 0.05, 0); j3.add(fore);
  const j5 = new THREE.Group(); j5.position.set(-0.02, L2, 0); j3.add(j5);
  const wr = new THREE.Mesh(roundCyl(0.075, 0.2, 0.02), cast); wr.rotation.z = Math.PI / 2; j5.add(wr);
  const wl = new THREE.Mesh(roundCyl(0.06, 0.12, 0.015), paint); wl.position.y = 0.07; j5.add(wl);
  const j6 = new THREE.Group(); j6.position.y = 0.13; j5.add(j6);
  const flange = new THREE.Mesh(roundCyl(0.055, 0.025, 0.006), steel); flange.position.y = 0.012; j6.add(flange);
  // the row gripper: an aluminium bar with one suction cup per gear and blue air hoses. Its frame has its origin
  // at the cup tips and +y pointing on towards the work (down, while it works).
  const grip = new THREE.Group(); grip.position.y = L3 - 0.13; j6.add(grip);
  const stemL = (L3 - 0.13) - 0.025 - 0.07;
  const stem = new THREE.Mesh(new THREE.BoxGeometry(0.05, stemL, 0.05), alu); stem.position.y = -0.07 - stemL / 2; grip.add(stem);
  const bar = new THREE.Mesh(new RoundedBoxGeometry(W + 0.06, 0.04, 0.05, 2, 0.006), alu); bar.position.y = -0.05; grip.add(bar);
  const carried = [];
  for(let j = 0; j < c; j++){
    const x = -W / 2 + P / 2 + j * P;
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.012, 0.03, 20), black); cup.position.set(x, -0.015, 0); grip.add(cup);
    const h = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(x, -0.07, 0.022), new THREE.Vector3(x * 0.55, -0.09, 0.05), new THREE.Vector3(0, -0.13, 0.03)]), 12, 0.006, 8), hose);
    grip.add(h);
    const g = new THREE.Mesh(gearGeometry(), gearSteel); g.position.set(x, 0, 0); g.visible = false; grip.add(g); carried.push(g);
  }
  shadow(robot);

  /* ---------- where the tool is: inverse kinematics in the arm's plane ---------- */
  const tmp = new THREE.Vector3();
  /** Point the tool (cup tips) at a world position, the bar along the world direction `yaw`. */
  function reachTo(p, yaw){
    tmp.copy(p).sub(robot.position);
    const th = Math.atan2(tmp.x, tmp.z), reach = Math.hypot(tmp.x, tmp.z);
    j1.rotation.y = th;
    const d = reach - OS, h = p.y + L3 - HS - 0.0;
    const Dl = Math.min(L1 + L2 - 0.005, Math.max(Math.abs(L1 - L2) + 0.01, Math.hypot(d, h)));
    const phi = Math.atan2(d, h), beta = Math.acos(Math.min(1, Math.max(-1, (L1 * L1 + Dl * Dl - L2 * L2) / (2 * L1 * Dl))));
    const a2 = phi - beta;
    const ex = L1 * Math.sin(a2), ey = L1 * Math.cos(a2);
    const tx = Math.sin(phi) * Dl, ty = Math.cos(phi) * Dl;
    const a23 = Math.atan2(tx - ex, ty - ey);
    j2.rotation.x = a2; j3.rotation.x = a23 - a2; j5.rotation.x = Math.PI - a23;
    let roll = th - yaw; while(roll > Math.PI / 2) roll -= Math.PI; while(roll < -Math.PI / 2) roll += Math.PI;
    j6.rotation.y = roll;
  }
  // task-space poses: where the cup tips are, and which way the bar points
  const rowPoint = i => { const q = at(i, 0).setX(0); q.y = GEAR_T; return tray.localToWorld(q); };
  const pickPoint = () => new THREE.Vector3(0, CT + 0.012 + GEAR_T, zc);
  const lift = (p, dy) => p.clone().setY(p.y + dy);
  const home = () => ({ p: new THREE.Vector3(0, PLATE + 0.45, zb + Math.max(0.8, D * 0.45)), yaw: 0 });
  let pose = home(); reachTo(pose.p, pose.yaw);

  /* ---------- one row per cycle: pick from the conveyor, swing round, set it down, swing back ---------- */
  let run = null;
  const lightsOn = on => { lights[0].material.emissiveIntensity = on ? 2.2 : 0.05; lights[1].material.emissiveIntensity = on ? 0.05 : 0.6; };
  lightsOn(false);
  const showRow = (i, on) => parts.forEach(m => { if(m.userData.row === i + 1) m.visible = on; });
  function reveal(){
    parts.forEach(m => { m.visible = false; m.userData.t0 = 0; });
    if(reduced()){ for(let i = 0; i < r; i++){ showRow(i, true); hooks.onReveal && hooks.onReveal(i + 1); } hooks.onRevealDone && hooks.onRevealDone(); return; }
    run = { row: 0, t: 0, from: pose, seg: 0 }; lightsOn(true);
    carried.forEach(m => { m.visible = false; }); queued.forEach(m => { m.visible = true; m.material = gearMat(0); }); carrier.position.x = 0;
  }
  const yawOf = () => tray.rotation.y;
  /** The keyframes of row i: [pose, seconds to get there, what happens on arrival]. */
  function cycle(i){
    const pk = pickPoint(), rp = rowPoint(i), hi = Math.max(pk.y, rp.y) + 0.28;
    return [
      [{ p: lift(pk, hi - pk.y), yaw: 0 }, 0.55],
      [{ p: pk, yaw: 0 }, 0.32, () => { queued.forEach(m => { m.visible = false; }); carried.forEach((m, j) => { m.visible = true; m.material = gearMat(i); }); }],
      [{ p: lift(pk, hi - pk.y), yaw: 0 }, 0.3, () => { if(i + 1 < r){ carrier.position.x = -(CL - W) / 2 + 0.03; queued.forEach(m => { m.visible = true; m.material = gearMat(i + 1); }); } }],
      [{ p: lift(rp, hi - rp.y), yaw: yawOf() }, 0.75],
      [{ p: rp, yaw: yawOf() }, 0.32, () => { carried.forEach(m => { m.visible = false; }); showRow(i, true); parts.forEach(m => { if(m.userData.row === i + 1) m.userData.t0 = performance.now(); }); hooks.onReveal && hooks.onReveal(i + 1); }],
      [{ p: lift(rp, hi - rp.y), yaw: yawOf() }, 0.28],
    ];
  }
  function update(dt, now){
    tray.rotation.y += ((st.rot) - tray.rotation.y) * (reduced() ? 1 : Math.min(1, dt * 3));
    // set-down: a gear seats on its pin with a tiny settle
    parts.forEach(m => { if(m.userData.t0){ const t = (now - m.userData.t0) / 260; m.position.y = t >= 1 ? 0 : 0.012 * (1 - t); if(t >= 1) m.userData.t0 = 0; } });
    // the carrier with the next row slides in along the belt
    if(carrier.position.x < 0){ carrier.position.x = Math.min(0, carrier.position.x + dt * 1.4); belt.map.offset.x -= dt * 1.4 / CL * 6; }
    if(!run) return;
    run.t += dt;
    const keys = run.keys ??= cycle(run.row);
    const [to, dur, arrive] = keys[run.seg];
    const k = ease(run.t / dur);
    const p = run.from.p.clone().lerp(to.p, k);
    // swinging round, the tool goes over the arm's side, not through the robot
    if(run.seg === 0 || run.seg === 3){ const mid = Math.sin(k * Math.PI); p.y += mid * 0.08; }
    let dy = to.yaw - run.from.yaw; while(dy > Math.PI / 2) dy -= Math.PI; while(dy < -Math.PI / 2) dy += Math.PI;
    pose = { p, yaw: run.from.yaw + dy * k };
    reachTo(pose.p, pose.yaw);
    if(run.t >= dur){
      arrive && arrive();
      run.from = { p: to.p.clone(), yaw: to.yaw }; run.t = 0; run.seg++;
      if(run.seg >= keys.length){
        if(run.final){ run = null; hooks.onRevealDone && hooks.onRevealDone(); return; }
        run.row++; run.seg = 0; run.keys = null;
        // all rows down: back to watching the pallet
        if(run.row >= r){ run.final = true; run.keys = [[home(), 0.8, () => lightsOn(false)]]; }
      }
    }
  }
  const st = { rot: 0 };
  return {
    pickables, tray,
    reveal, update,
    setRot(on){ st.rot = on ? Math.PI / 2 : 0; },
    // labels on the sides the camera sees, away from the arm: the left end of a middle row, the front end of a middle column
    anchors: {
      row: () => tray.localToWorld(at(Math.floor(r / 2), 0).setX(-W / 2 - 0.12).setY(0.06)),
      col: () => tray.localToWorld(at(r - 1, Math.floor(c / 2)).setZ(D / 2 + 0.12).setY(0.06)),
      total: () => tray.localToWorld(new THREE.Vector3(0, 0.3, 0)),
      robot: () => j3.localToWorld(new THREE.Vector3(0, 0.1, 0)),
    },
    view: { target: new THREE.Vector3(0, PLATE + 0.2, zb * 0.4), dist: Math.max(W, D) * 1.2 + 3.9, min: 0.8, az: 0.5, el: 0.74 },
    shadowR: Math.max(W, D) / 2 + 2.6,
    dispose(){ run = null; },
  };
}
