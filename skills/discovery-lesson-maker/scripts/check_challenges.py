#!/usr/bin/env python3
"""按补充材料预检task/answers题目；不取代宿主原生Schema或运行验收。"""
import argparse
import itertools
import json
import math
from pathlib import Path
import sys


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def within(value, spec):
    if not number(value) or not spec['min'] <= value <= spec['max']:
        return False
    step = spec.get('step', 1)
    return number(step) and step > 0 and abs((value - spec['min']) / step - round(
        (value - spec['min']) / step)) < 1e-8


def expression(node, state):
    if number(node):
        return node
    if isinstance(node, dict) and set(node) == {'param'}:
        value = state[node['param']]
        if not number(value):
            raise ValueError('表达式参数不是有限数值')
        return value
    if not isinstance(node, dict) or set(node) != {'op', 'args'}:
        raise ValueError('未知数学表达式；不能运行代码或eval')
    values = [expression(n, state) for n in node['args']]
    if len(values) < 2:
        raise ValueError('运算至少两个参数')
    if node['op'] == 'add':
        return sum(values)
    if node['op'] == 'mul':
        return math.prod(values)
    if node['op'] == 'sub' and len(values) == 2:
        return values[0] - values[1]
    raise ValueError('只支持add/mul/sub审计表达式')


def satisfies(rules, state):
    if not isinstance(rules, list) or not rules:
        raise ValueError('数学判题审计必须有条件')
    outcomes = []
    for rule in rules:
        left, right = expression(rule['left'], state), expression(rule['right'], state)
        op = rule['op']
        if op == 'eq':
            outcomes.append(abs(left - right) <= rule.get('tolerance', 1e-8))
        elif op == 'gt':
            outcomes.append(left > right)
        elif op == 'gte':
            outcomes.append(left >= right)
        elif op == 'lt':
            outcomes.append(left < right)
        elif op == 'lte':
            outcomes.append(left <= right)
        else:
            raise ValueError('未知比较运算')
    return all(outcomes)


def at_pointer(document, pointer):
    if not pointer.startswith('/'):
        raise ValueError('pointer必须是JSON Pointer，例如/challenges')
    value = document
    for key in pointer[1:].split('/'):
        key = key.replace('~1', '/').replace('~0', '~')
        value = value[int(key)] if isinstance(value, list) else value[key]
    return value


def validate(document, capabilities, audit=None, pointer='/challenges'):
    errors, warnings, findings = [], [], []
    try:
        if not isinstance(document, dict) or not isinstance(capabilities, dict):
            raise ValueError('课程和能力输入必须是JSON对象')
        questions = at_pointer(document, pointer)
        if not isinstance(questions, list) or not questions:
            raise ValueError('题目数组为空或不存在')
        params = capabilities.get('params', {})
        hands_on = capabilities.get('handsOn', {})
        if not isinstance(params, dict) or not isinstance(hands_on, dict) or any(
                not isinstance(spec, dict) for spec in hands_on.values()):
            raise ValueError('params/handsOn必须是有效能力对象')
        for name, spec in params.items():
            if not (number(spec['min']) and number(spec['max']) and spec['min'] <= spec['max']
                    and number(spec.get('step', 1)) and spec.get('step', 1) > 0):
                raise ValueError(f'能力参数{name}范围无效')
    except (ValueError, KeyError, TypeError) as exc:
        return {'errors': [str(exc)], 'warnings': [], 'findings': []}
    if capabilities.get('evidence', {}).get('runtimeVerified') is not True:
        warnings.append('能力来自文档/未运行验证；预检通过不代表组件存在或动作可用')
    question_ids = set()
    counts = {'choice': 0, 'task': 0, 'number': 0, 'transfer': 0}

    def check(q, label, twin=False):
        if not isinstance(q, dict):
            errors.append(f'{label}不是题目对象')
            return
        if 'kind' in q or 'answer' in q:
            errors.append(f'{label}混用了旧ZIP的kind/answer格式；请先按宿主Schema迁移')
        if not isinstance(q.get('prompt'), str) or not q['prompt'].strip():
            errors.append(f'{label}缺少题目')
        options, task, answers = q.get('options'), q.get('task'), q.get('answers')
        if not isinstance(answers, list) or not answers:
            errors.append(f'{label}缺少answers数组')
            answers = []
        kind = 'task' if task is not None else 'choice' if options is not None else 'number'
        if not twin:
            counts[kind] += 1
            counts['transfer'] += q.get('with_theme') is False
        if kind == 'choice':
            if not isinstance(options, list) or not 2 <= len(options) <= 4:
                errors.append(f'{label}选择题需2–4个选项')
                options = []
            texts = [o if isinstance(o, str) else o.get('text') if isinstance(o, dict) else None for o in options]
            if capabilities.get('profile') == 'family-app-math':
                if any(not isinstance(o, str) for o in options):
                    errors.append(f'{label}宿主options仅接受字符串，误区说明应写制作审计而非添加why')
                if any(not isinstance(a, dict) or not isinstance(a.get('field'), str) for a in answers):
                    errors.append(f'{label}宿主answers必须是field/value对象数组')
            if any(not isinstance(text, str) or not text for text in texts):
                errors.append(f'{label}选项必须是非空文字或含text的对象')
                texts = [text for text in texts if isinstance(text, str)]
            answer = answers[0] if len(answers) == 1 else None
            answer = answer.get('value') if isinstance(answer, dict) else answer
            if not isinstance(answer, str) or answer not in texts:
                errors.append(f'{label}正确答案必须唯一且与选项文字一致')
            if len(texts) != len(set(texts)):
                errors.append(f'{label}选项重复')
            if any(isinstance(text, str) and ('以上都' in text) for text in texts):
                errors.append(f'{label}不能用以上都对/都不对凑选项')
            if any(isinstance(o, dict) and o.get('text') != answer and not o.get('why') for o in options):
                warnings.append(f'{label}错误选项缺少误区说明；纯字符串选项的诊断需在宿主支持字段/制作审计中记录')
        elif kind == 'task':
            if not isinstance(task, dict):
                errors.append(f'{label}task必须是对象')
                return
            task_type = task.get('type')
            if not isinstance(task_type, str) or task_type not in hands_on:
                errors.append(f'{label}操作类型{task_type}没有宿主能力声明，不能假装支持')
                return
            allowed = set(hands_on[task_type].get('controls', []))
            controls, start = task.get('controls', []), task.get('start', {})
            if not isinstance(controls, list) or not controls or any(not isinstance(c, str) for c in controls) or len(controls) != len(set(controls)):
                errors.append(f'{label}controls为空或重复')
                controls = []
            if not isinstance(start, dict) or set(start) != set(params):
                errors.append(f'{label}start必须写全组件参数')
                start = start if isinstance(start, dict) else {}
            for name, value in start.items():
                if name not in params or not within(value, params[name]):
                    errors.append(f'{label}初始参数{name}越界、非数值或不符步长')
            if any(name not in allowed or name not in params for name in controls):
                errors.append(f'{label}controls超出宿主可修改参数')
            fields = [a.get('field') for a in answers if isinstance(a, dict)]
            if any(not isinstance(f, str) for f in fields) or len(fields) != len(answers) or len(set(fields)) != len(fields) or set(fields) != set(controls):
                errors.append(f'{label}answers必须与controls一一对应')
            for answer in answers:
                if not isinstance(answer, dict):
                    continue
                name = answer.get('field')
                if name not in params or not within(answer.get('value'), params[name]):
                    errors.append(f'{label}答案参数{name}越界或不符步长')
                elif answer.get('unit') != params[name].get('unit'):
                    errors.append(f'{label}答案参数{name}单位与场景不一致')
            if answers and all(isinstance(a, dict) and start.get(a.get('field')) == a.get('value') for a in answers):
                errors.append(f'{label}初始场景已经是答案，不需要操作')
            if options is not None or q.get('picture') is not None:
                errors.append(f'{label}操作题不写options或预摆答案的picture')
            if q.get('seconds') is not None and (not number(q['seconds']) or q['seconds'] < 60):
                errors.append(f'{label}此宿主操作题规则要求至少60秒；不等于超时可以代答')
        else:
            warnings.append(f'{label}为填空；请确认确有必要且宿主答案结构已经校验')
        if kind != 'task':
            picture = q.get('picture')
            if not isinstance(picture, dict) or not picture:
                errors.append(f'{label}缺少可对应题意的场景配图/视角')
            else:
                for name, value in picture.get('params', {}).items():
                    if name not in params or not within(value, params[name]):
                        errors.append(f'{label}配图参数{name}越界或不存在')
                if picture.get('view') and picture['view'] not in capabilities.get('views', []):
                    errors.append(f'{label}配图视角没有宿主声明')
        if not twin:
            worked = q.get('worked_example', {})
            if not isinstance(worked, dict) or not worked.get('steps'):
                errors.append(f'{label}缺少宿主格式的worked_example.steps')
            if not isinstance(q.get('twin'), dict) or not q['twin']:
                errors.append(f'{label}缺少独立再验证的同类题twin')
            else:
                if q['twin'].get('prompt') == q.get('prompt'):
                    errors.append(f'{label}同类题复制了原题，不能证明迁移')
                check(q['twin'], label + '的同类题', True)
        findings.append({'question': label, 'type': kind, 'semanticReview': '数字/误区/泄题/应用性尚需审查'})

    for index, q in enumerate(questions):
        key = q.get('id') if isinstance(q, dict) and isinstance(q.get('id'), str) else None
        if not key or key in question_ids:
            errors.append('题目id缺失或重复')
        question_ids.add(key)
        check(q, str(key or index))
    if capabilities.get('profile') == 'family-app-math':
        if not 2 <= len(questions) <= 3 or counts['choice'] < 1 or counts['number'] > 1 or not counts['transfer']:
            errors.append('该宿主配置要求2–3题、至少1选择、最多1填空及独立迁移题')
        if hands_on and not counts['task']:
            errors.append('该宿主已有操作能力，本课缺少操作题')
    audit = audit or {}
    if not isinstance(audit, dict):
        errors.append('audit必须是对象')
        audit = {}
    for proof in audit.get('buildConstraints', []):
        try:
            q = next(q for q in questions if q['id'] == proof['questionId'])
            if proof.get('variant') == 'twin':
                q = {**q['twin'], 'id': q['id'] + '::twin'}
            task, rules = q['task'], proof['constraints']
            control_names = task['controls']
            ranges = []
            for name in control_names:
                p = params[name]
                count = math.floor((p['max'] - p['min']) / p.get('step', 1) + 1e-9) + 1
                if count > 1000:
                    raise ValueError('审计搜索范围过大，请用目标领域求解器')
                ranges.append([p['min'] + i * p.get('step', 1) for i in range(count)])
            if math.prod(map(len, ranges)) > 100000:
                raise ValueError('审计组合超过10万，不盲目穷举')
            solutions = []
            for values in itertools.product(*ranges):
                state = {**task['start'], **dict(zip(control_names, values))}
                if satisfies(rules, state):
                    solutions.append(state)
            answer = {**task['start'], **{a['field']: a['value'] for a in q['answers']}}
            if not satisfies(rules, answer):
                errors.append(f"{q['id']}标注答案不满足审计中的数学条件")
            if proof.get('hostRequiresUnique') and len(solutions) != 1:
                errors.append(f"{q['id']}宿主仅比较一组答案，但条件有{len(solutions)}个解；补充分辨条件或实现多解判定")
            findings.append({'question': q['id'], 'constraintSolutions': solutions})
        except (ValueError, KeyError, TypeError, StopIteration) as exc:
            errors.append('数学判题审计：' + str(exc))
    return {'errors': errors, 'warnings': warnings, 'counts': counts, 'findings': findings,
            'meaning': '仅材料所述格式/约束预检，不是App原生校验、交互或教学效果验收'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('lesson', type=Path)
    parser.add_argument('--capabilities', required=True, type=Path)
    parser.add_argument('--audit', type=Path)
    parser.add_argument('--pointer', default='/challenges')
    args = parser.parse_args()
    try:
        read = lambda path: json.loads(path.read_text(encoding='utf-8'))
        result = validate(read(args.lesson), read(args.capabilities), read(args.audit) if args.audit else None, args.pointer)
    except (ValueError, OSError, TypeError) as exc:
        result = {'errors': [str(exc)], 'warnings': []}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(bool(result['errors']))


if __name__ == '__main__':
    main()
