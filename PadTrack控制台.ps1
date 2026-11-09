# PadTrack 控制中心（自绘界面，风格对齐网页端）
param([switch]$Test, [switch]$Compile)

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 高 DPI 下必须声明感知，否则整窗被位图缩放，文字发虚
try {
    Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class DpiApi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
    [void][DpiApi]::SetProcessDPIAware()
} catch {}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $here 'PadTrack.exe'
$keyFile = Join-Path $here 'key.txt'
$logFile = Join-Path $here 'padtrack.log'
$adb = Join-Path $here 'tools\platform-tools\adb.exe'
$port = 8765

$csharp = @'

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Windows.Forms;

public class PadButton
{
    public string Key;
    public string Text;
    public Rectangle Rect;
    public int Kind;          // 0=ghost 1=primary 2=danger
    public float Hover;
    public float Press;
    public bool Enabled = true;
}

public class PadCenter : Form
{
    public List<PadButton> Buttons = new List<PadButton>();
    public string[] Lines = new string[0];      // "标签|值|状态(ok/warn/dim)"
    public string LogText = "";
    public float UiScale = 1f;

    [System.Runtime.InteropServices.DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    private int darkMode = 1;
    public Func<string, bool> OnAction;

    private int hot = -1, down = -1;
    private Timer anim;
    private Font fTitle, fSub, fLine, fLineB, fBtn, fLog, fTag;
    private Rectangle cardA, cardB;

    private static readonly Color Accent = Color.FromArgb(62, 207, 142);
    private static readonly Color TextMain = Color.FromArgb(226, 236, 246);
    private static readonly Color TextDim = Color.FromArgb(150, 165, 180);

    public PadCenter()
    {
        Text = "PadTrack 控制中心";
        ClientSize = new Size(640, 700);
        AutoScaleMode = AutoScaleMode.None;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        BackColor = Color.FromArgb(11, 15, 20);
        DoubleBuffered = true;
        SetStyle(ControlStyles.AllPaintingInWmPaint
               | ControlStyles.OptimizedDoubleBuffer
               | ControlStyles.UserPaint, true);

        fTitle = new Font("Microsoft YaHei UI", 15f, FontStyle.Bold);
        fSub = new Font("Microsoft YaHei UI", 8.5f);
        fLine = new Font("Microsoft YaHei UI", 9.5f);
        fLineB = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold);
        fBtn = new Font("Microsoft YaHei UI", 9f, FontStyle.Bold);
        fLog = new Font("Microsoft YaHei UI", 8.2f);
        fTag = new Font("Microsoft YaHei UI", 8f);

        cardA = new Rectangle(20, 92, 600, 176);
        cardB = new Rectangle(20, 392, 600, 288);

        // 深色标题栏，和窗体内部统一
        try
        {
            DwmSetWindowAttribute(Handle, 20, ref darkMode, sizeof(int));
        }
        catch { }

        anim = new Timer();
        anim.Interval = 16;
        anim.Tick += (s, e) => Tick();
        anim.Start();
    }

    public void AddButton(string key, string text, int x, int y, int w, int h, int kind)
    {
        PadButton b = new PadButton();
        b.Key = key; b.Text = text; b.Rect = new Rectangle(x, y, w, h); b.Kind = kind;
        Buttons.Add(b);
    }

    private void Tick()
    {
        bool dirty = false;
        for (int i = 0; i < Buttons.Count; i++)
        {
            PadButton b = Buttons[i];
            float target = (i == hot && b.Enabled) ? 1f : 0f;
            float d = target - b.Hover;
            if (Math.Abs(d) > 0.01f) { b.Hover += d * 0.25f; dirty = true; }
            else if (b.Hover != target) { b.Hover = target; dirty = true; }

            float pt = (i == down && b.Enabled) ? 1f : 0f;
            float dp = pt - b.Press;
            if (Math.Abs(dp) > 0.01f) { b.Press += dp * 0.35f; dirty = true; }
            else if (b.Press != pt) { b.Press = pt; dirty = true; }
        }
        if (dirty) Invalidate();
    }

    private static GraphicsPath Round(Rectangle r, int rad)
    {
        GraphicsPath p = new GraphicsPath();
        int d = rad * 2;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    private static Color Mix(Color a, Color b, float t)
    {
        t = Math.Max(0f, Math.Min(1f, t));
        return Color.FromArgb(
            (int)(a.A + (b.A - a.A) * t),
            (int)(a.R + (b.R - a.R) * t),
            (int)(a.G + (b.G - a.G) * t),
            (int)(a.B + (b.B - a.B) * t));
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.ScaleTransform(UiScale, UiScale);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

        // 背景：竖向渐变 + 左上角薄荷绿柔光（近似网页的封面模糊氛围）
        Rectangle full = new Rectangle(0, 0, (int)(Width / UiScale), (int)(Height / UiScale));
        using (LinearGradientBrush bg = new LinearGradientBrush(full,
            Color.FromArgb(19, 25, 33), Color.FromArgb(9, 12, 17), 90f))
        {
            g.FillRectangle(bg, full);
        }
        using (GraphicsPath glow = new GraphicsPath())
        {
            glow.AddEllipse(-160, -220, 620, 420);
            using (PathGradientBrush pb = new PathGradientBrush(glow))
            {
                pb.CenterColor = Color.FromArgb(26, 62, 207, 142);
                pb.SurroundColors = new Color[] { Color.FromArgb(0, 62, 207, 142) };
                g.FillPath(pb, glow);
            }
        }

        // 标题
        using (SolidBrush b = new SolidBrush(TextMain))
            g.DrawString("PadTrack 控制中心", fTitle, b, 22, 22);
        using (SolidBrush b = new SolidBrush(TextDim))
            g.DrawString("平板触控板 · 统一管理", fSub, b, 24, 56);

        DrawCard(g, cardA);
        DrawCard(g, cardB);

        // 状态行
        float y = cardA.Y + 18;
        foreach (string line in Lines)
        {
            string[] parts = line.Split('|');
            string label = parts.Length > 0 ? parts[0] : "";
            string value = parts.Length > 1 ? parts[1] : "";
            string state = parts.Length > 2 ? parts[2] : "dim";

            Color dot = state == "ok" ? Accent
                      : state == "warn" ? Color.FromArgb(232, 190, 92)
                      : Color.FromArgb(110, 125, 140);

            using (SolidBrush b = new SolidBrush(dot))
                g.FillEllipse(b, cardA.X + 20, y + 7, 7, 7);
            using (SolidBrush b = new SolidBrush(TextDim))
                g.DrawString(label, fLine, b, cardA.X + 38, y);
            using (SolidBrush b = new SolidBrush(TextMain))
                g.DrawString(value, fLineB, b, cardA.X + 150, y);
            y += 28;
        }

        // 按钮
        foreach (PadButton btn in Buttons) DrawButton(g, btn);

        // 日志卡片
        using (SolidBrush t = new SolidBrush(TextDim))
            g.DrawString("最近日志", fTag, t, cardB.X + 4, cardB.Y - 22);

        Rectangle inner = new Rectangle(cardB.X + 14, cardB.Y + 14,
                                        cardB.Width - 28, cardB.Height - 28);
        using (SolidBrush b = new SolidBrush(Color.FromArgb(120, 8, 11, 15)))
            g.FillPath(b, Round(inner, 10));

        RectangleF txt = new RectangleF(inner.X + 12, inner.Y + 10,
                                        inner.Width - 24, inner.Height - 20);
        Region oldClip = g.Clip;
        g.SetClip(inner);
        using (StringFormat sf = new StringFormat())
        {
            sf.Trimming = StringTrimming.None;
            using (SolidBrush b = new SolidBrush(Color.FromArgb(170, 185, 200)))
                g.DrawString(LogText ?? "", fLog, b, txt, sf);
        }
        g.Clip = oldClip;
    }

    private void DrawCard(Graphics g, Rectangle r)
    {
        using (GraphicsPath p = Round(r, 14))
        {
            using (SolidBrush b = new SolidBrush(Color.FromArgb(14, 255, 255, 255)))
                g.FillPath(b, p);
            using (Pen pen = new Pen(Color.FromArgb(36, 255, 255, 255), 1f))
                g.DrawPath(pen, p);
        }
    }

    private void DrawButton(Graphics g, PadButton b)
    {
        Rectangle r = b.Rect;
        // 按下时轻微内缩，模仿网页的 scale(.96)
        if (b.Press > 0.01f)
        {
            int dx = (int)(r.Width * 0.015f * b.Press);
            int dy = (int)(r.Height * 0.03f * b.Press);
            r = new Rectangle(r.X + dx, r.Y + dy, r.Width - dx * 2, r.Height - dy * 2);
        }

        Color fill, border, text;
        if (b.Kind == 1)
        {
            fill = Color.FromArgb((int)(210 + 40 * b.Hover), Accent);
            border = Color.FromArgb(255, 120, 230, 180);
            text = Color.FromArgb(10, 16, 12);
        }
        else if (b.Kind == 2)
        {
            fill = Mix(Color.FromArgb(16, 255, 255, 255), Color.FromArgb(46, 220, 120, 120), b.Hover);
            border = Mix(Color.FromArgb(36, 255, 255, 255), Color.FromArgb(110, 220, 120, 120), b.Hover);
            text = Color.FromArgb(230, 150, 150);
        }
        else
        {
            fill = Mix(Color.FromArgb(16, 255, 255, 255), Color.FromArgb(34, 255, 255, 255), b.Hover);
            border = Mix(Color.FromArgb(36, 255, 255, 255), Color.FromArgb(80, 255, 255, 255), b.Hover);
            text = Color.FromArgb(220, 230, 240);
        }
        if (!b.Enabled) { fill = Color.FromArgb(10, 255, 255, 255); text = Color.FromArgb(90, 100, 110); }

        using (GraphicsPath p = Round(r, 10))
        {
            using (SolidBrush br = new SolidBrush(fill)) g.FillPath(br, p);
            using (Pen pen = new Pen(border, 1f)) g.DrawPath(pen, p);
        }

        using (StringFormat sf = new StringFormat())
        {
            sf.Alignment = StringAlignment.Center;
            sf.LineAlignment = StringAlignment.Center;
            using (SolidBrush br = new SolidBrush(text))
                g.DrawString(b.Text, fBtn, br, r, sf);
        }
    }

    private Point Logical(Point p)
    {
        return new Point((int)(p.X / UiScale), (int)(p.Y / UiScale));
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        Point lp = Logical(e.Location);
        int idx = -1;
        for (int i = 0; i < Buttons.Count; i++)
            if (Buttons[i].Rect.Contains(lp)) idx = i;
        if (idx != hot) { hot = idx; Cursor = idx >= 0 ? Cursors.Hand : Cursors.Default; }
        base.OnMouseMove(e);
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        hot = -1;
        base.OnMouseLeave(e);
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        Point lp = Logical(e.Location);
        for (int i = 0; i < Buttons.Count; i++)
            if (Buttons[i].Rect.Contains(lp)) down = i;
        base.OnMouseDown(e);
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        int hit = -1;
        Point lp = Logical(e.Location);
        for (int i = 0; i < Buttons.Count; i++)
            if (Buttons[i].Rect.Contains(lp)) hit = i;

        if (hit >= 0 && hit == down)
        {
            PadButton b = Buttons[hit];
            if (b.Enabled && OnAction != null)
            {
                try { OnAction(b.Key); } catch { }
            }
        }
        down = -1;
        base.OnMouseUp(e);
    }
}

'@

Add-Type -TypeDefinition $csharp -ReferencedAssemblies System.Windows.Forms, System.Drawing
if ($Compile) { 'compiled ok'; exit 0 }

function Get-Key {
    if (Test-Path $keyFile) { return (Get-Content $keyFile -Raw).Trim() }
    return ''
}

function Get-LanIp {
    $addrFile = Join-Path $here '当前地址.txt'
    if (Test-Path $addrFile) {
        $m = Select-String -Path $addrFile -Pattern 'http://([0-9\.]+):' -AllMatches
        if ($m -and $m.Matches.Count -gt 0) {
            $ipFromFile = $m.Matches[0].Groups[1].Value
            if ($ipFromFile -and $ipFromFile -ne '127.0.0.1') { return $ipFromFile }
        }
    }
    try {
        $sock = New-Object System.Net.Sockets.UdpClient
        $sock.Connect('8.8.8.8', 80)
        $ip = $sock.Client.LocalEndPoint.Address.ToString()
        $sock.Close()
        if ($ip -and $ip -notlike '127.*') { return $ip }
    } catch {}
    return '127.0.0.1'
}

function Get-Server {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $c) { return $null }
    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    return [pscustomobject]@{ PID = $c.OwningProcess; Name = $(if ($p) { $p.ProcessName } else { '?' }) }
}

function Test-NewVersion {
    $k = Get-Key
    if (-not $k) { return $false }
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/keylock?k=$k" -UseBasicParsing -TimeoutSec 2
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function Get-AdbDevice {
    if (-not (Test-Path $adb)) { return $null }
    $env:TMP = Join-Path $here 'tools\tmp'
    $env:TEMP = $env:TMP
    $out = & $adb devices 2>$null
    foreach ($line in $out) {
        if ($line -match '^(\S+)\s+device$') { return $Matches[1] }
    }
    return $null
}

function Get-Reverse {
    if (-not (Test-Path $adb)) { return '' }
    $env:TMP = Join-Path $here 'tools\tmp'
    $env:TEMP = $env:TMP
    $out = & $adb reverse --list 2>$null
    if ($out -match "tcp:$port") { return 'on' }
    return ''
}

function Get-LastClient {
    if (-not (Test-Path $logFile)) { return '' }
    $tail = Get-Content $logFile -Tail 200 -Encoding UTF8 -ErrorAction SilentlyContinue
    $hits = $tail | Select-String '平板已连接: (\S+)'
    if ($hits) { return $hits[-1].Matches[0].Groups[1].Value }
    return ''
}

if ($Test) {
    $s = Get-Server
    'server: ' + $(if ($s) { "pid $($s.PID) $($s.Name)" } else { 'none' })
    'new version: ' + (Test-NewVersion)
    'adb device: ' + (Get-AdbDevice)
    'reverse: ' + $(if (Get-Reverse) { 'on' } else { 'off' })
    'last client: ' + (Get-LastClient)
    'lan ip: ' + (Get-LanIp)
    exit 0
}


# 让窗口里的中文不受代码页影响
[System.Windows.Forms.Application]::EnableVisualStyles()

$ui = New-Object PadCenter
try {
    $scale = $ui.DeviceDpi / 96.0
    if ($scale -lt 1) { $scale = 1 }
    $ui.UiScale = $scale
    $ui.ClientSize = New-Object System.Drawing.Size ([int](640 * $scale)), ([int](700 * $scale))
} catch {}
$ui.AddButton('start',      '启动（普通权限）', 20,  292, 190, 40, 1)
$ui.AddButton('startadmin', '以管理员启动',     222, 292, 190, 40, 0)
$ui.AddButton('stop',       '停止服务',         424, 292, 190, 40, 2)
$ui.AddButton('usb',        'USB 直连（建映射）', 20, 342, 190, 36, 0)
$ui.AddButton('open',       '打开平板页面',     222, 342, 190, 36, 0)
$ui.AddButton('copy',       '复制地址',         424, 342, 190, 36, 0)

$ui.OnAction = [Func[string, bool]]{
    param($key)

    $srv = Get-Server
    switch ($key) {
        'start' {
            if (-not (Test-Path $exe)) { [System.Windows.Forms.MessageBox]::Show("找不到 PadTrack.exe", 'PadTrack'); return $false }
            Start-Process -FilePath $exe -WorkingDirectory $here
            Start-Sleep -Milliseconds 700
        }
        'startadmin' {
            if (-not (Test-Path $exe)) { [System.Windows.Forms.MessageBox]::Show("找不到 PadTrack.exe", 'PadTrack'); return $false }
            try { Start-Process -FilePath $exe -WorkingDirectory $here -Verb RunAs } catch {}
            Start-Sleep -Milliseconds 1500
        }
        'stop' {
            if ($srv) {
                & taskkill /f /pid $srv.PID *> $null
                if ($LASTEXITCODE -ne 0) {
                    try { Start-Process -FilePath (Join-Path $here '停止.bat') -Verb RunAs -WorkingDirectory $here } catch {}
                }
                Start-Sleep -Milliseconds 900
            }
        }
        'usb' {
            $bat = Join-Path $here 'USB直连.bat'
            if (Test-Path $bat) { Start-Process -FilePath $bat -WorkingDirectory $here }
            Start-Sleep -Milliseconds 1600
        }
        'open' {
            $k = Get-Key
            Start-Process "http://127.0.0.1:$port/?k=$k"
        }
        'copy' {
            [System.Windows.Forms.Clipboard]::SetText("http://$(Get-LanIp):$port/?k=$(Get-Key)")
        }
    }
    Refresh-Ui
    return $true
}

function Refresh-Ui {
    $srv = Get-Server
    $lines = New-Object System.Collections.Generic.List[string]
    if ($srv) {
        $lines.Add("运行状态|运行中 · PID $($srv.PID)（$($srv.Name)）|ok")
    } else {
        $lines.Add("运行状态|未运行|warn")
    }
    if ($srv) {
        if (Test-NewVersion) { $lines.Add('版本|新版|codE') } else { $lines.Add('版本|旧版，建议停止后重开|warn') }
    } else {
        $lines.Add('版本|-|dim')
    }
    $dev = Get-AdbDevice
    if ($dev) {
        $rev = Get-Reverse
        if ($rev) { $lines.Add("USB 设备|$dev  ·  映射已建立|ok") }
        else { $lines.Add("USB 设备|$dev  ·  映射未建立|warn") }
    } else {
        $lines.Add('USB 设备|未检测到（插线并允许调试）|dim')
    }
    $client = Get-LastClient
    if ($client) {
        $how = if ($client -eq '127.0.0.1') { 'USB' } else { 'WiFi' }
        $lines.Add("最近连接|$client（$how）|ok")
    } else {
        $lines.Add('最近连接|-|dim')
    }
    $lines.Add("平板地址|http://$(Get-LanIp):$port/?k=$(Get-Key)|dim")
    $ui.Lines = $lines.ToArray()

    # 按钮状态
    foreach ($b in $ui.Buttons) {
        if ($b.Key -eq 'start' -or $b.Key -eq 'startadmin') { $b.Enabled = -not $srv }
        if ($b.Key -eq 'stop') { $b.Enabled = [bool]$srv }
    }

    if (Test-Path $logFile) {
        $ui.LogText = ((Get-Content $logFile -Tail 16 -Encoding UTF8 -ErrorAction SilentlyContinue) -join "`r`n")
    }
    $ui.Invalidate()
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.Add_Tick({ try { Refresh-Ui } catch {} })
$timer.Start()

$ui.Add_Shown({ try { Refresh-Ui } catch {} })
[void]$ui.ShowDialog()
$timer.Stop()

