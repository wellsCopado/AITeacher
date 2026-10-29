"""按有来源的轴向剖面建立回转零件、实体安装孔与独立装配；不是通用造型器。"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys

import bpy

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--spec', type=Path, required=True)
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
spec_path = args.spec.resolve(strict=True)
spec = json.loads(spec_path.read_text())
if spec.get('units') != 'mm' or not spec.get('sourceUrl') or not spec.get('limitations'):
    raise ValueError('剖面需声明毫米、真实来源和近似范围')
out = args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
root = bpy.data.objects.new('reference_assembly', None)
bpy.context.collection.objects.link(root)
root['realObject'] = spec['realObject']
root['sourceUrl'] = spec['sourceUrl']
root['limitations'] = '; '.join(spec['limitations'])
materials = {}
for key, values in spec['materials'].items():
    mat = bpy.data.materials.new(key)
    mat.use_nodes = True
    p = mat.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (*values['color'], 1)
    p.inputs['Metallic'].default_value = values['metalness']
    p.inputs['Roughness'].default_value = values['roughness']
    materials[key] = mat
objects = []
for component in spec['components']:
    profile = component['profile']
    if len(profile) < 3 or any(radius < 0 for z, radius in profile):
        raise ValueError('剖面须是闭合轮廓，半径不能小于零')
    sides = 128
    vertices = [(r * math.cos(math.tau * k / sides) / 1000,
                 r * math.sin(math.tau * k / sides) / 1000, z / 1000)
                for z, r in profile for k in range(sides)]
    faces = []
    for i in range(len(profile)):
        n = (i + 1) % len(profile)
        for k in range(sides):
            faces.append((i * sides + k, i * sides + (k + 1) % sides,
                          n * sides + (k + 1) % sides, n * sides + k))
    mesh = bpy.data.meshes.new(component['id'])
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(component['id'], mesh)
    bpy.context.collection.objects.link(obj)
    obj.parent = root
    obj['partId'] = component['id']
    obj['basis'] = component['basis']
    obj.data.materials.append(materials[component['material']])
    for hole in component.get('holePatterns', []):
        for k in range(hole['count']):
            angle = math.tau * k / hole['count'] + math.radians(hole.get('angle', 0))
            r = hole['pitchDiameter'] / 2000
            bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=hole['visualDiameter'] / 2000,
                                               depth=(hole['z1'] - hole['z0']) / 1000,
                                               location=(r * math.cos(angle), r * math.sin(angle), (hole['z0'] + hole['z1']) / 2000))
            cutter = bpy.context.object
            modifier = obj.modifiers.new('真实孔_不使用黑点贴图', 'BOOLEAN')
            modifier.operation = 'DIFFERENCE'
            modifier.solver = 'EXACT'
            modifier.object = cutter
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.modifier_apply(modifier=modifier.name)
            bpy.data.objects.remove(cutter, do_unlink=True)
    bevel = obj.modifiers.new('参考重建的小尺度边缘倒角', 'BEVEL')
    bevel.width = component.get('bevel', 0.15) / 1000
    bevel.segments = 3
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=bevel.name)
    # 以法向区分平面端盖与回转侧面，避免整件变成融化的塑料。
    for polygon in obj.data.polygons:
        polygon.use_smooth = abs(polygon.normal.z) < 0.95
    normal = obj.modifiers.new('端面与倒角法向', 'WEIGHTED_NORMAL')
    normal.keep_sharp = True
    normal.weight = 50
    bpy.ops.object.modifier_apply(modifier=normal.name)
    objects.append(obj)
bpy.ops.object.select_all(action='DESELECT')
for obj in objects + [root]:
    obj.select_set(True)
bpy.context.view_layer.objects.active = root
bpy.ops.export_scene.gltf(filepath=str(out / 'reference-assembly.glb'), export_format='GLB', use_selection=True, export_extras=True)
bpy.ops.wm.save_as_mainfile(filepath=str(out / 'reference-assembly.blend'))
(out / 'construction.json').write_text(json.dumps({
    'realObject': spec['realObject'], 'sourceUrl': spec['sourceUrl'],
    'specSha256': hashlib.sha256(spec_path.read_bytes()).hexdigest(),
    'confirmedAnchors': spec['confirmedAnchors'], 'limitations': spec['limitations'],
    'visualStatus': '制作回归样件，非完整机器人或照片级验收'
}, ensure_ascii=False, indent=2))
print('REFERENCE_ASSEMBLY_READY', out)
