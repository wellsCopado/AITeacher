// An 探索课 made from the parent app: Codex on the home computer works from the 探索课 Skill
// (skills/discovery-lesson-maker) in a scratch folder. It finds out what is worth learning about the topic
// for this child, builds the topic's own scene and lesson, and packs it the way the App imports it.
// What goes out is what every lesson writer gets: grade, 哥哥/妹妹, the topic, school progress and lesson titles.
import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { StudioContext } from './context.js';

/** The Skill Codex works from, copied next to it as ./skill (its own tests and caches left out). */
export const EXPLORE_SKILL = ['skills', 'discovery-lesson-maker'];
export function seedExploreSkill(root: string, dir: string) {
  const from = join(root, ...EXPLORE_SKILL);
  if (!existsSync(join(from, 'SKILL.md'))) throw new Error('仓库里没有探索课 Skill（skills/discovery-lesson-maker）');
  cpSync(from, join(dir, 'skill'), { recursive: true, filter: p => !/(^|\/)(tests|__pycache__|node_modules|\.DS_Store)(\/|$)/.test(p.slice(from.length)) });
}

/** The lesson id an AI-made 探索课 gets: one per child, day and topic (X-GEGE-20261104-1a2b). */
export const exploreId = (child: string, day: string, tag: string) => `X-${child.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'KID'}-${day.replace(/-/g, '')}-${tag}`;

export function explorePrompt(ctx: StudioContext, a: { topic: string; wish?: string; id: string }): string {
  const c = ctx.child, s = ctx.school;
  const recent = ctx.lessons_for_child.slice(-8).map(l => `「${l.title}」`).join('、');
  const declined = ctx.parent_declined?.lessons.map(l => `「${l.title}」${l.reason ? `（${l.reason}）` : ''}`).join('、');
  return `你在家里的 Mac 上、一个家庭学习 App（AI 探索世界）的后台，为一个孩子做一节探索课。家长只给了主题。研究、定学什么、建场景、做课、配音、打包和验收都由你完成，中途没有人回答问题。

## 照什么做
- 课程制作规则在 ./skill/ 里：先读 ./skill/SKILL.md，再按它的指引读 ./skill/references/ 里用得到的文件。
- 怎样接进这个 App（课程包格式、进度接口、打包和预检）：./skill/references/app-reference.md。进度接口原样复制 ./skill/assets/web/adw-host.mjs。

## 这节课
- 给：${c.label}，${c.grade} 年级（${c.region}${c.system}）。孩子编号 ${c.id}，写进 exploration.json 的 for_child；页面里不出现孩子的名字。
- 主题：「${a.topic}」。主角就是它，不换成更容易做的东西。
- 家长的要求：${a.wish?.trim() || '没有另外的要求'}
- 课内进度：${s.progress ?? `家长没填。今天是 ${s.today}（${s.term}），按年级和日期推断，并在 课程设计.md 里写明是推断的`}。
- 最近上过的课：${recent || '还没有'}。这节课的主导任务、观察方式和操作不要和它们一样，例如不要又是拉卷尺量周长和面积。
${declined ? `- 家长没采用过的课和原因：${declined}。不要重犯。\n` : ''}
## 先定学什么，再动手做
1. 查「${a.topic}」的真实资料：机构、博物馆、论文、百科的原始来源，记下来源。
2. 对照课内进度，找这个主题里真实存在、这个年级该学或刚学过的数学和科学，定一个主问题和 2–4 个学习目标。比如蜜蜂可以是巢房的六边形、采蜜的次数和距离。不要默认周长和面积。
3. 场景按「${a.topic}」真实生活或存在的地方自己做，不套别的课的场景。
4. 把调研结果、学习目标和你的取舍写在 课程设计.md 的开头。

## 交付
- 在当前目录做出课程包文件夹 package/，里面要有：
  - exploration.json：format "adw-explore/1"，id "${a.id}"，version "1.0"，for_child "${c.id}"，grade ${c.grade}，title、concept、subjects、minutes、summary 都要写；
  - 构建好的 web/dist/ 和 web 源码；
  - README.md、课程设计.md、验收结果.md；
  - licenses/ 和 research/sources.json。
- 运行 \`python3 ./skill/scripts/check_package.py package\`，errors 为空才算做完；warnings 写进 验收结果.md。
- 不要读写当前目录以外的文件：沙盒只让写当前目录，装依赖时把缓存也放在这里（\`npm install --cache ./.npm-cache\`，或 pnpm 加 \`--store-dir ./.pnpm-store\`）。不要把孩子的任何信息发到网上。
- 最后用两三句话说明：这节课学什么、孩子动手做什么、还有什么没做到。`;
}
