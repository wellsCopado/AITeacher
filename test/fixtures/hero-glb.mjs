// A hero model that passes the floor in skills/discovery-lesson-maker/assets/hero-floor.json: real geometry (a finely
// divided box of the real size, so a browser can load it), 1024 px colour and normal textures, nodes named for the
// subject card's features. It is a test fixture, not a model of anything; the card that goes with it is subjectCard().
import { deflateSync } from 'node:zlib';

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
function png(w, h, rgb) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.from([0, ...Array.from({ length: w }, () => rgb).flat()]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

/** size: metres [x, y, z]; names: the feature nodes (each one a part of the model); n: divisions per box face edge. */
export function heroGlb({ size = [1, 1, 1], names = ['part_a', 'part_b', 'part_c', 'part_d'], n = 24, tex = 1024, seed = 0 } = {}) {
  const parts = [], views = [];
  let off = 0;
  const add = (b, target) => { const pad = (4 - (b.length % 4)) % 4; views.push({ buffer: 0, byteOffset: off, byteLength: b.length, ...(target ? { target } : {}) }); parts.push(b, Buffer.alloc(pad)); off += b.length + pad; return views.length - 1; };
  const accessors = [], meshes = [], nodes = [];
  names.forEach((name, k) => {
    // each part is a slice of the whole along y, so together they span the real size
    const y0 = -size[1] / 2 + (k * size[1]) / names.length, y1 = y0 + size[1] / names.length;
    const pos = [], nor = [], uv = [], idx = [];
    const faces = [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]];
    for (const [axis, sign] of faces) {
      const base = pos.length / 3;
      for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
        const a = i / n - 0.5, b = j / n - 0.5, p = [0, 0, 0];
        p[axis] = sign * 0.5; p[(axis + 1) % 3] = a; p[(axis + 2) % 3] = b;
        pos.push(p[0] * size[0], y0 + (p[1] + 0.5) * (y1 - y0), p[2] * size[2]);
        const nn = [0, 0, 0]; nn[axis] = sign; nor.push(...nn); uv.push(i / n, j / n);
      }
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const q = base + i * (n + 1) + j;
        idx.push(q, q + n + 1, q + 1, q + 1, q + n + 1, q + n + 2);
      }
    }
    const lo = [0, 1, 2].map(r => Math.min(...pos.filter((_, i) => i % 3 === r))), hi = [0, 1, 2].map(r => Math.max(...pos.filter((_, i) => i % 3 === r)));
    const f32 = a => Buffer.from(new Float32Array(a).buffer), u32 = a => Buffer.from(new Uint32Array(a).buffer);
    const a0 = accessors.length;
    accessors.push({ bufferView: add(f32(pos), 34962), componentType: 5126, count: pos.length / 3, type: 'VEC3', min: lo, max: hi },
      { bufferView: add(f32(nor), 34962), componentType: 5126, count: nor.length / 3, type: 'VEC3' },
      { bufferView: add(f32(uv), 34962), componentType: 5126, count: uv.length / 2, type: 'VEC2' },
      { bufferView: add(u32(idx), 34963), componentType: 5125, count: idx.length, type: 'SCALAR' });
    meshes.push({ name, primitives: [{ attributes: { POSITION: a0, NORMAL: a0 + 1, TEXCOORD_0: a0 + 2 }, indices: a0 + 3, material: 0 }] });
    nodes.push({ name, mesh: k });
  });
  const img = [png(tex, tex, [seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255]), png(tex, tex, [128, 128, 255])].map(b => add(b));
  const json = {
    asset: { version: '2.0', generator: 'adw test fixture' }, scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }], nodes, meshes, accessors,
    materials: [{ name: 'surface', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, roughnessFactor: 0.8 }, normalTexture: { index: 1 } }],
    textures: [{ source: 0 }, { source: 1 }], images: img.map(v => ({ bufferView: v, mimeType: 'image/png' })),
    bufferViews: views, buffers: [{ byteLength: off }],
  };
  let js = Buffer.from(JSON.stringify(json)); js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(parts);
  const c = (t, d) => { const h = Buffer.alloc(8); h.writeUInt32LE(d.length, 0); h.writeUInt32LE(t, 4); return Buffer.concat([h, d]); };
  const body = Buffer.concat([c(0x4e4f534a, js), c(0x004e4942, bin)]);
  const head = Buffer.alloc(12); head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([head, body]);
}

/** The subject card for heroGlb({ size, names }): the longest size is the main dimension. */
export function subjectCard({ topic, instance, kind = 'other', size = [1, 1, 1], names = ['part_a', 'part_b', 'part_c', 'part_d'] }) {
  return {
    topic, instance, kind, why_this_one: '测试夹具',
    references: ['整体', '侧面', '近景'].map((angle, i) => ({ file: `research/refs/ref-${i + 1}.jpg`, angle, source: `https://example.org/ref-${i + 1}`, license: 'CC BY 4.0' })),
    dimensions: [{ what: '最长', meters: Math.max(...size), source: 'https://example.org/size', main: true }, { what: '另一边', meters: Math.min(...size), source: 'https://example.org/size' }],
    features: names.map(n => ({ name: n, node: n })),
    route: { hero: kind === 'animal' ? 'scan' : 'modeled-from-reference', why: '测试夹具' },
  };
}
