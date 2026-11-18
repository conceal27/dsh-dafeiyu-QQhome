# -*- coding: utf-8 -*-
"""PDF 文本提取（离线，pypdf）。用法：python3 pdf.py <文件> <最多页数> <最多字符> <起始页1based>"""
import json
import sys


def fail(msg):
    print(json.dumps({"ok": False, "error": str(msg)[:300]}, ensure_ascii=True))
    sys.exit(0)


def main():
    if len(sys.argv) < 2:
        fail("缺少文件路径")
    path = sys.argv[1]
    max_pages = int(sys.argv[2]) if len(sys.argv) > 2 else 80
    max_chars = int(sys.argv[3]) if len(sys.argv) > 3 else 9000
    start = max(1, int(sys.argv[4])) if len(sys.argv) > 4 else 1
    try:
        from pypdf import PdfReader
    except Exception as e:
        fail("没有 pypdf：" + str(e))
    try:
        reader = PdfReader(path)
        if reader.is_encrypted:
            try:
                reader.decrypt("")
            except Exception:
                pass
        total = len(reader.pages)
    except Exception as e:
        fail("打不开 PDF：" + str(e))

    meta = {}
    try:
        info = reader.metadata or {}
        for k in ("/Title", "/Author", "/Subject", "/CreationDate"):
            v = info.get(k)
            if v:
                meta[k[1:].lower()] = str(v)[:120]
    except Exception:
        pass

    lines = []
    chars = 0
    empty = 0
    used = 0
    idx = start - 1
    while idx < total and used < max_pages:
        used += 1
        try:
            t = reader.pages[idx].extract_text() or ""
        except Exception:
            t = ""
        t = " ".join(t.split())
        if len(t) < 20:
            empty += 1
        else:
            lines.append("[第%d页] %s" % (idx + 1, t))
            chars += len(t)
        idx += 1
        if chars >= max_chars:
            break

    text = "\n".join(lines)
    scanned = chars < 60
    out = {
        "ok": True,
        "pages": total,
        "start": start,
        "read_pages": used,
        "empty_pages": empty,
        "chars": len(text),
        "scanned": bool(scanned),
        "truncated": bool(idx < total or chars >= max_chars),
        "next_page": idx + 1 if idx < total else 0,
        "meta": meta,
        "text": text[:max_chars],
    }
    print(json.dumps(out, ensure_ascii=True))


if __name__ == "__main__":
    main()
