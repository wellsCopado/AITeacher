"""按主题做主角：主角卡 research/subject.json 和主角三维模型的最低线（规则见 references/topic-3d-production.md）。

check_package.py 调用它；App 导入时按 assets/hero-floor.json 同一套数查（apps/server/src/hero-check.ts）。
它能查出：没写清具体是哪一个、没有真实照片和尺寸、模型面数太少、没贴图、尺寸不是真实的、几何体拼的、代码里拼主角。
它查不出模型像不像：那要看画面对照图和家长预览。
"""
import fnmatch
import json
import re
import struct
from pathlib import Path

FLOOR = json.loads((Path(__file__).resolve().parents[1] / 'assets' / 'hero-floor.json').read_text(encoding='utf-8'))
MODEL = re.compile(r'\.(glb|gltf)$', re.I)
SOURCE = re.compile(r'\.(m?[jt]sx?)$', re.I)
CODE_GEOMETRY = re.compile(FLOOR['code_geometry'])


def image_size(b):
    """PNG 或 JPEG 的宽高；别的格式（KTX2、WebP）返回 None。"""
    if len(b) > 24 and b[:4] == b'\x89PNG':
        return struct.unpack('>II', b[16:24])
    if len(b) > 4 and b[:2] == b'\xff\xd8':
        i = 2
        while i + 9 < len(b):
            if b[i] != 0xff:
                i += 1
                continue
            m = b[i + 1]
            ln = struct.unpack('>H', b[i + 2:i + 4])[0]
            if 0xc0 <= m <= 0xcf and m not in (0xc4, 0xc8, 0xcc):
                h, w = struct.unpack('>HH', b[i + 5:i + 9])
                return w, h
            i += 2 + ln
    return None


def _trs(n):
    if n.get('matrix'):
        return n['matrix']
    x, y, z, w = n.get('rotation', [0, 0, 0, 1])
    sx, sy, sz = n.get('scale', [1, 1, 1])
    tx, ty, tz = n.get('translation', [0, 0, 0])
    return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
            2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
            2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
            tx, ty, tz, 1]


def _mul(a, b):
    o = [0.0] * 16
    for c in range(4):
        for r in range(4):
            o[c * 4 + r] = sum(a[k * 4 + r] * b[c * 4 + k] for k in range(4))
    return o


def glb_stats(data):
    """读 GLB 的 JSON 和二进制块：面数、每个图元的面数、贴图大小、材质、真实尺寸（米）、节点名。不对就抛 ValueError。"""
    if len(data) < 20 or data[:4] != b'glTF' or struct.unpack('<I', data[4:8])[0] != 2:
        raise ValueError('不是 GLB 2.0 文件')
    off, doc, binary = 12, None, b''
    while off + 8 <= len(data):
        ln, kind = struct.unpack('<II', data[off:off + 8])
        chunk = data[off + 8:off + 8 + ln]
        if kind == 0x4e4f534a:
            doc = json.loads(chunk.decode('utf-8'))
        elif kind == 0x004e4942:
            binary = chunk
        off += 8 + ln
    if doc is None:
        raise ValueError('GLB 里没有 JSON 块')
    acc, nodes, meshes = doc.get('accessors', []), doc.get('nodes', []), doc.get('meshes', [])
    tris, prims = 0, []
    lo, hi = [float('inf')] * 3, [float('-inf')] * 3
    eye = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

    def visit(i, parent, depth=0):
        nonlocal tris
        if i >= len(nodes) or depth > 64:
            return
        n = nodes[i]
        m = _mul(parent, _trs(n))
        for p in (meshes[n['mesh']].get('primitives', []) if 'mesh' in n and n['mesh'] < len(meshes) else []):
            a = acc[p['indices']] if 'indices' in p else acc[p['attributes']['POSITION']]
            t = a.get('count', 0) // 3 if p.get('mode', 4) == 4 else 0
            tris += t
            prims.append(t)
            pos = acc[p['attributes']['POSITION']]
            if pos.get('min') and pos.get('max'):
                for c in range(8):
                    v = [pos['max'][k] if c >> k & 1 else pos['min'][k] for k in range(3)]
                    for r in range(3):
                        wv = m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r]
                        lo[r], hi[r] = min(lo[r], wv), max(hi[r], wv)
        for c in n.get('children', []):
            visit(c, m, depth + 1)

    roots = (doc.get('scenes') or [{}])[doc.get('scene', 0)].get('nodes') if doc.get('scenes') else list(range(len(nodes)))
    for r in roots or []:
        visit(r, eye)
    views, images = doc.get('bufferViews', []), doc.get('images', [])

    def tex_size(tex):
        if tex is None or tex >= len(doc.get('textures', [])):
            return None
        t = doc['textures'][tex]
        src = t.get('source', next((e.get('source') for e in (t.get('extensions') or {}).values()), None))
        img = images[src] if src is not None and src < len(images) else {}
        if 'bufferView' in img and binary:
            v = views[img['bufferView']]
            return image_size(binary[v.get('byteOffset', 0):v.get('byteOffset', 0) + v['byteLength']]) or 'unknown'
        return 'unknown'
    base_sizes, detail = [], 0
    for mat in doc.get('materials', []):
        pbr = mat.get('pbrMetallicRoughness', {})
        if 'baseColorTexture' in pbr:
            base_sizes.append(tex_size(pbr['baseColorTexture'].get('index')))
        if 'normalTexture' in mat or 'metallicRoughnessTexture' in pbr:
            detail += 1
    names = [n.get('name', '') for n in nodes] + [m.get('name', '') for m in meshes]
    size = [round(hi[k] - lo[k], 3) for k in range(3)] if lo[0] != float('inf') else None
    return {'triangles': tris, 'primitives': prims, 'baseColorTextures': base_sizes, 'detailMaterials': detail,
            'materials': len(doc.get('materials', [])), 'size': size, 'names': [x for x in names if x]}


def check_hero(read, names, base, manifest, items):
    """read(name) 读包里的文件；names 是包里所有文件名；items 是 research/assets.json 的 items。返回 (errors, warnings, facts)。"""
    e, w = [], []
    names = set(names)
    has = names.__contains__
    try:
        card = json.loads(read(base + 'research/subject.json').decode('utf-8'))
    except KeyError:
        return ['没有主角卡 research/subject.json：动手建模前先写清主角具体是哪一个、真实照片、真实尺寸、辨识特征和怎么做出来（见 references/topic-3d-production.md）'], w, {}
    except (ValueError, UnicodeDecodeError) as error:
        return [f'research/subject.json 不是合法的 JSON：{error}'], w, {}
    if not isinstance(card, dict):
        return ['research/subject.json 要写成对象'], w, {}
    topic = str(manifest.get('topic') or '').strip()
    kind = card.get('kind')
    if topic and str(card.get('topic') or '').strip() != topic:
        e.append(f'主角卡的 topic（{card.get("topic")!r}）和 exploration.json 的「{topic}」不一样')
    if not str(card.get('instance') or '').strip():
        e.append('主角卡没写 instance：主角具体是哪一个（哪种型号、哪个物种、哪座建筑），不能只写泛称')
    if kind not in FLOOR['kinds']:
        e.append(f'主角卡的 kind 写 {"/".join(FLOOR["kinds"])} 之一：{kind!r}')
        kind = 'other'

    refs = [r for r in card.get('references') or [] if isinstance(r, dict)]
    good_refs = [r for r in refs if str(r.get('source') or '').strip() and str(r.get('angle') or '').strip()]
    if len(good_refs) < FLOOR['min_references']:
        e.append(f'主角卡的 references 要至少 {FLOOR["min_references"]} 张真实照片（写 angle 角度和 source 来源），现在 {len(good_refs)} 张')
    if len({r['angle'] for r in good_refs}) < FLOOR['min_angles']:
        e.append(f'参考照片要至少 {FLOOR["min_angles"]} 个不同角度（正面、侧面、俯视、近景……）')
    missing = [r['file'] for r in refs if r.get('file') and not has(base + r['file'])]
    if missing:
        e.append(f'参考照片不在包里：{missing[:3]}（放在 research/ 下，家长要对着看）')
    for r in refs:
        if any(x.lower() in str(r.get('note', '')).lower() for x in FLOOR['banned_words']):
            e.append(f'参考 {r.get("file") or r.get("source")} 是卡通或风格化的：参考只用真实照片')

    dims = [d for d in card.get('dimensions') or [] if isinstance(d, dict)]
    good_dims = [d for d in dims if d.get('what') and isinstance(d.get('meters'), (int, float)) and d['meters'] > 0 and str(d.get('source') or '').strip()]
    if len(good_dims) < FLOOR['min_dimensions']:
        e.append(f'主角卡的 dimensions 要至少 {FLOOR["min_dimensions"]} 条真实尺寸 {{what, meters, source}}，现在 {len(good_dims)} 条')
    main = next((d for d in good_dims if d.get('main')), None)
    if good_dims and not main:
        e.append('dimensions 里标一条 "main": true（主角最大的那个尺寸，模型按它核对大小）')

    feats = [f for f in card.get('features') or [] if isinstance(f, dict) and str(f.get('name') or '').strip()]
    if len(feats) < FLOOR['min_features']:
        e.append(f'主角卡的 features 要至少 {FLOOR["min_features"]} 个辨识特征（一眼认出它的地方，每个写模型里的节点名 node），现在 {len(feats)} 个')
    route = card.get('route') if isinstance(card.get('route'), dict) else {}
    if route.get('hero') not in FLOOR['routes']:
        e.append(f'主角卡的 route.hero 写 {"/".join(FLOOR["routes"])} 之一：怎么把真实的它做成三维')
    elif route['hero'] == 'modeled-from-reference' and kind in FLOOR['no_reference_modeling']:
        e.append('动物不走“照着照片手工建模”：用扫描件、摄影测量或有许可的写实成品，再修整和绑骨骼')
    if not str(route.get('why') or '').strip():
        e.append('route.why 没写：为什么选这条路线、试过哪些来源')

    heroes = [i for i in items if isinstance(i, dict) and i.get('role') == 'hero']
    facts = {'subject': card.get('instance'), 'kind': kind, 'route': route.get('hero')}
    for hero in heroes:
        f = str(hero.get('file') or '')
        if hero.get('origin') in FLOOR['banned_origins']:
            e.append(f'主角 {f} 的 origin 是 {hero["origin"]}：主角不能用程序几何体拼或手绘，按 route 用真实来源做')
        if any(x.lower() in (str(hero.get('depicts', '')) + str(hero.get('how', ''))).lower() for x in FLOOR['banned_words']):
            e.append(f'主角 {f} 是低多边形、卡通或风格化的：换写实的')
        if not MODEL.search(f) or not has(base + f):
            continue
        try:
            s = glb_stats(read(base + f))
        except (ValueError, KeyError, IndexError, struct.error) as error:
            e.append(f'主角模型 {f} 读不了：{error}')
            continue
        facts.update({'heroTriangles': s['triangles'], 'heroSize': s['size']})
        need = FLOOR['min_triangles'][kind]
        if s['triangles'] < need:
            e.append(f'主角模型 {f} 只有 {s["triangles"]} 个三角面，{FLOOR["kinds"][kind].split("（")[0]}至少 {need} 个：面太少就是方块拼的样子')
        prims = s['primitives']
        small = sum(1 for t in prims if t <= FLOOR['primitive_triangles'])
        if len(prims) >= 6 and small / len(prims) > FLOOR['primitive_share']:
            e.append(f'主角模型 {f} 有 {small}/{len(prims)} 个部件只有几十个面（方块、圆柱、球）：像几何体拼的，换真实来源')
        if not s['baseColorTextures']:
            e.append(f'主角模型 {f} 没有颜色贴图：只有纯色材质，像塑料玩具')
        else:
            px = [max(x) for x in s['baseColorTextures'] if isinstance(x, tuple)]
            if px and max(px) < FLOOR['min_texture_px']:
                e.append(f'主角模型 {f} 的颜色贴图最大只有 {max(px)} 像素，至少 {FLOOR["min_texture_px"]}')
        if not s['detailMaterials']:
            e.append(f'主角模型 {f} 没有法线或粗糙度贴图：表面没有细节')
        if main and s['size']:
            big, real = max(s['size']), float(main['meters'])
            if not (1 - FLOOR['size_tolerance']) * real <= big <= (1 + FLOOR['size_tolerance']) * real:
                e.append(f'主角模型 {f} 最长 {big:g} 米，真实的「{main["what"]}」是 {real:g} 米：模型要按真实尺寸做（1 单位 = 1 米）')
        lost = [x['name'] for x in feats if x.get('node') and not any(fnmatch.fnmatch(n, x['node']) for n in s['names'])]
        unbound = [x['name'] for x in feats if not x.get('node')]
        if lost:
            e.append(f'这些辨识特征在模型里找不到对应节点：{lost[:4]}（节点名写进 features[].node，可用 * 通配）')
        if unbound:
            e.append(f'这些辨识特征没写 node：{unbound[:4]}')

    sources = [n for n in sorted(names) if n.startswith(base + 'web/src/') and SOURCE.search(n)]
    if not sources:
        w.append('课程包里没有 web/src 源码：查不了有没有在代码里用几何体拼主角和环境')
    lines = []
    for n in sources:
        for i, line in enumerate(read(n).decode('utf-8', 'replace').splitlines(), 1):
            if CODE_GEOMETRY.search(line) and FLOOR['code_geometry_allow'] not in line:
                lines.append(f'{n[len(base):]}:{i}')
    if lines:
        e.append(f'代码里用几何体拼了 {len(lines)} 处画面：{lines[:4]}。主角、部件和环境都要来自真实来源的模型和扫描贴图；'
                 f'只有界面标记（箭头、高亮圈、刻度）可以，在那一行写注释 {FLOOR["code_geometry_allow"]}: 用途')
    return e, w, facts
