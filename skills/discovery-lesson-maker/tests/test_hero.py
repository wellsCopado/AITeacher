"""按主题做主角（hero_model.py）：主角卡写全、模型过最低线才算；几何体拼的、尺寸不对的、没贴图的都报错。夹具不是模型。"""
import copy
import json
from pathlib import Path
import struct
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from hero_model import check_hero, glb_stats


def png_header(w, h):
    return b'\x89PNG\r\n\x1a\n' + struct.pack('>I', 13) + b'IHDR' + struct.pack('>II', w, h) + b'\x08\x02\x00\x00\x00' + b'\0' * 4


def make_glb(tris=24000, size=(0.6, 0.6, 58.3), names=('booster_1', 'booster_2', 'fairing', 'tower_escape', 'core_stage'),
             tex=2048, textures=True, detail=True, prims=None):
    """只有 JSON 和贴图头的 GLB：查的是结构和数，不是画面。prims 给出每个图元的面数。"""
    prims = prims or [tris]
    images = png_header(tex, tex) + png_header(tex, tex)
    hx, hy, hz = (s / 2 for s in size)
    accessors, meshes = [], []
    for t in prims:
        accessors.append({'count': t * 3, 'componentType': 5125, 'type': 'SCALAR'})
        accessors.append({'count': 8, 'componentType': 5126, 'type': 'VEC3', 'min': [-hx, -hy, -hz], 'max': [hx, hy, hz]})
        meshes.append({'primitives': [{'attributes': {'POSITION': len(accessors) - 1}, 'indices': len(accessors) - 2, 'material': 0}]})
    mat = {'pbrMetallicRoughness': {}}
    if textures:
        mat['pbrMetallicRoughness']['baseColorTexture'] = {'index': 0}
    if detail:
        mat['normalTexture'] = {'index': 1}
    nodes = [{'mesh': i, 'name': names[i % len(names)] if names else ''} for i in range(len(meshes))]
    for n in names[len(meshes):]:
        nodes.append({'name': n})
    doc = {'asset': {'version': '2.0'}, 'scene': 0, 'scenes': [{'nodes': list(range(len(nodes)))}], 'nodes': nodes, 'meshes': meshes,
           'accessors': accessors, 'materials': [mat], 'textures': [{'source': 0}, {'source': 1}],
           'images': [{'bufferView': 0, 'mimeType': 'image/png'}, {'bufferView': 1, 'mimeType': 'image/png'}],
           'bufferViews': [{'buffer': 0, 'byteOffset': 0, 'byteLength': len(images) // 2}, {'buffer': 0, 'byteOffset': len(images) // 2, 'byteLength': len(images) // 2}],
           'buffers': [{'byteLength': len(images)}]}
    js = json.dumps(doc).encode()
    js += b' ' * (-len(js) % 4)
    binary = images + b'\0' * (-len(images) % 4)
    body = struct.pack('<II', len(js), 0x4e4f534a) + js + struct.pack('<II', len(binary), 0x004e4942) + binary
    return b'glTF' + struct.pack('<II', 2, 12 + len(body)) + body


CARD = json.loads((ROOT / 'examples/subject.example.json').read_text(encoding='utf-8'))
HERO = {'file': 'web/dist/models/cz2f.glb', 'role': 'hero', 'depicts': '长征二号F运载火箭', 'origin': 'modeled', 'how': 'Blender 按照片和尺寸建模'}


class HeroTests(unittest.TestCase):
    def run_check(self, card=CARD, glb=None, items=None, extra=None):
        files = {'research/subject.json': json.dumps(card, ensure_ascii=False).encode(), 'web/dist/models/cz2f.glb': glb or make_glb(),
                 'web/src/main.js': b"const marker = new THREE.RingGeometry(1, 1.2, 32); // adw-allow-geometry: \xe9\xab\x98\xe4\xba\xae\xe5\x9c\x88\n"}
        for r in card.get('references', []):
            if r.get('file'):
                files[r['file']] = b'jpg'
        files.update(extra or {})
        e, w, facts = check_hero(lambda n: files[n], files.keys(), '', {'topic': '火箭发射'}, items or [HERO])
        return ' | '.join(e), w, facts

    def card(self):
        return copy.deepcopy(CARD)

    def test_a_real_hero_passes(self):
        e, w, facts = self.run_check()
        self.assertEqual(e, '')
        self.assertEqual(w, [])
        self.assertEqual(facts['heroTriangles'], 24000)

    def test_stats_follow_node_transforms(self):
        s = glb_stats(make_glb(size=(1, 2, 3)))
        self.assertEqual(s['size'], [1, 2, 3])
        self.assertEqual(s['baseColorTextures'], [(2048, 2048)])

    def test_no_card_means_not_started(self):
        files = {'web/dist/models/cz2f.glb': make_glb()}
        e, _, _ = check_hero(lambda n: files[n], files.keys(), '', {'topic': '火箭发射'}, [HERO])
        self.assertIn('没有主角卡', e[0])

    def test_card_must_name_the_real_one_with_photos_sizes_and_features(self):
        c = self.card()
        c['instance'] = ''
        c['kind'] = 'rocket'
        c['references'] = c['references'][:2]
        c['dimensions'] = [{'what': '全长', 'meters': 58.3}]
        c['features'] = c['features'][:2]
        c['route'] = {'hero': 'code'}
        e, _, _ = self.run_check(c)
        for words in ('instance', 'kind 写', '至少 3 张真实照片', '至少 2 条真实尺寸', '至少 4 个辨识特征', 'route.hero', 'route.why'):
            self.assertIn(words, e)

    def test_animals_are_not_hand_modelled(self):
        c = self.card()
        c['kind'] = 'animal'
        self.assertIn('动物不走', self.run_check(c)[0])

    def test_low_poly_untextured_box_toy_fails(self):
        glb = make_glb(tris=2000, textures=False, detail=False, prims=[12] * 10)
        e = self.run_check(glb=glb)[0]
        for words in ('三角面', '像几何体拼的', '没有颜色贴图', '没有法线或粗糙度贴图'):
            self.assertIn(words, e)
        self.assertIn('贴图最大只有 512', self.run_check(glb=make_glb(tex=512))[0])

    def test_model_is_built_at_real_size(self):
        e = self.run_check(glb=make_glb(size=(0.1, 0.1, 1.0)))[0]
        self.assertIn('最长 1 米', e)
        self.assertIn('58.3 米', e)

    def test_features_point_at_model_nodes(self):
        self.assertIn('找不到对应节点', self.run_check(glb=make_glb(names=('part_a', 'part_b')))[0])

    def test_procedural_or_cartoon_hero_and_code_geometry_fail(self):
        e = self.run_check(items=[{**HERO, 'origin': 'procedural', 'how': 'Sketchfab 上的 low poly 火箭'}])[0]
        self.assertIn('origin 是 procedural', e)
        self.assertIn('低多边形、卡通', e)
        e = self.run_check(extra={'web/src/rocket.js': b'const body = new THREE.CylinderGeometry(1.7, 1.7, 40);\nconst nose = new ConeGeometry(1.7, 8);\n'})[0]
        self.assertIn('代码里用几何体拼了 2 处', e)
        self.assertIn('web/src/rocket.js:1', e)


if __name__ == '__main__':
    unittest.main()
