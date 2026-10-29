"""探索课包预检：和 App 导入规则一致；夹具只是几行网页，不是课程。"""
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from check_package import check

BRIDGE = (ROOT / 'assets/web/adw-host.mjs').read_text(encoding='utf-8')
MANIFEST = {'format': 'adw-explore/1', 'id': 'X-BRIDGE', 'version': '1.0', 'title': '大桥', 'grade': 4,
            'entry': 'web/dist/index.html'}


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / '大桥_四年级探索课'
        self.write('exploration.json', json.dumps(MANIFEST, ensure_ascii=False))
        self.write('web/dist/index.html', '<!doctype html><title>大桥</title><script type="module" src="./assets/index.js"></script>')
        self.write('web/dist/assets/index.js', BRIDGE + "\nfetch('./models/bridge.glb');")
        self.write('web/dist/models/bridge.glb', 'glTF')
        for doc in ('README.md', '课程设计.md', '验收结果.md', 'licenses/README.md'):
            self.write(doc, '# 说明')

    def tearDown(self):
        self.temp.cleanup()

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')

    def zipped(self, extra=()):
        out = self.root.parent / 'pkg.zip'
        with zipfile.ZipFile(out, 'w') as z:
            for p in sorted(self.root.rglob('*')):
                if p.is_file():
                    z.write(p, f'{self.root.name}/{p.relative_to(self.root).as_posix()}')
            for name, data in extra:
                z.writestr(name, data)
        return out

    def test_a_ready_package_passes_as_folder_and_zip(self):
        for target in (self.root, self.zipped()):
            result = check(target)
            self.assertEqual(result['errors'], [], target)
            self.assertEqual(result['warnings'], [], target)
            self.assertTrue(result['checks']['bridge'])
            self.assertEqual(result['checks']['id'], 'X-BRIDGE')

    def test_unbuilt_source_page_is_refused(self):
        (self.root / 'web/dist').rename(self.root / 'web/built')
        self.write('web/index.html', '<script type="module" src="/src/main.mjs"></script>')
        self.write('exploration.json', json.dumps({**MANIFEST, 'entry': None}))
        self.assertIn('没有构建好的网页', ' '.join(check(self.root)['errors']))
        self.write('index.html', '<script type="module" src="/src/main.mjs"></script>')
        self.assertIn('没构建的源码页面', ' '.join(check(self.root)['errors']))

    def test_absolute_paths_cdn_and_missing_bridge_are_warned(self):
        self.write('web/dist/assets/index.js', "import * as T from 'https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js';\nload('/models/bridge.glb');")
        warnings = ' '.join(check(self.root)['warnings'])
        self.assertIn('绝对路径', warnings)
        self.assertIn('连外网', warnings)
        self.assertIn('进度接口', warnings)

    def test_source_links_for_adults_are_not_runtime_downloads(self):
        self.write('web/dist/assets/more.js', 'x=`<a target="_blank" href="https://www.openstreetmap.org/copyright">OSM</a><a href="https://example.org/report.pdf">报告</a>`')
        self.assertEqual(check(self.root)['warnings'], [])

    def test_bad_manifest_fields_are_errors(self):
        self.write('exploration.json', json.dumps({**MANIFEST, 'id': 'bridge lesson', 'version': 1.1, 'grade': '四'}))
        errors = ' '.join(check(self.root)['errors'])
        for words in ('X- 开头', '"1.0"', '1–6'):
            self.assertIn(words, errors)
        self.write('exploration.json', '{"id": ')
        self.assertIn('不是合法的 JSON', ' '.join(check(self.root)['errors']))

    def test_secrets_unsafe_paths_and_node_modules(self):
        result = check(self.zipped([('大桥_四年级探索课/.env', 'KEY=1'), ('../evil.js', 'x'),
                                    ('大桥_四年级探索课/web/node_modules/three/index.js', 'x')]))
        errors = ' '.join(result['errors'])
        self.assertIn('密钥', errors)
        self.assertIn('不安全的文件路径', errors)
        self.assertIn('node_modules', ' '.join(result['warnings']))

    def test_chinese_names_from_a_zip_without_utf8_flag(self):
        class Legacy(zipfile.ZipInfo):  # 名字是 UTF-8 字节却不标 UTF-8，像一些老压缩工具那样
            def _encodeFilenameFlags(self):
                return self.filename.encode('utf-8'), self.flag_bits & ~0x800

        out = self.root.parent / 'mac.zip'
        with zipfile.ZipFile(out, 'w') as z:
            for p in sorted(self.root.rglob('*')):
                if p.is_file():
                    z.writestr(Legacy(f'{self.root.name}/{p.relative_to(self.root).as_posix()}'), p.read_bytes())
        with zipfile.ZipFile(out) as z:
            self.assertNotIn('大桥', z.namelist()[0])
        result = check(out)
        self.assertEqual(result['errors'], [])
        self.assertEqual(result['checks']['root'], '大桥_四年级探索课/')


if __name__ == '__main__':
    unittest.main()
