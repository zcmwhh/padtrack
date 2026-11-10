# PadTrack 控制中心（自绘 + 后台采集，UI 线程不做阻塞 I/O）
param([switch]$Test, [switch]$Compile)

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

try {
    Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class DpiApi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
    [void][DpiApi]::SetProcessDPIAware()
} catch {}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $here 'PadTrack.exe'
$keyFile = Join-Path $here 'key.txt'
$port = 8765

try {
    $tmpDir = Join-Path $here 'tools\tmp'
    if (-not (Test-Path $tmpDir)) { New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null }
    $env:TMP = $tmpDir
    $env:TEMP = $tmpDir
} catch {}

$csharp = @'

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

public class AddrItem
{
    public string Kind = "";      // 网线 / WiFi / 热点
    public string Ip = "";
    public string IfName = "";
}

public class StatusData
{
    public bool Running;
    public int Pid;
    public string ProcName = "?";
    public bool NewVersion;
    public string Device = "";
    public bool Reverse;
    public string LastClient = "";
    public string LanIp = "127.0.0.1";
    public string LogTail = "";
    public System.Collections.Generic.List<AddrItem> Addrs =
        new System.Collections.Generic.List<AddrItem>();
}

public class PadButton
{
    public string Key;
    public string Text;
    public Rectangle Rect;
    public int Kind;          // 0=ghost 1=primary 2=danger 3=窗口按钮
    public float Hover;
    public float Press;
    public bool Enabled = true;
}

public class PadCenter : Form
{
    public List<PadButton> Buttons = new List<PadButton>();
    public List<PadButton> Caps = new List<PadButton>();
    public Func<string, bool> OnAction = null;
    public StatusData Last = null;
    public bool GlassOn = false;
    public string AppDir = ".";

    public const float DesignW = 640f;
    public const float DesignH = 700f;

    private string[] linesData = new string[0];
    private string logData = "";
    private int port = 8765;

    private int hot = -1, down = -1;
    private System.Windows.Forms.Timer anim;
    private Font fTitle, fSub, fLine, fLineB, fBtn, fLog, fTag;
    private Rectangle cardA, cardB;
    private float scale = 1f, offX = 0f, offY = 0f;

    private Rectangle addrRect = Rectangle.Empty;
    private string addrUrl = "";
    private readonly List<Rectangle> chipRects = new List<Rectangle>();
    private readonly List<string> chipUrls = new List<string>();
    private int chipHot = -1;
    private DateTime toastAt = DateTime.MinValue;

    private Bitmap frameCache = null;
    private bool frameDirty = true;
    private bool dragging = false;

    private DateTime adbAt = DateTime.MinValue;
    private string adbDev = "";
    private bool adbRev = false;

    private Thread pollThread;
    private volatile bool pollStop = false;
    private readonly ManualResetEventSlim poke = new ManualResetEventSlim(false);

    private static readonly Color Accent = Color.FromArgb(62, 207, 142);
    private static readonly Color TextMain = Color.FromArgb(226, 236, 246);
    private static readonly Color TextDim = Color.FromArgb(150, 165, 180);

    [StructLayout(LayoutKind.Sequential)]
    private struct MARGINS { public int Left; public int Right; public int Top; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct AccentPolicy { public int AccentState; public int AccentFlags; public int GradientColor; public int AnimationId; }

    [StructLayout(LayoutKind.Sequential)]
    private struct WindowCompositionData { public int Attribute; public IntPtr Data; public int SizeOfData; }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    [DllImport("dwmapi.dll")]
    private static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref MARGINS m);
    [DllImport("user32.dll")]
    private static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref WindowCompositionData data);

    private int darkMode = 1;

    public PadCenter()
    {
        Text = "PadTrack 控制中心";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size((int)DesignW, (int)DesignH);
        MinimumSize = new Size(560, 620);
        MaximizeBox = false;
        BackColor = Color.FromArgb(11, 15, 20);
        DoubleBuffered = true;
        AutoScaleMode = AutoScaleMode.None;
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

        cardA = new Rectangle(20, 92, 600, 232);
        cardB = new Rectangle(20, 474, 600, 206);

        Caps.Add(MakeCap("min", 508, 14));
        Caps.Add(MakeCap("max", 548, 14));
        Caps.Add(MakeCap("close", 588, 14));

        anim = new System.Windows.Forms.Timer();
        anim.Interval = 16;
        anim.Tick += (s, e) => Tick();
        anim.Start();

        pollThread = new Thread(PollLoop);
        pollThread.IsBackground = true;
        pollThread.Start();
    }

    public void PokeRefresh()
    {
        try { poke.Set(); } catch { }
    }

    private PadButton MakeCap(string key, int x, int y)
    {
        PadButton b = new PadButton();
        b.Key = key; b.Rect = new Rectangle(x, y, 32, 32); b.Kind = 3;
        return b;
    }

    public void AddButton(string key, string text, int x, int y, int w, int h, int kind)
    {
        PadButton b = new PadButton();
        b.Key = key; b.Text = text; b.Rect = new Rectangle(x, y, w, h); b.Kind = kind;
        Buttons.Add(b);
    }

    // ---------------- 后台采集 ----------------

    private void PollLoop()
    {
        while (!pollStop)
        {
            StatusData d = null;
            try { d = Collect(); }
            catch { }
            if (d != null)
            {
                try
                {
                    if (IsHandleCreated)
                        BeginInvoke(new Action<StatusData>(Apply), d);
                }
                catch { }
            }
            poke.Wait(2000);
            poke.Reset();
        }
    }

    private void Dbg(string msg)
    {
        try
        {
            File.AppendAllText(Path.Combine(AppDir, "center_poll.log"),
                DateTime.Now.ToString("HH:mm:ss") + " " + msg + "\r\n", Encoding.UTF8);
        }
        catch { }
    }

    private string AdbPath() { return Path.Combine(AppDir, @"tools\platform-tools\adb.exe"); }

    private bool lastRunTimedOut = false;
    private DateTime adbRestartedAt = DateTime.MinValue;

    private string RunHidden(string file, string args, int timeoutMs)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(file, args);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.WorkingDirectory = AppDir;
            using (Process p = Process.Start(psi))
            {
                // 必须先异步读：进程卡住不退出时 ReadToEnd 会一直等，超时形同虚设
                System.Threading.Tasks.Task<string> outTask = p.StandardOutput.ReadToEndAsync();
                System.Threading.Tasks.Task<string> errTask = p.StandardError.ReadToEndAsync();

                lastRunTimedOut = false;
                if (!p.WaitForExit(timeoutMs))
                {
                    lastRunTimedOut = true;
                    try { p.Kill(); } catch { }
                    try { p.WaitForExit(1500); } catch { }
                }

                string outp = "";
                try
                {
                    if (outTask.Wait(1500)) outp += outTask.Result;
                    if (errTask.Wait(1500)) outp += errTask.Result;
                }
                catch { }
                return outp;
            }
        }
        catch { return ""; }
    }

    private int FindListenerPid()
    {
        string outp = RunHidden(Path.Combine(Environment.SystemDirectory, "netstat.exe"), "-ano", 2500);
        foreach (string line in outp.Split('\n'))
        {
            if (line.IndexOf(":" + port, StringComparison.Ordinal) < 0) continue;
            if (line.IndexOf("LISTENING", StringComparison.OrdinalIgnoreCase) < 0) continue;
            string[] parts = line.Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 5) continue;
            int pid;
            if (int.TryParse(parts[parts.Length - 1], out pid)) return pid;
        }
        return 0;
    }

    private void RestartAdb(string adbPath)
    {
        bool hadReverse = adbRev;
        try
        {
            RunHidden(Path.Combine(Environment.SystemDirectory, "taskkill.exe"),
                      "/f /im adb.exe", 3000);
            Thread.Sleep(600);
            RunHidden(adbPath, "start-server", 6000);
            Thread.Sleep(400);
            if (hadReverse)
                RunHidden(adbPath, "reverse tcp:" + port + " tcp:" + port, 5000);
            adbRestartedAt = DateTime.Now;
        }
        catch { }
    }

    private bool HttpOk(string url, int timeoutMs)
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            req.Proxy = null;
            using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                return (int)resp.StatusCode == 200;
        }
        catch { return false; }
    }

    private string ReadKey()
    {
        try
        {
            string f = Path.Combine(AppDir, "key.txt");
            if (File.Exists(f)) return File.ReadAllText(f, Encoding.UTF8).Trim();
        }
        catch { }
        return "";
    }

    private string DetectLanIp()
    {
        try
        {
            string f = Path.Combine(AppDir, "当前地址.txt");
            if (File.Exists(f))
            {
                Match m = Regex.Match(File.ReadAllText(f, Encoding.UTF8), @"http://([0-9\.]+):");
                if (m.Success && m.Groups[1].Value != "127.0.0.1") return m.Groups[1].Value;
            }
        }
        catch { }
        try
        {
            using (Socket s = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp))
            {
                s.Connect("8.8.8.8", 80);
                return ((IPEndPoint)s.LocalEndPoint).Address.ToString();
            }
        }
        catch { }
        return "127.0.0.1";
    }

    private bool? hotspotOn = null;
    private DateTime hotspotAt = DateTime.MinValue;

    private bool HotspotOn()
    {
        // 移动热点靠 Internet 连接共享服务，服务停了地址就不通
        if (hotspotOn != null && (DateTime.Now - hotspotAt).TotalSeconds < 10) return hotspotOn.Value;
        hotspotAt = DateTime.Now;
        bool on = false;
        try
        {
            string outp = RunHidden(Path.Combine(Environment.SystemDirectory, "sc.exe"),
                                    "query SharedAccess", 2000);
            on = outp.IndexOf("RUNNING", StringComparison.OrdinalIgnoreCase) >= 0;
        }
        catch { }
        hotspotOn = on;
        return on;
    }

    private void CollectAddrs(StatusData d)
    {
        try
        {
            foreach (NetworkInterface ni in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (ni.OperationalStatus != OperationalStatus.Up) continue;
                if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;

                string kind = "网卡";
                string desc = (ni.Name + " " + ni.Description).ToLower();
                if (desc.Contains("wlan") || desc.Contains("wi-fi") || desc.Contains("wireless"))
                    kind = "WiFi";
                else if (desc.Contains("以太网") || desc.Contains("ethernet"))
                    kind = "网线";
                if (ni.Name.Contains("本地连接") || ni.Description.Contains("Wi-Fi Direct"))
                    kind = HotspotOn() ? "热点" : "热点(未开)";

                foreach (UnicastIPAddressInformation ua in ni.GetIPProperties().UnicastAddresses)
                {
                    if (ua.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                    string ip = ua.Address.ToString();
                    if (ip.StartsWith("127.") || ip.StartsWith("169.254.")) continue;
                    AddrItem it = new AddrItem();
                    it.Kind = kind; it.Ip = ip; it.IfName = ni.Name;
                    d.Addrs.Add(it);
                }
            }
        }
        catch { }
    }

    private StatusData Collect()
    {
        StatusData d = new StatusData();
        CollectAddrs(d);
        d.LanIp = DetectLanIp();

        int pid = FindListenerPid();
        d.Running = pid > 0;
        d.Pid = pid;
        if (pid > 0)
        {
            try { d.ProcName = Process.GetProcessById(pid).ProcessName; } catch { d.ProcName = "?"; }
            string key = ReadKey();
            if (key.Length > 0)
                d.NewVersion = HttpOk("http://127.0.0.1:" + port + "/keylock?k=" + key, 1200);
        }

        // adb 看门狗：上一次查询超时 → 大概率服务器卡死，直接重启它
        string adbPath = AdbPath();
        if (File.Exists(adbPath) && (DateTime.Now - adbRestartedAt).TotalSeconds > 20)
        {
            bool wedged = !string.IsNullOrEmpty(lastRunTimedOut ? "1" : "") && lastRunTimedOut;
            if (wedged)
            {
                RestartAdb(adbPath);
                lastRunTimedOut = false;
            }
        }

        // adb 调用有成本，6 秒查一次就够
        string adb = AdbPath();
        if (File.Exists(adb) && (DateTime.Now - adbAt).TotalSeconds >= 6)
        {
            adbAt = DateTime.Now;
            string dev = RunHidden(adb, "devices", 3000);
            foreach (string line in dev.Split('\n'))
            {
                Match m = Regex.Match(line.Trim(), @"^(\S+)\s+device$");
                if (m.Success) { adbDev = m.Groups[1].Value; break; }
            }

            adbRev = false;
            if (adbDev.Length > 0)
            {
                string rev = RunHidden(adb, "reverse --list", 3000);
                adbRev = rev.IndexOf("tcp:" + port, StringComparison.Ordinal) >= 0;
            }
        }
        d.Device = adbDev;
        d.Reverse = adbRev;

        try
        {
            string log = Path.Combine(AppDir, "padtrack.log");
            if (File.Exists(log))
            {
                string[] all = File.ReadAllLines(log, Encoding.UTF8);
                int start = Math.Max(0, all.Length - 40);
                StringBuilder tail = new StringBuilder();
                for (int i = start; i < all.Length; i++) tail.AppendLine(all[i]);
                d.LogTail = tail.ToString().TrimEnd();

                for (int i = all.Length - 1; i >= 0; i--)
                {
                    Match m = Regex.Match(all[i], @"平板已连接:\s*(\S+)");
                    if (m.Success) { d.LastClient = m.Groups[1].Value; break; }
                }
            }
        }
        catch { }

        return d;
    }

    // ---------------- UI 更新 ----------------

    private void Apply(StatusData d)
    {
        Last = d;

        List<string> lines = new List<string>();
        if (d.Running)
            lines.Add("运行状态|运行中 · PID " + d.Pid + "（" + d.ProcName + "）|ok");
        else
            lines.Add("运行状态|未运行|warn");

        if (d.Running)
            lines.Add(d.NewVersion ? "版本|新版|ok" : "版本|旧版，建议停止后重开|warn");
        else
            lines.Add("版本|-|dim");

        if (d.Device.Length > 0)
        {
            string tail = (DateTime.Now - adbRestartedAt).TotalSeconds < 60 ? "（adb 已自动重启）" : "";
            lines.Add(d.Reverse
                ? "USB 设备|" + d.Device + "  ·  映射已建立" + tail + "|ok"
                : "USB 设备|" + d.Device + "  ·  映射未建立" + tail + "|warn");
        }
        else
            lines.Add("USB 设备|未检测到（插线并允许调试）|dim");

        if (d.LastClient.Length > 0)
            lines.Add("最近连接|" + d.LastClient + (d.LastClient == "127.0.0.1" ? "（USB）" : "（WiFi）") + "|ok");
        else
            lines.Add("最近连接|-|dim");

        string key = ReadKey();
        if (d.Device.Length > 0 && d.Reverse)
            lines.Add("USB|http://127.0.0.1:" + port + "/?k=" + key + "|ok");

        int shown = 0;
        foreach (AddrItem a in d.Addrs)
        {
            if (shown >= 2) break;
            string label = a.Kind;
            if (label == "网卡") label = a.IfName.Length > 0 ? a.IfName : "网卡";
            lines.Add(label + "|http://" + a.Ip + ":" + port + "/?k=" + key + "|dim");
            shown++;
        }
        if (shown == 0)
            lines.Add("地址|http://" + d.LanIp + ":" + port + "/?k=" + key + "|dim");

        linesData = lines.ToArray();
        logData = d.LogTail;
        frameDirty = true;

        foreach (PadButton b in Buttons)
        {
            if (b.Key == "startadmin") b.Enabled = !d.Running;
            if (b.Key == "stop") b.Enabled = d.Running;
        }

        Invalidate();
    }

    // ---------------- 绘制 ----------------

    private void Tick()
    {
        bool dirty = false;
        List<PadButton> all = new List<PadButton>();
        all.AddRange(Buttons);
        all.AddRange(Caps);
        for (int i = 0; i < all.Count; i++)
        {
            PadButton b = all[i];
            float target = (i == hot && b.Enabled) ? 1f : 0f;
            float d = target - b.Hover;
            if (Math.Abs(d) > 0.01f) { b.Hover += d * 0.25f; dirty = true; }
            else if (b.Hover != target) { b.Hover = target; dirty = true; }

            float pt = (i == down && b.Enabled) ? 1f : 0f;
            float dp = pt - b.Press;
            if (Math.Abs(dp) > 0.01f) { b.Press += dp * 0.35f; dirty = true; }
            else if (b.Press != pt) { b.Press = pt; dirty = true; }
        }
        if (dirty) { frameDirty = true; Invalidate(); }
    }

    private static GraphicsPath Round(RectangleF r, float rad)
    {
        GraphicsPath p = new GraphicsPath();
        float d = rad * 2f;
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

    private void ApplyGlass()
    {
        try
        {
            MARGINS m = new MARGINS();
            m.Left = 1; m.Right = 1; m.Top = 1; m.Bottom = 1;
            DwmExtendFrameIntoClientArea(Handle, ref m);

            int build = Environment.OSVersion.Version.Build;
            if (build >= 22000)
            {
                int roundPref = 2;
                DwmSetWindowAttribute(Handle, 33, ref roundPref, sizeof(int));
                int mica = 2;
                int code = DwmSetWindowAttribute(Handle, 38, ref mica, sizeof(int));
                if (code == 0) { GlassOn = true; return; }
            }

            AccentPolicy ap = new AccentPolicy();
            ap.AccentState = 3;
            ap.AccentFlags = 2;
            ap.GradientColor = unchecked((int)0xA80C1117);
            int size = Marshal.SizeOf(ap);
            IntPtr ptr = Marshal.AllocHGlobal(size);
            Marshal.StructureToPtr(ap, ptr, false);
            WindowCompositionData data = new WindowCompositionData();
            data.Attribute = 19;
            data.SizeOfData = size;
            data.Data = ptr;
            int hr = SetWindowCompositionAttribute(Handle, ref data);
            Marshal.FreeHGlobal(ptr);
            GlassOn = (hr != 0);
        }
        catch { GlassOn = false; }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        ApplyGlass();
        try { DwmSetWindowAttribute(Handle, 20, ref darkMode, sizeof(int)); } catch { }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        pollStop = true;
        try { poke.Set(); } catch { }
        base.OnFormClosing(e);
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        Invalidate();
    }

    private void CalcTransform()
    {
        float w = ClientSize.Width;
        float h = ClientSize.Height;
        scale = Math.Min(w / DesignW, h / DesignH);
        if (scale <= 0) scale = 1f;
        offX = (w - DesignW * scale) / 2f;
        offY = (h - DesignH * scale) / 2f;
    }

    private PointF ToDesign(Point p)
    {
        CalcTransform();
        return new PointF((p.X - offX) / scale, (p.Y - offY) / scale);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        CalcTransform();

        if (frameDirty || frameCache == null)
        {
            if (frameCache == null)
                frameCache = new Bitmap((int)DesignW, (int)DesignH,
                                        System.Drawing.Imaging.PixelFormat.Format32bppArgb);
            using (Graphics fg = Graphics.FromImage(frameCache))
            {
                fg.Clear(Color.Transparent);
                RenderAll(fg);
            }
            frameDirty = false;
        }

        Graphics g = e.Graphics;
        if (dragging)
        {
            using (SolidBrush sb = new SolidBrush(Color.FromArgb(16, 21, 27)))
                g.FillRectangle(sb, 0, 0, Width, Height);
        }
        g.InterpolationMode = InterpolationMode.Low;
        g.PixelOffsetMode = PixelOffsetMode.Half;
        g.DrawImage(frameCache, new RectangleF(offX, offY, DesignW * scale, DesignH * scale));
    }

    private void RenderAll(Graphics g)
    {
        chipRects.Clear();
        chipUrls.Clear();
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;

        Rectangle full = new Rectangle(0, 0, (int)DesignW, (int)DesignH);
        int a1 = GlassOn ? 168 : 255;
        int a2 = GlassOn ? 200 : 255;
        using (LinearGradientBrush bg = new LinearGradientBrush(full,
            Color.FromArgb(a1, 19, 25, 33), Color.FromArgb(a2, 9, 12, 17), 90f))
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

        using (SolidBrush b = new SolidBrush(TextMain))
            g.DrawString("PadTrack 控制中心", fTitle, b, 22, 20);
        using (SolidBrush b = new SolidBrush(TextDim))
            g.DrawString("平板触控板 · 统一管理", fSub, b, 24, 56);

        DrawCard(g, cardA);
        DrawCard(g, cardB);

        float y = cardA.Y + 18;
        foreach (string line in linesData)
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
            if (value.StartsWith("http://"))
            {
                SizeF sz = g.MeasureString(value, fLineB);
                addrRect = new Rectangle(cardA.X + 146, (int)y - 2, (int)sz.Width + 8, (int)sz.Height + 4);
                addrUrl = value;        // 点哪行复制哪行

                // 右侧的「复制」小胶囊
                Rectangle chip = new Rectangle(cardA.Right - 74, (int)y - 1, 52, 22);
                bool hot = chipRects.Count == chipHot;
                Color chipFill = hot ? Color.FromArgb(120, 62, 207, 142)
                                     : Color.FromArgb(26, 255, 255, 255);
                Color chipText = hot ? Color.FromArgb(10, 20, 14)
                                     : Color.FromArgb(190, 205, 220);
                using (GraphicsPath cp = Round(chip, 11))
                {
                    using (SolidBrush cb = new SolidBrush(chipFill)) g.FillPath(cb, cp);
                    using (Pen cpen = new Pen(Color.FromArgb(hot ? 150 : 46, 255, 255, 255), 1f))
                        g.DrawPath(cpen, cp);
                }
                using (StringFormat sf = new StringFormat())
                {
                    sf.Alignment = StringAlignment.Center;
                    sf.LineAlignment = StringAlignment.Center;
                    using (SolidBrush tb = new SolidBrush(chipText))
                        g.DrawString("复制", fTag, tb, chip, sf);
                }
                chipRects.Add(chip);
                chipUrls.Add(value);
            }
            y += 28;
        }

        foreach (PadButton btn in Buttons) DrawButton(g, btn);

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
                g.DrawString(logData ?? "", fLog, b, txt, sf);
        }
        g.Clip = oldClip;

        foreach (PadButton cap in Caps) DrawCap(g, cap);

        // 复制后的提示
        if ((DateTime.Now - toastAt).TotalSeconds < 1.8)
        {
            string t = "地址已复制";
            SizeF sz = g.MeasureString(t, fTag);
            RectangleF box = new RectangleF((DesignW - sz.Width - 32) / 2f, 660, sz.Width + 32, 26);
            using (GraphicsPath p = Round(box, 13))
            {
                using (SolidBrush b = new SolidBrush(Color.FromArgb(230, 40, 190, 130)))
                    g.FillPath(b, p);
            }
            using (SolidBrush b = new SolidBrush(Color.FromArgb(255, 10, 20, 14)))
                g.DrawString(t, fTag, b, box.X + 16, box.Y + 5);
        }
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

    private void DrawCap(Graphics g, PadButton b)
    {
        RectangleF r = b.Rect;
        bool close = b.Key == "close";
        Color fill = Mix(Color.FromArgb(16, 255, 255, 255),
                         close ? Color.FromArgb(190, 220, 70, 70) : Color.FromArgb(40, 255, 255, 255),
                         b.Hover);
        using (SolidBrush br = new SolidBrush(fill))
            g.FillEllipse(br, r);
        using (Pen pen = new Pen(Color.FromArgb((int)(30 + 40 * b.Hover), 255, 255, 255), 1f))
            g.DrawEllipse(pen, r);

        Color ink = close && b.Hover > 0.5f
            ? Color.FromArgb(255, 255, 255)
            : Color.FromArgb((int)(150 + 80 * b.Hover), 235, 242, 248);
        using (Pen pen = new Pen(ink, 1.6f))
        {
            pen.StartCap = LineCap.Round;
            pen.EndCap = LineCap.Round;
            float cx = r.X + r.Width / 2f;
            float cy = r.Y + r.Height / 2f;
            if (b.Key == "min") g.DrawLine(pen, cx - 5, cy, cx + 5, cy);
            else if (b.Key == "max")
            {
                if (WindowState == FormWindowState.Maximized)
                {
                    g.DrawRectangle(pen, cx - 5, cy - 5, 8, 8);
                    g.DrawRectangle(pen, cx - 1, cy - 1, 8, 8);
                }
                else g.DrawRectangle(pen, cx - 5, cy - 5, 10, 10);
            }
            else
            {
                g.DrawLine(pen, cx - 4.5f, cy - 4.5f, cx + 4.5f, cy + 4.5f);
                g.DrawLine(pen, cx + 4.5f, cy - 4.5f, cx - 4.5f, cy + 4.5f);
            }
        }
    }

    private void DrawButton(Graphics g, PadButton b)
    {
        Rectangle r = b.Rect;
        if (b.Press > 0.01f)
        {
            int dx = (int)(r.Width * 0.015f * b.Press);
            int dy = (int)(r.Height * 0.03f * b.Press);
            r = new Rectangle(r.X + dx, r.Y + dy, r.Width - dx * 2, r.Height - dy * 2);
        }

        Color fill, border, text;
        if (b.Kind == 1)
        {
            // 只有"当下能用"的主操作才是绿色，否则会误导
            int a = (int)(200 + 55 * b.Hover);
            fill = Color.FromArgb(a, Mix(Accent, Color.FromArgb(120, 255, 190), b.Hover));
            border = Color.FromArgb(255, 150, 240, 200);
            text = Color.FromArgb(10, 16, 12);
        }
        else if (b.Kind == 2)
        {
            fill = Mix(Color.FromArgb(18, 255, 255, 255), Color.FromArgb(70, 220, 120, 120), b.Hover);
            border = Mix(Color.FromArgb(40, 255, 255, 255), Color.FromArgb(150, 230, 130, 130), b.Hover);
            text = Mix(Color.FromArgb(200, 150, 150), Color.FromArgb(255, 190, 190), b.Hover);
        }
        else
        {
            // 悬停对比拉大，之前 16→34 太细腻，看着像没反应
            fill = Mix(Color.FromArgb(18, 255, 255, 255), Color.FromArgb(52, 255, 255, 255), b.Hover);
            border = Mix(Color.FromArgb(40, 255, 255, 255), Color.FromArgb(120, 255, 255, 255), b.Hover);
            text = Mix(Color.FromArgb(206, 218, 230), Color.FromArgb(255, 255, 255), b.Hover);
        }
        if (!b.Enabled)
        {
            fill = Color.FromArgb(10, 255, 255, 255);
            border = Color.FromArgb(28, 255, 255, 255);
            text = Color.FromArgb(96, 108, 120);
        }

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

    private int HitIndex(Point client)
    {
        PointF lp = ToDesign(client);
        for (int i = 0; i < Caps.Count; i++)
            if (Caps[i].Rect.Contains((int)lp.X, (int)lp.Y)) return 1000 + i;
        for (int i = 0; i < Buttons.Count; i++)
            if (Buttons[i].Rect.Contains((int)lp.X, (int)lp.Y)) return i;
        return -1;
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        PointF lp0 = ToDesign(e.Location);
        int ch = -1;
        for (int i = 0; i < chipRects.Count; i++)
            if (chipRects[i].Contains((int)lp0.X, (int)lp0.Y)) ch = i;
        if (ch != chipHot) { chipHot = ch; frameDirty = true; Invalidate(); }

        int idx = HitIndex(e.Location);
        if (idx != hot) { hot = idx; Cursor = idx >= 0 ? Cursors.Hand : Cursors.Default; }
        base.OnMouseMove(e);
    }

    protected override void OnMouseLeave(EventArgs e) { hot = -1; base.OnMouseLeave(e); }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        down = HitIndex(e.Location);
        base.OnMouseDown(e);
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        int hit = HitIndex(e.Location);
        PointF lpClick = ToDesign(e.Location);
        for (int i = 0; i < chipRects.Count; i++)
        {
            if (chipRects[i].Contains((int)lpClick.X, (int)lpClick.Y))
            {
                try { Clipboard.SetText(chipUrls[i]); } catch { }
                toastAt = DateTime.Now;
                frameDirty = true;
                Invalidate();
                down = -1;
                base.OnMouseUp(e);
                return;
            }
        }

        if (hit >= 0 && hit == down)
        {
            if (hit >= 1000)
            {
                PadButton cap = Caps[hit - 1000];
                if (cap.Key == "min") WindowState = FormWindowState.Minimized;
                else if (cap.Key == "max")
                    WindowState = WindowState == FormWindowState.Maximized
                        ? FormWindowState.Normal : FormWindowState.Maximized;
                else Close();
                Invalidate();
            }
            else
            {
                PadButton b = Buttons[hit];
                if (b.Enabled && OnAction != null) { try { OnAction(b.Key); } catch { } }
            }
        }
        else if (hit < 0)
        {
            PointF lp = ToDesign(e.Location);
            if (!addrRect.IsEmpty && addrRect.Contains((int)lp.X, (int)lp.Y))
            {
                try { if (addrUrl.Length > 0) Clipboard.SetText(addrUrl); } catch { }
                toastAt = DateTime.Now;
                frameDirty = true;
                Invalidate();
            }
        }
        down = -1;
        base.OnMouseUp(e);
    }

    private void SetBackdrop(int kind)
    {
        try
        {
            if (Environment.OSVersion.Version.Build >= 22000)
            {
                int v = kind;
                DwmSetWindowAttribute(Handle, 38, ref v, sizeof(int));
            }
        }
        catch { }
    }

    protected override void WndProc(ref Message m)
    {
        const int WM_NCHITTEST = 0x0084;
        const int WM_ENTERSIZEMOVE = 0x0231;
        const int WM_EXITSIZEMOVE = 0x0232;

        if (m.Msg == WM_ENTERSIZEMOVE)
        {
            SetBackdrop(1);
            dragging = true;
            anim.Stop();
        }
        else if (m.Msg == WM_EXITSIZEMOVE)
        {
            SetBackdrop(2);
            dragging = false;
            anim.Start();
            frameDirty = true;
            Invalidate();
        }
        else if (m.Msg == WM_NCHITTEST)
        {
            int screenX = (short)(m.LParam.ToInt32() & 0xFFFF);
            int screenY = (short)((m.LParam.ToInt32() >> 16) & 0xFFFF);
            Point pt = PointToClient(new Point(screenX, screenY));
            PointF lp = ToDesign(pt);
            bool onCap = false;
            foreach (PadButton c in Caps)
                if (c.Rect.Contains((int)lp.X, (int)lp.Y)) onCap = true;

            if (lp.Y < 70 && !onCap)
            {
                m.Result = (IntPtr)2;
                return;
            }
        }
        base.WndProc(ref m);
    }

    protected override void OnDoubleClick(EventArgs e)
    {
        Point pt = PointToClient(Cursor.Position);
        PointF lp = ToDesign(pt);
        if (lp.Y < 70)
            WindowState = WindowState == FormWindowState.Maximized
                ? FormWindowState.Normal : FormWindowState.Maximized;
        base.OnDoubleClick(e);
    }
}

'@

Add-Type -TypeDefinition $csharp -ReferencedAssemblies System.Windows.Forms, System.Drawing
if ($Compile) { 'compiled ok'; exit 0 }

# 带超时地跑一次 adb：adb 服务器卡死时不会把界面拖住
function Invoke-AdbQuick {
    param([string[]]$AdbArgs, [int]$TimeoutSec = 4)
    $adbExe = Join-Path $here 'tools\platform-tools\adb.exe'
    if (-not (Test-Path $adbExe)) { return }
    $p = Start-Process -FilePath $adbExe -ArgumentList $AdbArgs -WindowStyle Hidden -PassThru -ErrorAction SilentlyContinue
    if (-not $p) { return }
    try { Wait-Process -Id $p.Id -Timeout $TimeoutSec -ErrorAction Stop }
    catch { try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {} }
}

function Get-Key {
    if (Test-Path $keyFile) { return (Get-Content $keyFile -Raw).Trim() }
    return ''
}


[System.Windows.Forms.Application]::EnableVisualStyles()

$ui = New-Object PadCenter
$ui.AppDir = $here
$ui.AddButton('startadmin', '启动（管理员权限）', 20,  334, 290, 38, 1)
$ui.AddButton('stop',       '停止服务',           320, 334, 290, 38, 2)
$ui.AddButton('usb',        'USB 直连（建映射）', 20, 380, 190, 34, 0)
$ui.AddButton('open',       '打开平板页面',     222, 380, 190, 34, 0)
$ui.AddButton('help',       '使用说明',         424, 380, 190, 34, 0)
$ui.AddButton('log',        '打开日志',          20, 420, 190, 34, 0)
$ui.AddButton('refresh',    '刷新状态',         222, 420, 190, 34, 0)
$ui.AddButton('copy',       '复制地址',         424, 420, 190, 34, 0)

# 本程序拉起来的进程（记事本等），停止服务时一起关掉
$script:spawned = @()

function Close-Spawned {
    foreach ($id in @($script:spawned)) {
        try { Stop-Process -Id $id -Force -ErrorAction Stop } catch {}
    }
    $script:spawned = @()
}

$ui.OnAction = [Func[string, bool]]{
    param($key)

    $d = $ui.Last
    switch ($key) {
        'startadmin' {
            if (Test-Path $exe) {
                try { Start-Process -FilePath $exe -WorkingDirectory $here -Verb RunAs }
                catch { [System.Windows.Forms.MessageBox]::Show('提权被取消，服务没起来', 'PadTrack') }
            }
            # 起完顺手补上 USB 映射（接着线的场景就不用再点一次）
            Start-Sleep -Milliseconds 1800
            Invoke-AdbQuick -AdbArgs @('reverse', 'tcp:8765', 'tcp:8765') -TimeoutSec 5
        }
        'stop' {
            if ($d -and $d.Pid -gt 0) {
                & taskkill /f /pid $d.Pid *> $null
                if ($LASTEXITCODE -ne 0) {
                    try { Start-Process -FilePath (Join-Path $here '停止.bat') -Verb RunAs -WorkingDirectory $here } catch {}
                }
            }
            # 先撤销 USB 映射（映射挂在 adb 守护进程里，杀掉就没了，
            # 但显式撤销能让平板端马上释放 127.0.0.1:8765）
            Invoke-AdbQuick -AdbArgs @('reverse', '--remove-all') -TimeoutSec 4
            # 本程序拉起来的 adb 守护进程也关掉，别留后台
            & taskkill /f /im adb.exe *> $null
            Close-Spawned
        }
        'usb' {
            $bat = Join-Path $here 'USB直连.bat'
            if (Test-Path $bat) { Start-Process -FilePath $bat -WorkingDirectory $here }
        }
        'open' {
            $k = Get-Key
            $usb = ($d -and $d.Device -and $d.Reverse)
            $hostPart = if ($usb) { '127.0.0.1' } elseif ($d) { $d.LanIp } else { '127.0.0.1' }
            Start-Process "http://$hostPart`:$port/?k=$k"
        }
        'copy' {
            $usb = ($d -and $d.Device -and $d.Reverse)
            $ip = if ($usb) { '127.0.0.1' } elseif ($d) { $d.LanIp } else { '127.0.0.1' }
            [System.Windows.Forms.Clipboard]::SetText("http://$ip`:$port/?k=$(Get-Key)")
        }
        'help' {
            $f = Join-Path $here '使用说明.txt'
            if (Test-Path $f) {
                $np = Start-Process notepad.exe $f -PassThru
                if ($np) { $script:spawned += $np.Id }
            } else { [System.Windows.Forms.MessageBox]::Show('没找到 使用说明.txt', 'PadTrack') }
        }
        'log' {
            $f = Join-Path $here 'padtrack.log'
            if (Test-Path $f) {
                $np = Start-Process notepad.exe $f -PassThru
                if ($np) { $script:spawned += $np.Id }
            } else { [System.Windows.Forms.MessageBox]::Show('还没生成日志（服务没启动过？）', 'PadTrack') }
        }
        'refresh' { }
    }
    $ui.PokeRefresh()
    return $true
}

if ($Test) {
    $null = $ui.Handle            # 访问 Handle 才会真正建句柄（CreateControl 对未显示的窗体无效）
    $ui.PokeRefresh()
    # BeginInvoke 的回调要靠消息泵执行，这里手动泵最多 8 秒
    $deadline = (Get-Date).AddSeconds(8)
    while (-not $ui.Last -and (Get-Date) -lt $deadline) {
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 80
    }
    $d = $ui.Last
    if ($d) {
        'running: '   + $d.Running
        'pid: '       + $d.Pid
        'new: '       + $d.NewVersion
        'device: '    + $d.Device
        'reverse: '   + $d.Reverse
        'client: '    + $d.LastClient
        'lanip: '     + $d.LanIp
        'logtail 长度: ' + $d.LogTail.Length
    } else { '采集还没返回（1.5 秒）' }
    exit 0
}

$ui.Add_Shown({ $ui.PokeRefresh() })
[void]$ui.ShowDialog()

