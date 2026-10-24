// Narration audio made on the server Mac with its own voices (`say`). The Pad plays it as ordinary audio,
// which works on iPad even where the browser's speech engine stays silent. Files are cached by text.
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type Lang = 'zh' | 'en';
/** Returns a WAV file for the text. */
export type Synth = { voices: Record<Lang, string>; make(text: string, lang: Lang): Promise<Buffer> };

/** Pick a voice from `say -v ?` lines like "Tingting            zh_CN    # 你好！". */
export function pickVoices(list: string): Record<Lang, string> | null {
  const rows = list.split('\n').map(l => /^(.+?)\s{2,}([a-z]{2}[_-][A-Z]{2,})\s+#/.exec(l)).filter(Boolean).map(m => ({ name: m![1].trim(), loc: m![2].replace('-', '_') }));
  const best = (loc: RegExp, prefer: string[]) => {
    const mine = rows.filter(r => loc.test(r.loc));
    for (const p of prefer) { const r = mine.find(x => x.name.toLowerCase().startsWith(p.toLowerCase())); if (r) return r.name; }
    return mine[0]?.name;
  };
  const zh = best(/^zh_CN$/, ['Tingting', 'Ting-Ting', 'Lili', 'Yue']), en = best(/^en_US$/, ['Samantha', 'Ava', 'Allison', 'Alex']) ?? best(/^en_/, []);
  return zh && en ? { zh, en } : null;
}

/** The Mac's `say`, or null on other systems or a Mac without a Chinese voice. */
export function macSay(): Synth | null {
  if (process.platform !== 'darwin') return null;
  let voices: Record<Lang, string> | null = null;
  try { voices = pickVoices(execFileSync('say', ['-v', '?'], { encoding: 'utf8' })); } catch { return null; }
  if (!voices) return null;
  const v = voices;
  let running = 0; const waiting: (() => void)[] = [];
  const slot = () => new Promise<void>(res => { if (running < 2) { running++; res(); } else waiting.push(() => { running++; res(); }); });
  const free = () => { running--; waiting.shift()?.(); };
  return {
    voices: v,
    async make(text, lang) {
      await slot();
      const dir = mkdtempSync(join(tmpdir(), 'adw-say-'));
      try {
        writeFileSync(join(dir, 'in.txt'), text);
        await new Promise<void>((res, rej) => execFile('say', ['-v', v[lang], '-r', lang === 'en' ? '155' : '185', '-f', join(dir, 'in.txt'), '-o', join(dir, 'out.wav'), '--file-format=WAVE', '--data-format=LEI16@22050'],
          { timeout: 30_000 }, e => (e ? rej(e) : res())));
        return readFileSync(join(dir, 'out.wav'));
      } finally { rmSync(dir, { recursive: true, force: true }); free(); }
    },
  };
}
