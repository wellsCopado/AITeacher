# Build the movable relief rig for the mantis shrimp from its top-view cut-out.
# Output (next to the cut-out): rig.png  R = height above the sand (px), G = part number, A = coverage
#                               rig.json part names, pivots, parents and how far each moves apart in the anatomy view
# Run: python3 scripts/rig-organism.py content/assets/organisms/M-peacock-mantis-shrimp
import json, sys
import numpy as np
from PIL import Image, ImageFilter

d = sys.argv[1]
im = Image.open(f'{d}/top-cutout.webp').convert('RGBA')
W, H = im.size                                   # 1400 x 618; the body's midline is y = 280
a = np.asarray(im)[:, :, 3] > 40
Y, X = np.mgrid[0:H, 0:W]
MID = 280

def ell(cx, cy, rx, ry, deg=0):
    c, n = np.cos(np.radians(deg)), np.sin(np.radians(deg))
    u, v = (X - cx) * c + (Y - cy) * n, -(X - cx) * n + (Y - cy) * c
    return (u / rx) ** 2 + (v / ry) ** 2 <= 1

# Parts, first match wins. pivot = joint in image pixels; explode = offset in the anatomy view (px).
P = []
def part(key, name, mask, pivot, parent, explode, amp, base=0, slope=None):
    P.append(dict(key=key, name=name, mask=mask & a, pivot=pivot, parent=parent, explode=explode, amp=amp, base=base, slope=slope))

part('eyeA', '复眼', ell(285, 140, 46, 44) | ((X > 300) & (X < 372) & (Y > 150) & (Y < 212)), (352, 205), 'head', (-60, -150), 34, base=95)
part('eyeB', '复眼', ell(285, 236, 46, 44) | ((X > 300) & (X < 372) & (Y >= 212) & (Y < 270)), (352, 252), 'head', (-60, 150), 34, base=95)
part('scaleA', '触角鳞片', ell(342, 64, 112, 72, 36) & ~ell(285, 140, 50, 48), (405, 128), 'head', (-40, -120), 14, base=55, slope=(405, 128, 25))
part('scaleB', '触角鳞片', ell(332, 448, 120, 74, -44), (400, 372), 'head', (-40, 120), 14, base=55, slope=(400, 372, 25))
part('antA', '触角', (X < 262) & (Y < 196), (258, 190), 'head', (-150, -60), 3, base=48, slope=(258, 190, 48))
part('antB', '触角', (X < 125) & (Y >= 280), (250, 322), 'head', (-150, 60), 3, base=48, slope=(250, 322, 48))
part('clawA', '捕肢（出拳用）', (X < 262) & (Y < 290), (262, 252), 'head', (-110, -40), 40, base=18)
part('clawB', '捕肢（出拳用）', (X < 262), (258, 318), 'head', (-110, 40), 40, base=18)
legs = [('legA', (Y < 150) & (X >= 520) & (X < 690), (652, 160), (0, -110)), ('legB', (Y < 150) & (X >= 690) & (X < 800), (746, 152), (40, -110)),
        ('legC', (Y > 395) & (X >= 400) & (X < 600), (588, 388), (-20, 120)), ('legD', (Y > 400) & (X >= 600) & (X < 700), (655, 395), (20, 120)),
        ('legE', (Y > 400) & (X >= 700) & (X < 800), (745, 402), (60, 120))]
for k, m, pv, ex in legs: part(k, '步足', m, pv, 'head', ex, 6, base=42, slope=(pv[0], pv[1], 40))
cuts = [612, 660, 757, 857, 962, 1052, 1112]
part('head', '头胸甲', X < cuts[0], (560, MID), None, (-30, 0), 120)
for i in range(6):
    part(f'abd{i+1}', '腹节', (X >= cuts[i]) & (X < cuts[i + 1]), (cuts[i], MID), 'head' if i == 0 else f'abd{i}', (25 * (i + 1), 0), 118)
part('uroA', '尾扇', (X >= cuts[6] - 30) & (Y < 205), (cuts[6], MID), 'abd6', (200, -110), 30)
part('telson', '尾节', (X >= cuts[6]) & (Y >= 205) & (Y <= 360), (cuts[6], MID), 'abd6', (200, 0), 60)
part('uroB', '尾扇', (X >= cuts[6] - 30) & (Y > 360), (cuts[6], MID), 'abd6', (200, 110), 30)

pid = np.full((H, W), 255, np.uint8)
for i, p in enumerate(P):
    m = p['mask'] & (pid == 255); pid[m] = i; p['mask'] = m

def dist(mask, cap=160):
    # distance to the edge of the mask, in px (repeated 3x3 erosion)
    out = np.zeros(mask.shape, np.float32); cur = mask.copy()
    for k in range(cap):
        if not cur.any(): break
        out[cur] += 1
        e = cur.copy()
        e[1:, :] &= cur[:-1, :]; e[:-1, :] &= cur[1:, :]; e[:, 1:] &= cur[:, :-1]; e[:, :-1] &= cur[:, 1:]
        cur = e
    return out

body = np.zeros((H, W), bool)
for p in P:
    if p['key'] == 'head' or p['key'].startswith('abd') or p['key'] == 'telson': body |= p['mask']
db = dist(body)
hgt = np.zeros((H, W), np.float32)
for p in P:
    m = p['mask']
    if not m.any(): continue
    if p['key'] == 'head' or p['key'].startswith('abd') or p['key'] == 'telson':
        R = 125.0
        t = np.clip(db / R, 0, 1); dome = np.sqrt(1 - (1 - t) ** 2)
        hgt[m] = (dome * p['amp'])[m]
    else:
        dp = dist(m, 60); t = np.clip(dp / 25.0, 0, 1); dome = np.sqrt(1 - (1 - t) ** 2) * p['amp']
        base = np.full((H, W), float(p['base']), np.float32)
        if p['slope']:
            sx, sy, h0 = p['slope']; L = np.hypot(X - sx, Y - sy)
            far = max(1.0, float(L[m].max())); base = h0 * np.clip(1 - L / far, 0, 1) + 3
        hgt[m] = (base + dome)[m]
hgt = np.asarray(Image.fromarray(np.clip(hgt, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2.2))).astype(np.float32)
hgt[pid == 255] = 0

small = (700, 309)
R = Image.fromarray(np.clip(hgt, 0, 255).astype(np.uint8)).resize(small, Image.BILINEAR)
G = Image.fromarray(pid).resize(small, Image.NEAREST)
A = Image.fromarray((a * 255).astype(np.uint8)).resize(small, Image.BILINEAR)
Image.merge('RGBA', (R, G, Image.new('L', small, 0), A)).save(f'{d}/rig.png', optimize=True)
json.dump({'size': [W, H], 'grid': list(small), 'mid': MID, 'body_px': [252, 1379],
           'parts': [{k: p[k] for k in ('key', 'name', 'pivot', 'parent', 'explode')} for p in P]},
          open(f'{d}/rig.json', 'w'), ensure_ascii=False, indent=1)
# a preview of the part map, to check the cut
pal = np.random.RandomState(3).randint(40, 255, (256, 3)).astype(np.uint8); pal[255] = 235
Image.fromarray(pal[pid]).resize((700, 309), Image.NEAREST).save('/tmp/claude-0/-home-claude/c02b488a-a8c7-521e-93f6-287a2bc8bf07/scratchpad/cut/parts.png')
Image.fromarray(np.clip(hgt * 1.5, 0, 255).astype(np.uint8)).resize((700, 309)).save('/tmp/claude-0/-home-claude/c02b488a-a8c7-521e-93f6-287a2bc8bf07/scratchpad/cut/height.png')
print('parts', len(P), {p['key']: int(p['mask'].sum()) for p in P})
