import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const load = (name: string) => JSON.parse(readFileSync(join(here, '..', 'schemas', name), 'utf8'));

export const lessonSpecSchema = load('lessonspec.schema.json');
export const assetSchema = load('asset.schema.json');
export const interestSchema = load('interest.schema.json');
export const recognitionSchema = load('recognition.schema.json');
export const judgmentSchema = load('judgment.schema.json');

export type Realism = 'scan' | 'photo' | 'ai_from_photo' | 'pbr_measured' | 'pbr' | 'stylized';
export type AssetKind = 'organism' | 'object' | 'texture' | 'hdri' | 'photo';

export interface AssetRef {
  asset_id: string; kind: AssetKind; realism: Realism; ver: string; license: string;
  commercial_ok: boolean; source: string; depiction: string;
  reference_photos?: string[]; checked_by?: string | null;
}
export interface PendingAsset {
  asset_id: string; kind: AssetKind; realism_required: Exclude<Realism, 'stylized'>; status: string; until_ready: string;
}
export interface AssetEntry {
  asset_id: string; name?: string; kind: AssetKind; realism: Realism; version: string;
  file?: { path: string; sha256: string } | null; source: string; license: string; commercial_ok: boolean;
  real_scale?: string; depiction: string; reference_photos?: string[]; checked_by?: string | null;
  status: '采用' | '采用标记' | '拒绝' | '待采购'; note?: string;
}
export interface InterestObservation {
  id: string; tenant_id: string; child: string; topic: string;
  source: '孩子自述' | '家长报告' | '老师反馈'; said?: string | null; observed_on: string;
  /** 家长指定: the parent named this topic for the next lesson; it comes before everything else. */
  state: '家长指定' | '近期最喜欢' | '喜欢' | '曾经喜欢' | '下一课心愿' | '只用于安全工程题材'; lesson_ref?: string | null;
}
export interface Hotspot {
  id: string; label: string; anchor: string; teaches: string | null;
  facts?: { text: string; ref: string }[];
  language_pack: { zh: string; en: (string | null)[] };
}
export interface ActivityNode {
  id: string; type: 'explain' | 'demo' | 'contrast' | 'predict' | 'transfer' | 'chat';
  teaches: string | null; action?: string; prompt?: string; hints?: string[]; items?: string[];
  no_theme?: boolean; complete: string;
}
export interface Challenge {
  id: string; prompt: string; with_theme: boolean; hints: string[]; options?: string[];
  answers: { field: string; label?: string; value: number | string; unit?: string }[];
  /** Shown step by step (subtitle + voice) after the child misses the question 3 times; the last step gives the answer. */
  worked_example?: { steps: string[] };
  /** A similar question the child then does alone: same method, new numbers or setting. */
  twin?: { prompt: string; answers: Challenge['answers']; options?: string[] };
}
export interface ExperimentModel {
  id: string; ver: string; deterministic: true;
  vars: Record<string, { unit: string; min: number; max: number; step: number }>;
  outputs: Record<string, { expr: string; unit: string }>;
  reference_cases: { in: Record<string, number>; out?: Record<string, number>; expect?: 'reject_out_of_range' }[];
}
export interface ReviewRecord { category: '科学' | '教研' | '语言' | '安全'; reviewer: string; checked: string[]; at: string }
export interface LessonSpec {
  schema_version: 'lessonspec/1.0'; lesson_id: string; version: string; tenant_id: string; for_child: string; title: string;
  previous_version?: string | null; trigger_judgment_ref?: string | null;
  primary_concept: { id: string; name: string; target_misconceptions: string[] };
  prerequisites?: string[];
  curriculum_mapping: {
    region: string; system: string; grade: number; term?: string; source: string; publisher?: string; unit?: string;
    status: '参考·待核对' | '先修补强' | '已核对本年级' | '兴趣拓展'; verified_by?: string | null; checked_on?: string;
  };
  theme: {
    id: string; name: string; skin?: string; interest_refs: string[]; neutral?: boolean; why: string; no_husbandry: true;
    /** What the theme is about and must be seen in the lesson (an animal, a robot…), not only named in the text. */
    subject?: { name: string; asset_id: string; kind: 'organism' | 'object' };
  };
  intro: { headline: string; paragraphs: string[]; note?: string };
  learner_profile: { grade: number; scaffold?: string[]; language: { default: 'zh'; cycle_enabled: boolean }; recent_judgment_ref?: string | null; est_minutes?: [number, number] };
  scene_component_ids: string[];
  component_params: Record<string, unknown>;
  experiment_model_version: ExperimentModel;
  activity_graph: ActivityNode[];
  hotspots: Hotspot[];
  challenges: Challenge[];
  end_chat: { skippable: true; questions: { id: string; kind: 'reflection' | 'next_lesson_wish'; prompt: string; options: string[]; allow_own_words?: boolean }[] };
  object_asset_versions: AssetRef[];
  pending_assets?: PendingAsset[];
  /** Seconds per step; when one runs out the lesson moves on (the last step ends the lesson). */
  timing?: { steps?: Partial<Record<'explain' | 'demo' | 'challenge' | 'chat', number>> };
  /** Reasons to keep going after a wrong answer, tied to the lesson's theme. */
  encouragement?: { persist: string[] };
  assessment_plan: { in_lesson: string[]; followup: string; states?: string[] };
  offscreen?: { task: string; adult: boolean; materials?: string[]; optional: true };
  parent_tip: string;
  source_refs: { id: string; for: string; url?: string }[];
  distribution: { scope: 'family' | 'commercial'; tenant_id: string };
  review_records?: ReviewRecord[];
  content_hash?: string; published_at?: string;
}

export interface ComponentDef {
  versions: string[]; status: string; teaches: string[]; themes: string[];
  hotspotAnchors: string[]; actions: string[]; paramsSchema: object;
}
export interface ChildProfile {
  name: string; grade: number; system: string; region: string;
  wish_prompt: string; wish_options_from_interests: boolean; wish_fallback_options: string[];
}
export interface ThemeTable {
  skins: Record<string, { name: string; component: string; status: '已有' | '待开发' }>;
  topics: Record<string, string[]>;
  neutral: Record<string, string>;
}

// ---- homework and judgment (M4) ----
export type TeacherMark = '对' | '错' | '半对' | '未批';
export type MasteryState = '未观察' | '待确认' | '有独立应用证据' | '需再支持';
export interface RecognitionItem {
  no: string; photo: string; prompt: string; child_answer: string; teacher_mark: TeacherMark;
  teacher_note?: string | null; confidence: number; concept_id?: string | null; observation?: string | null;
}
export interface Recognition { homework_ref: string; recognized_by?: string; items: RecognitionItem[] }
/** A recognition item after the parent's check: corrections keep the recognised values in `original`. */
export interface CheckedItem extends RecognitionItem { confirmed: boolean; needs_check: boolean; original?: Partial<RecognitionItem> | null }
export interface HomeworkUpload {
  id: string; child: string; date: string; note: string | null;
  photos: { id: string; mime: string; sha256: string }[];
  status: '待识别' | '待核对' | '已核对' | '已判断'; created_at: string;
  /** The parent agreed that an outside AI (Claude) may read these photos (BL11). */
  ai_consent: boolean;
}
export interface ParentCard { facts: string; child_share: string; unverified: string; talk: string }
export interface LearningJudgment {
  id?: string; homework_ref: string; child: string;
  facts: { text: string; items: string[] }[];
  gaps: { concept_id: string; misconception?: string | null; text: string; confidence: number; verify_by: string; items: string[] }[];
  unknowns: string[];
  next: { kind: '重教' | '巩固' | '新课' | '观察'; concept_id?: string | null; text: string }[];
  mastery: { concept_id: string; state: MasteryState; evidence: string[] }[];
  corrects?: { judgment_id: string; gap: number; note: string }[];
  parent_card: ParentCard;
}
export interface ReteachTicket {
  id: string; child: string; concept_id: string; judgment_ref: string; attempt: number;
  status: '需求登记' | '已发布' | '已验证' | '未见效'; lesson_ref: string | null; mechanism: string | null; created_at: string;
}
/** One reteach attempt for V15: which mechanism was used and whether it helped. */
export interface ReteachHistory { concept_id: string; child: string; mechanism: string; outcome: '已验证' | '未见效' | '待验证' }
export interface FeedbackItem {
  id: string; child: string; source: '孩子' | '家长' | '老师' | '作业' | '系统'; said: string;
  context: string | null; kind: '事实' | '解释' | '推测'; ref: string | null; created_at: string;
}
