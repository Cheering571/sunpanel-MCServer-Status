# Minecraft 状态桥接服务 —— Windows 启动脚本
#
# 用法：双击运行，或在该目录执行 powershell -ExecutionPolicy Bypass -File start.ps1
#
# 前提：已安装 Python 3（https://www.python.org/downloads/）
# 首次运行会在当前目录生成 start-hide.vbs，双击它即可后台运行不显示窗口。

param(
    [int]$Port = 8848
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Definition
$py = Join-Path $here 'bridge.py'

if (-not (Test-Path $py)) {
    Write-Host "找不到 bridge.py" -ForegroundColor Red
    exit 1
}

# 找 python
$python = $null
foreach ($cand in @('python', 'python3', 'py')) {
    $cmd = Get-Command $cand -ErrorAction SilentlyContinue
    if ($cmd) { $python = $cmd.Source; break }
}
if (-not $python) {
    Write-Host "未找到 Python，请先安装：https://www.python.org/downloads/" -ForegroundColor Red
    exit 1
}

# 生成一个后台启动器，避免每次开个黑窗口
$vbsPath = Join-Path $here 'start-hide.vbs'
if (-not (Test-Path $vbsPath)) {
    $content = @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """$python"" ""$py"" --host 0.0.0.0 --port $Port", 0, False
"@
    Set-Content -Path $vbsPath -Value $content -Encoding ASCII
    Write-Host "已生成 start-hide.vbs（双击可后台运行）" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "启动桥接服务：http://0.0.0.0:$Port" -ForegroundColor Cyan
Write-Host "微应用配置页的「服务地址」填：" -ForegroundColor Cyan
Write-Host "  http://<本机局域网IP>:$Port"
Write-Host ""
Write-Host "自检：curl http://127.0.0.1:$Port/health"
Write-Host "按 Ctrl+C 停止"
Write-Host ""

& $python $py --host 0.0.0.0 --port $Port
