<#
    停止并卸载 CloudStorage 服务（管理员 PowerShell）。

    用法：
        powershell -ExecutionPolicy Bypass -File .\uninstall_service.ps1
        powershell -ExecutionPolicy Bypass -File .\uninstall_service.ps1 -KeepFirewall
#>
param(
    [switch]$KeepFirewall
)

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$serviceName = 'CloudStorage'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '需要管理员权限：请右键「以管理员身份运行」PowerShell 后再执行本脚本。'
}

$py = Join-Path $dir '.venv\Scripts\python.exe'
if (Test-Path $py) {
    Push-Location $dir
    try {
        Write-Host "停止服务 $serviceName ..."
        & $py (Join-Path $dir 'service.py') stop 2>$null | Out-Null
        Start-Sleep -Seconds 2
        Write-Host "移除服务 $serviceName ..."
        & $py (Join-Path $dir 'service.py') remove 2>$null | Out-Null
    }
    finally {
        Pop-Location
    }
} else {
    Write-Host '找不到 .venv，改用 sc.exe 删除服务'
    sc.exe stop $serviceName 2>$null | Out-Null
    sc.exe delete $serviceName 2>$null | Out-Null
}

if (-not $KeepFirewall) {
    Get-NetFirewallRule -DisplayName 'CloudStorage*' -ErrorAction SilentlyContinue |
        Remove-NetFirewallRule -ErrorAction SilentlyContinue
    Write-Host '已移除 CloudStorage 防火墙规则'
}

Write-Host '卸载完成（文件与数据库都保留）。'
