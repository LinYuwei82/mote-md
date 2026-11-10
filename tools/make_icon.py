#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 Mote 的应用图标（零第三方依赖，仅用标准库）。

图形：圆角方形渐变底 + 白色 Markdown "M↓" 标识。
按目标尺寸逐个做矢量光栅化（而不是从大图缩放），保证 16px 也清晰。

输出：
  resources/icons/app.png         512x512
  resources/icons/app_256.png     256x256
  resources/icons/app.icns        macOS 图标（含 16~1024 的 iconset）
  resources/icons/app.ico         Windows 图标（16/24/32/48/64 BMP + 128/256 PNG）
  resources/win/app.ico           Windows .rc 资源用副本
  resources/samples/sample-diagram.png  示例文档里的图片
"""

import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON_DIR = os.path.join(ROOT, "resources", "icons")
SAMPLE_DIR = os.path.join(ROOT, "resources", "samples")

CANVAS = 1024.0
BG_INSET = 30.0
BG_RADIUS = 210.0
GRAD_START = (37, 99, 235)    # #2563EB
GRAD_END = (109, 40, 217)     # #6D28D9

STROKE = 45.0
# "M" 字：左竖线、下斜线、上斜线、右竖线
M_SEGMENTS = [
    ((197.0, 740.0), (197.0, 320.0)),
    ((197.0, 320.0), (377.0, 560.0)),
    ((377.0, 560.0), (557.0, 320.0)),
    ((557.0, 320.0), (557.0, 740.0)),
]
# 向下箭头：竖杆 + 箭头
ARROW_SEGMENTS = [
    ((747.0, 300.0), (747.0, 690.0)),
    ((667.0, 590.0), (747.0, 690.0)),
    ((747.0, 690.0), (827.0, 590.0)),
]


def clamp01(value):
    return 0.0 if value < 0.0 else (1.0 if value > 1.0 else value)


def capsule_distance(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    length_sq = vx * vx + vy * vy
    t = clamp01((wx * vx + wy * vy) / length_sq) if length_sq else 0.0
    return math.hypot(wx - t * vx, wy - t * vy)


def rounded_rect_distance(px, py, cx, cy, half_w, half_h, radius):
    qx = abs(px - cx) - (half_w - radius)
    qy = abs(py - cy) - (half_h - radius)
    ax, ay = max(qx, 0.0), max(qy, 0.0)
    return math.hypot(ax, ay) + min(max(qx, qy), 0.0) - radius


def render(size):
    """返回 size*size 的 RGBA 字节串。"""
    scale = size / CANVAS
    bg_cx = bg_cy = CANVAS / 2.0
    half = (CANVAS - 2.0 * BG_INSET) / 2.0
    gradient_span = CANVAS - 2.0 * BG_INSET

    data = bytearray(size * size * 4)
    offset = 0
    for y in range(size):
        py = (y + 0.5) / scale
        for x in range(size):
            px = (x + 0.5) / scale

            bg_distance = rounded_rect_distance(
                px, py, bg_cx, bg_cy, half, half, BG_RADIUS)
            bg_coverage = clamp01(0.5 - bg_distance * scale)
            if bg_coverage <= 0.0:
                offset += 4
                continue

            t = clamp01(((px - BG_INSET) + (py - BG_INSET)) / (2.0 * gradient_span))
            red = GRAD_START[0] + (GRAD_END[0] - GRAD_START[0]) * t
            green = GRAD_START[1] + (GRAD_END[1] - GRAD_START[1]) * t
            blue = GRAD_START[2] + (GRAD_END[2] - GRAD_START[2]) * t

            ink = 0.0
            for (ax, ay), (bx, by) in M_SEGMENTS + ARROW_SEGMENTS:
                distance = capsule_distance(px, py, ax, ay, bx, by) - STROKE
                ink = max(ink, clamp01(0.5 - distance * scale))

            if ink > 0.0:
                red = red * (1.0 - ink) + 255.0 * ink
                green = green * (1.0 - ink) + 255.0 * ink
                blue = blue * (1.0 - ink) + 255.0 * ink

            data[offset] = int(round(red))
            data[offset + 1] = int(round(green))
            data[offset + 2] = int(round(blue))
            data[offset + 3] = int(round(255.0 * bg_coverage))
            offset += 4
    return bytes(data)


def write_png(path, size, rgba):
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)  # filter: none
        raw += rgba[y * stride:(y + 1) * stride]

    def chunk(tag, payload):
        return (struct.pack(">I", len(payload)) + tag + payload
                + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as handle:
        handle.write(png)


def bmp_icon_image(size, rgba):
    """ICO 内嵌的 32bpp BMP（含 AND 掩码）。"""
    header = struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0,
                         size * size * 4, 0, 0, 0, 0)
    pixels = bytearray()
    for y in range(size - 1, -1, -1):
        row = rgba[y * size * 4:(y + 1) * size * 4]
        for i in range(0, len(row), 4):
            pixels += bytes((row[i + 2], row[i + 1], row[i], row[i + 3]))
    mask_stride = ((size + 31) // 32) * 4
    return header + bytes(pixels) + bytes(mask_stride * size)


def write_ico(path, images):
    count = len(images)
    directory = bytearray()
    payload = bytearray()
    data_offset = 6 + 16 * count
    for size, blob in images:
        directory += struct.pack("<BBBBHHII",
                                 size if size < 256 else 0,
                                 size if size < 256 else 0,
                                 0, 0, 1, 32, len(blob), data_offset)
        payload += blob
        data_offset += len(blob)
    with open(path, "wb") as handle:
        handle.write(struct.pack("<HHH", 0, 1, count) + bytes(directory) + bytes(payload))


def write_icns(iconset_pngs):
    if shutil.which("iconutil") is None:
        print("未找到 iconutil，跳过 .icns 生成")
        return False
    with tempfile.TemporaryDirectory() as temp_dir:
        iconset = os.path.join(temp_dir, "app.iconset")
        os.makedirs(iconset)
        for name, source in iconset_pngs:
            shutil.copyfile(source, os.path.join(iconset, name))
        result = subprocess.run(["iconutil", "-c", "icns", iconset,
                                 "-o", os.path.join(ICON_DIR, "app.icns")],
                                capture_output=True, text=True)
        if result.returncode != 0:
            print("iconutil 失败:", result.stderr.strip())
            return False
    return True


def main():
    os.makedirs(ICON_DIR, exist_ok=True)
    os.makedirs(SAMPLE_DIR, exist_ok=True)
    os.makedirs(os.path.join(ROOT, "resources", "win"), exist_ok=True)

    cache = {}

    def image(size):
        if size not in cache:
            cache[size] = render(size)
        return cache[size]

    png_paths = {}
    for size in (16, 24, 32, 48, 64, 128, 256, 512, 1024):
        path = os.path.join(ICON_DIR, "app_%d.png" % size)
        write_png(path, size, image(size))
        png_paths[size] = path

    shutil.copyfile(png_paths[512], os.path.join(ICON_DIR, "app.png"))

    ico_images = [(size, bmp_icon_image(size, image(size))) for size in (16, 24, 32, 48, 64)]
    for size in (128, 256):
        with open(png_paths[size], "rb") as handle:
            ico_images.append((size, handle.read()))
    write_ico(os.path.join(ICON_DIR, "app.ico"), ico_images)
    shutil.copyfile(os.path.join(ICON_DIR, "app.ico"),
                    os.path.join(ROOT, "resources", "win", "app.ico"))

    iconset = [
        ("icon_16x16.png", png_paths[16]),
        ("icon_16x16@2x.png", png_paths[32]),
        ("icon_32x32.png", png_paths[32]),
        ("icon_32x32@2x.png", png_paths[64]),
        ("icon_128x128.png", png_paths[128]),
        ("icon_128x128@2x.png", png_paths[256]),
        ("icon_256x256.png", png_paths[256]),
        ("icon_256x256@2x.png", png_paths[512]),
        ("icon_512x512.png", png_paths[512]),
        ("icon_512x512@2x.png", png_paths[1024]),
    ]
    write_icns(iconset)

    shutil.copyfile(png_paths[256], os.path.join(SAMPLE_DIR, "sample-diagram.png"))

    print("图标生成完成：")
    for path in sorted(os.listdir(ICON_DIR)):
        full = os.path.join(ICON_DIR, path)
        print("  %-20s %8d 字节" % (path, os.path.getsize(full)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
