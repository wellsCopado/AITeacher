"""写啥主题就做啥图片：素材清单的检查。三个没做过的主题（火箭发射、蜜蜂、火山）各走一遍；
夹具里的图片是随机字节，主角是测试用的 .glb（tests/glb_fixture.py），都不是课程，也不证明画面合格。"""
import hashlib
import json
import os
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from topic_assets import check_assets
sys.path.insert(0, str(ROOT / 'tests'))
from glb_fixture import glb

PREFIX = 'pkg/web/dist/'

# 每个主题：主角、部件、环境、题目配图，全都为这个主题做（步骤 3 的素材清单）
TOPICS = {
    '火箭发射': [('models/long-march-2f.glb', 'hero', '长征二号F运载火箭（整箭）', 'cad', '航天科技集团公开的外形图转 CAD，再补贴图'),
               ('models/launch-tower.glb', 'scene', '发射塔和导流槽', 'modeled', 'Blender 按发射场照片建模'),
               ('textures/concrete.jpg', 'scene', '发射台混凝土地面', 'cc0-library', 'ambientCG 混凝土贴图'),
               ('img/q2-countdown.png', 'picture', '倒计时 10 秒时的火箭和发射塔（第 2 题配图）', 'rendered', '本课三维场景渲染')],
    '蜜蜂': [('models/worker-bee.glb', 'hero', '意大利蜜蜂工蜂', 'scan', '博物馆标本扫描，Blender 修整并绑定翅膀'),
           ('models/honeycomb.glb', 'part', '蜂巢巢脾（六边形巢房）', 'procedural', '按巢房实测边长程序生成'),
           ('img/q1-cells.webp', 'picture', '巢脾上一排排巢房（第 1 题配图）', 'rendered', '本课三维场景渲染')],
    '火山': [('models/stratovolcano.glb', 'hero', '层状火山（火山锥和火山口）', 'procedural', '按公开高程数据（DEM）生成地形，卫星影像做贴图'),
           ('models/lava-flow.glb', 'part', '熔岩流', 'procedural', '本课程序生成'),
           ('textures/basalt.jpg', 'scene', '玄武岩地面', 'cc0-library', 'Poly Haven 岩石贴图')],
}


# 主角的类别和真实尺寸（米）：主角要过 hero_check.py 的门槛
HERO = {'火箭发射': ('vehicle', 58.3), '蜜蜂': ('organism', 0.013), '火山': ('landform', 3776.0)}


def hero_fields(topic):
    cls, meters = HERO.get(topic, ('object', 1.0))
    return {'class': cls, 'real_size_m': meters, 'source_url': 'https://example.org/source', 'generator': 'Hunyuan3D-2.1',
            'reference_photos': [{'source': f'https://example.org/{a}.jpg', 'angle': a} for a in ('正面', '侧面', '俯视')]}


def build(topic, items=None, manifest_topic=None, listing_topic=None):
    files, listed = {}, []
    for rel, role, depicts, origin, how in items or TOPICS[topic]:
        meters = HERO.get(topic, ('object', 1.0))[1]
        data = glb(20000, (meters, meters / 3, meters / 3)) if role == 'hero' and rel.endswith('.glb') else os.urandom(4096)
        files[PREFIX + rel] = data
        listed.append({'file': 'web/dist/' + rel, 'sha256': hashlib.sha256(data).hexdigest(), 'role': role, 'depicts': depicts,
                       'made_for': topic, 'origin': origin, 'how': how, 'license': 'CC0' if origin == 'cc0-library' else '自制',
                       **(hero_fields(topic) if role == 'hero' else {})})
    files[PREFIX + 'assets/index.js'] = b'// code is not a picture'
    files['pkg/research/assets.json'] = json.dumps({'topic': listing_topic or topic, 'items': listed}, ensure_ascii=False).encode()
    manifest = {'topic': manifest_topic if manifest_topic is not None else topic}
    return files, manifest, listed


def run(files, manifest):
    site = [n for n in files if n.startswith(PREFIX)]
    return check_assets(lambda n: files[n], site, 'pkg/', PREFIX, manifest)


class TopicAssetTests(unittest.TestCase):
    def test_three_new_topics_with_their_own_assets_pass(self):
        for topic in TOPICS:
            errors, warnings, facts = run(*build(topic)[:2])
            self.assertEqual(errors, [], topic)
            self.assertEqual(warnings, [], topic)
            self.assertEqual(facts['topic'], topic)

    def test_a_picture_not_in_the_list_fails(self):
        files, manifest, _ = build('火箭发射')
        files[PREFIX + 'img/robot-arm.png'] = os.urandom(4096)  # 从别处拷来、没登记的图
        errors = ' '.join(run(files, manifest)[0])
        self.assertIn('不在素材清单里', errors)
        self.assertIn('img/robot-arm.png', errors)

    def test_an_asset_made_for_another_topic_fails(self):
        files, manifest, listed = build('火箭发射')
        listed[3]['made_for'] = '机器人工厂'
        files['pkg/research/assets.json'] = json.dumps({'topic': '火箭发射', 'items': listed}, ensure_ascii=False).encode()
        self.assertIn('不是为「火箭发射」做的', ' '.join(run(files, manifest)[0]))

    def test_the_robot_arm_as_the_rocket_lesson_hero_fails(self):
        # 2026-11-05 的退回：火箭发射的课，画面还是机械臂
        items = [('models/robot-arm.glb', 'hero', '工业机械臂', 'modeled', '旧场景'), ('img/q1.png', 'picture', '机械臂摆齿轮', 'rendered', '旧场景截图')]
        errors, warnings, _ = run(*build('火箭发射', items)[:2])
        self.assertIn('主角画的是「工业机械臂」，主题是「火箭发射」', ' '.join(errors))
        self.assertIn('机械臂', ' '.join(warnings))

    def test_a_photo_cannot_be_the_hero(self):
        items = [('img/bee.jpg', 'hero', '蜜蜂照片', 'photo', 'Wikimedia 照片')]
        self.assertIn('不是三维模型', ' '.join(run(*build('蜜蜂', items)[:2])[0]))

    def test_topic_and_list_are_required_and_agree(self):
        files, manifest, _ = build('火山', manifest_topic='')
        self.assertIn('没写 topic', ' '.join(run(files, manifest)[0]))
        files, manifest, _ = build('火山', listing_topic='台北101')
        self.assertIn('不一样', ' '.join(run(files, manifest)[0]))
        files, manifest, _ = build('火山')
        del files['pkg/research/assets.json']
        self.assertIn('没有素材清单', ' '.join(run(files, manifest)[0]))

    def test_every_item_says_what_where_from_and_licence(self):
        files, manifest, listed = build('蜜蜂')
        for k in ('depicts', 'how', 'license', 'sha256'):
            listed[1].pop(k)
        files['pkg/research/assets.json'] = json.dumps({'topic': '蜜蜂', 'items': listed}, ensure_ascii=False).encode()
        errors = ' '.join(run(files, manifest)[0])
        for k in ('depicts', 'license', 'how 或 sourceIds', 'sha256'):
            self.assertIn(k, errors)


if __name__ == '__main__':
    unittest.main()
