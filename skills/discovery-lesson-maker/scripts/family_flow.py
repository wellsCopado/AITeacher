#!/usr/bin/env python3
"""家庭上课规则（adw-family/1）：lesson-flow.json 的检查和要录音的句子。规则见 references/family-profile.md。
check_package.py 和 make_family_audio.py 共用；只查结构、数量、句长和录音文件，不判断画面和教学好不好。"""
import json
import re
from pathlib import Path

FORMAT = 'adw-family/1'
PHRASES_FILE = Path(__file__).resolve().parents[1] / 'assets' / 'web' / 'adw-family-phrases.json'
KINDS = {'choice', 'application', 'hands_on', 'explain'}
INPUTS = {'drag', 'rotate', 'push', 'assemble', 'place', 'draw', 'pinch'}
LINE_MAX, CLAUSE_MAX = 40, 24
# 写给家长的知识边界和免责话，不放进孩子听的句子
ADULT_WORDS = ['示意', '近似', '不能推成', '教学算例', '未标定', '性能保证', '不代表', '仅供', '不能冒称', '待核对', '教学重建']
CJK = re.compile(r'[一-鿿]')


def line_file(lang, text):
    """和 adw-family.mjs 的 lineFile() 一致：FNV-1a 32 位。"""
    h = 0x811c9dc5
    for b in f'{lang}|{text}'.encode('utf-8'):
        h = ((h ^ b) * 0x01000193) & 0xffffffff
    return f'audio/family/{lang}-{h:08x}.m4a'


def phrases():
    return json.loads(PHRASES_FILE.read_text(encoding='utf-8'))


def _texts(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for v in value:
            yield from _texts(v)


def child_lines(flow):
    """孩子会看到、听到的每一句：(lang, text, 出处)。"""
    out = []
    add = lambda lang, text, where: isinstance(text, str) and text.strip() and out.append((lang, text.strip(), where))
    for step in flow.get('steps') or []:
        add('zh', step.get('title'), f'steps.{step.get("id")}.title')
    for nid, n in (flow.get('narration') or {}).items():
        add('zh', (n or {}).get('zh'), f'narration.{nid}.zh')
        for i, en in enumerate((n or {}).get('en') or []):
            add('en', en, f'narration.{nid}.en[{i}]')

    def ask(a, where):
        add('zh', a.get('ask'), f'{where}.ask')
        for key in ('good', 'look'):
            add('zh', a.get(key), f'{where}.{key}')
        for o in a.get('options') or []:
            for key in ('text', 'good', 'look'):
                add('zh', o.get(key), f'{where}.options.{o.get("id")}.{key}')

    for tid, t in (flow.get('tasks') or {}).items():
        t = t or {}
        ask(t, f'tasks.{tid}')
        for i, h in enumerate(t.get('hints') or []):
            add('zh', h, f'tasks.{tid}.hints[{i}]')
        for i, s in enumerate(t.get('worked_example') or []):
            add('zh', s, f'tasks.{tid}.worked_example[{i}]')
        if isinstance(t.get('twin'), dict):
            ask(t['twin'], f'tasks.{tid}.twin')
    for i, p in enumerate((flow.get('encouragement') or {}).get('persist') or []):
        add('zh', p, f'encouragement.persist[{i}]')
    return out


def all_lines(flow):
    """要录音的全部句子：课里的话和流程固定用语。"""
    fixed = [('zh', t, 'phrases') for t in _texts(list(phrases().values()))]
    seen, out = set(), []
    for lang, text, where in child_lines(flow) + fixed:
        if (lang, text) not in seen:
            seen.add((lang, text))
            out.append((lang, text, where))
    return out


def check_flow(flow, has_file=lambda rel: True):
    """返回 (errors, warnings)。has_file(rel) 判断网页目录里有没有这个文件。"""
    e, w = [], []
    if not isinstance(flow, dict) or flow.get('format') != FORMAT:
        return [f'lesson-flow.json 的 format 要写 {FORMAT}'], w
    steps, narration, tasks = flow.get('steps') or [], flow.get('narration') or {}, flow.get('tasks') or {}
    experiments = flow.get('experiments') or []
    if not 2 <= len(steps) <= 8:
        e.append(f'steps 要 2–8 步，现在 {len(steps)} 步')
    step_ids, owner = set(), {}
    for s in steps:
        sid = s.get('id')
        if not sid or sid in step_ids:
            e.append(f'步骤 id 缺少或重复：{sid!r}')
        step_ids.add(sid)
        sec = s.get('seconds')
        if not (isinstance(sec, (int, float)) and 30 <= sec <= 900):
            e.append(f'步骤 {sid} 的 seconds 要在 30–900 秒（每步都倒计时）：{sec!r}')
        if not s.get('title'):
            e.append(f'步骤 {sid} 没写 title')
        if not s.get('say'):
            e.append(f'步骤 {sid} 没有讲解点（say），孩子进这一步听不到引导')
        for nid in s.get('say') or []:
            if nid not in narration:
                e.append(f'步骤 {sid} 的讲解点 {nid} 没写在 narration 里')
        for tid in s.get('tasks') or []:
            if tid not in tasks:
                e.append(f'步骤 {sid} 的题 {tid} 没写在 tasks 里')
            elif tid in owner:
                e.append(f'题 {tid} 同时在步骤 {owner[tid]} 和 {sid} 里')
            owner[tid] = sid
    for nid, n in narration.items():
        n = n or {}
        if not str(n.get('zh', '')).strip():
            e.append(f'讲解点 {nid} 没有中文')
        en = [x for x in n.get('en') or [] if isinstance(x, str) and x.strip()]
        if len(en) != 3:
            e.append(f'讲解点 {nid} 要正好 3 句英文（一中三英），现在 {len(en)} 句')

    exp_ids = set()
    for x in experiments:
        xid = x.get('id')
        exp_ids.add(xid)
        if x.get('input') not in INPUTS:
            e.append(f'实验 {xid} 的 input 要是 {sorted(INPUTS)} 之一（切镜头、下拉框、滑条、点播放不算亲手做实验）：{x.get("input")!r}')
        if x.get('step') not in step_ids:
            e.append(f'实验 {xid} 的 step 不存在：{x.get("step")!r}')
        for key in ('child_does', 'scene_state', 'see'):
            if not str(x.get(key, '')).strip():
                e.append(f'实验 {xid} 没写 {key}')
    if len(experiments) < 3:
        e.append(f'至少 3 个孩子亲手改变三维场景的实验（experiments），现在 {len(experiments)} 个')

    kinds = [t.get('kind') for t in tasks.values() if isinstance(t, dict)]
    if len(tasks) < 2:
        e.append(f'至少 2 道题，现在 {len(tasks)} 道')
    if 'choice' not in kinds:
        e.append('至少 1 道选择题（kind: choice）')
    if 'hands_on' not in kinds:
        e.append('至少 1 道动手题（kind: hands_on），用实验判题')

    def options(a, where):
        opts = a.get('options') or []
        if not 2 <= len(opts) <= 4:
            e.append(f'{where} 是选择题，要 2–4 个选项')
            return
        if sum(1 for o in opts if o.get('right')) != 1:
            e.append(f'{where} 要正好 1 个正确选项')
        for o in opts:
            if not o.get('right') and not (o.get('good') and o.get('look')):
                e.append(f'{where} 的错误选项 {o.get("id")} 要写 good（先夸做对的地方）和 look（再看哪里）')

    for tid, t in tasks.items():
        t = t or {}
        if t.get('kind') not in KINDS:
            e.append(f'题 {tid} 的 kind 要是 {sorted(KINDS)} 之一：{t.get("kind")!r}')
        if tid not in owner:
            e.append(f'题 {tid} 不在任何步骤里')
        if not str(t.get('ask', '')).strip():
            e.append(f'题 {tid} 没写 ask')
        if t.get('kind') == 'choice':
            options(t, f'题 {tid}')
        elif not (t.get('good') and t.get('look')):
            e.append(f'题 {tid} 要写 good 和 look：答错时先夸真正做对的地方，再说看哪里')
        if t.get('kind') == 'hands_on' and t.get('experiment') not in exp_ids:
            e.append(f'动手题 {tid} 的 experiment 要指向一个实验：{t.get("experiment")!r}')
        ex = t.get('worked_example') or []
        if not 2 <= len(ex) <= 5:
            e.append(f'题 {tid} 的 worked_example 要 2–5 步（错 3 次后演示）')
        twin = t.get('twin')
        if not (isinstance(twin, dict) and str(twin.get('ask', '')).strip()):
            e.append(f'题 {tid} 没有同类题 twin（演示后孩子自己做一次）')
        else:
            if twin.get('ask') == t.get('ask'):
                e.append(f'题 {tid} 的同类题和原题一样，要换数字或情境')
            if t.get('kind') == 'choice':
                options(twin, f'题 {tid} 的同类题')
    persist = (flow.get('encouragement') or {}).get('persist') or []
    if not 2 <= len(persist) <= 5:
        e.append('encouragement.persist 要 2–5 句和主题有关的坚持理由')

    for lang, text, where in child_lines(flow):
        if lang != 'zh':
            continue
        if len(text) > LINE_MAX:
            e.append(f'{where} 有 {len(text)} 个字，孩子的一句话不超过 {LINE_MAX} 字：「{text[:20]}…」')
        long = [c for c in re.split(r'[。！？!?；;，,：:]', text) if len(c.strip()) > CLAUSE_MAX]
        if long:
            w.append(f'{where} 有一个分句超过 {CLAUSE_MAX} 字，读出来不好懂：「{long[0][:20]}…」')
        bad = [x for x in ADULT_WORDS if x in text]
        if bad:
            e.append(f'{where} 用了写给家长的词 {bad}，放进 parent_notes：「{text[:20]}…」')

    missing = [(lang, text) for lang, text, _ in all_lines(flow) if not has_file(line_file(lang, text))]
    if missing:
        e.append(f'{len(missing)} 句没有录音（字幕要朗读），先运行 make_family_audio.py：例如「{missing[0][1][:20]}」')

    gate = flow.get('visual_gate') or {}
    if not gate.get('sheet'):
        e.append('visual_gate.sheet 没写：先做真实照片和课里截图的对照图')
    if not gate.get('references'):
        e.append('visual_gate.references 至少 1 张真实照片和它的来源')
    if len(str(gate.get('self_review', '')).strip()) < 20:
        e.append('visual_gate.self_review 要写清对着照片挑出的不像的地方和处理办法')
    return e, w


def stray_chinese(text, flow):
    """网页代码里不在 lesson-flow.json、也不在流程固定用语里的汉字数：多了说明页面上有没朗读的大段文字。"""
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)  # 注释孩子看不到（正式构建会去掉）
    text = re.sub(r'(^|\s)//[^\n]*', r'\1', text)
    known = [t for _, t, _ in all_lines(flow)] + list(_texts(flow.get('parent_notes') or []))
    for t in sorted(set(known), key=len, reverse=True):
        text = text.replace(t, '')
        text = text.replace(json.dumps(t, ensure_ascii=False)[1:-1], '')
    return len(CJK.findall(text))
