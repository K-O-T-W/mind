#Requires -Version 5.1
<#
  Mind · Windows 双击入口
  --------------------------------------------------------------------
  现在统一由 Toolset 的 server 提供页面和静态文件；这个脚本只负责确保
  Toolset 在跑，然后打开 /tools/mind/。

  -Port 保留是为了兼容旧快捷方式；端口由 Toolset 统一管理（默认 8770）。
#>
param(
    [switch]$NoOpen,
    [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$Toolset = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Server = Join-Path $Toolset 'server.py'

function Pause-Close {
    try {
        if (-not [Console]::IsInputRedirected) { Read-Host "  按 Enter 关闭" | Out-Null }
    } catch { }
}

if (-not (Test-Path -LiteralPath $Server)) {
    Write-Host ""
    Write-Host "  找不到 Toolset 服务：$Server" -ForegroundColor Red
    Write-Host "  Mind 已经整合进 Toolset，请确认 Documents\Toolset 还在。" -ForegroundColor Yellow
    Write-Host ""
    Pause-Close
    exit 1
}

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

$py = Find-Python
if (-not $py) {
    Write-Host ""
    Write-Host "  找不到 Python 3.10+。" -ForegroundColor Red
    Write-Host "  安装时勾选 Add to PATH，装完再双击一次。" -ForegroundColor Yellow
    Write-Host ""
    Pause-Close
    exit 1
}

$argsList = @($Server, '--open-tool', 'mind')
if ($NoOpen) { $argsList += '--no-open' }
& $py @argsList
