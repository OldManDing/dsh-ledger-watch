---
name: lesson-ledger
description: 经验账本。动手前查过往踩过的坑（brief.ps1），踩坑后记成一条规则（add-lesson.ps1），收尾自报（closing.ps1）。避免同一个坑踩第二次。
---

# lesson-ledger · 经验账本

一个纯本地的 Markdown 账本，用来把「踩过的坑」变成下次能直接跳过的规则。

## 什么时候用它

- **开工前**：任务涉及以前做过的系统、工具、路径、权限时，先查一遍。
- **踩坑后**：命令报错、发现更好的做法、被用户纠正，记一条。
- **收尾时**：打印本会话的账本指标，写「已完成 / 待办」。

## 三段式

```powershell
# 1. 开工：查（多个关键词是「或」，命中越多排越前）
& "$env:USERPROFILE\.agents\skills\lesson-ledger\tools\brief.ps1" -Keywords "git,部署,权限"

# 2. 踩坑：记
& "$env:USERPROFILE\.agents\skills\lesson-ledger\tools\add-lesson.ps1" `
    -Title "一句话说清这个坑" `
    -Trigger "什么场景会遇上" -Symptom "看到什么现象" -Rule "下次怎么做"

# 3. 收尾：自报
& "$env:USERPROFILE\.agents\skills\lesson-ledger\tools\closing.ps1"
```

## 维护

| 脚本 | 用途 |
| --- | --- |
| `brief.ps1` | 查询，命中的条目摘要贴进回复 |
| `add-lesson.ps1` | 追加一条，ID 自动取下一个空号 |
| `closing.ps1` | 收尾自报（健康度 + 本会话指标） |
| `inbox.ps1` | 攒零散记录，整理成正式条目前先放着 |
| `mark-lesson.ps1` | 标记复发（`relapse`）或已修订（`revised`） |
| `selftest.ps1` | 条目断言：缺字段、重复 ID |
| `check-ledger.ps1` | 结构自检：目录、脚本、BOM、证据新鲜度 |

## 条目格式

```markdown
## ENV-001 标题

- **触发场景**：什么情况下会撞上
- **症状**：看到的现象
- **规则**：下次怎么做
- **状态**：有效
```

条目 ID 前缀表示领域：`ENV`（环境/工具）、`DSH`（本项目）、`DATA`、`PRC`（流程）、`WS-XXX`（工作区）。

## 注意

这些 `.ps1` 含中文，必须是 **UTF-8 带 BOM**，否则 Windows PowerShell 5.1 会按 ANSI 解码、报一堆假的语法错。`check-ledger.ps1` 会检查这一点。
