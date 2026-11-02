# inbox.ps1 — 零散记录收件箱（由 dsh-ledger-watch 安装器部署）
#
# 用途：想到一条但还说不清「触发场景 / 规则」时，先扔进收件箱，之后再整理成正式条目。
#
# 用法：
#   & "<账本目录>\tools\inbox.ps1" -Add "某个坑的碎片描述"
#   & "<账本目录>\tools\inbox.ps1" -List
#   & "<账本目录>\tools\inbox.ps1" -Clear

[CmdletBinding()]
param(
  [string]$Add = '',
  [switch]$List,
  [switch]$Clear
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$inbox = Join-Path $root 'inbox.md'
$utf8 = New-Object System.Text.UTF8Encoding($false)

if ($Clear) {
  if (Test-Path -LiteralPath $inbox) { Remove-Item -LiteralPath $inbox -Force }
  Write-Output '收件箱已清空'
  exit 0
}

if ($Add) {
  $line = '- {0} · {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm'), $Add.Trim()
  $existing = ''
  if (Test-Path -LiteralPath $inbox) { $existing = [System.IO.File]::ReadAllText($inbox) }
  if ($existing.Length -eq 0) { $existing = "# 收件箱`r`n`r`n" }
  [System.IO.File]::WriteAllText($inbox, ($existing.TrimEnd() + "`r`n" + $line + "`r`n"), $utf8)
  Write-Output ('已收：' + $Add.Trim())
  exit 0
}

if (Test-Path -LiteralPath $inbox) {
  $text = [System.IO.File]::ReadAllText($inbox)
  $items = @($text -split "`r?`n" | Where-Object { $_ -like '- *' })
  if ($items.Count -eq 0) { Write-Output '收件箱是空的' }
  else { Write-Output ("收件箱 {0} 条：" -f $items.Count); $items | ForEach-Object { Write-Output $_ } }
} else {
  Write-Output '收件箱是空的'
}
