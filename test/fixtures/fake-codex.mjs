#!/usr/bin/env node
// Stands in for the Codex command line in tests: same arguments, canned answers, every run logged.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const args = process.argv.slice(2);
const env = process.env;
if (args[0] === '--version') { console.log('codex-cli 0.164.0'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') {
  if (env.FAKE_CODEX_LOGGED_OUT) { console.error('Not logged in'); process.exit(1); }
  console.log('Logged in using ChatGPT'); process.exit(0);
}
if (args[0] !== 'exec') { console.error(`unknown command ${args[0]}`); process.exit(2); }

const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dir = opt('-C'), out = opt('-o');
const images = args.filter(a => a.startsWith('--image=')).map(a => a.slice(8));
let prompt = '';
process.stdin.on('data', d => { prompt += d; });
process.stdin.on('end', () => {
  if (env.FAKE_CODEX_LOG) appendFileSync(env.FAKE_CODEX_LOG, JSON.stringify({ args, prompt, images }) + '\n');
  const home = env.CODEX_HOME;
  if (existsSync(join(home, 'broken'))) { console.error('ERROR: stream error: unexpected status 401 Unauthorized'); process.exit(1); }
  let text;
  if (prompt.includes('refs.json')) {
    // finding real photos on the web: only allowed with live search and network access
    if (!args.includes('web_search="live"') || !args.includes('sandbox_workspace_write.network_access=true')) { console.error('no network in this sandbox'); process.exit(1); }
    const n = existsSync(join(home, 'few-photos')) ? 2 : 4;
    mkdirSync(join(dir, 'refs'), { recursive: true });
    const photos = [];
    for (let i = 1; i <= n; i++) {
      writeFileSync(join(dir, 'refs', `${i}.jpg`), Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, i), Buffer.from([0xff, 0xd9])]));
      photos.push({ file: `refs/${i}.jpg`, source_url: `https://commons.wikimedia.org/wiki/File:Bobbit_${i}.jpg`, author: `摄影者 ${i}`, license: 'CC BY-SA 4.0', caption: `实拍 ${i}` });
    }
    photos.push({ file: '../outside.jpg', source_url: 'https://example.com', author: 'x', license: 'x', caption: 'outside the folder' });
    writeFileSync(join(dir, 'refs.json'), JSON.stringify({ scientific_name: 'Eunice aphroditois', length_cm: 100, habitat: 'sea_floor', photos, facts: ['白天躲在沙里的洞中', '夜里伸出头部等猎物经过'] }));
    text = `找到了 ${n} 张实拍照片。`;
  } else if (prompt.includes('./skill/SKILL.md') && prompt.includes('exploration.json')) {
    // making a whole 探索课 from the Skill copied next to it: research on the web, then a package folder
    if (!args.includes('web_search="live"') || !args.includes('sandbox_workspace_write.network_access=true')) { console.error('no network in this sandbox'); process.exit(1); }
    if (!existsSync(join(dir, 'skill', 'SKILL.md')) || existsSync(join(dir, 'skill', 'tests'))) { console.error('the Skill is not here as ./skill'); process.exit(1); }
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '查到了：蜜蜂的巢房是六边形，四年级刚学角的度量，就从六边形的角开始。' } }));
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: "/bin/zsh -lc 'cd package/web && pnpm build'" } }));
    if (existsSync(join(home, 'no-package'))) { writeFileSync(out, '没能做完：构建失败。'); process.exit(0); }
    const id = /id "(X-[A-Za-z0-9-]+)"/.exec(prompt)?.[1], kid = /for_child "([a-z]+)"/.exec(prompt)?.[1];
    const put = (f, t) => { mkdirSync(join(dir, 'package', f, '..'), { recursive: true }); writeFileSync(join(dir, 'package', f), t); };
    // the topic it was asked for, its hero made for it and on the asset list (references/topic-assets.md);
    // a file assets-copied in its home leaves in a picture taken from elsewhere, unlisted; assets-reused names a file it copies in
    const topic = /主题：「(.+?)」/.exec(prompt)?.[1] ?? '', hero = topic === '蜜蜂' ? 'hive' : 'hero';
    // one topic, one model: a hero that passes the file checks (20 000 triangles, 1024 px textures, real size 10 m);
    // a file cartoon-hero in its home hands in what the parent turned down: a few flat-coloured blocks
    const cartoon = existsSync(join(home, 'cartoon-hero'));
    const model = heroGlb(createHash('md5').update(topic).digest()[0], cartoon);
    put('exploration.json', JSON.stringify({ format: 'adw-explore/1', id, version: '1.0', for_child: kid, grade: 4, topic, title: topic === '蜜蜂' ? '蜜蜂的六边形巢房' : `${topic}探索课`, concept: '角的度量', subjects: ['数学', '科学'], minutes: 25, summary: '转动三维蜂巢，量六边形的角。', entry: 'web/dist/index.html' }));
    put('web/dist/index.html', `<!doctype html><title>${topic}</title><script type="module" src="./assets/index.js"></script>`);
    // the family's lesson rules and the visual gate (references/family-profile.md); a file no-family in its home leaves them out
    const family = !existsSync(join(home, 'no-family'));
    put('web/dist/assets/index.js', `const BRIDGE = 'adw-explore/1'; ${family ? "const FAMILY = 'adw-family/1'; " : ''}fetch('./models/${hero}.glb');`);
    if (family) {
      // the blind look (references/hero-production.md): photo and picture shuffled, judged by a model that didn't make it
      const blind = existsSync(join(home, 'no-blind')) ? [] : ['正面', '侧面', '近景'].map(view => ({ view, subject: 'hero', media: 'render', photo: `research/ref-${view}.jpg`, ours: `evidence/${view}.png`, reviewer: '另一个看图模型', same_thing: true, verdict: 'photo', flaws: [] }));
      put('web/dist/lesson-flow.json', JSON.stringify({ format: 'adw-family/1', visual_gate: { sheet: 'evidence/visual-gate.jpg', blind_review: blind } }));
      put('evidence/visual-gate.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    }
    put(`web/dist/models/${hero}.glb`, model);
    const items = [{ file: `web/dist/models/${hero}.glb`, sha256: createHash('sha256').update(model).digest('hex'), role: 'hero', depicts: `${topic}（三维模型）`, made_for: topic,
      origin: cartoon ? 'modeled' : 'scan', how: cartoon ? 'Blender 照着照片拼' : '实物扫描后修整', license: 'CC0', source_url: 'https://example.org/scan', class: cartoon ? 'organism' : 'object', real_size_m: 10,
      reference_photos: ['正面', '侧面', '俯视'].map(angle => ({ source: `https://example.org/${angle}.jpg`, angle })) }];
    if (existsSync(join(home, 'assets-copied'))) put('web/dist/img/robot-arm.png', Buffer.alloc(4096, 7));
    if (existsSync(join(home, 'assets-reused'))) {
      const old = readFileSync(readFileSync(join(home, 'assets-reused'), 'utf8').trim());
      put('web/dist/models/borrowed.glb', old);
      items.push({ file: 'web/dist/models/borrowed.glb', sha256: createHash('sha256').update(old).digest('hex'), role: 'scene', depicts: `${topic}的环境`, made_for: topic, origin: 'modeled', how: '本次建模', license: '自制' });
    }
    put('research/assets.json', JSON.stringify({ topic, items }));
    put('web/node_modules/three/index.js', 'not packed');
    for (const f of ['README.md', '课程设计.md', '验收结果.md', 'licenses/README.md']) put(f, `# ${f}`);
    symlinkSync('/etc/hosts', join(dir, 'package', 'web', 'dist', 'leak.txt'));
    text = '做好了「蜜蜂的六边形巢房」：孩子转动蜂巢、量六边形的角；配音还是机器声。';
  } else if (prompt.includes('$imagegen')) {
    const png = env.FAKE_CODEX_IMAGE ? readFileSync(env.FAKE_CODEX_IMAGE) : Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a3e1d2a80000000049454e44ae426082', 'hex');
    const saved = join(home, 'generated_images', 'thread-1', 'ig_1.png');
    mkdirSync(join(home, 'generated_images', 'thread-1'), { recursive: true });
    writeFileSync(saved, png);
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'image_generation', saved_path: saved } }));
    if (!existsSync(join(home, 'no-copy'))) copyFileSync(saved, join(dir, 'out.png'));
    text = '画了一只侧面的孔雀螳螂虾。';
  } else {
    const queue = join(home, 'replies.json');
    const replies = existsSync(queue) ? JSON.parse(readFileSync(queue, 'utf8')) : [];
    if (replies.length) { text = replies.shift(); writeFileSync(queue, JSON.stringify(replies)); }
    else if (prompt.includes('用一句话介绍你自己')) text = '我是 ChatGPT。';
    else if (/【对方】\n好了/.test(prompt)) text = '【课程方案】\n孩子：哥哥（4 年级）\n知识点：长方形面积　容易错的地方：周长和面积弄反\n组件和主题：铺格子，用大桥';
    else text = '想练面积还是周长？我建议用大桥做主题。';
  }
  writeFileSync(out, text);
  process.exit(0);
});

/** A test hero .glb: a 10 m box drawn 20 000 times over with 1024 px colour and normal maps (or, cartoon, 12 flat triangles). */
function heroGlb(tint, cartoon) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]), c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const png = (w, rgb) => { const h = Buffer.alloc(13); h.writeUInt32BE(w, 0); h.writeUInt32BE(w, 4); h[8] = 8; h[9] = 2;
    const row = Buffer.from([0, ...Array.from({ length: w }, () => rgb).flat()]);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', h), chunk('IDAT', deflateSync(Buffer.concat(Array(w).fill(row)))), chunk('IEND', Buffer.alloc(0))]); };
  const pos = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 10], uv = [0, 0, 1, 0, 1, 1, 0, 1];
  const tris = cartoon ? 12 : 20000, idx = Array.from({ length: tris * 3 }, (_, i) => [0, 1, 2, 0, 2, 3][i % 6]);
  const parts = [], views = []; let off = 0;
  const add = b => { const pad = (4 - b.length % 4) % 4; views.push({ buffer: 0, byteOffset: off, byteLength: b.length }); parts.push(b, Buffer.alloc(pad)); off += b.length + pad; return views.length - 1; };
  const vP = add(Buffer.from(new Float32Array(pos).buffer)), vT = add(Buffer.from(new Float32Array(uv).buffer)), vI = add(Buffer.from(new Uint16Array(idx).buffer));
  const imgs = cartoon ? [] : [add(png(1024, [120, 110, tint])), add(png(1024, [128, 128, 255]))];
  const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: cartoon ? { POSITION: 0 } : { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
    accessors: [{ bufferView: vP, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [10, 10, 10] },
      { bufferView: vT, componentType: 5126, count: 4, type: 'VEC2' }, { bufferView: vI, componentType: 5123, count: idx.length, type: 'SCALAR' }],
    materials: [cartoon ? { pbrMetallicRoughness: { baseColorFactor: [1, 0.8, 0, 1] } } : { pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, normalTexture: { index: 1 } }],
    ...(cartoon ? {} : { textures: [{ source: 0 }, { source: 1 }], images: imgs.map(bufferView => ({ bufferView, mimeType: 'image/png' })) }),
    bufferViews: views, buffers: [{ byteLength: off }] };
  const js = Buffer.from(JSON.stringify(json)), jpad = Buffer.alloc((4 - js.length % 4) % 4, 0x20), bin = Buffer.concat(parts);
  const head = Buffer.alloc(12); head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(28 + js.length + jpad.length + bin.length, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  return Buffer.concat([head, ch(js.length + jpad.length, 0x4e4f534a), js, jpad, ch(bin.length, 0x004e4942), bin]);
}
