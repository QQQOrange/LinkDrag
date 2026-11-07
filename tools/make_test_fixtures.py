#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Create small local fixtures for browser smoke tests."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
TEST = ROOT / "test"
TEST.mkdir(exist_ok=True)

thumb = Image.new("RGB", (320, 200), (28, 48, 98))
d = ImageDraw.Draw(thumb)
d.rectangle((18, 18, 302, 182), outline=(120, 170, 255), width=4)
d.text((38, 80), "THUMB 320x200", fill=(240, 246, 255))
thumb.save(TEST / "thumb.png")

full = Image.new("RGB", (1600, 1000), (22, 36, 76))
d = ImageDraw.Draw(full)
for i in range(16):
    d.line((i * 100, 0, i * 100, 1000), fill=(38, 66, 130), width=2)
for i in range(10):
    d.line((0, i * 100, 1600, i * 100), fill=(38, 66, 130), width=2)
d.rectangle((80, 120, 1520, 880), outline=(110, 215, 185), width=8)
d.text((160, 470), "FULL ORIGINAL 1600x1000 — drag image preview", fill=(245, 250, 255))
full.save(TEST / "full.png")

(TEST / "index.html").write_text("""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Link Preview test page</title>
<style>
body{font:16px/1.7 system-ui,"Microsoft YaHei",sans-serif;margin:40px;background:#faf7f0;color:#20242e}
a{color:#2459b8}.row{margin:18px 0;padding:18px;border:1px solid #d9d2c4;border-radius:14px;background:#fff}
img{max-width:100%;border-radius:10px;display:block}
.small{width:320px} .note{color:#777;font-size:13px}
</style></head><body>
<h1>Link Preview Suite Test</h1>
<p class="note">拖拽下面的大图应打开高清图片预览（1600×1000），而不是网页缩略图。普通链接拖拽应打开网页预览。</p>
<div class="row"><a href="full.png" id="imageLink"><img id="testImage" class="small" src="thumb.png" srcset="thumb.png 320w, full.png 1600w" alt="高清测试图"></a><p>图片被一个指向 full.png 的链接包着；srcset 也包含 1600w。</p></div>
<div class="row"><a href="second.html" id="pageLink">普通链接：second.html</a></div>
<div class="row"><a href="https://example.com/" id="externalLink">外部链接 example.com</a></div>
<script>
window.__testReady = true;
</script>
</body></html>""", encoding="utf-8")

(TEST / "second.html").write_text("""<!doctype html><html><head><meta charset="utf-8"><title>Second page</title></head>
<body style="font:18px system-ui;padding:40px;background:#eef5ff"><h1>Second page</h1><p>这是一个用于网页预览的本地页面。</p></body></html>""", encoding="utf-8")
print("test fixtures ready")
