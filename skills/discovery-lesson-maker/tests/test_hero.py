"""主角硬门槛 H1–H7，用几个从没做过的主题走一遍：鲸鱼、地铁列车、恐龙、长颈鹿、挖掘机、大熊猫。
夹具 .glb 由 tests/glb_fixture.py 现造，只测检查器；能过只说明不是代码拼的、不是纯色卡通件，不证明像。"""
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'scripts'), str(ROOT / 'tests')]
from glb_fixture import glb
from hero_check import check_blind_review, check_hero

REFS = [{'source': f'https://example.org/{a}.jpg', 'angle': a} for a in ('正面', '侧面', '俯视')]


def hero(file, cls, origin, meters, **extra):
    item = {'file': file, 'role': 'hero', 'class': cls, 'origin': origin, 'real_size_m': meters, 'reference_photos': REFS,
            'source_url': 'https://example.org/source', 'generator': 'Hunyuan3D-2.1', 'how': '见课程设计.md'}
    item.update(extra)
    return item


def errors(item, data):
    return ' '.join(check_hero(item, data)[0])


class HeroGateTests(unittest.TestCase):
    def test_real_sources_at_real_size_pass(self):
        cases = [
            (hero('whale.glb', 'organism', 'scan', 25.0), glb(40000, (25.0, 5.0, 4.0))),            # 蓝鲸：博物馆骨架+体表扫描
            (hero('metro.glb', 'vehicle', 'cad', 19.5), glb(30000, (19.5, 3.8, 2.8))),              # 地铁列车一节：厂家外形图
            (hero('panda.glb', 'organism', 'generated', 1.6), glb(30000, (1.6, 0.9, 0.8))),         # 大熊猫：≥3 张实拍生成后修整
            (hero('trex.glb', 'organism', 'scan', 12.3), glb(60000, (12.3, 3.9, 2.5))),             # 霸王龙：博物馆化石骨架扫描
        ]
        for item, data in cases:
            got, facts = check_hero(item, data)
            self.assertEqual(got, [], item['file'])
            self.assertEqual(facts['triangles'] >= 15000, True)

    def test_animals_cannot_be_drawn_by_hand_or_by_code(self):
        for origin in ('modeled', 'procedural', 'drawn'):
            self.assertIn('动物和人只能来自实物扫描', errors(hero('whale.glb', 'organism', origin, 25.0), glb(40000, (25.0, 5.0, 4.0))))

    def test_a_machine_built_from_code_primitives_fails(self):
        # 挖掘机：几十个方块圆柱拼起来、纯色、没贴图——家长否掉的机械臂就是这样
        got = errors(hero('excavator.glb', 'machine', 'modeled', 9.5), glb(900, (9.5, 3.0, 3.2), texture=0, uv=False, parts=30))
        for want in ('三角形', '贴了颜色贴图', '颜色贴图最大 0 像素', '法线或粗糙度贴图'):
            self.assertIn(want, got)

    def test_wrong_scale_fails(self):
        # 长颈鹿 5.5 米，模型却只有 1 米：放进场景就成了玩具
        self.assertIn('差了 82%', errors(hero('giraffe.glb', 'organism', 'generated', 5.5), glb(30000, (1.0, 0.4, 0.3))))

    def test_evidence_is_required(self):
        item = hero('metro.glb', 'vehicle', 'cad', 19.5, reference_photos=REFS[:2], source_url='')
        got = errors(item, glb(30000, (19.5, 3.8, 2.8)))
        self.assertIn('至少 3 张不同角度的真实照片', got)
        self.assertIn('source_url', got)
        got = errors(hero('panda.glb', 'organism', 'generated', 1.6, generator=''), glb(30000, (1.6, 0.9, 0.8)))
        self.assertIn('generator', got)
        got = errors({'file': 'x.glb', 'origin': 'scan'}, glb(30000))
        self.assertIn('没写 class', got)
        self.assertIn('real_size_m', got)

    def test_low_resolution_or_flat_material_fails(self):
        got = errors(hero('panda.glb', 'organism', 'generated', 1.6), glb(30000, (1.6, 0.9, 0.8), texture=512, normal=False))
        self.assertIn('颜色贴图最大 512', got)
        self.assertIn('法线或粗糙度贴图', got)

    def test_hero_must_be_a_glb_and_be_present(self):
        self.assertIn('交 .glb', errors(hero('whale.fbx', 'organism', 'scan', 25.0), b''))
        self.assertIn('不在包里', errors(hero('whale.glb', 'organism', 'scan', 25.0), None))
        self.assertIn('读不了', errors(hero('whale.glb', 'organism', 'scan', 25.0), b'not a model at all'))


def row(view, verdict='photo', **extra):
    r = {'view': view, 'subject': 'hero', 'media': 'render', 'photo': f'research/{view}.jpg', 'ours': f'evidence/{view}.png',
         'reviewer': '另一个看图模型', 'same_thing': True, 'verdict': verdict, 'flaws': []}
    r.update(extra)
    return r


class BlindReviewTests(unittest.TestCase):
    def test_three_angles_that_read_as_photos_pass(self):
        rows = [row('正面'), row('侧面'), row('桥面', 'cg', media='realtime', subject='scene', flaws=['水面偏亮'])]
        self.assertEqual(check_blind_review({'blind_review': rows}), ([], []))

    def test_cartoon_or_toy_verdict_fails(self):
        for verdict in ('cartoon', 'toy'):
            got = ' '.join(check_blind_review({'blind_review': [row('正面'), row('侧面', verdict, flaws=['颜色太纯']), row('俯视')]})[0])
            self.assertIn('不能给孩子看', got)

    def test_a_render_that_still_looks_cg_fails(self):
        got = ' '.join(check_blind_review({'blind_review': [row('正面', 'cg', flaws=['塑料感']), row('侧面'), row('俯视')]})[0])
        self.assertIn('预渲染图还看得出是电脑画面', got)

    def test_not_the_same_thing_fails(self):
        got = ' '.join(check_blind_review({'blind_review': [row('正面', same_thing=False, notes='照片是蜜蜂，画面是黄蜂'), row('侧面'), row('俯视')]})[0])
        self.assertIn('不是同一个东西', got)

    def test_the_maker_cannot_review_itself_and_the_hero_must_be_seen(self):
        got = ' '.join(check_blind_review({'blind_review': [row('正面', reviewer_made_it=True), row('侧面'), row('俯视')]})[0])
        self.assertIn('不算盲看', got)
        got = ' '.join(check_blind_review({'blind_review': [row(v, subject='scene') for v in ('a', 'b', 'c')]})[0])
        self.assertIn('没有主角', got)

    def test_fewer_than_three_angles_fails(self):
        self.assertIn('至少 3 个角度', ' '.join(check_blind_review({'blind_review': [row('正面')]})[0]))
        self.assertIn('3 个不同角度', ' '.join(check_blind_review({'blind_review': [row('正面')] * 3})[0]))


if __name__ == '__main__':
    unittest.main()
