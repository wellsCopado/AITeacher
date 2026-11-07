// Inside the Android tablet app (apps/android) the page runs in a WebView that has no speechSynthesis, and the
// app is already full screen. The app exposes window.AdwNative; this file adapts the page to it.

interface AdwNative {
  version(): string;
  speak(id: string, text: string, lang: string, rate: number): void;
  cancelSpeech(): void;
  /** JSON: [{ name, lang, localService, default }] */
  voices(): string;
  changeServer(): void;
}

export const native: AdwNative | null = (window as unknown as { AdwNative?: AdwNative }).AdwNative ?? null;

type Handler = ((e: { type: string }) => void) | null;
class Utterance {
  lang = ''; rate = 1; pitch = 1; volume = 1; voice: unknown = null;
  onend: Handler = null; onerror: Handler = null; onstart: Handler = null;
  constructor(public text = '') {}
  addEventListener() { /* the player only uses onend / onerror */ }
}

/** Gives the player a speechSynthesis that speaks with the tablet's own voice through the app. */
export function installSpeech() {
  if (!native) return;
  const n = native;
  const live = new Map<string, Utterance>();
  let seq = 0;
  (window as unknown as { __adwSpeech: (id: string, type: string) => void }).__adwSpeech = (id, type) => {
    const u = live.get(id);
    if (!u) return; // cancelled
    live.delete(id);
    (type === 'end' ? u.onend : u.onerror)?.({ type });
  };
  const synth = {
    get speaking() { return live.size > 0; },
    pending: false, paused: false,
    getVoices: () => { try { return JSON.parse(n.voices()); } catch { return []; } },
    speak(u: Utterance) {
      // the player's silent warm-up line
      if (u.volume === 0) { setTimeout(() => u.onend?.({ type: 'end' }), 0); return; }
      const id = `u${++seq}`;
      live.set(id, u);
      n.speak(id, u.text, u.lang || 'zh-CN', u.rate || 1);
    },
    cancel() { live.clear(); n.cancelSpeech(); },
    pause() {}, resume() {},
    addEventListener() {}, removeEventListener() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: Utterance, configurable: true });
}
