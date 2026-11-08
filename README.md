# PadTrack

把安卓平板变成 Windows 的触控板 + 键盘 —— 平板**不用装 App、不用 root**，浏览器打开网页即可。

![Python](https://img.shields.io/badge/python-3.8%2B-blue)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)
![License](https://img.shields.io/badge/license-MIT-green)

PC 端跑一个纯标准库的 Python 脚本，平板用浏览器连上，手指在网页上滑动就驱动电脑光标。
带宽占用极小，同一 WiFi 下延迟约 10–30ms。

## 特性

- **零依赖**：只用 Python 标准库，不装任何第三方包
- **平板零安装**：Chrome / Edge 打开网页即用，不用 APK
- **手势对齐 Windows 精密触控板**：单指移动、双指滚动（带惯性）、捏合缩放、三指切换窗口
- **走电脑输入法**：网页自绘键盘只发按键，拼音候选框出现在电脑上，用的还是你熟悉的词库
- **四种键盘形态**：抽屉 / 全屏（滑动当触控板）/ 分屏 / 环绕
- **可调手感**：灵敏度、滚轮速度、指针加速、滚动方向、绝对定位
- **访问码保护**：同一网段的其他设备不能随便连

## 下载

到 [Releases](releases/latest) 下载 `PadTrack.zip`，解压后双击 `PadTrack.exe`，**不需要安装 Python**。

从源码运行：

```bash
git clone https://github.com/<your-name>/padtrack.git
cd padtrack
python server.py
```

## 快速开始

1. 双击 `PadTrack.exe`（或 `python server.py`），窗口里会打印：

   ```
   平板浏览器打开:  http://192.168.1.10:8765/?k=4821
   ```

2. 平板连**同一个 WiFi**，浏览器打开这个地址（`?k=` 是访问码）
3. 手指在平板上滑动，电脑光标跟着动

首次运行 Windows 会弹防火墙提示，务必勾选**专用网络**。若误点了阻止，用管理员 CMD 补一条：

```bat
netsh advfirewall firewall add rule name="PadTrack" dir=in action=allow protocol=TCP localport=8765
```

## 手势

| 操作 | 效果 |
|---|---|
| 单指滑动 | 移动光标 |
| 轻点 | 左键单击 |
| 双击后直接拖 | 拖拽（0.5 秒内第二下按住并移动） |
| 按住 0.3 秒后拖动 | 拖拽（备选方式） |
| 点右上角 ✋ 再拖 | 拖动锁定：锁住左键自由拖，再点 ✋ 松开 |
| 双指上下滑 | 滚动，松手带惯性衰减 |
| 双指左右滑 | 横向滚动 |
| 双指捏合 / 张开 | 缩放（Ctrl+滚轮） |
| 双指轻点 | 右键 |
| 三指轻点 | 开始菜单 |
| 三指上滑 / 下滑 | 任务视图 / 显示桌面 |
| 三指左右滑 | 切换窗口（Alt+Tab） |

## 键盘

| 形态 | 布局 | 适合 |
|---|---|---|
| 抽屉键盘 | 屏幕下半 | 偶尔打字 |
| 全屏键盘 | 铺满全屏，滑动即触控板 | 大量打字 + 随时移光标 |
| 分屏 | 左 3/4 键盘 + 右 1/4 触控板 | 边打字边点选 |
| 环绕 | 上方打字区 + 下方 3:2 触控板 + 两侧功能区 | 长时间打字 |

主层布局（`123` 可切到 Fn 层取 Esc/Tab/方向键等）：

```
1 2 3 4 5 6 7 8 9 0
 q w e r t y u i o p
  a s d f g h j k l
   ⇧ z x c v b n m , . ⌫
 123  Ctrl  [   空格   ]  回车
```

打字默认走**电脑输入法**：平板只发送按键（VK 码），由电脑的输入法组词，数字键选候选词。
另有「直接输入」模式，按 Unicode 直接注入文字，适合粘贴长文本。

## 工作原理

```
平板浏览器                     PC
┌──────────────┐   WebSocket  ┌──────────────────────────┐
│ 触摸/鼠标事件 │ ───────────► │ server.py                │
│ 手势状态机    │   JSON 指令   │  ├ HTTP  提供网页         │
│ 键盘/触控板   │ ◄─────────── │  └ WS    转发到 SendInput │
└──────────────┘   延迟回显    └──────────────────────────┘
```

- 服务端约 700 行，`http.server` + 手写 WebSocket 帧解析，不依赖第三方库
- 客户端是单文件 `web/index.html`，无框架、无构建步骤
- 输入注入走 `user32.SendInput`，滚轮按 1/8 格（15 单位）发送，兼顾连续性和跨程序一致性

## 延迟优化

- 优先连 **5GHz** WiFi，2.4GHz 上延迟可能到 80ms 以上
- 关闭路由器的 **AP 隔离 / 访客网络**，否则平板和 PC 互相不通
- 更稳可以走 USB：平板开启「USB 网络共享」，或 PC 上 `adb reverse tcp:8765 tcp:8765`，
  然后平板访问 `http://127.0.0.1:8765/?k=访问码`，完全绕开 WiFi

## 自测

```bash
python server.py --key 1234
python selftest.py --key 1234
```

验证页面、WebSocket 握手、ping/pong，以及光标是否真的被移动（结束时会还原鼠标位置）。

## 已知限制

- **必须以普通用户权限运行**。跑在低完整性级别或沙箱里时，Windows 的 UIPI 会静默丢弃输入注入
  （`SendInput` 返回成功但光标不动）
- 目标程序以管理员身份运行时，PadTrack 也需要以管理员身份运行
- 仅支持 Windows（依赖 `user32.SendInput`）；macOS / Linux 需替换输入后端
- 部分杀毒软件会误报 PyInstaller 打包的 exe，加入白名单即可

## 开发约定

改动 `server.py` / `web/index.html` 前，先复制一份到 `backup/yyyyMMdd-HHmm/`（保留目录结构），
出问题直接覆盖回滚。

## License

[MIT](LICENSE)