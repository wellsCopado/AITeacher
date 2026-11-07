"""Blender后台生成同机位材质/素模诊断；不修改原件，不自动评写实分数。"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys

import bpy
from mathutils import Matrix, Vector


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--focus', help='真实节点名；框选它及子部件，周边仍保留以检查连接')
    parser.add_argument('--up', choices=['auto', 'y', 'z'], default='auto')
    parser.add_argument('--views', default='front,three-quarter', help='front,side,back,three-quarter,underside的逗号列表')
    parser.add_argument('--modes', default='material,clay', help='material,clay的逗号列表')
    parser.add_argument('--size', type=int, default=900)
    parser.add_argument('--samples', type=int, default=24)
    parser.add_argument('--environment', type=Path, help='允许使用的本地HDR/EXR；不自动联网获取')
    return parser.parse_args(sys.argv[sys.argv.index('--') + 1:])


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def descendants(node):
    return [node] + list(node.children_recursive)


def main():
    args = parse_args()
    asset = args.input.resolve(strict=True)
    output = args.out.resolve()
    if asset.suffix.lower() not in ['.glb', '.gltf', '.blend']:
        raise ValueError('只接受真实GLB/glTF/Blend，不能用图片代替模型')
    output.mkdir(parents=True, exist_ok=True)
    before = digest(asset)
    if asset.suffix.lower() == '.blend':
        bpy.ops.wm.open_mainfile(filepath=str(asset))
    else:
        bpy.ops.object.select_all(action='SELECT')
        bpy.ops.object.delete(use_global=False)
        bpy.ops.import_scene.gltf(filepath=str(asset))
    scene = bpy.context.scene
    for obj in list(scene.objects):
        if obj.type in ['CAMERA', 'LIGHT']:
            bpy.data.objects.remove(obj, do_unlink=True)
    up = args.up if args.up != 'auto' else 'z'
    # glTF导入器会把标准Y-up变为Blender Z-up；已有Blend按其真实坐标选择--up。
    if up == 'y':
        convert = Matrix.Rotation(math.pi / 2, 4, 'X')
        for obj in scene.objects:
            if obj.parent is None:
                obj.matrix_world = convert @ obj.matrix_world
    bpy.context.view_layer.update()
    meshes = [o for o in scene.objects if o.type == 'MESH' and not o.hide_render]
    if not meshes:
        raise ValueError('没有可见真实网格')
    missing = [i.filepath for i in bpy.data.images if i.source == 'FILE' and not i.packed_file and not Path(bpy.path.abspath(i.filepath)).exists()]
    if missing:
        raise ValueError('材质外部引用丢失，不能静默换白材质：' + ', '.join(missing[:4]))
    targets = meshes
    if args.focus:
        node = scene.objects.get(args.focus)
        if node is None:
            raise ValueError('指定部件不在实际模型中：' + args.focus)
        target_ids = set(descendants(node))
        targets = [o for o in meshes if o in target_ids]
        if not targets:
            raise ValueError('部件没有可见网格：' + args.focus)
    points = [o.matrix_world @ Vector(p) for o in targets for p in o.bound_box]
    lower = Vector(tuple(min(p[i] for p in points) for i in range(3)))
    upper = Vector(tuple(max(p[i] for p in points) for i in range(3)))
    center = (lower + upper) / 2
    extent = max((upper - lower).length, 0.001)
    directions = {'front': (0, -1, 0.03), 'side': (1, 0, 0.03), 'back': (0, 1, 0.03),
                  'three-quarter': (0.8, -1, 0.45), 'underside': (0.5, -0.8, -1)}
    views = args.views.split(',')
    modes = args.modes.split(',')
    if any(v not in directions for v in views) or any(m not in ['material', 'clay'] for m in modes):
        raise ValueError('视角或材质模式无效')
    if args.size < 64 or args.samples < 1:
        raise ValueError('尺寸或采样参数过小')
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = args.samples
    scene.cycles.use_denoising = True
    scene.render.resolution_x = scene.render.resolution_y = args.size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.film_transparent = False
    scene.view_settings.view_transform = 'AgX'
    world = bpy.data.worlds.new('诊断照明_不代表最终Web环境')
    world.use_nodes = True
    scene.world = world
    bg = world.node_tree.nodes.get('Background')
    bg.inputs['Color'].default_value = (0.13, 0.15, 0.18, 1)
    bg.inputs['Strength'].default_value = 0.45
    if args.environment:
        path = args.environment.resolve(strict=True)
        texture = world.node_tree.nodes.new('ShaderNodeTexEnvironment')
        texture.image = bpy.data.images.load(str(path))
        world.node_tree.links.new(texture.outputs['Color'], bg.inputs['Color'])
    for vector, power, size in [((2, -3, 4), 120, 2.5), ((-3, -1, 1.5), 75, 2), ((1, 3, 3), 150, 2)]:
        bpy.ops.object.light_add(type='AREA', location=center + Vector(vector) * extent)
        light = bpy.context.object
        light.data.energy = power * extent * extent
        light.data.shape = 'DISK'
        light.data.size = size * extent
        light.rotation_euler = (center - light.location).to_track_quat('-Z', 'Y').to_euler()
    bpy.ops.object.camera_add()
    camera = bpy.context.object
    camera.data.type = 'ORTHO'
    camera.data.clip_start = extent * 0.001
    camera.data.clip_end = extent * 50
    scene.camera = camera
    # 诊断补光随镜头转动，底部也必须能看见连接和孔；不是最终现场照明。
    light_data = bpy.data.lights.new('诊断观察补光', 'AREA')
    light_data.energy = 250 * extent * extent
    light_data.shape = 'DISK'
    light_data.size = extent * 1.5
    inspection = bpy.data.objects.new('诊断观察补光', light_data)
    scene.collection.objects.link(inspection)
    inspection.parent = camera
    inspection.location = (0, 0, 0)
    clay = bpy.data.materials.new('素模_只看体积连接')
    clay.use_nodes = True
    p = clay.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (0.38, 0.40, 0.42, 1)
    p.inputs['Metallic'].default_value = 0
    p.inputs['Roughness'].default_value = 0.65
    results = []
    for view in views:
        direction = Vector(directions[view]).normalized()
        camera.location = center + direction * extent * 3
        camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
        right = camera.rotation_euler.to_matrix() @ Vector((1, 0, 0))
        up_vector = camera.rotation_euler.to_matrix() @ Vector((0, 1, 0))
        width = max(p.dot(right) for p in points) - min(p.dot(right) for p in points)
        height = max(p.dot(up_vector) for p in points) - min(p.dot(up_vector) for p in points)
        camera.data.ortho_scale = max(width, height) * 1.25
        for mode in modes:
            scene.view_layers[0].material_override = clay if mode == 'clay' else None
            path = output / f'{view}-{mode}.png'
            if path.resolve() == asset:
                raise ValueError('不能覆盖原资产')
            scene.render.filepath = str(path)
            bpy.ops.render.render(write_still=True)
            results.append({'view': view, 'mode': mode, 'file': path.name, 'sha256': digest(path),
                            'camera': list(camera.location), 'orthoScale': camera.data.ortho_scale})
    if digest(asset) != before:
        raise ValueError('原资产发生变化，应停止交付并调查')
    manifest = {'input': str(asset), 'inputSha256': before, 'inputUnchanged': True,
                'focus': args.focus, 'bounds': {'min': list(lower), 'max': list(upper)},
                'renders': results, 'diagnosticOnly': True,
                'meaning': '同机位素模揭示形体/连接，材质图检查表面；不证明参考一致、最终Web或照片级通过。'}
    (output / 'diagnostic.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    print('DIAGNOSTICS_READY', output)


if __name__ == '__main__':
    main()
