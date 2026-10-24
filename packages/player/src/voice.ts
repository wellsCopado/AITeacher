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

/** Fetches narration audio (a WAV file) made by the family server's voice. */
export type FetchAudio = (text: string, lang: Lang) => Promise<ArrayBuffer>;

/** A short silent WAV, played inside the first tap so iPad lets the same audio element play later. */
function silentWav() {
  const n = 2205, b = new ArrayBuffer(44 + n * 2), d = new DataView(b);
  const str = (o: number, t: string) => [...t].forEach((c, i) => d.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); d.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true);
  d.setUint32(24, 22050, true); d.setUint32(28, 44100, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true); str(36, 'data'); d.setUint32(40, n * 2, true);
  return b;
}

export interface Voice {
  /** Resolves when the line has been read out (or, without sound, after the time it takes to read it). */
  speak(text: string, lang: Lang): Promise<void>;
  stop(): void;
  /** Call inside a tap: iPad Safari only lets a page make sound after one. */
  unlock(): void;
  tap(): void;
  chime(): void;
  tick(): void;
  muted: boolean;
  readonly available: boolean;
  /** 'server' when lines are played from the family server's voice, 'device' when the browser speaks them. */
  readonly source: 'server' | 'device' | 'none';
}

export function createVoice(scale = 1, fetchAudio?: FetchAudio): Voice {
  // Server voice first: it plays through an <audio> element, which iPad treats as media (it plays even with
  // the mute switch on). The browser's own speech engine is the fallback.
  const el = typeof Audio !== 'undefined' ? new Audio() : null;
  el?.setAttribute('playsinline', '');
  let elReady = false, serverOk = !!fetchAudio, gen = 0;
  let endCurrent: (() => void) | null = null;
  const clips = new Map<string, Promise<ArrayBuffer>>();
  const clip = (text: string, lang: Lang) => {
    const k = lang + '|' + text;
    if (!clips.has(k)) { const p = fetchAudio!(text, lang); clips.set(k, p); p.catch(() => clips.delete(k)); }
    return clips.get(k)!;
  };
  const playClip = (buf: ArrayBuffer, my: number) => new Promise<void>((res, rej) => {
    if (!el || my !== gen) return res();
    const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    const end = (e?: unknown) => { el.onended = el.onerror = null; endCurrent = null; URL.revokeObjectURL(url); clearTimeout(t); if (e) rej(e); else res(); };
    const t = setTimeout(() => end(), (buf.byteLength / 44100) * 1000 + 3000);
    endCurrent = () => end();
    el.src = url;
    el.onended = () => end(); el.onerror = () => end(new Error('audio'));
    el.play().catch(e => end(e));
  });
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

  // iPad Safari: sound only starts from a finished tap (touchend / click, not touchstart or pointerdown),
  // and the side mute switch silences web audio unless the page asks for "playback".
  let warmed = false, warmOnly = false;
  const unlock = () => {
    try {
      const nav = navigator as Navigator & { audioSession?: { type: string } };
      if (nav.audioSession) nav.audioSession.type = 'playback';
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AC && !ctx) ctx = new AC();
      if (ctx && ctx.state !== 'running') {
        void ctx.resume();
        const src = ctx.createBufferSource(); src.buffer = ctx.createBuffer(1, 1, 22050); src.connect(ctx.destination); src.start(0);
      }
      if (el && !elReady) {
        el.src = URL.createObjectURL(new Blob([silentWav()], { type: 'audio/wav' }));
        el.play().then(() => { elReady = true; }).catch(() => undefined);
      }
      if (synth && !warmed) { warmed = true; const u = new SpeechSynthesisUtterance('。'); u.volume = 0; u.lang = 'zh-CN'; u.onend = () => { warmOnly = false; }; warmOnly = true; synth.speak(u); }
    } catch { /* no audio on this device */ }
    if (ctx?.state === 'running' && warmed && (elReady || !el)) for (const t of ['touchend', 'click']) window.removeEventListener(t, unlock, true);
  };
  if (typeof window !== 'undefined') for (const t of ['touchend', 'click']) window.addEventListener(t, unlock, true);
  // Safari drops an utterance that is garbage-collected mid-sentence (and never fires its end), so keep them.
  const live: SpeechSynthesisUtterance[] = [];

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
    get available() { return serverOk || !!synth; },
    get source() { return serverOk ? 'server' : synth ? 'device' : 'none'; },
    async speak(text, lang) {
      const est = readingTime(text) * 1000 / scale;
      const parts = runs(text, lang);
      const my = ++gen;
      if (v.muted || !parts.length) return wait(est);
      if (serverOk && el) {
        try {
          if (synth?.speaking) synth.cancel();
          const bufs = parts.map(r => clip(r.text, r.lang));
          for (const b of bufs) { const buf = await b; if (my !== gen) return; await playClip(buf, my); }
          return;
        } catch (e) {
          if (my !== gen) return;
          // No server voice (not a Mac) or the Pad refused to play: use the device voice from now on.
          if (!(e instanceof DOMException && e.name === 'NotAllowedError')) serverOk = false;
        }
      }
      if (!synth) return wait(est);
      // cancel() right before speak() makes Safari drop the new line, so only cancel when something is playing
      if ((synth.speaking || synth.pending) && !warmOnly) synth.cancel();
      warmOnly = false;
      live.length = 0;
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
          live.push(u);
          synth.speak(u);
        });
        // Some devices never fire onend; never let a lesson hang on that.
        setTimeout(finish, est * 1.6 + 1500 / scale);
        cancels.add(finish);
      });
    },
    unlock() { unlock(); },
    stop() { gen++; if (el && !el.paused) el.pause(); endCurrent?.(); synth?.cancel(); cancels.forEach(f => f()); cancels.clear(); },
    tap() { tone([1320], 0.05, 0.05, 'triangle'); },
    chime() { tone([660, 880, 1320], 0.22, 0.08); },
    tick() { tone([880], 0.08, 0.06); },
  };
  return v;
}
