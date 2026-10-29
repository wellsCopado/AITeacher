import * as THREE from 'three';
import {EXRLoader} from 'three/addons/loaders/EXRLoader.js';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';

/* The host of the end-of-lesson chat: a reception robot like the ones in museums and banks (about 1.2 m tall),
   glossy white plastic, a black glass visor with LED eyes and an LED mouth that moves while it speaks, a light
   ring on its chest, jointed arms. It talks while the Pad reads a line, nods when the child answers, waves
   goodbye. Lit by a real indoor HDRI with a soft contact shadow. */

const ease = t => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
function room(){
  const A = window.ASSETS, bin = atob(A.hdr_apartment.split(',')[1]), buf = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const loader = new EXRLoader(); loader.setDataType(THREE.HalfFloatType);
  const d = loader.parse(buf.buffer);
  const t = new THREE.DataTexture(d.data, d.width, d.height, d.format, d.type);
  t.colorSpace = THREE.LinearSRGBColorSpace; t.minFilter = t.magFilter = THREE.LinearFilter; t.generateMipmaps = false; t.flipY = d.flipY ?? false;
  t.mapping = THREE.EquirectangularReflectionMapping; t.needsUpdate = true; return t;
}
const lathe = (pts, seg = 48) => new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), seg);

export function createHost(stage, { reduced = () => false } = {}){
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(1.75, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  stage.prepend(renderer.domElement);
  const scene = new THREE.Scene(), pm = new THREE.PMREMGenerator(renderer);
  const env = pm.fromEquirectangular(room());
  scene.environment = env.texture; scene.background = env.texture; scene.backgroundBlurriness = 0.62; scene.backgroundIntensity = 0.75;
  const cam = new THREE.PerspectiveCamera(28, 1, 0.05, 50);
  const key = new THREE.DirectionalLight(0xfff4e6, 1.5); key.position.set(1.6, 3.2, 2.4); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024); key.shadow.radius = 6; key.shadow.bias = -0.0004;
  Object.assign(key.shadow.camera, { left: -1, right: 1, top: 1.6, bottom: -0.2, near: 0.5, far: 8 }); scene.add(key);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.ShadowMaterial({ opacity: 0.28 })); floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);

  /* ---------- materials ---------- */
  const white = new THREE.MeshPhysicalMaterial({ color: 0xf3f4f6, roughness: 0.3, clearcoat: 0.85, clearcoatRoughness: 0.12 });
  const grey = new THREE.MeshStandardMaterial({ color: 0x5d6168, roughness: 0.45, metalness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x24272b, roughness: 0.6 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x06080b, roughness: 0.06, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, reflectivity: 0.6 });
  const led = new THREE.MeshBasicMaterial({ color: 0x6fe6ff, toneMapped: false });
  const ledSoft = new THREE.MeshBasicMaterial({ color: 0x3fb8d8, toneMapped: false, transparent: true, opacity: 0.85 });

  /* ---------- body ---------- */
  const bot = new THREE.Group(); scene.add(bot);
  const add = (geo, mat, parent = bot) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; };
  add(lathe([[0, 0.01], [0.27, 0.01], [0.285, 0.03], [0.285, 0.07], [0.27, 0.085], [0, 0.085]]), dark);           // bumper
  add(lathe([[0, 0.08], [0.27, 0.08], [0.25, 0.2], [0.215, 0.36], [0.19, 0.46], [0, 0.46]]), white);              // skirt
  const torso = new THREE.Group(); torso.position.y = 0.46; bot.add(torso);
  add(lathe([[0, 0], [0.19, 0], [0.215, 0.09], [0.225, 0.2], [0.215, 0.32], [0.18, 0.41], [0.11, 0.46], [0, 0.465]]), white, torso);
  // chest: a black glass panel with a light ring
  const chest = add(new RoundedBoxGeometry(0.2, 0.15, 0.04, 4, 0.02), glass, torso); chest.position.set(0, 0.24, 0.205); chest.rotation.x = -0.08;
  const ring = add(new THREE.TorusGeometry(0.045, 0.006, 12, 48), led, torso); ring.position.set(0, 0.245, 0.228); ring.rotation.x = -0.08; ring.castShadow = false;
  const neck = add(new THREE.CylinderGeometry(0.05, 0.06, 0.07, 32), grey, torso); neck.position.y = 0.48;
  // head: white shell, glass visor, LED eyes and mouth, ear lights
  const head = new THREE.Group(); head.position.y = 0.6; torso.add(head);
  const shell = add(new THREE.SphereGeometry(0.17, 48, 32), white, head); shell.scale.set(1.08, 0.92, 1);
  // a sphere patch centred on the face (+z is at phi = pi/2)
  const visor = add(new THREE.SphereGeometry(0.165, 48, 32, Math.PI * 0.14, Math.PI * 0.72, Math.PI * 0.26, Math.PI * 0.42), glass, head);
  visor.scale.set(1.1, 0.95, 1.06); visor.position.z = 0.004;
  const onVisor = (x, y) => Math.sqrt(0.165 ** 2 - (x / 1.1) ** 2 - (y / 0.95) ** 2) * 1.06 + 0.004;
  const eyes = [-1, 1].map(s => { const e = add(new THREE.CapsuleGeometry(0.014, 0.022, 6, 16), led, head); e.position.set(s * 0.055, 0.025, 0.172); e.rotation.x = -0.1; e.castShadow = false; return e; });
  const mouth = [...Array(7)].map((_, k) => { const b = add(new THREE.BoxGeometry(0.009, 0.02, 0.004), ledSoft, head); b.position.set((k - 3) * 0.014, -0.045, onVisor((k - 3) * 0.014, -0.045) + 0.003); b.castShadow = false; return b; });
  for(const s of [-1, 1]){
    const ear = add(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 32), grey, head); ear.rotation.z = Math.PI / 2; ear.position.x = s * 0.185;
    const el = add(new THREE.TorusGeometry(0.03, 0.004, 8, 32), led, head); el.rotation.y = Math.PI / 2; el.position.x = s * 0.2; el.castShadow = false;
  }
  // arms: shoulder ball, upper arm, elbow, forearm, hand
  const arms = [-1, 1].map(s => {
    const sh = new THREE.Group(); sh.position.set(s * 0.235, 0.36, 0); torso.add(sh);
    add(new THREE.SphereGeometry(0.05, 24, 16), grey, sh);
    const up = add(new THREE.CapsuleGeometry(0.042, 0.13, 8, 20), white, sh); up.position.y = -0.1;
    const el = new THREE.Group(); el.position.y = -0.19; sh.add(el);
    add(new THREE.SphereGeometry(0.038, 20, 14), grey, el);
    const fo = add(new THREE.CapsuleGeometry(0.036, 0.12, 8, 20), white, el); fo.position.y = -0.09;
    const hand = add(new THREE.SphereGeometry(0.042, 24, 16), dark, el); hand.scale.set(0.85, 1.15, 0.7); hand.position.y = -0.19;
    sh.rotation.z = s * 0.12;
    return { sh, el, s };
  });

  /* ---------- behaviour ---------- */
  let talking = 0, nodT = -1, waveT = -1, blinkT = 2 + Math.random() * 2, t = 0, raf = 0, dead = false;
  const levels = mouth.map(() => 0.2);
  const clock = new THREE.Clock();
  function resize(){ const r = stage.getBoundingClientRect(); renderer.setSize(Math.max(1, r.width), Math.max(1, r.height), false); cam.aspect = r.width / Math.max(1, r.height); cam.updateProjectionMatrix();
    // frame the upper body whatever the shape of the box
    const tall = cam.aspect < 0.9; cam.position.set(0.32, tall ? 1.05 : 0.98, tall ? 2.9 : 2.25); cam.lookAt(0, tall ? 0.72 : 0.8, 0); }
  const ro = new ResizeObserver(resize); ro.observe(stage); resize();
  function frame(){
    if(dead) return; raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, clock.getDelta()), rm = reduced(); t += dt;
    // breathing and a slow look around; while talking it faces the child and moves a little more
    torso.position.y = 0.46 + (rm ? 0 : Math.sin(t * 1.6) * 0.003);
    let yaw = rm ? 0 : Math.sin(t * 0.37) * 0.16 + Math.sin(t * 0.91) * 0.04, pitch = rm ? 0 : Math.sin(t * 0.53) * 0.04;
    if(talking){ yaw *= 0.35; pitch += Math.sin(t * 5.2) * 0.025; }
    if(nodT >= 0){ nodT += dt; pitch += Math.sin(Math.min(1, nodT / 0.7) * Math.PI * 2) * 0.16; if(nodT > 0.7) nodT = -1; }
    head.rotation.set(pitch, yaw, rm ? 0 : Math.sin(t * 0.29) * 0.03);
    // blink
    blinkT -= dt; const closed = blinkT < 0 && blinkT > -0.13; if(blinkT < -0.13) blinkT = 2.5 + Math.random() * 3;
    eyes.forEach(e => { e.scale.y = closed ? 0.12 : talking ? 1 + Math.sin(t * 3) * 0.05 : 1; });
    // LED mouth: a little equaliser while it speaks, a calm line when it listens
    mouth.forEach((b, k) => { const want = talking && !rm ? 0.35 + Math.abs(Math.sin(t * (9 + k * 1.7) + k)) * (1 - Math.abs(k - 3) / 4.5) * 1.6 : 0.25;
      levels[k] += (want - levels[k]) * Math.min(1, dt * 18); b.scale.y = levels[k]; });
    ring.scale.setScalar(talking && !rm ? 1 + Math.sin(t * 6) * 0.08 : 1);
    // arms: rest, gesture while talking, wave goodbye
    const [L, R] = arms;
    L.sh.rotation.x = talking && !rm ? -0.25 + Math.sin(t * 1.3) * 0.12 : Math.sin(t * 0.8) * 0.03;
    L.el.rotation.x = talking && !rm ? -0.55 + Math.sin(t * 1.7) * 0.15 : -0.08;
    if(waveT >= 0){ waveT += dt; const up = ease(Math.min(1, waveT / 0.5)) * ease(Math.min(1, (2.6 - waveT) / 0.5));
      R.sh.rotation.z = 0.12 + up * 2.3; R.sh.rotation.x = -up * 0.3; R.el.rotation.z = up * Math.sin(waveT * 9) * 0.45; R.el.rotation.x = -up * 0.25;
      if(waveT > 2.6){ waveT = -1; R.el.rotation.z = 0; } }
    else { R.sh.rotation.z = 0.12; R.sh.rotation.x = talking && !rm ? -0.12 + Math.sin(t * 1.1 + 1) * 0.08 : Math.sin(t * 0.8 + 1) * 0.03; R.el.rotation.x = talking && !rm ? -0.3 : -0.08; }
    L.sh.rotation.z = -0.12;
    renderer.render(scene, cam);
  }
  frame();
  return {
    talk(on){ talking = Math.max(0, talking + (on ? 1 : -1)); },
    nod(){ nodT = 0; },
    wave(){ if(!reduced()) waveT = 0; },
    dispose(){ dead = true; cancelAnimationFrame(raf); ro.disconnect(); scene.traverse(n => { if(n.isMesh) n.geometry.dispose(); }); env.dispose(); pm.dispose(); renderer.dispose(); renderer.domElement.remove(); },
  };
}
