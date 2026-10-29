// Narration audio made on the server Mac with its own voices (`say`). The Pad plays it as ordinary audio,
// which works on iPad even where the browser's speech engine stays silent. Files are cached by voice and text.
// The most human-sounding Mac voices are the downloadable "Premium" / "Enhanced" ones and the Siri voices
// (reachable only as the Mac's system voice), so those are ranked first; the parent can switch and preview.
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type Lang = 'zh' | 'en';
export type Quality = 'premium' | 'enhanced' | 'standard' | 'system';
export interface VoiceInfo { name: string; locale: string; lang: Lang; quality: Quality }
/** The Mac's own system voice (Spoken Content). It can be a Siri voice, which `say -v` can't name. */
export const SYSTEM_VOICE = 'system';
/** Returns a WAV file for the text, read by the named voice (or the language's current voice). */
export type Synth = { voices: Record<Lang, string>; list?: VoiceInfo[]; make(text: string, lang: Lang, voice?: string): Promise<Buffer> };

// Joke and robot voices that ship with macOS: never for a child's lesson.
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Fred|Junior|Ralph|Kathy|Princess|Deranged|Hysterical|Pipe Organ|Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley)\b/i;
const PREFER: Record<Lang, string[]> = {
  zh: ['Lilian', 'Tingting', 'Ting-Ting', 'Yue', 'Lili', 'Shasha', 'Lanlan', 'Binbin', 'Lisheng', 'Panpan'],
  en: ['Ava', 'Zoe', 'Samantha', 'Evan', 'Nathan', 'Joelle', 'Allison', 'Susan', 'Tom', 'Alex'],
};
const QUALITY: Record<Quality, number> = { system: 0, premium: 3, enhanced: 2, standard: 1 };

/** Voices from `say -v ?` lines like "Tingting (Enhanced)  zh_CN    # 你好！", Mandarin and English only. */
export function listVoices(list: string): VoiceInfo[] {
  // Long names ("Tingting (Enhanced)") are followed by a single space, short ones are padded.
  return list.split('\n').map(l => /^(.+?)\s+([a-z]{2,3}[_-][A-Z0-9]{2,3})\s+#/.exec(l)).filter(Boolean).flatMap(m => {
    const name = m![1].trim(), locale = m![2].replace('-', '_');
    const lang: Lang | null = locale === 'zh_CN' ? 'zh' : locale.startsWith('en_') ? 'en' : null;
    if (!lang || NOVELTY.test(name)) return [];
    const quality: Quality = /\(Premium\)|高级/i.test(name) ? 'premium' : /\(Enhanced\)|增强/i.test(name) ? 'enhanced' : 'standard';
    return [{ name, locale, lang, quality }];
  });
}

/** Best first: higher quality, then the voices that sound most natural to children, US English before others. */
export function rankVoices(vs: VoiceInfo[]): VoiceInfo[] {
  const pref = (v: VoiceInfo) => { const i = PREFER[v.lang].findIndex(p => v.name.toLowerCase().startsWith(p.toLowerCase())); return i < 0 ? 99 : i; };
  return [...vs].sort((a, b) => QUALITY[b.quality] - QUALITY[a.quality] || pref(a) - pref(b) || Number(b.locale === 'en_US') - Number(a.locale === 'en_US') || a.name.localeCompare(b.name));
}

/** The most natural Mandarin and English voices on this Mac, or null when one language has none. */
export function pickVoices(list: string): Record<Lang, string> | null {
  const r = rankVoices(listVoices(list));
  const zh = r.find(v => v.lang === 'zh')?.name, en = r.find(v => v.lang === 'en')?.name;
  return zh && en ? { zh, en } : null;
}

/** The Mac's `say`, or null on other systems or a Mac without a Chinese voice. */
export function macSay(): Synth | null {
  if (process.platform !== 'darwin') return null;
  let out = '';
  try { out = execFileSync('say', ['-v', '?'], { encoding: 'utf8' }); } catch { return null; }
  const voices = pickVoices(out);
  if (!voices) return null;
  let running = 0; const waiting: (() => void)[] = [];
  const slot = () => new Promise<void>(res => { if (running < 2) { running++; res(); } else waiting.push(() => { running++; res(); }); });
  const free = () => { running--; waiting.shift()?.(); };
  const synth: Synth = {
    voices,
    list: rankVoices(listVoices(out)),
    async make(text, lang, voice = synth.voices[lang]) {
      await slot();
      const dir = mkdtempSync(join(tmpdir(), 'adw-say-'));
      try {
        writeFileSync(join(dir, 'in.txt'), text);
        // The voice's own speaking rate: forcing a rate is what makes these voices sound mechanical.
        const args = [...(voice === SYSTEM_VOICE ? [] : ['-v', voice]), '-f', join(dir, 'in.txt'), '-o', join(dir, 'out.wav'), '--file-format=WAVE', '--data-format=LEI16@24000'];
        await new Promise<void>((res, rej) => execFile('say', args, { timeout: 30_000 }, e => (e ? rej(e) : res())));
        return readFileSync(join(dir, 'out.wav'));
      } finally { rmSync(dir, { recursive: true, force: true }); free(); }
    },
  };
  return synth;
}
