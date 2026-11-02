# selftest.ps1 — 条目断言（由 dsh-ledger-watch 安装器部署）
#
# 检查账本里每一条的结构：必填字段、ID 重复、编号是否连续。
# 只读，不改任何文件。退出码 0 = 全部通过，1 = 有问题。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$lessons = Join-Path $root 'lessons'

$headRe = [regex]'^##\s+((?:ENV|DSH|DATA|PRC|WS-[A-Z0-9]+)-\d{3,})\s+(.+)$'
$fieldRe = @{
  '触发场景' = [regex]'^- \*\*触发场景\*\*：(.+)$'
  '症状'     = [regex]'^- \*\*症状\*\*：(.+)$'
  '规则'     = [regex]'^- \*\*规则\*\*：(.+)$'
  '状态'     = [regex]'^- \*\*状态\*\*：(.+)$'
}

$entries = @()
if (Test-Path -LiteralPath $lessons) {
  foreach ($file in Get-ChildItem -LiteralPath $lessons -Filter *.md -File) {
    if ($file.Name.StartsWith('_')) { continue }
    $cur = $null
    foreach ($line in [System.IO.File]::ReadAllLines($file.FullName)) {
      $m = $headRe.Match($line)
      if ($m.Success) {
        if ($null -ne $cur) { $entries += $cur }
        $cur = [pscustomobject]@{ id = $m.Groups[1].Value; title = $m.Groups[2].Value.Trim(); file = $file.Name; fields = @{} }
        continue
      }
      if ($null -eq $cur) { continue }
      foreach ($k in $fieldRe.Keys) {
        $fm = $fieldRe[$k].Match($line)
        if ($fm.Success) { $cur.fields[$k] = $fm.Groups[1].Value.Trim(); break }
      }
    }
    if ($null -ne $cur) { $entries += $cur }
  }
}

$pass = 0
$fail = 0
function Ok([string]$msg) { Write-Output ('  ✓ ' + $msg); $script:pass++ }
function Bad([string]$msg) { Write-Output ('  ✗ ' + $msg); $script:fail++ }

Write-Output ("条目数：{0}" -f $entries.Count)
if ($entries.Count -eq 0) {
  Write-Output '账本是空的 —— 第一次踩坑后用 add-lesson.ps1 记一条。'
  exit 0
}

# 1) 必填字段
$missing = @()
foreach ($e in $entries) {
  $lack = @()
  foreach ($k in @('触发场景', '症状', '规则', '状态')) { if (-not $e.fields.ContainsKey($k)) { $lack += $k } }
  if ($lack.Count -gt 0) { $missing += ('{0} 缺 {1}' -f $e.id, ($lack -join '/')) }
}
if ($missing.Count -eq 0) { Ok '每条都有 触发场景 / 症状 / 规则 / 状态' } else { Bad ('缺字段：' + ($missing -join '；')) }

# 2) ID 唯一
$dupes = @($entries | Group-Object id | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name })
if ($dupes.Count -eq 0) { Ok 'ID 无重复' } else { Bad ('重复 ID：' + ($dupes -join ', ')) }

# 3) 同前缀编号连续
$bad = @()
foreach ($g in ($entries | Group-Object { ($_.id -split '-')[0] })) {
  $nums = @($g.Group | ForEach-Object { [int](($_.id -split '-')[-1]) } | Sort-Object)
  for ($i = 1; $i -lt $nums.Count; $i++) {
    if ($nums[$i] -ne $nums[$i - 1] + 1) { $bad += ('{0} 缺编号 {1}' -f $g.Name, ($nums[$i - 1] + 1)) }
  }
}
if ($bad.Count -eq 0) { Ok '同前缀编号连续' } else { Bad ($bad -join '；') }

# 4) 标题非空
$noTitle = @($entries | Where-Object { $_.title.Length -eq 0 } | ForEach-Object { $_.id })
if ($noTitle.Count -eq 0) { Ok '每条都有标题' } else { Bad ('没有标题：' + ($noTitle -join ', ')) }

Write-Output ("通过 {0} 项，失败 {1} 项" -f $pass, $fail)
if ($fail -gt 0) { exit 1 }
