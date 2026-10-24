// Narration language state machine (FR12, BL06).
// Each hotspot keeps its own counter under `child|lesson@ver|hotspot|rev`. In cycle mode the n-th
// play uses n mod 4: 0 → Chinese, 1–3 → English lines 1–3, so the fifth play is Chinese again.
// A play advances the counter when it starts; "listen in Chinese now" never advances it.

export type LangMode = 'zh' | 'cycle';
export interface LanguagePack { zh: string; en: (string | null)[] }
export interface Utterance { lang: 'zh' | 'en'; text: string; advance: boolean; fallback: boolean }

export const pointerKey = (child: string, lesson: string, hotspot: string, rev = 1) => `${child}|${lesson}|${hotspot}|rev${rev}`;

export function utterance(mode: LangMode, pointer: number, pack: LanguagePack, override?: 'zh'): Utterance {
  if (override === 'zh' || mode === 'zh') return { lang: 'zh', text: pack.zh, advance: false, fallback: false };
  const pos = pointer % 4;
  if (pos === 0) return { lang: 'zh', text: pack.zh, advance: true, fallback: false };
  const en = pack.en[pos - 1];
  if (!en || !en.trim()) return { lang: 'zh', text: pack.zh, advance: true, fallback: true };
  return { lang: 'en', text: en, advance: true, fallback: false };
}
