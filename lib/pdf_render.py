# -*- coding: utf-8 -*-
"""把 PDF 某一页渲染成 PNG（离线，pypdfium2）。
用法：python3 pdf_render.py <pdf> <页码 1based> <输出 png> [宽度]
"""
import json
import os
import struct
import sys
import zlib


def write_png(path, w, h, rgb):
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    raw = bytearray()
    stride = w * 3
    for y in range(h):
        raw.append(0)
        raw.extend(rgb[y * stride:(y + 1) * stride])
    out = b"\x89PNG\r\n\x1a\n"
    out += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    out += chunk(b"IDAT", zlib.compress(bytes(raw), 6))
    out += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(out)


def main():
    if len(sys.argv) < 4:
        print(json.dumps({"ok": False, "error": "用法: pdf_render.py <pdf> <页码> <输出> [宽度]"}))
        return
    path, page_no, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    width = int(sys.argv[4]) if len(sys.argv) > 4 else 1000
    try:
        import pypdfium2 as pdfium
    except Exception as e:
        print(json.dumps({"ok": False, "error": "没有 pypdfium2：" + str(e)}))
        return
    try:
        pdf = pdfium.PdfDocument(path)
        idx = max(0, min(len(pdf) - 1, page_no - 1))
        page = pdf[idx]
        w, h = page.get_size()
        scale = max(0.3, min(3.0, width / max(1.0, w)))
        bmp = page.render(scale=scale)
        bw, bh, stride = bmp.width, bmp.height, bmp.stride
        data = bytes(bmp.buffer)
        # format: 2 = BGR, 3 = BGRx, 4 = BGRA
        rgb = bytearray(bw * bh * 3)
        if stride == bw * 3:
            rgb[0::3] = data[2::3]
            rgb[1::3] = data[1::3]
            rgb[2::3] = data[0::3]
        else:
            for y in range(bh):
                row = data[y * stride:y * stride + bw * 3]
                base = y * bw * 3
                rgb[base + 0::3] = row[2::3]
                rgb[base + 1::3] = row[1::3]
                rgb[base + 2::3] = row[0::3]
        write_png(out, bw, bh, rgb)
        print(json.dumps({"ok": True, "page": idx + 1, "width": bw, "height": bh, "bytes": os.path.getsize(out)}))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:300]}))


if __name__ == "__main__":
    main()
