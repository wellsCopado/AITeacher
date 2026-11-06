// Cloud narration voices: neural TTS that sounds like a trained announcer, far less "AI" than the Mac's
// built-in voices. One engine at a time, chosen by the parent (key kept on the family server only).
//   azure      — Microsoft Azure Speech (晓晓/云扬 etc.); one key covers Mandarin and US English;
//                free tier F0 = 500,000 characters a month, plenty for a family.
//   volcengine — 火山引擎 豆包语音 (ByteDance): very natural Mandarin; voice ids come from its console.
//   openai     — any OpenAI-compatible /audio/speech endpoint (OpenAI gpt-4o-mini-tts etc.).
// Every engine returns 24 kHz 16-bit mono WAV, the same format as the Mac's `say` here, so lines can be joined.
import { randomUUID } from 'node:crypto';
import { runs } from '../../../packages/player/src/voice.js';
import type { Lang, Synth, VoiceInfo } from './tts.js';

export type Provider = 'azure' | 'volcengine' | 'openai';
export const PROVIDERS: Provider[] = ['azure', 'volcengine', 'openai'];
export interface CloudConfig {
  provider: Provider;
  api_key: string;
  /** azure: region such as eastasia / southeastasia / japaneast */
  region?: string;
  /** volcengine: AppID and cluster from the console (cluster usually volcano_tts) */
  appid?: string;
  cluster?: string;
  /** openai: base URL (default https://api.openai.com/v1) and model (default gpt-4o-mini-tts) */
  base_url?: string;
  model?: string;
  voices: Record<Lang, string>;
  /** azure: speaking style for the Chinese voice (e.g. gentle, newscast); openai: delivery instructions */
  style?: string;
}

/** Suggested voices per engine, best first. Names a parent can also type in themselves. */
export const CLOUD_VOICES: Record<Provider, (Omit<VoiceInfo, 'quality'> & { note: string })[]> = {
  azure: [
    { name: 'zh-CN-XiaoxiaoNeural', locale: 'zh_CN', lang: 'zh', note: '晓晓 · 温暖清楚的女声，讲解最自然' },
    { name: 'zh-CN-YunyangNeural', locale: 'zh_CN', lang: 'zh', note: '云扬 · 新闻播音男声，最“标准播音”' },
    { name: 'zh-CN-XiaochenNeural', locale: 'zh_CN', lang: 'zh', note: '晓辰 · 轻松自然的女声' },
    { name: 'zh-CN-YunxiNeural', locale: 'zh_CN', lang: 'zh', note: '云希 · 年轻男声，讲故事' },
    { name: 'en-US-AvaNeural', locale: 'en_US', lang: 'en', note: 'Ava · 美式女声，亲切清楚' },
    { name: 'en-US-AndrewNeural', locale: 'en_US', lang: 'en', note: 'Andrew · 美式男声，温和' },
    { name: 'en-US-JennyNeural', locale: 'en_US', lang: 'en', note: 'Jenny · 美式女声，播报感' },
    { name: 'en-GB-SoniaNeural', locale: 'en_GB', lang: 'en', note: 'Sonia · 英式女声' },
  ],
  volcengine: [
    { name: 'BV001_streaming', locale: 'zh_CN', lang: 'zh', note: '通用女声' },
    { name: 'BV701_streaming', locale: 'zh_CN', lang: 'zh', note: '擎苍 · 旁白男声' },
    { name: 'BV700_streaming', locale: 'zh_CN', lang: 'zh', note: '灿灿 · 多情感女声' },
    { name: 'BV503_streaming', locale: 'en_US', lang: 'en', note: '英文女声（以控制台开通的音色为准）' },
  ],
  openai: [
    { name: 'coral', locale: 'zh_CN', lang: 'zh', note: 'coral · 温暖女声（中文略带口音）' },
    { name: 'sage', locale: 'zh_CN', lang: 'zh', note: 'sage · 平静女声' },
    { name: 'coral', locale: 'en_US', lang: 'en', note: 'coral · 温暖女声' },
    { name: 'ash', locale: 'en_US', lang: 'en', note: 'ash · 沉稳男声' },
  ],
};
export const CLOUD_DEFAULTS: Record<Provider, Record<Lang, string>> = {
  azure: { zh: 'zh-CN-XiaoxiaoNeural', en: 'en-US-AvaNeural' },
  volcengine: { zh: 'BV001_streaming', en: 'BV503_streaming' },
  openai: { zh: 'coral', en: 'coral' },
};
export const ENGINE_LABEL: Record<Provider | 'mac', string> = {
  mac: '这台 Mac 自带的声音（免费，偏机械）',
  azure: '微软 Azure 神经语音（播音级，每月 50 万字免费）',
  volcengine: '火山引擎 豆包语音（中文最自然，按量付费）',
  openai: 'OpenAI 兼容语音（gpt-4o-mini-tts 等）',
};

/**
 * Text as it should be spoken: no emoji or decoration, one mark instead of "！！！", no "~", ellipses as a pause.
 * Over-punctuated lines are the main reason a neural voice suddenly sounds fake-excited.
 */
export function speakable(text: string): string {
  return text
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}★☆✓✔✗✘●○◆◇■□▶►→←↑↓]/gu, '')
    .replace(/[~～]+/g, '')
    .replace(/(……|\.{3,}|…)+/g, m => (/[㐀-鿿]/.test(text) ? '，' : ', '))
    .replace(/([！!])[！!]+/g, '$1').replace(/([？?])[？?]+/g, '$1').replace(/[？?][！!]+|[！!][？?]+/g, '？')
    .replace(/\s+/g, ' ').replace(/[，,]\s*([。.！!？?])/g, '$1').trim().replace(/[，,]$/, '');
}

const xml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
const LOCALE: Record<Lang, string> = { zh: 'zh-CN', en: 'en-US' };

/** One SSML document for a whole line: each language run in its own voice, so a mixed line is one smooth clip. */
export function azureSsml(text: string, base: Lang, voices: Record<Lang, string>, style?: string): string {
  const parts = runs(speakable(text), base);
  const body = (parts.length ? parts : [{ lang: base, text: speakable(text) }]).map(r => {
    const inner = xml(r.text);
    const styled = style && r.lang === 'zh' ? `<mstts:express-as style="${xml(style)}">${inner}</mstts:express-as>` : inner;
    return `<voice name="${xml(voices[r.lang])}">${styled}</voice>`;
  }).join('');
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${LOCALE[base]}">${body}</speak>`;
}

/** Joins WAV clips of the same format with a short natural gap between them. */
export function joinWav(clips: Buffer[], gapMs = 140): Buffer {
  if (clips.length === 1) return clips[0];
  const parse = (b: Buffer) => {
    if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('不是 WAV');
    let fmt: Buffer | null = null, data: Buffer | null = null;
    for (let o = 12; o + 8 <= b.length;) {
      const id = b.toString('ascii', o, o + 4), n = b.readUInt32LE(o + 4);
      if (id === 'fmt ') fmt = b.subarray(o + 8, o + 8 + n);
      if (id === 'data') data = b.subarray(o + 8, Math.min(b.length, o + 8 + n));
      o += 8 + n + (n % 2);
    }
    if (!fmt || !data) throw new Error('WAV 缺少 fmt 或 data');
    return { fmt, data };
  };
  const ps = clips.map(parse);
  if (ps.some(p => !p.fmt.equals(ps[0].fmt))) throw new Error('几段声音的格式不一样，不能拼接');
  const byteRate = ps[0].fmt.readUInt32LE(8), align = ps[0].fmt.readUInt16LE(12);
  const gap = Buffer.alloc(Math.round((byteRate * gapMs) / 1000 / align) * align);
  const data = Buffer.concat(ps.flatMap((p, i) => (i ? [gap, p.data] : [p.data])));
  const head = Buffer.alloc(12 + 8 + ps[0].fmt.length + 8);
  head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(head.length - 8 + data.length, 4); head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii'); head.writeUInt32LE(ps[0].fmt.length, 16); ps[0].fmt.copy(head, 20);
  head.write('data', 20 + ps[0].fmt.length, 'ascii'); head.writeUInt32LE(data.length, 24 + ps[0].fmt.length);
  return Buffer.concat([head, data]);
}

/** A whole line (possibly mixed Chinese and English) as one clip, made run by run and joined. */
export async function lineBySegments(synth: Synth, text: string, base: Lang, voice?: Record<Lang, string>): Promise<Buffer> {
  const parts = runs(text, base);
  if (parts.length <= 1) return synth.make(parts[0]?.text ?? text, parts[0]?.lang ?? base, voice?.[parts[0]?.lang ?? base]);
  return joinWav(await Promise.all(parts.map(r => synth.make(r.text, r.lang, voice?.[r.lang]))));
}

export type CloudSynth = Synth & { provider: Provider; makeLine(text: string, base: Lang, voices?: Record<Lang, string>): Promise<Buffer> };

async function ok(r: Response, what: string) {
  if (r.ok) return r;
  const body = (await r.text().catch(() => '')).slice(0, 200);
  throw new Error(`${what} 返回 ${r.status}${r.status === 401 || r.status === 403 ? '（密钥不对或没开通）' : ''}${body ? `：${body}` : ''}`);
}

export function cloudSynth(cfg: CloudConfig, fetchImpl: typeof fetch = fetch): CloudSynth {
  const voices = { ...CLOUD_DEFAULTS[cfg.provider], ...cfg.voices };
  const list: VoiceInfo[] = [...CLOUD_VOICES[cfg.provider].map(v => ({ name: v.name, locale: v.locale, lang: v.lang, quality: 'neural' as const }))];
  for (const lang of ['zh', 'en'] as Lang[]) if (!list.some(v => v.lang === lang && v.name === voices[lang])) list.unshift({ name: voices[lang], locale: LOCALE[lang].replace('-', '_'), lang, quality: 'neural' });
  const timeout = () => AbortSignal.timeout(30_000);

  async function one(text: string, lang: Lang, voice: string): Promise<Buffer> {
    const say = speakable(text);
    if (cfg.provider === 'azure') return azure(azureSsml(say, lang, { ...voices, [lang]: voice }, cfg.style));
    if (cfg.provider === 'volcengine') {
      const r = await ok(await fetchImpl('https://openspeech.bytedance.com/api/v1/tts', {
        method: 'POST', signal: timeout(),
        headers: { 'content-type': 'application/json', authorization: `Bearer;${cfg.api_key}` },
        body: JSON.stringify({
          app: { appid: cfg.appid ?? '', token: cfg.api_key, cluster: cfg.cluster || 'volcano_tts' },
          user: { uid: 'family' },
          audio: { voice_type: voice, encoding: 'wav', rate: 24000, speed_ratio: 1.0, volume_ratio: 1.0, pitch_ratio: 1.0 },
          request: { reqid: randomUUID(), text: say, text_type: 'plain', operation: 'query' },
        }),
      }), '火山引擎');
      const j = await r.json() as { code?: number; message?: string; data?: string };
      if ((j.code !== 3000 && j.code !== 0) || !j.data) throw new Error(`火山引擎：${j.message ?? `code ${j.code}`}`);
      return Buffer.from(j.data, 'base64');
    }
    const base = (cfg.base_url || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const r = await ok(await fetchImpl(`${base}/audio/speech`, {
      method: 'POST', signal: timeout(),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.api_key}` },
      body: JSON.stringify({
        model: cfg.model || 'gpt-4o-mini-tts', voice, input: say, response_format: 'wav',
        instructions: cfg.style || (lang === 'zh'
          ? '用标准普通话，像少儿科普节目的专业主持人：亲切、清楚、语速适中，不夸张，不广告腔。'
          : 'Speak clear, natural American English like a warm documentary narrator for children. Moderate pace, no exaggeration.'),
      }),
    }), 'OpenAI 语音');
    return Buffer.from(await r.arrayBuffer());
  }
  async function azure(ssml: string): Promise<Buffer> {
    const region = (cfg.region || 'eastasia').trim();
    const r = await ok(await fetchImpl(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST', signal: timeout(),
      headers: { 'Ocp-Apim-Subscription-Key': cfg.api_key, 'content-type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm', 'user-agent': 'ai-discovery-world' },
      body: ssml,
    }), 'Azure 语音');
    return Buffer.from(await r.arrayBuffer());
  }

  const synth: CloudSynth = {
    provider: cfg.provider,
    voices,
    list,
    make: (text, lang, voice = synth.voices[lang]) => one(text, lang, voice),
    async makeLine(text, base, vs = synth.voices) {
      // Azure reads a mixed line in one request (one voice per language inside one SSML); others are joined.
      if (cfg.provider === 'azure') return azure(azureSsml(text, base, vs, cfg.style));
      return lineBySegments(synth, text, base, vs);
    },
  };
  return synth;
}

/** Checks a config the parent typed before it is saved. Returns an error in Chinese, or null. */
export function checkCloudConfig(c: Partial<CloudConfig>): string | null {
  if (!c.provider || !PROVIDERS.includes(c.provider)) return '请选一个语音服务';
  if (!c.api_key) return '请填密钥';
  if (c.provider === 'azure' && c.region && !/^[a-z0-9]+$/.test(c.region)) return 'Azure 区域只写英文小写，例如 eastasia';
  if (c.provider === 'volcengine' && !c.appid) return '火山引擎还要填 AppID';
  if (c.provider === 'openai' && c.base_url && !/^https?:\/\//.test(c.base_url)) return '接口地址要以 https:// 开头';
  for (const v of Object.values(c.voices ?? {})) if (typeof v !== 'string' || !/^[\w.\-()一-鿿 ]{1,80}$/.test(v)) return '声音名称不对';
  return null;
}
