#!/usr/bin/env python3
"""交给 AI 探索世界 App 之前预检探索课包（目录或 .zip）：按 App 导入时的同一套规则查结构、路径、进度接口和大小。
只做静态检查，不运行网页；能否在 App 里打开、画面和教学是否合格，要导入后在「课程库 → 探索课」预览。"""
import argparse
import json
import os
import re
import zipfile
from pathlib import Path, PurePosixPath

PAGES = ['web/dist/index.html', 'site/index.html', 'dist/index.html', 'index.html']
SKIP_DIRS = ('node_modules', '.git', '__MACOSX')
SKIP = re.compile(r'(^|/)(__MACOSX|node_modules|\.git)/|(^|/)\.DS_Store$')
SECRET = re.compile(r'(^|/)(\.env(\.[^/]*)?|id_rsa|id_ed25519|[^/]+\.(pem|key|p12|pfx|jks|keystore))$', re.I)
DOCS = ['README.md', '课程设计.md', '验收结果.md']
MEDIA = r'glb|gltf|bin|png|jpe?g|webp|avif|ktx2|hdr|exr|m4a|mp3|wav|ogg|mp4|webm|wasm|json|woff2?|js|mjs|css'
ABSOLUTE = re.compile(r'''["'`(]/(?!/)[\w.\-/]+\.(?:%s)\b''' % MEDIA)
# 运行时要下载的外网文件；给大人核对的 <a href> 来源链接不算
EXTERNAL = re.compile(r'''(?:\bsrc\s*=\s*["']|<link\b[^>]*\bhref\s*=\s*["']|\bfrom\s*["']|\bimport\(\s*["']|\bfetch\(\s*["']|url\(\s*["']?)https?://|https?://[^\s"'`)<>]+\.(?:%s)(?=[?#"'`)\s]|$)''' % MEDIA)
SOURCE_PAGE = re.compile(r'''<script[^>]+src=["']/?src/[^"']+\.(m?js|ts)["']''')
SOFT_LIMIT, HARD_LIMIT, MAX_FILES = 150 * 2**20, 800 * 2**20, 5000


def zip_name(info):
    # 没标 UTF-8 的中文文件名（macOS/Windows 压缩）按 UTF-8 还原，和 App 一致
    if info.flag_bits & 0x800:
        return info.filename
    try:
        return info.filename.encode('cp437').decode('utf-8')
    except (UnicodeEncodeError, UnicodeDecodeError):
        return info.filename


def safe(name):
    return (bool(name) and not name.startswith('/') and '\\' not in name and '\0' not in name
            and all(part not in ('', '..') for part in name.split('/')))


class Package:
    def __init__(self, path):
        self.path, self.skipped = path, set()
        if path.is_dir():
            self.zip, self.files = None, {}
            for top, dirs, files in os.walk(path):
                here = Path(top)
                for name in [d for d in dirs if d in SKIP_DIRS]:
                    dirs.remove(name)  # 不往里走，只提醒打包时去掉
                    self.skipped.add(name)
                for name in files + [d for d in dirs if (here / d).is_symlink()]:
                    self.files[(here / name).relative_to(path).as_posix()] = here / name
            self.sizes = {name: p.lstat().st_size for name, p in self.files.items()}
            self.links = {name for name, p in self.files.items() if p.is_symlink()}
        else:
            self.zip = zipfile.ZipFile(path)
            infos = [i for i in self.zip.infolist() if not i.is_dir()]
            self.files = {zip_name(i): i for i in infos}
            self.sizes = {zip_name(i): i.file_size for i in infos}
            self.links = {zip_name(i) for i in infos if (i.external_attr >> 16) & 0o170000 == 0o120000}

    def read(self, name):
        item = self.files[name]
        return item.read_bytes() if self.zip is None else self.zip.read(item)


def check(path):
    errors, warnings, facts = [], [], {}
    try:
        pkg = Package(path)
    except (zipfile.BadZipFile, OSError) as error:
        return {'errors': [f'打不开课程包：{error}'], 'warnings': [], 'checks': {}}
    names = [n for n in pkg.files if not SKIP.search(n)]
    skipped = sorted(pkg.skipped | {m.group(2) or '.DS_Store' for n in pkg.files if (m := SKIP.search(n))})
    if skipped:
        warnings.append(f'包里有 App 会丢掉的 {", ".join(skipped[:3])}：打包时去掉，包会小很多')
    unsafe = [n for n in names if not safe(n)]
    if unsafe:
        errors.append(f'不安全的文件路径（App 会整包拒收）：{unsafe[:3]}')
    if pkg.links:
        errors.append(f'包里有符号链接，打包时换成实际文件：{sorted(pkg.links)[:3]}')
    secrets = [n for n in names if SECRET.search(n)]
    if secrets:
        errors.append(f'课程包不能带账户和密钥文件：{secrets[:3]}')
    has = set(names)
    depth = lambda n: n.count('/')

    manifest, base = {}, ''
    found = sorted((n for n in names if PurePosixPath(n).name == 'exploration.json'), key=depth)
    if found:
        base = found[0][:-len('exploration.json')]
        try:
            manifest = json.loads(pkg.read(found[0]).decode('utf-8'))
            if not isinstance(manifest, dict):
                raise ValueError('不是对象')
        except (ValueError, UnicodeDecodeError) as error:
            errors.append(f'exploration.json 不是合法的 JSON：{error}')
            manifest = {}
    else:
        warnings.append('没有 exploration.json：App 只能从网页标题和文件夹名猜课名、年级，家长导入时可能要自己选给谁')
        pages = sorted((n for n in names if any(n == p or n.endswith('/' + p) for p in PAGES)),
                       key=lambda n: (next(i for i, p in enumerate(PAGES) if n.endswith(p)), depth(n)))
        if pages:
            page = pages[0]
            base = page[:len(page) - len(next(p for p in PAGES if page.endswith(p)))]

    lesson_id, version = manifest.get('id'), manifest.get('version')
    if manifest:
        if manifest.get('format') not in (None, 'adw-explore/1'):
            errors.append(f'format 应为 adw-explore/1，现在是 {manifest.get("format")!r}')
        if lesson_id is None:
            warnings.append('exploration.json 没写 id：App 会用包名代替，改版时就接不上旧版本')
        elif not (isinstance(lesson_id, str) and re.fullmatch(r'X-[A-Za-z0-9-]{1,48}', lesson_id)):
            errors.append(f'id 要以 X- 开头，只用英文字母、数字和连字符：{lesson_id!r}')
        if version is not None and not (isinstance(version, str) and re.fullmatch(r'\d+\.\d+', version)):
            errors.append(f'version 写成 "1.0" 这样的字符串：{version!r}')
        grade = manifest.get('grade')
        if grade is not None and not (isinstance(grade, int) and 1 <= grade <= 6):
            errors.append(f'grade 写 1–6 的数字：{grade!r}')
        if grade is None and not manifest.get('for_child'):
            warnings.append('没写 grade 或 for_child：家长导入时要自己选给谁')
        if not str(manifest.get('title', '')).strip():
            warnings.append('没写 title：App 用网页标题代替')

    entry = manifest.get('entry')
    if entry is not None and not (isinstance(entry, str) and safe(entry) and base + entry in has):
        errors.append(f'entry 指的网页不在包里：{entry!r}')
        entry = None
    entry = entry or next((p for p in PAGES if base + p in has), None)
    if not entry:
        errors.append('没有构建好的网页（web/dist/index.html）：先 vite build，再把 web/dist 打进包里')
        return {'errors': errors, 'warnings': warnings, 'checks': facts}

    site_dir = str(PurePosixPath(base + entry).parent)
    prefix = '' if site_dir == '.' else site_dir + '/'
    site = [n for n in names if n.startswith(prefix)]
    size = sum(pkg.sizes[n] for n in site)
    html = pkg.read(base + entry).decode('utf-8', 'replace')
    if SOURCE_PAGE.search(html):
        errors.append('入口是没构建的源码页面（引用 /src/…）：先 vite build，把 web/dist 打进包里')
    if len(site) > MAX_FILES or size > HARD_LIMIT:
        errors.append(f'网页部分 {size / 2**20:.0f} MB、{len(site)} 个文件，超过 App 上限（800 MB / 5000 个）')
    elif size > SOFT_LIMIT:
        warnings.append(f'网页部分 {size / 2**20:.0f} MB，平板第一次打开会慢；压缩模型和贴图，尽量在 150 MB 以内')

    absolute, external, bridge = set(), set(), False
    for name in site:
        if not re.search(r'\.(html|m?js|css)$', name):
            continue
        text = pkg.read(name).decode('utf-8', 'replace')
        bridge = bridge or 'explore/1' in text
        rel = name[len(prefix):]
        if ABSOLUTE.search(text) or (name.endswith('.html') and re.search(r'''(src|href)=["']/(?!/)''', text)):
            absolute.add(rel)
        if EXTERNAL.search(text):
            external.add(rel)
    if absolute:
        warnings.append(f'用了绝对路径（/models/… 这类）：{sorted(absolute)[:3]}。vite 写 base: "./"，代码里写 ./models/…；App 会尽量转接，但家长卡片上会提示')
    if external:
        warnings.append(f'运行时要连外网：{sorted(external)[:3]}。平板只连家里的 Mac，把这些文件放进包里')
    if not bridge:
        warnings.append('没接 App 的进度接口：复制 assets/web/adw-host.mjs 进源码并调用 ready/report/onHost，不然 App 不知道孩子做到哪')
    missing_docs = [d for d in DOCS if base + d not in has]
    if missing_docs:
        warnings.append(f'缺少给家长看的说明：{missing_docs}')
    if not any(n.startswith(base + 'licenses/') for n in has) and base + 'research/sources.json' not in has:
        warnings.append('没有 licenses/ 或 research/sources.json：素材的许可和来源要随课保存')

    facts.update({'root': base or '.', 'entry': entry, 'id': lesson_id, 'version': version,
                  'siteFiles': len(site), 'siteMB': round(size / 2**20, 1), 'bridge': bridge})
    return {'errors': errors, 'warnings': warnings, 'checks': facts}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('package', type=Path, help='课程包目录或 .zip')
    args = parser.parse_args()
    result = check(args.package)
    result['meaning'] = '只按 App 导入规则做静态检查；不运行网页，不证明画面、科学或教学合格。导入后在 App 里预览一遍。'
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(bool(result['errors']))


if __name__ == '__main__':
    main()
