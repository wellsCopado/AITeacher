// Pre-reviewed lesson components. The Pad only ever runs code from here; a LessonSpec supplies parameters.
// The photoreal scene engine (engine.js) is the prototype's, kept as-is so its look stays what was signed off.
// @ts-expect-error engine.js is plain JS without types
import { create } from './engine.js';
// @ts-expect-error host.js is plain JS without types
import { createHost } from './host.js';

export interface HotspotBinding { anchor: string; label: string }
export interface MountOptions {
  hotspots: HotspotBinding[];
  /** A hotspot label or its object in the scene was tapped. */
  onHotspot(anchor: string): void;
  /** Something without a hotspot was tapped (e.g. one block: row/col). */
  onPick?(info: Record<string, unknown>): void;
  /** Progress while an action runs, e.g. metres walked or quadrats placed. */
  onProgress?(action: string, value: number): void;
  /**
   * A cut-out top view of the animal that lives in the burrow, placed at true size (BL14: photoreal only). With a
   * hand-made rig (rig, rigMeta) it moves part by part; without one it is jointed into segments automatically.
   */
  organism?: { url: string; rig?: string | null; rigMeta?: string | null; lengthM: number };
}
export interface Instance {
  readonly componentId: string;
  setParams(p: Record<string, unknown>): void;
  run(action: string): Promise<void>;
  focus(anchor: string): void;
  zoom(factor: number): void;
  reset(): void;
  toggleLabels(): void;
  /** The animal in the scene: show, strike, slow (strike in slow motion), anatomy (apart / together), hide. */
  organism(cmd: string): void;
  organismState(): { mode: string; exploded: boolean } | null;
  /** Show the finished setup without animation (a challenge's picture). */
  still(): void;
  /**
   * A hands-on question: the scene starts at `start`; the child changes `controls` by dragging the corner handle
   * (or the player's steppers through setTask). onChange gets the lesson params after every change.
   */
  startTask(task: { start: Record<string, number>; controls: string[] }, onChange: (state: Record<string, number>) => void): void;
  setTask(values: Record<string, number>): void;
  taskState(): Record<string, number>;
  /** The worked example of a hands-on question: the scene steps to `target` one unit at a time, then the handle goes. */
  demoTask(target: Record<string, number>): Promise<void>;
  endTask(): void;
  dispose(): void;
}

/** The robot host of the end-of-lesson chat: talks while a line is read, nods at an answer, waves goodbye. */
export interface Host { talk(on: boolean): void; nod(): void; wave(): void; dispose(): void }
export function mountHost(el: HTMLElement, opts: { reduced?: () => boolean } = {}): Host { return createHost(el, opts); }

interface Def {
  version: string;
  engineKind: 'PerimeterArea' | 'ArrayMultiplier';
  hotspotAnchors: string[];
  actions: string[];
  toEngine(p: Record<string, unknown>): Record<string, unknown>;
  /** Params a child can set by hand (content/components.json handsOn.build): engine name and range. */
  build: Record<string, { engine: string; min: number; max: number }>;
}

/** Must match content/components.json (checked by test/components.test.ts). */
export const COMPONENTS: Record<string, Def> = {
  PerimeterArea: {
    version: '1.2', engineKind: 'PerimeterArea',
    hotspotAnchors: ['fence', 'tile', 'unit', 'shrimp'], actions: ['walk', 'fill', 'focus'],
    toEngine: p => ({ a: p.a, b: p.b, theme: p.theme }),
    build: { a: { engine: 'a', min: 1, max: 10 }, b: { engine: 'b', min: 1, max: 10 } },
  },
  ArrayMultiplier: {
    version: '1.0', engineKind: 'ArrayMultiplier',
    hotspotAnchors: ['row', 'col', 'total'], actions: ['reveal', 'rotate'],
    toEngine: p => ({ r: p.rows, c: p.cols, theme: p.theme }),
    build: { rows: { engine: 'r', min: 1, max: 9 }, cols: { engine: 'c', min: 1, max: 9 } },
  },
};

export function mount(el: HTMLElement, componentId: string, params: Record<string, unknown>, opts: MountOptions): Instance {
  const [name, ver] = componentId.split('@');
  const def = COMPONENTS[name];
  if (!def || def.version !== ver) throw new Error(`组件 ${componentId} 不在已审列表`);

  const pending = new Map<string, () => void>();
  const done = (action: string) => () => { pending.get(action)?.(); pending.delete(action); };
  let rotated = false;
  const anchors = new Set(def.hotspotAnchors);
  let cur: Record<string, unknown> = { ...params };
  let task: { controls: string[]; onChange(state: Record<string, number>): void } | null = null;
  const state = () => Object.fromEntries(Object.keys(def.build).map(k => [k, Number(cur[k])]));
  const clampTo = (k: string, v: number) => Math.max(def.build[k].min, Math.min(def.build[k].max, Math.round(v)));

  const engine = create(el, def.engineKind, def.toEngine(params),
    (ud: Record<string, unknown>) => {
      const kind = String(ud.kind ?? '');
      if (anchors.has(kind) && opts.hotspots.some(h => h.anchor === kind)) opts.onHotspot(kind);
      else opts.onPick?.(ud);
    },
    {
      hotspots: opts.hotspots.map(h => ({ id: h.anchor, label: h.label })),
      onHotspot: (h: { id: string }) => opts.onHotspot(h.id),
      onWalk: (d: number) => opts.onProgress?.('walk', d), onWalkDone: done('walk'),
      onFill: (n: number) => opts.onProgress?.('fill', n), onFillDone: done('fill'),
      onReveal: (n: number) => opts.onProgress?.('reveal', n), onRevealDone: done('reveal'),
      organism: opts.organism,
    });

  return {
    componentId,
    setParams: p => { cur = { ...p }; engine.setParams(def.toEngine(p)); },
    run(action) {
      if (!def.actions.includes(action)) return Promise.reject(new Error(`${name} 没有动作 ${action}`));
      if (action === 'rotate') { rotated = !rotated; engine.setRot(rotated); return Promise.resolve(); }
      if (action === 'focus') { engine.focusShrimp(); return Promise.resolve(); }
      return new Promise<void>(res => { pending.set(action, res); engine[action](); });
    },
    focus(anchor) { if (anchor === 'shrimp') engine.focusShrimp(); },
    zoom: f => engine.zoom(f),
    reset: () => engine.reset(),
    toggleLabels: () => engine.toggleLabels(),
    organism: cmd => engine.organism?.(cmd),
    organismState: () => engine.organismState?.() ?? null,
    still: () => engine.still(),
    startTask(t, onChange) {
      task = { controls: t.controls.filter(k => k in def.build), onChange };
      cur = { ...cur, ...t.start };
      engine.setParams(def.toEngine(cur));
      const ctrl = task.controls.map(k => def.build[k].engine), lim = Object.fromEntries(task.controls.map(k => [def.build[k].engine, [def.build[k].min, def.build[k].max]]));
      engine.taskOn(ctrl, lim, (p: Record<string, number>) => {
        for (const [k, b] of Object.entries(def.build)) cur[k] = p[b.engine];
        task?.onChange(state());
      });
    },
    setTask(values) {
      if (!task) return;
      const p: Record<string, number> = {};
      for (const [k, v] of Object.entries(values)) if (task.controls.includes(k)) { cur[k] = clampTo(k, v); p[def.build[k].engine] = Number(cur[k]); }
      engine.taskSet(p); task.onChange(state());
    },
    taskState: () => state(),
    async demoTask(target) {
      const t = task; if (!t) return;
      const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      for (;;) {
        const k = t.controls.find(c => target[c] !== undefined && Number(cur[c]) !== clampTo(c, target[c]));
        if (!k) break;
        const v = Number(cur[k]) + Math.sign(clampTo(k, target[k]) - Number(cur[k]));
        cur[k] = v; engine.taskSet({ [def.build[k].engine]: v }); t.onChange(state());
        if (!reduced) await new Promise(r => setTimeout(r, 380));
      }
      task = null; engine.taskOff();
    },
    endTask: () => { task = null; engine.taskOff(); },
    dispose: () => { pending.clear(); task = null; engine.dispose(); },
  };
}
