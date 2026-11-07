// Reading a binary glTF (GLB) without a renderer: its structure, materials, size in metres and render cost.
// Used by `dls asset-check` (acceptance.md A1–A4) to tell what a model file really is before anyone looks at it.

export interface GltfJson {
  asset?: { version?: string };
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: { mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[];
  meshes?: { primitives: { attributes: Record<string, number>; indices?: number; material?: number; mode?: number }[] }[];
  accessors?: { count: number; min?: number[]; max?: number[]; type?: string }[];
  materials?: {
    name?: string;
    pbrMetallicRoughness?: { baseColorTexture?: { index: number }; metallicRoughnessTexture?: { index: number } };
    normalTexture?: { index: number }; occlusionTexture?: { index: number };
  }[];
  textures?: { source?: number; extensions?: Record<string, { source?: number }> }[];
  images?: { bufferView?: number; mimeType?: string; uri?: string }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number }[];
  animations?: unknown[];
  extensionsUsed?: string[];
}

export class GlbError extends Error {}

/** Split a GLB into its JSON and binary chunks; throws GlbError when it isn't a valid GLB 2.0 container. */
export function parseGlb(buf: Buffer): { json: GltfJson; bin: Buffer | null } {
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) throw new GlbError('不是 GLB 文件（文件头不是 glTF）');
  if (buf.readUInt32LE(4) !== 2) throw new GlbError(`GLB 版本是 ${buf.readUInt32LE(4)}，要 2`);
  if (buf.readUInt32LE(8) !== buf.length) throw new GlbError('GLB 头里写的长度和文件长度对不上（文件可能不完整）');
  let off = 12, json: GltfJson | null = null, bin: Buffer | null = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (data.length !== len) throw new GlbError('GLB 块的长度超出文件');
    if (type === 0x4e4f534a) {
      try { json = JSON.parse(data.toString('utf8')); } catch { throw new GlbError('GLB 里的 JSON 读不出来'); }
    } else if (type === 0x004e4942) bin = data;
    off += 8 + len;
  }
  if (!json) throw new GlbError('GLB 里没有 JSON 块');
  if (!json.asset?.version?.startsWith('2.')) throw new GlbError('glTF asset.version 不是 2.x');
  return { json, bin };
}

/** Width and height of a PNG or JPEG, or null for other formats (KTX2, WebP…). */
export function imageSize(b: Buffer): { w: number; h: number } | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1], len = b.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}

type Mat = number[];
const I: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mul = (a: Mat, b: Mat): Mat => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
function trs(n: NonNullable<GltfJson['nodes']>[number]): Mat {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = n.scale ?? [1, 1, 1], [tx, ty, tz] = n.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

export interface GlbStats {
  triangles: number; drawCalls: number; materials: number; animations: number;
  textures: { index: number; mime: string | null; w: number | null; h: number | null }[];
  /** Estimated GPU memory of the textures (RGBA with mipmaps), in MB. */
  textureMB: number;
  /** World-space bounding box size in metres (glTF units are metres). */
  size: [number, number, number] | null;
  extensions: string[];
}

/** What drawing this model costs and how big it is, read from its JSON and binary chunk. */
export function glbStats({ json, bin }: { json: GltfJson; bin: Buffer | null }): GlbStats {
  let triangles = 0, drawCalls = 0;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const visit = (i: number, parent: Mat) => {
    const n = json.nodes?.[i]; if (!n) return;
    const m = mul(parent, trs(n));
    for (const p of n.mesh !== undefined ? json.meshes?.[n.mesh]?.primitives ?? [] : []) {
      drawCalls++;
      const count = p.indices !== undefined ? json.accessors?.[p.indices]?.count ?? 0 : json.accessors?.[p.attributes.POSITION]?.count ?? 0;
      if ((p.mode ?? 4) === 4) triangles += Math.floor(count / 3);
      const a = json.accessors?.[p.attributes.POSITION];
      if (a?.min && a.max) for (let c = 0; c < 8; c++) {
        const v = [c & 1 ? a.max[0] : a.min[0], c & 2 ? a.max[1] : a.min[1], c & 4 ? a.max[2] : a.min[2]];
        for (let r = 0; r < 3; r++) { const w = m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r]; lo[r] = Math.min(lo[r], w); hi[r] = Math.max(hi[r], w); }
      }
    }
    for (const c of n.children ?? []) visit(c, m);
  };
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? (json.nodes ?? []).map((_, i) => i);
  for (const r of roots) visit(r, I);
  const textures = (json.textures ?? []).map((t, index) => {
    const src = t.source ?? Object.values(t.extensions ?? {})[0]?.source;
    const img = src !== undefined ? json.images?.[src] : undefined;
    const view = img?.bufferView !== undefined ? json.bufferViews?.[img.bufferView] : undefined;
    const size = view && bin ? imageSize(bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)) : null;
    return { index, mime: img?.mimeType ?? null, w: size?.w ?? null, h: size?.h ?? null };
  });
  const textureMB = textures.reduce((s, t) => s + (t.w && t.h ? t.w * t.h * 4 * 1.34 : 0), 0) / 1024 / 1024;
  return {
    triangles, drawCalls, materials: json.materials?.length ?? 0, animations: json.animations?.length ?? 0, textures,
    textureMB: Math.round(textureMB * 10) / 10,
    size: Number.isFinite(lo[0]) ? [0, 1, 2].map(r => Math.round((hi[r] - lo[r]) * 1000) / 1000) as [number, number, number] : null,
    extensions: json.extensionsUsed ?? [],
  };
}

/** Materials that lack a base colour, normal or ORM (occlusion-roughness-metallic) texture (acceptance.md A2). */
export function bareMaterials(json: GltfJson): { index: number; name: string; missing: string[] }[] {
  return (json.materials ?? []).map((m, index) => ({
    index, name: m.name ?? `材质 ${index}`,
    missing: [
      !m.pbrMetallicRoughness?.baseColorTexture && '底色贴图',
      !m.normalTexture && '法线贴图',
      !m.pbrMetallicRoughness?.metallicRoughnessTexture && '粗糙度/金属度（ORM）贴图',
    ].filter(Boolean) as string[],
  })).filter(m => m.missing.length);
}
