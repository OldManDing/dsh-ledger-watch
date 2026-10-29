# dsh-ledger-watch · 经验账本指示灯

**一句话**：**踩过的坑不必再踩一次。** 动手前先查账本、踩坑后记成规则（这是 `lesson-ledger` 技能的活）；本插件负责盯着它有没有真的这么做，并把「查了几次、记了哪几条」摆在面板上。

**目的**：让模型**真的**在查经验账本、记下踩过的坑、修正失效的规则 —— 也就是自我提升 / 自我避坑 / 自我升级。
**界面只是指示灯**：显示「当前会话有没有查过账本」，以及经验账本的健康度。

它**不是**审计系统，**不是**监控用户行为的工具，也**不生产规则**（规则由 `lesson-ledger` 账本技能生产）。
**装完即用**：`install.ps1` 自己部署账本技能（`brief.ps1` / `add-lesson.ps1`）并写入 `AGENTS.md` 托管块，用户不需要手工建目录、贴配置或跑脚本。首屏也不会指责你（没就绪时是一句说明，不是一根红条）。

![会话顶部 tab 里的「经验账本」面板](assets/panel-main.png)

![首次使用：账本技能已由 install.ps1 装好、还没有条目](assets/panel-onboard.png)

> 上图是真实运行界面（会话 id 与证据文件路径已替换为占位符）：顶部一行是**启用指示灯**（本会话有没有查经验账本），下面是结论条、本会话指标、可疑信号、事件时间线，页脚是账本健康度与召回状态。

<details>
<summary><b>English summary</b></summary>

**What it is.** A bundle plugin for DeepSeek Harness that answers one question per session: *did this session actually consult the lesson ledger, and did it record the pitfalls it hit?*

**What problem it solves.** "I'll remember not to repeat that mistake" is unverifiable. This plugin turns it into data you can check: a per-session indicator, a closing-report callout, and the ledger's health (rules needing rework / rules already revised).

**What it is not.** Not an audit system, not user-behaviour monitoring, and it does not produce rules — the rules live in the `lesson-ledger` skill; this plugin only reports whether they were used.

**Zero manual setup.** `install.ps1` provisions the ledger skill (`brief.ps1` / `add-lesson.ps1`) and writes a managed block into `AGENTS.md`; no manual folders, config pasting or script runs. The first screen explains a missing setup instead of accusing you.

**Optional auto-recall (default OFF).** The host half can inject the most relevant ledger rules into the step as a system-reminder. It ships disabled because an independent acceptance pass measured ~69% precision on an 87–100 entry Chinese ledger; enable it with `recallMode: 'high-confidence'` only after reading the admission thresholds in the repo's own quality gate. The panel always shows the current state of this switch, including when it is off and why.

**Zero runtime dependencies.** The host half uses only Node built-ins; the browser half requires only React (provided by the host).

</details>

## 两个界面

| 界面 | 插槽 | 说明 |
| --- | --- | --- |
| **会话顶部 tab**「经验账本」 | `conversation.view`（order 30，在「画廊」之后） | 主界面：启用指示灯 + 账本健康度 + 本会话指标 + 可疑信号 + 事件时间线 + 其它会话 |
| **输入框下方药丸** | `conversation.composer.dock`（5 秒轮询） | `● 账本 5 / 11`，圆点颜色 = 结论；在本 tab 内随输入框一起隐藏且**停止轮询** |

本 tab 在屏时会隐藏宿主输入框（`[data-composer-seat]` + 把 `--dsh-composer-height` 归零），切走即恢复。

## 指示灯与判定口径

| 显示 | 含义 |
| --- | --- |
| **避坑功能已启用**（绿） | 本会话查过账本（`queries > 0`） |
| **避坑功能未启用**（红） | 本会话一次都没查过账本，但已经在动工具 |
| **本会话不在监视范围内**（灰） | 插件**从没观测到**这个会话（`sessionKnown === false`）：重启前就已存在的会话、或跑在别的进程里的会话。与「没查账本」是两回事，不能混为一谈 |
| 结论 `又查又记` / `查了没记` / `记了没查` / `未查询` / `无活动` | 由 queries 与 records 组合得出；「不在监视范围内」时不显示结论（没有观测就没有结论） |
| ⚠ 补记横幅 | `needRecord`：本会话有**失败的**工具调用，却一条坑都没记 → 收尾请用 `add-lesson.ps1` 补记 |

### 首次使用（没装账本技能时）

插件**不生产规则**。`ledgerDir`（默认 `~/.agents/skills/lesson-ledger`）里没有 `lessons/` 与 `workspaces/` 时，
面板**不会**判红（那不是你的错，是还没有账本可查），而是出一张引导卡：

1. 装 `lesson-ledger` 技能（把该目录放进你的技能目录）；
2. 把一段 `AGENTS.md` 片段贴进去（开工自报，让模型每次先查账本）—— 卡上可以一键复制；
3. 用 `add-lesson.ps1` 记第一条坑。

三种状态由 `scanLedger()` 给出，界面据此分流：`missing`（技能没装）/ `empty`（技能在、零条目）/ `ready`（可查）。

### 观测范围（重要）

插件只在 **DSH 运行期间**通过 `ctx.on('tools/result')` 观测工具调用，因此：

- 内存里只有**本进程启动之后**见过的会话；`state()` 会把内存与证据文件 `.watch.json` 合并后再返回，
  所以重启前活跃的会话仍能显示自己的历史计数（**读路径与写路径共用一份合并**，见 `mergeWithPrevious`）。
- **从未被观测到**的会话（插件安装之前的老会话、或运行在其他进程里的会话）没有数据可补，
  界面会明确显示「本会话不在监视范围内」，而**不是**「本会话还没开始」——后者会让人误以为所有会话内容一样。
- 落盘的会话列表上限 10 条（`payload.sessions.slice(0, 10)`），界面「其它会话」再截断到 8 条（`SESSION_LIMIT`）；
  内存里最多保留 24 条（`MAX_SESSIONS`）。

计数口径（2026-10-27 评审后收紧）：

- **只认命令位真的调用了账本脚本**（`& …\brief.ps1`、`pwsh -File …\add-lesson.ps1`、行首裸调用、任何路径形式）；
  字符串字面量、注释、只是路径里出现 `lesson-ledger` 的无关命令都**不算**。
- 文件类工具：`file_path` 必须落在账本目录内；**读证据文件本身不算**（自指）。
- `skill` 工具加载 `lesson-ledger` 算一次查询。
- **失败的调用不算查询/记录**（失败的 `brief.ps1` 没有产出任何信息）——只进事件流并计入 `failures`。
- 「记录 N」是**动作次数**，不等于「新增了 N 条坑」（同一条目反复编辑会重复计数）。

## 它怎么判断「这是不是一个坑」

**它不判断。** 插件不做语义判断，它只回答两个问题：**这个会话有没有查过经验账本、有没有把坑记下来**。判断「这段经历算不算坑」的是模型，判据写在账本技能与 `~/.dsh/AGENTS.md` 里（用户纠正、同类错误第 2 次、失败原因不显然、实测与旧结论冲突、定位超 10 分钟）。

插件能做的是**把可疑事件标出来，提醒模型回头看一眼**。目前采集五类可观测信号：

| 信号 | 判据 | 对应的坑类型 |
| --- | --- | --- |
| `failures` | 工具调用失败（`ok:false` / `isError` / 数字退出码 / 结果文本里的 `[exit code: N]`） | 失败原因不显然 |
| `retries` | 连续两次「同一工具 + 同一参数」（写类工具除外，它由下一项覆盖） | 同类错误第 2 次 |
| `rewrites` | 同一个文件被写/改到第 3 次及以上 | 之前理解错了 |
| `corrections` | 用户消息里出现纠正标记词（不对 / 错了 / 又犯 / 我说过 …）——只匹配标记词，**不保存用户原文** | 用户纠正 |
| `churn` | 工具调用 ≥ 25 次却一条坑都没记 | 干了很多活、什么都没沉淀 |

当 `records === 0` 且任一信号非零时，面板出 ⚠ 横幅、收尾自报点名，并写出**具体是哪些信号**（例如「失败调用 2 次 · 用户疑似纠正 1 次」）。

**信号行常显**：指标下方始终有一行 `可疑信号：失败 2 · 重复 1`（没有就显示「暂无」）。
原来只在「零记录」时出一条横幅 —— 用户记了一条坑，整块就消失了，48 条用例建起来的引擎没有出口。

**边界**：信号 ≠ 坑。失败调用可能只是探针故意跑失败；用户说「不对」也可能只是改需求。所以插件只提醒、不判定，也不会因为信号非零就自动往账本里写东西。
## 数据从哪来

宿主半边订阅 `tools/result` 与 `session/event`，把结果写成证据文件（宿主 `console` 模型读不到，只能落盘）：

```
~/.agents/skills/lesson-ledger\.watch.json
```

关键字段：`build`、`ledger{entries,relapse,revised}`、`writeFailures`、`client`（客户端回报自己的 build）、
`current{queries,records,calls,failures,enabled,needRecord,verdict,events}`、`sessions[]`。

写入是**原子替换**（tmp + rename，Windows 瞬态错误退避重试，退避用尽降级为直接写），
并会**合并**文件里已有的会话统计 —— 多实例或重启不会互相清空历史。

收尾自报里也会点名（`tools\report.ps1` 尾部「避坑功能」段）：未查 / 踩坑未记都会打 ⚠。

## 安装（推荐：从 npm 装）

已发布到 npm：dsh-ledger-watch。这是**唯一能进 DSH 插件市场搜索**的形态（市场索引只收 npm 包）。

```powershell
dsh plugin --profile web add dsh-ledger-watch
# 然后跑一次安装器把技能与 AGENTS.md 接线补齐（它不会重复下载包，只做本地配置）
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

也可以直接从 GitHub 装（不进市场搜索，但能跑）：

```powershell
dsh plugin --profile web add github:OldManDing/dsh-ledger-watch
```

## 安装与生效方式（重要）

本包是 **bundle 型**插件（浏览器半边只能靠 bundle 进启动载荷）：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "inject": [...] }
}
```

```powershell
# 在你自己克隆下来的目录里运行（不要用别人机器上的路径）
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

脚本做三件事，**都与源码放在哪无关**：

1. 把包实体复制进 `profiles/web/vendor/dsh-ledger-watch/`（**自包含**：之后删掉克隆目录也不影响启动）；
2. 在 `profiles/web/package.json` 里写 `"dsh-ledger-watch": "file:./vendor/dsh-ledger-watch"`
   并登记 `dsh.profile.bundles`（相对路径，跨机器一致，且不会去 registry 找这个包）；
3. 清理旧包目录。

> 开发机想「改源码即时生效」可以加 `-LinkSource`，那会把依赖写成 `file:<你的源码绝对路径>`。
> 注意那**不可移植** —— 源码目录一删，下次启动依赖解析就会失败。

| 改了什么 | 怎么生效 |
| --- | --- |
| `lib/client.js`（界面） | 跑 install.ps1 → 浏览器 **Ctrl+F5**（客户端按内容 rev 取新 bundle，**不用重启**） |
| `lib/index.js`（宿主） | 跑 install.ps1 → **必须重启 DSH web**（bundle 的模块与客户端载荷都是启动时组合的） |

**三处 id 必须逐字相同**（否则静默跳过或报 `duplicate factory registration`）：
`cordis.patch.yml` 的 `- insert[].name` ／ `package.json` 的 `name` ／ `lib/client.js` 里 `__ModuleLoader__.load({ id })`（外加目录名）。

## 配置

在 profile 的 cordis 补丁层里给本包的 loader 行加 `config`：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `ledgerDir` | `~/.agents/skills/lesson-ledger` | 账本根目录 |
| `recallMode` | `'off'` | 设 `'high-confidence'` 才开启自动召回（准入未过，见上文） |
| `exposeEvidence` | `false` | 是否允许界面读取证据文件原文 |

## 测试

```powershell
node .\tests\run-all.mjs
```

当前状态：**这里不写“全部通过”的断言**。`tests/` 不随公开仓库发布（内含开发机的绝对路径与本地账本语料），外部无法复现任何通过数；把不可复现的数字写成承诺，等于让人按它验收一个他看不到的东西。套件记录与审计文档留在开发机，仅作开发参考。

## 已知限制

0. **它依赖一个本仓库不提供的账本技能**：`brief.ps1` / `add-lesson.ps1` / `lessons/` 来自 `lesson-ledger` 技能，不在本包内。没有那个技能，本插件只能显示引导卡，不会变成绿色。
1. **只反映「本进程观测到的事实」**：宿主重启后内存计数从零开始（证据文件里的历史会话会保留，但新进程不认它们的实时状态）。
2. **多实例共享同一个证据文件**：两个实例交替写入时，谁最后写谁的内容在外层（会话统计已合并，`build`/`diag` 会是最后写入者的）。
3. **只能证明「工具调用层面」**：它看不到「坑有没有记全」「规则有没有真的生效」——那要靠账本的复发记录与人工复核。
4. 界面文案与判定口径会随评审调整，以本文件 + 代码注释为准。

## 回滚

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1 -RemovePackage
```
再从 `profiles/web/package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里删掉 `dsh-ledger-watch`，重启 DSH。

## 目录

```
ledger-watch/
├── package.json            # bundle + client 声明
├── cordis.patch.yml        # bundle 自带补丁层（插入宿主半边的 loader 行）
├── lib/index.js            # 宿主半边：观测 + 统计 + 证据文件 + Remote 面（state/evidence/report）
├── lib/client.js           # 浏览器半边：会话 tab + 药丸
├── lib/recall.js           # 账本扫描 + 条目特征 + 召回打分
├── install.ps1 / uninstall.ps1
└── README.md
```

## 设计取向（为什么是这样）

- **不做语义判断**：插件不猜「这段经历算不算坑」。判据写在账本技能与 `~/.dsh/AGENTS.md` 里，模型负责判断。
  一旦由插件来判断，错判就会被当成事实（实测过：主力是 LLM 蒸馏的同类工具，噪声全出在这里）。
- **只标信号，不阻断**：失败/重复/反复改/被纠正/空转，只计数并显示，不自动写账本、不改写模型调用。
- **召回默认关闭**：宁可漏召，不产噪声。连续四轮调参（70.8% → 60.6% → 68.8% → 66.3%）证明在旧形态上继续调参
  没有收益，所以保留高置信模式但不默认开，并把状态常显在页脚。
- **可回归**：账本的规则健康度（失效待改 / 已修订）与 `selftest.ps1` 的断言让它变得可测，
  这才是「自我提升」里唯一能被验证的部分。
