# -*- coding: utf-8 -*-
"""EPUB 正文提取（离线，python 标准库）。
用法：python3 epub.py <文件> <最多字符> <最多章节>
"""
import json
import posixpath
import re
import sys
import zipfile
from html.parser import HTMLParser


class TextGrab(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []
        self.skip = 0
        self.title = ""

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1
        elif tag in ("p", "div", "br", "h1", "h2", "h3", "h4", "h5", "li", "tr", "section"):
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self.skip > 0:
            self.skip -= 1
        elif tag in ("p", "div", "h1", "h2", "h3", "h4", "h5", "li", "tr", "section"):
            self.out.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.out.append(data)

    def text(self):
        raw = "".join(self.out)
        raw = raw.replace("\u00a0", " ")
        lines = []
        for ln in raw.split("\n"):
            ln = re.sub(r"[ \t]+", " ", ln).strip()
            if ln:
                lines.append(ln)
        return "\n".join(lines)


def fail(msg):
    print(json.dumps({"ok": False, "error": str(msg)[:300]}, ensure_ascii=True))
    sys.exit(0)


def main():
    if len(sys.argv) < 2:
        fail("缺少文件路径")
    path = sys.argv[1]
    max_chars = int(sys.argv[2]) if len(sys.argv) > 2 else 9000
    max_chaps = int(sys.argv[3]) if len(sys.argv) > 3 else 40
    try:
        z = zipfile.ZipFile(path)
    except Exception as e:
        fail("打不开 epub：" + str(e))

    names = set(z.namelist())
    opf_path = ""
    try:
        cont = z.read("META-INF/container.xml").decode("utf-8", "ignore")
        m = re.search(r'full-path="([^"]+)"', cont)
        if m:
            opf_path = m.group(1)
    except Exception:
        pass
    if not opf_path:
        for n in names:
            if n.lower().endswith(".opf"):
                opf_path = n
                break
    if not opf_path:
        fail("这个 epub 里找不到 OPF（可能不是标准 epub）")

    try:
        opf = z.read(opf_path).decode("utf-8", "ignore")
    except Exception as e:
        fail("读 OPF 失败：" + str(e))
    base = posixpath.dirname(opf_path)

    title = ""
    m = re.search(r"<dc:title[^>]*>([^<]*)</dc:title>", opf, re.I)
    if m:
        title = m.group(1).strip()

    items = {}
    for tag in re.findall(r"<item\b[^>]*>", opf, re.I):
        mid = re.search(r'\bid="([^"]+)"', tag)
        href = re.search(r'\bhref="([^"]+)"', tag)
        if mid and href:
            items[mid.group(1)] = href.group(1)

    order = re.findall(r'<itemref\b[^>]*idref="([^"]+)"', opf, re.I)
    if not order:
        order = list(items.keys())

    parts = []
    total = 0
    used = 0
    for idref in order:
        href = items.get(idref)
        if not href:
            continue
        if used >= max_chaps or total >= max_chars:
            break
        target = posixpath.normpath(posixpath.join(base, href)) if base else href
        if target not in names:
            continue
        used += 1
        try:
            html = z.read(target).decode("utf-8", "ignore")
        except Exception:
            continue
        g = TextGrab()
        try:
            g.feed(html)
        except Exception:
            pass
        body = g.text()
        if len(body) < 20:
            continue
        parts.append("[第%d节] %s" % (used, body))
        total += len(body)

    text = "\n\n".join(parts)
    out = {
        "ok": True,
        "title": title,
        "chapters_total": len(order),
        "chapters_read": used,
        "chars": len(text),
        "truncated": bool(used < len(order) or len(text) > max_chars),
        "text": text[:max_chars],
    }
    print(json.dumps(out, ensure_ascii=True))


if __name__ == "__main__":
    main()
