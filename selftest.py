#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PadTrack 自测：验证页面、WebSocket、以及光标是否真的被控制。

用法：
    python selftest.py --key 1234 [--port 8765]

注意：测试会短暂移动鼠标光标，结束后会还原位置。
"""

import argparse
import base64
import ctypes
import json
import os
import socket
import struct
import sys
import time
import urllib.request
from ctypes import wintypes

user32 = ctypes.WinDLL("user32")
user32.GetCursorPos.argtypes = (ctypes.POINTER(wintypes.POINT),)
user32.SetCursorPos.argtypes = (ctypes.c_int, ctypes.c_int)

PASS, FAIL = "PASS", "FAIL"
results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(f"[{PASS if ok else FAIL}] {name}" + (f"  {detail}" if detail else ""))


def cursor():
    p = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(p))
    return p.x, p.y


def http_get(url):
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""


def ws_connect(host, port, key):
    s = socket.create_connection((host, port), timeout=5)
    nonce = base64.b64encode(os.urandom(16)).decode()
    req = (
        f"GET /ws?k={key} HTTP/1.1\r\nHost: {host}:{port}\r\n"
        "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {nonce}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    )
    s.sendall(req.encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = s.recv(4096)
        if not chunk:
            raise ConnectionError("no handshake response")
        buf += chunk
    head, _, rest = buf.partition(b"\r\n\r\n")
    if rest:
        s.settimeout(3)
    return s, head.decode("latin-1", "replace"), rest


def send_frame(s, obj):
    data = json.dumps(obj).encode()
    mask = os.urandom(4)
    n = len(data)
    h = bytearray([0x81])
    if n < 126:
        h.append(0x80 | n)
    elif n < 65536:
        h.append(0x80 | 126)
        h += struct.pack(">H", n)
    else:
        h.append(0x80 | 127)
        h += struct.pack(">Q", n)
    s.sendall(bytes(h) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))


def recv_frame(s, timeout=3):
    s.settimeout(timeout)

    def rd(n):
        b = b""
        while len(b) < n:
            c = s.recv(n - len(b))
            if not c:
                raise ConnectionError("closed")
            b += c
        return b

    b1, b2 = rd(2)
    ln = b2 & 0x7F
    if ln == 126:
        ln = struct.unpack(">H", rd(2))[0]
    elif ln == 127:
        ln = struct.unpack(">Q", rd(8))[0]
    mask = rd(4) if b2 & 0x80 else b"\x00\x00\x00\x00"
    data = rd(ln) if ln else b""
    if b2 & 0x80:
        data = bytes(c ^ mask[i % 4] for i, c in enumerate(data))
    return b1 & 0x0F, data


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--key", required=True)
    args = ap.parse_args()

    base = f"http://{args.host}:{args.port}"

    # 1. 页面
    code, body = http_get(f"{base}/?k={args.key}")
    check("页面返回 200", code == 200, f"HTTP {code}")
    # 前端拆成 index.html + app.css + app.js 之后，页面里不再有 WebSocket 字样，
    # 改成检查结构标记 + 外链资源是否可达
    css_ok = "app.css" in body
    js_ok = "app.js" in body
    check("页面内容正确", "PadTrack" in body and css_ok and js_ok and 'id="pad"' in body)

    # 2. 错误的访问码
    code, _ = http_get(f"{base}/?k=0000x")
    check("错误访问码被拒绝", code == 403, f"HTTP {code}")

    # 3. WebSocket 握手
    try:
        s, head, _ = ws_connect(args.host, args.port, args.key)
        check("WebSocket 握手 101", "101" in head, head.splitlines()[0] if head else "")
    except Exception as exc:
        check("WebSocket 握手 101", False, str(exc))
        return finish()

    # 4. ping / pong
    send_frame(s, {"t": "ping", "ts": 12345})
    try:
        op, data = recv_frame(s)
        msg = json.loads(data)
        check("ping → pong", msg.get("t") == "pong" and msg.get("ts") == 12345, str(msg))
    except Exception as exc:
        check("ping → pong", False, str(exc))

    saved = cursor()

    # 5. 绝对模式：1:1 位移
    try:
        user32.SetCursorPos(500, 400)
        send_frame(s, {"t": "cfg", "abs": True})
        time.sleep(0.08)
        send_frame(s, {"t": "m", "dx": 50, "dy": 30})
        time.sleep(0.12)
        x, y = cursor()
        check("绝对模式位移精确", (x, y) == (550, 430), f"实际 ({x},{y}) 期望 (550,430)")
    except Exception as exc:
        check("绝对模式位移精确", False, str(exc))

    # 6. 相对模式：方向正确且幅度合理
    try:
        send_frame(s, {"t": "cfg", "abs": False})
        time.sleep(0.08)
        x0, y0 = cursor()
        send_frame(s, {"t": "m", "dx": 80, "dy": 50})
        time.sleep(0.15)
        x1, y1 = cursor()
        ok = (x1 > x0 and y1 > y0 and (x1 - x0) >= 10 and (y1 - y0) >= 10)
        check("相对模式方向正确", ok, f"位移 ({x1-x0},{y1-y0})")
    except Exception as exc:
        check("相对模式方向正确", False, str(exc))

    # 7. 滚轮不报错
    try:
        send_frame(s, {"t": "s", "dy": 120})
        send_frame(s, {"t": "s", "dy": -120})
        time.sleep(0.1)
        check("滚轮指令不报错", True)
    except Exception as exc:
        check("滚轮指令不报错", False, str(exc))

    user32.SetCursorPos(saved[0], saved[1])
    s.close()
    return finish()


def finish():
    ok = all(results)
    print("\n" + ("全部通过，服务端工作正常。" if ok else "有项目失败，请检查服务端日志。"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
