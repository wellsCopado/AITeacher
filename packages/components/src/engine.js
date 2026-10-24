import * as THREE from 'three';
import {EXRLoader} from 'three/addons/loaders/EXRLoader.js';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';

/* Photoreal scene engine: PBR materials, real HDRI lighting, soft shadows, ACES tone mapping.
   Lesson state stays in the app; the engine only renders it and reports animation progress. */
const A = window.ASSETS;
const texLoader = new THREE.TextureLoader();
const hdrCache = {};
function hdr(name){
  if(!hdrCache[name]){
    const bin = atob(A['hdr_'+name].split(',')[1]); const buf = new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) buf[i]=bin.charCodeAt(i);
    const loader = new EXRLoader(); loader.setDataType(THREE.HalfFloatType);
    const d = loader.parse(buf.buffer);
    const t = new THREE.DataTexture(d.data, d.width, d.height, d.format, d.type);
    t.colorSpace = THREE.LinearSRGBColorSpace; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false; t.flipY = d.flipY ?? false; t.mapping = THREE.EquirectangularReflectionMapping; t.needsUpdate = true;
    hdrCache[name] = t;
  }
  return hdrCache[name];
}
function tex(key, {srgb=true, repeat=[1,1], rot=0}={}){
  const t = texLoader.load(A[key]);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); t.rotation = rot; t.center.set(.5,.5);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 8;
  return t;
}
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const easeOut=t=>1-Math.pow(1-t,3);
const settle=t=>{ if(t>=1) return 0; const e=easeOut(Math.min(1,t/0.75)); return (1-e) + (t>0.75? Math.sin((t-0.75)/0.25*Math.PI)*0.04:0); };
const reduced=()=>window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

function woodMat(color, rep, rot=0, rough=0.62){
  return new THREE.MeshStandardMaterial({color, map:tex('woodC',{repeat:rep,rot}), roughnessMap:tex('woodR',{srgb:false,repeat:rep,rot}),
    bumpMap:tex('woodB',{srgb:false,repeat:rep,rot}), bumpScale:0.6, roughness:rough, metalness:0});
}

export function create(stage, kind, params, onPick, hooks){
  const garden = kind==='PerimeterArea';
  const reef = garden && params.theme==='reef';
  const renderer = new THREE.WebGLRenderer({antialias:true, powerPreference:'high-performance'});
  renderer.setPixelRatio(Math.min(1.75, window.devicePixelRatio||1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = garden ? 0.85 : 1.05;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.localClippingEnabled = true;
  stage.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const pm = new THREE.PMREMGenerator(renderer);
  let envRT;
  if(reef){
    // underwater: light falls off with depth; env built from a vertical gradient dome
    const dome = new THREE.Scene();
    const gm = new THREE.ShaderMaterial({side:THREE.BackSide, uniforms:{}, vertexShader:'varying vec3 p;void main(){p=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader:'varying vec3 p;void main(){float t=clamp(p.y*.5+.5,0.,1.);vec3 c=mix(vec3(.03,.12,.16),vec3(.55,.85,.95),pow(t,2.2));gl_FragColor=vec4(c*1.6,1.);}'});
    dome.add(new THREE.Mesh(new THREE.SphereGeometry(10,32,16), gm));
    envRT = pm.fromScene(dome, 0.04);
    const water=new THREE.Color(0x1b5f73); scene.fog = new THREE.FogExp2(water, 0.075);
    // open water fades from lit blue near the surface to deep blue below
    { const c=document.createElement('canvas'); c.width=4; c.height=256; const g=c.getContext('2d'); const gr=g.createLinearGradient(0,0,0,256);
      gr.addColorStop(0,'#5fb3c4'); gr.addColorStop(0.45,'#25748a'); gr.addColorStop(1,'#0c3442'); g.fillStyle=gr; g.fillRect(0,0,4,256);
      const t=new THREE.CanvasTexture(c); t.colorSpace=THREE.SRGBColorSpace; scene.environment = envRT.texture; scene.background = t; }
    renderer.toneMappingExposure = 0.9;
  } else {
    envRT = pm.fromEquirectangular(hdr(garden?'park':'apartment'));
    scene.environment = envRT.texture; scene.background = envRT.texture;
    scene.backgroundBlurriness = garden ? 0.04 : 0.55; scene.backgroundIntensity = garden ? 0.95 : 0.8;
  }
  const cam = new THREE.PerspectiveCamera(38, 1.6, 0.05, 600);

  const sun = new THREE.DirectionalLight(reef?0xc8f0ff:garden?0xfff0d8:0xfff6ea, reef?1.6:garden?2.6:1.7);
  sun.position.set(reef?3:garden?9:5, reef?16:garden?14:9, reef?2:garden?7:4); sun.castShadow = true;
  if(reef) scene.add(new THREE.HemisphereLight(0x9fe3f0,0x3a3220,0.7));
  sun.shadow.mapSize.set(2048,2048); sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.02; sun.shadow.radius = 4;
  scene.add(sun, sun.target);

  const world = new THREE.Group(); scene.add(world);
  const orbit = {az:-0.55, el:garden?0.62:0.78, dist:14, min:reef?0.3:garden?4:5, max:garden?40:26, elMin:garden?0.1:0.2, elMax:1.35, target:new THREE.Vector3()};
  let def = null;
  // Camera moves glide to a goal instead of jumping; a drag or pinch cancels the glide.
  let goal = null, follow = false;
  const glide = (g)=>{ goal = {az:g.az??orbit.az, el:g.el??orbit.el, dist:g.dist??orbit.dist, target:(g.target??orbit.target).clone()}; if(reduced()){ Object.assign(orbit,{az:goal.az,el:goal.el,dist:goal.dist}); orbit.target.copy(goal.target); goal=null; } };
  const st = {params:{...params}, pickables:[], anchors:{}, labels:{}, dims:[], hideLabels:false, anim:[], walk:null, fill:null, reveal:null, rotTarget:0, raf:0, dead:false};

  /* ---------- shared materials ---------- */
  const M = {};
  if(reef){
    M.sand = new THREE.MeshStandardMaterial({map:tex('sandC',{repeat:[60,60]}), normalMap:tex('sandN',{srgb:false,repeat:[60,60]}), normalScale:new THREE.Vector2(1.2,1.2), roughness:0.95, color:0xa9bdb0});
    M.rock = new THREE.MeshStandardMaterial({map:tex('paverC',{repeat:[2,2]}), normalMap:tex('paverN',{srgb:false,repeat:[2,2]}), color:0x8c8576, roughness:0.9, flatShading:false});
    M.rockAlgae = new THREE.MeshStandardMaterial({map:tex('paverC',{repeat:[3,3]}), color:0x6f7d52, roughness:0.95});
    M.pvc = new THREE.MeshPhysicalMaterial({color:0xf3f3ee, roughness:0.35, clearcoat:0.4});
    M.stake = new THREE.MeshStandardMaterial({color:0x5a5650, roughness:0.6, metalness:0.8});
    M.cap = new THREE.MeshStandardMaterial({color:0xff6a1a, roughness:0.5});
    M.reel = new THREE.MeshStandardMaterial({color:0xf2c200, roughness:0.4});
    M.hole = new THREE.MeshStandardMaterial({color:0x1a140c, roughness:1});
    M.rim = new THREE.MeshStandardMaterial({map:tex('sandC'), color:0xb7a88a, roughness:1});
    const sand = new THREE.Mesh(new THREE.PlaneGeometry(200,200), M.sand); sand.rotation.x=-Math.PI/2; sand.receiveShadow=true; scene.add(sand);
    const cm = (sp)=>{const t=tex('caustic',{srgb:false,repeat:[48,48]}); return new THREE.MeshBasicMaterial({map:t,transparent:true,opacity:0.07,blending:THREE.AdditiveBlending,depthWrite:false,fog:true,color:0xcff6ff})};
    st.caus=[cm(),cm()]; st.caus[1].map.repeat.set(37,37); st.caus[1].map.rotation=0.7;
    st.caus.forEach((m,i)=>{const c=new THREE.Mesh(new THREE.PlaneGeometry(200,200),m); c.rotation.x=-Math.PI/2; c.position.y=0.004+i*0.001; c.renderOrder=2; scene.add(c)});
    // drifting particles (marine snow)
    const n=900, pos=new Float32Array(n*3); for(let i=0;i<n;i++){pos[i*3]=(Math.random()-.5)*30;pos[i*3+1]=Math.random()*6;pos[i*3+2]=(Math.random()-.5)*30}
    const pg=new THREE.BufferGeometry(); pg.setAttribute('position',new THREE.BufferAttribute(pos,3));
    st.snow=new THREE.Points(pg,new THREE.PointsMaterial({color:0xdff4f2,size:0.025,transparent:true,opacity:0.55,depthWrite:false})); scene.add(st.snow);
    // sunlight shafts from the surface: soft additive sheets that sway slowly
    { const c=document.createElement('canvas'); c.width=64; c.height=256; const g=c.getContext('2d'); const gr=g.createLinearGradient(0,0,0,256);
      gr.addColorStop(0,'rgba(255,255,255,.9)'); gr.addColorStop(0.55,'rgba(255,255,255,.25)'); gr.addColorStop(1,'rgba(255,255,255,0)'); g.fillStyle=gr; g.fillRect(0,0,64,256);
      const hg=g.getImageData(0,0,64,256); for(let y=0;y<256;y++)for(let x=0;x<64;x++){const k=Math.sin(x/63*Math.PI); hg.data[(y*64+x)*4+3]*=k*k;} g.putImageData(hg,0,0);
      const t=new THREE.CanvasTexture(c); st.rays=[];
      for(let k=0;k<9;k++){ const m=new THREE.Mesh(new THREE.PlaneGeometry(0.6+(k%3)*0.35,9), new THREE.MeshBasicMaterial({map:t,transparent:true,opacity:0.05+((k*7)%5)*0.012,blending:THREE.AdditiveBlending,depthWrite:false,side:THREE.DoubleSide,color:0xd8f6ff,fog:false}));
        m.position.set(-5+k*1.3+((k*37)%10)/10, 3.2, -3+((k*53)%60)/10); m.rotation.set(0.0, k*0.7, 0.22+((k*13)%7)*0.02); m.userData.ph=k*1.7; scene.add(m); st.rays.push(m); } }
    // sand kicked up when something lands on the sea floor
    { const n=360, pos=new Float32Array(n*3).fill(-99); const g=new THREE.BufferGeometry(); g.setAttribute('position',new THREE.BufferAttribute(pos,3));
      st.puff={pts:new THREE.Points(g,new THREE.PointsMaterial({color:0xcfc2a2,size:0.018,transparent:true,opacity:0.8,depthWrite:false})), v:new Float32Array(n*3), life:new Float32Array(n), next:0};
      scene.add(st.puff.pts); }
    // gravel and shell grit scattered over the sand, more of it away from the survey area
    { const g=new THREE.IcosahedronGeometry(1,1), q=g.attributes.position;
      for(let i=0;i<q.count;i++){const x=q.getX(i),y=q.getY(i),z=q.getZ(i); const f=1+0.22*Math.sin(x*4.1+1.3)*Math.cos(z*3.3)+0.1*Math.sin(y*6); q.setXYZ(i,x*f,y*f*0.55,z*f)}
      g.computeVertexNormals();
      const N=2600, mat=new THREE.MeshStandardMaterial({roughness:0.92, map:tex('paverC',{repeat:[0.3,0.3]})});
      const im=new THREE.InstancedMesh(g,mat,N); const m4=new THREE.Matrix4(), qq=new THREE.Quaternion(), e=new THREE.Euler(), col=new THREE.Color();
      let seed=7; const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
      for(let i=0;i<N;i++){ const r=Math.pow(rnd(),0.7)*14, a=rnd()*Math.PI*2, sc=0.004+Math.pow(rnd(),3)*(r>4?0.06:0.022);
        e.set(rnd()*0.4,rnd()*6.28,rnd()*0.4); qq.setFromEuler(e); m4.compose(new THREE.Vector3(Math.cos(a)*r,sc*0.2,Math.sin(a)*r),qq,new THREE.Vector3(sc,sc,sc)); im.setMatrixAt(i,m4);
        const k=rnd(); col.setRGB(0.42+k*0.35,0.4+k*0.32,0.36+k*0.26); if(rnd()<0.18) col.setRGB(0.85,0.82,0.74); im.setColorAt(i,col); }
      im.castShadow=true; im.receiveShadow=true; scene.add(im); }
    // rocks & rubble outside the survey area
    const rg=new THREE.IcosahedronGeometry(1,3); const rp=rg.attributes.position;
    for(let k=0;k<34;k++){ const g=rg.clone(), q=g.attributes.position; const seed=k*12.9898;
      for(let i=0;i<q.count;i++){const x=q.getX(i),y=q.getY(i),z=q.getZ(i); const f=1+0.28*Math.sin(x*3.1+seed)*Math.cos(z*2.7+seed*.3)+0.12*Math.sin(y*5+seed); q.setXYZ(i,x*f,y*f*0.62,z*f)}
      g.computeVertexNormals(); const m=new THREE.Mesh(g,k%3?M.rock:M.rockAlgae); const ang=k*2.399, rad=6.5+((k*37)%60)/10;
      const sc=0.18+((k*53)%10)/14; m.scale.setScalar(sc); m.position.set(Math.cos(ang)*rad,sc*0.25,Math.sin(ang)*rad); m.rotation.y=k; m.castShadow=true; m.receiveShadow=true; scene.add(m); }
  } else if(garden){
    M.grass = new THREE.MeshStandardMaterial({map:tex('grass',{repeat:[90,90]}), roughness:1, color:0xd8e6c8});
    M.soil = new THREE.MeshStandardMaterial({map:tex('soilC'), roughness:1, color:0x8a7a6a, envMapIntensity:0.5});
    M.pavers = [1,0.94,1.04,0.9].map((k,i)=>new THREE.MeshStandardMaterial({map:tex('paverC',{rot:i*Math.PI/2}), normalMap:tex('paverN',{srgb:false,rot:i*Math.PI/2}),
      normalScale:new THREE.Vector2(0.9,0.9), roughness:0.82, envMapIntensity:0.7, color:new THREE.Color(k,k*0.99,k*0.97)}));
    M.post = woodMat(0xe2c9a6,[0.25,1],Math.PI/2,0.75); M.rail = woodMat(0xe2c9a6,[1,0.08],0,0.75);
    M.rubber = new THREE.MeshStandardMaterial({color:0x1b1b1b, roughness:0.92});
    M.paint = new THREE.MeshStandardMaterial({color:0xe8b20e, roughness:0.38, metalness:0.25});
    M.steel = new THREE.MeshStandardMaterial({color:0xc8ccd2, roughness:0.28, metalness:1});
    M.plastic = new THREE.MeshStandardMaterial({color:0x2a2d33, roughness:0.55});
    M.chalk = new THREE.MeshStandardMaterial({color:0xf4f4f0, roughness:1});
    const g = new THREE.Mesh(new THREE.PlaneGeometry(400,400), M.grass); g.rotation.x=-Math.PI/2; g.receiveShadow=true; scene.add(g);
  } else {
    M.table = woodMat(0xb88a62,[1.6,1.6],0,0.42);
    M.tray = woodMat(0xf3dfc2,[0.8,0.8],Math.PI/2,0.55);
    const solid=(color,rot)=>new THREE.MeshStandardMaterial({color,map:tex('woodS',{rot}),roughnessMap:tex('woodSR',{srgb:false,rot}),bumpMap:tex('woodSR',{srgb:false,rot}),bumpScale:0.4,roughness:0.85});
    M.beech = solid(0xf4dcb6,0); M.walnut = solid(0x6f4a33,Math.PI/2);
    const t = new THREE.Mesh(new RoundedBoxGeometry(30,0.8,20,2,0.08), M.table); t.position.y=-0.4; t.receiveShadow=true; scene.add(t);
  }

  /* ---------- builders ---------- */
  function clear(){ while(world.children.length){ const o=world.children.pop(); o.traverse(n=>{ if(n.geometry && !n.geometry.userData.shared) n.geometry.dispose(); }); } st.pickables=[]; st.anchors={}; st.dims=[]; }
  const G = {};
  function shared(geo){ geo.userData.shared=true; return geo; }
  function buildGarden(){
    clear(); const {a,b} = st.params; const grp = new THREE.Group(); world.add(grp);
    const bed = new THREE.Mesh(new THREE.BoxGeometry(a+0.24,0.06,b+0.24), M.soil); bed.position.y=0.03; bed.receiveShadow=true; bed.userData={kind:'tile'}; grp.add(bed); st.pickables.push(bed);
    G.paver = G.paver || shared(new RoundedBoxGeometry(0.965,0.05,0.965,2,0.012));
    st.tiles=[];
    for(let i=0;i<b;i++) for(let j=0;j<a;j++){
      const m = new THREE.Mesh(G.paver, M.pavers[(i*7+j*3)%4]); m.position.set(-a/2+0.5+j, 0.085, -b/2+0.5+i);
      m.rotation.y = ((i*13+j*5)%7-3)*0.004; m.castShadow=true; m.receiveShadow=true; m.visible=false; m.userData={kind:'tile'}; grp.add(m); st.pickables.push(m); st.tiles.push(m);
    }
    G.post = G.post || shared(new THREE.BoxGeometry(0.08,0.92,0.08));
    G.cap = G.cap || shared(new THREE.ConeGeometry(0.068,0.07,4));
    const pts=[]; for(let j=0;j<=a;j++){pts.push([j,0]);pts.push([j,b])} for(let i=1;i<b;i++){pts.push([0,i]);pts.push([a,i])}
    pts.forEach(([x,z])=>{ const p=new THREE.Mesh(G.post,M.post); p.position.set(-a/2+x,0.46,-b/2+z); p.castShadow=true; p.receiveShadow=true; p.userData={kind:'fence'}; grp.add(p); st.pickables.push(p);
      const c=new THREE.Mesh(G.cap,M.post); c.position.set(-a/2+x,0.955,-b/2+z); c.rotation.y=Math.PI/4; c.castShadow=true; grp.add(c); });
    const rail=(len,x,z,alongX)=>[0.34,0.72].forEach(y=>{ const r=new THREE.Mesh(new THREE.BoxGeometry(alongX?len:0.035,0.07,alongX?0.035:len),M.rail); r.position.set(x,y,z); r.castShadow=true; r.receiveShadow=true; r.userData={kind:'fence'}; grp.add(r); st.pickables.push(r); });
    rail(a,0,b/2+0.055,true); rail(a,0,-b/2-0.055,true); rail(b,a/2+0.055,0,false); rail(b,-a/2-0.055,0,false);
    st.wheel = buildWheel(); grp.add(st.wheel.group); placeWheel(0);
    st.chalk = new THREE.Group(); grp.add(st.chalk);
    st.anchors.fence=()=>grp.localToWorld(new THREE.Vector3(0,1.1,b/2));
    st.anchors.tile=()=>grp.localToWorld(new THREE.Vector3(0,0.35,0));
    st.anchors.unit=()=>grp.localToWorld(new THREE.Vector3(-a/2+0.5,0.35,-b/2+0.5));
    st.dims=[{p:()=>grp.localToWorld(new THREE.Vector3(0,0.05,b/2+0.75)),t:`长 ${a} 米`},{p:()=>grp.localToWorld(new THREE.Vector3(a/2+0.75,0.05,0)),t:`宽 ${b} 米`}];
    const R=Math.max(a,b)/2+2.5; Object.assign(sun.shadow.camera,{left:-R,right:R,top:R,bottom:-R,near:1,far:60}); sun.shadow.camera.updateProjectionMatrix();
    const ab=a+'x'+b; if(st.lastAB!==ab){ st.lastAB=ab; orbit.dist=clamp(Math.max(a,b)*1.45+5,orbit.min,orbit.max); orbit.target.set(0,0.2,0); }
    buildLabels();
  }
  function tapeTexture(P){
    const pxm=96, c=document.createElement('canvas'); c.width=Math.min(8192,Math.ceil(P*pxm)); c.height=40; const g=c.getContext('2d'), k=c.width/P;
    g.fillStyle='#f1c40f'; g.fillRect(0,0,c.width,40); g.fillStyle='#1a1a1a';
    for(let i=0;i<=P*10;i++){ const x=i*k/10; const big=i%10===0; g.fillRect(x,0,big?3:1.2,big?22:i%5===0?14:8); }
    g.font='bold 15px sans-serif'; g.fillStyle='#c0392b'; for(let m=1;m<=P;m++){ g.fillText(m+'m', m*k-28, 36); }
    const t=new THREE.CanvasTexture(c); t.colorSpace=THREE.SRGBColorSpace; t.anisotropy=8; return t;
  }
  function buildReef(){
    clear(); const {a,b}=st.params, P=2*(a+b); const grp=new THREE.Group(); world.add(grp);
    // pick planes for each 1 m cell + PVC quadrat frames
    G.pick = G.pick || shared(new THREE.PlaneGeometry(0.98,0.98));
    const pickMat=new THREE.MeshBasicMaterial({visible:false});
    G.bar = G.bar || shared(new THREE.CylinderGeometry(0.011,0.011,0.96,10));
    G.elbow = G.elbow || shared(new THREE.SphereGeometry(0.016,12,8));
    st.tiles=[];
    for(let i=0;i<b;i++) for(let j=0;j<a;j++){
      const cx=-a/2+0.5+j, cz=-b/2+0.5+i;
      const pk=new THREE.Mesh(G.pick,pickMat); pk.rotation.x=-Math.PI/2; pk.position.set(cx,0.02,cz); pk.userData={kind:'tile'}; grp.add(pk); st.pickables.push(pk);
      const q=new THREE.Group(); q.position.set(cx,0.012,cz);
      [[0,-0.49,0],[0,0.49,0],[-0.49,0,1],[0.49,0,1]].forEach(([x,z,rot])=>{const bar=new THREE.Mesh(G.bar,M.pvc); bar.rotation.z=Math.PI/2; if(rot)bar.rotation.y=Math.PI/2; bar.position.set(x,0,z); bar.castShadow=true; q.add(bar)});
      [[-.49,-.49],[.49,-.49],[-.49,.49],[.49,.49]].forEach(([x,z])=>{const e=new THREE.Mesh(G.elbow,M.pvc); e.position.set(x,0,z); e.castShadow=true; q.add(e)});
      q.visible=false; q.userData={kind:'tile',baseY:0.012}; grp.add(q); st.tiles.push(q);
    }
    // corner stakes
    [[-a/2,-b/2],[a/2,-b/2],[a/2,b/2],[-a/2,b/2]].forEach(([x,z])=>{const s=new THREE.Mesh(new THREE.CylinderGeometry(0.008,0.008,0.35,8),M.stake); s.position.set(x,0.17,z); s.castShadow=true; grp.add(s);
      const c=new THREE.Mesh(new THREE.CylinderGeometry(0.022,0.022,0.03,12),M.cap); c.position.set(x,0.35,z); grp.add(c); s.userData={kind:'fence'}; st.pickables.push(s)});
    // survey tape laid along the boundary in 0.25 m pieces (numbers are cumulative metres)
    const tmat=new THREE.MeshStandardMaterial({map:tapeTexture(P),roughness:0.45,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-2});
    st.tape=[]; const seg=0.25;
    for(let d=0; d<P-1e-6; d+=seg){ const p0=pathAt(d,0), p1=pathAt(Math.min(P,d+seg)-1e-6,0); const len=Math.hypot(p1.x-p0.x,p1.z-p0.z)||seg;
      const geo=new THREE.PlaneGeometry(len,0.03); const uv=geo.attributes.uv; for(let i=0;i<uv.count;i++){uv.setX(i,(d+uv.getX(i)*seg)/P)}
      const m=new THREE.Mesh(geo,tmat); m.rotation.x=-Math.PI/2; m.rotation.z=Math.atan2(-(p1.z-p0.z),p1.x-p0.x); m.position.set((p0.x+p1.x)/2,0.008,(p0.z+p1.z)/2);
      m.receiveShadow=true; m.visible=false; m.userData={kind:'fence',d}; grp.add(m); st.pickables.push(m); st.tape.push(m); }
    // tape reel carried along the edge
    const reel=new THREE.Group(); const body=new THREE.Mesh(new THREE.CylinderGeometry(0.07,0.07,0.035,28),M.reel); body.rotation.x=Math.PI/2; reel.add(body);
    const hub=new THREE.Mesh(new THREE.CylinderGeometry(0.02,0.02,0.05,16),M.stake); hub.rotation.x=Math.PI/2; reel.add(hub);
    const hd=new THREE.Mesh(new THREE.CylinderGeometry(0.012,0.012,0.16,10),M.stake); hd.position.y=0.11; reel.add(hd); reel.traverse(n=>{if(n.isMesh)n.castShadow=true});
    reel.position.set(-a/2,0.25,b/2); grp.add(reel); st.reel=reel;
    // burrows: dark entrance + low sand rim; the first one is the mantis shrimp's
    const holes=[[-a/2+0.7,-b/2+0.6],[a/2-1.3,0.3],[0.2,b/2-0.8]].filter(([x,z])=>Math.abs(x)<a/2&&Math.abs(z)<b/2);
    if(!G.holeMat){ const c=document.createElement('canvas'); c.width=c.height=128; const g=c.getContext('2d'); const gr=g.createRadialGradient(64,64,6,64,64,64);
      gr.addColorStop(0,'rgba(8,6,4,1)'); gr.addColorStop(0.32,'rgba(18,14,10,.95)'); gr.addColorStop(0.55,'rgba(60,52,40,.45)'); gr.addColorStop(1,'rgba(60,52,40,0)'); g.fillStyle=gr; g.fillRect(0,0,128,128);
      const t=new THREE.CanvasTexture(c); G.holeMat=new THREE.MeshStandardMaterial({map:t,transparent:true,depthWrite:false,roughness:1,polygonOffset:true,polygonOffsetFactor:-3}); }
    holes.forEach(([x,z])=>{const h=new THREE.Mesh(new THREE.PlaneGeometry(0.26,0.26),G.holeMat); h.rotation.x=-Math.PI/2; h.position.set(x,0.006,z); h.renderOrder=3; grp.add(h)});
    // Realism floor (BL14): no stylised creature stands in for a real one. Until a licensed
    // photoreal model is registered, only the burrow is shown and the hotspot points at it.
    const h0=holes[0]||[0,0]; st.burrow=new THREE.Vector3(h0[0],0,h0[1]);
    const hit=new THREE.Mesh(new THREE.CircleGeometry(0.2,24),new THREE.MeshBasicMaterial({visible:false})); hit.rotation.x=-Math.PI/2; hit.position.set(h0[0],0.01,h0[1]);
    hit.userData={kind:'shrimp'}; grp.add(hit); st.pickables.push(hit);
    placeOrganism(grp, h0);
    st.anchors.fence=()=>grp.localToWorld(new THREE.Vector3(0,0.35,b/2));
    st.anchors.tile=()=>grp.localToWorld(new THREE.Vector3(0.5,0.3,0.5));
    st.anchors.unit=()=>grp.localToWorld(new THREE.Vector3(a/2-0.5,0.3,b/2-0.5));
    st.anchors.shrimp=()=>grp.localToWorld(new THREE.Vector3(h0[0],0.12,h0[1]));
    st.dims=[{p:()=>grp.localToWorld(new THREE.Vector3(0,0.05,b/2+0.45)),t:`长 ${a} 米`},{p:()=>grp.localToWorld(new THREE.Vector3(a/2+0.45,0.05,0)),t:`宽 ${b} 米`}];
    const R=Math.max(a,b)/2+2; Object.assign(sun.shadow.camera,{left:-R,right:R,top:R,bottom:-R,near:1,far:40}); sun.shadow.camera.updateProjectionMatrix();
    const ab=a+'x'+b; if(st.lastAB!==ab){ st.lastAB=ab; orbit.dist=clamp(Math.max(a,b)*1.25+3,orbit.min,orbit.max); orbit.target.set(0,0,0); }
    buildLabels();
  }
  /* The animal in the burrow: a cut-out top view at true size (BL14 photoreal), slightly domed so light
     falls on it like on a body, clipped at the burrow so it really comes out of the hole. */
  function placeOrganism(grp, h0){
    const o=hooks.organism; st.shr=null; if(!o) return;
    const dir=new THREE.Vector2(-h0[0],-h0[1]); if(dir.lengthSq()<1e-6) dir.set(1,0); dir.normalize();
    const pivot=new THREE.Group(); pivot.position.set(h0[0],0.004,h0[1]); pivot.rotation.y=Math.atan2(dir.y,-dir.x); grp.add(pivot);
    const W=o.lengthM/Math.max(0.2,o.body[1]-o.body[0]);
    const clip=new THREE.Plane(new THREE.Vector3(dir.x,0,dir.y), 0);
    const shr={pivot, clip, W, mesh:null, state:'in', t:0, x:W/2, kick:0, dir};
    st.shr=shr;
    const make=(t)=>{
      if(st.shr!==shr) return;
      const H=W*t.image.height/t.image.width, geo=new THREE.PlaneGeometry(W,H,64,24), q=geo.attributes.position;
      for(let i=0;i<q.count;i++){ const y=q.getY(i)/(H/2), xx=(q.getX(i)/W)+0.5; const along=xx<o.body[0]?0:Math.sin(Math.min(1,(xx-o.body[0])/(o.body[1]-o.body[0]))*Math.PI)**0.4;
        q.setZ(i, Math.max(0,1-(y/0.42)**2)*0.11*o.lengthM*along); }
      geo.computeVertexNormals();
      const mat=new THREE.MeshStandardMaterial({map:t, alphaTest:0.4, roughness:0.42, metalness:0, side:THREE.DoubleSide, clippingPlanes:[clip], envMapIntensity:1.1});
      const mesh=new THREE.Mesh(geo,mat); mesh.rotation.x=-Math.PI/2; mesh.castShadow=true; mesh.receiveShadow=false;
      mesh.customDepthMaterial=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking, map:t, alphaTest:0.4, clippingPlanes:[clip]});
      mesh.userData={kind:'shrimp'}; pivot.add(mesh); st.pickables.push(mesh); shr.mesh=mesh;
    };
    if(G.shrimpTex && G.shrimpTex.image) make(G.shrimpTex);
    else { G.shrimpTex=texLoader.load(o.url, make); G.shrimpTex.colorSpace=THREE.SRGBColorSpace; G.shrimpTex.anisotropy=8; }
  }
  function updateOrganism(dt, now){
    const s=st.shr; if(!s||!s.mesh) return; s.t+=dt;
    const b=new THREE.Vector3(); s.pivot.getWorldPosition(b);
    s.clip.constant=-(s.clip.normal.x*b.x+s.clip.normal.z*b.z)+0.035; // keep what is outside the burrow mouth
    const headIn=s.W/2 - 0.18*s.W, peek=headIn-0.03, out=s.W/2-0.86*s.W;
    let goalX = s.state==='out' ? out + 0.005*Math.sin(s.t*1.4) : peek + (Math.sin(s.t*0.9)>0.6 ? 0 : 0.035);
    if(reduced()) goalX = s.state==='out'?out:peek;
    const speed = s.state==='out' ? 1.4 : 3; s.x += (goalX-s.x)*Math.min(1,dt*speed);
    if(s.kick>0){ s.kick=Math.max(0,s.kick-dt); }
    const lunge = s.kick>0.25 ? (0.3-s.kick)/0.05 : s.kick/0.25; // 50 ms out, 250 ms back: the strike
    s.mesh.position.x = s.x - (s.kick>0 ? 0.03*Math.max(0,Math.min(1,lunge)) : 0);
    s.mesh.rotation.z = s.state==='out' && !reduced() ? 0.05*Math.sin(s.t*0.6) : 0;
  }
  function strike(){ const s=st.shr; if(!s||s.state!=='out'||s.kick>0) return; s.kick=0.3;
    const p=new THREE.Vector3(-s.W/2+s.mesh.position.x-0.02,0,0); s.mesh.parent.localToWorld(p); setTimeout(()=>puff(p.x,p.z,40,0.5,0.25),50); }
  function buildWheel(){
    const r = 1/(2*Math.PI); // circumference exactly 1 m, like a real surveyor's measuring wheel
    const group = new THREE.Group(), spin = new THREE.Group(); group.add(spin);
    const tire = new THREE.Mesh(new THREE.TorusGeometry(r-0.013,0.015,16,64), M.rubber); tire.rotation.y=Math.PI/2; tire.castShadow=true; spin.add(tire);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(r-0.022,r-0.022,0.022,48), M.paint); rim.rotation.z=Math.PI/2; rim.castShadow=true; spin.add(rim);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.022,0.022,0.05,24), M.steel); hub.rotation.z=Math.PI/2; spin.add(hub);
    for(let k=0;k<5;k++){ const s=new THREE.Mesh(new THREE.BoxGeometry(0.008,r*1.55,0.012), M.steel); s.rotation.x=k*Math.PI/5; s.position.x=0.013; spin.add(s); }
    spin.position.y=r;
    const forkL=new THREE.Mesh(new THREE.BoxGeometry(0.01,0.2,0.02),M.paint), forkR=forkL.clone(); forkL.position.set(0.03,r+0.08,-0.02); forkR.position.set(-0.03,r+0.08,-0.02); forkL.rotation.x=forkR.rotation.x=-0.5;
    const handle=new THREE.Group(); handle.position.set(0,r+0.16,-0.08); handle.rotation.x=-0.62;
    const rod=new THREE.Mesh(new THREE.CylinderGeometry(0.011,0.011,0.95,16),M.steel); rod.position.y=0.475; rod.castShadow=true; handle.add(rod);
    const grip=new THREE.Mesh(new THREE.CylinderGeometry(0.017,0.017,0.13,16),M.plastic); grip.position.y=0.95; handle.add(grip);
    const counter=new THREE.Mesh(new RoundedBoxGeometry(0.07,0.045,0.035,2,0.008),M.plastic); counter.position.set(0,0.05,0.02); handle.add(counter);
    const lcd=new THREE.Mesh(new THREE.PlaneGeometry(0.05,0.02),new THREE.MeshStandardMaterial({color:0x9fb39a,roughness:0.3,emissive:0x1a2418})); lcd.position.set(0,0.05,0.0381); handle.add(lcd);
    group.add(forkL,forkR,handle); group.traverse(n=>{if(n.isMesh)n.castShadow=true});
    return {group, spin, r};
  }
  function pathAt(d,off){ const {a,b}=st.params, P=2*(a+b); d=((d%P)+P)%P; const o=off??0.2;
    if(d<=a) return {x:-a/2+d, z:b/2+o, yaw:Math.PI/2};
    if(d<=a+b) return {x:a/2+o, z:b/2-(d-a), yaw:Math.PI};
    if(d<=2*a+b) return {x:a/2-(d-a-b), z:-b/2-o, yaw:-Math.PI/2};
    return {x:-a/2-o, z:-b/2+(d-2*a-b), yaw:0}; }
  function placeWheel(d){ const w=st.wheel, p=pathAt(d); w.group.position.set(p.x,0,p.z);
    let dy=p.yaw-w.group.rotation.y; while(dy>Math.PI)dy-=2*Math.PI; while(dy<-Math.PI)dy+=2*Math.PI;
    w.group.rotation.y += reduced()? dy : dy*0.25; w.spin.rotation.x = d / w.r; }

  function buildArray(){
    clear(); const {r,c} = st.params, s=1, gap=0.14, W=c*(s+gap)-gap, D=r*(s+gap)-gap;
    const tray = new THREE.Group(); world.add(tray); st.tray=tray; tray.rotation.y = st.rotTarget;
    const board = new THREE.Mesh(new RoundedBoxGeometry(W+0.9,0.16,D+0.9,2,0.04), M.tray); board.position.y=0.08; board.receiveShadow=true; board.castShadow=true; tray.add(board);
    G.cube = G.cube || shared(new RoundedBoxGeometry(s,s,s,3,0.07));
    st.cubes=[];
    for(let i=0;i<r;i++) for(let j=0;j<c;j++){
      const m=new THREE.Mesh(G.cube, i%2? M.walnut : M.beech); m.position.set(-W/2+s/2+j*(s+gap), 0.16+s/2, -D/2+s/2+i*(s+gap));
      m.rotation.y = ((i*5+j*3)%5-2)*0.012; m.castShadow=true; m.receiveShadow=true; m.userData={kind:'cube',row:i+1,col:j+1,baseY:m.position.y}; tray.add(m); st.pickables.push(m); st.cubes.push(m);
    }
    st.anchors.row=()=>tray.localToWorld(new THREE.Vector3(-W/2-0.95,0.7,-D/2+0.5));
    st.anchors.col=()=>tray.localToWorld(new THREE.Vector3(-W/2+0.5,1.5,-D/2-0.95));
    st.anchors.total=()=>tray.localToWorld(new THREE.Vector3(0,2.0,0));
    const R=Math.max(W,D)/2+3; Object.assign(sun.shadow.camera,{left:-R,right:R,top:R,bottom:-R,near:1,far:40}); sun.shadow.camera.updateProjectionMatrix();
    orbit.target.set(0,0.6,0); const k=r+'x'+c; if(st.lastAB!==k){st.lastAB=k; orbit.dist=clamp(Math.max(W,D)*1.25+5,orbit.min,orbit.max);}
    buildLabels();
  }
  function puff(x,z,count,spread,up){ if(!st.puff||reduced()) return; const p=st.puff, a=p.pts.geometry.attributes.position, n=st.puff.life.length;
    for(let i=0;i<count;i++){ const k=p.next=(p.next+1)%n, ang=Math.random()*Math.PI*2, r=Math.random()*spread;
      a.setXYZ(k,x+Math.cos(ang)*r*0.3,0.01,z+Math.sin(ang)*r*0.3); p.v[k*3]=Math.cos(ang)*r; p.v[k*3+1]=up*(0.4+Math.random()); p.v[k*3+2]=Math.sin(ang)*r; p.life[k]=1.2+Math.random()*1.4; }
    a.needsUpdate=true; }
  function build(){ reef ? buildReef() : garden ? buildGarden() : buildArray(); if(!def) def={az:orbit.az,el:orbit.el,dist:orbit.dist}; }

  /* ---------- labels ---------- */
  function buildLabels(){
    stage.querySelectorAll('.hs,.dimlab').forEach(n=>n.remove()); st.labels={};
    (hooks.hotspots||[]).forEach(h=>{ const b=document.createElement('button'); b.className='hs'; b.textContent=h.label; b.onclick=e=>{e.stopPropagation(); hooks.onHotspot(h)}; stage.appendChild(b); st.labels[h.id]=b; });
    st.dims.forEach(d=>{ const n=document.createElement('span'); n.className='dimlab'; n.textContent=d.t; stage.appendChild(n); d.el=n; });
  }
  function placeLabels(){
    const rect = renderer.domElement.getBoundingClientRect();
    const put=(el,v,isHs)=>{ const p=v.clone().project(cam); if(p.z>1){el.hidden=true;return} el.hidden = isHs && st.hideLabels; el.style.left=((p.x+1)/2*rect.width)+'px'; el.style.top=((1-p.y)/2*rect.height)+'px'; };
    Object.entries(st.labels).forEach(([id,el])=>st.anchors[id]&&put(el,st.anchors[id](),true));
    st.dims.forEach(d=>d.el&&put(d.el,d.p(),false));
  }

  /* ---------- input: drag rotate, pinch/wheel zoom, tap pick ---------- */
  const cv = renderer.domElement, ptrs=new Map(); let down=null, pinch0=null;
  cv.addEventListener('pointerdown',e=>{cv.setPointerCapture(e.pointerId);ptrs.set(e.pointerId,{x:e.clientX,y:e.clientY});if(ptrs.size===1)down={x:e.clientX,y:e.clientY,t:performance.now(),moved:false};if(ptrs.size===2){goal=null;const [p,q]=[...ptrs.values()];pinch0={d:Math.hypot(p.x-q.x,p.y-q.y),dist:orbit.dist};if(down)down.moved=true}});
  cv.addEventListener('pointermove',e=>{if(!ptrs.has(e.pointerId))return;const p=ptrs.get(e.pointerId),dx=e.clientX-p.x,dy=e.clientY-p.y;ptrs.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(ptrs.size===2&&pinch0){const [u,v]=[...ptrs.values()];orbit.dist=clamp(pinch0.dist*pinch0.d/Math.max(1,Math.hypot(u.x-v.x,u.y-v.y)),orbit.min,orbit.max);return}
    if(down&&Math.hypot(e.clientX-down.x,e.clientY-down.y)>6)down.moved=true;
    if(down&&down.moved){goal=null;follow=false;orbit.az-=dx*0.008;orbit.el=clamp(orbit.el+dy*0.006,orbit.elMin,orbit.elMax)}});
  const ray=new THREE.Raycaster();
  cv.addEventListener('pointerup',e=>{ptrs.delete(e.pointerId);if(ptrs.size<2)pinch0=null;
    if(ptrs.size===0&&down){ if(!down.moved&&performance.now()-down.t<450){const r=cv.getBoundingClientRect();ray.setFromCamera(new THREE.Vector2(((e.clientX-r.left)/r.width)*2-1,-((e.clientY-r.top)/r.height)*2+1),cam);
      const hit=ray.intersectObjects(st.pickables,false).find(h=>h.object.visible); if(hit&&hit.object.userData.kind==='shrimp'){ if(st.shr&&st.shr.state==='out') strike(); else if(st.shr) st.shr.state='out'; } if(hit&&onPick)onPick(hit.object.userData)} down=null }});
  cv.addEventListener('pointercancel',e=>{ptrs.delete(e.pointerId);down=null;pinch0=null});
  cv.addEventListener('wheel',e=>{e.preventDefault();orbit.dist=clamp(orbit.dist*(1+Math.sign(e.deltaY)*0.08),orbit.min,orbit.max)},{passive:false});

  /* ---------- loop ---------- */
  const resize=()=>{const r=stage.getBoundingClientRect();renderer.setSize(r.width,r.height,false);cam.aspect=r.width/Math.max(1,r.height);cam.updateProjectionMatrix()};
  const ro=new ResizeObserver(resize); ro.observe(stage); resize();
  const clock=new THREE.Clock();
  function frame(){
    if(st.dead) return; st.raf=requestAnimationFrame(frame); const dt=Math.min(0.05,clock.getDelta()), now=performance.now();
    if(reef){
      st.caus.forEach((m,i)=>{m.map.offset.x+=dt*(i?0.011:-0.007);m.map.offset.y+=dt*(i?0.006:0.009)});
      st.rays.forEach(m=>{ m.rotation.z=0.24+Math.sin(now*0.00021+m.userData.ph)*0.05; m.material.opacity=Math.max(0.02,m.material.opacity+Math.sin(now*0.0004+m.userData.ph)*0.0004); });
      { const p=st.puff, a=p.pts.geometry.attributes.position; let live=false;
        for(let k=0;k<p.life.length;k++){ if(p.life[k]<=0) continue; live=true; p.life[k]-=dt; const drag=Math.exp(-dt*2.2);
          p.v[k*3]*=drag; p.v[k*3+2]*=drag; p.v[k*3+1]=p.v[k*3+1]*drag-dt*0.12;
          let y=a.getY(k)+p.v[k*3+1]*dt; if(y<0.003){y=0.003;p.v[k*3+1]=0}
          a.setXYZ(k,a.getX(k)+p.v[k*3]*dt,y,a.getZ(k)+p.v[k*3+2]*dt); if(p.life[k]<=0) a.setY(k,-99); }
        if(live) a.needsUpdate=true; }
      // a few grains trickle out of the burrow now and then: something lives in there
      if(st.burrow && Math.random()<dt*0.6) puff(st.burrow.x,st.burrow.z,4,0.08,0.05);
      updateOrganism(dt, now);
      const sp=st.snow.geometry.attributes.position; for(let i=0;i<sp.count;i++){let y=sp.getY(i)-dt*0.04; if(y<0)y=6; sp.setY(i,y); sp.setX(i,sp.getX(i)+Math.sin(now*0.0003+i)*dt*0.03)} sp.needsUpdate=true;
      if(st.walk){ const P=2*(st.params.a+st.params.b); st.walk.d=Math.min(P, st.walk.d+(reduced()?P:dt*1.3));
        const p=pathAt(st.walk.d,0); st.reel.position.set(p.x,0.25+Math.sin(now*0.004)*0.02,p.z);
        if(follow){ orbit.target.lerp(new THREE.Vector3(p.x*0.55,0,p.z*0.55),Math.min(1,dt*1.5)); }
        if(Math.random()<dt*6) puff(p.x,p.z,2,0.12,0.06); st.reel.rotation.y=p.yaw-Math.PI/2; st.reel.children[0].rotation.y=st.walk.d*8;
        st.tape.forEach(m=>{m.visible=m.userData.d<st.walk.d});
        hooks.onWalk && hooks.onWalk(st.walk.d); if(st.walk.d>=P){ st.walk=null; if(follow){ follow=false; glide({target:new THREE.Vector3(0,reef?0:0.2,0)}); } hooks.onWalkDone&&hooks.onWalkDone(); } }
      if(st.fill){ const f=st.fill, n=st.tiles.length, per=reduced()?0:0.22;
        while(f.next<n && (now-f.t0)/1000 >= f.next*per){ const m=st.tiles[f.next]; m.visible=true; m.userData.t0=now; f.next++; hooks.onFill&&hooks.onFill(f.next); }
        // quadrats sink through water: slow fall with drag, a little rocking, then a puff of sand on landing
        st.tiles.forEach(m=>{ if(m.visible&&m.userData.t0){ const t=(now-m.userData.t0)/1100; const e=Math.min(1,t); m.position.y=0.012+0.9*Math.pow(1-e,1.6); m.rotation.z=(1-e)*0.22*Math.sin(t*7.5); m.rotation.x=(1-e)*0.16*Math.cos(t*6.1); if(t>=1){m.userData.t0=0;m.rotation.set(0,0,0); puff(m.position.x,m.position.z,26,0.55,0.18);} } });
        if(f.next>=n && st.tiles.every(m=>!m.userData.t0)){ st.fill=null; hooks.onFillDone&&hooks.onFillDone(); } }
    } else if(garden){
      if(st.walk){ const P=2*(st.params.a+st.params.b); st.walk.d=Math.min(P, st.walk.d+(reduced()?P:dt*1.3)); placeWheel(st.walk.d);
        if(follow){ const p=pathAt(st.walk.d); orbit.target.lerp(new THREE.Vector3(p.x*0.5,0.2,p.z*0.5),Math.min(1,dt*1.5)); }
        const m=Math.floor(st.walk.d+1e-6); while(st.walk.marks<m){ st.walk.marks++; const p=pathAt(st.walk.marks); const dot=new THREE.Mesh(new THREE.CircleGeometry(0.035,20),M.chalk); dot.rotation.x=-Math.PI/2; dot.position.set(p.x,0.006,p.z); st.chalk.add(dot); }
        hooks.onWalk && hooks.onWalk(st.walk.d); if(st.walk.d>=P){ st.walk=null; if(follow){ follow=false; glide({target:new THREE.Vector3(0,reef?0:0.2,0)}); } hooks.onWalkDone&&hooks.onWalkDone(); } }
      if(st.fill){ const f=st.fill; const n=st.tiles.length; const per=reduced()?0:0.16;
        while(f.next<n && (now-f.t0)/1000 >= f.next*per){ const m=st.tiles[f.next]; m.visible=true; m.userData.t0=now; f.next++; hooks.onFill&&hooks.onFill(f.next); }
        st.tiles.forEach(m=>{ if(m.visible&&m.userData.t0){ const t=(now-m.userData.t0)/420; m.position.y=0.085+0.6*settle(t); if(t>=1)m.userData.t0=0; } });
        if(f.next>=n && st.tiles.every(m=>!m.userData.t0)){ st.fill=null; hooks.onFillDone&&hooks.onFillDone(); } }
    } else {
      if(st.tray){ const d=st.rotTarget-st.tray.rotation.y; st.tray.rotation.y += reduced()? d : d*Math.min(1,dt*4); }
      if(st.reveal){ const f=st.reveal, {r,c}=st.params, rowDur=reduced()?0:0.9;
        const rowsDue=Math.min(r, Math.floor((now-f.t0)/1000/Math.max(rowDur,1e-6))+1);
        while(f.rows<rowsDue){ for(let j=0;j<c;j++){ const m=st.cubes[f.rows*c+j]; m.visible=true; m.userData.t0=now+j*70; } f.rows++; hooks.onReveal&&hooks.onReveal(f.rows); }
        if(f.rows>=r && st.cubes.every(m=>!m.userData.t0 || now-m.userData.t0>500)){ st.reveal=null; st.cubes.forEach(m=>{m.userData.t0=0;m.position.y=m.userData.baseY}); hooks.onRevealDone&&hooks.onRevealDone(); } }
      st.cubes && st.cubes.forEach(m=>{ if(m.userData.t0){ const t=(now-m.userData.t0)/450; if(t<0){m.position.y=m.userData.baseY+1.6;return} m.position.y=m.userData.baseY+1.6*settle(t); } });
    }
    if(goal){ const k=Math.min(1,dt*2.4); let da=goal.az-orbit.az; while(da>Math.PI)da-=2*Math.PI; while(da<-Math.PI)da+=2*Math.PI;
      orbit.az+=da*k; orbit.el+=(goal.el-orbit.el)*k; orbit.dist+=(goal.dist-orbit.dist)*k; orbit.target.lerp(goal.target,k);
      if(Math.abs(da)+Math.abs(goal.el-orbit.el)+Math.abs(goal.dist-orbit.dist)+orbit.target.distanceTo(goal.target)<0.002) goal=null; }
    const o=orbit; cam.position.set(o.target.x+o.dist*Math.cos(o.el)*Math.sin(o.az), o.target.y+o.dist*Math.sin(o.el), o.target.z+o.dist*Math.cos(o.el)*Math.cos(o.az)); cam.lookAt(o.target);
    // underwater the viewer drifts very slightly, like a diver holding position
    if(reef && !reduced()){ cam.position.y+=Math.sin(now*0.0007)*0.015*o.dist/6; cam.rotation.z+=Math.sin(now*0.00043)*0.004; }
    renderer.render(scene,cam); placeLabels();
  }
  build(); frame();

  return {
    get params(){return st.params},
    setParams(p){ st.params={...p}; st.walk=null; st.fill=null; st.reveal=null; build(); },
    walk(){ if(!garden)return; if(reef){st.tape.forEach(m=>m.visible=false)} else st.chalk.clear(); st.walk={d:0,marks:0}; follow=true; },
    focusShrimp(){ if(!st.burrow)return; follow=false;
      const s=st.shr, t=st.burrow.clone(); if(s) t.add(new THREE.Vector3(s.dir.x,0,s.dir.y).multiplyScalar(0.09));
      glide({target:t, dist:s?0.62:1.1, el:s?1.1:0.62}); puff(st.burrow.x,st.burrow.z,30,0.25,0.12);
      if(s) setTimeout(()=>{ if(st.shr===s) s.state='out'; }, reduced()?0:700); },
    strike(){ strike(); },
    fill(){ if(!garden)return; st.tiles.forEach(m=>{m.visible=false;m.userData.t0=0}); st.fill={next:0,t0:performance.now()}; },
    reveal(){ if(garden)return; st.cubes.forEach(m=>{m.visible=false;m.userData.t0=0}); st.reveal={rows:0,t0:performance.now()}; },
    setRot(on){ st.rotTarget = on? Math.PI/2 : 0; },
    showAllTiles(n){ if(garden) st.tiles.forEach((m,i)=>{m.visible=i<n;m.position.y=0.085}); },
    reset(){ if(def){ follow=false; glide({...def, target:new THREE.Vector3(0,reef?0:garden?0.2:0.6,0)}); } },
    zoom(f){ if(goal) goal.dist=clamp(goal.dist*f,orbit.min,orbit.max); else orbit.dist=clamp(orbit.dist*f,orbit.min,orbit.max); },
    toggleLabels(){ st.hideLabels=!st.hideLabels; },
    dispose(){ st.dead=true; cancelAnimationFrame(st.raf); ro.disconnect(); stage.querySelectorAll('.hs,.dimlab').forEach(n=>n.remove());
      scene.traverse(n=>{ if(n.isMesh){ n.geometry.dispose(); } }); envRT.dispose(); pm.dispose(); renderer.dispose(); renderer.domElement.remove(); }
  };
}
