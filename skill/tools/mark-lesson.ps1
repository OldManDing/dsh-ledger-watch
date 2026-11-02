# mark-lesson.ps1 — 标记「复发」或「已修订」（由 dsh-ledger-watch 安装器部署）
#
# 用法：
#   & "<账本目录>\tools\mark-lesson.ps1" -Id DSH-001 -Recurred "又在 F: 盘踩了一次"
#   & "<账本目录>\tools\mark-lesson.ps1" -Id DSH-001 -Revised "已改成强制 BOM 写入"
#
# 为什么需要它：面板上的「复发 / 已修订」两个数字，靠扫描条目行里的
# 「复发记录」「修订记录」字样得出，而 add-lesson.ps1 只写四个字段 ——
# 没有写入端，这两个数字就永远是 0（问题 L8）。

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Id,
  [string]$Recurred = '',
  [string]$Revised = '',
  [string]$Status = ''
)

$ErrorActionPreference = 'Stop'
if (-not $Recurred -and -not $Revised -and -not $Status) {
  throw '至少给 -Recurred / -Revised / -Status 其中一项'
}

$root = Split-Path -Parent $PSScriptRoot
$lessons = Join-Path $root 'lessons'
if (-not (Test-Path -LiteralPath $lessons)) { throw "账本目录不存在：$lessons" }

$headRe = [regex]('^##\s+' + [regex]::Escape($Id) + '\s')
$utf8 = New-Object System.Text.UTF8Encoding($false)
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
$hit = $false

foreach ($file in Get-ChildItem -LiteralPath $lessons -Filter *.md -File) {
  $lines = [System.IO.File]::ReadAllLines($file.FullName)
  $idx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($headRe.IsMatch($lines[$i])) { $idx = $i; break }
  }
  if ($idx -lt 0) { continue }
  $hit = $true

  # 找到这一条的末尾（下一条 ## 之前，或文件末尾）
  $end = $lines.Count
  for ($i = $idx + 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i].StartsWith('## ')) { $end = $i; break }
  }

  $add = @()
  if ($Recurred) { $add += ('- **复发记录**：{0}（{1}）' -f $Recurred.Trim(), $stamp) }
  if ($Revised) { $add += ('- **修订记录**：{0}（{1}）' -f $Revised.Trim(), $stamp) }

  # 已有同名字段就替换，没有就插在条目标尾
  $body = @($lines[($idx + 1)..($end - 1)])
  foreach ($line in $add) {
    $mark = if ($line.IndexOf('复发记录') -ge 0) { '复发记录' } else { '修订记录' }
    $found = $false
    for ($i = 0; $i -lt $body.Count; $i++) {
      if ($body[$i].IndexOf('**' + $mark + '**') -ge 0) { $body[$i] = $line; $found = $true; break }
    }
    if (-not $found) { $body = @($body) + $line }
  }
  if ($Status) {
    $replaced = $false
    for ($i = 0; $i -lt $body.Count; $i++) {
      if ($body[$i].IndexOf('**状态**') -ge 0) {
        $body[$i] = '- **状态**：' + $Status.Trim()
        $replaced = $true
        break
      }
    }
    if (-not $replaced) { $body = @($body) + ('- **状态**：' + $Status.Trim()) }
  }

  $out = @()
  $out += $lines[0..$idx]
  $out += $body
  if ($end -lt $lines.Count) { $out += $lines[$end..($lines.Count - 1)] }
  [System.IO.File]::WriteAllText($file.FullName, (($out -join "`r`n") + "`r`n"), $utf8)
  Write-Output ("已更新：{0} → {1}" -f $Id, $file.Name)
  break
}

if (-not $hit) { throw "账本里找不到条目：$Id" }
