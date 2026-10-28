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
         插件市场的所有更新与回滚全部失败（2026-10-27 实测，见账本 DSH-033）
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
  [string]$Profile = 'web',
  # 开发机专用：把 dependencies 写成 file:<源码绝对路径>，改源码即时生效；
  # 默认（不带本开关）写成 profile 内的相对路径 file:./vendor/<pkg>，跨机器可移植。
  [switch]$LinkSource
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

# StrictMode 下「读一个可能不存在的属性」本身就抛 PropertyNotFoundStrict；
# 更坑的是刚 `New-Object psobject` 出来的空对象，连 `.PSObject.Properties.Name` 都取不到
# （集合为空 → 成员枚举报错）。2026-10-28 实测：新 profile（没有 dsh 字段）装到第 149 行必崩，
# 而「没有 dsh 字段」正是陌生人第一次安装的形状 —— 安装器对最干净的机器是坏的。
# 唯一稳的读法是走 PSPropertyInfo 索引器：属性不存在时返回 $null，不抛。
function Get-JsonProp($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  $prop = $Object.PSObject.Properties[$Name]
  if ($null -eq $prop) { return $null }
  return $prop.Value
}

# ── 1. 复制包本体到 web profile 作用域 ─────────────────────────────────────
$srcLib = Join-Path $Source 'lib'
$srcPkg = Join-Path $Source 'package.json'
$srcPatch = Join-Path $Source 'cordis.patch.yml'
foreach ($required in @($srcPkg, $srcPatch, (Join-Path $srcLib 'index.js'), (Join-Path $srcLib 'client.js'))) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "源码不完整，缺少：$required" }
}

$webProfile = Join-Path $DshHome "profiles\$Profile"
$webModules = Join-Path $webProfile 'node_modules'
# 包实体放 profile 自己的 vendor/（自包含：删掉 GitHub 克隆目录也不影响启动）。
# 同时仍复制一份到 node_modules/，因为宿主 loader 今天就按 profile node_modules 解析 specifier；
# 两处内容完全一致（都从同一份源码复制），pnpm 若真跑起来也只会把 node_modules 那条换成指向 vendor 的链接。
$vendorDir = Join-Path (Join-Path $webProfile 'vendor') $pkgName
$targetDir = Join-Path $webModules $pkgName
foreach ($dest in @($vendorDir, $targetDir)) {
  $null = New-Item -ItemType Directory -Force -Path (Join-Path $dest 'lib')
  # 整个 lib/ 一起复制（以后加模块文件不用再改本脚本）
  Get-ChildItem -LiteralPath $srcLib -File | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $dest ('lib' + [IO.Path]::DirectorySeparatorChar + $_.Name)) -Force
  }

  # 包名必须与 loader 行的 specifier 完全一致！
  # dsh-client-modules 的 nearestPackage() 会沿模块路径向上找 package.json，
  # 并要求它的 name === 行的 specifier；不一致就**静默跳过**（客户端半边永远不进载荷）。
  # 2026-10-26 实测踩过：目录叫 dsh-ledger-watch-<stamp>、包内 name 仍是 dsh-ledger-watch → 无任何报错。
  $pkgText = (Read-Text $srcPkg) -replace '"name"\s*:\s*"[^"]*"', "`"name`": `"$pkgName`""
  Write-Text (Join-Path $dest 'package.json') $pkgText

  $patchText = (Read-Text $srcPatch) -replace 'name: dsh-ledger-watch', "name: $pkgName"
  Write-Text (Join-Path $dest 'cordis.patch.yml') $patchText
}

# ── 2. 登记进 profile 的 dependencies 与 bundles ──────────────────────────
$profilePkgPath = Join-Path $webProfile 'package.json'
$profileText = Read-Text $profilePkgPath
$backup = "$profilePkgPath.bak-ledger-watch"
if (-not (Test-Path -LiteralPath $backup)) { Write-Text $backup $profileText }

# 本地包**不能**写成 "*"（2026-10-27 实测，见账本 DSH-033）：
# profile 的 pnpm 解析会把 "*" 当成 registry 上的包去 npm 找 → ERR_PNPM_FETCH_404，
# 而且是「整棵依赖树」解析失败 —— 插件市场的每一次更新、以及失败后的回滚，全部 exit=1。
#
# 也**不能**把开发机的绝对路径写进 profile 的 package.json（产品评审 2026-10-28 P0-2）：
# 陌生人从 GitHub 克隆到别处时路径不同；就算路径对了，克隆目录一删，下次启动依赖解析失败。
# 解法：把包**实体**复制进 profile 自己的 vendor 目录，依赖写成 profile 内的相对路径
#   profiles/web/vendor/dsh-ledger-watch   ← 实体（自包含，删掉克隆目录也不影响）
#   dependencies: "dsh-ledger-watch": "file:./vendor/dsh-ledger-watch"
# 相对路径由 profile 的 package.json 解析，跨机器一致，且仍然不碰 registry。
$useLink = $PSBoundParameters.ContainsKey('LinkSource') -and $LinkSource
$depSpec = if ($useLink) {
  'file:' + ((Resolve-Path -LiteralPath $Source).Path -replace '\\', '/')
} else {
  'file:./vendor/' + $pkgName
}

# 结构化改写，不用正则（2026-10-28 实测根因）：
# profile 的 package.json 是**单行压缩 JSON**，旧正则要求 `"dependencies": {` 后面紧跟换行，
# 于是在这种文件上永远匹配不到 —— 依赖与 bundles 一条都没写进去，脚本却只在最后抛
# 「未被改写」这种看不出原因的话。改成解析 → 改对象 → 写回，幂等且与格式无关。
$profileJson = $null
try { $profileJson = $profileText | ConvertFrom-Json } catch { throw "profile package.json 不是合法 JSON：$($_.Exception.Message)" }
if ($null -eq (Get-JsonProp $profileJson 'dependencies')) {
  $profileJson | Add-Member -NotePropertyName dependencies -NotePropertyValue (New-Object psobject) -Force
}
$deps = [ordered]@{}
if ($profileJson.dependencies -ne $null) {
  foreach ($prop in $profileJson.dependencies.PSObject.Properties) { $deps[$prop.Name] = $prop.Value }
}
# 清掉本包所有历史写法（含旧的时间戳包名），只留一条
foreach ($key in @($deps.Keys)) { if ($key -like "$baseName*") { $deps.Remove($key) } }
$deps[$pkgName] = $depSpec

# Set-StrictMode 下给 PSCustomObject **新增**属性只能走 Add-Member：
# 直接 `$obj.newKey = ...` 会抛 "The property 'X' cannot be found on this object"（本脚本曾因此失败）
if ($null -eq (Get-JsonProp $profileJson 'dsh')) {
  $profileJson | Add-Member -NotePropertyName dsh -NotePropertyValue (New-Object psobject) -Force
}
if ($null -eq (Get-JsonProp (Get-JsonProp $profileJson 'dsh') 'profile')) {
  $profileJson.dsh | Add-Member -NotePropertyName profile -NotePropertyValue (New-Object psobject) -Force
}
if ($null -eq (Get-JsonProp (Get-JsonProp (Get-JsonProp $profileJson 'dsh') 'profile') 'bundles')) {
  $profileJson.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() -Force
}
$bundles = New-Object System.Collections.ArrayList
foreach ($b in @($profileJson.dsh.profile.bundles)) { $null = $bundles.Add([string]$b) }
# 本包必须排在**最前**（bundles 是有序栈，声明在前 = 参与组合在前；本包只加一个 tab，顺序无副作用但保持一致）
$kept = New-Object System.Collections.ArrayList
foreach ($b in $bundles) { if ($b -notlike "$baseName*") { $null = $kept.Add($b) } }
$null = $bundles.Clear()
$null = $bundles.Add($pkgName)
foreach ($b in $kept) { $null = $bundles.Add($b) }

# 已有属性用赋值（保留属性位置），确保写回顺序稳定
$profileJson.dependencies = [pscustomobject]$deps
$profileJson.dsh.profile.bundles = @($bundles)

# 结构化校验：改完再把内存对象写回文件，再从**文件**读回校验（不校验内存那份）
Write-Text $profilePkgPath ($profileJson | ConvertTo-Json -Depth 12)
$verified = (Read-Text $profilePkgPath) | ConvertFrom-Json
$depOk = @($verified.dependencies.PSObject.Properties.Name) -contains $pkgName
$bundleOk = @($verified.dsh.profile.bundles) -contains $pkgName
if (-not $depOk) { throw "回读校验失败：dependencies 里没有 $pkgName" }
if (-not $bundleOk) { throw "回读校验失败：dsh.profile.bundles 里没有 $pkgName（客户端半边不会进启动载荷）" }

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
foreach ($dir in @($webModules, (Join-Path $DshHome 'profiles\node_modules'), (Join-Path $webProfile 'vendor'))) {
  if (-not (Test-Path -LiteralPath $dir)) { continue }
  $old = @(Get-ChildItem -LiteralPath $dir -Directory -ErrorAction SilentlyContinue |
           Where-Object { $_.Name -like "$baseName*" -and $_.Name -ne $pkgName })
  foreach ($d in $old) { Remove-Item -LiteralPath $d.FullName -Recurse -Force; $pruned += $d.Name }
}

# ── 汇报 ──────────────────────────────────────────────────────────────────
Write-Host '账本监视插件（bundle 型）安装完成。' -ForegroundColor Green
Write-Host ''
Write-Host "包目录   : $targetDir"
Write-Host "包实体   : $vendorDir  （profile 自包含，删掉源码克隆目录也不影响）"
Write-Host "包名     : $pkgName"
Write-Host "依赖写法 : $pkgName -> $depSpec$(if ($useLink) { '  [开发模式 -LinkSource]' } else { '' })"
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
