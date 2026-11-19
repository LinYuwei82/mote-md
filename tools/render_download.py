#!/usr/bin/env python3
"""按 OSS 上的更新清单（Schema v2）重写官网页面里的版本信息。

页面上的版本号 / 体积 / SHA256 / 下载地址原本是手抄进 HTML 的兜底值，
发版后容易和线上产物对不上（DevCard 1.2.1 → 1.2.2 就漂移过）。
本脚本把 manifest.json 里的 platforms.<os>.artifacts.* 渲染进所有带
data-manifest 锚点的页面，站点脚本 site.js 运行时仍会做同样的校准，
这里只是让静态 HTML 本身也是最新的。

用法：
    python3 tools/render_download.py                 # 渲染 web/ 下所有带锚点的页面
    python3 tools/render_download.py --check         # 只比对，不一致退出 1（适合 CI / 发布前）
    python3 tools/render_download.py web/download/index.html
    python3 tools/render_download.py --manifest-dir dist   # 离线：读 dist/{product}.json

清单地址默认 https://dl.xiaotu.online/<product>/updates/stable/manifest.json。
"""

import argparse
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRODUCTS = ("mote", "xiaotu", "devcard")

# 与 web/assets/js/site.js 的 SOURCES 保持一致
SOURCES = {
    "mote-mac": ("mote", "macos", "dmg"),
    "mote-win-setup": ("mote", "windows", "setup"),
    "mote-win-zip": ("mote", "windows", "portable"),
    "xiaotu-mac": ("xiaotu", "macos", "dmg"),
    "xiaotu-win-setup": ("xiaotu", "windows", "setup"),
    "xiaotu-win-zip": ("xiaotu", "windows", "portable"),
    "devcard-mac": ("devcard", "macos", "dmg"),
    "devcard-win-setup": ("devcard", "windows", "setup"),
    "devcard-win-zip": ("devcard", "windows", "portable"),
}

ANCHOR_RE = re.compile(r'data-manifest="([^"]+)"')


def fetch_json(url):
    req = urllib.request.Request(url, headers={"Cache-Control": "no-cache", "User-Agent": "mote-render/1"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def load_manifests(base_url, manifest_dir):
    """返回 {product: manifest}；任何一个产品取不到都直接失败，避免渲染出半旧半新的页面。"""
    manifests = {}
    for product in PRODUCTS:
        if manifest_dir:
            path = Path(manifest_dir) / f"{product}.json"
            if not path.is_file():
                raise SystemExit(f"缺少清单文件：{path}")
            manifests[product] = json.loads(path.read_text(encoding="utf-8"))
        else:
            url = f"{base_url.rstrip('/')}/{product}/updates/stable/manifest.json?t={int(time.time())}"
            try:
                manifests[product] = fetch_json(url)
            except Exception as exc:  # 网络 / JSON 错误一并报出来
                raise SystemExit(f"拉取清单失败：{url}\n  {exc}")
        version = manifests[product].get("manifest_version")
        if version != 2:
            raise SystemExit(f"{product} 清单 manifest_version={version}，本脚本只支持 v2")
    return manifests


def human_size(size):
    if size < 1024 * 1024:
        return f"{size / 1024:.0f} KB"
    return f"{size / (1024 * 1024):.1f} MB"


def artifact_of(manifest, product, platform, artifact):
    platform_data = (manifest.get("platforms") or {}).get(platform) or {}
    info = (platform_data.get("artifacts") or {}).get(artifact)
    if not info:
        raise SystemExit(f"{product} 清单缺少 platforms.{platform}.artifacts.{artifact}")
    version = platform_data.get("version")
    sha = str(info.get("sha256", ""))
    size = info.get("size")
    url = str(info.get("url", ""))
    if not version:
        raise SystemExit(f"{product} 清单缺少 platforms.{platform}.version")
    if not re.fullmatch(r"[0-9a-f]{64}", sha):
        raise SystemExit(f"{product} 清单 platforms.{platform}.artifacts.{artifact}.sha256 不合法：{sha!r}")
    if not isinstance(size, int) or size <= 0:
        raise SystemExit(f"{product} 清单 platforms.{platform}.artifacts.{artifact}.size 不合法：{size!r}")
    if not re.match(r"https?://", url):
        raise SystemExit(f"{product} 清单 platforms.{platform}.artifacts.{artifact}.url 不合法：{url!r}")
    return {"version": version, "sha": sha, "size": size, "url": url}


def sub_field(text, pattern, replacement):
    """替换第一个匹配，返回 (新文本, 旧值, 是否变化)。"""
    match = re.search(pattern, text)
    if not match:
        return text, None, False
    new_text = text[: match.start()] + replacement(match) + text[match.end():]
    return new_text, match.group(0), new_text != text


def render_block(block, info):
    """对单个 data-manifest 区块内的字段做替换，返回 (新块, 变更列表)。"""
    changes = []
    rules = [
        ("version", r'(data-field="version"[^>]*>)[^<]*(?=<)',
         lambda m, v=f"v{info['version']}": m.group(1) + v),
        ("version-plain", r'(data-field="version-plain"[^>]*>)[^<]*(?=<)',
         lambda m, v=info["version"]: m.group(1) + v),
        ("size", r'(data-field="size"[^>]*>)[^<]*(?=<)',
         lambda m, v=f"{info['size']:,}": m.group(1) + v),
        ("size-human", r'(data-field="size-human"[^>]*>)[^<]*(?=<)',
         lambda m, v=f"约 {human_size(info['size'])}": m.group(1) + v),
        ("sha", r'(data-field="sha"[^>]*>)[^<]*(?=<)',
         lambda m, v=info["sha"]: m.group(1) + v),
        ("sha-title", r'(data-field="sha"[^>]*?title=")[^"]*(")',
         lambda m, v=info["sha"]: m.group(1) + v + m.group(2)),
        ("href", r'(data-field="href"[^>]*?href=")[^"]*(")',
         lambda m, v=info["url"]: m.group(1) + v + m.group(2)),
    ]
    for name, pattern, repl in rules:
        block, old, changed = sub_field(block, pattern, repl)
        if changed:
            changes.append((name, old, block))
    return block, changes


def render_text(text, manifests):
    """按锚点切块渲染，返回 (新文本, [(锚点, 字段, 行号)])。"""
    anchors = list(ANCHOR_RE.finditer(text))
    if not anchors:
        return text, []
    out, cursor, changes = [], 0, []
    for index, anchor in enumerate(anchors):
        key = anchor.group(1)
        start = anchor.start()
        end = anchors[index + 1].start() if index + 1 < len(anchors) else len(text)
        if key not in SOURCES:
            raise SystemExit(f"未知的 data-manifest 锚点：{key}")
        product, platform, artifact = SOURCES[key]
        info = artifact_of(manifests[product], product, platform, artifact)
        new_block, block_changes = render_block(text[start:end], info)
        for field, _old, _new in block_changes:
            line = text.count("\n", 0, start) + 1
            changes.append((key, field, line))
        out.append(text[cursor:start])
        out.append(new_block)
        cursor = end
    out.append(text[cursor:])
    return "".join(out), changes


def discover_pages(explicit):
    if explicit:
        return [Path(item).resolve() for item in explicit]
    return [path for path in sorted((ROOT / "web").rglob("*.html"))
            if 'data-manifest="' in path.read_text(encoding="utf-8")]


def main():
    parser = argparse.ArgumentParser(description="按更新清单渲染下载页版本信息")
    parser.add_argument("pages", nargs="*", help="要渲染的 HTML（默认：web/ 下所有带 data-manifest 的页面）")
    parser.add_argument("--base-url", default="https://dl.xiaotu.online", help="清单根地址")
    parser.add_argument("--manifest-dir", help="离线模式：从这里读取 {product}.json")
    parser.add_argument("--check", action="store_true", help="只比对不写入，有差异时退出码 1")
    args = parser.parse_args()

    manifests = load_manifests(args.base_url, args.manifest_dir)

    pages = discover_pages(args.pages)
    if not pages:
        raise SystemExit("没有找到带 data-manifest 的页面")

    total_changes = 0
    for path in pages:
        original = path.read_text(encoding="utf-8")
        rendered, changes = render_text(original, manifests)
        if not changes:
            print(f"一致  {path.relative_to(ROOT)}")
            continue
        total_changes += len(changes)
        printed = set()
        for key, field, line in changes:
            if (key, field) in printed:
                continue
            printed.add((key, field))
            print(f"差异  {path.relative_to(ROOT)}:{line}  {key}  {field}")
        if not args.check:
            path.write_text(rendered, encoding="utf-8")

    if args.check and total_changes:
        print(f"\n发现 {total_changes} 处与清单不一致，运行不带 --check 即可写入")
        return 1
    if total_changes:
        print(f"\n已更新 {total_changes} 处字段，页面现在与线上清单一致")
    else:
        print("\n所有页面均与线上清单一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
