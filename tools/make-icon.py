#!/usr/bin/env python3
# 生成应用图标（desktop/build/icon.ico + icon.png）。
#
# 为什么要自己生成：之前打包用的是 **Electron 默认图标** —— 参赛作品一眼就能看出没做完。
# 设计：圆角方块 + 项目主色渐变（#4945ff，与 IDE 主题一致）+ 白色 MB。
# 一次性工具：Pillow 已装（12.1.1），跑一次把 ico/png 写进 desktop/build/。
import os
import sys

# Windows 控制台默认 GBK，直接 print 中文/✓ 会 UnicodeEncodeError —— 先把 stdout 切成 utf-8
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print('需要 Pillow：pip install pillow')
    sys.exit(1)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'desktop', 'build')
os.makedirs(OUT_DIR, exist_ok=True)

S = 512                      # 先按 512 画，再缩到各尺寸，边缘更干净
RADIUS = int(S * 0.22)       # 圆角
C1 = (0x49, 0x45, 0xFF)      # 主色（与 IDE 的 --s-primary 一致）
C2 = (0x7B, 0x6F, 0xE0)      # 渐变到偏紫

img = Image.new('RGBA', (S, S), (0, 0, 0, 0))

# ① 竖向渐变
grad = Image.new('RGB', (S, S))
gd = ImageDraw.Draw(grad)
for y in range(S):
    t = y / (S - 1)
    gd.line([(0, y), (S, y)], fill=(
        int(C1[0] + (C2[0] - C1[0]) * t),
        int(C1[1] + (C2[1] - C1[1]) * t),
        int(C1[2] + (C2[2] - C1[2]) * t),
    ))

# ② 圆角遮罩，把渐变裁成圆角方块
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=RADIUS, fill=255)
img.paste(grad, (0, 0), mask)

# ③ 白色 MB（用系统粗体；找不到就退化成几何块，别让脚本挂掉）
draw = ImageDraw.Draw(img)
fonts = ['C:/Windows/Fonts/segoeuib.ttf', 'C:/Windows/Fonts/arialbd.ttf',
         '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
         '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf']
font = None
for f in fonts:
    if os.path.exists(f):
        try:
            font = ImageFont.truetype(f, int(S * 0.42))
            break
        except Exception:
            pass
if font:
    text = 'MB'
    bb = draw.textbbox((0, 0), text, font=font)
    draw.text(((S - (bb[2] - bb[0])) / 2 - bb[0], (S - (bb[3] - bb[1])) / 2 - bb[1]),
              text, font=font, fill=(255, 255, 255, 255))
    print('· 用字体 ' + str(font.path))
else:
    # 退化：画一个大写 M 的简化几何
    w = int(S * 0.10)
    draw.line([(S*0.28, S*0.68), (S*0.38, S*0.34)], fill=(255,255,255,255), width=w)
    draw.line([(S*0.38, S*0.34), (S*0.48, S*0.62)], fill=(255,255,255,255), width=w)
    draw.line([(S*0.48, S*0.62), (S*0.58, S*0.34)], fill=(255,255,255,255), width=w)
    draw.line([(S*0.58, S*0.34), (S*0.68, S*0.68)], fill=(255,255,255,255), width=w)
    print('· 没找到字体，用几何退化的 M')

# ④ 写 PNG（256，备用）与多尺寸 ICO
png = img.resize((256, 256), Image.LANCZOS)
png.save(os.path.join(OUT_DIR, 'icon.png'), 'PNG')
sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
img.resize((256, 256), Image.LANCZOS).save(
    os.path.join(OUT_DIR, 'icon.ico'), format='ICO',
    sizes=sizes)
print('✓ 写出 ' + os.path.join(OUT_DIR, 'icon.ico') + '（' + ', '.join(str(s[0]) for s in sizes) + '）')
print('✓ 写出 ' + os.path.join(OUT_DIR, 'icon.png') + '（256×256）')
