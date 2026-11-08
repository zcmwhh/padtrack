#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PadTrack —— 把安卓平板/手机变成 Windows 的触控板。

零第三方依赖：只用 Python 标准库 + Windows user32.SendInput。
平板端不需要装 App，浏览器打开网页即可。

用法：
    python server.py            # 默认 0.0.0.0:8765，自动生成 4 位访问码
    python server.py --port 9000 --key 1234
"""

import argparse
import base64
import ctypes
import errno
import hashlib
import json
import os
import random
import re
import socket
import socketserver
import struct
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import threading
import time
from ctypes import wintypes
from urllib.parse import parse_qs

# 打包成 exe 时，网页文件解压在临时目录（sys._MEIPASS），
# 而日志 / 访问码 / pid 要留在 exe 旁边，所以两个目录分开算。
if getattr(sys, "frozen", False):
    HERE = os.path.dirname(os.path.abspath(sys.executable))
    RES_DIR = getattr(sys, "_MEIPASS", HERE)
else:
    HERE = os.path.dirname(os.path.abspath(__file__))
    RES_DIR = HERE

WEB_DIR = os.path.join(RES_DIR, "web")
LOG_PATH = os.path.join(HERE, "padtrack.log")
ADDR_PATH = os.path.join(HERE, "当前地址.txt")
KEY_PATH = os.path.join(HERE, "key.txt")
PID_PATH = os.path.join(HERE, "padtrack.pid")
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

# ---------------------------------------------------------------- SendInput

user32 = ctypes.WinDLL("user32", use_last_error=True)

ULONG_PTR = ctypes.c_size_t


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


user32.SendInput.argtypes = (wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int)
user32.SendInput.restype = wintypes.UINT
user32.GetCursorPos.argtypes = (ctypes.POINTER(wintypes.POINT),)
user32.GetCursorPos.restype = wintypes.BOOL
user32.SetCursorPos.argtypes = (ctypes.c_int, ctypes.c_int)
user32.SetCursorPos.restype = wintypes.BOOL

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_HWHEEL = 0x1000

KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

VK = {
    "win": 0x5B, "ctrl": 0x11, "alt": 0x12, "shift": 0x10,
    "enter": 0x0D, "tab": 0x09, "esc": 0x1B, "back": 0x08, "space": 0x20,
}

_input_lock = threading.Lock()
_state = {"abs": False}          # 相对移动 / 绝对定位


def _send(inp):
    with _input_lock:
        return user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))


def _mouse(dx=0, dy=0, data=0, flags=0):
    inp = INPUT(type=INPUT_MOUSE)
    inp.mi = MOUSEINPUT(int(dx), int(dy), int(data) & 0xFFFFFFFF, int(flags), 0, 0)
    return _send(inp)


def _key(vk=0, scan=0, flags=0):
    inp = INPUT(type=INPUT_KEYBOARD)
    inp.ki = KEYBDINPUT(int(vk) & 0xFFFF, int(scan) & 0xFFFF, int(flags), 0, 0)
    return _send(inp)


BTN = {
    "l": (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
    "r": (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
    "m": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
}


def act_move(dx, dy):
    dx = max(-500, min(500, int(dx)))
    dy = max(-500, min(500, int(dy)))
    if not dx and not dy:
        return
    if _state["abs"]:
        pt = wintypes.POINT()
        user32.GetCursorPos(ctypes.byref(pt))
        user32.SetCursorPos(pt.x + dx, pt.y + dy)
    else:
        _mouse(dx, dy, 0, MOUSEEVENTF_MOVE)


def act_down(b):
    _mouse(0, 0, 0, BTN[b][0])


def act_up(b):
    _mouse(0, 0, 0, BTN[b][1])


def act_click(b):
    act_down(b)
    act_up(b)


def act_wheel(units):
    _mouse(0, 0, int(units), MOUSEEVENTF_WHEEL)


def act_hwheel(units):
    _mouse(0, 0, int(units), MOUSEEVENTF_HWHEEL)


def act_zoom(units):
    """按住 Ctrl 滚轮 —— 浏览器/看图工具里的缩放。

    Ctrl 必须一直按着，等目标程序真正处理到 WM_MOUSEWHEEL 那一刻仍然是按下状态，
    否则 WPS 这类用 GetKeyState 判断的程序会认为没按 Ctrl，缩放就没反应。
    """
    _key(VK["ctrl"], 0, 0)
    time.sleep(0.02)
    act_wheel(units)
    time.sleep(0.06)
    _key(VK["ctrl"], 0, KEYEVENTF_KEYUP)


def act_drag_start():
    """双击拖动的起手动作。

    Windows 判双击要同时满足「时间 < 双击间隔」和「位置偏差 < SM_CXDOUBLECLK
    (默认 4px)」。这里先把光标挪开 8px 再按下左键，位置条件不成立，系统就不会
    发 WM_LBUTTONDBLCLK（标题栏也就不会最大化）；随后把光标挪回原位，拖动
    接着从原处开始，用户感觉不到偏移。
    """
    _mouse(8, 8, 0, MOUSEEVENTF_MOVE)
    _mouse(0, 0, 0, MOUSEEVENTF_LEFTDOWN)
    _mouse(-8, -8, 0, MOUSEEVENTF_MOVE)


def act_tap(vk):
    _key(vk, 0, 0)
    _key(vk, 0, KEYEVENTF_KEYUP)


def act_combo(mods, vk):
    mods = [VK[m] for m in mods if m in VK]
    for m in mods:
        _key(m, 0, 0)
    _key(vk, 0, 0)
    _key(vk, 0, KEYEVENTF_KEYUP)
    for m in reversed(mods):
        _key(m, 0, KEYEVENTF_KEYUP)


def act_text(text):
    for ch in text[:2000]:
        if ch == "\n":
            act_tap(VK["enter"])
        elif ch == "\t":
            act_tap(VK["tab"])
        else:
            cp = ord(ch)
            if cp > 0xFFFF:                     # 极小概率，转代理对
                cp -= 0x10000
                hi = 0xD800 + (cp >> 10)
                lo = 0xDC00 + (cp & 0x3FF)
                for unit in (hi, lo):
                    _key(0, unit, KEYEVENTF_UNICODE)
                    _key(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)
                continue
            _key(0, cp, KEYEVENTF_UNICODE)
            _key(0, cp, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)


def handle_message(msg):
    """处理一条来自平板的 JSON 指令。"""
    t = msg.get("t")
    if t == "m":
        act_move(msg.get("dx", 0), msg.get("dy", 0))
    elif t == "c":
        b = msg.get("b", "l")
        if b in BTN:
            act_click(b)
    elif t == "d":
        b = msg.get("b", "l")
        if b in BTN:
            act_down(b)
    elif t == "u":
        b = msg.get("b", "l")
        if b in BTN:
            act_up(b)
    elif t == "s":
        if msg.get("dy"):
            act_wheel(msg["dy"])
        if msg.get("dx"):
            act_hwheel(msg["dx"])
    elif t == "zoom":
        act_zoom(int(msg.get("d") or 0))
    elif t == "dblstart":
        act_drag_start()
    elif t == "k":
        act_tap(int(msg.get("vk") or 0))
    elif t == "ks":
        act_combo(msg.get("mods", []), int(msg.get("vk") or 0))
    elif t == "txt":
        act_text(str(msg.get("s", "")))
    elif t == "bs":
        n = max(0, min(int(msg.get("n") or 1), 300))
        for _ in range(n):
            act_tap(VK["back"])
    elif t == "cfg":
        _state["abs"] = bool(msg.get("abs", False))
    elif t == "ping":
        return {"t": "pong", "ts": msg.get("ts", 0)}
    return None


# ---------------------------------------------------------------- WebSocket

def ws_accept(key):
    digest = hashlib.sha1((key + WS_GUID).encode()).digest()
    return base64.b64encode(digest).decode()


def ws_send(sock, payload, opcode=0x1):
    if isinstance(payload, str):
        payload = payload.encode()
    header = bytearray([0x80 | opcode])
    n = len(payload)
    if n < 126:
        header.append(n)
    elif n < 65536:
        header.append(126)
        header += struct.pack(">H", n)
    else:
        header.append(127)
        header += struct.pack(">Q", n)
    sock.sendall(bytes(header) + payload)


class Reader:
    def __init__(self, sock, buf=b""):
        self.sock = sock
        self.buf = buf

    def read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("peer closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out


def read_frame(reader):
    b1, b2 = reader.read(2)
    fin = bool(b1 & 0x80)
    opcode = b1 & 0x0F
    masked = bool(b2 & 0x80)
    ln = b2 & 0x7F
    if ln == 126:
        ln = struct.unpack(">H", reader.read(2))[0]
    elif ln == 127:
        ln = struct.unpack(">Q", reader.read(8))[0]
    if ln > 1 << 20:
        raise ConnectionError("frame too large")
    mask = reader.read(4) if masked else b"\x00\x00\x00\x00"
    data = reader.read(ln) if ln else b""
    if masked:
        data = bytes(c ^ mask[i & 3] for i, c in enumerate(data))
    return fin, opcode, data


# ---------------------------------------------------------------- HTTP 服务

PAGE_PATH = os.path.join(WEB_DIR, "index.html")

FORBIDDEN = """<!doctype html><meta charset="utf-8">
<body style="background:#111;color:#ddd;font:16px/1.8 sans-serif;padding:40px">
<h2>访问码不对</h2>
<p>请用电脑上启动时打印的完整地址打开，例如：<br>
<code>http://192.168.1.10:8765/?k=1234</code></p>
</body>"""


# ---------------------------------------------------------------- 媒体信息
# 走 Windows 系统媒体控制（GSMTC），取当前播放器的曲名/歌手/状态。
MEDIA_PS = r"""
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$gen = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, $t) {
  $m = $gen.MakeGenericMethod($t)
  $task = $m.Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$s = $mgr.GetCurrentSession()
if ($null -eq $s) {
  '{"title":"","artist":"","status":"none"}'
} else {
  $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $i = $s.GetPlaybackInfo()
  $tl = $s.GetTimelineProperties()
  @{ title = $p.Title; artist = $p.Artist; status = [string]$i.PlaybackStatus; pos = [double]$tl.Position.TotalSeconds; dur = [double]$tl.EndTime.TotalSeconds; shuffle = [bool]$i.ShuffleEnabled; repeat = [int]$i.AutoRepeatMode } | ConvertTo-Json -Compress
}
"""

_media_lock = threading.Lock()
_media_cache = {"t": 0.0, "data": {"title": "", "artist": "", "status": ""}}
_cover_cache = {}          # "title|artist" -> bytes
_COVER_MAX = 24

PLAYER_PROCS = (
    "cloudmusic.exe", "cloudmusic_reporter.exe", "qqmusic.exe", "kugou.exe",
    "spotify.exe", "music.ui.exe", "wmplayer.exe", "foobar2000.exe", "aimp.exe",
)


def _exe_name(pid):
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.QueryFullProcessImageNameW.argtypes = (
        wintypes.HANDLE, wintypes.DWORD, ctypes.c_wchar_p, ctypes.POINTER(wintypes.DWORD))
    k32.CloseHandle.argtypes = (wintypes.HANDLE,)
    h = k32.OpenProcess(0x1000, False, pid)
    if not h:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(1024)
        if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return os.path.basename(buf.value).lower()
        return ""
    finally:
        k32.CloseHandle(h)


NOISE_TITLES = ("桌面歌词", "迷你播放器", "网易云音乐", "云音乐", "Default IME",
                "MSCTFIME UI", "Program Manager", "QQ音乐", "酷狗音乐")


def _is_noise_title(title):
    if not title:
        return True
    for bad in NOISE_TITLES:
        if title == bad or title.startswith(bad + " "):
            return True
    if title.startswith("GDI+ Window") or title.startswith("Default IME"):
        return True
    return False


def player_window_title():
    """从正在播放的软件窗口标题里取「歌名 - 歌手」。

    网易云这类不注册系统媒体控制的播放器，只能这样拿。
    """
    u32 = ctypes.WinDLL("user32")
    u32.EnumWindows.argtypes = (ctypes.c_void_p, wintypes.LPARAM)
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _):
        n = u32.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 2)
        u32.GetWindowTextW(hwnd, buf, n + 2)
        title = buf.value.strip()
        if not title:
            return True
        pid = wintypes.DWORD()
        u32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        exe = _exe_name(pid.value)
        if exe in PLAYER_PROCS and not _is_noise_title(title):
            found.append((title, exe, bool(u32.IsWindowVisible(hwnd))))
        return True

    u32.EnumWindows(cb, 0)
    if not found:
        return "", ""
    # 优先可见窗口、优先带「歌名 - 歌手」格式的
    found.sort(key=lambda r: (r[2], " - " in r[0]), reverse=True)
    return found[0][0], found[0][1]


def session_active(exe_name):
    """这个进程的音频会话是否在出声。True=在放, False=静音/暂停, None=判断不了。"""
    if not exe_name:
        return None
    try:
        import comtypes
        comtypes.CoInitialize()
    except Exception:
        pass
    try:
        from pycaw.pycaw import AudioUtilities
    except Exception:
        return None
    seen = False
    try:
        for s in AudioUtilities.GetAllSessions():
            try:
                proc = s.Process
                if proc and proc.name().lower() == exe_name:
                    seen = True
                    if s.State == 1:
                        return True
            except Exception:
                continue
    except Exception:
        return None
    return False if seen else None


def split_song_title(raw):
    t = raw
    for suffix in (" - 网易云音乐", " - QQ音乐", " - 酷狗音乐", " - Spotify"):
        if t.endswith(suffix):
            t = t[: -len(suffix)]
    if " - " in t:
        name, artist = t.rsplit(" - ", 1)
        return name.strip(), artist.strip()
    return t.strip(), ""


def parse_lrc(text):
    """把 LRC 文本解析成 [[秒, 歌词], ...]。"""
    out = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        m = re.match(r"\[(\d+):(\d+(?:[.:]\d+)?)\](.*)", line)
        if not m:
            continue
        mm, ss, words = m.group(1), m.group(2).replace(":", "."), m.group(3).strip()
        if not words:
            continue
        try:
            sec = int(mm) * 60 + float(ss)
        except ValueError:
            continue
        out.append([round(sec, 2), words])
    out.sort(key=lambda x: x[0])
    return out[:400]


def netease_meta(title, artist):
    """按歌名+歌手取封面和歌词。返回 {"cover": bytes, "lyric": [[秒, 词], ...]}。"""
    result = {"cover": b"", "lyric": [], "dur": 0}
    if not title:
        return result
    hdr = {"User-Agent": "Mozilla/5.0", "Referer": "https://music.163.com/"}

    def fetch(url, timeout=5):
        with urllib.request.urlopen(urllib.request.Request(url, headers=hdr), timeout=timeout) as r:
            return r.read()

    try:
        q = urllib.parse.quote(f"{title} {artist}".strip())
        data = json.loads(fetch(
            f"https://music.163.com/api/search/get/web?s={q}&type=1&limit=1&offset=0"
        ).decode("utf-8", "replace"))
        songs = (data.get("result") or {}).get("songs") or []
        if not songs:
            return result
        sid = songs[0].get("id")
        if not sid:
            return result

        # 歌词
        try:
            ly = json.loads(fetch(
                f"https://music.163.com/api/song/lyric?id={sid}&lv=-1&tv=-1"
            ).decode("utf-8", "replace"))
            result["lyric"] = parse_lrc((ly.get("lrc") or {}).get("lyric", ""))
        except Exception:
            pass

        # 封面
        try:
            d2 = json.loads(fetch(
                f"https://music.163.com/api/song/detail/?id={sid}&ids=%5B{sid}%5D"
            ).decode("utf-8", "replace"))
            dsongs = d2.get("songs") or []
            if dsongs:
                dur_ms = dsongs[0].get("duration") or 0
                if dur_ms:
                    result["dur"] = round(float(dur_ms) / 1000.0, 1)
            pic = ((dsongs[0].get("album") or {}).get("picUrl") if dsongs else "") or ""
            if pic:
                result["cover"] = fetch(pic.split("?")[0] + "?param=200y200", timeout=6)
        except Exception:
            pass
    except Exception:
        pass
    return result


_now_cache = {"t": 0.0, "data": {"title": "", "artist": "", "status": "none"}}


def query_now():
    """只回答「现在放的是哪首、在不在放」，不碰网络，够快。"""
    now = time.time()
    if now - _now_cache["t"] < 0.4:
        return _now_cache["data"]

    data = {"title": "", "artist": "", "status": "none"}
    try:
        raw, exe = player_window_title()
        if raw:
            t, a = split_song_title(raw)
            if t:
                playing = session_active(exe)
                data = {"title": t, "artist": a,
                        "status": "Paused" if playing is False else "Playing"}
    except Exception:
        pass

    _now_cache["t"] = time.time()
    _now_cache["data"] = data
    return data


SEARCH_PS = r"""
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$gen = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, $t) {
  $m = $gen.MakeGenericMethod($t)
  $task = $m.Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$s = $mgr.GetCurrentSession()
if ($null -eq $s) { '{"ok":false,"reason":"no-session"}'; exit }
$ticks = [long]([double]::Parse($args[0]) * 10000000)
$ok = Await ($s.TryChangePlaybackPositionAsync($ticks)) ([bool])
@{ ok = [bool]$ok } | ConvertTo-Json -Compress
"""


MODE_PS = r"""
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$gen = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, $t) {
  $m = $gen.MakeGenericMethod($t)
  $task = $m.Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$s = $mgr.GetCurrentSession()
if ($null -eq $s) { '{"ok":false,"reason":"no-session"}'; exit }
$what = $args[0]
try {
  if ($what -eq 'shuffle') {
    $ok = Await ($s.TryChangeShuffleActiveAsync([bool]::Parse($args[1]))) ([bool])
  } else {
    $mode = [Windows.Media.Playback.MediaPlaybackAutoRepeatMode]([int]$args[1])
    $ok = Await ($s.TryChangeAutoRepeatModeAsync($mode)) ([bool])
  }
  @{ ok = [bool]$ok } | ConvertTo-Json -Compress
} catch {
  '{"ok":false,"reason":"error"}'
}
"""


def set_play_mode(what, value):
    """切换随机/循环。只有支持系统媒体控制的播放器才能改。"""
    try:
        script = os.path.join(tempfile.gettempdir(), "padtrack_mode.ps1")
        if not os.path.exists(script):
            with open(script, "w", encoding="utf-8") as f:
                f.write(MODE_PS)
        out = subprocess.run(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
             str(what), str(int(value))],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=8, creationflags=0x08000000,
        ).stdout.strip()
        for line in reversed(out.splitlines()):
            line = line.strip()
            if line.startswith("{") and line.endswith("}"):
                return json.loads(line)
    except Exception:
        pass
    return {"ok": False, "reason": "error"}


def seek_to(seconds):
    """把当前播放位置跳到指定秒数。只有支持系统媒体控制的播放器才行。"""
    try:
        script = os.path.join(tempfile.gettempdir(), "padtrack_seek.ps1")
        if not os.path.exists(script):
            with open(script, "w", encoding="utf-8") as f:
                f.write(SEARCH_PS)
        out = subprocess.run(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
             str(float(seconds))],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=8, creationflags=0x08000000,
        ).stdout.strip()
        for line in reversed(out.splitlines()):
            line = line.strip()
            if line.startswith("{") and line.endswith("}"):
                return json.loads(line)
    except Exception:
        pass
    return {"ok": False, "reason": "error"}


def _ne_db_path():
    base = os.path.join(os.environ.get("LOCALAPPDATA", ""), "NetEase", "CloudMusic", "Library")
    p = os.path.join(base, "webdb.dat")
    return p if os.path.exists(p) else ""


def netease_playlists():
    """读取网易云本地库里的歌单列表（只读）。"""
    path = _ne_db_path()
    if not path:
        return []
    try:
        import sqlite3
        uri = "file:" + path.replace("\\", "/") + "?mode=ro&immutable=1"
        con = sqlite3.connect(uri, uri=True, timeout=3)
        out = []
        seen = set()
        for pid, js in con.execute("select id, jsonStr from historyPlaylists order by playtime desc limit 30"):
            try:
                d = json.loads(js)
            except Exception:
                continue
            if not isinstance(d, dict):
                continue
            seen.add(str(d.get("id") or pid))
            out.append({
                "id": str(d.get("id") or pid),
                "name": d.get("name") or "未命名歌单",
                "cover": d.get("coverImgUrl") or "",
            })
        for (pid,) in con.execute("select id from playlistTrackIds"):
            pid = str(pid)
            if pid in seen or pid.startswith("dailyRecommend"):
                continue
            seen.add(pid)
            out.append({"id": pid, "name": "歌单 " + pid[-4:], "cover": ""})
        con.close()
        return out
    except Exception:
        return []


def netease_playlist_tracks(pid, limit=120):
    """某个歌单里的曲目（曲名从 dbTrack 里解析）。"""
    path = _ne_db_path()
    if not path or not pid:
        return []
    try:
        import sqlite3
        uri = "file:" + path.replace("\\", "/") + "?mode=ro&immutable=1"
        con = sqlite3.connect(uri, uri=True, timeout=3)
        js = con.execute("select jsonStr from playlistTrackIds where id = ?", (pid,)).fetchone()
        if not js:
            con.close()
            return []
        ids = []
        try:
            for item in (json.loads(js[0]).get("trackIds") or []):
                sid = str(item.get("id") if isinstance(item, dict) else item)
                if sid:
                    ids.append(sid)
        except Exception:
            pass

        out = []
        for sid in ids[:limit]:
            row = con.execute("select jsonStr from dbTrack where id = ?", (sid,)).fetchone()
            if not row:
                out.append({"id": sid, "name": "(未缓存)", "artist": "", "dur": 0})
                continue
            try:
                d = json.loads(row[0])
            except Exception:
                continue
            artists = d.get("artists") or d.get("ar") or []
            names = []
            if isinstance(artists, list):
                for a in artists:
                    if isinstance(a, dict) and a.get("name"):
                        names.append(a["name"])
            album = d.get("album") or d.get("al") or {}
            out.append({
                "id": sid,
                "name": d.get("name") or "",
                "artist": "/".join(names),
                "album": album.get("name") if isinstance(album, dict) else "",
                "dur": round((d.get("duration") or 0) / 1000.0, 1),
            })
        con.close()
        return out
    except Exception:
        return []


def query_media(force=False):
    """当前播放曲目，带 2.5 秒缓存；force=True 时跳过缓存（切歌瞬间用）。"""
    if not force and time.time() - _media_cache["t"] < 2.5:
        return _media_cache["data"]

    data = {"title": "", "artist": "", "status": ""}
    with _media_lock:
        if not force and time.time() - _media_cache["t"] < 2.5:
            return _media_cache["data"]

        # 1) 先看本机播放器窗口：标题里有歌名，音频会话状态说明是否真在放
        #    （网易云走这条，它不注册系统媒体控制）
        raw, exe = player_window_title()
        if raw:
            t, a = split_song_title(raw)
            if t:
                playing = session_active(exe)
                data = {"title": t, "artist": a,
                        "status": "Paused" if playing is False else "Playing"}

        # 2) 窗口这条路拿不到（Spotify 这种标题里没歌名的），再问系统媒体控制
        if not data.get("title"):
            try:
                script = os.path.join(tempfile.gettempdir(), "padtrack_media.ps1")
                if not os.path.exists(script):
                    with open(script, "w", encoding="utf-8") as f:
                        f.write(MEDIA_PS)
                out = subprocess.run(
                    ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
                    capture_output=True, text=True, encoding="utf-8", errors="replace",
                    timeout=8, creationflags=0x08000000,
                ).stdout.strip()
                for line in reversed(out.splitlines()):
                    line = line.strip()
                    if line.startswith("{") and line.endswith("}"):
                        data = json.loads(line)
                        break
            except Exception:
                pass

        # 3) 封面 + 歌词
        key = f"{data.get('title','')}|{data.get('artist','')}"
        if data.get("title"):
            if key not in _cover_cache:
                meta = netease_meta(data.get("title", ""), data.get("artist", ""))
                if len(_cover_cache) >= _COVER_MAX:
                    _cover_cache.clear()
                _cover_cache[key] = meta
            meta = _cover_cache.get(key) or {"cover": b"", "lyric": []}
            if meta.get("cover"):
                data["cover"] = hashlib.md5(key.encode("utf-8")).hexdigest()[:12]
            if meta.get("lyric"):
                data["lyric"] = meta["lyric"]
            if meta.get("dur"):
                data["dur"] = meta["dur"]

        _media_cache["t"] = time.time()
        _media_cache["data"] = data
        return data


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        sock = self.request
        try:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            sock.settimeout(15)
            head, rest = self._read_head(sock)
            if head is None:
                return
            lines = head.split(b"\r\n")
            parts = lines[0].decode("latin-1").split()
            if len(parts) < 2:
                return
            method, target = parts[0].upper(), parts[1]

            headers = {}
            for line in lines[1:]:
                if b":" in line:
                    k, v = line.split(b":", 1)
                    headers[k.strip().lower().decode("latin-1")] = v.strip().decode("latin-1")

            path, _, query = target.partition("?")
            params = parse_qs(query)
            key = params.get("k", [""])[0]

            if path == "/ws" and headers.get("upgrade", "").lower() == "websocket":
                if key != KEY:
                    self._http(sock, 403, FORBIDDEN.encode())
                    return
                self._websocket(sock, headers, rest)
                return

            if method == "GET" and path in ("/", "/index.html"):
                if key != KEY:
                    self._http(sock, 403, FORBIDDEN.encode())
                    return
                try:
                    with open(PAGE_PATH, "rb") as f:
                        body = f.read()
                except OSError as exc:
                    self._http(sock, 500, f"缺少网页文件: {exc}".encode())
                    return
                self._http(sock, 200, body)
                return

            if method == "GET" and path == "/favicon.ico":
                self._http(sock, 204, b"")
                return

            if method == "GET" and path == "/media":
                if key != KEY:
                    self._http(sock, 403, b"{}", "application/json")
                    return
                force = params.get("bust", [""])[0] == "1"
                body = json.dumps(query_media(force), ensure_ascii=False).encode("utf-8")
                self._http(sock, 200, body, "application/json; charset=utf-8")
                return

            if method == "GET" and path == "/now":
                if key != KEY:
                    self._http(sock, 403, b"{}", "application/json")
                    return
                body = json.dumps(query_now(), ensure_ascii=False).encode("utf-8")
                self._http(sock, 200, body, "application/json; charset=utf-8")
                return

            if method == "GET" and path == "/playlists":
                if key != KEY:
                    self._http(sock, 403, b"[]", "application/json")
                    return
                body = json.dumps(netease_playlists(), ensure_ascii=False).encode("utf-8")
                self._http(sock, 200, body, "application/json; charset=utf-8")
                return

            if method == "GET" and path == "/playlist":
                if key != KEY:
                    self._http(sock, 403, b"[]", "application/json")
                    return
                pid = params.get("id", [""])[0]
                body = json.dumps(netease_playlist_tracks(pid), ensure_ascii=False).encode("utf-8")
                self._http(sock, 200, body, "application/json; charset=utf-8")
                return

            if method == "GET" and path == "/mode":
                if key != KEY:
                    self._http(sock, 403, b"{}", "application/json")
                    return
                what = params.get("what", [""])[0]
                try:
                    value = int(params.get("value", ["0"])[0])
                except ValueError:
                    value = 0
                body = json.dumps(set_play_mode(what, value), ensure_ascii=False).encode("utf-8")
                self._http(sock, 200, body, "application/json; charset=utf-8")
                return

            if method == "GET" and path == "/seek":
                if key != KEY:
                    self._http(sock, 403, b"{}", "application/json")
                    return
                try:
                    pos = float(params.get("pos", ["0"])[0])
                except ValueError:
                    pos = 0.0
                body = json.dumps(seek_to(pos), ensure_ascii=False).encode("utf-8")
                self._http(sock, 200, body, "application/json; charset=utf-8")
                return

            if method == "GET" and path == "/cover":
                if key != KEY:
                    self._http(sock, 403, b"", "text/plain")
                    return
                want = params.get("h", [""])[0]
                for k, meta in list(_cover_cache.items()):
                    if hashlib.md5(k.encode("utf-8")).hexdigest()[:12] == want:
                        img = (meta or {}).get("cover") if isinstance(meta, dict) else meta
                        if not img:
                            break
                        ctype = "image/png" if img[:4] == b"\x89PNG" else "image/jpeg"
                        self._http(sock, 200, img, ctype)
                        return
                self._http(sock, 404, b"", "text/plain")
                return

            self._http(sock, 404, b"not found")
        except Exception:
            pass
        finally:
            try:
                sock.close()
            except Exception:
                pass

    @staticmethod
    def _read_head(sock, limit=65536):
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = sock.recv(4096)
            if not chunk:
                return None, b""
            buf += chunk
            if len(buf) > limit:
                return None, b""
        head, _, rest = buf.partition(b"\r\n\r\n")
        return head, rest

    @staticmethod
    def _http(sock, code, body, ctype="text/html; charset=utf-8"):
        reason = {200: "OK", 204: "No Content", 403: "Forbidden",
                  404: "Not Found", 500: "Internal Server Error"}.get(code, "OK")
        head = (
            f"HTTP/1.1 {code} {reason}\r\n"
            f"Content-Type: {ctype}\r\n"
            f"Content-Length: {len(body)}\r\n"
            "Cache-Control: no-store\r\n"
            "Connection: close\r\n\r\n"
        )
        sock.sendall(head.encode() + body)

    def _websocket(self, sock, headers, rest):
        skey = headers.get("sec-websocket-key", "")
        if not skey:
            self._http(sock, 400, b"missing key")
            return
        resp = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {ws_accept(skey)}\r\n\r\n"
        )
        sock.sendall(resp.encode())
        sock.settimeout(None)

        reader = Reader(sock, rest)
        peer = self.client_address[0]
        log(f"平板已连接: {peer}")
        try:
            while True:
                fin, opcode, data = read_frame(reader)
                if opcode == 0x8:                       # close
                    break
                if opcode == 0x9:                       # ping
                    ws_send(sock, data, 0xA)
                    continue
                if opcode == 0xA:                       # pong
                    continue
                if opcode not in (0x1, 0x2):
                    continue
                try:
                    msg = json.loads(data.decode("utf-8"))
                except Exception:
                    continue
                if not isinstance(msg, dict):
                    continue
                try:
                    reply = handle_message(msg)
                except Exception as exc:        # 单条指令出错不该把连接打断
                    log(f"指令出错 {msg.get('t')}: {type(exc).__name__}: {exc}")
                    continue
                if reply is not None:
                    ws_send(sock, json.dumps(reply, separators=(",", ":")))
        except (ConnectionError, OSError, ValueError) as exc:
            log(f"断开原因: {type(exc).__name__}: {exc}")
        except Exception as exc:
            log(f"断开异常: {type(exc).__name__}: {exc}")
        finally:
            log(f"平板已断开: {peer}")


class Server(socketserver.ThreadingTCPServer):
    # Windows 上 SO_REUSEADDR 会允许绑定已被占用的端口（请求仍被旧进程收走），
    # 必须关掉，让 bind 直接报错，交给 bind_server 顺延端口。
    allow_reuse_address = False
    daemon_threads = True


# ---------------------------------------------------------------- 启动

def log(text):
    print(f"[{time.strftime('%H:%M:%S')}] {text}", flush=True)


def lan_ips():
    ips = []
    for probe in ("8.8.8.8", "1.1.1.1", "192.168.1.1"):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.settimeout(0.3)
            s.connect((probe, 80))
            ip = s.getsockname()[0]
            if ip and ip not in ips and not ip.startswith("127."):
                ips.append(ip)
        except OSError:
            pass
        finally:
            s.close()
    return ips


def use_hidden_output():
    """pythonw 启动时没有控制台，stdout/stderr 为 None，这里改写到日志文件。"""
    if sys.stdout is not None and sys.stderr is not None:
        return False
    try:
        stream = open(LOG_PATH, "a", encoding="utf-8", buffering=1)
    except OSError:
        return True
    if sys.stdout is None:
        sys.stdout = stream
    if sys.stderr is None:
        sys.stderr = stream
    return True


def msgbox(text, title="PadTrack"):
    try:
        ctypes.windll.user32.MessageBoxW(None, text, title, 0x40)
    except Exception:
        pass


def resolve_key(explicit):
    """访问码优先用命令行，其次沿用上次生成的值，最后随机生成并保存。"""
    if explicit:
        key = explicit.strip()
    else:
        key = ""
        try:
            with open(KEY_PATH, encoding="utf-8") as f:
                key = f.read().strip()
        except OSError:
            pass
        if not key:
            key = f"{random.randint(0, 9999):04d}"
    try:
        with open(KEY_PATH, "w", encoding="utf-8") as f:
            f.write(key)
    except OSError:
        pass
    return key


def write_address(port, ips):
    lines = [
        f"PadTrack  {time.strftime('%Y-%m-%d %H:%M:%S')} 已启动",
        "",
    ]
    for ip in ips:
        lines.append(f"平板浏览器打开:  http://{ip}:{port}/?k={KEY}")
    lines += [
        f"本机自测:        http://127.0.0.1:{port}/?k={KEY}",
        "",
        "停止服务: 双击 停止.bat",
        "运行日志: padtrack.log",
    ]
    try:
        with open(ADDR_PATH, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    except OSError:
        pass


def bind_server(bind_addr, port, tries=10):
    """端口被占用时自动顺延，返回 (server, 实际端口)。"""
    last_exc = None
    for candidate in range(port, port + tries):
        try:
            return Server((bind_addr, candidate), Handler), candidate
        except OSError as exc:
            last_exc = exc
            busy = getattr(exc, "errno", None) in (errno.EADDRINUSE, 10048, 10013)
            if not busy:
                break
    raise last_exc if last_exc else OSError("bind failed")


def pid_alive(pid):
    """判断 PID 是否仍然存活（不依赖权限，只需 QUERY_LIMITED_INFORMATION）。"""
    if pid <= 0:
        return False
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
    k32.GetExitCodeProcess.restype = wintypes.BOOL
    k32.CloseHandle.argtypes = (wintypes.HANDLE,)
    handle = k32.OpenProcess(0x1000, False, pid)      # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return False
    try:
        code = wintypes.DWORD()
        if not k32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return False
        return code.value == 259                       # STILL_ACTIVE
    finally:
        k32.CloseHandle(handle)


def _tasklist_has(pid):
    """tasklist 兜底判断进程是否存在（OpenProcess 被拒时用）。"""
    try:
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
            capture_output=True, text=True, timeout=6,
            creationflags=0x08000000,          # CREATE_NO_WINDOW
        ).stdout
        return str(pid) in out
    except Exception:
        return False


def find_existing(port=None, tries=None):
    """已经跑着一个 PadTrack 就返回它的端口，否则 None。

    只认 pid 文件，不做网络探测——某些环境下连接未开放的 127.0.0.1 端口会卡住
    到超时，反而让启动变慢。
    """
    try:
        with open(PID_PATH, encoding="utf-8") as f:
            parts = f.read().split()
        pid, running_port = int(parts[0]), int(parts[1])
    except (OSError, ValueError, IndexError):
        return None

    if pid_alive(pid) or _tasklist_has(pid):
        return running_port
    return None


def main():
    global KEY
    hidden = use_hidden_output()

    ap = argparse.ArgumentParser(description="PadTrack：安卓平板变 PC 触控板")
    ap.add_argument("--port", type=int, default=8765, help="监听端口，默认 8765")
    ap.add_argument("--bind", default="0.0.0.0", help="监听地址，默认 0.0.0.0")
    ap.add_argument("--key", default=None, help="访问码，默认沿用上次生成的值")
    args = ap.parse_args()

    KEY = resolve_key(args.key)

    if not os.path.exists(PAGE_PATH):
        msg = f"找不到网页文件: {PAGE_PATH}"
        print(msg)
        if hidden:
            msgbox(msg)
        return 1

    # 单实例：已经有 PadTrack 在跑就不再起第二个（否则每点一次就多一个）
    existing = find_existing(args.port)
    if existing is not None:
        ips = lan_ips() or ["<本机IP>"]
        write_address(existing, ips)
        print(f"PadTrack 已经在运行（端口 {existing}），没有重复启动。"
              f"\n地址见: {ADDR_PATH}", flush=True)
        return 0

    try:
        srv, actual_port = bind_server(args.bind, args.port)
    except OSError as exc:
        msg = f"端口 {args.port} 启动失败: {exc}\n换个端口试试：python server.py --port 8766"
        print(msg)
        if hidden:
            msgbox(msg)
        return 1
    if actual_port != args.port:
        log(f"端口 {args.port} 被占用，已改用 {actual_port}")

    ips = lan_ips() or ["<本机IP>"]
    lines = ["", "  PadTrack 已启动", "  " + "-" * 52]
    for ip in ips:
        lines.append(f"  平板浏览器打开:  http://{ip}:{actual_port}/?k={KEY}")
    lines += [
        f"  本机自测:        http://127.0.0.1:{actual_port}/?k={KEY}",
        "  " + "-" * 52,
        "  同一 WiFi 即可；连不上先看 Windows 防火墙是否放行。",
        "  按 Ctrl+C 停止。",
        "",
    ]
    print("\n".join(lines), flush=True)
    write_address(actual_port, ips)
    try:
        with open(PID_PATH, "w", encoding="utf-8") as f:
            f.write(f"{os.getpid()} {actual_port}")
    except OSError:
        pass

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        srv.server_close()
        try:
            os.remove(PID_PATH)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
