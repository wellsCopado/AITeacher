#!/usr/bin/env node
// Stands in for the Codex command line in tests: same arguments, canned answers, every run logged.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

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
    const model = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(2048, createHash('md5').update(topic).digest())]); // one topic, one model
    put('exploration.json', JSON.stringify({ format: 'adw-explore/1', id, version: '1.0', for_child: kid, grade: 4, topic, title: topic === '蜜蜂' ? '蜜蜂的六边形巢房' : `${topic}探索课`, concept: '角的度量', subjects: ['数学', '科学'], minutes: 25, summary: '转动三维蜂巢，量六边形的角。', entry: 'web/dist/index.html' }));
    put('web/dist/index.html', `<!doctype html><title>${topic}</title><script type="module" src="./assets/index.js"></script>`);
    // the family's lesson rules and the visual gate (references/family-profile.md); a file no-family in its home leaves them out
    const family = !existsSync(join(home, 'no-family'));
    put('web/dist/assets/index.js', `const BRIDGE = 'adw-explore/1'; ${family ? "const FAMILY = 'adw-family/1'; " : ''}fetch('./models/${hero}.glb');`);
    if (family) {
      put('web/dist/lesson-flow.json', JSON.stringify({ format: 'adw-family/1', visual_gate: { sheet: 'evidence/visual-gate.jpg' } }));
      put('evidence/visual-gate.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    }
    put(`web/dist/models/${hero}.glb`, model);
    const items = [{ file: `web/dist/models/${hero}.glb`, sha256: createHash('sha256').update(model).digest('hex'), role: 'hero', depicts: `${topic}（三维模型）`, made_for: topic, origin: 'modeled', how: 'Blender 本次建模', license: '自制' }];
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
