// 端到端测试用的探索课页面（scripts/e2e-family.ts）：三维场景 + adw-family 上课流程 + adw-host 进度接口。
// 题目控件很简单，只为走通流程；不是课程样板，画面和教学不按它做。
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as host from './adw-host.mjs';
import { mountFamilyLesson } from './adw-family.mjs';

const qa = new URLSearchParams(location.search).has('qa');
const flow = await (await fetch('./lesson-flow.json')).json();
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight); renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.getElementById('stage').append(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0xa9b8c6); scene.fog = new THREE.FogExp2(0xa9b8c6, 0.0006);
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 1, 20000);
camera.position.set(160, 22, 1150);
const controls = new OrbitControls(camera, renderer.domElement); controls.target.set(-40, 85, 0); controls.update();
scene.add(new THREE.HemisphereLight(0xdde8f5, 0x55604e, 1.2));
const sun = new THREE.DirectionalLight(0xfff1dd, 2.4); sun.position.set(600, 700, -500); scene.add(sun);
window.adwSetView = (v) => { camera.fov = v.fov || 42; camera.updateProjectionMatrix(); camera.position.set(...v.position); controls.target.set(...v.target); controls.update(); renderer.render(scene, camera); };

const $ = (s) => document.querySelector(s);
const panel = $('#task');
let lesson;
function showTask(id, ask) {
  const t = flow.tasks[id];
  panel.hidden = false; panel.dataset.task = id; panel.innerHTML = `<p class="ask">${ask.ask}</p>`;
  if (t.kind === 'choice') {
    for (const o of ask.options) {
      const b = document.createElement('button'); b.textContent = o.text; b.dataset.option = o.id;
      b.onclick = () => done(id, lesson.answer(id, { ok: Boolean(o.right), option: o.id }));
      panel.append(b);
    }
  } else if (t.kind === 'hands_on') {
    // 摆桥墩：点格子放桥墩，场景状态 piers 决定对错
    const cells = ask === t ? 12 : 18, want = [cells / 3, (2 * cells) / 3];
    const piers = new Set();
    const row = document.createElement('div'); row.className = 'cells';
    for (let i = 1; i < cells; i++) {
      const c = document.createElement('button'); c.textContent = i; c.dataset.cell = i;
      c.onclick = () => { piers.has(i) ? piers.delete(i) : piers.size < 2 && piers.add(i); c.classList.toggle('pier', piers.has(i)); };
      row.append(c);
    }
    const check = document.createElement('button'); check.textContent = '放好了'; check.className = 'check';
    check.onclick = () => { const ok = piers.size === 2 && want.every((w) => piers.has(w)); done(id, lesson.answer(id, { ok })); };
    panel.append(row, check);
  } else {
    const b = document.createElement('button'); b.textContent = '我说完了'; b.className = 'check';
    b.onclick = () => done(id, lesson.answer(id, { ok: true }));
    panel.append(b);
  }
}
function done(id) { if (lesson.engine.state.tasks[id].done) panel.hidden = true; }

lesson = mountFamilyLesson({
  flow, root: $('#flow'), host, key: host.storageKey(flow.lesson, qa),
  hooks: {
    onStep: (step) => {
      $('#still').hidden = step.media !== 'render';
      setTimeout(() => { const id = (step.tasks || []).find((x) => !lesson.engine.state.tasks[x].done); if (id) showTask(id, flow.tasks[id]); else panel.hidden = true; });
    },
    onDemoStep: (id, i, text) => { panel.innerHTML = `<p class="demo">演示 ${i + 1}：${text}</p>`; },
    onTwin: (id, twin) => showTask(id, twin),
    onEnd: () => { panel.hidden = false; panel.innerHTML = '<p class="end">下课啦</p>'; },
  },
});
window.__lesson = lesson;

new GLTFLoader().load('./models/hero.glb', (g) => {
  scene.add(g.scene); host.ready(); window.__ready = true;
}, undefined, (e) => host.failed(e.message));
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
