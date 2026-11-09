# 在桌面创建 PadTrack 控制中心快捷方式（图标取自 exe 内嵌，桌面在 C: 盘显示正常）
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $here 'PadTrack.exe'

if (-not (Test-Path $exe)) {
    [System.Windows.Forms.MessageBox]::Show("找不到 PadTrack.exe", 'PadTrack') | Out-Null
    exit 1
}

$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'PadTrack 控制中心.lnk'

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = $exe
$sc.Arguments = '--center'
$sc.WorkingDirectory = $here
$sc.IconLocation = "$exe,0"
$sc.Description = 'PadTrack 控制中心'
$sc.Save()

Write-Host ''
Write-Host '已创建桌面快捷方式：'
Write-Host "  $lnk"
Write-Host ''
