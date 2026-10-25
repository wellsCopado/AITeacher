import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetCheck, assetSheet, geometryLint } from '../packages/cli/src/assets.js';
import { glbStats, imageSize, parseGlb } from '../packages/cli/src/glb.js';
import { boxGlb, png } from './fixtures/glb.js';

const root = join(import.meta.dirname, '..');

/** A repo with only what the asset checks read: the registry, one asset folder, and scene code that passes A5. */
function sandbox(id: string, glb: Buffer | null, manifest: Record<string, unknown>) {
  const r = mkdtempSync(join(tmpdir(), 'adw-asset-'));
  mkdirSync(join(r, 'content', 'assets', id), { recursive: true });
  mkdirSync(join(r, 'packages', 'components', 'src'), { recursive: true });
  writeFileSync(join(r, 'content', 'assets', 'registry.json'), '[]');
  writeFileSync(join(r, 'packages', 'components', 'src', 'scene.js'), 'const ground = new THREE.PlaneGeometry(10, 10);\n');
  writeFileSync(join(r, 'packages', 'components', 'src', 'simple-geometry.allow.json'), JSON.stringify({ 'scene.js': [{ geometry: 'PlaneGeometry', what: '地面', class: '简单几何件' }] }));
  if (glb) writeFileSync(join(r, 'content', 'assets', id, 'model.glb'), glb);
  writeFileSync(join(r, 'content', 'assets', id, 'manifest.json'), JSON.stringify(manifest));
  return r;
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const facts = { source_url: 'https://example.com/arm', author: '厂家', license: 'CC BY 4.0', downloaded_at: '2026-10-25', subject_facts: [{ fact: '6 个关节', source: '厂家数据表' }] };

describe('A5: no complex object drawn from code', () => {
  it('every geometry in the scene code is on the allowlist, and what still waits for replacement is named', () => {
    const l = geometryLint(root);
    expect(l.unlisted).toEqual([]);
    expect(l.stale).toEqual([]);
    // the robot cell, the host, the 2.5D animals, the measuring tools and the rocks: each tracked in gaps.md
    expect([...new Set(l.pending.map(p => p.gap))].sort()).toEqual(['G1', 'G19', 'G2', 'G3', 'G4']);
    const gaps = readFileSync(join(root, 'skills/photoreal-3d-production/reference/gaps.md'), 'utf8');
    for (const g of new Set(l.pending.map(p => p.gap))) expect(gaps).toContain(`| ${g} |`);
  });
  it('catches geometry nobody wrote down, and entries for geometry no longer used', () => {
    const r = sandbox('X', null, {});
    writeFileSync(join(r, 'packages/components/src/robot.js'), 'const arm = new THREE.CapsuleGeometry(0.1, 0.5);\nconst j = new THREE.TorusGeometry(1, 0.1);\n');
    writeFileSync(join(r, 'packages/components/src/simple-geometry.allow.json'), JSON.stringify({
      'scene.js': [{ geometry: 'PlaneGeometry', what: '地面', class: '简单几何件' }, { geometry: 'BoxGeometry', what: '箱子', class: '简单几何件' }],
      'robot.js': [{ geometry: 'TorusGeometry', what: '关节', class: '待替换', gap: 'G1' }],
    }));
    const l = geometryLint(r);
    expect(l.unlisted).toEqual([{ file: 'robot.js', geometry: 'CapsuleGeometry', lines: [1] }]);
    expect(l.stale).toEqual([{ file: 'scene.js', geometry: 'BoxGeometry' }]);
    expect(l.pending.map(p => p.gap)).toEqual(['G1']);
  });
});

describe('asset checks A1–A7', () => {
  it('reads a GLB: size in metres, triangles, draw calls, texture sizes', () => {
    const s = glbStats(parseGlb(boxGlb([0.4, 0.9, 0.3], { textures: true, texSize: 16 })));
    expect(s).toMatchObject({ triangles: 12, drawCalls: 1, materials: 1, size: [0.4, 0.9, 0.3] });
    expect(s.textures.map(t => [t.w, t.h])).toEqual([[16, 16], [16, 16], [16, 16]]);
    expect(imageSize(png(5, 3, [0, 0, 0]))).toEqual({ w: 5, h: 3 });
  });

  it('passes a textured model at its true size with everything registered', async () => {
    const glb = boxGlb([0.4, 0.9, 0.3], { textures: true });
    const r = sandbox('M-arm', glb, { ...facts, sha256: sha(glb), real_scale_m: { height: 0.9 } });
    const out = await assetCheck(r, 'M-arm');
    const by = Object.fromEntries(out.results.map(c => [c.id, c]));
    expect(out.ok, JSON.stringify(out.results)).toBe(true);
    expect(by.A1.detail).toContain('Khronos glTF Validator 0 个错误');
    expect(by.A3.detail).toContain('相差 0%');
    expect(by.A7.ok).toBeNull(); // no animation in the file
  });

  it('fails a flat-coloured model at the wrong size, a swapped file, and a generated one without photos', async () => {
    const glb = boxGlb([2, 0.5, 0.5]);
    const r = sandbox('M-bad', glb, { ...facts, sha256: sha(boxGlb([1, 1, 1])), generator: '图生 3D v1', reference_photos: [{ file: 'refs/1.jpg' }], real_scale_m: { reach: 0.85 }, budget: { triangles: 10 } });
    const out = await assetCheck(r, 'M-bad');
    const by = Object.fromEntries(out.results.map(c => [c.id, c]));
    expect(out.ok).toBe(false);
    expect(by.A2.detail).toMatch(/flat grey 缺底色贴图、法线贴图/);
    expect(by.A3.ok).toBe(false);
    expect(by.A4.detail).toContain('三角形 12 > 10');
    expect(by.A6.detail).toMatch(/参考照片（AI 生成的要 ≥ 3 张，现在 1 张）[\s\S]*sha256 和登记的不一样/);
    // not a GLB at all
    writeFileSync(join(r, 'content/assets/M-bad/model.glb'), 'not a model');
    expect((await assetCheck(r, 'M-bad')).results[0]).toMatchObject({ id: 'A1', ok: false });
  });
});

describe('B: comparison sheet', () => {
  it('renders the four views next to the real photos taken from those angles', async () => {
    const glb = boxGlb([0.4, 0.9, 0.3], { textures: true });
    const r = sandbox('M-arm', glb, { ...facts, real_scale_m: { height: 0.9 }, reference_photos: [{ file: 'refs/front.png', angle: '3/4 前侧' }, { file: 'refs/top.png', angle: '俯视' }] });
    mkdirSync(join(r, 'content/assets/M-arm/refs'));
    writeFileSync(join(r, 'content/assets/M-arm/refs/front.png'), png(64, 48, [90, 90, 100]));
    writeFileSync(join(r, 'content/assets/M-arm/refs/top.png'), png(64, 48, [100, 90, 90]));
    symlinkSync(join(root, 'node_modules'), join(r, 'node_modules'));
    cpSync(join(root, 'package.json'), join(r, 'package.json'));
    const out = await assetSheet(r, 'M-arm');
    expect(out.views.map(v => v.photo)).toEqual(['refs/front.png', null, 'refs/top.png', null]);
    expect(existsSync(out.out)).toBe(true);
    const size = imageSize(readFileSync(out.out))!;
    expect(size.w).toBeGreaterThan(1000);
    expect(size.h).toBeGreaterThan(1400);
  }, 120_000);
});
