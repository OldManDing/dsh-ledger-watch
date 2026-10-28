<#
.SYNOPSIS
  卸载 DSH 账本监视插件（dsh-ledger-watch）。

.DESCRIPTION
  1. 删掉 <DshHome>\cordis.patch.yml 里 ledger-watch 的托管块（块外内容逐字节保留）
  2. 默认**保留**包目录，加 -RemovePackage 才删除（便于回滚重装）

.NOTES
  本文件必须保存为「UTF-8 带 BOM」（账本 ENV-003）。

.EXAMPLE
  powershell -NoProfile -File F:\dsh\plugins\ledger-watch\uninstall.ps1
.EXAMPLE
  powershell -NoProfile -File F:\dsh\plugins\ledger-watch\uninstall.ps1 -RemovePackage
#>
[CmdletBinding()]
param(
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  [switch]$RemovePackage
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$LF = "`n"
$PkgName = 'dsh-ledger-watch'
$markerBegin = '# --- BEGIN ledger-watch managed block (machine-generated) ---'
$markerEnd = '# --- END ledger-watch managed block (machine-generated) ---'

$patchPath = Join-Path $DshHome 'cordis.patch.yml'
if (-not (Test-Path -LiteralPath $patchPath -PathType Leaf)) {
  Write-Host "补丁层不存在，无需处理：$patchPath" -ForegroundColor Yellow
} else {
  $text = [System.IO.File]::ReadAllText($patchPath)
  $start = $text.IndexOf($markerBegin, [StringComparison]::Ordinal)
  $end = $text.IndexOf($markerEnd, [StringComparison]::Ordinal)
  if ($start -lt 0 -or $end -lt 0 -or $end -lt $start) {
    Write-Host '没有找到 ledger-watch 托管块（可能已卸载，或行是手工挂的）。' -ForegroundColor Yellow
  } else {
    $endOfBlock = $end + $markerEnd.Length
    $before = $text.Substring(0, $start)
    $after = $text.Substring($endOfBlock)
    # 顺手吃掉托管块前后因插入产生的多余空行，块外正文本身逐字节保留
    $before = $before -replace "(`r?`n)+$", $LF
    $after = $after -replace "^(`r?`n)+", ''
    $newText = $before + $after
    if ($newText.Trim().Length -eq 0) {
      Remove-Item -LiteralPath $patchPath -Force
      Write-Host "已删除补丁文件（块外已无内容）：$patchPath"
    } else {
      [System.IO.File]::WriteAllText($patchPath, $newText, $utf8NoBom)
      Write-Host "已移除托管块（块外内容保留）：$patchPath"
    }
  }
}

$targetDir = Join-Path $DshHome "profiles\node_modules\$PkgName"
if ($RemovePackage) {
  if (Test-Path -LiteralPath $targetDir) {
    Remove-Item -LiteralPath $targetDir -Recurse -Force
    Write-Host "已删除包目录：$targetDir"
  } else {
    Write-Host "包目录不存在：$targetDir" -ForegroundColor Yellow
  }
} else {
  Write-Host "包目录保留（加 -RemovePackage 可删除）：$targetDir"
}

# 摘掉 AGENTS.md 里由安装器写入的托管块（只删块内内容，块外原文保留）
$agentsPath = Join-Path $DshHome 'AGENTS.md'
if (Test-Path -LiteralPath $agentsPath) {
  $h = [System.IO.File]::ReadAllText($agentsPath)
  $b = '# --- BEGIN dsh-ledger-watch managed block (machine-generated) ---'
  $e = '# --- END dsh-ledger-watch managed block (machine-generated) ---'
  $i = $h.IndexOf($b, [StringComparison]::Ordinal)
  $j = $h.IndexOf($e, [StringComparison]::Ordinal)
  if ($i -ge 0 -and $j -gt $i) {
    $rest = $h.Substring($j + $e.Length)
    $kept = $h.Substring(0, $i).TrimEnd()
    if (($kept + $rest).Trim().Length -eq 0) {
      Remove-Item -LiteralPath $agentsPath -Force
      Write-Host 'AGENTS.md 只含托管块，已删除该文件'
    } else {
      $merged = if ($kept.Length -eq 0) { $rest.TrimStart() } else { $kept + "`r`n" + $rest.TrimStart() }
      [System.IO.File]::WriteAllText($agentsPath, $merged, (New-Object System.Text.UTF8Encoding($false)))
      Write-Host '已从 AGENTS.md 移除托管块（块外内容保留）'
    }
  } else {
    Write-Host 'AGENTS.md 里没有本插件的托管块'
  }
}
Write-Host ''
Write-Host '生效：宿主半边会被 live 重载；客户端半边刷新页面（Ctrl+F5）后标签消失。' -ForegroundColor Yellow
