"""测试用的 .glb：一块细分的面（可以选三角形数、尺寸、贴图）。只为测检查器，不是课程素材。"""
import json
import struct
import zlib


def png(w, h):
    raw = b''.join(b'\x00' + b'\x80\x80\x80' * w for _ in range(min(h, 4)))  # 只写前几行：检查器只读头
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


def glb(triangles=20000, size=(1.0, 1.0, 1.0), texture=2048, normal=True, uv=True, parts=1):
    """parts>1 时拆成多块，每块一样大（模拟代码拼的零件）。"""
    per = max(1, triangles // parts)
    bin_parts, views, accessors, meshes, nodes = [], [], [], [], []

    def add(data, target=None):
        while sum(len(p) for p in bin_parts) % 4:
            bin_parts.append(b'\x00')
        off = sum(len(p) for p in bin_parts)
        bin_parts.append(data)
        v = {'buffer': 0, 'byteOffset': off, 'byteLength': len(data)}
        if target:
            v['target'] = target
        views.append(v)
        return len(views) - 1

    images, textures = [], []
    if texture:
        images.append({'bufferView': add(png(texture, texture)), 'mimeType': 'image/png'})
        textures.append({'source': 0})
        if normal:
            images.append({'bufferView': add(png(texture, texture)), 'mimeType': 'image/png'})
            textures.append({'source': 1})
    material = {'pbrMetallicRoughness': {'metallicFactor': 0, 'roughnessFactor': 0.8}}
    if texture:
        material['pbrMetallicRoughness']['baseColorTexture'] = {'index': 0}
        if normal:
            material['normalTexture'] = {'index': 1}
    sx, sy, sz = size
    for p in range(parts):
        n = 3 * per  # 不共用顶点：每个三角形 3 个点，坐标落在 0..size 的盒子里
        pos = []
        for i in range(n):
            t = i / max(1, n - 1)
            pos += [sx * t, sy * ((i * 7919) % n) / max(1, n - 1), sz * ((i * 104729) % n) / max(1, n - 1)]
        # 让包围盒正好是 size：第一个点是原点，最后一个点是最远角
        pos[0:3] = [0, 0, 0]
        pos[-3:] = [sx, sy, sz]
        pa = add(struct.pack(f'<{len(pos)}f', *pos), 34962)
        accessors.append({'bufferView': pa, 'componentType': 5126, 'count': n, 'type': 'VEC3', 'min': [0, 0, 0], 'max': [sx, sy, sz]})
        attrs = {'POSITION': len(accessors) - 1}
        if uv:
            ua = add(struct.pack(f'<{2 * n}f', *([0.5] * 2 * n)), 34962)
            accessors.append({'bufferView': ua, 'componentType': 5126, 'count': n, 'type': 'VEC2'})
            attrs['TEXCOORD_0'] = len(accessors) - 1
        meshes.append({'primitives': [{'attributes': attrs, 'material': 0}]})
        nodes.append({'mesh': p})
    binary = b''.join(bin_parts)
    while len(binary) % 4:
        binary += b'\x00'
    doc = {'asset': {'version': '2.0'}, 'scene': 0, 'scenes': [{'nodes': list(range(parts))}], 'nodes': nodes, 'meshes': meshes,
           'materials': [material], 'accessors': accessors, 'bufferViews': views, 'buffers': [{'byteLength': len(binary)}]}
    if images:
        doc['images'], doc['textures'] = images, textures
    js = json.dumps(doc).encode()
    while len(js) % 4:
        js += b' '
    total = 12 + 8 + len(js) + 8 + len(binary)
    return b'glTF' + struct.pack('<II', 2, total) + struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(binary), 0x004E4942) + binary
