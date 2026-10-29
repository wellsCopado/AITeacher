// A small valid GLB for the asset checks: a box of a given size in metres, with or without PBR textures.
import { deflateSync } from 'node:zlib';

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A w × h PNG of one colour. */
export function png(w: number, h: number, rgb: [number, number, number]) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.concat(Array.from({ length: h }, () => Buffer.from([0, ...Array.from({ length: w }, () => rgb).flat()])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

export function boxGlb(size: [number, number, number], o: { textures?: boolean; texSize?: number } = {}) {
  const [hx, hy, hz] = size.map(s => s / 2);
  const faces: [number[], number[], number[]][] = [ // normal, u axis, v axis
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]], [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  faces.forEach(([n, u, v], f) => {
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      pos.push((n[0] + a * u[0] + b * v[0]) * hx, (n[1] + a * u[1] + b * v[1]) * hy, (n[2] + a * u[2] + b * v[2]) * hz);
      nor.push(...n); uv.push((a + 1) / 2, (1 - b) / 2);
    }
    idx.push(f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3);
  });
  const parts: Buffer[] = [], views: { buffer: 0; byteOffset: number; byteLength: number; target?: number }[] = [];
  let off = 0;
  const add = (b: Buffer, target?: number) => { const pad = (4 - (b.length % 4)) % 4; views.push({ buffer: 0, byteOffset: off, byteLength: b.length, ...(target ? { target } : {}) }); parts.push(b, Buffer.alloc(pad)); off += b.length + pad; return views.length - 1; };
  const f32 = (a: number[]) => Buffer.from(new Float32Array(a).buffer), u16 = (a: number[]) => Buffer.from(new Uint16Array(a).buffer);
  const vP = add(f32(pos), 34962), vN = add(f32(nor), 34962), vT = add(f32(uv), 34962), vI = add(u16(idx), 34963);
  const t = o.texSize ?? 8;
  const imgs = o.textures ? [png(t, t, [120, 110, 95]), png(t, t, [128, 128, 255]), png(t, t, [255, 180, 0])].map(b => add(b)) : [];
  const json = {
    asset: { version: '2.0', generator: 'adw test fixture' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    accessors: [
      { bufferView: vP, componentType: 5126, count: 24, type: 'VEC3', min: [-hx, -hy, -hz], max: [hx, hy, hz] },
      { bufferView: vN, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: vT, componentType: 5126, count: 24, type: 'VEC2' },
      { bufferView: vI, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
    materials: [o.textures
      ? { name: 'steel', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 2 } }, normalTexture: { index: 1 }, occlusionTexture: { index: 2 } }
      : { name: 'flat grey', pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1], roughnessFactor: 0.5 } }],
    ...(o.textures ? { textures: imgs.map((_, i) => ({ source: i })), images: imgs.map(bufferView => ({ bufferView, mimeType: 'image/png' })) } : {}),
    bufferViews: views, buffers: [{ byteLength: off }],
  };
  const js = Buffer.from(JSON.stringify(json)), jpad = Buffer.alloc((4 - (js.length % 4)) % 4, 0x20), bin = Buffer.concat(parts);
  const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + jpad.length + 8 + bin.length, 8);
  const ch = (len: number, type: number) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  return Buffer.concat([head, ch(js.length + jpad.length, 0x4e4f534a), js, jpad, ch(bin.length, 0x004e4942), bin]);
}
