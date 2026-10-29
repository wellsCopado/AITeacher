// Any chat model behind an OpenAI-compatible API: DeepSeek, Qwen (百炼), Kimi, GLM, Doubao, OpenAI, Claude,
// Gemini, a local Ollama… Switching models is a change of base URL, model name and key, nothing else.
// One more needs no key: the parent's ChatGPT account through Codex on the family computer (codex.ts).
import { codexChat, type CodexOpts } from './codex.js';

export interface ModelConfig {
  id: string;
  label: string;
  provider: string;
  base_url: string;
  model: string;
  api_key?: string;
  /** Ask for a JSON object reply (response_format). Turned off by itself when a provider refuses it. */
  json_mode?: boolean;
}

/** Known providers' OpenAI-compatible addresses. Model names change often: use "获取模型列表" to see current ones. */
export const PROVIDERS: { id: string; label: string; base_url: string; models: string[]; key_url?: string }[] = [
  { id: 'deepseek', label: 'DeepSeek', base_url: 'https://api.deepseek.com', models: ['deepseek-v4-pro', 'deepseek-flash'], key_url: 'https://platform.deepseek.com/api_keys' },
  { id: 'qwen', label: '通义千问（阿里云百炼）', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: [] },
  { id: 'kimi', label: 'Kimi（月之暗面）', base_url: 'https://api.moonshot.cn/v1', models: [] },
  { id: 'glm', label: '智谱 GLM', base_url: 'https://open.bigmodel.cn/api/paas/v4', models: [] },
  { id: 'doubao', label: '豆包（火山方舟）', base_url: 'https://ark.cn-beijing.volces.com/api/v3', models: [] },
  { id: 'codex', label: 'ChatGPT 账号（本机 Codex，用 Plus 额度，不用 Key）', base_url: '', models: [] },
  { id: 'openai', label: 'OpenAI（GPT，按 API 用量付费）', base_url: 'https://api.openai.com/v1', models: [] },
  { id: 'anthropic', label: 'Anthropic（Claude）', base_url: 'https://api.anthropic.com/v1', models: [] },
  { id: 'gemini', label: 'Google Gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', models: [] },
  { id: 'ollama', label: '本机 Ollama（不联网）', base_url: 'http://localhost:11434/v1', models: [] },
  { id: 'custom', label: '其他（OpenAI 兼容接口）', base_url: '', models: [] },
];

export type Message = { role: 'system' | 'user' | 'assistant'; content: string };
export type Chat = (messages: Message[]) => Promise<string>;

export class ModelError extends Error {}

const url = (cfg: ModelConfig, path: string) => cfg.base_url.replace(/\/+$/, '') + path;
const headers = (cfg: ModelConfig) => ({ 'content-type': 'application/json', ...(cfg.api_key ? { authorization: `Bearer ${cfg.api_key}` } : {}) });

async function call(cfg: ModelConfig, path: string, init: { method?: string; body?: unknown; timeoutMs?: number; fetchImpl?: typeof fetch }) {
  if (!/^https?:\/\//.test(cfg.base_url)) throw new ModelError('模型地址要以 http:// 或 https:// 开头');
  let r: Response;
  try {
    r = await (init.fetchImpl ?? fetch)(url(cfg, path), { method: init.method ?? 'GET', headers: headers(cfg), body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: AbortSignal.timeout(init.timeoutMs ?? 240_000) });
  } catch (e) { throw new ModelError(`连不上 ${cfg.base_url}：${(e as Error).message}`); }
  const text = await r.text();
  let body: any = null; try { body = JSON.parse(text); } catch { /* not JSON */ }
  if (!r.ok) {
    const msg = body?.error?.message ?? body?.message ?? text.slice(0, 200);
    throw Object.assign(new ModelError(r.status === 401 || r.status === 403 ? `API Key 不对或没有权限（${r.status}）：${msg}` : r.status === 402 ? `账户余额不足（402）：${msg}` : `模型接口出错（${r.status}）：${msg}`), { status: r.status });
  }
  return body;
}

/** Codex runs on this computer and talks to the parent's ChatGPT account: no address, no key, model optional. */
export const isCodex = (cfg: Pick<ModelConfig, 'provider'>) => cfg.provider === 'codex';

/** A chat function bound to one model. JSON mode and temperature are dropped if the provider refuses them. */
export function chatWith(cfg: ModelConfig, opts: { fetchImpl?: typeof fetch; timeoutMs?: number; codex?: CodexOpts } = {}): Chat {
  if (isCodex(cfg)) return codexChat(cfg, { ...opts.codex, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
  let json = cfg.json_mode !== false, temp = true;
  return async messages => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const body = await call(cfg, '/chat/completions', { method: 'POST', ...opts, body: {
          model: cfg.model, messages, ...(temp ? { temperature: 0.4 } : {}), ...(json ? { response_format: { type: 'json_object' } } : {}),
        } });
        const content = body?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) throw new ModelError('模型没有返回内容');
        return content;
      } catch (e) {
        if ((e as { status?: number }).status === 400 && (json || temp)) { if (json) json = false; else temp = false; continue; }
        throw e;
      }
    }
    throw new ModelError('模型接口一直拒绝请求');
  };
}

/** The models this key can use (GET /models), for picking one in the parent app. */
export async function listModels(cfg: ModelConfig, opts: { fetchImpl?: typeof fetch } = {}): Promise<string[]> {
  if (isCodex(cfg)) throw new ModelError('用 ChatGPT 账号时不用选模型：留空就用 Codex 默认的模型，也可以手填（例如 Codex 里 /model 列出的名字）');
  const body = await call(cfg, '/models', { timeoutMs: 20_000, ...opts });
  return ((body?.data ?? body?.models ?? []) as { id?: string; name?: string }[]).map(m => m.id ?? m.name ?? '').filter(Boolean).sort();
}

/** A model from environment variables (dls generate): ADW_LLM_PROVIDER, ADW_LLM_BASE_URL, ADW_LLM_MODEL, ADW_LLM_API_KEY. */
export function modelFromEnv(env: Record<string, string | undefined> = process.env): ModelConfig | null {
  const p = PROVIDERS.find(x => x.id === (env.ADW_LLM_PROVIDER ?? '').toLowerCase());
  if (p?.id === 'codex') return { id: 'env', label: p.label, provider: p.id, base_url: '', model: env.ADW_LLM_MODEL ?? '' };
  const base = env.ADW_LLM_BASE_URL ?? p?.base_url, model = env.ADW_LLM_MODEL ?? p?.models[0];
  if (!base || !model) return null;
  return { id: 'env', label: p?.label ?? base, provider: p?.id ?? 'custom', base_url: base, model, api_key: env.ADW_LLM_API_KEY };
}

/** The first JSON object in a reply, with or without a ```json fence around it. */
export function parseJsonReply(text: string): any {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const s = (fenced ? fenced[1] : text).trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* fall through */ } }
  throw new ModelError('模型返回的不是合法 JSON');
}
