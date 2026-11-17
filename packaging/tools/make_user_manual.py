#!/usr/bin/env python3
"""Mote 用户手册 Markdown → PDF

Usage: python3 /tmp/make_user_manual.py [input.md] [output.pdf]
Defaults: docs/Mote-用户手册.md → dist/Mote-用户手册.pdf
"""
import sys, os, re, math
from pathlib import Path

# --- Page geometry (A4, like the export PDF) ---
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm, inch
from reportlab.lib.colors import HexColor, white, black
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Image, KeepTogether,
    Table, TableStyle, PageBreak, Flowable
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

PAGE_W, PAGE_H = A4
MARGIN_L = MARGIN_R = 25 * mm
MARGIN_T = MARGIN_B = 25 * mm
CW = PAGE_W - MARGIN_L - MARGIN_R  # content width ≈ 160mm

# --- Register CJK font (PingFang SC on macOS, fallback STHeiti SC) ---
def register_fonts():
    candidates = [
        # PingFang 系列在较新 macOS 下可能在 Supplemental，也可能是独立文件
        ("/System/Library/Fonts/PingFang.ttc", 0),          # PingFang SC
        ("/System/Library/Fonts/Supplemental/PingFang.ttc", 0),
        ("/System/Library/Fonts/STHeiti Medium.ttc", 1),    # STHeitiSC-Medium (简体)
        ("/System/Library/Fonts/STHeiti Light.ttc", 1),     # STHeitiSC-Light
        ("/Library/Fonts/Arial Unicode.ttf", 0),
    ]
    font = None
    for path, subidx in candidates:
        if os.path.exists(path):
            try:
                pdfmetrics.registerFont(TTFont("CJK", path, subfontIndex=subidx))
                face = pdfmetrics.getFont("CJK").face.name
                print(f"   ✓ Registered CJK={face.decode() if isinstance(face, bytes) else face}")
                font = "CJK"
                break
            except Exception as e:
                print(f"   ✗ {path}[{subidx}]: {e}")
    if not font:
        raise RuntimeError("No CJK font found on this system")

    # Register Menlo for code
    try:
        pdfmetrics.registerFont(TTFont("Code", "/System/Library/Fonts/Menlo.ttc", subfontIndex=0))
    except Exception as e:
        print(f"   ⚠️ Code font fallback: {e}")
        try:
            pdfmetrics.registerFont(TTFont("Code", "/Library/Fonts/Arial Unicode.ttf", subfontIndex=0))
        except Exception:
            print("   ✗ Could not register code font, will use CJK for code blocks")
    return font

# --- Styles ---
def make_styles(font):
    code_font = "Code"
    base = dict(fontName=font, wordWrap="CJK")
    return {
        "cover_title": ParagraphStyle("cover_title", **base, fontSize=44, leading=52,
                                       alignment=TA_CENTER, textColor=HexColor("#1e3a5f"),
                                       spaceAfter=10),
        "cover_sub": ParagraphStyle("cover_sub", **base, fontSize=16, leading=22,
                                     alignment=TA_CENTER, textColor=HexColor("#5a6a7a")),
        "h1": ParagraphStyle("h1", **base, fontSize=20, leading=28,
                              textColor=HexColor("#1e3a5f"), spaceBefore=22, spaceAfter=10),
        "h2": ParagraphStyle("h2", **base, fontSize=16, leading=22,
                              textColor=HexColor("#2b6cb0"), spaceBefore=18, spaceAfter=8),
        "h3": ParagraphStyle("h3", **base, fontSize=13, leading=18,
                              textColor=HexColor("#4a5568"), spaceBefore=14, spaceAfter=6),
        "h4": ParagraphStyle("h4", **base, fontSize=11, leading=16,
                              textColor=HexColor("#718096"), spaceBefore=10, spaceAfter=4),
        "body": ParagraphStyle("body", **base, fontSize=11, leading=18,
                                textColor=HexColor("#2d3748"), spaceAfter=6, firstLineIndent=0),
        "bullet": ParagraphStyle("bullet", **base, fontSize=11, leading=18,
                                  leftIndent=18, spaceAfter=3, textColor=HexColor("#2d3748")),
        "code_block": ParagraphStyle("code_block", fontName=code_font, fontSize=9, leading=14,
                                      textColor=HexColor("#2d3748"), leftIndent=10, rightIndent=10,
                                      spaceAfter=4),
        "caption": ParagraphStyle("caption", **base, fontSize=9, leading=13,
                                   alignment=TA_CENTER, textColor=HexColor("#718096"),
                                   spaceBefore=4, spaceAfter=14),
        "table_h": ParagraphStyle("table_h", **base, fontSize=10, leading=14,
                                   textColor=white),
        "table_b": ParagraphStyle("table_b", **base, fontSize=10, leading=14,
                                   textColor=HexColor("#2d3748")),
        "quote": ParagraphStyle("quote", **base, fontSize=11, leading=18,
                                 leftIndent=20, textColor=HexColor("#4a5568"),
                                 spaceAfter=6, borderPad=6),
        "toc": ParagraphStyle("toc", **base, fontSize=11, leading=20,
                               textColor=HexColor("#2b6cb0")),
        "footer": ParagraphStyle("footer", **base, fontSize=8, leading=10,
                                  textColor=HexColor("#a0aec0"), alignment=TA_CENTER),
    }

# --- Markdown inline → reportlab <xxx> tags ---
_CJK_CHAR_RE = re.compile(r'[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\u2000-\u206f]')

_HTML_TAG_RE = re.compile(r'<[^>]+>')

def _code_to_rl(code_text):
    """Split inline code text into ASCII (→ Code font) and CJK (→ CJK font) segments.

    Menlo/Code fonts have no CJK glyphs — Chinese inside `...` would render as □.
    We keep ASCII parts in Code font, but emit CJK characters bare so they fall
    through to the enclosing paragraph's CJK font.  Already-emitted HTML tags
    (from prior link/bold steps) are treated as opaque and passed through.
    """
    # Split into alternating runs of: HTML tags <...> and plain text.
    # Re-insert <b>/</b> wrapper around non-CJK plain text runs only.
    tokens = []  # list of (kind, text): kind='tag' | 'text'
    pos = 0
    for m in _HTML_TAG_RE.finditer(code_text):
        if m.start() > pos:
            tokens.append(('text', code_text[pos:m.start()]))
        tokens.append(('tag', m.group(0)))
        pos = m.end()
    if pos < len(code_text):
        tokens.append(('text', code_text[pos:]))

    out_parts = []
    ascii_buf = []  # plain ASCII text accumulating for Code font

    def flush_ascii():
        nonlocal ascii_buf
        if ascii_buf:
            out_parts.append(
                f'<font face="Code"><b>{"".join(ascii_buf)}</b></font>'
            )
            ascii_buf = []

    for kind, txt in tokens:
        if kind == 'tag':
            flush_ascii()
            out_parts.append(txt)
            continue
        # plain text — walk char by char
        for ch in txt:
            if _CJK_CHAR_RE.match(ch):
                flush_ascii()
                out_parts.append(ch)
            else:
                ascii_buf.append(ch)
    flush_ascii()
    return "".join(out_parts)

def inline_to_rl(md, font):
    """Convert inline Markdown to reportlab Paragraph markup.
    Handles: **bold**, *italic*, `code`, [text](url), ![alt](path), --- HR.
    """
    # Images (standalone: ![alt](path))
    img_re = re.compile(r'!\[([^\]]*)\]\(([^)]+)\)')
    # Links
    link_re = re.compile(r'\[([^\]]+)\]\(([^)]+)\)')
    # Inline code — with CJK-aware handling
    code_re = re.compile(r'`([^`]+)`')
    # Bold
    bold_re = re.compile(r'\*\*([^*]+)\*\*')
    # Italic (single *)
    ital_re = re.compile(r'\*([^*]+)\*')

    # Order: images → links → code → bold → italic
    md = img_re.sub(r'[[IMG:\2]]', md)  # placeholder
    md = link_re.sub(r'<font color="#2b6cb0"><u>\1</u></font>', md)
    md = code_re.sub(lambda m: _code_to_rl(m.group(1)), md)
    md = bold_re.sub(r'<b>\1</b>', md)
    md = ital_re.sub(r'<i>\1</i>', md)
    return md

# --- Resolve screenshot path ---
def resolve_screenshot(path, md_file):
    md_abs = md_file.resolve() if not md_file.is_absolute() else md_file
    base_dir = md_abs.parent  # docs/ absolute
    # "../screenshots/xxx.png" → join with base_dir
    abs_path = (base_dir / path).resolve()
    return str(abs_path)

# --- Build image flowable ---
def make_image(path, caption, styles):
    if not os.path.exists(path):
        print(f"  ⚠️  image not found: {path}")
        return Spacer(1, 4 * mm)
    pil_img = __import__("PIL").Image.open(path)
    orig_w, orig_h = pil_img.size
    dpi_x = pil_img.info.get('dpi', (72, 72))[0]
    # Convert pixels → points
    w_pt = orig_w / dpi_x * 72
    h_pt = orig_h / dpi_x * 72

    # Fit to content width
    max_w = CW * 0.95
    if w_pt > max_w:
        scale = max_w / w_pt
        w_pt = max_w
        h_pt = h_pt * scale

    # Height cap
    max_h = CW * 1.3  # ~ A4 60% of height content
    if h_pt > max_h:
        scale = max_h / h_pt
        h_pt = max_h
        w_pt = w_pt * scale

    img = Image(path, width=w_pt, height=h_pt)
    img.hAlign = "CENTER"

    elems = [img]
    if caption:
        cap_p = Paragraph(caption, styles["caption"])
        elems.append(cap_p)
    return KeepTogether(elems)

# --- HR flowable ---
class HR(Flowable):
    def __init__(self, width=CW, color=HexColor("#e2e8f0")):
        super().__init__()
        self.width = width
        self.color = color
        self.height = 8
    def draw(self):
        self.canv.setStrokeColor(self.color)
        self.canv.setLineWidth(0.6)
        self.canv.line(0, 4, self.width, 4)

# --- Parse Markdown → story ---
def parse_md(md_file, styles, font):
    with open(md_file, "r", encoding="utf-8") as f:
        lines = f.readlines()

    story = []
    i = 0
    N = len(lines)

    def flush_paragraph(buf):
        if not buf:
            return
        text = " ".join(b.strip() for b in buf if b.strip())
        text = inline_to_rl(text, font)
        story.append(Paragraph(text, styles["body"]))
        buf.clear()

    para_buf = []
    in_code = False
    code_buf = []
    code_lang = ""
    table_buf = []

    while i < N:
        line = lines[i].rstrip("\n")

        # Fenced code block
        if line.startswith("```"):
            if not in_code:
                in_code = True
                code_lang = line[3:].strip()
                code_buf = []
            else:
                in_code = False
                code_text = "\n".join(code_buf)
                # Code block with gray background
                table_data = [[Paragraph(code_text, styles["code_block"])]]
                t = Table(table_data, colWidths=[CW * 0.96])
                t.setStyle(TableStyle([
                    ("BACKGROUND", (0, 0), (-1, -1), HexColor("#f7fafc")),
                    ("BOX", (0, 0), (-1, -1), 0.5, HexColor("#e2e8f0")),
                    ("LEFTPADDING", (0, 0), (-1, -1), 10),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                    ("TOPPADDING", (0, 0), (-1, -1), 8),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
                ]))
                story.append(Spacer(1, 2 * mm))
                story.append(t)
                story.append(Spacer(1, 2 * mm))
            i += 1
            continue

        if in_code:
            code_buf.append(line)
            i += 1
            continue

        # Skip empty lines (flush paragraph)
        if not line.strip():
            flush_paragraph(para_buf)
            i += 1
            continue

        # Headings
        h_match = re.match(r'^(#{1,6})\s+(.*)$', line)
        if h_match:
            flush_paragraph(para_buf)
            level = len(h_match.group(1))
            text = inline_to_rl(h_match.group(2).strip(), font)
            style = styles.get(f"h{level}", styles["h4"])
            story.append(Paragraph(text, style))
            i += 1
            continue

        # HR ---
        if re.match(r'^-{3,}$', line.strip()):
            flush_paragraph(para_buf)
            story.append(Spacer(1, 4 * mm))
            story.append(HR())
            story.append(Spacer(1, 4 * mm))
            i += 1
            continue

        # Blockquote >
        if line.startswith("> "):
            flush_paragraph(para_buf)
            q_text = inline_to_rl(line[2:], font)
            story.append(Paragraph(q_text, styles["quote"]))
            i += 1
            continue

        # Image line ![alt](path)
        img_match = re.match(r'^!\[([^\]]*)\]\(([^)]+)\)\s*$', line)
        if img_match:
            flush_paragraph(para_buf)
            caption = img_match.group(1)
            path = resolve_screenshot(img_match.group(2), md_file)
            story.append(make_image(path, caption, styles))
            i += 1
            continue

        # Table header + separator
        if "|" in line and i + 1 < N and re.match(r'^\s*\|?\s*-+\s*(\|\s*-+\s*)+\|?\s*$', lines[i+1].rstrip()):
            flush_paragraph(para_buf)
            # Collect table rows
            header_cells = [c.strip() for c in line.strip().strip("|").split("|")]
            i += 2  # skip separator
            data = [header_cells]
            while i < N and "|" in lines[i] and lines[i].strip():
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                data.append(cells)
                i += 1
            # Wrap with Paragraph for CJK + auto-wrap
            wrapped = []
            for ri, row in enumerate(data):
                row_wrap = []
                for cell in row:
                    style = styles["table_h"] if ri == 0 else styles["table_b"]
                    row_wrap.append(Paragraph(inline_to_rl(cell, font), style))
                wrapped.append(row_wrap)
            col_w = [CW / len(header_cells) * 0.98] * len(header_cells)
            t = Table(wrapped, colWidths=col_w, repeatRows=1)
            t.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), HexColor("#2b6cb0")),
                ("TEXTCOLOR", (0, 0), (-1, 0), white),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("ALIGN", (0, 0), (-1, -1), "LEFT"),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [HexColor("#f7fafc"), white]),
                ("GRID", (0, 0), (-1, -1), 0.5, HexColor("#e2e8f0")),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ]))
            story.append(Spacer(1, 2 * mm))
            story.append(t)
            story.append(Spacer(1, 3 * mm))
            continue

        # Bullet list
        if re.match(r'^[-*+]\s+', line):
            flush_paragraph(para_buf)
            text = inline_to_rl(re.sub(r'^[-*+]\s+', '', line), font)
            story.append(Paragraph("• " + text, styles["bullet"]))
            i += 1
            continue

        # Ordered list
        ol_match = re.match(r'^(\d+)\.\s+(.*)', line)
        if ol_match:
            flush_paragraph(para_buf)
            text = inline_to_rl(ol_match.group(2), font)
            story.append(Paragraph(f"{ol_match.group(1)}. " + text, styles["bullet"]))
            i += 1
            continue

        # TOC entry (skip — we'll handle separately if needed)
        if line.startswith("1. [快速开始](#"):
            i += 1
            continue

        # Accumulate into paragraph
        para_buf.append(line)
        i += 1

    flush_paragraph(para_buf)
    return story

# --- Build cover page ---
def build_cover(styles, font):
    story = [
        Spacer(1, 60 * mm),
        Paragraph("Mote", styles["cover_title"]),
        Spacer(1, 8 * mm),
        HR(width=CW * 0.4, color=HexColor("#2b6cb0")),
        Spacer(1, 12 * mm),
        Paragraph("用户手册 · User Manual", styles["cover_sub"]),
        Spacer(1, 30 * mm),
        Paragraph("C++20 原生 Markdown 编辑器", styles["body"]),
        Paragraph("macOS 14+ · Windows 10/11 · v1.0.0", styles["body"]),
        Paragraph("最后更新：2026-11-17", styles["body"]),
        Spacer(1, 100 * mm),
        Paragraph("© 2026 Mote", styles["footer"]),
        PageBreak(),
    ]
    return story

# --- Main ---
def main():
    md_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "docs" / "Mote-用户手册.md"
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parent.parent / "dist" / "Mote-用户手册.pdf"

    out_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"📖  Markdown : {md_path}")
    print(f"📄  Output   : {out_path}")

    print("🔤  Registering fonts...")
    font = register_fonts()
    print(f"   Using CJK font: {font}")

    styles = make_styles(font)

    doc = SimpleDocTemplate(
        str(out_path),
        pagesize=A4,
        leftMargin=MARGIN_L, rightMargin=MARGIN_R,
        topMargin=MARGIN_T, bottomMargin=MARGIN_B,
        title="Mote 用户手册",
        author="Mote Team",
    )

    story = []
    print("📑  Building cover...")
    story.extend(build_cover(styles, font))

    print("📝  Parsing Markdown...")
    md_story = parse_md(md_path, styles, font)
    story.extend(md_story)

    print("🖨️  Building PDF...")
    doc.build(story)

    size = out_path.stat().st_size
    print(f"✅  Done! {out_path} ({size:,} bytes, {size/1024:.1f} KB)")

if __name__ == "__main__":
    main()
