// 下一课准备单 (pipeline P0): whenever a child says what they want to learn next, it is written down at once, turned
// into the next lesson's topic, queued oldest first and prepared ahead; the next lesson follows the first one.
// The child's own words stay on this server: lesson writers and outside services only ever see the topic.
import { join } from 'node:path';
import type { AssetEntry, ChildProfile, InterestObservation, LessonSpec } from '../../../packages/schema/src/index.js';
import { loadThemes, readJson, topicPlan, wishTopic } from '../../../packages/cli/src/lib.js';
import type { PrepRow, Store } from './db.js';
import { fail } from './http.js';

/** 2026-10-25 → 10月25日; 2026-10 → 10月. */
export const dateText = (d: string) => `${Number(d.slice(5, 7))}月${d.length > 7 ? `${Number(d.slice(8, 10))}日` : ''}`;

export function wishBook(d: { store: Store; root: string; iso: () => string }) {
  const { store, root, iso } = d;
  const profiles = () => readJson<Record<string, ChildProfile>>(join(root, 'content', 'children.json'));
  const subjectOf = (topic: string) => topicPlan(topic, loadThemes(root)).subject;
  const isOpen = (p: PrepRow) => p.status === '准备中';
  const hidden = () => new Set(store.preps().filter(p => p.status === '等你确认主题').map(p => p.interest_id));
  /** Topics the words of a wish can name: themes, the child's answer options and interests, the registry's animals. */
  const known = (child: string) => {
    const no = hidden();
    const animals = readJson<AssetEntry[]>(join(root, 'content', 'assets', 'registry.json')).filter(a => a.kind === 'organism' && a.name).map(a => a.name!);
    return [...Object.keys(loadThemes(root).topics), ...(profiles()[child]?.wish_fallback_options ?? []), ...store.interests(child).filter(x => !no.has(x.id)).map(x => x.topic), ...animals];
  };
  /** This child's prep lists waiting for their lesson, oldest first. */
  const queue = (child: string) => store.preps(child).filter(isOpen);

  /**
   * Write a wish down (call it inside the caller's transaction). A wish for a topic already queued joins that
   * prep list instead of queueing twice. `topic` is given when the parent typed it.
   */
  function record(w: { child: string; said: string; on: string; lesson_from: string | null; source: InterestObservation['source']; topic?: string }) {
    const said = w.said.trim().slice(0, 40);
    const topic = w.topic?.trim().slice(0, 20) || wishTopic(said, known(w.child));
    const interest = store.addInterest({ child: w.child, topic: topic ?? said, source: w.source, said, observed_on: w.on.slice(0, 7), state: '下一课心愿', lesson_ref: w.lesson_from }, iso());
    const same = topic ? queue(w.child).find(p => p.topic === topic) : undefined;
    if (same) { store.logPrep(same.id, `${dateText(w.on)}又说了一次想学「${topic}」`, iso()); return { interest, prep: null }; }
    const prep = store.addPrep({ child: w.child, interest_id: interest.id, said, topic: topic ?? said, status: topic ? '准备中' : '等你确认主题', wished_on: w.on, lesson_from: w.lesson_from, subject: topic ? subjectOf(topic) : null }, iso());
    store.logPrep(prep.id, topic ? `记下了：下一课想学「${topic}」` : '记下了孩子的原话，还认不出是哪个主题：等你确认主题，确认前不会发给任何模型或服务', iso());
    return { interest, prep: store.prep(prep.id)! };
  }

  /** The parent says what the topic is (or changes it). Returns the prep list to get ready. */
  function setTopic(id: string, raw: string): PrepRow {
    const p = store.prep(id) ?? fail(404, '没有这张准备单');
    const topic = raw.trim().slice(0, 20);
    if (!topic) fail(400, '写一个主题，例如：螳螂虾、机械臂');
    if (p.status === '已安排' || p.status === '已跳过') fail(409, `这张准备单已经${p.status}`);
    store.setInterestTopic(p.interest_id, topic);
    const same = queue(p.child).find(x => x.id !== id && x.topic === topic);
    if (same) {
      store.updatePrep(id, { topic, status: '已跳过' }, iso());
      store.logPrep(id, `和排着的「${topic}」是同一个主题，合到那一张`, iso());
      store.logPrep(same.id, `${dateText(p.wished_on)}也说过想学「${topic}」`, iso());
      return store.prep(same.id)!;
    }
    store.updatePrep(id, { topic, status: '准备中', subject: subjectOf(topic) }, iso());
    store.logPrep(id, `主题定为「${topic}」`, iso());
    return store.prep(id)!;
  }

  function skip(id: string) {
    const p = store.prep(id) ?? fail(404, '没有这张准备单');
    if (p.status === '已安排') fail(409, '这张准备单已经安排了课');
    store.updatePrep(id, { status: '已跳过' }, iso());
    store.wishDone(p.child, p.topic);
    store.logPrep(id, '你跳过了这个心愿（它还留在兴趣里）', iso());
  }

  /**
   * The interests lesson writing sees: only the first queued wish (or the one the parent picked) counts as the
   * next-lesson wish, later ones wait their turn as ordinary interests, and words with no topic yet are left out.
   */
  function interestsFor(child: string, pick?: string) {
    const no = hidden();
    const first = (pick ? queue(child).find(p => p.id === pick) : undefined) ?? queue(child)[0];
    return store.interests().filter(x => !no.has(x.id)).map(x => (x.child === child && x.state === '下一课心愿' && x.topic !== first?.topic ? { ...x, state: '喜欢' as const } : x));
  }
  /** The prep list a lesson for this child follows now. */
  const head = (child: string, pick?: string) => (pick ? queue(child).find(p => p.id === pick) : undefined) ?? queue(child)[0];

  /** A lesson was handed in: the wishes it follows are 已安排, and parent_tip says whose wish it was (the topic, never the words). */
  function follow(spec: LessonSpec, key: string): PrepRow[] {
    const refs = new Set(spec.theme.interest_refs);
    const topics = new Set(store.interests(spec.for_child).filter(x => refs.has(x.id)).map(x => x.topic));
    const used = queue(spec.for_child).filter(p => topics.has(p.topic));
    const label = profiles()[spec.for_child]?.name ?? spec.for_child;
    for (const p of used) {
      if (!spec.parent_tip.includes(`心愿「${p.topic}」`)) spec.parent_tip = `${spec.parent_tip.trim()}${spec.parent_tip.trim() ? ' ' : ''}按${label}${dateText(p.wished_on)}的心愿「${p.topic}」准备。`;
      store.updatePrep(p.id, { status: '已安排', lesson_ref: key }, iso());
      store.logPrep(p.id, `按它写好了「${spec.title}」，在课程库等你审核`, iso());
      store.wishDone(spec.for_child, p.topic);
    }
    return used;
  }

  /** The parent didn't take the lesson written for these wishes: they go back in the queue, in their old place. */
  function unfollow(key: string, title: string): PrepRow[] {
    const back = store.preps().filter(p => p.status === '已安排' && p.lesson_ref === key);
    for (const p of back) {
      store.updatePrep(p.id, { status: '准备中', lesson_ref: null }, iso());
      store.wishAgain(p.interest_id);
      store.logPrep(p.id, `你没采用「${title}」，这个心愿回到排队里，下一节课还按它准备`, iso());
    }
    return back;
  }

  /** Wishes written down before prep lists existed get one, so they keep their place in the queue. */
  function migrate() {
    store.tx(() => {
      for (const x of store.interests().filter(i => i.state === '下一课心愿')) {
        const preps = store.preps(x.child);
        if (preps.some(p => p.interest_id === x.id || (isOpen(p) && p.topic === x.topic))) continue;
        store.addPrep({ child: x.child, interest_id: x.id, said: x.said ?? null, topic: x.topic, status: '准备中', wished_on: x.observed_on, lesson_from: x.lesson_ref ?? null, subject: subjectOf(x.topic) }, iso());
      }
    });
  }

  return { record, setTopic, skip, queue, head, interestsFor, follow, unfollow, migrate, label: (child: string) => profiles()[child]?.name ?? child };
}
export type WishBook = ReturnType<typeof wishBook>;
