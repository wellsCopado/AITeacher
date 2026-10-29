import * as THREE from 'three';
import { createChainOrganism } from './organism-chain.js';

/* A living animal built from a photoreal top view (BL14): the picture is cut into its real body parts
   (eyes, antennae, antennal scales, raptorial claws, legs, carapace, six abdominal segments, tail fan),
   each part gets the relief of its own body from a height map, and the parts are jointed so they move
   like the animal does: eyes dart independently, antennae and scales flick, legs step, the abdomen bends
   when it turns, the tail fan spreads, and the claws strike. It also comes apart for an anatomy view.
   rig.png: R = height (px), G = part number, A = coverage. rig.json: parts, pivots, parents, offsets. */

const loader = new THREE.TextureLoader();
const cache = {};
function loadImage(url){ return new Promise((res, rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=url; }); }
async function assets(o){
  if(!cache[o.url]) cache[o.url] = (async()=>{
    const [tex, rigImg, meta] = await Promise.all([
      new Promise((res, rej)=>loader.load(o.url, res, undefined, rej)),
      loadImage(o.rig), fetch(o.rigMeta).then(r=>r.json()),
    ]);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const c = document.createElement('canvas'); c.width = rigImg.width; c.height = rigImg.height;
    const g = c.getContext('2d'); g.drawImage(rigImg, 0, 0);
    return { tex, meta, rig: g.getImageData(0, 0, c.width, c.height) };
  })();
  return cache[o.url];
}

const ease = t => t<0?0:t>1?1:t*t*(3-2*t);
const wrap = a => { while(a>Math.PI) a-=2*Math.PI; while(a<-Math.PI) a+=2*Math.PI; return a; };

export function createOrganism(args){
  // any other animal comes as one top view without a hand-made rig: it is jointed automatically
  if(!args.o.rig) return createChainOrganism(args);
  const { parent, o, outDir, puff, reduced, stage } = args;
  const ctl = { ready:false, pickables:[], mode:'hidden', anchor:null, dispose(){} };
  const clip = new THREE.Plane(new THREE.Vector3(outDir.x, 0, outDir.y), 0);
  const root = new THREE.Group(); parent.add(root);
  let parts = {}, labels = [], s = 1, W = 1, H = 1, mid = 0, originPx = [0, 0];
  const st = { pos:new THREE.Vector2(), heading:Math.atan2(outDir.y, -outDir.x), gait:0, speed:0, turn:0, t:0,
    target:null, nextWander:4, strike:null, explode:0, explodeTo:0, eyes:[{y:0,p:0,ty:0,tp:0,n:0},{y:0,p:0,ty:0,tp:0,n:0.4}], flick:0 };
  const fwd = () => new THREE.Vector2(-Math.cos(st.heading), Math.sin(st.heading));
  const out = new THREE.Vector2(outDir.x, outDir.y);

  assets(o).then(({ tex, meta, rig }) => {
    if(ctl.dead) return;
    [W, H] = meta.size; mid = meta.mid;
    s = o.lengthM / (meta.body_px[1] - meta.body_px[0]);
    const gw = rig.width, gh = rig.height, f = W / gw, d = rig.data;
    const R = (x, y) => d[(Math.min(gh-1, Math.max(0, y)) * gw + Math.min(gw-1, Math.max(0, x))) * 4];
    const PID = (x, y) => (x<0||y<0||x>=gw||y>=gh) ? 255 : d[(y * gw + x) * 4 + 1];
    originPx = [ (meta.body_px[0] + meta.body_px[1]) / 2, mid ];
    const P = (px, py, h) => new THREE.Vector3((px - originPx[0]) * s, h * s, (py - mid) * s);
    const mat = new THREE.MeshPhysicalMaterial({ map:tex, alphaTest:0.45, roughness:0.34, metalness:0, clearcoat:0.85, clearcoatRoughness:0.2,
      side:THREE.DoubleSide, clippingPlanes:[clip], envMapIntensity:1.15 });
    const depth = new THREE.MeshDepthMaterial({ depthPacking:THREE.RGBADepthPacking, map:tex, alphaTest:0.45, clippingPlanes:[clip] });

    // one relief mesh per part, positioned around its joint
    meta.parts.forEach((p, i) => {
      const pv = P(p.pivot[0], p.pivot[1], R(Math.round(p.pivot[0]/f), Math.round(p.pivot[1]/f)) * f * 0.5);
      const pos = [], uv = [], idx = [], at = new Map();
      const vert = (gx, gy, h) => {
        const k = gy * (gw + 1) + gx; if(at.has(k)) return at.get(k);
        const px = gx * f, py = gy * f, v = P(px, py, h).sub(pv);
        pos.push(v.x, v.y, v.z); uv.push(px / W, 1 - py / H); at.set(k, pos.length / 3 - 1); return pos.length / 3 - 1;
      };
      for(let gy = 0; gy < gh; gy++) for(let gx = 0; gx < gw; gx++){
        if(PID(gx, gy) !== i) continue;
        const own = R(gx, gy);
        const h = (x, y) => { const q = PID(x, y); return (q === i ? R(x, y) : q === 255 ? own * 0.55 : (R(x, y) + own) / 2) * f; };
        const a = vert(gx, gy, h(gx, gy)), b = vert(gx + 1, gy, h(gx + 1, gy)), c = vert(gx, gy + 1, h(gx, gy + 1)), e = vert(gx + 1, gy + 1, h(gx + 1, gy + 1));
        idx.push(a, c, b, b, c, e);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx); geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, mat); mesh.castShadow = true; mesh.receiveShadow = true; mesh.customDepthMaterial = depth;
      mesh.userData = { kind:'shrimp' };
      const g = new THREE.Group(); g.add(mesh);
      parts[p.key] = { g, mesh, meta:p, pv, side: p.pivot[1] < mid ? -1 : 1, base:new THREE.Vector3(), ex:new THREE.Vector3(p.explode[0] * s * f * 0.5, 0, p.explode[1] * s * f * 0.5) };
      ctl.pickables.push(mesh);
    });
    for(const [k, q] of Object.entries(parts)){
      const par = q.meta.parent ? parts[q.meta.parent] : null;
      (par ? par.g : root).add(q.g);
      q.base.copy(par ? q.pv.clone().sub(par.pv) : q.pv);
      q.g.position.copy(q.base);
    }
    // anatomy labels, one per kind of part
    const seen = new Set();
    for(const k of ['eyeA', 'antA', 'scaleA', 'clawA', 'head', 'legC', 'abd3', 'telson', 'uroB']){
      const q = parts[k]; if(!q || seen.has(q.meta.name)) continue; seen.add(q.meta.name);
      const el = document.createElement('span'); el.className = 'organlab'; el.textContent = q.meta.name; el.hidden = true; stage.appendChild(el);
      labels.push({ el, q });
    }
    hidePose();
    ctl.ready = true;
  }).catch(() => { ctl.failed = true; });

  // Inside the burrow, head just behind the rim. Peeking moves the eyes out past it.
  const eyeX = () => (285 - originPx[0]) * s; // eyes, along the body (negative = forward)
  function hidePose(){ st.heading = Math.atan2(out.y, -out.x); const k = -eyeX() - 0.02; st.pos.copy(out).multiplyScalar(-k); st.mode = 'hidden'; ctl.mode = 'hidden'; }
  function setClip(on){
    const b = new THREE.Vector3(); parent.getWorldPosition(b);
    clip.normal.set(out.x, 0, out.y);
    clip.constant = on ? -(out.x * b.x + out.y * b.z) + 0.03 : 1e3;
  }

  ctl.cmd = (c) => {
    if(!ctl.ready) return;
    if(c === 'show' && (st.mode === 'hidden' || st.mode === 'retreat')){ st.mode = 'emerge'; st.target = out.clone().multiplyScalar(0.2); }
    else if(c === 'hide' && st.mode !== 'hidden'){ st.explodeTo = 0; st.mode = 'retreat'; }
    else if(c === 'strike' || c === 'slow'){ if(st.mode === 'hidden') { ctl.cmd('show'); return; } if(!st.strike && st.explode < 0.05) st.strike = { t:0, slow:c === 'slow' ? 40 : 1 }; }
    else if(c === 'anatomy'){ if(st.mode === 'hidden' || st.mode === 'retreat') return; st.explodeTo = st.explodeTo ? 0 : 1; st.mode = 'idle'; st.target = null; }
    else if(c === 'tap'){ if(st.mode === 'hidden') ctl.cmd('show'); else if(st.explodeTo === 0) ctl.cmd('strike'); }
  };

  ctl.update = (dt, now) => {
    if(!ctl.ready) return;
    const rm = reduced(); st.t += dt;
    // locomotion
    let moving = false, turn = 0;
    if(st.mode === 'emerge' || st.mode === 'walk'){
      const to = st.target.clone().sub(st.pos), dist = to.length();
      if(dist < 0.01 || rm){ if(rm) st.pos.copy(st.target); st.mode = 'idle'; st.target = null; st.nextWander = 5 + Math.random() * 5; }
      else {
        const want = Math.atan2(to.y, -to.x), dh = wrap(want - st.heading);
        turn = Math.max(-1.4, Math.min(1.4, dh * 3)); st.heading = wrap(st.heading + turn * dt);
        const sp = Math.abs(dh) > 1.2 ? 0.015 : 0.07;
        st.pos.add(fwd().multiplyScalar(Math.min(dist, sp * dt))); moving = true;
      }
    } else if(st.mode === 'retreat'){
      // backwards into the burrow, head kept facing out, the way it escapes
      const home = out.clone().multiplyScalar(eyeX() + 0.02);
      const to = home.clone().sub(st.pos), dist = to.length();
      st.heading = wrap(st.heading + wrap(Math.atan2(out.y, -out.x) - st.heading) * Math.min(1, dt * 8));
      if(dist < 0.005 || rm){ hidePose(); }
      else { st.pos.add(to.normalize().multiplyScalar(Math.min(dist, 0.45 * dt))); moving = true; if(Math.random() < dt * 20) { const w = root.getWorldPosition(new THREE.Vector3()); puff(w.x, w.z, 3, 0.15, 0.08); } }
    } else if(st.mode === 'idle' && st.explodeTo === 0 && !st.strike){
      st.nextWander -= dt;
      if(st.nextWander <= 0){
        // wander a little in front of the burrow, never far from it
        const a = Math.atan2(out.y, out.x) + (Math.random() - 0.5) * 2.2, r = 0.12 + Math.random() * 0.22;
        st.target = new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r); st.mode = 'walk';
      }
    }
    // the clip at the burrow mouth is on while any part of it is still inside
    const inside = st.pos.dot(out) < 0.13;
    setClip(st.mode === 'hidden' || ((st.mode === 'emerge' || st.mode === 'retreat') && inside));
    st.speed += ((moving ? 1 : 0) - st.speed) * Math.min(1, dt * 6);
    st.turn += (turn - st.turn) * Math.min(1, dt * 4);
    st.gait += dt * (st.mode === 'retreat' ? 26 : 9) * st.speed;

    // peeking from the burrow: eyes come out now and then
    let peek = 0;
    if(st.mode === 'hidden' && !rm) peek = ease((Math.sin(st.t * 0.7) - 0.2) * 2) * 0.035;
    const fp = out.clone().multiplyScalar(peek);
    const e = st.explode += (st.explodeTo - st.explode) * Math.min(1, dt * (rm ? 100 : 2.2));
    root.position.set(st.pos.x + fp.x, 0.002 + e * 0.035 + st.speed * 0.002 * Math.abs(Math.sin(st.gait)), st.pos.y + fp.y);
    root.rotation.y = st.heading;

    // joints
    const P = parts;
    for(const q of Object.values(P)){ q.g.position.copy(q.base).addScaledVector(q.ex, e); q.g.rotation.set(0, 0, 0); }
    // eyes: each one on its own, quick darts then holds
    st.eyes.forEach((ey, i) => {
      ey.n -= dt;
      if(ey.n <= 0){ ey.ty = (Math.random() - 0.5) * 0.9; ey.tp = -Math.random() * 0.35; ey.n = 0.3 + Math.random() * 1.6; }
      const k = Math.min(1, dt * 18); ey.y += (ey.ty - ey.y) * k; ey.p += (ey.tp - ey.p) * k;
      const q = P[i ? 'eyeB' : 'eyeA']; if(q && !rm){ q.g.rotation.y = ey.y; q.g.rotation.z = ey.p; }
    });
    if(!rm){
      for(const [k, ph] of [['antA', 0], ['antB', 1.7]]) if(P[k]) P[k].g.rotation.y = Math.sin(st.t * 2.1 + ph) * 0.12 + Math.sin(st.t * 5.3 + ph) * 0.04;
      st.flick -= dt; const fl = st.flick > 0 ? Math.sin(st.flick * 30) * 0.18 : 0; if(st.flick < -2 - Math.random() * 3) st.flick = 0.35;
      if(P.scaleA) P.scaleA.g.rotation.y = -fl + Math.sin(st.t * 1.3) * 0.03;
      if(P.scaleB) P.scaleB.g.rotation.y = fl - Math.sin(st.t * 1.3) * 0.03;
      // legs: alternating step, the tip lifts while it swings forward
      ['legA', 'legB', 'legC', 'legD', 'legE'].forEach((k, i) => {
        const q = P[k]; if(!q) return; const ph = st.gait + i * 2.1 + (q.side > 0 ? Math.PI : 0);
        q.g.rotation.y = Math.sin(ph) * 0.32 * st.speed;
        q.g.rotation.x = -q.side * Math.max(0, Math.cos(ph)) * 0.35 * st.speed;
      });
      // abdomen follows the turn, with a slight wave while walking; tail fan breathes
      for(let i = 1; i <= 6; i++){ const q = P['abd' + i]; if(q) q.g.rotation.y = -st.turn * 0.07 + Math.sin(st.gait * 0.5 - i * 0.6) * 0.02 * st.speed; }
      const fan = 0.06 + 0.05 * Math.sin(st.t * 0.9);
      if(P.uroA) P.uroA.g.rotation.y = fan; if(P.uroB) P.uroB.g.rotation.y = -fan;
      if(P.telson) P.telson.g.rotation.z = Math.sin(st.t * 0.9) * 0.03;
    }
    // the strike: claws snap forward and back. Real ones take about 3 ms; "slow" shows it 40x slower.
    if(st.strike){
      const S = st.strike; S.t += dt / S.slow;
      const outT = 0.06, back = 0.25, t = S.t;
      const k = t < outT ? ease(t / outT) : 1 - ease((t - outT) / back);
      for(const c of ['clawA', 'clawB']){ const q = P[c]; if(!q) continue; q.g.position.x -= 0.022 * k; q.g.position.y += 0.004 * k; q.g.rotation.z = 0.5 * k; }
      if(!S.hit && t >= outT){ S.hit = true; const w = root.localToWorld(new THREE.Vector3((115 - originPx[0]) * s - 0.02, 0, 0)); puff(w.x, w.z, 45, 0.5, 0.3); }
      if(t > outT + back) st.strike = null;
    }
    if(st.mode !== 'hidden' && ctl.mode !== st.mode) ctl.mode = st.mode;
    ctl.mode = st.mode; ctl.exploded = e > 0.5; ctl.striking = !!st.strike; ctl.slow = st.strike?.slow > 1;
  };
  ctl.anchor = () => {
    const q = parts.eyeA; if(!ctl.ready || !q) { const b = new THREE.Vector3(); parent.getWorldPosition(b); return b.setY(0.12); }
    return q.g.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.05, 0));
  };
  ctl.center = () => root.getWorldPosition(new THREE.Vector3());
  // Anatomy labels sit over their part; ones that would overlap are pushed apart so every name stays readable.
  ctl.placeLabels = (project) => {
    const on = st.explode >= 0.6, boxes = [];
    for(const l of labels){
      l.el.hidden = !on; if(!on) continue;
      const g = l.q.mesh.geometry; if(!g.boundingSphere) g.computeBoundingSphere();
      const p = project(l.q.mesh.localToWorld(g.boundingSphere.center.clone()));
      boxes.push({ l, x:p.x, y:p.y, w:l.el.offsetWidth || 60, h:(l.el.offsetHeight || 20) + 4 });
    }
    boxes.sort((a, b) => a.y - b.y);
    for(let i = 0; i < boxes.length; i++) for(let j = 0; j < i; j++){
      const a = boxes[j], b = boxes[i];
      if(Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < a.h) b.y = a.y + a.h;
    }
    for(const b of boxes){ b.l.el.style.left = b.x + 'px'; b.l.el.style.top = b.y + 'px'; }
  };
  ctl.dispose = () => { ctl.dead = true; labels.forEach(l => l.el.remove()); };
  return ctl;
}
