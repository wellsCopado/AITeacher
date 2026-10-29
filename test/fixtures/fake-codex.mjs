#!/usr/bin/env node
// Stands in for the Codex command line in tests: same arguments, canned answers, every run logged.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
