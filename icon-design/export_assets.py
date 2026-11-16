"""按选定的两套图标，导出全平台所需资源。

来源为 make_icons.py 的程序化渲染（矢量/字体绘制），不含任何水印与元数据。
"""
import os
import shutil
import struct
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

import make_icons as mk

OUT = mk.OUT
EXPORT = os.path.join(OUT, "export")

# 每个 app：master（1024 带 100px 留白）、调色板、文字规格
APPS = {
    "tu": dict(
        master="Tu-1024.png", icns="Tu.icns", palette="peacock", spec=mk.TU,
        word_col=(252, 249, 241),
        splash_light=((244, 246, 245), (229, 236, 235)),
        splash_dark=((7, 51, 61), (4, 31, 38)),
        og_bg=((12, 74, 86), (5, 40, 48)),
        og_text=(250, 247, 238),
    ),
    "md": dict(
        master="MD-1024.png", icns="MD.icns", palette="vivid-soft", spec=mk.MD,
        word_col=(9, 54, 60),
        splash_light=((244, 246, 245), (229, 236, 235)),
        splash_dark=((10, 58, 64), (5, 37, 42)),
        og_bg=((170, 240, 233), (86, 205, 195)),
        og_text=(9, 52, 58),
    ),
}

ICO_WEB = [16, 24, 32, 48, 64]
ICO_WIN = [16, 24, 32, 48, 64, 128, 256]
ICNS_SIZES = [(16, "16x16"), (32, "16x16@2x"), (32, "32x32"), (64, "32x32@2x"),
              (128, "128x128"), (256, "128x128@2x"), (256, "256x256"),
              (512, "256x256@2x"), (512, "512x512"), (1024, "512x512@2x")]

BODY_INSET = 100


def strip(im):
    """只保留像素数据，丢弃 EXIF / ICC / 文本块。"""
    clean = Image.new(im.mode, im.size)
    clean.paste(im)
    return clean


def save(im, path, **kw):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    strip(im).save(path, **kw)
    return path


def tight(master, size):
    """裁掉四周留白，让圆角方块铺满画布（保留四角透明）。"""
    body = master.crop((BODY_INSET, BODY_INSET, 1024 - BODY_INSET, 1024 - BODY_INSET))
    return body.resize((size, size), Image.LANCZOS)


def square(palette, spec, size=1024, glyph_scale=1.0):
    """满版方形（无透明）：用于 maskable / Apple Touch，交由系统裁圆角。"""
    p = mk.PALETTES[palette]
    bg = mk.gradient_canvas(p)
    kw = dict(spec)
    kw["target_h"] = kw["target_h"] * (1024 - 2 * BODY_INSET) / 1024 * glyph_scale
    tl = np.asarray(mk.render_text(**kw), np.float32)[..., None] / 255.0
    ink = mk.text_color(p)
    rgb = bg * (1 - tl) + ink * tl
    arr = np.clip(rgb, 0, 255).astype(np.uint8)
    return Image.fromarray(arr, "RGB").resize((size, size), Image.LANCZOS)


def write_ico(master, sizes, path):
    """PNG 压缩的多尺寸 .ico（Vista+ 支持，能完全控制降采样质量）。"""
    blobs = []
    for s in sizes:
        img = master.resize((s, s), Image.LANCZOS)
        buf = os.path.join(EXPORT, "_tmp.png")
        save(img, buf)
        with open(buf, "rb") as f:
            blobs.append((s, f.read()))
    os.remove(buf)

    header = struct.pack("<HHH", 0, 1, len(blobs))
    offset = 6 + 16 * len(blobs)
    entries, data = b"", b""
    for s, blob in blobs:
        entries += struct.pack("<BBBBHHII", 0 if s >= 256 else s, 0 if s >= 256 else s,
                               0, 0, 1, 32, len(blob), offset + len(data))
        data += blob
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(header + entries + data)


def vgrad(size, top, bottom):
    w, h = size
    t = np.linspace(0, 1, h, dtype=np.float32)[:, None, None] ** 1.1
    c = np.array(top, np.float32) + (np.array(bottom, np.float32) - np.array(top, np.float32)) * t
    return Image.fromarray(np.broadcast_to(c, (h, w, 3)).astype(np.uint8), "RGB")


def shadow_layer(icon, blur, color, alpha, dy):
    pad = int(blur * 3)
    mask = icon.split()[-1].filter(ImageFilter.GaussianBlur(blur))
    mask = mask.point(lambda v: int(v * alpha / 255))
    shadow = Image.new("RGBA", icon.size, color + (0,))
    shadow.putalpha(mask)
    canvas = Image.new("RGBA", (icon.width + pad * 2, icon.height + pad * 2), (0, 0, 0, 0))
    canvas.alpha_composite(shadow, (pad, pad + dy))
    return canvas, pad


def og_image(cfg, path):
    W, H = 1200, 630
    canvas = vgrad((W, H), *cfg["og_bg"]).convert("RGBA")

    icon = tight(Image.open(os.path.join(OUT, cfg["master"])), 380)
    pos = ((W - icon.width) // 2, (H - icon.height) // 2)
    if cfg["palette"] != "peacock":  # 浅底加一点柔和投影，深底保持干净
        halo, pad = shadow_layer(icon, 30, (10, 40, 45), 40, 8)
        canvas.alpha_composite(halo, (pos[0] - pad, pos[1] - pad))
    canvas.alpha_composite(icon, pos)
    save(canvas.convert("RGB"), path)


def splash(cfg, size, dark, path):
    W, H = size
    bg = vgrad(size, *(cfg["splash_dark"] if dark else cfg["splash_light"]))
    canvas = bg.convert("RGBA")
    icon_px = int(min(W, H) * 0.28)
    icon = tight(Image.open(os.path.join(OUT, cfg["master"])), icon_px)

    if dark:
        halo, pad = shadow_layer(icon, icon_px * 0.14, (255, 255, 255), 22, 0)
        y = (H - icon_px) // 2
        canvas.alpha_composite(halo, ((W - icon_px) // 2 - pad, y - pad))
    else:
        halo, pad = shadow_layer(icon, icon_px * 0.07, (18, 60, 62), 70, int(icon_px * 0.05))
        y = (H - icon_px) // 2
        canvas.alpha_composite(halo, ((W - icon_px) // 2 - pad, y - pad))

    canvas.alpha_composite(icon, ((W - icon_px) // 2, (H - icon_px) // 2))
    save(canvas.convert("RGB"), path)


def build_app(slug, cfg):
    root = os.path.join(EXPORT, slug)
    master = Image.open(os.path.join(OUT, cfg["master"]))
    flat = square(cfg["palette"], cfg["spec"])

    # Web：favicon / Apple Touch / PWA / OG
    web = os.path.join(root, "web")
    write_ico(tight(master, 1024), ICO_WEB, os.path.join(web, "favicon.ico"))
    for s in (16, 32, 48):
        save(tight(master, s), os.path.join(web, f"favicon-{s}x{s}.png"))
    save(flat.resize((180, 180), Image.LANCZOS), os.path.join(web, "apple-touch-icon.png"))
    for s in (192, 512):
        save(flat.resize((s, s), Image.LANCZOS), os.path.join(web, f"pwa-{s}x{s}.png"))
        maskable = square(cfg["palette"], cfg["spec"], size=s, glyph_scale=0.86)
        save(maskable, os.path.join(web, f"pwa-maskable-{s}x{s}.png"))
    og_image(cfg, os.path.join(web, "og-image.png"))

    # 打包产物：Windows / macOS / Linux
    desktop = os.path.join(root, "desktop")
    write_ico(tight(master, 1024), ICO_WIN, os.path.join(desktop, "windows", "icon.ico"))
    iconset = os.path.join(OUT, "work", f"{slug}.iconset")
    os.makedirs(iconset, exist_ok=True)
    for px, label in ICNS_SIZES:
        save(master.resize((px, px), Image.LANCZOS), os.path.join(iconset, f"icon_{label}.png"))
    os.makedirs(os.path.join(desktop, "macos"), exist_ok=True)
    shutil.copyfile(os.path.join(OUT, cfg["icns"]),
                    os.path.join(desktop, "macos", "icon.icns"))
    save(tight(master, 512), os.path.join(desktop, "linux", "icon-512.png"))

    # 应用内：关于页图标 + 启动图
    app = os.path.join(root, "app")
    for s in (256, 512):
        save(tight(master, s), os.path.join(app, f"about-icon-{s}.png"))
    for tag, dark in (("light", False), ("dark", True)):
        splash(cfg, (2048, 2048), dark, os.path.join(app, f"splash-2048x2048-{tag}.png"))
        splash(cfg, (1920, 1080), dark, os.path.join(app, f"splash-1920x1080-{tag}.png"))


if __name__ == "__main__":
    for slug, cfg in APPS.items():
        build_app(slug, cfg)
    shutil.rmtree(os.path.join(OUT, "work"), ignore_errors=True)
    for root, _, files in os.walk(EXPORT):
        for f in sorted(files):
            print(os.path.relpath(os.path.join(root, f), EXPORT))
