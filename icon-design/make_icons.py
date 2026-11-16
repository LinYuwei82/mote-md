import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT = "/Users/lin/Projects/mote/icon-design"
REF = os.path.join(OUT, "ref", "ref.png")

CANVAS = 1024
S = 2
W = CANVAS * S

# 主题：dark = 参考图深青底 + 米白字；mint / cream = 浅色底 + 深青字
PALETTES = {
    "peacock": dict(
        bg_top=(26, 128, 143), bg_bot=(8, 58, 72),
        glow=0.07, glow_rgb=(0.75, 1.0, 1.0), vig=0.10,
        rim=0.34, text_top=(255, 253, 246), text_bot=(236, 245, 240),
    ),
    "peacock-light": dict(
        bg_top=(38, 146, 160), bg_bot=(7, 61, 74),
        glow=0.07, glow_rgb=(0.75, 1.0, 1.0), vig=0.10,
        rim=0.36, text_top=(255, 253, 246), text_bot=(236, 245, 240),
    ),
    "dark": dict(
        bg_top=(16, 70, 78), bg_bot=(7, 43, 48),
        glow=0.055, glow_rgb=(0.45, 1.0, 0.95), vig=0.09,
        rim=0.22, text_top=(255, 253, 247), text_bot=(246, 241, 230),
    ),
    "vivid": dict(
        bg_top=(116, 231, 217), bg_bot=(20, 156, 148),
        glow=0.10, glow_rgb=(1.0, 1.0, 1.0), vig=0.08,
        rim=0.55, edge=0.0, text_top=(255, 253, 246), text_bot=(240, 247, 240),
    ),
    "vivid-soft": dict(
        bg_top=(150, 237, 230), bg_bot=(44, 189, 180),
        glow=0.10, glow_rgb=(1.0, 1.0, 1.0), vig=0.07,
        rim=0.40, edge=0.14, text_top=(9, 54, 60), text_bot=(14, 68, 75),
    ),
    "cream": dict(
        bg_top=(243, 240, 231), bg_bot=(216, 210, 195),
        glow=0.20, glow_rgb=(1.0, 1.0, 0.96), vig=0.07,
        rim=0.30, edge=0.24, text_top=(14, 62, 69), text_bot=(23, 79, 88),
    ),
}


def ttc(path, index):
    def factory(size):
        return ImageFont.truetype(path, size, index=index)
    return factory


def sf(style):
    def factory(size):
        f = ImageFont.truetype("/System/Library/Fonts/SFNS.ttf", size)
        f.set_variation_by_name(style)
        return f
    return factory


CJK_FONT = ttc("/System/Library/Fonts/Hiragino Sans GB.ttc", 2)
SF_BOLD = sf("Bold")


def rounded(style="Bold"):
    """资源圆体（Resource Han Rounded CN，OFL），圆角黑体，可变字重。"""
    path = os.path.join(OUT, "fonts", "ResourceHanRoundedCN-VF.otf")

    def factory(size):
        f = ImageFont.truetype(path, size)
        f.set_variation_by_name(style)
        return f
    return factory


def body_mask():
    ref = Image.open(REF).convert("RGBA").split()[-1]
    return ref.resize((W, W), Image.LANCZOS)


def gradient_canvas(p):
    yy = np.linspace(0, 1, W, dtype=np.float32)[:, None]
    xx = np.linspace(0, 1, W, dtype=np.float32)[None, :]

    t = np.clip((yy - 0.02) / 0.96, 0, 1) ** 1.1
    base = np.zeros((W, W, 3), np.float32)
    for i in range(3):
        base[..., i] = p["bg_top"][i] + (p["bg_bot"][i] - p["bg_top"][i]) * t

    d = np.sqrt(((xx - 0.28) / 1.05) ** 2 + ((yy - 0.12) / 0.95) ** 2)
    glow = np.clip(1 - d, 0, 1) ** 2.0 * p["glow"]
    base += glow[..., None] * 255.0 * np.array(p["glow_rgb"], np.float32)

    dc = np.sqrt((xx - 0.5) ** 2 + (yy - 0.5) ** 2) / 0.707
    vig = np.clip((dc - 0.55) / 0.45, 0, 1) ** 1.8 * p["vig"]
    base *= (1 - vig[..., None])
    return np.clip(base, 0, 255)


def rim_light(mask, p):
    inner = mask.filter(ImageFilter.MinFilter(7))
    rim = np.clip(np.asarray(mask, np.float32) - np.asarray(inner, np.float32), 0, 1) / 255.0
    yy = np.linspace(0, 1, W, dtype=np.float32)[:, None]
    fade = np.clip(1.2 - yy * 1.45, 0.08, 1.0)
    return rim * fade * p["rim"]


def edge_shade(mask, p):
    """浅色底：加极细的深色内描边，保证在白色/浅色背景上轮廓仍清晰。"""
    inner = mask.filter(ImageFilter.MinFilter(5))
    rim = np.clip(np.asarray(mask, np.float32) - np.asarray(inner, np.float32), 0, 1) / 255.0
    return rim * p.get("edge", 0.0)


def render_text(chars, factory, target_h, tracking=0.0, vcenter="bbox", thicken=0, dy=0):
    probe = 400
    font = factory(probe)
    adv = [font.getlength(c) for c in chars]
    gap = tracking * probe
    total = sum(adv) + gap * (len(chars) - 1)

    img = Image.new("L", (int(total) + probe * 2, probe * 3), 0)
    d = ImageDraw.Draw(img)
    x = probe
    for i, c in enumerate(chars):
        d.text((x, probe), c, font=font, fill=255)
        x += adv[i] + gap

    ink = img.crop(img.getbbox())
    if thicken:
        ink = ink.filter(ImageFilter.MaxFilter(thicken * 2 + 1))
    target_px = int(round(target_h * S))
    scale = target_px / ink.height
    ink = ink.resize((max(1, int(round(ink.width * scale))), target_px), Image.LANCZOS)
    ink = ink.filter(ImageFilter.GaussianBlur(0.6))

    out = Image.new("L", (W, W), 0)
    ox = int(round((W - ink.width) / 2))
    oy = int(round((W - ink.height) / 2))
    if vcenter == "x":  # 以小写字身（x-height）视觉居中
        first = ink.crop((0, 0, int(ink.width * 0.45) + 1, ink.height))
        fb = first.getbbox()
        oy -= int(round(oy + (fb[1] + fb[3]) / 2 - W / 2))
    oy += int(round(dy * S))
    out.paste(ink, (ox, oy))
    return out


def text_color(p):
    yy = np.linspace(0, 1, W, dtype=np.float32)[:, None, None]
    top = np.array(p["text_top"], np.float32)
    bot = np.array(p["text_bot"], np.float32)
    return np.broadcast_to(top + (bot - top) * yy, (W, W, 3))


MASK = body_mask()
MASK_ARR = np.asarray(MASK, np.float32)
M = MASK_ARR[..., None] / 255.0
_CACHE = {}


def backdrop(key):
    if key not in _CACHE:
        p = PALETTES[key]
        bg = gradient_canvas(p) + rim_light(MASK, p)[..., None] * 255.0
        e = edge_shade(MASK, p)[..., None]
        edge_col = np.array(p["text_bot"], np.float32)
        bg = bg * (1 - e) + edge_col * e
        _CACHE[key] = (
            np.concatenate([np.clip(bg * M, 0, 255), MASK_ARR[..., None]], axis=2),
            text_color(p),
        )
    return _CACHE[key]


def build(name, palette="dark", **kw):
    bg, ink_color = backdrop(palette)
    tl = np.asarray(render_text(**kw), np.float32)[..., None] / 255.0
    rgb = bg[..., :3] * (1 - tl) + ink_color * tl
    arr = np.concatenate([np.clip(rgb, 0, 255), bg[..., 3:]], axis=2).astype(np.uint8)
    im = Image.fromarray(arr, "RGBA").resize((CANVAS, CANVAS), Image.LANCZOS)
    os.makedirs(os.path.join(OUT, "work"), exist_ok=True)
    path = os.path.join(OUT, "work", f"{name}.png")
    im.save(path)
    return path


TU = dict(chars=["兔"], factory=rounded("Bold"), target_h=452, tracking=0.0, vcenter="bbox", thicken=0)
MD = dict(chars=["m", "d"], factory=SF_BOLD, target_h=332, tracking=-0.02, vcenter="x", thicken=0, dy=8)

ICNS_SIZES = [(16, "16x16"), (32, "16x16@2x"), (32, "32x32"), (64, "32x32@2x"),
              (128, "128x128"), (256, "128x128@2x"), (256, "256x256"),
              (512, "256x256@2x"), (512, "512x512"), (1024, "512x512@2x")]


def export(name, path):
    master = Image.open(path)
    master.save(os.path.join(OUT, f"{name}-1024.png"))
    iconset = os.path.join(OUT, "work", f"{name}.iconset")
    os.makedirs(iconset, exist_ok=True)
    for px, label in ICNS_SIZES:
        master.resize((px, px), Image.LANCZOS).save(os.path.join(iconset, f"icon_{label}.png"))
    return master


def main():
    finals = {
        "Tu": export("Tu", build("final_Tu", palette="peacock", **TU)),
        "MD": export("MD", build("final_MD", palette="vivid-soft", **MD)),
        "MD-dark": export("MD-dark", build("final_MD_dark", palette="dark", **MD)),
    }

    # 多尺寸：浅底 / 深底 各一行
    sizes = [256, 128, 64, 32]
    pad = 32
    row_h = 256 + pad * 2
    width = pad + sum(s + pad for s in sizes)
    rows = ["Tu", "MD"]
    for bg, tag in [((245, 244, 240, 255), "light"), ((22, 24, 26, 255), "dark")]:
        canvas = Image.new("RGBA", (width, row_h * len(rows)), bg)
        for r, name in enumerate(rows):
            x = pad
            for s in sizes:
                canvas.alpha_composite(
                    finals[name].resize((s, s), Image.LANCZOS),
                    (x, r * row_h + pad + (256 - s) // 2),
                )
                x += s + pad
        canvas.save(os.path.join(OUT, f"preview-{tag}.png"))

    # 成对预览
    tile = Image.new("RGBA", (1184, 592), (245, 244, 240, 255))
    tile.alpha_composite(finals["Tu"].resize((512, 512), Image.LANCZOS), (48, 40))
    tile.alpha_composite(finals["MD"].resize((512, 512), Image.LANCZOS), (624, 40))
    tile.save(os.path.join(OUT, "preview-pair.png"))

    # 备选：md 用浓鲜艳底 + 米白字
    vivid = export("MD-vivid", build("final_MD_vivid", palette="vivid", **MD))
    cmp2 = Image.new("RGBA", (1184, 592), (245, 244, 240, 255))
    cmp2.alpha_composite(finals["Tu"].resize((512, 512), Image.LANCZOS), (48, 40))
    cmp2.alpha_composite(vivid.resize((512, 512), Image.LANCZOS), (624, 40))
    cmp2.save(os.path.join(OUT, "preview-vivid-a.png"))


if __name__ == "__main__":
    main()
