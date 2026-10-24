// The design brief: what a cloud chat model (ChatGPT, Codex…) needs to plan a lesson with the parent before
// another model (DeepSeek or any other) builds it by the Skill. Plain text to paste into any chat. Like the
// context it comes from, it carries only grade, 哥哥/妹妹 and interest topics.
import type { StudioContext } from './context.js';

/** What each action and hotspot shows in the 3D scene, in words a planner can design with. */
const DOES: Record<string, string> = {
  walk: '沿边走一圈（量周长）', fill: '一格一格铺满（数面积）', focus: '镜头对准生物或物体', reveal: '一行一行出现', rotate: '整块转 90 度（行列交换）',
  fence: '边线 / 围栏', tile: '一个铺满的方格', unit: '1 个单位格', shrimp: '洞口里的螳螂虾', row: '一行', col: '一列', total: '总数',
};
const MISTAKE: Record<string, string> = {
  'MC.unit_len_vs_area': '长度单位和面积单位混用（米 / 平方米）', 'MC.perim_area_swap': '周长和面积弄反',
  'MC.mul_as_repeated_groups': '不理解乘法是“几个几”', 'MC.commutative_array': '不知道行列交换后积不变',
};

function params(schema: unknown): string {
  const props = (schema as { properties?: Record<string, { type?: string; minimum?: number; maximum?: number; enum?: string[] }> })?.properties ?? {};
  return Object.entries(props).map(([k, p]) => p.enum ? `${k} 取 ${p.enum.join(' / ')}` : p.minimum !== undefined ? `${k} 是 ${p.minimum}–${p.maximum} 的${p.type === 'integer' ? '整数' : '数'}` : `${k} ${p.type === 'boolean' ? '是 / 否' : '可选'}`).join('，');
}

export const BRIEF_HEADER = '【课程方案】';

export function designPrompt(ctx: StudioContext): string {
  const c = ctx.child;
  const interests = ctx.interests.map(i => `${i.topic}（${i.state}，${i.source}）`).join('、') || '还没有记录，用中性题材';
  const comps = ctx.components.map(m => [
    `- ${m.name}：教「${m.teaches.map(t => t.name).join('、')}」，常见错误：${m.teaches.flatMap(t => t.misconceptions).map(x => MISTAKE[x] ?? x).join('；') || '无'}。`,
    `  参数：${params(m.params_schema)}。孩子能做的动作：${m.actions.map(a => DOES[a] ?? a).join('、')}。能点的讲解位置：${m.hotspot_anchors.map(a => DOES[a] ?? a).join('、')}。`,
    `  已做好的主题场景：${m.themes_ready.map(t => t.name).join('、')}。按孩子兴趣建议用「${m.suggested_theme.name}」（${m.suggested_theme.why}）。${m.theme_notes.length ? m.theme_notes.join('；') : ''}`,
  ].join('\n')).join('\n');
  const wish = ctx.components[0]?.wish_question as { prompt?: string; options?: string[] } | undefined;
  return `你是 AI Discovery World 的课程设计顾问，和家长一起为${c.label}（${c.grade} 年级，${c.region}${c.system}）设计下一节数学互动课的方案。方案谈好后，会交给另一个模型按固定规则做成完整的课，所以方案要具体、能落地。先问家长这节课想达到什么，再提 2–3 个方向让家长选，最后按下面的格式写出方案。

## 孩子
- 年级：${c.grade} 年级（${c.region}${c.system}）
- 兴趣：${interests}。主题只能来自这个孩子自己的兴趣，不要用别的孩子的兴趣。
- 已经上过的课：${ctx.lessons_for_child.map(l => l.title).join('、') || '还没有'}

## 3D 场景只能用这些已经做好的组件（在参数范围内设计，不要设计它们做不到的动画）
${comps}
需要新的交互或新的主题场景时，在方案末尾单独列为“需要新开发”，这节课先用现有的。

## 必须遵守
- 数学优先：先定知识点和孩子容易错的地方，再选主题。主题只是包装。
- 全部写实：不用卡通、简笔画。需要生物图片时，要依据至少 3 张真实照片生成写实图，写清参考了哪些照片，最后由家长核对。
- 讲解一句中文配三句英文循环讲（英文只用来讲解，不考英语）。说明、题目、提示都要短，适合读出来。
- 挑战题最多 3 道，至少一道不带主题（迁移题）；每道题都要有答案、分步演示思路（2–5 步，最后一步说出答案）和一道同类题（同一方法换数字或情境）。数字自己算对。
- 孩子答错时先夸做对的部分，再给坚持的理由：写 2–3 句和主题相连的鼓励。
- 课末问孩子下一节想学什么${wish?.options?.length ? `（选项：${wish.options.join('、')}，也可以自己说）` : ''}。
- 不做养殖经营，不开放聊天，不放外部链接。不确定的事实写“待科学审核”，不要编。

## 方案格式（谈好后按这个格式输出一整段，家长会整段复制）
${BRIEF_HEADER}
孩子：${c.label}（${c.grade} 年级）
知识点：…　容易错的地方：…
组件和主题：…（为什么选这个主题，对应孩子的哪个兴趣）
参数：…（例如 长 6、宽 4）
说明页：一句标题 + 两三句话
3D 里孩子要做的事：1. … 2. …
讲解要点：每个讲解位置一句中文要点
挑战题：
1. 题目… 答案… 演示思路… 同类题…
2. …
3.（不带主题的迁移题）…
鼓励的话：…
需要的图片：…（写实；参考了哪些实拍照片）
需要新开发：…（没有就写“无”）`;
}
