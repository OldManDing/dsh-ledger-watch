# check-ledger.ps1 — 结构自检（由 dsh-ledger-watch 安装器部署）
#
# 检查账本目录的骨架：目录、脚本、SKILL.md、BOM、证据文件新鲜度。
# 退出码 0 = 全部通过，1 = 有问题。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pass = 0
$fail = 0
function Ok([string]$m) { Write-Output ('  ✓ ' + $m); $script:pass++ }
function Bad([string]$m) { Write-Output ('  ✗ ' + $m); $script:fail++ }

Write-Output ("账本目录：{0}" -f $root)

# 1) 目录
foreach ($d in @('lessons', 'workspaces', 'tools')) {
  if (Test-Path -LiteralPath (Join-Path $root $d)) { Ok ("目录 $d") } else { Bad ("缺目录 $d") }
}

# 2) 脚本齐全
$expected = @('brief.ps1', 'add-lesson.ps1', 'closing.ps1', 'inbox.ps1', 'mark-lesson.ps1', 'selftest.ps1', 'check-ledger.ps1')
$tools = Join-Path $root 'tools'
foreach ($s in $expected) {
  if (Test-Path -LiteralPath (Join-Path $tools $s)) { Ok ("脚本 $s") } else { Bad ("缺脚本 $s") }
}

# 3) BOM：含中文的 .ps1 必须带 UTF-8 BOM，否则 Windows PowerShell 5.1 按 ANSI 解码会报假的语法错
if (Test-Path -LiteralPath $tools) {
  foreach ($f in Get-ChildItem -LiteralPath $tools -Filter *.ps1 -File) {
    $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
    $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    if ($hasBom) { Ok ("BOM " + $f.Name) } else { Bad ("缺 BOM：" + $f.Name + "（会被当成 ANSI 解码）") }
  }
}

# 4) SKILL.md 必须存在，且**不能**带 BOM（技能发现会读它的 front-matter）
$skill = Join-Path $root 'SKILL.md'
if (Test-Path -LiteralPath $skill) {
  Ok 'SKILL.md 存在'
  $bytes = [System.IO.File]::ReadAllBytes($skill)
  $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  if ($hasBom) { Bad 'SKILL.md 带了 BOM（front-matter 可能解析不出）' } else { Ok 'SKILL.md 无 BOM' }
} else {
  Bad '缺 SKILL.md（技能不会被注册）'
}

# 5) 条目文件
$lessons = Join-Path $root 'lessons'
$count = 0
if (Test-Path -LiteralPath $lessons) {
  foreach ($f in Get-ChildItem -LiteralPath $lessons -Filter *.md -File) {
    if ($f.Name.StartsWith('_')) { continue }
    $count += @([System.IO.File]::ReadAllLines($f.FullName) | Where-Object { $_ -match '^##\s+\S+-\d{3,}\s' }).Count
  }
}
if ($count -gt 0) { Ok ("条目 $count 条") } else { Ok '条目 0 条（首次使用属正常）' }

# 6) 证据文件新鲜度（插件正在观测吗）
$evidence = Join-Path $root '.watch.json'
if (Test-Path -LiteralPath $evidence) {
  $age = ((Get-Date) - (Get-Item $evidence).LastWriteTime).TotalMinutes
  if ($age -le 10) { Ok ("证据文件 {0:N0} 分钟前更新" -f $age) }
  else { Bad ("证据文件 {0:N0} 分钟未更新（插件没在观测？）" -f $age) }
} else {
  Bad '缺 .watch.json（插件还没观测过任何工具调用）'
}

# 7) AGENTS.md 接线
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$agents = Join-Path $dshHome 'AGENTS.md'
if (Test-Path -LiteralPath $agents) {
  $text = [System.IO.File]::ReadAllText($agents)
  if ($text.IndexOf('dsh-ledger-watch managed block') -ge 0) { Ok 'AGENTS.md 已接线' }
  else { Bad 'AGENTS.md 没有托管块（模型不会主动查账本）' }
} else {
  Bad 'AGENTS.md 不存在（模型不会主动查账本）'
}

Write-Output ("通过 {0} 项，失败 {1} 项" -f $pass, $fail)
if ($fail -gt 0) { exit 1 }
