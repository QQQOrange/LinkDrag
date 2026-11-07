#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate the Link Preview Suite toolbar/store icons."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "extension" / "icons"
ICON_DIR.mkdir(parents=True, exist_ok=True)
S = 1024


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return m


img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# Vertical gradient clipped to a squircle-ish rounded square.
grad = Image.new("RGB", (1, S))
for y in range(S):
    t = y / (S - 1)
    if t < 0.55:
        c = lerp((91, 124, 250), (68, 105, 225), t / 0.55)
    else:
        c = lerp((68, 105, 225), (49, 186, 156), (t - 0.55) / 0.45)
    grad.putpixel((0, y), c)
grad = grad.resize((S, S))
img.paste(grad, (0, 0), rounded_mask(S, 235))

# Soft top highlight.
shine = Image.new("RGBA", (S, S), (0, 0, 0, 0))
sd = ImageDraw.Draw(shine)
sd.ellipse((-180, -520, S + 180, 310), fill=(255, 255, 255, 38))
img.alpha_composite(shine)

# Window panel.
panel = Image.new("RGBA", (S, S), (0, 0, 0, 0))
pd = ImageDraw.Draw(panel)
pd.rounded_rectangle((156, 196, 868, 828), radius=96, fill=(255, 255, 255, 235))
pd.rounded_rectangle((156, 196, 868, 322), radius=96, fill=(240, 246, 255, 245))
pd.rectangle((156, 270, 868, 322), fill=(240, 246, 255, 245))
img.alpha_composite(panel)

# Window dots.
for i, color in enumerate([(255, 112, 128), (255, 193, 84), (83, 207, 145)]):
    x = 236 + i * 54
    d.ellipse((x - 15, 248 - 15, x + 15, 248 + 15), fill=color)

# Inside: a preview card with a link glyph.
d.rounded_rectangle((222, 380, 802, 746), radius=38, fill=(236, 243, 255, 255))
d.rounded_rectangle((268, 428, 756, 698), radius=28, fill=(255, 255, 255, 255))
# two chain links, tilted, forming a link glyph
link_layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ld = ImageDraw.Draw(link_layer)
# Rounded capsules approximated by thick rounded lines.
ld.line((430, 606, 526, 510), fill=(78, 111, 232, 255), width=52)
ld.line((500, 510, 596, 606), fill=(49, 186, 156, 255), width=52)
# Link end caps.
for cx, cy, col in [(414, 622, (78, 111, 232, 255)), (612, 494, (49, 186, 156, 255))]:
    ld.ellipse((cx - 30, cy - 30, cx + 30, cy + 30), outline=col, width=22)
# Outer rounded rings for link shape.
ld.arc((330, 520, 500, 690), 300, 120, fill=(78, 111, 232, 255), width=34)
ld.arc((524, 334, 694, 504), 120, 300, fill=(49, 186, 156, 255), width=34)
link_layer = link_layer.rotate(-8, center=(512, 560), resample=Image.Resampling.BICUBIC)
img.alpha_composite(link_layer)

# Subtle bottom shadow.
shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
shd = ImageDraw.Draw(shadow)
shd.rounded_rectangle((150, 798, 874, 858), radius=60, fill=(20, 40, 90, 38))
img.alpha_composite(shadow)

# Slight inner border for crispness.
border = Image.new("RGBA", (S, S), (0, 0, 0, 0))
bd = ImageDraw.Draw(border)
bd.rounded_rectangle((8, 8, S - 9, S - 9), radius=228, outline=(255, 255, 255, 62), width=10)

# Draw border before dropping alpha? alpha_composite onto img.
img.alpha_composite(border)

for size in (16, 32, 48, 128, 256):
    out = img.resize((size, size), Image.Resampling.LANCZOS)
    out.save(ICON_DIR / f"{size}.png", optimize=True)
    print(f"wrote {ICON_DIR / f'{size}.png'}")
