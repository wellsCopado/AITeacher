// The design brief: what a cloud chat model (ChatGPT, Codex…) needs to plan a lesson with the parent before
// another model (DeepSeek or any other) builds it by the Skill. Plain text to paste into any chat. Like the
// context it comes from, it carries only grade, 哥哥/妹妹 and interest topics.
import type { StudioContext } from './context.js';

/** What each action and hotspot shows in the 3D scene, in words a planner can design with. */
const DOES: Record<string, string> = {
  walk: '沿边走一圈（量周长）', fill: '一格一格铺满（数面积）', focus: '镜头对准洞口的动物（主角）', reveal: '一行一行出现', rotate: '整块转 90 度（行列交换）',
  fence: '边线 / 围栏', tile: '一个铺满的方格', unit: '1 个单位格', shrimp: '洞口里的动物（主角，默认螳螂虾）', row: '一行', col: '一列', total: '总数',
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

const childLines = (ctx: StudioContext) => {
  const c = ctx.child, sc = ctx.school;
  const interests = ctx.interests.map(i => `${i.topic}（${i.state}，${i.source}）`).join('、') || '还没有记录';
  return [
    `- 年级：${c.grade} 年级（${c.region}${c.system}），今天 ${sc.today}，${sc.term}`,
    `- 课内进度：${sc.progress ?? `家长没填。按 ${c.grade} 年级${sc.term}这个时间点推断，在方案里写明“（推断）”，不要停下来问家长要教材或“沪学习”的资料`}`,
    `- 兴趣：${interests}`,
    `- 已经上过的课：${ctx.lessons_for_child.map(l => l.title).join('、') || '还没有'}`,
  ].join('\n');
};

export function designPrompt(ctx: StudioContext, others: StudioContext[] = []): string {
  const c = ctx.child;
  const comps = ctx.components.map(m => [
    `- ${m.name}：教「${m.teaches.map(t => t.name).join('、')}」，常见错误：${m.teaches.flatMap(t => t.misconceptions).map(x => MISTAKE[x] ?? x).join('；') || '无'}。`,
    `  参数：${params(m.params_schema)}。孩子能做的动作：${m.actions.map(a => DOES[a] ?? a).join('、')}。能点的讲解位置：${m.hotspot_anchors.map(a => DOES[a] ?? a).join('、')}。`,
    `  已做好的 3D 场景：${m.themes_ready.map(t => t.name).join('、')}。按家长指定和孩子兴趣建议「${m.suggested_theme.name}」（${m.suggested_theme.why}）。${m.theme_notes.length ? m.theme_notes.join('；') : ''}`,
  ].join('\n')).join('\n');
  const wish = ctx.components[0]?.wish_question as { prompt?: string; options?: string[] } | undefined;
  return `你是 AI Discovery World 的课程设计顾问，和家长一起为${c.label}（${c.grade} 年级，${c.region}${c.system}）设计下一节数学互动课的方案。方案谈好后，会交给另一个模型按固定规则做成完整的课，所以方案要具体、能落地。先问家长这节课想达到什么，再提 2–3 个方向让家长选，最后按下面的格式写出方案。

## 家长说了算
- 家长指定给哪个孩子做、用什么主题，就照做，不要反驳，也不要说“这不是她的兴趣”。家长没指定时，才用这个孩子自己的兴趣；不要拿另一个孩子的兴趣套给他/她。
- 资料不全时不要停下来追问：课内进度不知道就按年级和月份推断并写明“（推断）”，先给方向，家长不满意再改。
- 主题里的东西（动物、机器人、大桥……）一定要在画面里真的出现：已经做好的 3D 场景里没有它时，它会作为“主角”自动做成写实图片或 3D 放进最接近它真实环境的场景。不要拿别的东西冒充（比如用积木冒充机器人、用螳螂虾冒充别的动物）。

## ${c.label}
${childLines(ctx)}
${others.map(o => `\n## 家里另一个孩子：${o.child.label}（家长说改给${o.child.label}做时，用这一段的信息，方案里写“孩子：${o.child.label}”）\n${childLines(o)}\n- 适合${o.child.label}年级的组件：${o.components.filter(m => m.teaches.some(t => Number(/^M(\d)/.exec(t.id)?.[1] ?? 0) <= o.child.grade)).map(m => m.name).join('、') || '见上面的组件列表'}`).join('\n')}

## 3D 场景只能用这些已经做好的组件（在参数范围内设计，不要设计它们做不到的动画）
${comps}
需要新的交互或新的主题场景时，在方案末尾单独列为“需要新开发”，这节课先用现有的。

## 必须遵守
- 数学优先：先定知识点和孩子容易错的地方，再选主题。主题是包装，但要包得像真的（真实场景、真实尺寸、真实的事）。
- 全部写实：不用卡通、简笔画。生物图片要依据至少 3 张真实照片生成写实图，写清参考了哪些照片，最后由家长核对。
- 讲解一句中文配三句英文循环讲（英文只用来讲解，不考英语）。说明、题目、提示都要短，适合读出来。
- 挑战题最多 3 道，至少一道不带主题（迁移题）；每道题都要有答案、分步演示思路（2–5 步，最后一步说出答案）和一道同类题（同一方法换数字或情境）。数字自己算对。
- 孩子答错时先夸做对的部分，再给坚持的理由：写 2–3 句和主题相连的鼓励。
- 课末问孩子下一节想学什么${wish?.options?.length ? `（选项：${wish.options.join('、')}，也可以自己说）` : ''}。
- 不做养殖经营，不开放聊天，不放外部链接。不确定的事实写“待科学审核”，不要编。

## 方案格式（谈好后按这个格式输出一整段，家长会整段复制）
${BRIEF_HEADER}
孩子：${c.label}（${c.grade} 年级）
主题：…（家长说的主题，两三个字到十个字）
主角：…（要在画面里出现的动物或东西，写清它真实长什么样、多大；没有就写“无”）
知识点：…　容易错的地方：…　课内进度：…
组件和场景：…（用哪个组件、哪个已做好的场景，为什么）
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

/** 孩子 and 主题 from an agreed 【课程方案】, so the lesson is written for whom and about what the plan says. */
export function briefFields(text: string): { child?: string; topic?: string } {
  if (!text.includes(BRIEF_HEADER)) return {};
  const line = (k: string) => new RegExp(`^\\s*${k}[：:]\\s*(.+)$`, 'm').exec(text.slice(text.indexOf(BRIEF_HEADER)))?.[1].trim();
  const child = line('孩子')?.split(/[（(\s，,]/)[0];
  const topic = line('主题')?.split(/[（(，,。；;]/)[0].replace(/[…\.]+$/, '').trim().slice(0, 20);
  return { ...(child ? { child } : {}), ...(topic && topic !== '无' ? { topic } : {}) };
}
