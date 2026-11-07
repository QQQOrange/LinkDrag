#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tiny X-Frame-Options test server for the snapshot fallback smoke test."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>XFO test entry</title></head>
<body style="font:16px system-ui;padding:40px"><h1>XFO entry</h1>
<p><a id="xfoLink" href="http://127.0.0.1:8766/xfo">打开受 X-Frame-Options 保护的页面</a></p>
</body></html>"""

XFO = """<!doctype html><html><head><meta charset="utf-8"><title>Protected snapshot</title></head>
<body style="font:17px/1.7 system-ui;padding:40px;background:#fff8ee">
<h1>XFO protected page</h1>
<p>这段正文来自服务器抓取的只读快照，说明扩展在 X-Frame-Options: DENY 的情况下仍然把内容呈现出来了。</p>
<p>第二段用于通过空壳检测，确保不会被误判为 SPA 空壳。</p>
</body></html>"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/favicon.ico'):
            self.send_response(204)
            self.end_headers()
            return
        if self.path.startswith('/xfo'):
            body = XFO.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('X-Frame-Options', 'DENY')
            self.send_header('Content-Security-Policy', "frame-ancestors 'none'")
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        body = PAGE.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 8766), Handler).serve_forever()
