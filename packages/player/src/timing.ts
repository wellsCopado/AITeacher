// Step time budgets. Every step has a countdown; when it runs out the lesson moves on by itself
// (the last step ends the lesson), so a child can't stay on one part for the whole session.
import type { LessonSpec } from '../../schema/src/index.js';

export const STEP_KEYS = ['explain', 'demo', 'challenge', 'chat'] as const;
export type StepKey = typeof STEP_KEYS[number];
export type StepBudget = Record<StepKey, number>;

/** Share of the lesson's upper time estimate that each step gets when the spec doesn't set it. */
const SHARE: StepBudget = { explain: 0.08, demo: 0.36, challenge: 0.42, chat: 0.14 };

export function budget(sp: LessonSpec): StepBudget {
  const total = (sp.learner_profile.est_minutes?.[1] ?? 12) * 60;
  const out = {} as StepBudget;
  for (const k of STEP_KEYS) out[k] = sp.timing?.steps?.[k] ?? Math.max(30, Math.round(total * SHARE[k] / 15) * 15);
  return out;
}

export const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.max(0, Math.floor(s % 60))).padStart(2, '0')}`;

/** Countdown that pauses while the Pad is locked or the app is in the background. */
export class Countdown {
  private left: number;
  private last = 0;
  private id: ReturnType<typeof setInterval> | null = null;
  private warned = new Set<number>();
  constructor(seconds: number, private scale: number, private on: { tick(left: number): void; warn?(left: number): void; end(): void }, private warnAt = [60, 15]) {
    this.left = seconds;
  }
  get remaining() { return this.left; }
  start() {
    this.last = performance.now();
    this.on.tick(this.left);
    this.id = setInterval(() => {
      const now = performance.now();
      if (typeof document !== 'undefined' && document.hidden) { this.last = now; return; }
      this.left -= (now - this.last) / 1000 * this.scale; this.last = now;
      for (const w of this.warnAt) if (this.left <= w && !this.warned.has(w)) { this.warned.add(w); this.on.warn?.(w); }
      if (this.left <= 0) { this.stop(); this.on.tick(0); this.on.end(); } else this.on.tick(this.left);
    }, 250);
    return this;
  }
  stop() { if (this.id) clearInterval(this.id); this.id = null; }
  private held = false;
  /** The child pressed pause: the time stops where it is. */
  pause() { if (this.id) { this.stop(); this.held = true; } }
  resume() { if (this.held) { this.held = false; this.start(); } }
}
