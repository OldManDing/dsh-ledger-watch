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
  [string]$Prefix = 'ENV',
  # 可选：可机检的触发条件，让插件能在下次踩同一个坑时当场提醒。
  # 语法：tool=工具名; path=路径通配; command=命令子串（command 放最后，允许空格）
  # 例：-Detect 'tool=write; path=*.ps1'    -Detect 'tool=pwsh; command=docker_data'
  [string]$Detect = ''
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
if ($Detect) {
  # 写入前自校验：语法错就让作者当场知道，而不是留一条永不命中的检测段
  $d = $Detect.Trim()
  $ok = $true; $why = ''
  foreach ($part in ($d -split ';')) {
    $part = $part.Trim()
    if ($part.Length -eq 0) { continue }
    $eq = $part.IndexOf('=')
    if ($eq -lt 0) { $ok = $false; $why = "缺少 '='：$part"; break }
    $key = $part.Substring(0, $eq).Trim().ToLower()
    $val = $part.Substring($eq + 1).Trim()
    if ($val.Length -eq 0) { $ok = $false; $why = "空值：$key"; break }
    if ($key -eq 'tool' -or $key -eq 'path') {
      if ($val -match '\s') { $ok = $false; $why = "$key 里有空格（多个子句要用分号隔开）：$val"; break }
    } elseif ($key -ne 'command') {
      $ok = $false; $why = "未知键：$key（只支持 tool / path / command）"; break
    }
  }
  if (-not $ok) {
    Write-Output ('检测段语法错误：' + $why)
    Write-Output '正确写法：-Detect "tool=write; path=*.ps1"  或  -Detect "tool=pwsh; command=docker_data"'
    Write-Output '（本次未写入任何内容，修正后重跑）'
    exit 1
  }
  $block += ('- **检测**：' + $d)
}
$block += ('- **状态**：' + $Status.Trim())

$existing = ''
if (Test-Path -LiteralPath $target) { $existing = [System.IO.File]::ReadAllText($target) }
[System.IO.File]::WriteAllText($target, ($existing.TrimEnd() + "`r`n" + ($block -join "`r`n") + "`r`n"), $utf8)

Write-Output ('已记入账本：' + $next + ' ' + $Title.Trim())
Write-Output ('文件：' + $target)
