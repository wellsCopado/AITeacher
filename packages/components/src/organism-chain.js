import * as THREE from 'three';

/* Any animal from one photoreal top view, with no hand-made rig: worms, eels, fish, snakes, caterpillars…
   The picture's outline gives the body axis; the body is cut into segments along it, each segment gets a
   rounded relief from the outline (a tube-like cross-section), and the segments are chained from the tail,
   which stays in the burrow, to the head, which moves freely. Like an ambush worm or a garden eel it keeps most
   of itself in the burrow: the front rises out of the sand and sways, strikes (also slowed down), goes back,
   and lies out on the sand coming apart segment by segment for the anatomy view. A picture without transparency has its plain
   background keyed out from the edges. Same controller as organism.js, so the scene treats both alike. */

const ease = t => t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t);
const OUT = 0.3; // share of the body out of the burrow while it waits
function loadImage(url){ return new Promise((res, rej) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = rej; i.src = url; }); }

/** Texture canvas with a clean alpha, and the body mask on a coarse grid. */
async function cutout(url){
  const img = await loadImage(url);
  const k = Math.min(1, 1024 / Math.max(img.width, img.height));
  const W = Math.max(8, Math.round(img.width * k)), H = Math.max(8, Math.round(img.height * k));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, W, H);
  const id = g.getImageData(0, 0, W, H), d = id.data, n = W * H;
  let clear = 0; for(let i = 0; i < n; i++) if(d[i * 4 + 3] < 250) clear++;
  if(clear < n * 0.01){
    // no transparency: the background is whatever touches the edges and looks like them
    let r = 0, gg = 0, b = 0, m = 0;
    const edge = i => { r += d[i * 4]; gg += d[i * 4 + 1]; b += d[i * 4 + 2]; m++; };
    for(let x = 0; x < W; x++){ edge(x); edge((H - 1) * W + x); }
    for(let y = 0; y < H; y++){ edge(y * W); edge(y * W + W - 1); }
    r /= m; gg /= m; b /= m;
    const near = i => Math.hypot(d[i * 4] - r, d[i * 4 + 1] - gg, d[i * 4 + 2] - b) < 46;
    const bg = new Uint8Array(n), stack = [];
    const push = i => { if(!bg[i] && near(i)){ bg[i] = 1; stack.push(i); } };
    for(let x = 0; x < W; x++){ push(x); push((H - 1) * W + x); }
    for(let y = 0; y < H; y++){ push(y * W); push(y * W + W - 1); }
    while(stack.length){ const i = stack.pop(), x = i % W, y = (i - x) / W;
      if(x > 0) push(i - 1); if(x < W - 1) push(i + 1); if(y > 0) push(i - W); if(y < H - 1) push(i + W); }
    for(let i = 0; i < n; i++) if(bg[i]) d[i * 4 + 3] = 0;
    g.putImageData(id, 0, 0);
  }
  // the coarse grid the relief is built on
  const step = Math.max(1, Math.round(Math.max(W, H) / 220)), gw = Math.ceil(W / step), gh = Math.ceil(H / step);
  let mask = new Uint8Array(gw * gh);
  for(let y = 0; y < gh; y++) for(let x = 0; x < gw; x++){
    const px = Math.min(W - 1, x * step + (step >> 1)), py = Math.min(H - 1, y * step + (step >> 1));
    mask[y * gw + x] = d[(py * W + px) * 4 + 3] > 60 ? 1 : 0;
  }
  // keep the biggest piece (specks and stray background go)
  const lab = new Int32Array(gw * gh).fill(-1); let best = -1, bestN = 0;
  for(let s = 0; s < gw * gh; s++){
    if(!mask[s] || lab[s] >= 0) continue;
    const st = [s]; lab[s] = s; let cnt = 0;
    while(st.length){ const i = st.pop(); cnt++; const x = i % gw, y = (i - x) / gw;
      for(const j of [x > 0 ? i - 1 : -1, x < gw - 1 ? i + 1 : -1, y > 0 ? i - gw : -1, y < gh - 1 ? i + gw : -1]) if(j >= 0 && mask[j] && lab[j] < 0){ lab[j] = s; st.push(j); } }
    if(cnt > bestN){ bestN = cnt; best = s; }
  }
  mask = mask.map((v, i) => v && lab[i] === best ? 1 : 0);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  return { tex, W, H, step, gw, gh, mask };
}

/** Distance to the outline in grid cells (two-pass chamfer). */
function distance(mask, gw, gh){
  const D = new Float32Array(gw * gh), INF = 1e9;
  for(let i = 0; i < D.length; i++) D[i] = mask[i] ? INF : 0;
  const at = (x, y) => (x < 0 || y < 0 || x >= gw || y >= gh) ? 0 : D[y * gw + x];
  for(let y = 0; y < gh; y++) for(let x = 0; x < gw; x++){ const i = y * gw + x; if(!D[i]) continue;
    D[i] = Math.min(D[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + 1.414, at(x + 1, y - 1) + 1.414); }
  for(let y = gh - 1; y >= 0; y--) for(let x = gw - 1; x >= 0; x--){ const i = y * gw + x; if(!D[i]) continue;
    D[i] = Math.min(D[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + 1.414, at(x - 1, y + 1) + 1.414); }
  return D;
}

export function createChainOrganism({ parent, o, outDir, puff, reduced, stage }){
  const ctl = { ready:false, pickables:[], mode:'hidden', anchor:null, dispose(){} };
  const clip = new THREE.Plane(new THREE.Vector3(outDir.x, 0, outDir.y), 0);
  const root = new THREE.Group(); parent.add(root);
  const out = new THREE.Vector2(outDir.x, outDir.y);
  const segs = []; let L = o.lengthM || 0.3, labels = [];
  const st = { t:0, out:0, outTo:0, sway:0, strike:null, explode:0, explodeTo:0, mode:'hidden' };

  cutout(o.url).then(({ tex, W, H, step, gw, gh, mask }) => {
    if(ctl.dead) return;
    // body axis from the outline's spread; the head is the end towards the picture's left (or top)
    let cx = 0, cy = 0, m = 0;
    for(let y = 0; y < gh; y++) for(let x = 0; x < gw; x++) if(mask[y * gw + x]){ cx += x; cy += y; m++; }
    if(m < 20) throw new Error('outline too small');
    cx /= m; cy /= m;
    let sxx = 0, syy = 0, sxy = 0;
    for(let y = 0; y < gh; y++) for(let x = 0; x < gw; x++) if(mask[y * gw + x]){ const a = x - cx, b = y - cy; sxx += a * a; syy += b * b; sxy += a * b; }
    let th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    let ax = Math.cos(th), ay = Math.sin(th);
    if(Math.abs(ax) >= Math.abs(ay) ? ax < 0 : ay < 0){ ax = -ax; ay = -ay; }
    const U = (x, y) => (x - cx) * ax + (y - cy) * ay, V = (x, y) => -(x - cx) * ay + (y - cy) * ax;
    let u0 = Infinity, u1 = -Infinity, vmax = 0;
    for(let y = 0; y < gh; y++) for(let x = 0; x < gw; x++) if(mask[y * gw + x]){ const u = U(x, y); u0 = Math.min(u0, u); u1 = Math.max(u1, u); vmax = Math.max(vmax, Math.abs(V(x, y))); }
    const len = u1 - u0, N = Math.max(6, Math.min(16, Math.round(len / Math.max(1, vmax) * 1.6)));
    const s = L / len; // metres per grid cell
    const D = distance(mask, gw, gh);
    const seg = (x, y) => Math.min(N - 1, Math.floor((U(x, y) - u0) / len * N));
    const half = new Float32Array(N);
    for(let i = 0; i < gw * gh; i++) if(mask[i]){ const x = i % gw, y = (i - x) / gw, k = seg(x, y); half[k] = Math.max(half[k], D[i]); }
    // a rounded cross-section: highest along the middle, down to the sand at the outline
    const height = (x, y) => { if(x < 0 || y < 0 || x >= gw || y >= gh || !mask[y * gw + x]) return 0;
      const w = Math.max(1, half[seg(x, y)]), dd = Math.min(D[y * gw + x], w); return Math.sqrt(Math.max(0, dd * (2 * w - dd))) * 0.85; };
    const mat = new THREE.MeshPhysicalMaterial({ map:tex, alphaTest:0.45, roughness:0.38, metalness:0, clearcoat:0.75, clearcoatRoughness:0.25,
      side:THREE.DoubleSide, clippingPlanes:[clip], envMapIntensity:1.1 });
    const depth = new THREE.MeshDepthMaterial({ depthPacking:THREE.RGBADepthPacking, map:tex, alphaTest:0.45, clippingPlanes:[clip] });
    // segment k's joint is its tail-side edge; the tail end is the root and stays in the burrow
    const jointU = k => u0 + (k + 1) * len / N;
    for(let k = 0; k < N; k++){
      const pu = jointU(k), pos = [], uv = [], idx = [], at = new Map();
      const vert = (gx, gy) => {
        const key = gy * (gw + 1) + gx; if(at.has(key)) return at.get(key);
        const h = (height(gx, gy) + height(gx - 1, gy) + height(gx, gy - 1) + height(gx - 1, gy - 1)) / 4;
        pos.push((U(gx - 0.5, gy - 0.5) - pu) * s, h * s, V(gx - 0.5, gy - 0.5) * s);
        uv.push(Math.min(1, gx * step / W), 1 - Math.min(1, gy * step / H)); at.set(key, pos.length / 3 - 1); return pos.length / 3 - 1;
      };
      for(let gy = 0; gy < gh; gy++) for(let gx = 0; gx < gw; gx++){
        if(!mask[gy * gw + gx] || seg(gx, gy) !== k) continue;
        const a = vert(gx, gy), b = vert(gx + 1, gy), c = vert(gx, gy + 1), e = vert(gx + 1, gy + 1);
        idx.push(a, c, b, b, c, e);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx); geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, mat); mesh.castShadow = true; mesh.receiveShadow = true; mesh.customDepthMaterial = depth;
      mesh.userData = { kind:'shrimp' };
      const g = new THREE.Group(); g.add(mesh);
      segs.push({ g, mesh, u:pu, len:len / N * s });
      ctl.pickables.push(mesh);
    }
    // chain from the tail (root) to the head; local x runs from the tail tip (0) towards the head (negative)
    for(let k = N - 1; k >= 0; k--){
      const q = segs[k];
      if(k === N - 1){ root.add(q.g); q.base = new THREE.Vector3((q.u - u1) * s, 0, 0); }
      else { segs[k + 1].g.add(q.g); q.base = new THREE.Vector3((q.u - segs[k + 1].u) * s, 0, 0); }
      q.g.position.copy(q.base);
    }
    L = len * s;
    const names = [['头部', 0], [`身体（共 ${N} 节）`, Math.floor(N / 2)], ['尾部', N - 1]];
    for(const [name, k] of names){ const el = document.createElement('span'); el.className = 'organlab'; el.textContent = name; el.hidden = true; stage.appendChild(el); labels.push({ el, q:segs[k] }); }
    root.rotation.y = Math.atan2(out.y, -out.x);
    ctl.ready = true;
  }).catch(() => { ctl.failed = true; });

  // how far the tail tip sits behind the burrow mouth for a given share of the body that is out
  const place = share => out.clone().multiplyScalar(-L * (1 - share) - 0.02);
  function setClip(on){
    const b = new THREE.Vector3(); parent.getWorldPosition(b);
    clip.normal.set(out.x, 0, out.y);
    clip.constant = on ? -(out.x * b.x + out.y * b.z) + 0.03 : 1e3;
  }

  ctl.cmd = (c) => {
    if(!ctl.ready) return;
    if(c === 'show' && (st.mode === 'hidden' || st.mode === 'retreat')){ st.mode = 'out'; st.outTo = OUT; }
    else if(c === 'hide' && st.mode !== 'hidden'){ st.explodeTo = 0; st.mode = 'retreat'; st.outTo = 0; }
    else if(c === 'strike' || c === 'slow'){ if(st.mode === 'hidden') { ctl.cmd('show'); return; } if(!st.strike && st.explode < 0.05) st.strike = { t:0, slow:c === 'slow' ? 40 : 1 }; }
    else if(c === 'anatomy'){ if(st.mode === 'hidden' || st.mode === 'retreat') return; st.explodeTo = st.explodeTo ? 0 : 1; st.outTo = st.explodeTo ? 1.05 : OUT; }
    else if(c === 'tap'){ if(st.mode === 'hidden') ctl.cmd('show'); else if(st.explodeTo === 0) ctl.cmd('strike'); }
  };

  ctl.update = (dt) => {
    if(!ctl.ready) return;
    const rm = reduced(); st.t += dt;
    // sliding out of and back into the burrow
    let lunge = 0, lift = 0;
    if(st.strike){
      const S = st.strike; S.t += dt / S.slow;
      const go = 0.07, back = 0.6, t = S.t;
      const k = t < go ? ease(t / go) : 1 - ease((t - go) / back);
      lunge = 0.14 * k; lift = k;
      if(!S.hit && t >= go){ S.hit = true; const w = segs[0].g.getWorldPosition(new THREE.Vector3()); puff(w.x, w.z, 50, 0.5, 0.3); }
      if(t > go + back) st.strike = null;
    }
    const speed = st.mode === 'retreat' ? 2.2 : 0.6;
    st.out += Math.max(-dt * speed, Math.min(dt * speed, st.outTo - st.out)) * (rm ? 100 : 1);
    if(st.mode === 'retreat' && st.out <= 0.001){ st.mode = 'hidden'; st.out = 0; }
    if(st.mode === 'out' && Math.abs(st.out - st.outTo) < 0.01) st.mode = 'idle';
    const share = Math.max(0, Math.min(1.05, st.out + lunge));
    const p = place(share);
    const e = st.explode += (st.explodeTo - st.explode) * Math.min(1, dt * (rm ? 100 : 2.2));
    root.position.set(p.x, 0.002 + e * 0.03, p.y);
    setClip(share < 1 && e < 0.5);
    // a travelling wave along the body, strongest at the head. The front stands up out of the sand from the
    // segment at the burrow mouth, the head bent forward again; it rears higher as it strikes and lies flat to come apart.
    const N = segs.length, amp = rm ? 0 : (st.mode === 'hidden' ? 0.05 : 0.16) * (1 - e);
    const mouth = Math.min(N - 1, Math.floor(Math.min(1, share) * N)), rise = (0.55 + lift * 0.35) * (1 - e) * Math.min(1, st.out / OUT);
    segs.forEach((q, k) => {
      const f = 1 - k / N; // 1 at the head
      q.g.position.copy(q.base).add(new THREE.Vector3(-e * q.len * 0.3, 0, 0));
      const pitch = k === mouth ? -rise : k < 2 && mouth > 2 ? rise * 0.3 : 0;
      q.g.rotation.set(0, amp * f * Math.sin(st.t * 2.2 - k * 0.7) + (st.mode === 'hidden' ? 0 : 0.03 * Math.sin(st.t * 0.6)), pitch);
    });
    ctl.mode = st.mode; ctl.exploded = e > 0.5; ctl.striking = !!st.strike; ctl.slow = st.strike?.slow > 1;
  };
  ctl.anchor = () => {
    if(!ctl.ready) { const b = new THREE.Vector3(); parent.getWorldPosition(b); return b.setY(0.12); }
    return segs[0].g.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.05, 0));
  };
  ctl.center = () => (ctl.ready ? segs[Math.floor(segs.length * (st.explode > 0.5 ? 0.5 : OUT / 2))].g : root).getWorldPosition(new THREE.Vector3());
  /** How much ground the camera has to show: the part out of the burrow, and the whole body laid out. */
  ctl.frame = () => ({ focus: L * OUT + 0.06, anatomy: L * 1.3 });
  ctl.placeLabels = (project) => {
    const on = st.explode >= 0.6;
    for(const l of labels){
      l.el.hidden = !on; if(!on) continue;
      const g = l.q.mesh.geometry; if(!g.boundingSphere) g.computeBoundingSphere();
      const p = project(l.q.mesh.localToWorld(g.boundingSphere.center.clone()));
      l.el.style.left = p.x + 'px'; l.el.style.top = (p.y - 18) + 'px';
    }
  };
  ctl.dispose = () => { ctl.dead = true; labels.forEach(l => l.el.remove()); };
  return ctl;
}
