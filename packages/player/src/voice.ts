// Sound for the Pad: spoken narration (the device's own offline voices) and short tap / chime cues.
// iPad Safari only plays sound after a touch, so the first tap anywhere unlocks both.
// Mixed lines such as "perimeter — 周长。" are split into runs so each run gets a voice of its language.

export type Lang = 'zh' | 'en';

const CJK = /[㐀-鿿豈-﫿，。！？、；：“”（）《》]/;

/** Split a line into runs of Chinese and non-Chinese text. Punctuation stays with the run it follows. */
export function runs(text: string, base: Lang): { lang: Lang; text: string }[] {
  const out: { lang: Lang; text: string }[] = [];
  for (const ch of text) {
    const lang: Lang | null = CJK.test(ch) ? 'zh' : /[A-Za-z]/.test(ch) ? 'en' : null;
    const last = out[out.length - 1];
    if (last && (lang === null || lang === last.lang)) last.text += ch;
    else out.push({ lang: lang ?? base, text: ch });
  }
  return out.map(r => ({ ...r, text: r.text.replace(/[—–-]+\s*$/, '').trim() })).filter(r => /[\p{L}\p{N}]/u.test(r.text));
}

/** Rough time a child needs to hear or read a line, used when the device has no voice or sound is off. */
export const readingTime = (text: string) => {
  const zh = (text.match(/[\u3400-\u9fff]/g) ?? []).length, en = (text.match(/[A-Za-z]+/g) ?? []).length;
  return Math.max(1.5, zh * 0.28 + en * 0.42);
};

export interface Voice {
  /** Resolves when the line has been read out (or, without sound, after the time it takes to read it). */
  speak(text: string, lang: Lang): Promise<void>;
  stop(): void;
  tap(): void;
  chime(): void;
  tick(): void;
  muted: boolean;
  readonly available: boolean;
}

export function createVoice(scale = 1): Voice {
  const cancels = new Set<() => void>();
  const wait = (ms: number) => new Promise<void>(res => { const t = setTimeout(res, ms); cancels.add(() => { clearTimeout(t); res(); }); });
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  let ctx: AudioContext | null = null;
  let voices: SpeechSynthesisVoice[] = [];
  const loadVoices = () => { voices = synth?.getVoices() ?? []; };
  loadVoices(); synth?.addEventListener?.('voiceschanged', loadVoices);
  const pick = (lang: Lang) => {
    const want = lang === 'zh' ? /^zh[-_](CN|Hans)/i : /^en[-_](US|GB)/i;
    const all = voices.filter(v => want.test(v.lang));
    return all.find(v => /Tingting|Ting-Ting|Samantha|Karen|Daniel|Xiaoxiao|Yaoyao/i.test(v.name)) ?? all.find(v => v.localService) ?? all[0];
  };

  const unlock = () => {
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AC && !ctx) ctx = new AC();
      void ctx?.resume();
      if (synth && !synth.speaking) synth.speak(new SpeechSynthesisUtterance(' '));
    } catch { /* no audio on this device */ }
  };
  if (typeof window !== 'undefined') window.addEventListener('pointerdown', unlock, { once: true, capture: true });

  const tone = (freqs: number[], dur: number, gain: number, type: OscillatorType = 'sine') => {
    if (v.muted || !ctx) return;
    const t0 = ctx.currentTime;
    freqs.forEach((f, i) => {
      const o = ctx!.createOscillator(), g = ctx!.createGain();
      o.type = type; o.frequency.value = f;
      const s = t0 + i * dur * 0.6;
      g.gain.setValueAtTime(0.0001, s); g.gain.exponentialRampToValueAtTime(gain, s + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, s + dur);
      o.connect(g).connect(ctx!.destination); o.start(s); o.stop(s + dur + 0.02);
    });
  };

  const v: Voice = {
    muted: false,
    get available() { return !!synth; },
    speak(text, lang) {
      const est = readingTime(text) * 1000 / scale;
      const parts = runs(text, lang);
      if (!synth || v.muted || !parts.length) return wait(est);
      synth.cancel();
      return new Promise<void>(res => {
        let done = false;
        const finish = () => { if (!done) { done = true; res(); } };
        parts.forEach((r, i) => {
          const u = new SpeechSynthesisUtterance(r.text);
          u.lang = r.lang === 'zh' ? 'zh-CN' : 'en-US';
          const voice = pick(r.lang); if (voice) u.voice = voice;
          u.rate = r.lang === 'en' ? 0.88 : 0.95; u.pitch = 1.05;
          // A voice that fails (e.g. sound not unlocked yet) still gives the child time to read the subtitle.
          if (i === parts.length - 1) { u.onend = finish; u.onerror = () => { void wait(est).then(finish); }; }
          synth.speak(u);
        });
        // Some devices never fire onend; never let a lesson hang on that.
        setTimeout(finish, est * 1.6 + 1500 / scale);
        cancels.add(finish);
      });
    },
    stop() { synth?.cancel(); cancels.forEach(f => f()); cancels.clear(); },
    tap() { tone([1320], 0.05, 0.05, 'triangle'); },
    chime() { tone([660, 880, 1320], 0.22, 0.08); },
    tick() { tone([880], 0.08, 0.06); },
  };
  return v;
}
