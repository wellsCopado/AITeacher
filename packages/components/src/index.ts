// Pre-reviewed lesson components. The Pad only ever runs code from here; a LessonSpec supplies parameters.
// The photoreal scene engine (engine.js) is the prototype's, kept as-is so its look stays what was signed off.
// @ts-expect-error engine.js is plain JS without types
import { create } from './engine.js';

export interface HotspotBinding { anchor: string; label: string }
export interface MountOptions {
  hotspots: HotspotBinding[];
  /** A hotspot label or its object in the scene was tapped. */
  onHotspot(anchor: string): void;
  /** Something without a hotspot was tapped (e.g. one block: row/col). */
  onPick?(info: Record<string, unknown>): void;
  /** Progress while an action runs, e.g. metres walked or quadrats placed. */
  onProgress?(action: string, value: number): void;
  /** A cut-out top view of the animal that lives in the burrow, placed at true size (BL14: photoreal only). */
  organism?: { url: string; rig: string; rigMeta: string; lengthM: number };
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
  dispose(): void;
}

interface Def {
  version: string;
  engineKind: 'PerimeterArea' | 'ArrayMultiplier';
  hotspotAnchors: string[];
  actions: string[];
  toEngine(p: Record<string, unknown>): Record<string, unknown>;
}

/** Must match content/components.json (checked by test/components.test.ts). */
export const COMPONENTS: Record<string, Def> = {
  PerimeterArea: {
    version: '1.2', engineKind: 'PerimeterArea',
    hotspotAnchors: ['fence', 'tile', 'unit', 'shrimp'], actions: ['walk', 'fill', 'focus'],
    toEngine: p => ({ a: p.a, b: p.b, theme: p.theme }),
  },
  ArrayMultiplier: {
    version: '1.0', engineKind: 'ArrayMultiplier',
    hotspotAnchors: ['row', 'col', 'total'], actions: ['reveal', 'rotate'],
    toEngine: p => ({ r: p.rows, c: p.cols }),
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
    setParams: p => engine.setParams(def.toEngine(p)),
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
    dispose: () => { pending.clear(); engine.dispose(); },
  };
}
