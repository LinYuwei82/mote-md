#!/usr/bin/env python3
"""Mote 前端源码拆分 / 拼接。

P1 机械拆分已完成：resources/web/src/*.js 是唯一源码，
resources/web/editor.js 现在是构建产物（CMake 在构建期按 manifest 拼接）。

本脚本保留两个用途：
- bundle：本地手动生成 editor.js（--check 校验，--out - 输出到 stdout）
- split：从历史 bundle 重新拆分分片（需要 --from 指定旧文件）

用法（在仓库根执行）：
  python3 tools/editor/split_editor.py bundle            # 写回 resources/web/editor.js
  python3 tools/editor/split_editor.py bundle --check
  python3 tools/editor/split_editor.py bundle --out -    # 输出到 stdout
  python3 tools/editor/split_editor.py status
  python3 tools/editor/split_editor.py split --from /path/to/old-editor.js
  python3 tools/editor/split_editor.py subsplit 70-dom-events.js --at 356:70b-xxx.js

约束：
- 分片不添加任何头注释，内容与原文完全一致。
- 所有分片共用 editor.js 原有的外层 IIFE，拼接顺序由 manifest 决定。
- 换行与 BOM 原样保留（读写都使用 newline=""）。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BUNDLE = ROOT / "resources/web/editor.js"
SRC_DIR = ROOT / "resources/web/src"
MANIFEST = SRC_DIR / "editor.manifest.json"

# 现有 editor.js 里的 section 注释 → 分片文件名。
# 新增 section 时必须在这里登记，避免拆分顺序悄悄漂移。
SECTION_FILES = {
    "基础工具": "10-util.js",
    "代码块语法高亮": "20-highlight.js",
    "Markdown 渲染": "30-markdown-render.js",
    "文档模型与选区": "40-document-model.js",
    "所见即所得编辑": "50-wysiwyg-editing.js",
    "目录侧栏": "60-toc.js",
    "缩放与视图状态": "61-view-state.js",
    "标记标签避让": "62-live-markers.js",
    "DOM 事件": "70-dom-events.js",
    "替换：命中 → 整篇原文的绝对区间": "71-find-replace.js",
    "源码模式：同一套规则作用于 textarea 文本": "72-source-mode.js",
    "右键「转为」": "73-turn-menu.js",
    "插入指示线": "74-insert-line.js",
    "手柄显示与定位": "75-block-handle.js",
    "拖拽重排（指针事件，不依赖 HTML5 DnD）": "76-drag-reorder.js",
    "块菜单": "77-block-menu.js",
    "块菜单动作": "78-block-menu-actions.js",
    "悬停 / 焦点 / 滚动联动": "79-hover-focus-scroll.js",
    "导出自包含 HTML": "80-export-html.js",
}

BOOT_FILE = "00-boot.js"

SECTION_RE = re.compile(r"^  /\* -{2,} (.+?) -{2,} \*/\n?", re.MULTILINE)


def read_text(path: Path) -> str:
    # newline="" 保留原始换行符，避免 CRLF 被悄悄改成 LF。
    with path.open("r", encoding="utf-8", newline="") as handle:
        return handle.read()


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        handle.write(text)


def split_text(text: str) -> list[tuple[str, str]]:
    """返回 [(文件名, 分片内容)]；拼起来必须等于 text。"""
    markers = list(SECTION_RE.finditer(text))
    if not markers:
        raise SystemExit("未在 editor.js 中找到任何 section 注释，无法拆分")

    parts: list[tuple[str, str]] = []
    first = markers[0].start()
    if first > 0:
        parts.append((BOOT_FILE, text[:first]))

    seen: set[str] = set()
    for index, marker in enumerate(markers):
        title = marker.group(1).strip()
        name = SECTION_FILES.get(title)
        if name is None:
            raise SystemExit(
                f"未登记的 section：{title!r}\n"
                "请在 tools/editor/split_editor.py 的 SECTION_FILES 中补上文件名后再拆分"
            )
        if name in seen:
            raise SystemExit(f"section 文件名重复：{name}")
        seen.add(name)
        end = markers[index + 1].start() if index + 1 < len(markers) else len(text)
        parts.append((name, text[marker.start():end]))

    joined = "".join(part for _, part in parts)
    if joined != text:
        raise SystemExit("内部错误：分片拼接结果与原文不一致")
    return parts


def load_manifest() -> dict:
    if not MANIFEST.exists():
        raise SystemExit(f"缺少清单：{MANIFEST.relative_to(ROOT)}，请先执行 split")
    with MANIFEST.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def bundle_text() -> str:
    manifest = load_manifest()
    names = manifest.get("files") or []
    if not names:
        raise SystemExit("清单 files 为空")
    return "".join(read_text(SRC_DIR / name) for name in names)


def first_difference(left: str, right: str) -> str:
    limit = min(len(left), len(right))
    for index in range(limit):
        if left[index] != right[index]:
            start = max(0, index - 30)
            end = index + 30
            return (
                f"首个差异在偏移 {index}\n"
                f"  editor.js: {left[start:end]!r}\n"
                f"  src 拼接:  {right[start:end]!r}"
            )
    return f"长度不同：editor.js={len(left)}，src 拼接={len(right)}"


def command_split(args: argparse.Namespace) -> int:
    source_path = Path(args.source) if args.source else BUNDLE
    if not source_path.exists():
        raise SystemExit(
            f"找不到待拆分文件 {source_path}\n"
            "editor.js 现在是构建产物；如需从历史 bundle 重新拆分，请用 --from 指定文件"
        )

    existing = []
    if SRC_DIR.exists():
        existing = sorted(path.name for path in SRC_DIR.iterdir() if path.is_file())
    if existing and not args.force:
        raise SystemExit(
            f"{SRC_DIR.relative_to(ROOT)} 已存在文件（{', '.join(existing[:5])}…）；"
            "确认要覆盖时加 --force"
        )

    text = read_text(source_path)
    parts = split_text(text)

    if args.force and existing:
        # 只删除上一次清单里的分片，避免误删将来可能加入的其它文件。
        old_names: set[str] = set()
        if MANIFEST.exists():
            try:
                old_names = set(load_manifest().get("files") or [])
            except SystemExit:
                old_names = set()
        if not old_names:
            old_names = {path.name for path in SRC_DIR.glob("*.js")}
        for name in old_names:
            target = SRC_DIR / name
            if target.exists():
                target.unlink()

    for name, chunk in parts:
        write_text(SRC_DIR / name, chunk)

    manifest = {
        "version": 1,
        "bundle": "resources/web/editor.js",
        "note": "由 tools/editor/split_editor.py split 生成；files 顺序即拼接顺序。",
        "files": [name for name, _ in parts],
    }
    write_text(MANIFEST, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")

    print(f"已拆分 {len(parts)} 个文件到 {SRC_DIR.relative_to(ROOT)}/")
    for name, chunk in parts:
        print(f"  {name:<28} {chunk.count(chr(10)):>5} 行")

    rebuilt = "".join(chunk for _, chunk in parts)
    if rebuilt != text:
        print("错误：拆分后拼接结果与 editor.js 不一致", file=sys.stderr)
        return 1
    print(f"验证通过：分片拼接结果与 {source_path.name} 逐字节一致")
    return 0


def command_bundle(args: argparse.Namespace) -> int:
    text = bundle_text()
    if args.check:
        if not BUNDLE.exists():
            print("editor.js 未生成（构建产物）；分片清单完整")
            return 0
        current = read_text(BUNDLE)
        if current != text:
            print("失败：src 拼接结果与 editor.js 不一致", file=sys.stderr)
            print(first_difference(current, text), file=sys.stderr)
            return 1
        print("通过：src 拼接结果与 editor.js 逐字节一致")
        return 0

    if args.out == "-":
        sys.stdout.write(text)
        return 0

    out = Path(args.out) if args.out else BUNDLE
    if not out.is_absolute():
        out = ROOT / out
    write_text(out, text)
    try:
        shown = out.relative_to(ROOT)
    except ValueError:
        shown = out
    print(f"已写出 {shown}")
    return 0


def command_subsplit(args: argparse.Namespace) -> int:
    manifest = load_manifest()
    names = list(manifest.get("files") or [])
    target = args.target
    if target not in names:
        raise SystemExit(f"清单中没有分片：{target}")

    target_path = SRC_DIR / target
    text = read_text(target_path)
    lines = text.splitlines(keepends=True)

    specs: list[tuple[int, str]] = []
    for spec in args.at:
        line_text, separator, new_name = spec.partition(":")
        if not separator or not line_text.isdigit() or not new_name:
            raise SystemExit(f"--at 格式应为 LINE:NEW_NAME：{spec!r}")
        line_number = int(line_text)
        if line_number < 1 or line_number > len(lines):
            raise SystemExit(f"切分行号越界：{line_number}（文件共 {len(lines)} 行）")
        specs.append((line_number, new_name))

    specs.sort(key=lambda item: item[0])
    seen_lines: set[int] = set()
    for line_number, _ in specs:
        if line_number in seen_lines:
            raise SystemExit(f"重复的切分行号：{line_number}")
        seen_lines.add(line_number)

    # 允许用 LINE=1 给首片改名；否则首片沿用原文件名。
    if specs and specs[0][0] == 1:
        first_name = specs[0][1]
        specs = specs[1:]
    else:
        first_name = target

    part_names = [first_name] + [name for _, name in specs]
    if len(set(part_names)) != len(part_names):
        raise SystemExit("新分片名重复")
    others = set(names) - {target}
    for name in part_names:
        if name in others:
            raise SystemExit(f"新分片名已存在于清单：{name}")
        if (SRC_DIR / name).exists() and name != target:
            raise SystemExit(f"目标文件已存在：{name}")

    bounds = [1] + [line for line, _ in specs] + [len(lines) + 1]
    parts: list[tuple[str, str]] = []
    for index, name in enumerate(part_names):
        start = bounds[index] - 1
        end = bounds[index + 1] - 1
        parts.append((name, "".join(lines[start:end])))

    rebuilt = "".join(chunk for _, chunk in parts)
    if rebuilt != text:
        raise SystemExit("内部错误：subsplit 拼接结果与目标文件不一致")

    for name, chunk in parts:
        write_text(SRC_DIR / name, chunk)
    if target not in part_names:
        target_path.unlink()

    position = names.index(target)
    names[position:position + 1] = part_names
    manifest["files"] = names
    write_text(MANIFEST, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")

    print(f"已把 {target} 拆成 {len(parts)} 个分片：")
    for name, chunk in parts:
        print(f"  {name:<32} {chunk.count(chr(10)):>5} 行")
    print("验证通过：分片拼接结果与拆分前逐字节一致")
    return 0


def command_status(args: argparse.Namespace) -> int:
    if not MANIFEST.exists():
        print("尚未拆分：没有 src/editor.manifest.json")
        return 1
    manifest = load_manifest()
    names = manifest.get("files") or []
    missing = [name for name in names if not (SRC_DIR / name).exists()]
    on_disk = {path.name for path in SRC_DIR.glob("*.js")}
    extra = sorted(on_disk - set(names))
    print(f"分片：{len(names)} 个；缺失：{len(missing)}；清单外 .js：{len(extra)}")
    if missing:
        print("  缺失：" + ", ".join(missing))
    if extra:
        print("  清单外：" + ", ".join(extra))
    if missing or extra:
        return 1
    if not BUNDLE.exists():
        print("editor.js 未生成（构建产物）；分片清单完整")
        return 0
    current = read_text(BUNDLE)
    rebuilt = bundle_text()
    if current != rebuilt:
        print("editor.js 与 src 拼接结果不一致")
        print(first_difference(current, rebuilt))
        return 1
    print("editor.js 与 src 拼接结果一致")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Mote 前端源码拆分 / 拼接")
    sub = parser.add_subparsers(dest="command", required=True)

    split = sub.add_parser("split", help="从历史 bundle 重新拆成 src/*.js")
    split.add_argument("--from", dest="source", help="待拆分文件；默认 resources/web/editor.js")
    split.add_argument("--force", action="store_true", help="覆盖已有分片")
    split.set_defaults(func=command_split)

    bundle = sub.add_parser("bundle", help="按清单拼接分片")
    bundle.add_argument("--check", action="store_true", help="只校验，不写出")
    bundle.add_argument("--out", help="输出路径；缺省写回 resources/web/editor.js，- 表示 stdout")
    bundle.set_defaults(func=command_bundle)

    status = sub.add_parser("status", help="检查清单、分片与 editor.js 是否一致")
    status.set_defaults(func=command_status)

    subsplit = sub.add_parser("subsplit", help="按行号把一个分片继续拆成多个")
    subsplit.add_argument("target", help="现有分片名，如 70-dom-events.js")
    subsplit.add_argument(
        "--at",
        action="append",
        required=True,
        metavar="LINE:NEW_NAME",
        help="在第 LINE 行前切分，新分片名为 NEW_NAME；LINE=1 表示给首片改名",
    )
    subsplit.set_defaults(func=command_subsplit)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
