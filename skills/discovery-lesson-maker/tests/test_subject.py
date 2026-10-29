"""题材偷换、完整结构和功能解释的回归，不把测试几何称成写实模型。"""
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from check_subject import validate
from check_production import digest


class SubjectTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.names = ['head', 'torso', 'armL', 'armR', 'legL', 'legR', 'handL', 'handR', 'footL', 'footR']
        doc = {'asset': {'version': '2.0'}, 'accessors': [{'count': 3}],
               'meshes': [{'primitives': [{'attributes': {'POSITION': 0}}]}],
               'nodes': [{'name': name} for name in self.names]}
        data = json.dumps(doc).encode()
        data += b' ' * (-len(data) % 4)
        body = struct.pack('<II', len(data), 0x4E4F534A) + data
        model = self.root / 'fixture.glb'
        model.write_bytes(struct.pack('<4sII', b'glTF', 2, len(body) + 12) + body)
        bindings = {'head': ['head'], 'torso': ['torso'], 'arms': ['armL', 'armR'],
                    'legs': ['legL', 'legR'], 'hands': ['handL', 'handR'], 'feet': ['footL', 'footR']}
        self.record = {'identity': {'request': '人形机器人', 'resolvedSubject': '人形机器人',
                                   'kind': 'humanoid', 'basis': '测试用用户明确输入',
                                   'requiredFeatures': [{'id': key, 'nodes': nodes} for key, nodes in bindings.items()]},
                       'model': {'file': 'fixture.glb', 'sha256': digest(model)},
                       'sources': [{'id': 's'}],
                       'parts': [{'id': key, 'title': key, 'nodes': nodes, 'function': '测试作用记录',
                                  'mechanism': '测试配合记录', 'observation': '测试观察记录', 'sourceIds': ['s']}
                                 for key, nodes in bindings.items()],
                       'experiment': {**{key: '测试记录，非真实验收' for key in ['question', 'prediction', 'control', 'observedChange', 'explanation']}, 'sourceIds': ['s']},
                       'reviews': {}}

    def tearDown(self):
        self.temp.cleanup()

    def run_check(self, draft=True, real=False):
        (self.root / 'scope.json').write_text(json.dumps(self.record))
        return validate(self.root, '人形机器人', draft, real)['errors']

    def test_arm_substitution_and_missing_legs_block_expansion(self):
        self.record['identity']['resolvedSubject'] = '机械臂'
        self.record['identity']['requiredFeatures'] = [{'id': 'arms', 'nodes': ['armL']}]
        errors = self.run_check()
        self.assertTrue(any('身份' in e for e in errors))
        self.assertTrue(any('legs' in e for e in errors))

    def test_part_name_alone_does_not_count_as_function_teaching(self):
        self.record['parts'][0]['mechanism'] = ''
        self.assertTrue(any('机制' in e for e in self.run_check()))

    def test_binding_must_exist_and_final_needs_actual_review(self):
        self.assertEqual(self.run_check(), [])
        self.assertTrue(any('实际审查' in e for e in self.run_check(False)))
        self.record['parts'][0]['nodes'] = ['imagined_hidden_organ']
        self.assertTrue(any('实际模型' in e for e in self.run_check()))

    def test_complete_geometry_without_leg_explanations_still_fails(self):
        self.record['parts'] = [part for part in self.record['parts'] if part['id'] != 'legs']
        self.assertTrue(any('功能教学覆盖：legs' in e for e in self.run_check()))

    def test_superlative_needs_dated_comparison_scope_and_read_source(self):
        self.record['identity']['superlative'] = True
        self.assertTrue(self.run_check())
        self.record['identity'].update({'checkedAt': '2026-10-27',
                                        'comparisonScope': '测试比较口径，非实际排名证据',
                                        'rankingSourceIds': ['s']})
        self.record['sources'][0]['verification'] = 'metadata-only'
        self.assertTrue(any('实际读取' in e for e in self.run_check()))
        self.record['sources'][0]['verification'] = 'read'
        self.assertEqual(self.run_check(), [])

    def test_complete_teaching_avatar_is_not_a_real_object_record(self):
        self.assertEqual(self.run_check(), [])
        self.record['identity']['representation'] = 'invented-teaching-design'
        errors = self.run_check(real=True)
        self.assertTrue(any('自创教学角色' in e for e in errors))
        self.assertTrue(any('几何依据' in e or '具体依据' in e for e in errors))

    def test_real_object_requires_read_sources_and_specific_geometry_basis(self):
        self.record['identity'].update({
            'representation': 'reference-reconstruction',
            'realObject': {'name': '测试对象，不是真实型号', 'basis': '测试选型记录',
                           'sourceIds': ['s'], 'anchors': [{'feature': '测试轮廓',
                           'basis': '测试正侧轮廓依据，非实际视觉证据', 'sourceIds': ['s']}]}})
        self.assertTrue(any('未实际读取' in e for e in self.run_check(real=True)))
        self.record['sources'][0]['verification'] = 'read'
        self.assertEqual(self.run_check(real=True), [])
        self.record['identity']['realObject']['anchors'][0]['sourceIds'] = ['unknown']
        self.assertTrue(any('有效直接来源' in e for e in self.run_check(real=True)))


if __name__ == '__main__':
    unittest.main()
