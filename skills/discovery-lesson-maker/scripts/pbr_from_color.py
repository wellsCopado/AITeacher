"""只有颜色贴图时补出法线图和粗糙度图；可另出一张无缝平铺的水面法线图。

补出来的贴图比扫描原件差：能拿到原件（法线、粗糙度、AO）就用原件。
用法：python3 pbr_from_color.py 颜色图… --out 目录 [--size 1024] [--strength 1.5] [--roughness 0.85] [--water-normal]
"""
import argparse
import re
from pathlib import Path
import sys

import numpy as np
from PIL import Image, ImageFilter


def normal_from_height(height, strength):
    """高度图（0–1）→ 切线空间法线图（OpenGL 约定，绿色朝上）。边缘按环绕处理，原图能平铺结果也能平铺。"""
    h = np.asarray(height, dtype=np.float32)
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * strength
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * strength
    n = np.dstack([-dx, dy, np.full_like(h, 0.25)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    return Image.fromarray(((n * 0.5 + 0.5) * 255).round().astype(np.uint8))


def roughness_from_luminance(lum, base):
    """亮处略光滑、暗处（缝、污渍）略粗糙，让粗糙度有变化而不是一个常数。"""
    r = np.clip(base + (0.5 - np.asarray(lum, dtype=np.float32)) * 0.25, 0.05, 1.0)
    return Image.fromarray((r * 255).round().astype(np.uint8))


def water_height(size=512, waves=48, seed=7):
    """整数波数的正弦叠加，在环面上周期，平铺无缝。短波弱、长波强。"""
    y, x = np.mgrid[0:size, 0:size] / size * 2 * np.pi
    rng = np.random.default_rng(seed)
    h = np.zeros((size, size))
    for _ in range(waves):
        kx, ky = rng.integers(-24, 25, 2)
        if kx == 0 and ky == 0:
            continue
        h += np.sin(kx * x + ky * y + rng.uniform(0, 2 * np.pi)) / np.hypot(kx, ky) ** 1.3
    return (h - h.min()) / (h.max() - h.min())


def convert(src, out, size, strength, rough):
    # ambientCG 的 Rock012_2K-PNG_Color、Poly Haven 的 rock_diff_2k 等 → Rock012 / rock
    name = re.sub(r'([_-](\d+K(-(PNG|JPG))?))?[_-](color|albedo|basecolor|diff(use)?)([_-]\d+k)?$', '', src.stem, flags=re.I)
    im = Image.open(src).convert('RGB')
    if size:
        im = im.resize((size, size), Image.LANCZOS)
    im.save(out / f'{name}_color.jpg', quality=88)
    lum = np.asarray(im.convert('L').filter(ImageFilter.GaussianBlur(0.8)), dtype=np.float32) / 255.0
    normal_from_height(lum, strength * 6).save(out / f'{name}_normal.jpg', quality=90)
    roughness_from_luminance(lum, rough).save(out / f'{name}_rough.jpg', quality=90)
    return name


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('colors', nargs='*', type=Path)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--size', type=int, default=1024, help='输出边长；0 保留原尺寸')
    p.add_argument('--strength', type=float, default=1.5, help='凹凸强度：混凝土约 1.2–1.6，沥青/草地约 2–2.5，立面约 0.8')
    p.add_argument('--roughness', type=float, default=0.85, help='基础粗糙度：干燥石材 0.8–0.95，玻璃幕墙 0.3–0.5')
    p.add_argument('--water-normal', action='store_true', help='另出 water_normal.jpg（无缝平铺）')
    a = p.parse_args(argv)
    if not a.colors and not a.water_normal:
        p.error('给至少一张颜色图，或加 --water-normal')
    a.out.mkdir(parents=True, exist_ok=True)
    for c in a.colors:
        print('ok', convert(c, a.out, a.size, a.strength, a.roughness))
    if a.water_normal:
        normal_from_height(water_height(), 10).save(a.out / 'water_normal.jpg', quality=92)
        print('ok water_normal')
    return 0


if __name__ == '__main__':
    sys.exit(main())
