# add-lesson.ps1 — 记一条坑（由 dsh-ledger-watch 安装器自动部署）
#
# 用法：
#   & "<账本目录>\tools\add-lesson.ps1" -Title "别在 F: 盘跑 pnpm install" `
#       -Trigger "在 F: 盘装依赖" -Symptom "报 EPERM" -Rule "换到 C: 盘或加 --store-dir"
#
# 只追加，不改写既有条目；ID 按前缀自动取下一个空号。

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [string]$Trigger = '',
  [string]$Symptom = '',
  [string]$Rule = '',
  [string]$Status = '有效',
  [string]$Prefix = 'ENV'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$lessons = Join-Path $root 'lessons'
if (-not (Test-Path -LiteralPath $lessons)) { $null = New-Item -ItemType Directory -Force -Path $lessons }

$idRe = [regex]('^##\s+' + [regex]::Escape($Prefix) + '-(\d{3,})\s')
$maxId = 0
foreach ($file in Get-ChildItem -LiteralPath $lessons -Filter *.md -File) {
  foreach ($line in [System.IO.File]::ReadAllLines($file.FullName)) {
    $m = $idRe.Match($line)
    if ($m.Success) { $n = [int]$m.Groups[1].Value; if ($n -gt $maxId) { $maxId = $n } }
  }
}

$next = '{0}-{1:D3}' -f $Prefix, ($maxId + 1)
$target = Join-Path $lessons 'auto.md'
$utf8 = New-Object System.Text.UTF8Encoding($false)

$block = @()

$block += ''
$block += ('## ' + $next + ' ' + $Title.Trim())
$block += ''
if ($Trigger) { $block += ('- **触发场景**：' + $Trigger.Trim()) }
if ($Symptom) { $block += ('- **症状**：' + $Symptom.Trim()) }
if ($Rule)    { $block += ('- **规则**：' + $Rule.Trim()) }
$block += ('- **状态**：' + $Status.Trim())

$existing = ''
if (Test-Path -LiteralPath $target) { $existing = [System.IO.File]::ReadAllText($target) }
[System.IO.File]::WriteAllText($target, ($existing.TrimEnd() + "`r`n" + ($block -join "`r`n") + "`r`n"), $utf8)

Write-Output ('已记入账本：' + $next + ' ' + $Title.Trim())
Write-Output ('文件：' + $target)
