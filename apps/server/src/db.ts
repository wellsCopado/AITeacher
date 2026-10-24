// SQLite storage for the family server. Every row carries tenant_id so a commercial build can isolate tenants.
import { DatabaseSync } from 'node:sqlite';
import type {
  CheckedItem, FeedbackItem, HomeworkUpload, InterestObservation, LearningJudgment, LessonSpec, ParentCard, ReteachTicket,
} from '../../../packages/schema/src/index.js';

const SCHEMA = `
create table if not exists children (id text primary key, tenant_id text not null, name text not null, grade integer not null);
create table if not exists lessons (
  lesson_id text not null, version text not null, tenant_id text not null, for_child text not null, title text not null,
  content_hash text not null, published_at text not null, spec text not null, primary key (lesson_id, version));
create table if not exists schedule (tenant_id text not null, date text not null, child text not null, lesson_key text not null,
  primary key (tenant_id, date, child, lesson_key));
create table if not exists grants (id integer primary key autoincrement, tenant_id text not null, child text not null,
  lesson_key text not null, expires_on text not null, granted_by text not null, created_at text not null);
create table if not exists sessions (key text primary key, tenant_id text not null, child text not null, lesson_key text not null,
  started_on text not null, updated_at text not null, finished integer not null default 0);
create table if not exists events (id text primary key, tenant_id text not null, session_key text not null, at text not null,
  type text not null, data text not null, received_at text not null);
create table if not exists interests (id text primary key, tenant_id text not null, child text not null, topic text not null,
  source text not null, said text, observed_on text not null, state text not null, lesson_ref text, created_at text not null);
create table if not exists tokens (hash text primary key, tenant_id text not null, role text not null, label text not null, created_at text not null);
create table if not exists pairing (code text primary key, tenant_id text not null, created_at text not null, label text, token text);
create index if not exists events_session on events(session_key);
create table if not exists homework (id text primary key, tenant_id text not null, child text not null, date text not null, note text,
  photos text not null, status text not null, ai_consent integer not null default 0, recognized_by text, created_at text not null);
create table if not exists hw_items (homework_id text not null, no text not null, pos integer not null, data text not null, primary key (homework_id, no));
create table if not exists judgments (id text primary key, tenant_id text not null, child text not null, homework_ref text not null, data text not null,
  status text not null, created_at text not null, confirmed_at text, card text, card_used integer not null default 0);
create table if not exists tickets (id text primary key, tenant_id text not null, child text not null, concept_id text not null, judgment_ref text not null,
  attempt integer not null, status text not null, lesson_ref text, mechanism text, created_at text not null, updated_at text not null);
create table if not exists drafts (key text not null, tenant_id text not null, for_child text not null, title text not null, spec text not null,
  status text not null, note text, submitted_by text not null, submitted_at text not null, primary key (tenant_id, key));
create table if not exists feedback (id text primary key, tenant_id text not null, child text not null, source text not null, said text not null,
  context text, kind text not null, ref text, created_at text not null);
create table if not exists media (id text primary key, tenant_id text not null, asset_id text not null, kind text not null, mime text not null,
  file text not null, key text not null, credit text not null, license text not null, source_url text, caption text, length_cm real,
  added_by text not null, created_at text not null);
`;

export type Role = 'parent' | 'device';
export interface SessionRow { key: string; child: string; lesson_key: string; started_on: string; updated_at: string; finished: number }
export interface JudgmentRow { id: string; child: string; homework_ref: string; status: '草稿' | '已确认'; created_at: string; confirmed_at: string | null; judgment: LearningJudgment; card: ParentCard | null; card_used: number }
export interface MediaRow {
  id: string; asset_id: string; kind: 'photo' | 'video' | 'model'; mime: string; file: string; key: string; credit: string; license: string;
  source_url: string | null; caption: string | null; length_cm: number | null; added_by: string; created_at: string;
}
export interface EventIn { id: string; at: string; type: string; [k: string]: unknown }

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string, readonly tenant: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('pragma journal_mode = wal; pragma foreign_keys = on;');
    this.db.exec(SCHEMA);
  }
  private all<T>(sql: string, ...p: (string | number | null)[]): T[] { return this.db.prepare(sql).all(...p) as T[]; }
  private get<T>(sql: string, ...p: (string | number | null)[]): T | undefined { return this.db.prepare(sql).get(...p) as T | undefined; }
  private run(sql: string, ...p: (string | number | null)[]) { return this.db.prepare(sql).run(...p); }
  tx<T>(fn: () => T): T {
    this.db.exec('begin');
    try { const r = fn(); this.db.exec('commit'); return r; } catch (e) { this.db.exec('rollback'); throw e; }
  }

  // children
  upsertChild(id: string, name: string, grade: number) {
    this.run('insert into children (id, tenant_id, name, grade) values (?,?,?,?) on conflict(id) do update set name=excluded.name, grade=excluded.grade', id, this.tenant, name, grade);
  }
  children() { return this.all<{ id: string; name: string; grade: number }>('select id, name, grade from children where tenant_id=? order by grade desc', this.tenant); }
  hasChild(id: string) { return !!this.get('select 1 from children where tenant_id=? and id=?', this.tenant, id); }

  // lessons
  addLesson(sp: LessonSpec) {
    this.run('insert into lessons (lesson_id, version, tenant_id, for_child, title, content_hash, published_at, spec) values (?,?,?,?,?,?,?,?)',
      sp.lesson_id, sp.version, this.tenant, sp.for_child, sp.title, sp.content_hash!, sp.published_at!, JSON.stringify(sp));
  }
  lesson(key: string): LessonSpec | undefined {
    const [id, ver] = key.split('@');
    const r = this.get<{ spec: string }>('select spec from lessons where tenant_id=? and lesson_id=? and version=?', this.tenant, id, ver ?? '');
    return r ? JSON.parse(r.spec) : undefined;
  }
  lessons() {
    return this.all<{ lesson_id: string; version: string; for_child: string; title: string; content_hash: string; published_at: string }>(
      'select lesson_id, version, for_child, title, content_hash, published_at from lessons where tenant_id=? order by published_at desc', this.tenant)
      .map(r => ({ key: `${r.lesson_id}@${r.version}`, ...r }));
  }

  // schedule and grants (FR55, BL13)
  setSchedule(date: string, child: string, keys: string[]) {
    this.tx(() => {
      this.run('delete from schedule where tenant_id=? and date=? and child=?', this.tenant, date, child);
      for (const k of keys) this.run('insert into schedule (tenant_id, date, child, lesson_key) values (?,?,?,?)', this.tenant, date, child, k);
    });
  }
  scheduled(date: string, child: string) { return this.all<{ lesson_key: string }>('select lesson_key from schedule where tenant_id=? and date=? and child=?', this.tenant, date, child).map(r => r.lesson_key); }
  scheduleRange(from: string, to: string) { return this.all<{ date: string; child: string; lesson_key: string }>('select date, child, lesson_key from schedule where tenant_id=? and date between ? and ? order by date', this.tenant, from, to); }
  addGrant(child: string, key: string, expiresOn: string, by: string, now: string) {
    this.run('insert into grants (tenant_id, child, lesson_key, expires_on, granted_by, created_at) values (?,?,?,?,?,?)', this.tenant, child, key, expiresOn, by, now);
  }
  activeGrants(child: string, today: string) {
    return this.all<{ lesson_key: string; expires_on: string }>('select lesson_key, max(expires_on) as expires_on from grants where tenant_id=? and child=? and expires_on>=? group by lesson_key', this.tenant, child, today);
  }
  grants() { return this.all<{ id: number; child: string; lesson_key: string; expires_on: string; granted_by: string; created_at: string }>('select id, child, lesson_key, expires_on, granted_by, created_at from grants where tenant_id=? order by id desc', this.tenant); }

  // sessions and events
  session(key: string) { return this.get<SessionRow>('select key, child, lesson_key, started_on, updated_at, finished from sessions where tenant_id=? and key=?', this.tenant, key); }
  ensureSession(key: string, child: string, lessonKey: string, today: string, now: string) {
    this.run('insert into sessions (key, tenant_id, child, lesson_key, started_on, updated_at) values (?,?,?,?,?,?) on conflict(key) do update set updated_at=excluded.updated_at', key, this.tenant, child, lessonKey, today, now);
  }
  finishSession(key: string) { this.run('update sessions set finished=1 where tenant_id=? and key=?', this.tenant, key); }
  /** Insert events, ignoring ids already stored so a Pad can resend its queue safely. Returns the events that were new. */
  addEvents(sessionKey: string, events: EventIn[], now: string): EventIn[] {
    const fresh: EventIn[] = [];
    const st = this.db.prepare('insert or ignore into events (id, tenant_id, session_key, at, type, data, received_at) values (?,?,?,?,?,?,?)');
    for (const e of events) {
      const { id, at, type, ...data } = e;
      if (Number(st.run(id, this.tenant, sessionKey, at, type, JSON.stringify(data), now).changes)) fresh.push(e);
    }
    return fresh;
  }
  sessions(child?: string) {
    return this.all<SessionRow & { events: number }>(
      `select s.key, s.child, s.lesson_key, s.started_on, s.updated_at, s.finished, (select count(*) from events e where e.session_key=s.key) as events
       from sessions s where s.tenant_id=? ${child ? 'and s.child=?' : ''} order by s.updated_at desc`, ...(child ? [this.tenant, child] : [this.tenant]));
  }
  events(sessionKey: string) {
    return this.all<{ id: string; at: string; type: string; data: string }>('select id, at, type, data from events where tenant_id=? and session_key=? order by at, id', this.tenant, sessionKey)
      .map(r => ({ id: r.id, at: r.at, type: r.type, ...JSON.parse(r.data) }));
  }

  // interests (BL05)
  interests(child?: string): InterestObservation[] {
    return this.all<InterestObservation>(`select id, tenant_id, child, topic, source, said, observed_on, state, lesson_ref from interests where tenant_id=? ${child ? 'and child=?' : ''} order by id`, ...(child ? [this.tenant, child] : [this.tenant]));
  }
  addInterest(x: Omit<InterestObservation, 'id' | 'tenant_id'> & { id?: string }, now: string): InterestObservation {
    const max = this.get<{ n: number | null }>("select max(cast(substr(id, 4) as integer)) as n from interests where tenant_id=?", this.tenant)?.n ?? 0;
    const rec: InterestObservation = { id: x.id ?? `IO-${String(max + 1).padStart(4, '0')}`, tenant_id: this.tenant, child: x.child, topic: x.topic, source: x.source, said: x.said ?? null, observed_on: x.observed_on, state: x.state, lesson_ref: x.lesson_ref ?? null };
    this.run('insert into interests (id, tenant_id, child, topic, source, said, observed_on, state, lesson_ref, created_at) values (?,?,?,?,?,?,?,?,?,?)',
      rec.id, this.tenant, rec.child, rec.topic, rec.source, rec.said ?? null, rec.observed_on, rec.state, rec.lesson_ref ?? null, now);
    return rec;
  }

  // auth
  addToken(hash: string, role: Role, label: string, now: string) { this.run('insert into tokens (hash, tenant_id, role, label, created_at) values (?,?,?,?,?)', hash, this.tenant, role, label, now); }
  token(hash: string) { return this.get<{ role: Role; label: string }>('select role, label from tokens where tenant_id=? and hash=?', this.tenant, hash); }
  devices() { return this.all<{ label: string; created_at: string }>("select label, created_at from tokens where tenant_id=? and role='device' order by created_at", this.tenant); }
  revokeDevice(label: string) { this.run("delete from tokens where tenant_id=? and role='device' and label=?", this.tenant, label); }
  startPairing(code: string, now: string) { this.run('insert into pairing (code, tenant_id, created_at) values (?,?,?)', code, this.tenant, now); }
  pairing(code: string) { return this.get<{ code: string; created_at: string; label: string | null; token: string | null }>('select code, created_at, label, token from pairing where tenant_id=? and code=?', this.tenant, code); }
  approvePairing(code: string, label: string, token: string) { this.run('update pairing set label=?, token=? where tenant_id=? and code=?', label, token, this.tenant, code); }
  expirePairings(before: string) { this.run('delete from pairing where tenant_id=? and created_at<?', this.tenant, before); }
  interestCount() { return this.get<{ n: number }>('select count(*) as n from interests where tenant_id=?', this.tenant)!.n; }
  endPairing(code: string) { this.run('delete from pairing where tenant_id=? and code=?', this.tenant, code); }

  // ids like HW-0001, per tenant and prefix
  private nextId(table: string, prefix: string) {
    const n = this.get<{ n: number | null }>(`select max(cast(substr(id, ${prefix.length + 2}) as integer)) as n from ${table} where tenant_id=?`, this.tenant)?.n ?? 0;
    return `${prefix}-${String(n + 1).padStart(4, '0')}`;
  }

  // homework (Spec §10)
  addHomework(h: Omit<HomeworkUpload, 'id' | 'status' | 'created_at'>, now: string): HomeworkUpload {
    const id = this.nextId('homework', 'HW');
    this.run('insert into homework (id, tenant_id, child, date, note, photos, status, ai_consent, created_at) values (?,?,?,?,?,?,?,?,?)', id, this.tenant, h.child, h.date, h.note, JSON.stringify(h.photos), '待识别', h.ai_consent ? 1 : 0, now);
    return this.homework(id)!;
  }
  homework(id: string): HomeworkUpload | undefined {
    const r = this.get<HomeworkUpload & { photos: string }>('select id, child, date, note, photos, status, ai_consent, created_at from homework where tenant_id=? and id=?', this.tenant, id);
    return r ? { ...r, photos: JSON.parse(r.photos), ai_consent: !!r.ai_consent } : undefined;
  }
  homeworks(child?: string): HomeworkUpload[] {
    return this.all<HomeworkUpload & { photos: string }>(`select id, child, date, note, photos, status, ai_consent, created_at from homework where tenant_id=? ${child ? 'and child=?' : ''} order by date desc, id desc`, ...(child ? [this.tenant, child] : [this.tenant]))
      .map(r => ({ ...r, photos: JSON.parse(r.photos), ai_consent: !!r.ai_consent }));
  }
  setHomeworkStatus(id: string, status: HomeworkUpload['status']) { this.run('update homework set status=? where tenant_id=? and id=?', status, this.tenant, id); }
  setItems(id: string, items: CheckedItem[], by: string) {
    this.tx(() => {
      this.run('delete from hw_items where homework_id=?', id);
      items.forEach((it, pos) => this.run('insert into hw_items (homework_id, no, pos, data) values (?,?,?,?)', id, it.no, pos, JSON.stringify(it)));
      this.run('update homework set recognized_by=? where tenant_id=? and id=?', by, this.tenant, id);
    });
  }
  items(id: string): CheckedItem[] { return this.all<{ data: string }>('select data from hw_items where homework_id=? order by pos', id).map(r => JSON.parse(r.data)); }
  updateItem(id: string, item: CheckedItem) { this.run('update hw_items set data=? where homework_id=? and no=?', JSON.stringify(item), id, item.no); }

  // judgments
  addJudgment(j: LearningJudgment, now: string): string {
    const id = this.nextId('judgments', 'LJ');
    this.run('insert into judgments (id, tenant_id, child, homework_ref, data, status, created_at) values (?,?,?,?,?,?,?)', id, this.tenant, j.child, j.homework_ref, JSON.stringify({ ...j, id }), '草稿', now);
    return id;
  }
  private judgmentRow = (r: { id: string; child: string; homework_ref: string; status: '草稿' | '已确认'; created_at: string; confirmed_at: string | null; data: string; card: string | null; card_used: number }): JudgmentRow =>
    ({ id: r.id, child: r.child, homework_ref: r.homework_ref, status: r.status, created_at: r.created_at, confirmed_at: r.confirmed_at, judgment: JSON.parse(r.data), card: r.card ? JSON.parse(r.card) : null, card_used: r.card_used });
  judgment(id: string) {
    const r = this.get<Parameters<Store['judgmentRow']>[0]>('select id, child, homework_ref, status, created_at, confirmed_at, data, card, card_used from judgments where tenant_id=? and id=?', this.tenant, id);
    return r ? this.judgmentRow(r) : undefined;
  }
  judgments(child?: string): JudgmentRow[] {
    return this.all<Parameters<Store['judgmentRow']>[0]>(`select id, child, homework_ref, status, created_at, confirmed_at, data, card, card_used from judgments where tenant_id=? ${child ? 'and child=?' : ''} order by id`, ...(child ? [this.tenant, child] : [this.tenant])).map(this.judgmentRow);
  }
  /** Replace a draft (the Skill may resubmit until the parent confirms). */
  replaceJudgment(id: string, j: LearningJudgment) { this.run("update judgments set data=? where tenant_id=? and id=? and status='草稿'", JSON.stringify({ ...j, id }), this.tenant, id); }
  confirmJudgment(id: string, now: string) { this.run("update judgments set status='已确认', confirmed_at=? where tenant_id=? and id=?", now, this.tenant, id); }
  setCard(id: string, card: ParentCard) { this.run('update judgments set card=? where tenant_id=? and id=?', JSON.stringify(card), this.tenant, id); }
  setCardUsed(id: string, used: boolean) { this.run('update judgments set card_used=? where tenant_id=? and id=?', used ? 1 : 0, this.tenant, id); }

  // reteach tickets
  addTicket(t: Omit<ReteachTicket, 'id' | 'created_at' | 'lesson_ref' | 'mechanism'>, now: string): ReteachTicket {
    const id = this.nextId('tickets', 'RT');
    this.run('insert into tickets (id, tenant_id, child, concept_id, judgment_ref, attempt, status, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)', id, this.tenant, t.child, t.concept_id, t.judgment_ref, t.attempt, t.status, now, now);
    return this.tickets().find(x => x.id === id)!;
  }
  tickets(child?: string): ReteachTicket[] {
    return this.all<ReteachTicket>(`select id, child, concept_id, judgment_ref, attempt, status, lesson_ref, mechanism, created_at from tickets where tenant_id=? ${child ? 'and child=?' : ''} order by id`, ...(child ? [this.tenant, child] : [this.tenant]));
  }
  updateTicket(id: string, f: { status: ReteachTicket['status']; lesson_ref?: string; mechanism?: string }, now: string) {
    this.run('update tickets set status=?, lesson_ref=coalesce(?, lesson_ref), mechanism=coalesce(?, mechanism), updated_at=? where tenant_id=? and id=?', f.status, f.lesson_ref ?? null, f.mechanism ?? null, now, this.tenant, id);
  }

  // feedback kept by source (BL08)
  addFeedback(f: Omit<FeedbackItem, 'id' | 'created_at'>, now: string): FeedbackItem {
    const id = this.nextId('feedback', 'FB');
    this.run('insert into feedback (id, tenant_id, child, source, said, context, kind, ref, created_at) values (?,?,?,?,?,?,?,?,?)', id, this.tenant, f.child, f.source, f.said, f.context, f.kind, f.ref, now);
    return { ...f, id, created_at: now };
  }
  feedback(child?: string): FeedbackItem[] {
    return this.all<FeedbackItem>(`select id, child, source, said, context, kind, ref, created_at from feedback where tenant_id=? ${child ? 'and child=?' : ''} order by id`, ...(child ? [this.tenant, child] : [this.tenant]));
  }

  // real photos, videos and scans of organisms (BL14), shown until a photoreal model is in the component
  addMedia(m: Omit<MediaRow, 'id' | 'created_at'>, now: string): MediaRow {
    const id = this.nextId('media', 'MD');
    this.run('insert into media (id, tenant_id, asset_id, kind, mime, file, key, credit, license, source_url, caption, length_cm, added_by, created_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, this.tenant, m.asset_id, m.kind, m.mime, m.file, m.key, m.credit, m.license, m.source_url, m.caption, m.length_cm, m.added_by, now);
    return this.media(id)!;
  }
  media(id: string) { return this.get<MediaRow>('select * from media where tenant_id=? and id=?', this.tenant, id); }
  mediaFor(asset?: string) { return this.all<MediaRow>(`select * from media where tenant_id=? ${asset ? 'and asset_id=?' : ''} order by id`, ...(asset ? [this.tenant, asset] : [this.tenant])); }
  deleteMedia(id: string) { this.run('delete from media where tenant_id=? and id=?', this.tenant, id); }

  /** BL11: everything stored about one child, and deleting it. Lessons and schedule for the child stay unless asked. */
  exportChild(child: string) {
    const sessions = this.sessions(child);
    return {
      child: this.children().find(c => c.id === child), interests: this.interests(child),
      sessions: sessions.map(s => ({ ...s, events: this.events(s.key) })),
      homework: this.homeworks(child).map(h => ({ ...h, items: this.items(h.id) })),
      judgments: this.judgments(child), tickets: this.tickets(child), feedback: this.feedback(child),
      schedule: this.all('select date, lesson_key from schedule where tenant_id=? and child=?', this.tenant, child),
      grants: this.all('select lesson_key, expires_on, granted_by, created_at from grants where tenant_id=? and child=?', this.tenant, child),
    };
  }
  deleteChildData(child: string): string[] {
    const hw = this.homeworks(child).map(h => h.id);
    this.tx(() => {
      for (const s of this.sessions(child)) this.run('delete from events where tenant_id=? and session_key=?', this.tenant, s.key);
      for (const id of hw) this.run('delete from hw_items where homework_id=?', id);
      for (const t of ['sessions', 'interests', 'homework', 'judgments', 'tickets', 'feedback', 'schedule', 'grants']) this.run(`delete from ${t} where tenant_id=? and child=?`, this.tenant, child);
    });
    return hw;
  }

  // lessons waiting for the parent's review (stage 6 in the parent app)
  upsertDraft(sp: LessonSpec, by: string, now: string) {
    const key = `${sp.lesson_id}@${sp.version}`;
    this.run(`insert into drafts (key, tenant_id, for_child, title, spec, status, note, submitted_by, submitted_at) values (?,?,?,?,?,'待审核',null,?,?)
      on conflict(tenant_id, key) do update set for_child=excluded.for_child, title=excluded.title, spec=excluded.spec, status='待审核', note=null, submitted_by=excluded.submitted_by, submitted_at=excluded.submitted_at`,
      key, this.tenant, sp.for_child, sp.title, JSON.stringify(sp), by, now);
    return key;
  }
  drafts() {
    return this.all<{ key: string; for_child: string; title: string; status: '待审核' | '已退回'; note: string | null; submitted_by: string; submitted_at: string }>(
      'select key, for_child, title, status, note, submitted_by, submitted_at from drafts where tenant_id=? order by submitted_at', this.tenant);
  }
  draft(key: string): LessonSpec | undefined {
    const r = this.get<{ spec: string }>('select spec from drafts where tenant_id=? and key=?', this.tenant, key);
    return r ? JSON.parse(r.spec) : undefined;
  }
  rejectDraft(key: string, note: string) { this.run("update drafts set status='已退回', note=? where tenant_id=? and key=?", note, this.tenant, key); }
  deleteDraft(key: string) { this.run('delete from drafts where tenant_id=? and key=?', this.tenant, key); }
}
