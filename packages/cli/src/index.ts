#!/usr/bin/env node
// dls — discovery-learning-studio 命令行。Skill 的六个阶段都通过它落盘和检查。
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import type { CheckedItem, InterestObservation, LearningJudgment, LessonSpec, ReteachTicket } from '../../schema/src/index.js';
import { checkJudgment, loadContext, validate, type JudgmentReport, type Report } from '../../validator/src/index.js';
import { buildPreview } from './preview.js';
import {
  assemble, chatWith, childList, createMcp, designPrompt, generateLesson, guide, localBackend, modelFromEnv, readStages, serveStdio,
  StageError, studioContext, writeStages, PROVIDERS,
} from '../../studio/src/index.js';
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
  try { return assemble(readStages(dir), loadAssets(root)); }
  catch (e) { if (e instanceof StageError) throw new UsageError(e.message); throw e; }
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
      learner_profile: { grade: prof.grade, scaffold: [], language: { default: 'zh', cycle_enabled: true }, recent_judgment_ref: str(flags, 'judgment') ?? null, est_minutes: [10, 15] },
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
    const server = serverUrl(flags);
    if (existsSync(out)) {
      if (!server) { console.log(`${basename(out)} 已发布且已冻结；修改请升版本号`); return 1; }
      console.log(`${basename(out)} 已在本地冻结，直接上传`);
      return upload(server, readJson(out));
    }
    const frozen: LessonSpec = { ...sp, review_records: rv.records, published_at: new Date().toISOString() };
    frozen.content_hash = contentHash(frozen);
    writeJson(out, frozen);
    console.log(`已发布并冻结：${out}\n内容哈希：${frozen.content_hash}`);
    return server ? upload(server, frozen) : 0;
  },

  /** Stage 6 with a server: send the validated lesson to the parent app, where the parent reviews and publishes it. */
  async submit(pos, flags) {
    const dir = lessonDir(need(pos[0], '课程目录'));
    const server = serverUrl(flags) ?? need(undefined, '--server <地址>（或环境变量 ADW_SERVER）');
    const { sp, report } = runValidate(dir, flags);
    if (canonical(assembleSpec(dir)) !== canonical(sp)) { console.log('阶段文件在组装之后改过，先重新运行 dls assemble 和 dls validate'); return 1; }
    if (!report.ok) { printReport(report); console.log('\n校验未通过，不能提交审核'); return 1; }
    const r = await serverCall<{ key: string; warnings: number }>(server, '/v1/drafts', { method: 'POST', body: sp });
    console.log(`已提交审核：${r.key}${r.warnings ? `（警告 ${r.warnings} 条）` : ''}。请家长在家长端「课程库」看课、勾选四类审核并发布。`);
    return 0;
  },

  /** Pull interest records (including the children's next-lesson wishes) from the server into content/interests.json. */
  async sync(_pos, flags) {
    const server = serverUrl(flags) ?? need(undefined, '--server <地址>（或环境变量 ADW_SERVER）');
    const remote = await serverCall<InterestObservation[]>(server, '/v1/interests');
    const p = join(root, 'content', 'interests.json');
    const local = loadInterests(root);
    const onlyLocal = local.filter(x => !remote.some(r => r.id === x.id));
    writeJson(p, remote);
    const added = remote.filter(r => !local.some(x => x.id === r.id));
    console.log(`已从服务器同步 ${remote.length} 条兴趣记录（新增 ${added.length}）`);
    for (const x of added) console.log(`  + ${x.id} ${x.child} ${x.topic} · ${x.source} · ${x.state}`);
    if (onlyLocal.length) console.log(`注意：本地有 ${onlyLocal.length} 条服务器上没有的记录已被替换（${onlyLocal.map(x => x.id).join('、')}），请在家长端重新记一下`);
    // Lessons the parent published in the parent app, so later reteach versions can compare with them (V10).
    const pubDir = join(root, 'content', 'published');
    let pulled = 0;
    for (const l of await serverCall<{ key: string }[]>(server, '/v1/lessons')) {
      const f = join(pubDir, `${l.key}.lesson.json`);
      if (existsSync(f)) continue;
      writeJson(f, await serverCall(server, `/v1/lessons/${encodeURIComponent(l.key)}`));
      pulled++;
    }
    if (pulled) console.log(`已拉回 ${pulled} 节已发布的课到 content/published`);
    const drafts = await serverCall<{ key: string; status: string; note: string | null }[]>(server, '/v1/drafts');
    for (const d of drafts.filter(d => d.status === '已退回')) console.log(`家长退回了 ${d.key}：${d.note}`);
    const hist = await serverCall<unknown[]>(server, '/v1/reteach-history');
    writeJson(join(root, 'content', 'reteach.json'), hist);
    console.log(`已同步 ${hist.length} 条重教历史（V15 用）`);
    return 0;
  },

  /** homework-analysis Skill: list, pull photos, upload recognition, draft/check/submit a judgment. */
  async homework(pos, flags) {
    const sub = pos[0];
    const server = serverUrl(flags) ?? need(undefined, '--server <地址>（或环境变量 ADW_SERVER）');
    const hwDir = (id: string) => join(root, 'content', 'homework', id);
    if (sub === 'list' || !sub) {
      const list = await serverCall<{ id: string; child: string; date: string; status: string; items: number; to_check: number; judgment: string | null; ai_consent: boolean; note: string | null }[]>(server, '/v1/homework');
      if (!list.length) console.log('还没有作业');
      for (const h of list) console.log(`${h.id} ${h.child} ${h.date} · ${h.status}${h.items ? ` · ${h.items} 题，待核对 ${h.to_check}` : ''}${h.judgment ? ` · ${h.judgment}` : ''}${h.ai_consent ? '' : ' · 未同意 AI 识别'}${h.note ? ` · ${h.note}` : ''}`);
      return 0;
    }
    const id = need(pos[1], '作业编号（如 HW-0001）');
    if (sub === 'pull') {
      const hw = await serverCall<{ id: string; child: string; date: string; note: string | null; ai_consent: boolean; photos: { id: string; mime: string }[]; items: unknown[] }>(server, `/v1/homework/${id}`);
      if (!hw.ai_consent) { console.log('家长没有同意用 AI 识别这份作业的照片，不能下载给 Skill 看。请家长在家长端重新上传并勾选同意。'); return 1; }
      const dir = hwDir(id);
      mkdirSync(dir, { recursive: true });
      for (const p of hw.photos) {
        const buf = await serverFetch(server, `/v1/homework/${id}/photos/${p.id}`);
        writeFileSync(join(dir, `${p.id}.${p.mime.split('/')[1].replace('jpeg', 'jpg')}`), buf);
      }
      const { photos: _p, ...meta } = hw;
      writeJson(join(dir, 'homework.json'), { ...meta, photos: hw.photos });
      console.log(`已下载 ${hw.photos.length} 张照片到 ${dir}（${hw.child}，${hw.date}${hw.note ? `，${hw.note}` : ''}）`);
      console.log(`下一步：逐张看照片，写 ${join(dir, 'recognition.json')}，再运行 dls homework recognize ${id}`);
      return 0;
    }
    if (sub === 'recognize') {
      const file = str(flags, 'file') ?? join(hwDir(id), 'recognition.json');
      const rec = readJson(file);
      const r = await serverCall<{ items: number; to_check: number }>(server, `/v1/homework/${id}/recognition`, { method: 'PUT', body: rec });
      console.log(`已上传识别结果：${r.items} 题，其中 ${r.to_check} 题置信度低、标了“请核对”。请家长在家长端逐题核对。`);
      return 0;
    }
    if (sub === 'draft') {
      const hw = await serverCall<{ status: string; items: { confirmed: boolean; no: string; original?: object | null }[] }>(server, `/v1/homework/${id}`);
      if (hw.status === '待识别' || hw.status === '待核对') { console.log(`家长还没核对完（${hw.items.filter(i => !i.confirmed).length} 题待核对），先等家长核对`); return 1; }
      const dir = hwDir(id);
      mkdirSync(dir, { recursive: true });
      writeJson(join(dir, 'items.json'), hw.items);
      const out = join(dir, 'judgment.json');
      if (existsSync(out) && !flags.force) { console.log(`${out} 已存在（--force 覆盖）`); return 1; }
      writeJson(out, await serverCall(server, `/v1/homework/${id}/draft`));
      const corrected = hw.items.filter(i => i.original).map(i => i.no);
      console.log(`已写判断草稿 ${out}，核对后的题在 items.json${corrected.length ? `；家长改过第 ${corrected.join('、')} 题，以改后的为准` : ''}`);
      console.log('下一步：补全“可能的缺口”“还不知道的”“下一课建议”和家长卡，再运行 dls homework check');
      return 0;
    }
    if (sub === 'check' || sub === 'submit') {
      const dir = hwDir(id);
      const j = readJson<LearningJudgment>(str(flags, 'file') ?? join(dir, 'judgment.json'));
      const items = existsSync(join(dir, 'items.json')) ? readJson<CheckedItem[]>(join(dir, 'items.json')) : [];
      const prev = await serverCall<{ status: string; judgment: LearningJudgment }[]>(server, `/v1/judgments?child=${encodeURIComponent(j.child)}`);
      const report = checkJudgment(j, { concepts: readJson(join(root, 'content', 'concepts.json')), items, previous: prev.filter(p => p.status === '已确认').map(p => p.judgment) });
      printJudgmentReport(report);
      if (!report.ok) { console.log('\n判断校验未通过'); return 1; }
      if (sub === 'check') return 0;
      const r = await serverCall<{ id: string; status: string }>(server, '/v1/judgments', { method: 'POST', body: j });
      console.log(`\n已提交 ${r.id}（${r.status}）。请家长在家长端“作业”页看判断并确认；确认后“需再支持”的知识点会生成重教需求。`);
      return 0;
    }
    throw new UsageError(`未知子命令 ${sub}`);
  },

  /** Reteach requests waiting for a lesson, and how to start one. */
  async tickets(_pos, flags) {
    const server = serverUrl(flags) ?? need(undefined, '--server <地址>（或环境变量 ADW_SERVER）');
    const list = await serverCall<ReteachTicket[]>(server, '/v1/tickets');
    const concepts = readJson<Record<string, { name: string }>>(join(root, 'content', 'concepts.json'));
    const published = loadPublished(root);
    if (!list.length) console.log('没有重教需求');
    for (const t of list) {
      console.log(`${t.id} ${t.child} · ${concepts[t.concept_id]?.name ?? t.concept_id} · 第 ${t.attempt} 次 · ${t.status}${t.lesson_ref ? ` · ${t.lesson_ref}` : ''} · 依据 ${t.judgment_ref}`);
      if (t.status !== '需求登记') continue;
      const last = published.filter(p => p.for_child === t.child && p.primary_concept.id === t.concept_id).sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''))[0];
      if (last) {
        const [maj, min] = last.version.split('.').map(Number);
        console.log(`    开始重教版：pnpm -s dls init ${last.lesson_id} ${maj}.${min + 1} --child ${t.child} --previous ${last.version} --judgment ${t.judgment_ref}`);
      } else console.log(`    这个知识点还没有给 ${t.child} 发布过课，做一节新课并在 01-target.json 写 trigger_judgment_ref: ${t.judgment_ref}`);
    }
    return 0;
  },

  /** Any Skill as plain text, for models and agents that don't load skill folders (also the MCP tool adw_read_skill). */
  skill(pos) {
    const [name, file] = pos;
    try { console.log(name ? guide(root, `skill:${name}${file ? `/${file}` : ''}`) : guide(root, 'skills')); }
    catch (e) { throw new UsageError((e as Error).message); }
    return 0;
  },

  /** Everything a model needs to write the next lesson for one child (also what the MCP tool adw_get_context returns). */
  context(_pos, flags) {
    const child = need(str(flags, 'child'), `--child（${childList(root).map(c => c.id).join(' / ')}）`);
    const ctx = studioContext(root, child);
    if (flags.json) { console.log(JSON.stringify(ctx, null, 2)); return 0; }
    console.log(`${ctx.child.label}（${ctx.child.id}）· ${ctx.child.grade} 年级 · ${ctx.child.region}${ctx.child.system}`);
    console.log(`兴趣：${ctx.interests.map(i => `${i.topic}（${i.state}）`).join('、') || '还没有记录'}`);
    for (const c of ctx.components) {
      console.log(`\n组件 ${c.id}：${c.teaches.map(t => t.name).join('、')}`);
      console.log(`  建议主题：${c.suggested_theme.name}（${c.suggested_theme.why}）${c.theme_notes.length ? `；${c.theme_notes.join('；')}` : ''}`);
      console.log(`  可用主题：${c.themes_ready.map(t => t.name).join('、')} · 热点锚点：${c.hotspot_anchors.join('、')} · 动作：${c.actions.join('、')}`);
      console.log(`  新课 id：${c.new_lesson_id}@1.0`);
    }
    console.log(`\n已发布给这个孩子的课：${ctx.lessons_for_child.map(l => `${l.key} ${l.title}`).join('；') || '没有'}\n（--json 输出完整内容）`);
    return 0;
  },

  /** What to paste into ChatGPT (or any chat) to plan the next lesson with it; the agreed plan goes to dls generate --wish. */
  design(_pos, flags) {
    console.log(designPrompt(studioContext(root, need(str(flags, 'child'), `--child（${childList(root).map(c => c.id).join(' / ')}）`))));
    return 0;
  },

  /** The built-in lesson writer: any OpenAI-compatible model writes the stage files, the validator checks them. */
  async generate(_pos, flags) {
    const child = need(str(flags, 'child'), '--child');
    const cfg = modelFromEnv();
    if (!cfg) {
      console.log(`没有配置大模型。设置环境变量后再运行，例如 DeepSeek：\n  ADW_LLM_PROVIDER=deepseek ADW_LLM_API_KEY=sk-… ADW_LLM_MODEL=deepseek-v4-pro pnpm -s dls generate --child ${child}\n可选的 ADW_LLM_PROVIDER：${PROVIDERS.map(p => p.id).join('、')}；其他 OpenAI 兼容接口用 ADW_LLM_BASE_URL。`);
      return 2;
    }
    const ctx = studioContext(root, child);
    console.log(`用 ${cfg.label} · ${cfg.model} 给 ${ctx.child.label} 写课…`);
    const r = await generateLesson({ root, ctx, chat: chatWith(cfg), request: { wish: str(flags, 'wish'), component: str(flags, 'component') }, rounds: Number(str(flags, 'rounds') ?? 4), onLog: l => console.log('  ' + l) });
    if (!r.stages) { console.log('模型没有给出能用的课'); return 1; }
    const dir = join(root, 'content', 'lessons', r.stages.target.lesson_id, r.stages.target.version);
    writeStages(dir, r.stages);
    if (r.spec) writeJson(join(dir, F.spec), r.spec);
    if (r.report) { writeJson(join(dir, F.validation), r.report); if (!r.ok) printReport(r.report); }
    console.log(r.ok ? `\n已写好 ${dir}（${r.rounds} 轮）。下一步：dls preview ${dir}，再 dls submit ${dir} 交给家长审核。` : `\n${r.rounds} 轮后还有问题，阶段文件留在 ${dir}，可以手动改或再运行一次。`);
    if (r.ok && flags.submit) return commands.submit([dir], flags);
    return r.ok ? 0 : 1;
  },

  /** MCP server on stdio: agents (Codex, Claude Code, Qoder, Cursor…) call the lesson tools directly. */
  async mcp(_pos, flags) {
    const server = serverUrl(flags);
    const backend = localBackend(root, server ? spec => serverCall(server, '/v1/drafts', { method: 'POST', body: spec }) : undefined);
    serveStdio(createMcp(backend));
    return new Promise<number>(res => process.stdin.on('end', () => res(0)));
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

const serverUrl = (f: Flags) => (str(f, 'server') ?? process.env.ADW_SERVER)?.replace(/\/+$/, '');
let parentToken: string | null = null;
async function serverCall<T>(server: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  // an agent token from the parent app (设备与数据 → AI 助手接入) can only hand lessons in; everything else needs the parent PIN
  const agent = process.env.ADW_TOKEN && path === '/v1/drafts' && init.method === 'POST' ? process.env.ADW_TOKEN : null;
  if (!agent && !parentToken) {
    const pin = process.env.ADW_PIN ?? need(undefined, '环境变量 ADW_PIN（家长 PIN）');
    const r = await fetch(`${server}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }) });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new UsageError(`登录服务器失败：${b.error ?? r.status}`);
    parentToken = b.token;
  }
  const r = await fetch(`${server}${path}`, { method: init.method ?? 'GET', headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), authorization: `Bearer ${agent ?? parentToken}` }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (b.report) printReport(b.report);
    throw new UsageError(`服务器拒绝（${r.status}）：${b.error ?? ''}`);
  }
  return b as T;
}
async function serverFetch(server: string, path: string): Promise<Buffer> {
  await serverCall(server, '/v1/time');
  const r = await fetch(`${server}${path}`, { headers: { authorization: `Bearer ${parentToken}` } });
  if (!r.ok) throw new UsageError(`下载失败（${r.status}）：${path}`);
  return Buffer.from(await r.arrayBuffer());
}
function printJudgmentReport(r: JudgmentReport) {
  console.log(`判断校验：${r.ok ? '通过' : '未通过'}（错误 ${r.errors}，警告 ${r.warnings}）`);
  for (const x of r.results) {
    console.log(`${x.ok ? '✓' : x.level === 'warn' ? '!' : '✗'} ${x.id} ${x.name} [${x.basis}]`);
    for (const i of x.issues) console.log(`    ${i.path}：${i.msg}${i.fix ? `\n      → ${i.fix}` : ''}`);
  }
}
async function upload(server: string, sp: LessonSpec): Promise<number> {
  const r = await serverCall<{ key: string; status: string; warnings?: number }>(server, '/v1/lessons', { method: 'POST', body: sp });
  console.log(`服务器：${r.key} ${r.status}${r.warnings ? `（警告 ${r.warnings} 条）` : ''}。在家长端排课后孩子就能看到。`);
  return 0;
}

const HELP = `dls — discovery-learning-studio 命令行

  dls init <课程id> <版本> --child <孩子> [--previous <上一版>] [--judgment <判断id>]
  dls target <目录>                       阶段 1：检查目标锁定
  dls theme <目录> --component <组件> [--write]   阶段 2：按孩子兴趣建议主题和课末心愿
  dls assets <目录>                       阶段 3：核验素材（许可、写实底线）
  dls assemble <目录>                     阶段 4：组装 lessonspec.json
  dls validate <目录|文件> [--previous <文件>] [--json]   阶段 5：V01–V20
  dls preview <目录|文件> [--out <文件>]         生成可直接打开的课程预览
  dls review <目录> [--init] [--approve <类别,…|all> --by <审核人>]   阶段 6：审核清单
  dls submit <目录> --server <地址>       阶段 6：交给家长端审核并发布（推荐）
  dls publish <目录> [--server <地址>]     阶段 6：校验 + 审核齐全后发布并冻结；带 --server 时上传（需 ADW_PIN）
  dls sync --server <地址>                从服务器拉回兴趣、孩子的下一课心愿和重教历史
  dls homework list|pull|recognize|draft|check|submit [<作业编号>] --server <地址>   作业判断（homework-analysis Skill）
  dls tickets --server <地址>             重教需求，以及开始重教版的命令
  dls interest [add] --child <孩子> [--topic … --source … --state … --said …]
  dls skill [<名称> [<文件>]]              读项目里的 Skill（不写名称时列出全部），给不会自己读文件夹的模型用
  dls context --child <孩子> [--json]      做课需要的全部信息（兴趣、可用组件、建议主题、新课 id）
  dls design --child <孩子>                给 ChatGPT 等聊天模型的设计说明：和它谈好方案，再交给 dls generate --wish
  dls generate --child <孩子> [--wish <要求>] [--component <组件>] [--submit --server <地址>]
                                          用任意大模型自动写课并校验（环境变量 ADW_LLM_PROVIDER / ADW_LLM_API_KEY / ADW_LLM_MODEL / ADW_LLM_BASE_URL）
  dls mcp [--server <地址>]               以 MCP（stdio）提供做课工具，给 Codex、Claude Code、Qoder、Cursor 等 agent 用`;

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
