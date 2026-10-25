// ChatGPT through the Codex command line on the family computer. The parent signs in once with their ChatGPT
// account (Plus includes Codex); after that the server runs `codex exec` in the background for planning chats,
// lesson writing and photoreal pictures, all started from the parent app. No API key, nothing to do inside Codex.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelError, type Chat, type Message, type ModelConfig } from './llm.js';

export interface CodexOpts { bin?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }

export const INSTALL_CODEX = '这台服务器电脑上还没装 Codex：在终端运行 npm i -g @openai/codex，再运行 codex login，用 ChatGPT 账号登录';
export const LOGIN_CODEX = 'Codex 还没登录 ChatGPT 账号：在服务器电脑的终端运行 codex login，在打开的网页里登录（只要做一次）';

const bin = (o: CodexOpts) => o.bin ?? (o.env ?? process.env).ADW_CODEX_BIN ?? 'codex';
const home = (o: CodexOpts) => (o.env ?? process.env).CODEX_HOME ?? join(homedir(), '.codex');

function run(o: CodexOpts, args: string[], input: string | null, timeoutMs: number): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin(o), args, { env: { ...(o.env ?? process.env), NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const keep = (s: string, d: Buffer) => (s + d.toString()).slice(-400_000);
    p.stdout.on('data', d => { out = keep(out, d); });
    p.stderr.on('data', d => { err = keep(err, d); });
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new ModelError(`Codex 超过 ${Math.round(timeoutMs / 60_000)} 分钟没有回答，已停止`)); }, timeoutMs);
    p.on('error', e => { clearTimeout(timer); reject(new ModelError((e as NodeJS.ErrnoException).code === 'ENOENT' ? INSTALL_CODEX : `启动 Codex 失败：${e.message}`)); });
    p.on('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
    p.stdin.on('error', () => undefined);
    p.stdin.end(input ?? '');
  });
}

/** Whether Codex is installed here and signed in, for the parent app's 大模型 card. */
export async function codexStatus(o: CodexOpts = {}): Promise<{ installed: boolean; version: string | null; logged_in: boolean; detail: string }> {
  let v;
  try { v = await run(o, ['--version'], null, 20_000); } catch (e) { return { installed: false, version: null, logged_in: false, detail: (e as Error).message }; }
  const version = /[\d]+\.[\d]+\.[\d]+/.exec(v.out)?.[0] ?? (v.out.trim() || null);
  const s = await run(o, ['login', 'status'], null, 20_000).catch(e => ({ code: 1, out: '', err: (e as Error).message }));
  const said = (s.out + s.err).trim().split('\n').pop() ?? '';
  const logged_in = s.code === 0 && !/not logged in/i.test(said);
  return { installed: v.code === 0, version, logged_in, detail: logged_in ? said : LOGIN_CODEX };
}

/** Why a run failed, in words the parent can act on. */
function failure(code: number | null, text: string): ModelError {
  const t = text.replace(/\x1b\[[0-9;]*m/g, '');
  if (/not logged in|\b401\b|unauthori[sz]ed/i.test(t)) return new ModelError(LOGIN_CODEX);
  if (/usage limit|rate limit|\b429\b/i.test(t)) return new ModelError('ChatGPT 套餐这段时间的 Codex 用量用完了，过一会儿再试，或先换别的模型');
  const last = t.split('\n').map(l => l.trim()).filter(l => l && !/^(warning|reading prompt)/i.test(l)).slice(-3).join(' ');
  return new ModelError(`Codex 出错（退出码 ${code}）：${last.slice(0, 300)}`);
}

export interface CodexRun {
  prompt: string; model?: string;
  /** Pictures to attach (reference photos). */
  images?: string[];
  /** Let Codex write into its scratch folder (pictures need this); text answers run read-only. */
  write?: boolean;
}

/** One `codex exec` in an empty scratch folder. Returns its last message and the folder (the caller removes it). */
export async function codexExec(r: CodexRun, o: CodexOpts = {}): Promise<{ text: string; dir: string; out: string; started: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'adw-codex-')), last = join(dir, '.reply.txt'), started = Date.now();
  const args = [
    'exec', '--skip-git-repo-check', '--ignore-user-config', '-C', dir, '--sandbox', r.write ? 'workspace-write' : 'read-only', '-o', last,
    ...(r.write ? ['--json'] : ['--ephemeral']), ...(r.model ? ['-m', r.model] : []), ...(r.images ?? []).map(i => `--image=${i}`),
  ];
  try {
    const p = await run(o, args, r.prompt, o.timeoutMs ?? 15 * 60_000);
    const text = existsSync(last) ? readFileSync(last, 'utf8').trim() : '';
    if (p.code !== 0) throw failure(p.code, `${p.err}\n${p.out}`);
    if (!text && !r.write) throw new ModelError('Codex 没有返回内容');
    return { text, dir, out: p.out, started };
  } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
}

/** A conversation as one prompt: Codex takes a single instruction per run. */
export function codexPrompt(messages: Message[]): string {
  const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const turns = messages.filter(m => m.role !== 'system');
  return [
    '你是在一个家庭学习系统的后台被调用的，只需要用文字回答：不要运行命令，不要读写文件，不要调用工具。',
    sys && `【说明】\n${sys}`,
    turns.length === 1 ? `【任务】\n${turns[0].content}` : `【到目前为止的对话】\n${turns.map(m => `${m.role === 'user' ? '【对方】' : '【你】'}\n${m.content}`).join('\n\n')}\n\n请直接写出你的下一条回复，只要回复本身。`,
  ].filter(Boolean).join('\n\n');
}

/** A chat function backed by the parent's ChatGPT account. */
export function codexChat(cfg: ModelConfig, o: CodexOpts = {}): Chat {
  return async messages => {
    const r = await codexExec({ prompt: codexPrompt(messages), model: cfg.model || undefined }, o);
    rmSync(r.dir, { recursive: true, force: true });
    return r.text;
  };
}

/** jpg / png / webp by their first bytes; null for anything else. */
export function sniffImage(b: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

const IMAGE_FILE = /\.(png|jpe?g|webp)$/i;
function images(dir: string, since: number, depth = 4): string[] {
  if (!existsSync(dir) || depth < 0) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return images(p, since, depth - 1);
    return IMAGE_FILE.test(e.name) && statSync(p).mtimeMs >= since ? [p] : [];
  });
}

/**
 * One photoreal picture from Codex's built-in image tool, guided by reference photos. Codex saves what it makes
 * under $CODEX_HOME/generated_images and is asked to copy it into the scratch folder; either place is accepted.
 */
export async function codexImage(a: { prompt: string; references: string[]; model?: string }, o: CodexOpts = {}): Promise<{ data: Buffer; mime: string; note: string }> {
  const prompt = `${a.prompt}\n\n用内置的图片生成工具（$imagegen）只生成一张图。生成后把这张图复制到当前工作目录，文件名 out.png（原图留在原处）。附上的照片只作参考，不要修改它们。最后用一句话说明画了什么。`;
  const r = await codexExec({ prompt, images: a.references, model: a.model, write: true }, o);
  try {
    const said = [...r.out.matchAll(/"(?:saved_?[pP]ath|path)"\s*:\s*"([^"]+\.(?:png|jpe?g|webp))"/g)].map(m => JSON.parse(`"${m[1]}"`) as string);
    const found = [join(r.dir, 'out.png'), ...images(r.dir, 0), ...said, ...images(join(home(o), 'generated_images'), r.started - 1000).sort((x, y) => statSync(y).mtimeMs - statSync(x).mtimeMs)];
    for (const f of found) {
      if (!existsSync(f) || a.references.includes(f)) continue;
      const data = readFileSync(f), mime = sniffImage(data);
      if (mime && data.length <= 20 * 1024 * 1024) return { data, mime, note: r.text.slice(0, 300) };
    }
    throw new ModelError(`Codex 没有生成图片${r.text ? `：${r.text.slice(0, 200)}` : ''}`);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
}
