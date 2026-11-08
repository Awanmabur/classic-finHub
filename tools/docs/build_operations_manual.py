#!/usr/bin/env python3
"""Build the editable Word and printable HTML handbook from the Markdown source.

Requires Python 3 and python-docx. Run from the repository root:
  python3 tools/docs/build_operations_manual.py --edition "8 November 2026"
HTML can be printed to PDF in a browser. No application/database access is used.
"""
from pathlib import Path
import argparse
import html
import re

from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.oxml import OxmlElement
from docx.oxml.ns import qn


def inline_text(value):
    value = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1", value)
    return re.sub(r"[*`]", "", value).replace("<br>", " ")


def inline_html(value):
    value = html.escape(value)
    value = re.sub(r"`([^`]+)`", r"<code>\1</code>", value)
    value = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", value)
    def link(match):
        label, target = match.groups()
        if target.startswith(("#", "https://", "http://")):
            href = target
        elif re.fullmatch(r"[A-Za-z0-9_./-]+(?:#[A-Za-z0-9_-]+)?", target):
            href = "../" + target
        else:
            return label
        return f'<a href="{href}">{label}</a>'
    value = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", link, value)
    return value


def word_runs(paragraph, value):
    value = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1", value)
    for token in re.split(r"(\*\*.*?\*\*|`[^`]+`)", value):
        if not token:
            continue
        run = paragraph.add_run(token[2:-2] if token.startswith("**") else token[1:-1] if token.startswith("`") else token)
        if token.startswith("**"):
            run.bold = True
        if token.startswith("`"):
            run.font.name = "Consolas"
            run.font.size = Pt(9)


def blocks(source):
    lines = source.splitlines()
    index = 0
    while index < len(lines):
        line = lines[index]
        if not line.strip():
            index += 1
            continue
        if line.startswith("```"):
            code = []
            index += 1
            while index < len(lines) and not lines[index].startswith("```"):
                code.append(lines[index])
                index += 1
            yield "code", "\n".join(code)
        elif re.match(r"^#{1,6}\s", line):
            mark, text = line.split(" ", 1)
            yield "heading", (len(mark), text)
        elif line.lstrip().startswith("|"):
            rows = []
            while index < len(lines) and lines[index].lstrip().startswith("|"):
                row = [cell.strip() for cell in lines[index].strip().strip("|").split("|")]
                if not all(re.fullmatch(r":?-{2,}:?", cell.replace(" ", "")) for cell in row):
                    rows.append(row)
                index += 1
            yield "table", rows
            continue
        elif re.match(r"^\s*(?:[-*]|\d+[.)])\s+", line):
            match = re.match(r"^(\s*)([-*]|\d+[.)])\s+(.*)", line)
            yield "item", (len(match[1]) // 2, match[2], match[3])
        elif line.strip() in ("---", "***", "___"):
            yield "rule", None
        elif line.startswith("> "):
            yield "note", line[2:]
        else:
            text = [line.strip()]
            while index + 1 < len(lines) and lines[index + 1].strip() and not re.match(r"^(?:#{1,6}\s|\s*[-*]\s|\s*\d+[.)]\s|\||```|>\s)", lines[index + 1]):
                index += 1
                text.append(lines[index].strip())
            yield "paragraph", " ".join(text)
        index += 1


def build(source, output, edition):
    parsed = []
    in_contents = False
    for kind, value in blocks(source.read_text(encoding="utf-8")):
        if kind == "heading" and value[0] <= 2:
            in_contents = value[1] == "Contents"
        if not in_contents:
            parsed.append((kind, value))
    output.mkdir(parents=True, exist_ok=True)
    document = Document()
    section = document.sections[0]
    section.page_width = Inches(8.27)
    section.page_height = Inches(11.69)
    section.top_margin = section.bottom_margin = Inches(.7)
    section.left_margin = section.right_margin = Inches(.75)
    normal = document.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(10.5)
    normal.paragraph_format.space_after = Pt(7)
    normal.paragraph_format.line_spacing = 1.12
    for level in range(1, 5):
        style = document.styles[f"Heading {level}"]
        style.font.name = "Calibri"
        style.font.color.rgb = RGBColor.from_string("082C52")
        style.paragraph_format.keep_with_next = True
    section.header.paragraphs[0].text = "CLASSICFIN HUB  |  OPERATIONS MANUAL"
    footer = section.footer.paragraphs[0]
    footer.text = "Controlled operating guide  •  Page "
    field = OxmlElement("w:fldSimple")
    field.set(qn("w:instr"), "PAGE")
    footer._p.append(field)
    title = document.add_paragraph("ClassicFin Hub", "Title")
    title.runs[0].font.color.rgb = RGBColor.from_string("082C52")
    document.add_paragraph("Platform and tenant operations manual", "Subtitle")
    document.add_paragraph("From first onboarding to daily operations, reconciliation and recovery.")
    document.add_paragraph(f"Edition: {edition}. Read the role and permission requirements before each procedure.")
    document.add_paragraph("This guide describes implemented workflows. It does not certify provider settlement or replace the production deployment runbook.")
    document.add_page_break()
    document.add_heading("Contents", 1)
    headings = [text for kind, value in parsed if kind == "heading" for level, text in [value] if level == 2]
    for heading in headings:
        document.add_paragraph(inline_text(heading), "List Bullet")
    document.add_page_break()
    body = []
    for kind, value in parsed:
        if kind == "heading":
            level, text = value
            if level == 1:
                continue
            document.add_heading(inline_text(text), min(level - 1, 4))
            anchor = re.sub(r"[^a-z0-9-]", "", inline_text(text).lower().replace(" ", "-"))
            body.append(f'<h{min(level,5)} id="{anchor}">{inline_html(text)}</h{min(level,5)}>')
        elif kind == "table":
            if not value:
                continue
            width = max(map(len, value))
            table = document.add_table(rows=1, cols=width)
            table.style = "Table Grid"
            repeat = OxmlElement("w:tblHeader")
            table.rows[0]._tr.get_or_add_trPr().append(repeat)
            html_rows = []
            for row_index, row in enumerate(value):
                cells = table.rows[0].cells if row_index == 0 else table.add_row().cells
                for column in range(width):
                    word_runs(cells[column].paragraphs[0], row[column] if column < len(row) else "")
                    for paragraph in cells[column].paragraphs:
                        for run in paragraph.runs:
                            run.font.size = Pt(9)
                            if row_index == 0:
                                run.bold = True
                tag = "th" if row_index == 0 else "td"
                html_rows.append("<tr>" + "".join(f"<{tag}>{inline_html(cell)}</{tag}>" for cell in row) + "</tr>")
            body.append("<table>" + "".join(html_rows) + "</table>")
            document.add_paragraph()
        elif kind == "item":
            depth, marker, text = value
            numbered = marker[0].isdigit()
            paragraph = document.add_paragraph(style="Normal" if numbered else "List Bullet")
            paragraph.paragraph_format.left_indent = Inches(.25 + min(depth, 3) * .18)
            paragraph.paragraph_format.first_line_indent = Inches(-.18)
            word_runs(paragraph, f"{marker} {text}" if numbered else text)
            body.append(f'<p class="item" style="margin-left:{min(depth,3)*14}px">{html.escape(marker) if numbered else "•"} {inline_html(text)}</p>')
        elif kind == "code":
            for line in value.splitlines():
                paragraph = document.add_paragraph()
                run = paragraph.add_run(line)
                run.font.name = "Consolas"
                run.font.size = Pt(8)
                paragraph.paragraph_format.space_after = Pt(0)
            body.append("<pre>" + html.escape(value) + "</pre>")
        elif kind == "rule":
            body.append("<hr>")
        else:
            paragraph = document.add_paragraph()
            word_runs(paragraph, value)
            body.append(f'<p class="{"note" if kind=="note" else ""}">{inline_html(value)}</p>')
    document.core_properties.title = "ClassicFin Hub operations manual"
    document.core_properties.subject = "Platform onboarding, tenant setup, daily operations and reconciliation"
    document.core_properties.author = "ClassicFin Hub"
    document.save(output / "OPERATIONS_MANUAL.docx")
    contents = "".join(f"<li>{inline_html(heading)}</li>" for heading in headings)
    contents = '<ul style="list-style:none;padding-left:0">' + contents + '</ul>'
    css = """@page{size:A4;margin:18mm 17mm 20mm}*{box-sizing:border-box}body{font:10.5pt/1.38 Arial,sans-serif;color:#142337}h1,h2,h3,h4,h5{color:#082c52;break-after:avoid}h2{font-size:18pt;margin:22pt 0 10pt}h3{font-size:13pt;margin:15pt 0 7pt}p{margin:0 0 7pt;orphans:3;widows:3}.cover{break-after:page;padding:48mm 0 0}.brand{font-size:14pt;letter-spacing:2pt;color:#0d4f91}.cover h1{font-size:30pt;line-height:1.1}.subtitle{font-size:16pt;color:#566170}.contents{break-after:page}table{border-collapse:collapse;width:100%;margin:10pt 0 14pt;font-size:8.5pt;overflow-wrap:anywhere}th,td{border:1px solid #d9e3ef;padding:6pt;text-align:left;vertical-align:top}th{background:#eef4fb;color:#082c52}tr{break-inside:avoid}code{font:9pt Consolas,monospace;background:#eef4fb;padding:1pt 3pt}pre{font:8.5pt/1.35 Consolas,monospace;background:#f4f7fb;border-left:3px solid #0d4f91;padding:9pt;white-space:pre-wrap;overflow-wrap:anywhere}.item{padding-left:10pt}.note{border-left:3px solid #0d4f91;padding:6pt 10pt;background:#f7f9fc}hr{border:0;border-top:1px solid #d9e3ef;margin:14pt 0}"""
    page = f'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ClassicFin Hub operations manual</title><style>{css}</style><body><section class="cover"><p class="brand">CLASSICFIN HUB</p><h1>Platform and tenant<br>operations manual</h1><p class="subtitle">From onboarding to daily operations,<br>reconciliation and recovery</p><p>Edition: {html.escape(edition)}</p><p>Use the role and permission requirements in each procedure.<br>Production deployment procedures are maintained separately.</p></section><section class="contents"><h2>Contents</h2>{contents}</section>'+"\n".join(body)+"</body></html>"
    (output / "OPERATIONS_MANUAL.html").write_text(page, encoding="utf-8")
    print(f"Built Word and HTML manuals from {len(parsed)} content blocks.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("docs/OPERATIONS_MANUAL.md"))
    parser.add_argument("--output-dir", type=Path, default=Path("docs/operations"))
    parser.add_argument("--edition", required=True, help="Reader-facing edition date, for example 8 November 2026")
    args = parser.parse_args()
    build(args.source, args.output_dir, args.edition)
