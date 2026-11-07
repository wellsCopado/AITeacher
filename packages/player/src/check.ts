import type { Challenge } from '../../schema/src/index.js';

export interface Attempt { [field: string]: { value: string; unit?: string } }
export interface FieldResult { field: string; label: string; valueOk: boolean; unitOk: boolean }
export interface CheckResult { correct: boolean; fields: FieldResult[] }

/** Compare a child's attempt with the challenge answers. Values and units are judged separately. */
export function checkAttempt(ch: Challenge, attempt: Attempt): CheckResult {
  const fields = ch.answers.map(a => {
    const got = attempt[a.field];
    const raw = (got?.value ?? '').trim();
    const valueOk = typeof a.value === 'number' ? raw !== '' && Number(raw) === a.value : raw === a.value;
    const unitOk = !a.unit || got?.unit === a.unit;
    return { field: a.field, label: a.label ?? a.field, valueOk, unitOk };
  });
  return { correct: fields.every(f => f.valueOk && f.unitOk), fields };
}

/** A factual sentence about what was right and what to look at again; no praise words, no scores. */
export function describe(r: CheckResult, redo = '再算一算'): string {
  if (r.correct) return '数和单位都对上了。';
  const parts: string[] = [];
  const wrongVal = r.fields.filter(f => !f.valueOk).map(f => f.label);
  const wrongUnit = r.fields.filter(f => f.valueOk && !f.unitOk).map(f => f.label);
  if (wrongVal.length) parts.push(`${wrongVal.join('、')}${redo === '再算一算' ? '的数' : ''}${redo}`);
  if (wrongUnit.length) parts.push(`${wrongUnit.join('、')}的数对了，单位再看一看`);
  return parts.join('；') + '。';
}
