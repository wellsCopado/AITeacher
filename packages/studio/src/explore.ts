// An 探索课 made from the parent app: Codex on the home computer works from the 探索课 Skill
// (skills/discovery-lesson-maker) in a scratch folder. It finds out what is worth learning about the topic
// for this child, builds the topic's own scene and lesson, and packs it the way the App imports it.
// What goes out is what every lesson writer gets: grade, 哥哥/妹妹, the topic, school progress and lesson titles.
// 写啥主题就做啥图片: every picture is listed as made for the topic (research/assets.json); the App checks it on import.
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
3. 孩子看到的每一样画面都为「${a.topic}」现做现找（步骤和验收照 ./skill/references/topic-assets.md）：动手前先列素材清单 research/assets.json——主角、部件、环境、题目和讲解的配图，每一项写画的是什么（depicts）、made_for "${a.topic}"、怎么来的（origin、how）、许可和 sha256。场景是「${a.topic}」真实所在的地方；配图从本课自己的三维场景渲染。不用 App 里、别的课的场景和素材（机械臂、齿轮、积木、珊瑚礁、花园的栅栏和地砖都不行，除非主题就是它），不用卡通或别的东西顶替；做不出来的写进 课程设计.md 的缺口。
4. 把调研结果、学习目标和你的取舍写在 课程设计.md 的开头。

## 这个家庭的上课规则（硬要求，家长定的）
先读 ./skill/references/family-profile.md，每一条都是验收条件，优先于 Skill 里给别的用户的默认值（不计时、英语可选那些不适用）：
- 用 ./skill/assets/web/adw-family.mjs 跑上课流程：步骤按顺序解锁、每步倒计时、到时间自动下一步、字幕加朗读、讲解一中三英、答错先夸做对的地方再说看哪里、错 3 次先演示再做同类题。不要自己另写。
- 孩子看到、听到的每句话写进 web/public/lesson-flow.json（照 ./skill/examples/lesson-flow.example.json），用 \`python3 ./skill/scripts/make_family_audio.py web/public\` 录音。给孩子的话短、像老师在旁边说，不写“示意、近似、不能推成”这类给大人的话，那些放进 parent_notes。
- 至少 3 个孩子用手指亲手改变三维场景的实验（拖、转、推、组装、放、描），切镜头、下拉框、滑条不算。
- 主角是真三维、环境像那个真实的地方；只用免费素材和本机工具，要花钱的写进 课程设计.md 等家长决定。
- 画面按 references/photoreal-pipeline.md：先查真实尺寸（单位米，带来源）再建模，画面里放孩子熟悉的尺度参照；“看”的步骤写 media: render，给同一模型的光线追踪图（scripts/render_stills.py）；有实验或动手题的步骤写 media: realtime，用实时三维。
- 写题目之前先做画面对照图 evidence/visual-gate.jpg（同机位的真实照片、实时网页截图、有“看”的步骤时再加预渲染图），按假感毛病表挑毛病、返工，写进 lesson-flow.json 的 visual_gate（views、dimensions、self_review），并放在 验收结果.md 第一段。

## 交付
- 在当前目录做出课程包文件夹 package/，里面要有：
  - exploration.json：format "adw-explore/1"，topic "${a.topic}"（家长的原词，一字不改），id "${a.id}"，version "1.0"，for_child "${c.id}"，grade ${c.grade}，title、concept、subjects、minutes、summary 都要写；
  - 构建好的 web/dist/ 和 web 源码；
  - README.md、课程设计.md、验收结果.md；
  - licenses/ 和 research/sources.json。
- 运行 \`python3 ./skill/scripts/check_package.py package\`，errors 为空才算做完（它也按家庭规则检查）；warnings 写进 验收结果.md。
- 不要读写当前目录以外的文件：沙盒只让写当前目录，装依赖时把缓存也放在这里（\`npm install --cache ./.npm-cache\`，或 pnpm 加 \`--store-dir ./.pnpm-store\`）。不要把孩子的任何信息发到网上。
- 最后用两三句话说明：这节课学什么、孩子亲手做哪几个实验、画面对照图里还有哪些不像、还有什么没做到。`;
}
