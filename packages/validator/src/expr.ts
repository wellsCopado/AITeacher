// Safe arithmetic for experiment-model formulas: numbers, variables, + - * /, parentheses.
// Anything else is rejected, so a LessonSpec can never smuggle code through a formula (V02, V06).

type Tok = { t: 'num'; v: number } | { t: 'var'; v: string } | { t: 'op'; v: string } | { t: 'lp' } | { t: 'rp' };

export class ExprError extends Error {}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ') { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i; while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const v = Number(src.slice(i, j));
      if (!Number.isFinite(v)) throw new ExprError(`不是合法数字：${src.slice(i, j)}`);
      out.push({ t: 'num', v }); i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i; while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ t: 'var', v: src.slice(i, j) }); i = j; continue;
    }
    if ('+-*/'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    if (c === '(') { out.push({ t: 'lp' }); i++; continue; }
    if (c === ')') { out.push({ t: 'rp' }); i++; continue; }
    throw new ExprError(`公式里不允许的字符：「${c}」`);
  }
  return out;
}

/** Variables referenced by a formula. */
export function exprVars(src: string): string[] {
  return [...new Set(tokenize(src).filter((t): t is { t: 'var'; v: string } => t.t === 'var').map(t => t.v))];
}

/** Recursive-descent evaluation: expr := term (('+'|'-') term)*, term := factor (('*'|'/') factor)*. */
export function evalExpr(src: string, vars: Record<string, number>): number {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const factor = (): number => {
    const t = toks[p++];
    if (!t) throw new ExprError('公式不完整');
    if (t.t === 'num') return t.v;
    if (t.t === 'var') {
      if (!(t.v in vars)) throw new ExprError(`公式用了未定义的变量：${t.v}`);
      return vars[t.v];
    }
    if (t.t === 'op' && t.v === '-') return -factor();
    if (t.t === 'lp') { const v = expr(); if (toks[p++]?.t !== 'rp') throw new ExprError('括号没有闭合'); return v; }
    throw new ExprError('公式结构不对');
  };
  const term = (): number => {
    let v = factor();
    for (let t = peek(); t && t.t === 'op' && (t.v === '*' || t.v === '/'); t = peek()) {
      p++; const r = factor();
      if (t.v === '/' && r === 0) throw new ExprError('除以零');
      v = t.v === '*' ? v * r : v / r;
    }
    return v;
  };
  const expr = (): number => {
    let v = term();
    for (let t = peek(); t && t.t === 'op' && (t.v === '+' || t.v === '-'); t = peek()) {
      p++; const r = term(); v = t.v === '+' ? v + r : v - r;
    }
    return v;
  };
  const v = expr();
  if (p !== toks.length) throw new ExprError('公式末尾有多余内容');
  return v;
}
