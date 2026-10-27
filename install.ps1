<#
.SYNOPSIS
  安装 / 更新 DSH 账本监视插件（dsh-ledger-watch）—— **bundle 型**，含宿主半边与浏览器半边。

.DESCRIPTION
  为什么必须做成 bundle（2026-10-26 实测结论，见账本 DSH-016）：
  只在 <DshHome>\cordis.patch.yml 里插一行，只能让**宿主半边**生效；
  浏览器半边要进 `__DSH_BOOT__.entries`，包必须是 **bundle** 并登记在
  `profiles/web/package.json` 的 `dsh.profile.bundles` 里（本机 dsh-context / dsh-purge 都是这个形态）。

  本脚本做五件事：
    1. 把 lib\ + package.json + cordis.patch.yml 复制到
       <DshHome>\profiles\web\node_modules\dsh-ledger-watch-<stamp>\
       （包内补丁层的 name 改写成新包名 —— 换 specifier 才换模块，见 DSH-013）
    2. 更新 <DshHome>\profiles\web\package.json：
       dependencies 与 dsh.profile.bundles 里各留一条本包（旧的自动清理），改前备份为
       package.json.bak-ledger-watch
       —— dependencies 里必须写成 **file:<源码目录>**（本地目录依赖），不能写 "*"：
          "*" 会让 profile 的 pnpm 去 registry 找这个不存在的包，整棵依赖树解析 404，
         插件市场的所有更新与回滚全部失败（2026-10-27 实测，见账本 DSH-020）
    3. 从 <DshHome>\cordis.patch.yml 移除旧的 ledger-watch 托管块（避免宿主半边被加载两次）
    4. 清理 profiles\web\node_modules 与 profiles\node_modules 里的旧包目录（各留最新 1 个）
    5. 汇报：并明确告诉你**必须重启 DSH web** 才生效（bundles 与客户端载荷都是启动时组合的）

.PARAMETER DshHome
  DSH 家目录。默认取 $env:DSH_HOME，没有则用 $env:USERPROFILE\.dsh。

.PARAMETER Source
  包源码目录。默认是本脚本所在目录。

.PARAMETER Profile
  profile 名。默认 web。

.NOTES
  本文件必须保存为「UTF-8 带 BOM」（账本 ENV-003）。
  F 盘脚本会被 RemoteSigned 拦住，调用时请带 -ExecutionPolicy Bypass（账本 ENV-008）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File F:\dsh\plugins\ledger-watch\install.ps1
#>
[CmdletBinding()]
param(
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  [string]$Source = $PSScriptRoot,
  [string]$Profile = 'web'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrEmpty($Source)) { $Source = $PSScriptRoot }
if ([string]::IsNullOrEmpty($Source)) { $Source = Split-Path -Parent $MyInvocation.MyCommand.Path }
if ([string]::IsNullOrEmpty($Source)) { throw '无法确定源码目录，请显式传 -Source <目录>' }

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$LF = "`n"
$baseName = 'dsh-ledger-watch'
# 稳定包名（不加时间戳）：bundle 型插件的三处 id 必须完全一致 ——
#   ① loader 行的 name  ② package.json 的 name  ③ 客户端 bundle 里 __ModuleLoader__.load({ id })
# 任何一处不一致都会被静默跳过或报 "duplicate factory registration"（2026-10-26 实测踩过，见 DSH-016/017）。
# 代价：宿主半边的代码更新需要重启 DSH（bundle 与客户端载荷本来就是启动时组合的）。
$pkgName = $baseName
$rowId = 'ledger-watch'

function Write-Text([string]$Path, [string]$Text) { [System.IO.File]::WriteAllText($Path, $Text, $utf8NoBom) }
function Read-Text([string]$Path) { [System.IO.File]::ReadAllText($Path) }

# ── 1. 复制包本体到 web profile 作用域 ─────────────────────────────────────
$srcLib = Join-Path $Source 'lib'
$srcPkg = Join-Path $Source 'package.json'
$srcPatch = Join-Path $Source 'cordis.patch.yml'
foreach ($required in @($srcPkg, $srcPatch, (Join-Path $srcLib 'index.js'), (Join-Path $srcLib 'client.js'))) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "源码不完整，缺少：$required" }
}

$webProfile = Join-Path $DshHome "profiles\$Profile"
$webModules = Join-Path $webProfile 'node_modules'
$targetDir = Join-Path $webModules $pkgName
$null = New-Item -ItemType Directory -Force -Path (Join-Path $targetDir 'lib')
# 整个 lib/ 一起复制（以后加模块文件不用再改本脚本）
Get-ChildItem -LiteralPath $srcLib -File | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $targetDir ('lib' + [IO.Path]::DirectorySeparatorChar + $_.Name)) -Force
}

# 包名必须与 loader 行的 specifier 完全一致！
# dsh-client-modules 的 nearestPackage() 会沿模块路径向上找 package.json，
# 并要求它的 name === 行的 specifier；不一致就**静默跳过**（客户端半边永远不进载荷）。
# 2026-10-26 实测踩过：目录叫 dsh-ledger-watch-<stamp>、包内 name 仍是 dsh-ledger-watch → 无任何报错。
$pkgText = (Read-Text $srcPkg) -replace '"name"\s*:\s*"[^"]*"', "`"name`": `"$pkgName`""
Write-Text (Join-Path $targetDir 'package.json') $pkgText

$patchText = (Read-Text $srcPatch) -replace 'name: dsh-ledger-watch', "name: $pkgName"
Write-Text (Join-Path $targetDir 'cordis.patch.yml') $patchText

# ── 2. 登记进 profile 的 dependencies 与 bundles ──────────────────────────
$profilePkgPath = Join-Path $webProfile 'package.json'
$profileText = Read-Text $profilePkgPath
$backup = "$profilePkgPath.bak-ledger-watch"
if (-not (Test-Path -LiteralPath $backup)) { Write-Text $backup $profileText }

# 本地包**不能**写成 "*"（2026-10-27 实测，见账本 DSH-020）：
# profile 的 pnpm 解析会把 "*" 当成 registry 上的包去 npm 找 → ERR_PNPM_FETCH_404，
# 而且是「整棵依赖树」解析失败 —— 插件市场的每一次更新、以及失败后的回滚，全部 exit=1。
# 正确写法是目录依赖 file:<源码目录>：pnpm 直接从本地目录取，不碰 registry。
$depSpec = 'file:' + ((Resolve-Path -LiteralPath $Source).Path -replace '\\', '/')

$before = $profileText
$profileText = [regex]::Replace($profileText, '(?m)^\s*"dsh-ledger-watch[^"]*"\s*:\s*"[^"]*",\r?\n', '')
$profileText = [regex]::Replace($profileText, '(?m)^\s*"dsh-ledger-watch[^"]*",\r?\n', '')
$profileText = [regex]::new('("dependencies"\s*:\s*\{\r?\n)').Replace($profileText, "`$1    `"$pkgName`": `"$depSpec`",`r`n", 1)
$profileText = [regex]::new('("bundles"\s*:\s*\[\r?\n)').Replace($profileText, "`$1        `"$pkgName`",`r`n", 1)
# 校验：改完之后两处都必须存在本包名（幂等重装时文本可能不变，所以不能拿 $before 比较）
# 结构化校验（只查文本会漏掉「bundles 没写进去」这类静默失败，见 DSH-016）
$profileJson = $null
try { $profileJson = $profileText | ConvertFrom-Json } catch { throw "profile package.json 不是合法 JSON：$($_.Exception.Message)" }
$depOk = $false
if ($profileJson.PSObject.Properties.Name -contains 'dependencies') {
  $depOk = @($profileJson.dependencies.PSObject.Properties.Name) -contains $pkgName
}
$bundleOk = $false
if ($profileJson.PSObject.Properties.Name -contains 'dsh' -and $profileJson.dsh -ne $null -and
    $profileJson.dsh.PSObject.Properties.Name -contains 'profile' -and $profileJson.dsh.profile -ne $null -and
    $profileJson.dsh.profile.PSObject.Properties.Name -contains 'bundles') {
  $bundleOk = @($profileJson.dsh.profile.bundles) -contains $pkgName
}
if (-not $depOk) { throw "profile package.json 的 dependencies 里没有 $pkgName" }
if (-not $bundleOk) { throw "profile package.json 的 dsh.profile.bundles 里没有 $pkgName（客户端半边不会进启动载荷）" }
Write-Text $profilePkgPath $profileText

# ── 3. 移除家目录补丁层里的旧托管块（避免宿主半边重复加载）────────────────
$homePatch = Join-Path $DshHome 'cordis.patch.yml'
$homeAction = '家目录补丁层不存在，无需处理'
if (Test-Path -LiteralPath $homePatch -PathType Leaf) {
  $h = Read-Text $homePatch
  $begin = '# --- BEGIN ledger-watch managed block (machine-generated) ---'
  $end = '# --- END ledger-watch managed block (machine-generated) ---'
  $s = $h.IndexOf($begin, [StringComparison]::Ordinal)
  $e = $h.IndexOf($end, [StringComparison]::Ordinal)
  if ($s -ge 0 -and $e -gt $s) {
    $newH = ($h.Substring(0, $s) -replace "(`r?`n)+$", $LF) + ($h.Substring($e + $end.Length) -replace "^(`r?`n)+", '')
    if ($newH.Trim().Length -eq 0) { Remove-Item -LiteralPath $homePatch -Force; $homeAction = '家目录补丁层已清空并删除' }
    else { Write-Text $homePatch $newH; $homeAction = '已移除 ledger-watch 托管块（块外内容保留）' }
  } else { $homeAction = '家目录补丁层里没有 ledger-watch 托管块（已由 bundle 接管）' }
}

# ── 4. 清理旧包目录 ───────────────────────────────────────────────────────
$pruned = @()
foreach ($dir in @($webModules, (Join-Path $DshHome 'profiles\node_modules'))) {
  $old = @(Get-ChildItem -LiteralPath $dir -Directory -ErrorAction SilentlyContinue |
           Where-Object { $_.Name -like "$baseName*" -and $_.Name -ne $pkgName } |
           Sort-Object Name -Descending | Select-Object -Skip 1)
  foreach ($d in $old) { Remove-Item -LiteralPath $d.FullName -Recurse -Force; $pruned += $d.Name }
}

# ── 汇报 ──────────────────────────────────────────────────────────────────
Write-Host '账本监视插件（bundle 型）安装完成。' -ForegroundColor Green
Write-Host ''
Write-Host "包目录   : $targetDir"
Write-Host "包名     : $pkgName"
Write-Host "profile  : $profilePkgPath  （dependencies + dsh.profile.bundles 各一条）"
Write-Host "补丁层   : $homeAction"
if ($pruned.Count -gt 0) { Write-Host "清理     : $($pruned -join ', ')" }
Write-Host ''
Write-Host '⚠️ 必须重启 DSH web 才生效：' -ForegroundColor Yellow
Write-Host '   dsh.profile.bundles 与浏览器端启动载荷（__DSH_BOOT__）都是**启动时**组合的，'
Write-Host '   热重载只覆盖补丁层，不会把新包加进客户端载荷。'
Write-Host ''
Write-Host '重启前可先验证组合结果：' -ForegroundColor Yellow
Write-Host "  dsh --profile $Profile --dump-config | Select-String ledger-watch"
Write-Host '  应能看到来自本包 cordis.patch.yml 的 - id: ledger-watch / name: <新包名>'
