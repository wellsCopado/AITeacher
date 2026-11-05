"""按机位表用 Blender Cycles 给同一个模型出光线追踪图（“看”的画面）。任何主题通用。

机位表 views.json 和网页共用：y 朝上、单位米，{"views":[{"name","position":[x,y,z],"target":[x,y,z],"fov":42,"media":"render"}]}。
默认只出 media 为 render 的机位；--all 全出（和实时截图对比用），--only a,b 只出指定的。
用法：python3 render_stills.py --input 模型.glb --views views.json --out 目录 [选项]
需要 Blender 的 Python（`pip install bpy`）或 `blender -b -P render_stills.py -- 参数`。不联网、不改原件。
"""
import argparse
import json
import math
from pathlib import Path
import sys


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input', type=Path, required=True, help='GLB/glTF，1 单位 = 1 米，y 朝上')
    p.add_argument('--views', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--only', default='', help='逗号分隔的机位名')
    p.add_argument('--all', action='store_true')
    p.add_argument('--sun-elevation', type=float, default=35, help='太阳高度角（度）')
    p.add_argument('--sun-azimuth', type=float, default=140, help='方位角（度）：从 +z（模型前方）向 +x 转；和 three.js setFromSphericalCoords 的 theta 一样')
    p.add_argument('--sun-strength', type=float, default=4.5)
    p.add_argument('--sky-strength', type=float, default=0.12, help='物理天空亮度；发白先降这个')
    p.add_argument('--hdri', type=Path, help='本地 HDR/EXR，代替物理天空（天空和反射都用它）')
    p.add_argument('--hdri-strength', type=float, default=1.0)
    p.add_argument('--haze', type=float, default=0.00016, help='大气雾密度（每米）；0 关掉。远景发灰发白先降这个')
    p.add_argument('--haze-height', type=float, default=600, help='雾层高度（米）')
    p.add_argument('--water', default='', help='宽,长[,颜色hex]：在 y=0 放一块水面，宽沿 x、长沿 z')
    p.add_argument('--samples', type=int, default=64)
    p.add_argument('--size', default='1280x750')
    p.add_argument('--exposure', type=float, default=0.0)
    return p.parse_args(argv)


def gltf_to_blender(v):
    """glTF/three.js 的 (x, y, z)，y 朝上 → Blender 的 (x, -z, y)，z 朝上（和 Blender glTF 导入一致）。"""
    x, y, z = v
    return (x, -z, y)


def sun_direction(elevation_deg, azimuth_deg):
    """指向太阳的单位向量，glTF 坐标。"""
    el, az = math.radians(elevation_deg), math.radians(azimuth_deg)
    return (math.cos(el) * math.sin(az), math.sin(el), math.cos(el) * math.cos(az))


def load_views(path, only='', include_all=False):
    data = json.loads(Path(path).read_text(encoding='utf-8'))
    views = data['views'] if isinstance(data, dict) else data
    names = [n for n in only.split(',') if n]
    errors = []
    for v in views:
        for k in ('name', 'position', 'target'):
            if k not in v:
                errors.append(f'机位缺 {k}：{v}')
        if v.get('media', 'realtime') not in ('render', 'realtime'):
            errors.append(f'机位 {v.get("name")} 的 media 只能是 render 或 realtime')
    if errors:
        raise ValueError('；'.join(errors))
    if names:
        missing = set(names) - {v['name'] for v in views}
        if missing:
            raise ValueError(f'机位表里没有：{sorted(missing)}')
        return [v for v in views if v['name'] in names]
    return [v for v in views if include_all or v.get('media') == 'render']


def hex_rgb(text):
    text = text.lstrip('#')
    srgb = [int(text[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb)


def build_scene(bpy, a):
    from mathutils import Vector
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(a.input.resolve(strict=True)))
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = a.samples
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = (int(n) for n in a.size.lower().split('x'))
    sc.view_settings.view_transform = 'AgX'
    try:
        sc.view_settings.look = 'AgX - Medium High Contrast'
    except TypeError:
        pass
    sc.view_settings.exposure = a.exposure

    world = bpy.data.worlds.new('sky'); sc.world = world; world.use_nodes = True
    nt = world.node_tree; bg = nt.nodes['Background']
    sun_dir = Vector(gltf_to_blender(sun_direction(a.sun_elevation, a.sun_azimuth)))
    if a.hdri:
        env = nt.nodes.new('ShaderNodeTexEnvironment')
        env.image = bpy.data.images.load(str(a.hdri.resolve(strict=True)))
        nt.links.new(env.outputs['Color'], bg.inputs['Color'])
        bg.inputs['Strength'].default_value = a.hdri_strength
    else:
        sky = nt.nodes.new('ShaderNodeTexSky')
        for kind in ('NISHITA', 'MULTIPLE_SCATTERING', 'HOSEK_WILKIE'):
            try:
                sky.sky_type = kind
                break
            except TypeError:
                continue
        if hasattr(sky, 'sun_elevation'):
            sky.sun_elevation = math.radians(a.sun_elevation)
            # Blender 天空的旋转从 +Y 量起；换算成和太阳灯同一个方向
            sky.sun_rotation = math.atan2(sun_dir.x, sun_dir.y) % (2 * math.pi)
        elif hasattr(sky, 'sun_direction'):
            sky.sun_direction = sun_dir
        nt.links.new(sky.outputs['Color'], bg.inputs['Color'])
        bg.inputs['Strength'].default_value = a.sky_strength

    lamp = bpy.data.lights.new('sun', 'SUN'); lamp.energy = a.sun_strength
    lamp.angle = math.radians(0.6); lamp.color = (1, 0.96, 0.9)
    sun = bpy.data.objects.new('sun', lamp); sc.collection.objects.link(sun)
    sun.rotation_euler = sun_dir.to_track_quat('Z', 'Y').to_euler()

    if a.water:
        parts = a.water.split(',')
        width, length = float(parts[0]), float(parts[1])
        color = hex_rgb(parts[2]) if len(parts) > 2 else (0.035, 0.04, 0.028)
        bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 0, 0))
        plane = bpy.context.object; plane.scale = (width, length, 1)
        m = bpy.data.materials.new('water'); m.use_nodes = True; t = m.node_tree
        bsdf = t.nodes['Principled BSDF']
        bsdf.inputs['Base Color'].default_value = (*color, 1)
        bsdf.inputs['Roughness'].default_value = 0.12
        bsdf.inputs['IOR'].default_value = 1.333
        noise = t.nodes.new('ShaderNodeTexNoise'); noise.inputs['Scale'].default_value = 0.35; noise.inputs['Detail'].default_value = 8
        coord = t.nodes.new('ShaderNodeTexCoord'); mapping = t.nodes.new('ShaderNodeMapping'); mapping.inputs['Scale'].default_value = (1, 3, 1)
        t.links.new(coord.outputs['Object'], mapping.inputs['Vector']); t.links.new(mapping.outputs['Vector'], noise.inputs['Vector'])
        bump = t.nodes.new('ShaderNodeBump'); bump.inputs['Strength'].default_value = 0.25; bump.inputs['Distance'].default_value = 0.02
        t.links.new(noise.outputs['Fac'], bump.inputs['Height']); t.links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
        plane.data.materials.append(m)

    if a.haze > 0:
        bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, a.haze_height / 2))
        box = bpy.context.object; box.scale = (20000, 20000, a.haze_height)
        m = bpy.data.materials.new('haze'); m.use_nodes = True; t = m.node_tree
        t.nodes.remove(t.nodes['Principled BSDF'])
        vol = t.nodes.new('ShaderNodeVolumePrincipled')
        vol.inputs['Density'].default_value = a.haze; vol.inputs['Color'].default_value = (0.75, 0.82, 0.9, 1)
        t.links.new(vol.outputs['Volume'], t.nodes['Material Output'].inputs['Volume'])
        box.data.materials.append(m)

    cam = bpy.data.cameras.new('cam'); cam.sensor_fit = 'VERTICAL'; cam.clip_start = 0.05; cam.clip_end = 30000
    obj = bpy.data.objects.new('cam', cam); sc.collection.objects.link(obj); sc.camera = obj
    return sc, obj


def main(argv=None):
    if argv is None:
        argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    a = parse_args(argv)
    views = load_views(a.views, a.only, a.all)
    if not views:
        print('没有要出的机位：机位表里没有 media 为 render 的，用 --all 或 --only')
        return 1
    import bpy
    from mathutils import Vector
    sc, cam = build_scene(bpy, a)
    a.out.mkdir(parents=True, exist_ok=True)
    for v in views:
        cam.data.angle = math.radians(v.get('fov', 42))
        cam.location = gltf_to_blender(v['position'])
        cam.rotation_euler = (Vector(gltf_to_blender(v['target'])) - cam.location).to_track_quat('-Z', 'Y').to_euler()
        sc.render.filepath = str(a.out / f'{v["name"]}.png')
        bpy.ops.render.render(write_still=True)
        print('rendered', sc.render.filepath)
    return 0


if __name__ == '__main__':
    sys.exit(main())
