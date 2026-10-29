# publish.ps1 — 发布 dsh-ledger-watch 到 npm（验证码交互输入，不进命令历史）
#
# 背景：npm 从 2025-11 起只剩 Granular token，而发布强制 2FA。token 的 Bypass 2FA
# 默认关闭，所以在不改账号设置的前提下，最省事的方式是每次发布现给一个 6 位码。
#
# 用法：
#   .\publish.ps1                    # 交互：先输 token（可留空用本机登录态），再输 6 位码
#   $env:NPM_TOKEN='npm_xxx'; .\publish.ps1
#   .\publish.ps1 -DryRun            # 只检查，不发布

[CmdletBinding()]
param(
  [string]$Otp = '',
  [string]$Token = $env:NPM_TOKEN,
  [switch]$DryRun
)

$pkg = Get-Content (Join-Path $PSScriptRoot 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json
$name = $pkg.name
$version = $pkg.version
Write-Host "包：$name@$version" -ForegroundColor Cyan

function Get-RegistryPackage([string]$pkgName) {
  try {
    $r = Invoke-WebRequest -Uri "https://registry.npmjs.org/$pkgName" -UseBasicParsing -TimeoutSec 20 -ErrorAction Stop
    return ($r.Content | ConvertFrom-Json)
  } catch {
    return $null
  }
}

$existing = Get-RegistryPackage $name
if ($existing -ne $null -and ($existing.versions.PSObject.Properties.Name -contains $version)) {
  Write-Host "registry 上已经有 $name@$version，先改 package.json 的 version 再发。" -ForegroundColor Yellow
  exit 3
}
if ($existing -eq $null) { Write-Host "registry 上没有 $name，本次为首发。" -ForegroundColor Gray }

if ($DryRun) { Write-Host 'DryRun：检查通过，未发布。' -ForegroundColor Yellow; exit 0 }

if ([string]::IsNullOrWhiteSpace($Token)) {
  $secure = Read-Host -AsSecureString 'npm token（输入不显示；直接回车=% 用本机已登录账号）'
  if ($secure.Length -gt 0) {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $Token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  }
}

if ([string]::IsNullOrWhiteSpace($Otp)) {
  $Otp = Read-Host '6 位验证码（账号没开 2FA 就直接回车）'
}

$npmArgs = @('publish', '--access', 'public')
if (-not [string]::IsNullOrWhiteSpace($Token)) { $npmArgs += "--//registry.npmjs.org/:_authToken=$Token" }
if (-not [string]::IsNullOrWhiteSpace($Otp)) { $npmArgs += "--otp=$Otp" }

Write-Host '正在发布…' -ForegroundColor Cyan
$out = & npm @npmArgs 2>&1
$code = $LASTEXITCODE
$out | Select-Object -Last 10 | ForEach-Object { $_.ToString() }

if ($code -ne 0) {
  Write-Host "发布失败（exit=$code）。若报错仍是 bypass 2FA，说明验证码已过期，重跑一次即可。" -ForegroundColor Red
  exit $code
}

Start-Sleep -Seconds 3
$after = Get-RegistryPackage $name
if ($after -ne $null -and ($after.versions.PSObject.Properties.Name -contains $version)) {
  Write-Host "已发布：$name@$version" -ForegroundColor Green
  Write-Host "安装：dsh plugin --profile web add $name" -ForegroundColor Gray
} else {
  Write-Host "发布命令成功，但 registry 暂时读不到 $version（CDN 同步中，稍后自查）。" -ForegroundColor Yellow
}
