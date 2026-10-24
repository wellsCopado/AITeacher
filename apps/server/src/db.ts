// SQLite storage for the family server. Every row carries tenant_id so a commercial build can isolate tenants.
import { DatabaseSync } from 'node:sqlite';
import type { InterestObservation, LessonSpec } from '../../../packages/schema/src/index.js';

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
`;

export type Role = 'parent' | 'device';
export interface SessionRow { key: string; child: string; lesson_key: string; started_on: string; updated_at: string; finished: number }
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
}
