"""只验证Skill工具的真实不变量，不是课程/写实/学习效果测试。"""
import importlib.util
import json
from pathlib import Path
import struct
import shutil
import subprocess
import sys
import tempfile
import unittest
import wave


ROOT = Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / f'{name}.py')
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


production = module('check_production')
challenges = module('check_challenges')


def tiny_glb():
    # 三角网格仅用于容器检查，不能当成写实主角。
    doc = {'asset': {'version': '2.0'}, 'buffers': [{'byteLength': 36}],
           'bufferViews': [{'buffer': 0, 'byteLength': 36}],
           'accessors': [{'bufferView': 0, 'componentType': 5126, 'count': 3, 'type': 'VEC3'}],
           'meshes': [{'primitives': [{'attributes': {'POSITION': 0}}]}]}
    text = json.dumps(doc).encode()
    text += b' ' * (-len(text) % 4)
    binary = struct.pack('<9f', 0, 0, 0, 1, 0, 0, 0, 1, 0)
    body = struct.pack('<II', len(text), 0x4E4F534A) + text + struct.pack('<II', 36, 0x004E4942) + binary
    return struct.pack('<4sII', b'glTF', 2, 12 + len(body)) + body


class ProductionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.record = json.loads((ROOT / 'assets/production-template.json').read_text())
        self.record['topic'] = '测试主题'
        # 此组兼容测试明确要求完整视频，独立视频可选另有正反例。
        self.record['requirements'] = {'video': True, 'action': True, 'reason': '完整媒体测试fixture'}

    def tearDown(self):
        self.temp.cleanup()

    def save(self):
        (self.root / 'production.json').write_text(json.dumps(self.record))

    def test_draft_does_not_become_delivered_assets(self):
        self.save()
        record = production.validate(self.root, 'record')
        self.assertEqual(record['errors'], [])
        self.assertEqual(record['reviewStatus']['visual'], 'pending')
        result = production.validate(self.root, 'assets')
        self.assertTrue(any('三维主角' in e for e in result['errors']))
        self.assertTrue(any('短片' in e for e in result['errors']))

    def test_optional_video_keeps_real_mesh_and_other_quality_gates(self):
        self.record['requirements'] = {'video': False, 'action': True, 'reason': '用户明确不要求独立视频'}
        self.save()
        errors = production.validate(self.root, 'assets')['errors']
        self.assertFalse(any('缺少写实动画短片' in e for e in errors))
        self.assertTrue(any('三维主角' in e for e in errors))
        errors = production.validate(self.root, 'course')['errors']
        self.assertTrue(any('实际旁白' in e for e in errors))
        self.assertTrue(any('visual' in e for e in errors))
        self.assertTrue(any('motion' in e for e in errors))

    def test_removing_media_requirement_needs_user_basis(self):
        self.record['requirements'] = {'video': False, 'action': False}
        self.save()
        errors = production.validate(self.root, 'record')['errors']
        self.assertTrue(any('本轮需求依据' in e for e in errors))

    def test_topic_drift_is_rejected(self):
        self.save()
        result = production.validate(self.root, 'record', '另一个用户主题')
        self.assertTrue(any('主题' in e for e in result['errors']))

    def test_image_cannot_be_a_3d_model(self):
        path = self.root / 'hero.png'
        path.write_bytes(b'\x89PNG\r\n\x1a\n')
        with self.assertRaises(ValueError):
            production.inspect_gltf(self.root, path)

    def test_glb_header_and_actual_vertices_are_checked(self):
        path = self.root / 'hero.glb'
        path.write_bytes(tiny_glb())
        self.assertEqual(production.inspect_gltf(self.root, path)['vertices'], 3)
        path.write_bytes(path.read_bytes()[:-3])
        with self.assertRaises(ValueError):
            production.inspect_gltf(self.root, path)

    def test_local_references_inside_root_work_but_missing_ones_fail(self):
        folder = self.root / 'models'
        folder.mkdir()
        (self.root / 'buffer.bin').write_bytes(b'\0' * 36)
        doc = {'asset': {'version': '2.0'}, 'buffers': [{'uri': '../buffer.bin', 'byteLength': 36}],
               'accessors': [{'count': 3}], 'meshes': [{'primitives': [{'attributes': {'POSITION': 0}}]}]}
        path = folder / 'hero.gltf'
        path.write_text(json.dumps(doc))
        self.assertEqual(production.inspect_gltf(self.root, path)['localReferences'], 1)
        (self.root / 'buffer.bin').unlink()
        with self.assertRaises(ValueError):
            production.inspect_gltf(self.root, path)

    def test_traversal_and_symlink_escape_are_rejected(self):
        with self.assertRaises(ValueError):
            production.local_file(self.root, '../private.txt')
        with tempfile.TemporaryDirectory() as other:
            target = Path(other) / 'private.txt'
            target.write_text('not part of the package')
            (self.root / 'link.txt').symlink_to(target)
            with self.assertRaises(ValueError):
                production.local_file(self.root, 'link.txt')

    def test_passed_review_needs_current_evidence(self):
        self.record['reviews']['visual'] = {'status': 'passed', 'evidence': []}
        self.save()
        self.assertTrue(any('visual' in e for e in production.validate(self.root, 'record')['errors']))

    def test_changed_asset_invalidates_review_hash(self):
        path = self.root / 'hero.glb'
        path.write_bytes(tiny_glb())
        sha = production.digest(path)
        evidence = self.root / 'review.txt'
        evidence.write_text('技术测试fixture，不是实际审美通过')
        self.record['reviews']['visual'] = {
            'status': 'passed', 'artifacts': {'hero.glb': sha},
            'evidence': [{'file': 'review.txt', 'sha256': production.digest(evidence)}]}
        self.save()
        self.assertEqual(production.validate(self.root, 'record')['errors'], [])
        path.write_bytes(path.read_bytes() + b'changed')
        self.assertTrue(any('SHA256' in e for e in production.validate(self.root, 'record')['errors']))

    def test_renamed_gif_is_not_a_video(self):
        path = self.root / 'fake.mp4'
        path.write_bytes(b'GIF89a' + b'0' * 50)
        self.record['sources'] = [{'id': 's', 'url': 'https://example.invalid/source', 'verification': 'not-verified'}]
        self.record['clips'] = [{'id': 'v', 'file': 'fake.mp4', 'sha256': production.digest(path),
                                  'sourceId': 's', 'license': 'fixture', 'licenseScope': 'personal-noncommercial'}]
        self.save()
        self.assertTrue(any('容器头' in e for e in production.validate(self.root, 'assets')['errors']))

    def test_not_read_source_cannot_support_verified_claim(self):
        self.record['sources'] = [{'id': 's', 'url': 'https://example.invalid/paper', 'verification': 'metadata-only'}]
        self.record['claims'] = [{'text': '待核实说法', 'sourceIds': ['s'], 'status': 'verified'}]
        self.save()
        self.assertTrue(any('事实声称' in e for e in production.validate(self.root, 'record')['errors']))

    def test_authored_source_uses_real_local_file_without_invented_url(self):
        source = self.root / 'build_hero.py'
        source.write_text('# 本次自主建模源码\n')
        self.record['sources'] = [{'id': 'own', 'file': 'build_hero.py',
                                   'sha256': production.digest(source), 'verification': 'read'}]
        self.save()
        self.assertEqual(production.validate(self.root, 'record')['errors'], [])
        source.unlink()
        self.assertTrue(production.validate(self.root, 'record')['errors'])

    def test_draft_keeps_unknown_voice_rights_without_claiming_authorization(self):
        audio = self.root / 'voice.wav'
        audio.write_bytes(b'draft audio fixture')
        (self.root / 'script.txt').write_text('许可待核实的草稿')
        self.record['sources'] = [{'id': 'voice-source', 'url': 'https://example.invalid/voice',
                                   'verification': 'not-verified'}]
        self.record['narration'] = [{'id': 'n', 'file': 'voice.wav', 'sha256': production.digest(audio), 'origin': 'synthetic',
                                    'sourceId': 'voice-source', 'licenseScope': 'unknown',
                                    'transcriptFile': 'script.txt'}]
        self.save()
        self.assertEqual(production.validate(self.root, 'record')['errors'], [])
        self.assertTrue(any('授权范围' in e for e in production.validate(self.root, 'assets')['errors']))

    def test_init_preserves_topic_and_refuses_overwrite(self):
        output = self.root / 'new-record'
        command = [sys.executable, str(ROOT / 'scripts/init_production.py'), '--topic', '月相', '--out', str(output)]
        self.assertEqual(subprocess.run(command, capture_output=True).returncode, 0)
        self.assertEqual(json.loads((output / 'production.json').read_text())['topic'], '月相')
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
        self.assertFalse((output / 'index.html').exists())

    def test_human_like_label_is_not_human_recording(self):
        audio = self.root / 'voice.wav'
        audio.write_bytes(b'not an actual recording')
        script = self.root / 'transcript.txt'
        script.write_text('声音测试')
        self.record['sources'] = [{'id': 's', 'url': 'https://example.invalid/voice', 'verification': 'not-verified'}]
        self.record['narration'] = [{'id': 'n', 'file': 'voice.wav', 'sha256': production.digest(audio),
                                    'origin': 'human-like', 'transcriptFile': 'transcript.txt',
                                    'sourceId': 's', 'license': 'fixture', 'licenseScope': 'personal-noncommercial'}]
        self.save()
        self.assertTrue(any('区分真人' in e for e in production.validate(self.root, 'record')['errors']))

    @unittest.skipUnless(shutil.which('ffprobe'), '本机无ffprobe，音频流检查未执行')
    def test_audio_stream_detection_is_not_listening_quality(self):
        audio = self.root / 'silence-fixture.wav'
        with wave.open(str(audio), 'wb') as stream:
            stream.setnchannels(1)
            stream.setsampwidth(2)
            stream.setframerate(8000)
            stream.writeframes(b'\0' * 1600)
        result = production.probe_audio(audio)
        self.assertGreater(result['duration'], 0)
        self.assertFalse(result['listened'])

    def test_course_gate_keeps_missing_app_voice_and_weave_visible(self):
        self.save()
        errors = production.validate(self.root, 'course')['errors']
        self.assertTrue(any('宿主App' in e for e in errors))
        self.assertTrue(any('实际旁白' in e for e in errors))
        self.assertTrue(any('自然结合' in e for e in errors))


class ChallengeTests(unittest.TestCase):
    def setUp(self):
        self.doc = json.loads((ROOT / 'examples/challenges.example.json').read_text())
        self.cap = json.loads((ROOT / 'examples/capabilities.example.json').read_text())
        self.audit = json.loads((ROOT / 'examples/constraints.example.json').read_text())

    def test_native_style_example_and_main_twin_constraints(self):
        result = challenges.validate(self.doc, self.cap, self.audit)
        self.assertEqual(result['errors'], [])
        self.assertTrue(result['warnings'])
        solutions = [f['constraintSolutions'] for f in result['findings'] if 'constraintSolutions' in f]
        self.assertEqual(solutions, [[{'a': 5, 'b': 3}], [{'a': 4, 'b': 3}]])

    def test_unsupported_rotation_is_not_enabled_by_content(self):
        self.doc['challenges'][1]['task']['type'] = 'rotate'
        self.assertTrue(any('没有宿主能力' in e for e in challenges.validate(self.doc, self.cap)['errors']))

    def test_start_equal_to_answer_requires_no_operation(self):
        self.doc['challenges'][1]['task']['start'] = {'a': 5, 'b': 3}
        self.assertTrue(any('初始场景已经' in e for e in challenges.validate(self.doc, self.cap)['errors']))

    def test_units_and_limits_are_checked(self):
        q = self.doc['challenges'][1]
        q['answers'][0]['value'] = 11
        q['answers'][1]['unit'] = '厘米'
        errors = challenges.validate(self.doc, self.cap)['errors']
        self.assertTrue(any('越界' in e for e in errors))
        self.assertTrue(any('单位' in e for e in errors))

    def test_two_valid_orderings_cannot_be_marked_unique(self):
        self.audit['buildConstraints'][0]['constraints'].pop()
        result = challenges.validate(self.doc, self.cap, self.audit)
        self.assertTrue(any('2个解' in e for e in result['errors']))

    def test_wrong_main_and_twin_answers_do_not_satisfy_conditions(self):
        self.doc['challenges'][1]['answers'][0]['value'] = 6
        self.doc['challenges'][1]['twin']['answers'][0]['value'] = 5
        errors = challenges.validate(self.doc, self.cap, self.audit)['errors']
        self.assertEqual(sum('不满足' in e for e in errors), 2)

    def test_legacy_shell_format_is_not_silently_accepted(self):
        self.doc['challenges'][0]['kind'] = 'choice'
        self.doc['challenges'][0]['answer'] = '20米'
        self.assertTrue(any('旧ZIP' in e for e in challenges.validate(self.doc, self.cap)['errors']))

    def test_field_contract_matches_current_app_not_only_json_validity(self):
        self.doc['challenges'][0]['options'][0] = {'text': '20米', 'why': 'not allowed by current host'}
        self.doc['challenges'][0]['answers'] = ['20米']
        errors = challenges.validate(self.doc, self.cap)['errors']
        self.assertTrue(any('options仅接受字符串' in e for e in errors))
        self.assertTrue(any('field/value' in e for e in errors))

    def test_fixed_parameter_is_not_optimized_away(self):
        q = self.doc['challenges'][1]
        q['task'] = {'type': 'build', 'start': {'a': 2, 'b': 3}, 'controls': ['a']}
        q['answers'] = [q['answers'][0]]
        self.assertEqual(challenges.validate(self.doc, self.cap, self.audit)['errors'], [])

    def test_malformed_option_and_twin_report_errors(self):
        self.doc['challenges'][0]['options'] = [[], 12]
        self.doc['challenges'][0]['twin'] = 'not an object'
        self.assertTrue(challenges.validate(self.doc, self.cap)['errors'])


if __name__ == '__main__':
    unittest.main()
