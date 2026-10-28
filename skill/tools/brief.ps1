# brief.ps1 — 开工前查经验账本（由 dsh-ledger-watch 安装器自动部署）
#
# 用法：
#   & "<账本目录>\tools\brief.ps1" -Keywords "git,测试,部署"
#   & "<账本目录>\tools\brief.ps1"          # 不给关键词就列最近 8 条
#
# 语义：多个关键词之间是「或」，命中越多排越前；全不命中时退化为按更新时间排序。
# （历史上这里是「与」，贴一串词就恒为 0 命中，用户以为账本是空的。）

[CmdletBinding()]
param(
  [string]$Keywords = '',
  [int]$Limit = 8
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dirs = @('lessons', 'workspaces') | ForEach-Object { Join-Path $root $_ }

$entryRe = [regex]'^##\s+((?:ENV|DSH|DATA|PRC|WS-[A-Z0-9]+)-\d{3,})\s+(.+)$'
$fieldRe = @{
  trigger = [regex]'^- \*\*触发场景\*\*：(.+)$'
  symptom = [regex]'^- \*\*症状\*\*：(.+)$'
  rule    = [regex]'^- \*\*规则\*\*：(.+)$'
  status  = [regex]'^- \*\*状态\*\*：(.+)$'
}

$items = New-Object System.Collections.ArrayList

foreach ($dir in $dirs) {
  if (-not (Test-Path -LiteralPath $dir)) { continue }
  foreach ($file in Get-ChildItem -LiteralPath $dir -Filter *.md -File) {
    if ($file.Name.StartsWith('_') -or $file.Name -eq 'WORKSPACES.md') { continue }
    $current = $null
    foreach ($line in [System.IO.File]::ReadAllLines($file.FullName)) {
      $m = $entryRe.Match($line)
      if ($m.Success) {
        if ($null -ne $current) { $null = $items.Add($current) }
        $current = [pscustomobject]@{
          id = $m.Groups[1].Value; title = $m.Groups[2].Value.Trim()
          trigger = ''; symptom = ''; rule = ''; status = ''
          file = $file.Name; mtime = $file.LastWriteTimeUtc
        }
        continue
      }
      if ($null -eq $current) { continue }
      foreach ($key in $fieldRe.Keys) {
        $fm = $fieldRe[$key].Match($line)
        if ($fm.Success) { $current.$key = $fm.Groups[1].Value.Trim(); break }
      }
    }
    if ($null -ne $current) { $null = $items.Add($current) }
  }
}

if ($items.Count -eq 0) {
  Write-Output '账本里还没有条目（第一次踩坑后用 add-lesson.ps1 记一条）。'
  exit 0
}

$words = @($Keywords -split '[,，\s]+' | Where-Object { $_.Trim().Length -gt 0 })
$scored = foreach ($item in $items) {
  $hay = ($item.id + ' ' + $item.title + ' ' + $item.trigger + ' ' + $item.symptom + ' ' + $item.rule)
  $score = 0
  foreach ($w in $words) { if ($hay.IndexOf($w, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $score++ } }
  [pscustomobject]@{ item = $item; score = $score }
}

$picked = if ($words.Count -gt 0) {
  $hit = @($scored | Where-Object { $_.score -gt 0 } | Sort-Object -Property @{Expression='score';Descending=$true}, @{Expression={$_.item.mtime};Descending=$true})
  if ($hit.Count -gt 0) { $hit } else { @($scored | Sort-Object -Property { $_.item.mtime } -Descending) }
} else {
  @($scored | Sort-Object -Property { $_.item.mtime } -Descending)
}

$picked | Select-Object -First $Limit | ForEach-Object {
  $it = $_.item
  Write-Output ('[' + $it.id + '] ' + $it.title)
  if ($it.trigger) { Write-Output ('  触发：' + $it.trigger) }
  if ($it.rule)    { Write-Output ('  规则：' + $it.rule) }
}
