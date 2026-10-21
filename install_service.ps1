<#
    把 CloudStorage 安装成 Windows 服务（开机自启、静默运行）。

    用法：
        # 一条命令搞定（自动绕过执行策略）
        .\install_service.cmd

        # 或者手动跑
        powershell -ExecutionPolicy Bypass -File .\install_service.ps1

        # 只准备环境（配置文件 / .venv / 依赖），不注册服务，不需要管理员
        powershell -ExecutionPolicy Bypass -File .\install_service.ps1 -PrepareOnly

    脚本会做：
      1. 检查项目是否在本机磁盘（服务不能跑在网络共享上）
      2. 没有 config.ini 时从 config.example.ini 生成，并提示设置管理员初始密码
      3. 检查端口不是被运营商封锁的 80/443
      4. 准备 .venv 并安装 requirements.txt
      5. 检查管理员权限后注册服务、设置失败自动重启、开机（延迟）自启并启动
      6. 放行防火墙入站端口（仅 域/专用 网络）
#>
param(
    [int]$Port = 0,
    [switch]$NoFirewall,
    [switch]$PrepareOnly,
    [string]$AdminPassword = ''
)

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$serviceName = 'CloudStorage'

function Assert-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw '需要管理员权限：请右键「以管理员身份运行」PowerShell 后再执行本脚本（或直接运行 install_service.cmd）。'
    }
}

function Set-ConfigValue {
    param($Path, $Section, $Key, $Value)
    $lines = [IO.File]::ReadAllLines($Path, [Text.Encoding]::UTF8)
    $inSection = $false
    $done = $false
    $sectionIndex = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $s = $lines[$i].Trim()
        if ($s.StartsWith('[') -and $s.EndsWith(']')) {
            $inSection = ($s.Trim('[', ']') -ieq $Section)
            if ($inSection) { $sectionIndex = $i }
            continue
        }
        if ($inSection -and $s -match "^\s*$([regex]::Escape($Key))\s*=") {
            $lines[$i] = "$Key = $Value"
            $done = $true
            break
        }
    }
    if (-not $done) {
        if ($sectionIndex -ge 0) {
            $lines = $lines[0..$sectionIndex] + @("$Key = $Value") + $lines[($sectionIndex + 1)..($lines.Count - 1)]
        } else {
            $lines += @('', "[$Section]", "$Key = $Value")
        }
    }
    [IO.File]::WriteAllLines($Path, $lines, (New-Object Text.UTF8Encoding($false)))
}

# ---------------------------------------------------------------- 1. 位置检查
if ($dir -like '\\*') {
    throw "项目位于网络路径：$dir`nWindows 服务无法从网络共享启动，请把整个项目复制到本机磁盘（例如 C:\CloudStorage）后再安装。"
}

# ---------------------------------------------------------------- 2. 配置文件
function Invoke-Native {
    # 运行外部命令并只返回退出码。
    # 注意：输出必须走 Write-Host，不能留在管道里，否则会和 return 的整数一起
    # 变成数组（调用方 $exit -ne 0 永远为真）。
    param([string]$Exe, [string[]]$Arguments, [switch]$PassThru)

    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = @(& $Exe @Arguments 2>&1)
        $code = $LASTEXITCODE
        if ($PassThru) {
            $output | ForEach-Object { Write-Host $_ }
        }
        return [int]$code
    }
    finally {
        $ErrorActionPreference = $prev
    }
}

$configPath = Join-Path $dir 'config.ini'
$examplePath = Join-Path $dir 'config.example.ini'

if (-not (Test-Path $configPath)) {
    if (-not (Test-Path $examplePath)) {
        throw "缺少 config.ini，且找不到 config.example.ini，无法生成配置。"
    }
    Copy-Item $examplePath $configPath
    Write-Host "未找到 config.ini，已从 config.example.ini 生成一份。"
}

# 端口
if ($Port -le 0) {
    $m = Select-String -Path $configPath -Pattern '^\s*port\s*=\s*(\d+)' | Select-Object -First 1
    $Port = if ($m) { [int]$m.Matches[0].Groups[1].Value } else { 5000 }
}
if ($Port -eq 80 -or $Port -eq 443) {
    throw "端口 $Port 会被运营商封锁，请先把 config.ini 的 [SERVER] port 改成 5000 / 8080 / 8443 等端口。"
}

# 首次运行改为网页初始化向导（/setup），这里不再询问管理员密码
if ($AdminPassword) {
    Write-Host "提示：管理员账号现在在网页 /setup 向导里创建，-AdminPassword 参数已不再需要。" -ForegroundColor Yellow
}

# ---------------------------------------------------------------- 3. Python 环境
$MinPython = [version]'3.9'

function Find-Python {
    # 依次尝试 py -3.13 / -3.12 / ... / -3，再退回 PATH 里的 python / python3
    $candidates = @()
    $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
    if ($pyLauncher) {
        foreach ($v in @('-3.14', '-3.13', '-3.12', '-3.11', '-3.10', '-3.9', '-3')) {
            $candidates += , @('py', $v)
        }
    }
    $candidates += , @('python')
    $candidates += , @('python3')

    foreach ($c in $candidates) {
        $exeName = $c[0]
        # 注意：$c 只有一个元素时不能写 $c[1..($c.Count-1)]，1..0 会反向取到第 0 个
        $exeArgs = @()
        if ($c.Count -gt 1) { $exeArgs = @($c[1..($c.Count - 1)]) }

        $cmd = Get-Command $exeName -ErrorAction SilentlyContinue
        if (-not $cmd) { continue }

        # 传给原生 exe 的代码里不要有双引号：PowerShell 5.1 会把内嵌引号吃掉，
        # python 收到残缺的 -c 参数就会报 SyntaxError。
        $probeCode = "import sys;print('%d.%d' % sys.version_info[:2]);print(sys.executable)"
        $probe = @($exeArgs) + @('-c', $probeCode)

        # 探测失败时 Python 会往 stderr 写东西，$ErrorActionPreference = 'Stop' 会把它变成
        # 终止性错误，所以这里临时降级并自己看退出码。
        $out = @()
        $ok = $false
        $prevEap = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $out = @(& $cmd.Source @probe 2>$null)
            $ok = ($LASTEXITCODE -eq 0)
        }
        catch {
            $ok = $false
        }
        finally {
            $ErrorActionPreference = $prevEap
        }

        if (-not $ok -or $out.Count -lt 2) { continue }

        $ver = $null
        try { $ver = [version]($out[0].ToString().Trim()) } catch { continue }
        if ($ver -lt $MinPython) { continue }

        $exePath = $out[1].ToString().Trim()
        if (-not (Test-Path $exePath)) { continue }
        return [pscustomobject]@{ Version = $ver; Path = $exePath; How = (($exeArgs + $exeName) -join ' ') }
    }
    return $null
}

$venv = Join-Path $dir '.venv'
$py = Join-Path $venv 'Scripts\python.exe'
$venvOk = $false
if (Test-Path $py) {
    $prevEap = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $out = @(& $py -c "import sys;print('%d.%d' % sys.version_info[:2])" 2>$null)
        $venvOk = ($LASTEXITCODE -eq 0 -and $out.Count -ge 1 -and ([version]$out[0].ToString().Trim()) -ge $MinPython)
    }
    catch { $venvOk = $false }
    finally { $ErrorActionPreference = $prevEap }
}

if (-not $venvOk) {
    $found = Find-Python
    if (-not $found) {
        throw "找不到可用的 Python（需要 $MinPython 或更高版本）。`n请安装 Python 3.11+，安装时勾选「Add python.exe to PATH」，或确保 py 启动器可用。"
    }
    Write-Host "使用 Python $($found.Version)：$($found.Path)"

    if (Test-Path $venv) {
        Write-Host "虚拟环境不可用，正在重建：$venv"
        Remove-Item $venv -Recurse -Force
    }
    & $found.Path -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw '创建虚拟环境失败。' }
    & $py -c "import sys;print('venv Python', sys.version.split()[0])"
}
else {
    $venvVer = & $py -c "import sys;print('%d.%d' % sys.version_info[:2])"
    Write-Host "复用已有虚拟环境（Python $venvVer）：$venv"
}

Write-Host '安装依赖...'
# pip 会往 stderr 写进度/警告，$ErrorActionPreference='Stop' 下会被当成终止性错误，这里临时降级
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $py -m pip install --upgrade pip --quiet 2>&1 | Out-Null
$pipOut = @(& $py -m pip install -r (Join-Path $dir 'requirements.txt') --quiet 2>&1)
$pipExit = $LASTEXITCODE
$ErrorActionPreference = $prevEap
if ($pipExit -ne 0) {
    $pipOut | Select-Object -Last 15 | ForEach-Object { Write-Host $_ }
    throw '依赖安装失败，请检查网络或代理设置（可尝试设置 pip 镜像源）。'
}

if ($PrepareOnly) {
    Write-Host ''
    Write-Host "环境准备完成（未注册服务）。"
    Write-Host "  配置 : $configPath"
    Write-Host "  解释器: $py"
    Write-Host ''
    Write-Host "先试运行： & '$py' '$dir\service.py' --foreground"
    Write-Host "确认没问题后，用管理员 PowerShell 重新执行本脚本即可安装服务。"
    return
}

# ---------------------------------------------------------------- 4. 注册服务
Assert-Admin

Push-Location $dir
try {
    # 已存在时先移除，保证配置是新的。
    # 这些调用会把提示写到 stderr，用 Invoke-Native 避免被 EAP=Stop 当成异常。
    $null = Invoke-Native $py @((Join-Path $dir 'service.py'), 'stop')
    $null = Invoke-Native $py @((Join-Path $dir 'service.py'), 'remove')

    Write-Host "注册服务 $serviceName ..."
    $installExit = Invoke-Native $py @((Join-Path $dir 'service.py'), '--startup', 'auto', 'install') -PassThru
    # pywin32 有时失败也返回 0，这里再确认服务真的出现在 SCM 里
    $registered = Get-Service $serviceName -ErrorAction SilentlyContinue
    if ($installExit -ne 0 -or -not $registered) {
        throw "服务注册失败（exit=$installExit，服务是否存在=$([bool]$registered)）。请确认是以管理员身份运行，然后重试。"
    }
    Write-Host "服务已注册：$serviceName"

    # 崩溃自动重启：5s / 10s / 30s，一天后重置计数
    $null = Invoke-Native 'sc.exe' @('failure', $serviceName, 'reset=', '86400',
        'actions=', 'restart/5000/restart/10000/restart/30000')
    # 开机延迟自启，避免和系统盘/网络初始化抢时间
    $null = Invoke-Native 'sc.exe' @('config', $serviceName, 'start=', 'delayed-auto')

    Write-Host '启动服务 ...'
    # pywin32 的 start 命令即使失败也返回 0，必须自己轮询服务状态
    $null = Invoke-Native $py @((Join-Path $dir 'service.py'), 'start')
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

# ---------------------------------------------------------------- 5. 防火墙
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
Write-Host '  卸载   : .\uninstall_service.cmd'
