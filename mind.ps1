#Requires -Version 5.1
<#
  产品定义 · 双击启动
  --------------------------------------------------------------------
  起一个只监听 127.0.0.1 的静态服务，再用浏览器打开。

  为什么不起 index.html 而是起服务：file:// 下浏览器不给文件系统权限，
  保存会退化成下载一份副本；走 http://127.0.0.1 才是安全上下文，Ctrl+S
  能原地写回磁盘上的 .md。

  这个窗口就是开关：关掉它，服务就停了。端口默认 8765，被占了会直接说。
#>
param(
    [switch]$NoOpen,          # 只起服务，不弹浏览器（自测用）
    [int]$Port = 8765
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # 探测端口时别闪进度条
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$Url  = "http://127.0.0.1:$Port/"
$Root = $PSScriptRoot
# 只认 ASCII 记号：http.server 不给 charset，PowerShell 解出来的中文可能是乱码
$Tag  = 'id="reviewChip"'

try { $Host.UI.RawUI.WindowTitle = "产品定义 · $Url" } catch { }

function Test-Mind {
    # 认页面而不是只认端口：8765 上蹲着别的程序时不能当成自己。
    # 只在前一步确认"有人在听"之后才调它——空连是这里最贵的一步。
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
        return ($r.StatusCode -eq 200 -and $r.Content -match $Tag)
    } catch {
        return $false
    }
}

# 端口上有没有人在听。
# 注意：Windows 上同步连一个没人监听的本地端口，可能要等满 2 秒才返回（SYN 被丢，
# 没有 RST）。同步的 Connect 会把启动拖成好几秒，所以这里是"最多等 waitMs 就放弃"。
function Test-Listen([int]$p, [int]$waitMs = 40) {
    $c = New-Object Net.Sockets.TcpClient
    try {
        $ar = $c.BeginConnect('127.0.0.1', $p, $null, $null)
        if (-not $ar.AsyncWaitHandle.WaitOne($waitMs)) { return $false }
        return $c.Connected
    } catch {
        return $false
    } finally {
        $c.Close()
    }
}

function Say($text, $color = 'Gray') {
    Write-Host "  $text" -ForegroundColor $color
}

# 双击时窗口不关，让人看清出了什么事；被脚本调用时不留住
function Pause-Close {
    try {
        if (-not [Console]::IsInputRedirected) { Read-Host "  按 Enter 关闭" | Out-Null }
    } catch { }
}

if (Test-Listen $Port) {
    if (Test-Mind) {
        Say ""
        Say "已经在跑了：$Url" 'Green'
        Say "直接切到浏览器就行，不用再开一个。"
        Say ""
        if (-not $NoOpen) { Start-Process $Url }
        Start-Sleep -Milliseconds 800
        exit 0
    }
    Say ""
    Say "$Port 上有别的东西，不是这个工具。" 'Yellow'
    Say "要么关掉它，要么换个端口：产品定义.cmd -Port 8766"
    Say ""
    Pause-Close
    exit 1
}

# ---------------------------------------------------------------- 找 Python

# 要找的是真正的 python.exe，不是 py.exe 启动器：
# 启动器会自己再拉一个进程，等它、关它、收它的日志都会错位。
function Find-Python {
    $candidates = @()
    if (Get-Command py -ErrorAction SilentlyContinue) {
        $out = & py -3 -c "import sys;print(sys.executable)" 2>$null
        if ($LASTEXITCODE -eq 0 -and $out) { $candidates += $out.Trim() }
    }
    if (Get-Command python -ErrorAction SilentlyContinue) {
        $out = & python -c "import sys;print(sys.executable)" 2>$null
        if ($LASTEXITCODE -eq 0 -and $out) { $candidates += $out.Trim() }
    }
    foreach ($path in $candidates) {
        if ($path -and (Test-Path -LiteralPath $path -PathType Leaf)) { return $path }
    }
    return $null
}

$pyExe = Find-Python
if (-not $pyExe) {
    Say ""
    Say "找不到 Python。" 'Red'
    Say "这个服务用同目录下的 server.py（标准库 http.server 加一个 DELETE），装一个 Python 3.x 就行（装的时候勾上 Add to PATH）。"
    Say ""
    Pause-Close
    exit 1
}

# ---------------------------------------------------------------- 起服务

# 日志按端口和进程分开：同一个端口再开一个也不会把正在跑的那份日志截掉
$logOut = Join-Path $env:TEMP "mind-server-$Port-$PID.out.log"
$logErr = Join-Path $env:TEMP "mind-server-$Port-$PID.err.log"
# server.py = http.server + 一个 DELETE：页面审批完的提案能从 proposals/ 里自己清掉，
# 不然只能靠浏览器 localStorage 记「已处理」，换浏览器就会把生效过的提案再弹一遍。
$serverArgs = @((Join-Path $Root 'server.py'), "$Port", '--bind', '127.0.0.1', '--directory', $Root)

$proc = $null
try {
    $proc = Start-Process -FilePath $pyExe -ArgumentList $serverArgs -NoNewWindow -PassThru `
        -RedirectStandardOutput $logOut -RedirectStandardError $logErr
} catch {
    Say ""
    Say "起不来服务：$($_.Exception.Message)" 'Red'
    Say ""
    Pause-Close
    exit 1
}

$ready = $false
for ($i = 0; $i -lt 90; $i++) {
    if ($proc.HasExited) { break }
    if (Test-Listen $Port) {
        # 有人听了，再确认是不是它（顺便把"别的程序抢了端口"挡掉）
        for ($k = 0; $k -lt 10; $k++) {
            if (Test-Mind) { $ready = $true; break }
            Start-Sleep -Milliseconds 60
        }
        break
    }
    Start-Sleep -Milliseconds 25
}

if (-not $ready) {
    Say ""
    Say "没起来。" 'Red'
    if (Test-Path $logErr) {
        Get-Content $logErr -Tail 6 -ErrorAction SilentlyContinue | ForEach-Object { Say "  $_" 'DarkGray' }
    }
    $busy = (Test-Path $logErr) -and ((Get-Content $logErr -Raw -ErrorAction SilentlyContinue) -match 'Only one usage|10048')
    if ($busy) { Say "端口 $Port 被别的程序占着，关掉它再双击一次。" 'Yellow' }
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Say ""
    Pause-Close
    exit 1
}

# ---------------------------------------------------------------- 开浏览器

Say ""
Say "产品定义" 'White'
Say $Url 'Cyan'
Say ""
Say "文件  $Root"
Say "这个窗口就是开关：关掉它（或按 Ctrl+C）服务就停。"
Say ""
if (-not $NoOpen) { Start-Process $Url }

try {
    Wait-Process -Id $proc.Id -ErrorAction Stop
} catch {
    # 进程早就没了，不用等
} finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}
