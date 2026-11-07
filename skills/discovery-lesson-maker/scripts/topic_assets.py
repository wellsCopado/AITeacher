"""写啥主题就做啥图片：查课程包的画面是不是为这个主题做的（规则见 references/topic-assets.md）。

check_package.py 调用它；App 导入时按同一套规则查，另外还查画面文件和别的课是否一模一样（这里看不到别的课）。
它只核对清单和文件对得上、写全了；画面像不像真的那个主题，要看画面对照图和预览。
"""
import hashlib
import json
import re

# 孩子看得到的画面文件：图片、贴图、模型、视频。声音、字体、代码不算
VISUAL = re.compile(r'\.(png|jpe?g|webp|avif|gif|svg|ktx2|basis|hdr|exr|glb|gltf|usdz|fbx|obj|drc|mp4|webm|mov|m4v)$', re.I)
MODEL = re.compile(r'\.(glb|gltf|usdz|fbx|obj|drc)$', re.I)
MIN_BYTES = 1024  # 更小的多半是界面小图标，不要求登记
ORIGINS = {'modeled', 'procedural', 'scan', 'cad', 'photo', 'cc0-library', 'licensed', 'generated', 'rendered', 'drawn'}
ROLES = {'hero', 'part', 'scene', 'picture', 'video', 'ui'}
# App 里固定场景和示例课的东西：不是这节课的主题却出现在素材清单里，多半是照搬
APP_SCENE_THINGS = ['机械臂', '齿轮', '转台', '积木', '珊瑚', '螳螂虾', '卷尺', '样方', 'PVC', '测距轮', '栅栏', '地砖', '石板']


def common(a, b, n=2):
    """a 和 b 有没有连续 n 个字一样（主题「火箭发射」和主角「长征二号F火箭」有「火箭」）。"""
    return any(a[i:i + n] in b for i in range(len(a) - n + 1)) if len(a) >= n else a in b


def check_assets(read, site, base, prefix, manifest):
    """read(name) 读包里的文件；site 是网页部分的文件名；base 是包根；prefix 是网页目录。返回 (errors, warnings, facts)。"""
    errors, warnings = [], []
    topic = str(manifest.get('topic') or '').strip()
    if not topic:
        errors.append('exploration.json 没写 topic：写家长给的主题原词（例如 "火箭发射"），画面要按它检查')
    name = base + 'research/assets.json'
    try:
        listing = json.loads(read(name).decode('utf-8'))
    except KeyError:
        return errors + ['没有素材清单 research/assets.json：孩子看到的每张图、每个模型、贴图和视频都要登记画的是什么、为哪个主题做、从哪来'
                         '（格式见 references/topic-assets.md）'], warnings, {'topic': topic, 'assets': 0}
    except (ValueError, UnicodeDecodeError) as error:
        return errors + [f'research/assets.json 不是合法的 JSON：{error}'], warnings, {'topic': topic, 'assets': 0}
    items = listing.get('items') if isinstance(listing, dict) else None
    if not isinstance(items, list):
        return errors + ['research/assets.json 要写成 {"topic": "…", "items": [ … ]}'], warnings, {'topic': topic, 'assets': 0}
    if topic and str(listing.get('topic') or '').strip() != topic:
        errors.append(f'素材清单的 topic（{listing.get("topic")!r}）和 exploration.json 的「{topic}」不一样')

    every, hashes = {}, {}  # 网页里所有画面文件；其中够大、必须登记的
    for full in site:
        rel = full[len(prefix):]
        if VISUAL.search(rel):
            data = read(full)
            digest = hashlib.sha256(data).hexdigest()
            every[digest] = rel
            if len(data) >= MIN_BYTES:
                hashes[digest] = rel
    listed, heroes, made_elsewhere, missing = set(), [], [], {}
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            errors.append(f'素材清单第 {i + 1} 项不是对象')
            continue
        label = item.get('file') or f'第 {i + 1} 项'
        role = item.get('role')
        if role not in ROLES:
            errors.append(f'{label}：role 写 {"/".join(sorted(ROLES))} 之一（主角 hero、主角部件 part、环境 scene、题目和讲解配图 picture、视频 video、界面图标 ui）')
        need = ['file', 'depicts', 'origin', 'license'] + ([] if role == 'ui' else ['made_for', 'sha256'])
        gaps = [k for k in need if not str(item.get(k) or '').strip()]
        if not (str(item.get('how') or '').strip() or item.get('sourceIds') or str(item.get('source') or '').strip()):
            gaps.append('how 或 sourceIds')
        if gaps:
            missing[label] = gaps
        if item.get('origin') and item.get('origin') not in ORIGINS:
            errors.append(f'{label}：origin 写 {"/".join(sorted(ORIGINS))} 之一，现在是 {item.get("origin")!r}')
        if role != 'ui' and topic and item.get('made_for') and str(item['made_for']).strip() != topic:
            made_elsewhere.append(f'{label}（给「{item["made_for"]}」做的）')
        sha = str(item.get('sha256') or '').lower()
        if sha:
            listed.add(sha)
            if sha not in every:
                warnings.append(f'{label}：网页里没有 sha256 对得上的文件（文件改过就重新算：shasum -a 256 文件）')
        if role == 'hero':
            heroes.append(item)
        if role != 'ui' and topic:
            depicts = str(item.get('depicts') or '')
            borrowed = [w for w in APP_SCENE_THINGS if w in depicts and w not in topic]
            if borrowed:
                warnings.append(f'{label} 画的是「{depicts}」：{"、".join(borrowed)}是 App 固定场景里的东西，确认它真是「{topic}」里有的，不是照搬')
    for label, gaps in list(missing.items())[:8]:
        errors.append(f'素材清单 {label} 没写：{"、".join(gaps)}')
    if made_elsewhere:
        errors.append(f'这些素材不是为「{topic}」做的：{made_elsewhere[:5]}。每节课的画面按自己的主题现做现找，不拿别的课、别的主题的')
    unlisted = sorted(rel for h, rel in hashes.items() if h not in listed)
    if unlisted:
        errors.append(f'{len(unlisted)} 个画面文件不在素材清单里（按 sha256 对）：{unlisted[:5]}。每张图、每个模型都登记，说清画的是什么、从哪来')
    if not heroes:
        errors.append('素材清单里没有主角（role 为 hero 的三维模型）：主题本身要有真三维的主角')
    for hero in heroes:
        if not MODEL.search(str(hero.get('file') or '')):
            errors.append(f'主角 {hero.get("file")} 不是三维模型（glb/gltf…）：照片、视频、截图不能代替可以转着看的主角')
        if topic and not common(topic, str(hero.get('depicts') or '')):
            errors.append(f'主角画的是「{hero.get("depicts")}」，主题是「{topic}」：主角要写出主题里的那个东西（例如主题「火箭发射」写「长征二号F火箭」）')
    return errors, warnings, {'topic': topic, 'assets': len(items), 'visualFiles': len(hashes)}
