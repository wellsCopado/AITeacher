#!/usr/bin/env node
// dls — discovery-learning-studio 命令行。Skill 的六个阶段都通过它落盘和检查。
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import type { InterestObservation, LessonSpec } from '../../schema/src/index.js';
import { loadContext, validate, type Report } from '../../validator/src/index.js';
import { buildPreview } from './preview.js';
import { writeFileSync } from 'node:fs';
import {
  REVIEW_CHECKLIST, STAGE_FILES as F, canonical, contentHash, findRoot, loadAssets, loadInterests, loadPublished,
  loadThemes, readJson, suggestTheme, writeJson,
} from './lib.js';

type Flags = Record<string, string | true>;
function parse(argv: string[]): { pos: string[]; flags: Flags } {
  const pos: string[] = []; const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2); const n = argv[i + 1];
      if (n !== undefined && !n.startsWith('--')) { flags[k] = n; i++; } else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}
const str = (f: Flags, k: string) => (typeof f[k] === 'string' ? (f[k] as string) : undefined);
function need(v: string | undefined, what: string): string { if (!v) throw new UsageError(`缺少 ${what}`); return v; }
class UsageError extends Error {}

const root = (() => { try { return findRoot(); } catch { return process.cwd(); } })();
const lessonDir = (d: string) => resolve(d);
const has = (dir: string, f: string) => existsSync(join(dir, f));

function printReport(r: Report) {
  console.log(`\n校验 ${r.lesson}：${r.ok ? '通过' : '未通过'}（错误 ${r.errors}，警告 ${r.warnings}）`);
  for (const x of r.results) {
    const mark = x.ok ? '✓' : x.level === 'warn' ? '!' : '✗';
    console.log(`${mark} ${x.id} ${x.name} [${x.basis}]`);
    for (const i of x.issues) console.log(`    ${i.path}：${i.msg}${i.fix ? `\n      → ${i.fix}` : ''}`);
  }
}

function assembleSpec(dir: string): LessonSpec {
  for (const f of [F.target, F.director, F.assets]) if (!has(dir, f)) throw new UsageError(`${dir} 缺少 ${f}，先完成前面的阶段`);
  const t = readJson(join(dir, F.target)); const d = readJson(join(dir, F.director)); const a = readJson(join(dir, F.assets));
  const registry = loadAssets(root);
  const missing: string[] = [];
  const refs = (a.use as string[]).map(id => {
    const r = registry.find(x => x.asset_id === id);
    if (!r) { missing.push(id); return null; }
    return {
      asset_id: r.asset_id, kind: r.kind, realism: r.realism, ver: r.version, license: r.license,
      commercial_ok: r.commercial_ok, source: r.source, depiction: r.depiction,
      ...(r.reference_photos ? { reference_photos: r.reference_photos } : {}),
      ...(r.checked_by !== undefined ? { checked_by: r.checked_by } : {}),
    };
  }).filter(Boolean);
  if (missing.length) throw new UsageError(`资产库里没有：${missing.join('、')}（先登记到 content/assets/registry.json）`);
  const spec = {
    schema_version: 'lessonspec/1.0',
    lesson_id: t.lesson_id, version: t.version, tenant_id: t.tenant_id, for_child: t.for_child,
    title: d.title,
    ...(t.previous_version ? { previous_version: t.previous_version } : {}),
    ...(t.trigger_judgment_ref ? { trigger_judgment_ref: t.trigger_judgment_ref } : {}),
    primary_concept: t.primary_concept,
    ...(t.prerequisites ? { prerequisites: t.prerequisites } : {}),
    curriculum_mapping: t.curriculum_mapping,
    theme: d.theme,
    intro: d.intro,
    learner_profile: t.learner_profile,
    scene_component_ids: d.scene_component_ids,
    component_params: d.component_params,
    experiment_model_version: d.experiment_model_version,
    activity_graph: d.activity_graph,
    hotspots: d.hotspots,
    challenges: d.challenges,
    end_chat: d.end_chat,
    object_asset_versions: refs,
    ...(a.pending?.length ? { pending_assets: a.pending } : {}),
    assessment_plan: d.assessment_plan,
    ...(d.offscreen ? { offscreen: d.offscreen } : {}),
    parent_tip: d.parent_tip,
    source_refs: d.source_refs,
    distribution: { scope: a.scope ?? 'family', tenant_id: t.tenant_id },
  };
  return spec as LessonSpec;
}

function previousFor(sp: LessonSpec, flags: Flags): LessonSpec | null {
  const p = str(flags, 'previous');
  if (p) return readJson(p);
  if (sp.previous_version) {
    const f = join(root, 'content', 'published', `${sp.lesson_id}@${sp.previous_version}.lesson.json`);
    if (existsSync(f)) return readJson(f);
  }
  return null;
}

function runValidate(target: string, flags: Flags): { sp: LessonSpec; report: Report; dir: string | null } {
  const isDir = statSync(target).isDirectory();
  const file = isDir ? join(target, F.spec) : target;
  if (!existsSync(file)) throw new UsageError(`${file} 不存在，先运行 dls assemble`);
  const sp = readJson<LessonSpec>(file);
  const report = validate(sp, loadContext(root, previousFor(sp, flags)));
  return { sp, report, dir: isDir ? target : null };
}

const commands: Record<string, (pos: string[], flags: Flags) => number | Promise<number>> = {
  init(pos, flags) {
    const [id, ver] = pos;
    need(id, '课程 id（如 L-PA）'); need(ver, '版本（如 1.0）');
    const child = need(str(flags, 'child'), '--child');
    const tenant = str(flags, 'tenant') ?? 'family-001';
    const children = readJson(join(root, 'content', 'children.json'));
    const prof = children[child];
    if (!prof) throw new UsageError(`children.json 里没有 ${child}`);
    const dir = join(root, 'content', 'lessons', id, ver);
    if (existsSync(join(dir, F.target))) throw new UsageError(`${dir} 已存在`);
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, F.target), {
      lesson_id: id, version: ver, tenant_id: tenant, for_child: child,
      previous_version: str(flags, 'previous') ?? null, trigger_judgment_ref: str(flags, 'judgment') ?? null,
      primary_concept: { id: '', name: '', target_misconceptions: [] }, prerequisites: [],
      curriculum_mapping: { region: prof.region, system: prof.system, grade: prof.grade, term: '', source: '沪学习 App 参考目录', publisher: '待核对', unit: '待核对', status: '参考·待核对', verified_by: null, checked_on: new Date().toISOString().slice(0, 10) },
      learner_profile: { grade: prof.grade, scaffold: [], language: { default: 'zh', cycle_enabled: false }, recent_judgment_ref: str(flags, 'judgment') ?? null, est_minutes: [10, 15] },
    });
    console.log(`已创建 ${dir}/${F.target}。下一步：填好主知识点和误区，运行 dls target ${dir}`);
    return 0;
  },

  target(pos) {
    const dir = lessonDir(need(pos[0], '课程目录'));
    const t = readJson(join(dir, F.target));
    const concepts = readJson(join(root, 'content', 'concepts.json'));
    const children = readJson(join(root, 'content', 'children.json'));
    const errs: string[] = [];
    const c = concepts[t.primary_concept?.id];
    if (!c) errs.push(`主知识点 ${t.primary_concept?.id || '（空）'} 不在 concepts.json`);
    if ((t.primary_concept?.target_misconceptions ?? []).length > 3) errs.push('误区最多 3 个');
    for (const m of t.primary_concept?.target_misconceptions ?? []) if (c && !c.misconceptions.includes(m)) errs.push(`误区 ${m} 不属于 ${t.primary_concept.id}`);
    for (const p of t.prerequisites ?? []) if (!concepts[p]) errs.push(`前置知识点 ${p} 不在 concepts.json`);
    const prof = children[t.for_child];
    if (!prof) errs.push(`children.json 里没有 ${t.for_child}`);
    else if (t.learner_profile.grade !== prof.grade) errs.push(`年级应为 ${prof.grade}`);
    if (t.curriculum_mapping.status === '已核对本年级' && !t.curriculum_mapping.verified_by) errs.push('标了已核对本年级但没有核对人');
    if (errs.length) { console.log('目标锁定未通过：\n' + errs.map(e => '  ✗ ' + e).join('\n')); return 1; }
    console.log(`目标锁定通过：${t.for_child} · ${t.primary_concept.name}（误区：${t.primary_concept.target_misconceptions.join('、') || '无'}）· 教材映射：${t.curriculum_mapping.status}`);
    return 0;
  },

  theme(pos, flags) {
    const dir = lessonDir(need(pos[0], '课程目录'));
    const t = readJson(join(dir, F.target));
    const component = need(str(flags, 'component'), '--component（如 PerimeterArea）');
    const children = readJson(join(root, 'content', 'children.json'));
    const s = suggestTheme({
      child: t.for_child, tenant: t.tenant_id, component, interests: loadInterests(root),
      themes: loadThemes(root), profile: children[t.for_child], published: loadPublished(root),
    });
    console.log(`建议主题：${s.theme.name}（${s.theme.id}）\n依据：${s.theme.why}`);
    for (const n of s.notes) console.log(`  · ${n}`);
    console.log(`课末心愿：${s.wish.prompt}\n  选项：${s.wish.options.join(' / ')} / 我自己说一个`);
    if (flags.write) {
      const p = join(dir, F.director);
      const d = existsSync(p) ? readJson(p) : {};
      d.theme = s.theme;
      d.end_chat = d.end_chat ?? { skippable: true, questions: [] };
      d.end_chat.questions = [...(d.end_chat.questions ?? []).filter((q: { kind: string }) => q.kind !== 'next_lesson_wish'), s.wish];
      writeJson(p, d);
      console.log(`已写入 ${p} 的 theme 和 end_chat`);
    }
    return 0;
  },

  assets(pos) {
    const dir = lessonDir(need(pos[0], '课程目录'));
    const a = readJson(join(dir, F.assets));
    const reg = loadAssets(root);
    let bad = 0;
    for (const id of a.use as string[]) {
      const r = reg.find(x => x.asset_id === id);
      if (!r) { console.log(`✗ ${id}：资产库没有登记`); bad++; continue; }
      const ok = (r.status === '采用' || r.status === '采用标记') && r.realism !== 'stylized' && !(r.kind === 'organism' && !['scan', 'photo', 'ai_from_photo'].includes(r.realism));
      if (!ok) bad++;
      console.log(`${ok ? '✓' : '✗'} ${id}  ${r.name ?? ''} · ${r.realism} · ${r.license}${r.commercial_ok ? '' : '（仅家用）'} · ${r.status}${r.note ? ' · ' + r.note : ''}`);
    }
    for (const p of a.pending ?? []) {
      const ok = /不展示/.test(p.until_ready);
      if (!ok) bad++;
      console.log(`${ok ? '…' : '✗'} 待采购 ${p.asset_id}：${p.status}；到位前：${p.until_ready}`);
    }
    console.log(bad ? `素材核验未通过（${bad} 项）` : '素材核验通过');
    return bad ? 1 : 0;
  },

  assemble(pos) {
    const dir = lessonDir(need(pos[0], '课程目录'));
    const spec = assembleSpec(dir);
    writeJson(join(dir, F.spec), spec);
    console.log(`已组装 ${join(dir, F.spec)}。下一步：dls validate ${dir}`);
    return 0;
  },

  validate(pos, flags) {
    const { report, dir } = runValidate(resolve(need(pos[0], '课程目录或 lessonspec 文件')), flags);
    if (dir) writeJson(join(dir, F.validation), report);
    if (flags.json) console.log(JSON.stringify(report, null, 2)); else printReport(report);
    return report.ok ? 0 : 1;
  },

  async preview(pos, flags) {
    const target = resolve(need(pos[0], '课程目录或 lessonspec 文件'));
    const { sp, report, dir } = runValidate(target, flags);
    if (!report.ok) { printReport(report); console.log('\n校验未通过；预览照常生成，但不能发布'); }
    const children = readJson(join(root, 'content', 'children.json'));
    const html = await buildPreview(sp, children[sp.for_child]?.name ?? sp.for_child);
    const out = str(flags, 'out') ?? join(dir ?? resolve(target, '..'), 'preview.html');
    writeFileSync(out, html);
    console.log(`已生成预览：${out}（${Math.round(html.length / 1024)} KB，用浏览器直接打开）`);
    return 0;
  },

  review(pos, flags) {
    const dir = lessonDir(need(pos[0], '课程目录'));
    const p = join(dir, F.review);
    if (flags.init || !existsSync(p)) {
      writeJson(p, { checklist: REVIEW_CHECKLIST, records: [] });
      console.log(`已生成审核清单 ${p}`);
    }
    const r = readJson(p);
    const approve = str(flags, 'approve');
    if (approve) {
      const by = need(str(flags, 'by'), '--by（审核人）');
      const cats = approve === 'all' ? Object.keys(REVIEW_CHECKLIST) : approve.split(',');
      for (const c of cats) {
        const items = REVIEW_CHECKLIST[c as keyof typeof REVIEW_CHECKLIST];
        if (!items) throw new UsageError(`没有审核类别 ${c}`);
        r.records = r.records.filter((x: { category: string }) => x.category !== c);
        r.records.push({ category: c, reviewer: by, checked: items, at: new Date().toISOString() });
      }
      writeJson(p, r);
    }
    for (const [c, items] of Object.entries(REVIEW_CHECKLIST)) {
      const rec = r.records.find((x: { category: string }) => x.category === c);
      console.log(`${rec ? '✓' : '○'} ${c}：${items.join('；')}${rec ? `（${rec.reviewer}）` : ''}`);
    }
    return 0;
  },

  publish(pos, flags) {
    const dir = lessonDir(need(pos[0], '课程目录'));
    const { sp, report } = runValidate(dir, flags);
    if (canonical(assembleSpec(dir)) !== canonical(sp)) { console.log('阶段文件在组装之后改过，先重新运行 dls assemble 和 dls validate'); return 1; }
    if (!report.ok) { printReport(report); console.log('\n校验未通过，不能发布'); return 1; }
    if (!has(dir, F.review)) { console.log('还没有审核记录，先 dls review'); return 1; }
    const rv = readJson(join(dir, F.review));
    const missing = Object.keys(REVIEW_CHECKLIST).filter(c => !rv.records.some((x: { category: string }) => x.category === c));
    if (missing.length) { console.log(`审核未完成：${missing.join('、')}`); return 1; }
    const out = join(root, 'content', 'published', `${sp.lesson_id}@${sp.version}.lesson.json`);
    if (existsSync(out)) { console.log(`${basename(out)} 已发布且已冻结；修改请升版本号`); return 1; }
    const frozen: LessonSpec = { ...sp, review_records: rv.records, published_at: new Date().toISOString() };
    frozen.content_hash = contentHash(frozen);
    writeJson(out, frozen);
    console.log(`已发布并冻结：${out}\n内容哈希：${frozen.content_hash}`);
    if (flags.server) console.log('上传到内容服务器在 M3 实现；目前请把这个文件交给服务器目录。');
    return 0;
  },

  interest(pos, flags) {
    const sub = pos[0];
    const p = join(root, 'content', 'interests.json');
    const list = loadInterests(root);
    if (sub === 'add') {
      const rec: InterestObservation = {
        id: `IO-${String(Math.max(0, ...list.map(x => Number(x.id.slice(3)))) + 1).padStart(4, '0')}`,
        tenant_id: str(flags, 'tenant') ?? 'family-001',
        child: need(str(flags, 'child'), '--child'),
        topic: need(str(flags, 'topic'), '--topic'),
        source: (str(flags, 'source') ?? '孩子自述') as InterestObservation['source'],
        said: str(flags, 'said') ?? null,
        observed_on: str(flags, 'on') ?? new Date().toISOString().slice(0, 10),
        state: (str(flags, 'state') ?? '下一课心愿') as InterestObservation['state'],
        lesson_ref: str(flags, 'lesson') ?? null,
      };
      list.push(rec); writeJson(p, list);
      console.log(`已记录 ${rec.id}：${rec.child} · ${rec.topic} · ${rec.source} · ${rec.state}`);
      return 0;
    }
    const child = str(flags, 'child');
    for (const x of list.filter(x => !child || x.child === child)) console.log(`${x.id} ${x.child} ${x.topic} · ${x.source} · ${x.state} · ${x.observed_on}`);
    return 0;
  },
};

const HELP = `dls — discovery-learning-studio 命令行

  dls init <课程id> <版本> --child <孩子> [--previous <上一版>] [--judgment <判断id>]
  dls target <目录>                       阶段 1：检查目标锁定
  dls theme <目录> --component <组件> [--write]   阶段 2：按孩子兴趣建议主题和课末心愿
  dls assets <目录>                       阶段 3：核验素材（许可、写实底线）
  dls assemble <目录>                     阶段 4：组装 lessonspec.json
  dls validate <目录|文件> [--previous <文件>] [--json]   阶段 5：V01–V14
  dls preview <目录|文件> [--out <文件>]         生成可直接打开的课程预览
  dls review <目录> [--init] [--approve <类别,…|all> --by <审核人>]   阶段 6：审核清单
  dls publish <目录>                      阶段 6：校验 + 审核齐全后发布并冻结
  dls interest [add] --child <孩子> [--topic … --source … --state … --said …]`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(HELP); return 0; }
  const fn = commands[cmd];
  if (!fn) { console.log(`未知命令 ${cmd}\n\n${HELP}`); return 2; }
  const { pos, flags } = parse(rest);
  try { return await fn(pos, flags); }
  catch (e) { if (e instanceof UsageError) { console.log(e.message); return 2; } throw e; }
}

process.exitCode = await main(process.argv.slice(2));
