"""主角三维模型的硬门槛（规则见 references/hero-production.md）。

topic_assets.py 查“画面是不是为这个主题做的”；这里查“主角是不是能当真看的写实模型”：
  H1 主角是哪一类东西（class）
  H2 这一类允许的来源（动物、人不能手工建模或程序生成）
  H3 来源证据：≥3 张不同角度的真实照片，扫描/图纸/素材库写出处，AI 生成写工具和输入照片
  H4 真实尺寸：模型包围盒和登记的真实尺寸差不超过 10%
  H5 细节：三角形数不低于这一类的下限
  H6 材质：贴了图的面 ≥ 80%，有 ≥1024 像素的颜色贴图，有法线或粗糙度贴图（纯色拼件过不了）
  H7 盲看：visual_gate.blind_review 里，不知道哪张是照片的审看人，对每个角度都说“同一个东西、不像动画片或玩具”
App 导入时用同一套规则（apps/server/src/hero-check.ts）。过了只说明不是代码拼的、不是纯色卡通件；像不像由家长看对照图。
"""
import json
import struct

CLASSES = {
    'organism': '动物、昆虫、植物等生物',
    'human': '人',
    'machine': '机器、机器人、机械臂',
    'vehicle': '车、船、飞机、火箭',
    'structure': '建筑、桥、隧道、塔',
    'landform': '山、火山、峡谷等地形',
    'object': '工具、器物等小物件',
}
# H2：每一类允许的来源。生物和人只能来自实物（扫描、素材库、授权）或依据真实照片生成；不能在 Blender 或代码里“照着画”
ROUTES = {
    'organism': {'scan', 'cc0-library', 'licensed', 'generated'},
    'human': {'scan', 'cc0-library', 'licensed', 'generated'},
    'machine': {'scan', 'cad', 'cc0-library', 'licensed', 'generated', 'modeled'},
    'vehicle': {'scan', 'cad', 'cc0-library', 'licensed', 'generated', 'modeled'},
    'structure': {'scan', 'cad', 'cc0-library', 'licensed', 'generated', 'modeled'},
    'landform': {'scan', 'cc0-library', 'licensed', 'generated', 'modeled', 'procedural'},
    'object': {'scan', 'cad', 'cc0-library', 'licensed', 'generated', 'modeled'},
}
# H5：三角形数下限。真实扫描和厂家图纸远高于这个数；代码拼的、低多边形的过不了
MIN_TRIANGLES = {'organism': 15000, 'human': 20000, 'machine': 12000, 'vehicle': 12000, 'structure': 8000, 'landform': 8000, 'object': 4000}
MIN_TEXTURE_PX = 1024
MIN_TEXTURED_SHARE = 0.8
SIZE_TOLERANCE = 0.10
VERDICTS = {'photo': '像照片', 'cg': '看得出是电脑画面', 'cartoon': '像动画片', 'toy': '像玩具或模型'}


def _dims(data):
    """图片宽高：PNG、JPEG、WebP、KTX2。认不出返回 None。"""
    if data[:8] == b'\x89PNG\r\n\x1a\n' and len(data) >= 24:
        return struct.unpack('>II', data[16:24])
    if data[:12] == b'\xabKTX 20\xbb\r\n\x1a\n' and len(data) >= 28:
        return struct.unpack('<II', data[20:28])
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP' and len(data) >= 30:
        kind = data[12:16]
        if kind == b'VP8X':
            return 1 + int.from_bytes(data[24:27], 'little'), 1 + int.from_bytes(data[27:30], 'little')
        if kind == b'VP8L':
            b = int.from_bytes(data[21:25], 'little')
            return 1 + (b & 0x3FFF), 1 + ((b >> 14) & 0x3FFF)
        if kind == b'VP8 ':
            return struct.unpack('<HH', data[26:30])[0] & 0x3FFF, struct.unpack('<HH', data[26:30])[1] & 0x3FFF
    if data[:2] == b'\xff\xd8':
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                h, w = struct.unpack('>HH', data[i + 5:i + 9])
                return w, h
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            i += 2 + struct.unpack('>H', data[i + 2:i + 4])[0]
    return None


def _mat(node):
    if 'matrix' in node:
        m = node['matrix']
        return [[m[c * 4 + r] for c in range(4)] for r in range(4)]
    tx, ty, tz = node.get('translation', [0, 0, 0])
    x, y, z, w = node.get('rotation', [0, 0, 0, 1])
    sx, sy, sz = node.get('scale', [1, 1, 1])
    r = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
         [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
         [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
    return [[r[0][0] * sx, r[0][1] * sy, r[0][2] * sz, tx], [r[1][0] * sx, r[1][1] * sy, r[1][2] * sz, ty],
            [r[2][0] * sx, r[2][1] * sy, r[2][2] * sz, tz], [0, 0, 0, 1]]


def _mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


NORMALIZED = {5120: 127.0, 5121: 255.0, 5122: 32767.0, 5123: 65535.0}


def inspect_glb(data):
    """读 .glb 的 JSON 和内嵌图片，不解压几何（Draco/meshopt 压缩也能读）。返回数字；读不了抛 ValueError。"""
    if len(data) < 20 or data[:4] != b'glTF':
        raise ValueError('不是 .glb 文件（开头不是 glTF）')
    length = struct.unpack('<I', data[8:12])[0]
    chunk_len, chunk_type = struct.unpack('<II', data[12:20])
    if chunk_type != 0x4E4F534A:
        raise ValueError('.glb 第一块不是 JSON')
    gltf = json.loads(data[20:20 + chunk_len].decode('utf-8'))
    binary = b''
    at = 20 + chunk_len
    if at + 8 <= min(length, len(data)):
        blen, btype = struct.unpack('<II', data[at:at + 8])
        if btype == 0x004E4942:
            binary = data[at + 8:at + 8 + blen]
    accessors, views = gltf.get('accessors', []), gltf.get('bufferViews', [])
    textures, images, materials = gltf.get('textures', []), gltf.get('images', []), gltf.get('materials', [])

    def image_of(tex):
        if not isinstance(tex, dict) or tex.get('index') is None or tex['index'] >= len(textures):
            return None
        t = textures[tex['index']]
        src = (t.get('extensions') or {}).get('KHR_texture_basisu', {}).get('source', t.get('source'))
        for ext in (t.get('extensions') or {}).values():
            if isinstance(ext, dict) and 'source' in ext:
                src = ext['source']
        return src if src is not None and src < len(images) else None

    def px(i):
        img = images[i]
        if img.get('bufferView') is None or not binary:
            return 0
        v = views[img['bufferView']]
        d = _dims(binary[v.get('byteOffset', 0):v.get('byteOffset', 0) + v['byteLength']])
        return max(d) if d else 0

    color_px, has_detail_map = 0, False
    for m in materials:
        pbr = m.get('pbrMetallicRoughness', {})
        c = image_of(pbr.get('baseColorTexture'))
        if c is not None:
            color_px = max(color_px, px(c))
        if image_of(m.get('normalTexture')) is not None or image_of(pbr.get('metallicRoughnessTexture')) is not None:
            has_detail_map = True

    triangles, textured, small_parts = 0, 0, 0
    bounds = [[float('inf')] * 3, [float('-inf')] * 3]
    meshes = gltf.get('meshes', [])
    nodes = gltf.get('nodes', [])

    def visit(index, parent, seen):
        nonlocal triangles, textured, small_parts
        if index in seen or index >= len(nodes):
            return
        seen = seen | {index}
        node = nodes[index]
        world = _mul(parent, _mat(node))
        if node.get('mesh') is not None and node['mesh'] < len(meshes):
            for prim in meshes[node['mesh']].get('primitives', []):
                mode = prim.get('mode', 4)
                if mode not in (4, 5, 6):
                    continue
                attrs = prim.get('attributes', {})
                pos = accessors[attrs['POSITION']] if 'POSITION' in attrs else None
                if pos is None:
                    continue
                count = accessors[prim['indices']]['count'] if prim.get('indices') is not None else pos['count']
                tris = count // 3 if mode == 4 else max(0, count - 2)
                triangles += tris
                if tris < 200:
                    small_parts += tris
                mat = materials[prim['material']] if prim.get('material') is not None and prim['material'] < len(materials) else {}
                if 'TEXCOORD_0' in attrs and image_of(mat.get('pbrMetallicRoughness', {}).get('baseColorTexture')) is not None:
                    textured += tris
                lo, hi = pos.get('min'), pos.get('max')
                if lo and hi and len(lo) == 3:
                    scale = NORMALIZED.get(pos.get('componentType')) if pos.get('normalized') else None
                    if scale:
                        lo, hi = [v / scale for v in lo], [v / scale for v in hi]
                    for x in (lo[0], hi[0]):
                        for y in (lo[1], hi[1]):
                            for z in (lo[2], hi[2]):
                                p = [world[r][0] * x + world[r][1] * y + world[r][2] * z + world[r][3] for r in range(3)]
                                for k in range(3):
                                    bounds[0][k] = min(bounds[0][k], p[k])
                                    bounds[1][k] = max(bounds[1][k], p[k])
        for child in node.get('children', []):
            visit(child, world, seen)

    identity = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
    scenes = gltf.get('scenes') or [{'nodes': list(range(len(nodes)))}]
    for root in scenes[gltf.get('scene', 0) if gltf.get('scene', 0) < len(scenes) else 0].get('nodes', []):
        visit(root, identity, frozenset())
    size = [round(bounds[1][k] - bounds[0][k], 4) for k in range(3)] if bounds[0][0] != float('inf') else [0, 0, 0]
    return {'triangles': triangles, 'texturedShare': round(textured / triangles, 3) if triangles else 0.0,
            'colorTexturePx': color_px, 'detailMaps': has_detail_map, 'sizeM': size,
            'smallPartShare': round(small_parts / triangles, 3) if triangles else 0.0,
            'materials': len(materials), 'meshes': len(meshes)}


def _real_size(item):
    """登记的真实尺寸（米）：最大的那一边。"""
    r = item.get('real_size_m')
    if isinstance(r, (int, float)):
        return float(r)
    if isinstance(r, dict):
        vals = [v for v in r.values() if isinstance(v, (int, float)) and v > 0]
        return float(max(vals)) if vals else None
    return None


def check_hero(item, data, label=None):
    """H1–H6：一项 role 为 hero 的素材和它的 .glb 字节。返回 (errors, facts)。"""
    label = label or item.get('file') or '主角'
    errors = []
    cls = item.get('class')
    if cls not in CLASSES:
        errors.append(f'主角 {label} 没写 class（是哪一类东西）：{"、".join(f"{k} {v}" for k, v in CLASSES.items())}。不同类别的来源和细节要求不一样')
        cls = None
    origin = item.get('origin')
    if cls and origin not in ROUTES[cls]:
        why = '动物和人只能来自实物扫描、授权素材，或依据真实照片生成后修整，不能在 Blender 或代码里照着画（家长否过程序做的螳螂虾、机械臂、接待机器人，都像动画片）' \
            if cls in ('organism', 'human') else '代码拼、程序生成只适合地形'
        errors.append(f'主角 {label} 是 {cls}，origin「{origin}」不行：允许 {"/".join(sorted(ROUTES[cls]))}。{why}')
    # H3 来源证据
    refs = [r for r in item.get('reference_photos') or [] if isinstance(r, dict) and str(r.get('source') or '').strip() and str(r.get('angle') or '').strip()]
    angles = {str(r['angle']).strip() for r in refs}
    if len(refs) < 3 or len(angles) < 3:
        errors.append(f'主角 {label} 要有至少 3 张不同角度的真实照片 reference_photos [{{file 或 source, angle, license}}]（现在 {len(refs)} 张、{len(angles)} 个角度）：'
                      '先收集真实照片，再找或做模型，最后拿同角度对照')
    if origin in ('scan', 'cad', 'cc0-library', 'licensed') and not str(item.get('source_url') or '').strip():
        errors.append(f'主角 {label} 来自 {origin}，要写 source_url（原始出处网址）')
    if origin == 'generated' and not (str(item.get('generator') or '').strip()):
        errors.append(f'主角 {label} 是 AI 生成的，要写 generator（用的服务或模型和版本），输入就是 reference_photos 里的真实照片')
    if origin in ('modeled', 'procedural') and not str(item.get('how') or '').strip():
        errors.append(f'主角 {label} 是自己建的，how 写清用什么工具、按哪些尺寸和照片建的')
    real = _real_size(item)
    if not real:
        errors.append(f'主角 {label} 没写 real_size_m（真实尺寸，米，例如 {{"height": 62.0}}）：模型要按真实尺寸放')
    facts = {}
    if not str(item.get('file') or '').lower().endswith('.glb'):
        errors.append(f'主角 {label} 交 .glb（一个文件带贴图），检查和平板加载都按 .glb')
        return errors, facts
    if data is None:
        errors.append(f'主角 {label} 的文件不在包里')
        return errors, facts
    try:
        facts = inspect_glb(data)
    except (ValueError, KeyError, IndexError, struct.error, UnicodeDecodeError) as error:
        errors.append(f'主角 {label} 读不了：{error}')
        return errors, facts
    # H4 尺寸
    longest = max(facts['sizeM']) if facts['sizeM'] else 0
    if real and longest and abs(longest - real) / real > SIZE_TOLERANCE:
        errors.append(f'主角 {label} 模型最长 {longest:g} 米，登记的真实尺寸是 {real:g} 米：差了 {abs(longest - real) / real:.0%}，按 1 单位 = 1 米改模型')
    # H5 细节
    floor = MIN_TRIANGLES.get(cls or 'object')
    if facts['triangles'] < floor:
        errors.append(f'主角 {label} 只有 {facts["triangles"]} 个三角形，{cls or "这一类"}至少 {floor}：面这么少的多半是代码拼的或低多边形，看起来像玩具')
    # H6 材质
    if facts['texturedShare'] < MIN_TEXTURED_SHARE:
        errors.append(f'主角 {label} 只有 {facts["texturedShare"]:.0%} 的面贴了颜色贴图（要 ≥ {MIN_TEXTURED_SHARE:.0%}）：纯色拼件就是“动画片感”的来源，用扫描或照片贴图')
    if facts['colorTexturePx'] < MIN_TEXTURE_PX:
        errors.append(f'主角 {label} 的颜色贴图最大 {facts["colorTexturePx"]} 像素，要 ≥ {MIN_TEXTURE_PX}')
    if not facts['detailMaps']:
        errors.append(f'主角 {label} 没有法线或粗糙度贴图：表面没有起伏和光泽变化，会像塑料')
    return errors, facts


def check_blind_review(gate):
    """H7：盲看记录。gate 是 lesson-flow.json 的 visual_gate。返回 (errors, warnings)。"""
    errors, warnings = [], []
    rows = [r for r in (gate or {}).get('blind_review') or [] if isinstance(r, dict)]
    if len(rows) < 3:
        return [f'visual_gate.blind_review 至少 3 个角度的盲看记录（现在 {len(rows)} 条）：把真实照片和本课同角度画面打乱成 A/B，'
                '交给没参与制作的审看人（另一个看图模型或家长），按 references/hero-production.md 第 5 步的问题问'], warnings
    angles = set()
    for i, r in enumerate(rows):
        tag = r.get('view') or f'第 {i + 1} 条'
        angles.add(str(r.get('view') or i))
        gaps = [k for k in ('view', 'photo', 'ours', 'reviewer', 'verdict') if not str(r.get(k) or '').strip()]
        if gaps:
            errors.append(f'盲看 {tag} 没写：{"、".join(gaps)}')
            continue
        if r.get('reviewer_made_it') is True:
            errors.append(f'盲看 {tag}：审看人参与了制作，不算盲看，换一个审看人')
        if r.get('same_thing') is not True:
            errors.append(f'盲看 {tag}：审看人认为本课画面和照片不是同一个东西（{r.get("notes") or "没写原因"}），回到素材那一步重做主角')
        verdict = r.get('verdict')
        if verdict not in VERDICTS:
            errors.append(f'盲看 {tag}：verdict 写 {"/".join(VERDICTS)} 之一')
        elif verdict in ('cartoon', 'toy'):
            errors.append(f'盲看 {tag}：审看人说本课画面{VERDICTS[verdict]}（{"、".join(r.get("flaws") or []) or "没写哪里"}）。不能给孩子看，按毛病表返工，返工后重新盲看')
        elif verdict == 'cg' and r.get('media') == 'render':
            errors.append(f'盲看 {tag}：预渲染图还看得出是电脑画面（{"、".join(r.get("flaws") or []) or "没写哪里"}），“看”的画面要做到像照片')
        elif verdict == 'cg' and not r.get('flaws'):
            warnings.append(f'盲看 {tag}：看得出是电脑画面，flaws 写出哪里不像，写进自评')
    if not any(r.get('subject') == 'hero' for r in rows):
        errors.append('盲看记录里没有主角：至少一条 subject 写 "hero"，看的是主角本身的近景')
    if len(angles) < 3:
        errors.append('盲看要 3 个不同角度（view 不同）')
    return errors, warnings


def main():
    """做主角时随手查：python3 scripts/hero_check.py 模型.glb --class organism --size 0.012"""
    import argparse
    import sys
    parser = argparse.ArgumentParser(description='主角三维模型的硬门槛 H4–H6（来源和盲看要在素材清单和 lesson-flow.json 里写，check_package.py 一起查）')
    parser.add_argument('glb')
    parser.add_argument('--class', dest='cls', choices=sorted(CLASSES), required=True)
    parser.add_argument('--size', type=float, required=True, help='真实尺寸：最长的那一边，米')
    args = parser.parse_args()
    data = open(args.glb, 'rb').read()
    item = {'file': args.glb, 'class': args.cls, 'origin': next(iter(ROUTES[args.cls])), 'real_size_m': args.size, 'source_url': '-', 'generator': '-', 'how': '-',
            'reference_photos': [{'source': '-', 'angle': a} for a in ('front', 'side', 'top')]}
    errors, facts = check_hero(item, data)
    print(json.dumps({'errors': errors, 'facts': facts}, ensure_ascii=False, indent=2))
    sys.exit(1 if errors else 0)


if __name__ == '__main__':
    main()
