<#
    把 CloudStorage 安装成 Windows 服务（开机自启、静默运行）。

    用法（必须「以管理员身份运行」PowerShell）：
        powershell -ExecutionPolicy Bypass -File .\install_service.ps1
        powershell -ExecutionPolicy Bypass -File .\install_service.ps1 -NoFirewall

    脚本会做：
      1. 检查管理员权限、检查项目是否在本机磁盘（服务不能跑在网络共享上）
      2. 检查端口不是被运营商封锁的 80/443
      3. 准备 .venv 并安装 requirements.txt
      4. 注册服务、设置失败自动重启、开机（延迟）自启并启动
      5. 放行防火墙入站端口（仅 域/专用 网络）
#>
param(
    [int]$Port = 0,
    [switch]$NoFirewall
)

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$serviceName = 'CloudStorage'

function Assert-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw '需要管理员权限：请右键「以管理员身份运行」PowerShell 后再执行本脚本。'
    }
}

Assert-Admin

if ($dir -like '\\*') {
    throw "项目位于网络路径：$dir`nWindows 服务无法从网络共享启动，请把整个项目复制到本机磁盘（例如 C:\CloudStorage）后再安装。"
}

$configPath = Join-Path $dir 'config.ini'
if ($Port -le 0) {
    $m = Select-String -Path $configPath -Pattern '^\s*port\s*=\s*(\d+)' | Select-Object -First 1
    $Port = if ($m) { [int]$m.Matches[0].Groups[1].Value } else { 5000 }
}
if ($Port -eq 80 -or $Port -eq 443) {
    throw "端口 $Port 会被运营商封锁，请先把 config.ini 的 [SERVER] port 改成 5000 / 8080 / 8443 等端口。"
}

# ---------------------------------------------------------------- 准备 Python 环境
$venv = Join-Path $dir '.venv'
$py = Join-Path $venv 'Scripts\python.exe'
$venvOk = $false
if (Test-Path $py) {
    try {
        & $py -c "import sys" 2>$null
        $venvOk = ($LASTEXITCODE -eq 0)
    } catch { $venvOk = $false }
}

if (-not $venvOk) {
    Write-Host "虚拟环境不可用，正在重建：$venv"
    if (Test-Path $venv) { Remove-Item $venv -Recurse -Force }
    $base = & py -3.13 -c "import sys;print(sys.executable)"
    if (-not $base -or -not (Test-Path $base)) {
        throw '找不到可用的 Python 3.13，请先安装 Python 并确保 py -3.13 可用。'
    }
    & $base -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw '创建虚拟环境失败' }
}

Write-Host "安装依赖..."
& $py -m pip install --upgrade pip --quiet
& $py -m pip install -r (Join-Path $dir 'requirements.txt') --quiet
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，请检查网络或代理设置' }

# ---------------------------------------------------------------- 注册并启动服务
Push-Location $dir
try {
    # 已存在时先移除，保证配置是新的
    & $py (Join-Path $dir 'service.py') stop 2>$null | Out-Null
    & $py (Join-Path $dir 'service.py') remove 2>$null | Out-Null

    Write-Host "注册服务 $serviceName ..."
    & $py (Join-Path $dir 'service.py') --startup auto install
    if ($LASTEXITCODE -ne 0) { throw "服务注册失败（exit $LASTEXITCODE）" }

    # 崩溃自动重启：5s / 10s / 30s，一天后重置计数
    sc.exe failure $serviceName reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
    # 开机延迟自启，避免和系统盘/网络初始化抢时间
    sc.exe config $serviceName start= delayed-auto | Out-Null

    Write-Host "启动服务 ..."
    # pywin32 的 start 命令即使失败也返回 0，必须自己轮询服务状态
    & $py (Join-Path $dir 'service.py') start 2>$null | Out-Null
    $svc = $null
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Seconds 1
        $svc = Get-Service $serviceName -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -eq 'Running') { break }
        if ($svc -and $svc.Status -eq 'Stopped' -and $i -ge 4) { break }
    }
    if (-not $svc -or $svc.Status -ne 'Running') {
        $state = if ($svc) { $svc.Status } else { '不存在' }
        throw "服务未能启动（当前状态：$state）。请查看 logs\cloudstorage.log 和系统事件日志（来源 Service Control Manager）后重试。"
    }
    Write-Host "服务已启动（$($svc.Status)）"
}
finally {
    Pop-Location
}

# ---------------------------------------------------------------- 防火墙
if (-not $NoFirewall) {
    $ruleName = "CloudStorage ($Port/TCP)"
    Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort $Port -Profile Domain,Private | Out-Null
    Write-Host "已放行防火墙入站 TCP $Port（仅域/专用网络）"
}

Write-Host ''
Write-Host '安装完成。'
Write-Host "  服务名 : $serviceName"
Write-Host "  地址   : http://<本机IP>:$Port"
Write-Host "  日志   : $(Join-Path $dir 'logs\cloudstorage.log')"
Write-Host "  状态   : Get-Service $serviceName"
Write-Host '  卸载   : powershell -ExecutionPolicy Bypass -File .\uninstall_service.ps1'
