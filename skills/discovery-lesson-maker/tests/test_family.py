"""家庭上课规则（lesson-flow.json）检查：示例通过，每条家长定的规则缺了都报错。夹具不是课程。"""
import copy
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from family_flow import all_lines, check_flow, child_lines, line_file, stray_chinese
from make_family_audio import speakable

FLOW = json.loads((ROOT / 'examples/lesson-flow.example.json').read_text(encoding='utf-8'))


def errors(flow, has=lambda rel: True):
    return ' | '.join(check_flow(flow, has)[0])


class FamilyFlowTests(unittest.TestCase):
    def flow(self):
        return copy.deepcopy(FLOW)

    def test_example_passes(self):
        self.assertEqual(check_flow(FLOW), ([], []))

    def test_line_file_matches_the_page_module(self):
        # 和 adw-family.mjs 的 lineFile() 同一个值（test/family-flow.test.ts 核对同一句）
        self.assertEqual(line_file('zh', '再试一次。'), line_file('zh', '再试一次。'))
        self.assertRegex(line_file('en', 'Look.'), r'^audio/family/en-[0-9a-f]{8}\.m4a$')
        self.assertEqual(line_file('zh', '桥'), 'audio/family/zh-%s.m4a' % FNV_ZH_QIAO)

    def test_one_chinese_three_english(self):
        f = self.flow()
        f['narration']['intro']['en'] = ['Look.']
        self.assertIn('正好 3 句英文', errors(f))

    def test_every_step_has_a_timer_and_guidance(self):
        f = self.flow()
        f['steps'][0]['seconds'] = 5000
        del f['steps'][1]['say']
        e = errors(f)
        self.assertIn('30–900 秒', e)
        self.assertIn('没有讲解点', e)

    def test_three_hands_on_experiments_and_sliders_do_not_count(self):
        f = self.flow()
        f['experiments'] = f['experiments'][:2]
        f['experiments'][1]['input'] = 'slider'
        e = errors(f)
        self.assertIn('至少 3 个', e)
        self.assertIn('滑条', e)

    def test_demo_twin_and_praise_parts_are_required(self):
        f = self.flow()
        f['tasks']['which']['worked_example'] = ['看。']
        del f['tasks']['span']['twin']
        del f['tasks']['which']['options'][1]['good']
        f['tasks']['span']['kind'] = 'application'
        e = errors(f)
        for words in ('2–5 步', '同类题 twin', '先夸做对的地方', '动手题（kind: hands_on）'):
            self.assertIn(words, e)

    def test_child_lines_are_short_and_not_written_for_reviewers(self):
        f = self.flow()
        f['narration']['intro']['zh'] = '这是一个教学算例，模型说明机制，不给真实大楼作安全或性能保证，也不能推成真实楼的固定减振百分比。'
        e = errors(f)
        self.assertIn('不超过 40 字', e)
        self.assertIn('写给家长的词', e)

    def test_every_line_needs_its_recording(self):
        recorded = {line_file(l, t) for l, t, _ in all_lines(FLOW)}
        self.assertEqual(errors(FLOW, lambda rel: rel in recorded), '')
        recorded.discard(line_file('en', FLOW['narration']['intro']['en'][0]))
        self.assertIn('1 句没有录音', errors(FLOW, lambda rel: rel in recorded))

    def test_visual_gate(self):
        f = self.flow()
        f['visual_gate'] = {'sheet': 'evidence/visual-gate.jpg', 'references': [], 'self_review': '好'}
        e = errors(f)
        self.assertIn('至少 1 张真实照片', e)
        self.assertIn('挑出的不像的地方', e)

    def test_hands_on_steps_are_realtime_and_gate_has_both_kinds_of_picture(self):
        f = self.flow()
        f['steps'][1]['media'] = 'render'      # 动手的步不能只给看预渲染图
        f['steps'][0]['media'] = 'video'
        f['visual_gate']['views'] = [v for v in f['visual_gate']['views'] if v['media'] == 'render']
        e = errors(f)
        self.assertIn('必须是实时三维', e)
        self.assertIn('动手题 span', e)
        self.assertIn('media 只能是 render', e)
        self.assertIn('至少一张实时网页截图', e)
        f = self.flow()
        f['visual_gate']['views'] = [v for v in f['visual_gate']['views'] if v['media'] == 'realtime']
        self.assertIn('对应的预渲染图', errors(f))
        for s in f['steps']:
            s.pop('media', None)          # 不写 media 就是实时三维，不要求预渲染图
        self.assertEqual(errors(f), '')

    def test_real_dimensions_with_sources(self):
        f = self.flow()
        f['visual_gate']['dimensions'] = [{'what': '主跨', 'meters': 602}]
        self.assertIn('至少 1 条真实尺寸', errors(f))

    def test_math_comes_first(self):
        f = self.flow()
        del f['math']
        f['tasks']['why'].pop('math')
        e = errors(f)
        self.assertIn('math.point 没写', e)
        self.assertIn('math.question 没写', e)
        self.assertIn('至少 2 道', e)
        f = self.flow()
        f['tasks']['span'].pop('math')
        f['tasks']['which']['math'] = True
        self.assertIn('至少一道数学题是动手题', errors(f))
        f = self.flow()
        f['math']['grade'] = 6
        self.assertIn('比孩子的 4 年级高', errors(f))

    def test_second_grade_gets_two_sentences_a_step(self):
        f = self.flow()
        self.assertEqual(errors(f), '')
        f['grade'] = 2
        self.assertEqual(check_flow(f)[0], [])           # 示例每步最多 2 句，二年级也过
        f['narration']['load']['zh'] = '把卡车拖上桥。看看哪里在用力。拉索会变直。'
        self.assertIn('2 年级每步不超过 2 句', errors(f))
        f['grade'] = 4
        self.assertEqual(errors(f), '')
        self.assertIn('不一样', ' | '.join(check_flow(f, grade=2)[0]))
        g = self.flow(); del g['grade']
        self.assertIn('没写年级', ' | '.join(check_flow(g)[1]))

    def test_wish_options_for_the_next_lesson(self):
        f = self.flow()
        del f['wish']
        self.assertIn('wish.options 要 2–4 个', errors(f))
        f['wish'] = {'options': ['隧道', '一个特别特别长的名字的主题']}
        self.assertIn('不超过 12 个字', errors(f))

    def test_stray_chinese_counts_only_unrecorded_text(self):
        page = 'h("' + '","'.join(t for _, t, _ in child_lines(FLOW)) + '");/* 注释里的中文不算 */'
        self.assertEqual(stray_chinese(page, FLOW), 0)
        self.assertEqual(stray_chinese(page + 'p("平均数只概括第一批")', FLOW), 9)


def _fnv(text):
    h = 0x811c9dc5
    for b in text.encode('utf-8'):
        h = ((h ^ b) * 0x01000193) & 0xffffffff
    return f'{h:08x}'


FNV_ZH_QIAO = _fnv('zh|桥')


class SpeakableTests(unittest.TestCase):
    """配音前的清理规则和服务器 voice-cloud.ts 的 speakable() 一致（test/server.test.ts 里同样三句）。"""

    def test_same_as_server(self):
        self.assertEqual(speakable('太棒了！！！🎉 你找到了~'), '太棒了！ 你找到了')
        self.assertEqual(speakable('我们来想一想……答案是多少？？'), '我们来想一想，答案是多少？')
        self.assertEqual(speakable('Wow!!! Great job...'), 'Wow! Great job')


if __name__ == '__main__':
    unittest.main()
