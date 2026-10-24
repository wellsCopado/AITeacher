// Lesson studio as an MCP server, so any agent (Codex, Claude Code, Qoder, Cursor, a GPT with MCP…) can write
// lessons with the same Skill, context and validator. Agents can only hand lessons in for the parent's review:
// there is no tool to approve or publish (that stays a button in the parent app).
// Transport-free: handle() takes one JSON-RPC message and returns the reply; stdio and HTTP wrap it.
import type { Stages } from './lesson.js';
import { GUIDE_TOPICS } from './guide.js';

export interface CheckOutcome { key: string; ok: boolean; errors: number; warnings: number; issues: { rule: string; level: string; path: string; msg: string; fix: string | null }[]; title?: string; saved_to?: string; status?: string }
export interface StudioBackend {
  /** 'local' works on a repo checkout (files under content/lessons); 'server' on the family server's database. */
  where: 'local' | 'server';
  children(): { id: string; label: string; grade: number }[];
  context(child: string): unknown;
  guide(topic: string): string;
  example(): Stages;
  check(stages: Stages): Promise<CheckOutcome> | CheckOutcome;
  /** Put a passing lesson in the parent's review queue (课程库 → 等你审核). */
  submit(stages: Stages): Promise<CheckOutcome & { status?: string }>;
  lessons(child?: string): unknown;
  /** One lesson as stage files (to revise a lesson the parent sent back), with its status and the parent's note. */
  lesson(key: string): unknown;
}

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const stagesSchema = {
  type: 'object', required: ['target', 'director', 'assets'],
  properties: {
    target: { type: 'object', description: '01-target.json 的内容' },
    director: { type: 'object', description: '02-director.json 的内容' },
    assets: { type: 'object', description: '03-assets.json 的内容' },
  },
};

export const INSTRUCTIONS = `AI Discovery World 做课工具。给哥哥（四年级）或妹妹（二年级）写以数学为主、包在孩子自己兴趣里的写实 3D 互动课。
顺序：1) adw_read_guide 读 Skill（topic=all），2) adw_get_context 拿这个孩子的兴趣、可用组件、建议主题、新课 id，3) adw_get_example 看一节完整的示例课，
4) 写 target / director / assets 三部分，用 adw_check_lesson 校验，按每条问题的 fix 改到全部通过，5) adw_submit_for_review 交给家长审核。
家长退回的课：adw_list_lessons 里状态是“已退回”，note 是家长的意见；用 adw_get_lesson 取回三部分，按意见改，校验通过后再交（id 和版本不变）。
发布只能由家长在家长端点按钮完成，这里没有发布工具。不要编造事实，不确定写“待科学审核”。`;

type Tool = { name: string; description: string; inputSchema: object; run(args: any): Promise<unknown> | unknown };

export function createMcp(b: StudioBackend, info = { name: 'adw-lesson-studio', version: '1.0.0' }) {
  const tools: Tool[] = [
    { name: 'adw_read_guide', description: `读做课 Skill（规则、固定上课流程、字段说明、组件、主题、校验规则）。topic：${Object.keys(GUIDE_TOPICS).join(' / ')} / all。第一次用先读 all。`,
      inputSchema: { type: 'object', properties: { topic: { type: 'string', enum: [...Object.keys(GUIDE_TOPICS), 'all'], default: 'all' } } },
      run: a => b.guide(a?.topic ?? 'all') },
    { name: 'adw_get_context', description: '一个孩子做课需要的全部信息：年级、自己的兴趣和下一课心愿、可用 3D 组件（参数范围、热点锚点、动作）、建议主题和课末心愿题、能用的素材、新课 id、必须原样使用的固定字段。',
      inputSchema: { type: 'object', required: ['child'], properties: { child: { type: 'string', description: `孩子 id：${b.children().map(c => `${c.id}（${c.label}，${c.grade} 年级）`).join('、')}` } } },
      run: a => b.context(String(a?.child ?? '')) },
    { name: 'adw_get_example', description: '一节完整、校验通过的示例课（target / director / assets），照它的结构写，内容要新写。', inputSchema: { type: 'object', properties: {} },
      run: () => b.example() },
    { name: 'adw_check_lesson', description: `组装并校验一节课（V01–V18）。返回每个问题的位置、原因和怎么改。${b.where === 'local' ? '同时把三份阶段文件写到 content/lessons/<id>/<版本>/。' : ''}`,
      inputSchema: stagesSchema, run: a => b.check(a as Stages) },
    { name: 'adw_submit_for_review', description: '校验通过的课交给家长审核（家长端「课程库 → 等你审核」）。家长看过、勾完四类审核才会发布。', inputSchema: stagesSchema,
      run: a => b.submit(a as Stages) },
    { name: 'adw_list_lessons', description: '已发布、等待审核和被家长退回的课（避免重复；退回的课带家长意见 note）。', inputSchema: { type: 'object', properties: { child: { type: 'string' } } },
      run: a => b.lessons(a?.child) },
    { name: 'adw_get_lesson', description: '取回一节课的 target / director / assets 三部分（修改家长退回的课时用），附状态和家长意见。',
      inputSchema: { type: 'object', required: ['key'], properties: { key: { type: 'string', description: '课的 id@版本，例如 L-PA-2@1.0' } } },
      run: a => b.lesson(String(a?.key ?? '')) },
  ];

  const ok = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });
  const err = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

  async function handleOne(m: any): Promise<object | null> {
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return err(m?.id ?? null, -32600, 'Invalid Request');
    const isNote = m.id === undefined || m.id === null;
    switch (m.method) {
      case 'initialize': {
        const want = m.params?.protocolVersion;
        return ok(m.id, { protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: info, instructions: INSTRUCTIONS });
      }
      case 'ping': return ok(m.id, {});
      case 'tools/list': return ok(m.id, { tools: tools.map(({ run: _r, ...t }) => t) });
      case 'tools/call': {
        const t = tools.find(x => x.name === m.params?.name);
        if (!t) return err(m.id, -32602, `没有这个工具：${m.params?.name}`);
        try {
          const out = await t.run(m.params?.arguments ?? {});
          return ok(m.id, { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 1) }] });
        } catch (e) {
          return ok(m.id, { isError: true, content: [{ type: 'text', text: (e as Error).message }] });
        }
      }
      case 'resources/list': return ok(m.id, { resources: [] });
      case 'prompts/list': return ok(m.id, { prompts: [] });
      default:
        if (isNote || m.method.startsWith('notifications/')) return null;
        return err(m.id, -32601, `Method not found: ${m.method}`);
    }
  }

  return {
    tools,
    /** One message or a batch; null when nothing needs to be sent back (notifications). */
    async handle(msg: unknown): Promise<object | object[] | null> {
      if (Array.isArray(msg)) { const out = (await Promise.all(msg.map(handleOne))).filter(Boolean) as object[]; return out.length ? out : null; }
      return handleOne(msg);
    },
  };
}

/** MCP over stdin/stdout (newline-delimited JSON-RPC), for agents that start `dls mcp` themselves. */
export function serveStdio(mcp: ReturnType<typeof createMcp>, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout) {
  let buf = '';
  input.setEncoding?.('utf8');
  input.on('data', async (chunk: string) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg: unknown;
      try { msg = JSON.parse(line); } catch { output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); continue; }
      const reply = await mcp.handle(msg);
      if (reply) output.write(JSON.stringify(reply) + '\n');
    }
  });
}
