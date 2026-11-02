# closing.ps1 — 收尾自报（由 dsh-ledger-watch 安装器部署）
#
# 用法：& "<账本目录>\tools\closing.ps1"
#
# 为什么叫 closing 而不是 report：插件按脚本名判「这次算不算查过账本」，
# 收尾自报是**维护动作**、不是开工查询。用独立名字，它就不会污染指示灯
# （原来 report.ps1 被归为 query，只做收尾的会话也会显示「查过账本」——假阳性）。

[CmdletBinding()]
param(
  [string]$Done = '',
  [string]$Todo = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$lessons = Join-Path $root 'lessons'

$entryRe = [regex]'^##\s+((?:ENV|DSH|DATA|PRC|WS-[A-Z0-9]+)-\d{3,})\s+(.+)$'
$count = 0
$relapse = 0
$revised = 0
$files = 0

if (Test-Path -LiteralPath $lessons) {
  foreach ($file in Get-ChildItem -LiteralPath $lessons -Filter *.md -File) {
    if ($file.Name.StartsWith('_')) { continue }
    $files++
    foreach ($line in [System.IO.File]::ReadAllLines($file.FullName)) {
      if ($entryRe.IsMatch($line)) { $count++; continue }
      if ($line.IndexOf('复发记录') -ge 0) { $relapse++; continue }
      if ($line.IndexOf('修订记录') -ge 0) { $revised++ }
    }
  }
}

$evidence = Join-Path $root '.watch.json'
$session = '未知'
if ($env:DSH_SESSION_ID) { $session = $env:DSH_SESSION_ID }
elseif (Test-Path -LiteralPath $evidence) {
  try {
    $j = Get-Content -LiteralPath $evidence -Raw -Encoding utf8 | ConvertFrom-Json
    if ($j.sessionId) { $session = [string]$j.sessionId }
  } catch { $session = '读取失败' }
}

Write-Output '=== 收尾自报 ==='
Write-Output ("账本    ：{0} 条 · {1} 个文件 · 复发 {2} · 已修订 {3}" -f $count, $files, $relapse, $revised)
Write-Output ("会话    ：{0}" -f $session)
if (Test-Path -LiteralPath $evidence) {
  try {
    $j = Get-Content -LiteralPath $evidence -Raw -Encoding utf8 | ConvertFrom-Json
    $key = if ($session -like 'session-*') { $session.Substring(8) } else { $session }
    $rec = $j.sessions | Where-Object { $_.id -like ('*' + $key + '*') } | Select-Object -First 1
    if ($rec) {
      Write-Output ("本会话  ：查询 {0} 次 · 记录 {1} 次 · 工具调用 {2} 次 · 结论 {3}" -f $rec.queries, $rec.records, $rec.calls, $rec.verdict)
    } else {
      Write-Output '本会话  ：插件尚未观测到（在会话里跑一次工具后即可出现）'
    }
  } catch { Write-Output '本会话  ：证据文件读取失败' }
} else {
  Write-Output '本会话  ：还没有证据文件'
}
if ($Done) { Write-Output ("已完成  ：{0}" -f $Done) }
if ($Todo) { Write-Output ("待办    ：{0}" -f $Todo) }
