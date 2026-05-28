---
review_id: <X>
reviewed_at: <YYYY-MM-DD>
expired: false               # 人工兜底；置 true 强制下轮重新纳入
skipped_expired:             # 本轮算出过期但被用户裁掉的（可空），写原因便于下次回查
  # - file: src/some.ts
  #   reason: 仅格式化 / 注释批量改
---

# REVIEW_<X>: <主题>

## 触发场景

<用户主动 / 周期性 / 大重构前 / 安全审查 ...，一两句说明动机；如本轮含「过期文件复审」请显式说明>

## 方法

**双对抗配对**（见 `resources/claude-config/CLAUDE.md`「决策对抗」节）：
- <Agent A：模型 / reasoning effort / 实现路径（Bash 起外部 CLI / teammate / ...）>
- <Agent B：模型 / reasoning effort / 超时设置>

**范围**：<N 个文件 / 模块清单 / 约多少行>

```text
<给人读的范围摘要；可按模块分组 / brace expansion，可读性优先>
```

**机器可读范围**（File-level Review Expiry 用；一行一个仓库相对路径，按字典序、去重；禁止目录 / glob / brace expansion）：

```review-scope
src/main/foo.ts
src/main/bar.ts
```

> 本文件**首次加入 git** 的 commit 视为该批文件的覆盖基线（自动取，不写 hash）。请与本轮结论 / 关联修复一同落地，不要预先创建空 `REVIEW_<X>.md`。

**约束**：<已知不再列的问题（如「CHANGELOG 1-N 已修过的不要再列」）/ 输出格式 / 严重度分级 (HIGH/MED/LOW)>

## 三态裁决结果

> 本节遵循全局「决策对抗」节 §Finding 输出契约 验证纪律：每条 ✅ 必须带**验证手段**（grep / 写小 test / 跑命令 / 读真实代码），未验证的 finding 强制降级 ❓ + 非 HIGH。弱断言只允许出现在 *未验证* 条目。

### ✅ 真问题（双方独立提出 / 一方提出且现场实践验证成立）

| # | 严重度 | 文件:行号 | 问题 | A | B | 验证手段 |
|---|---|---|---|---|---|---|

### ❌ 反驳（被对抗或现场核实证伪）

| 报告方 | 报项 | 反驳依据（验证手段 + 结论） |
|---|---|---|

### ❓ 部分 / 未验证（双方角度不同 / 一方提出但未实践验证）

| 现场 | A 视角 | B 视角 | 是否已验证 | 结论 |
|---|---|---|---|---|

## 修复（CHANGELOG_<Y> 落地）

### HIGH
1. **<文件:行号>** — <一句话修复方案>

### MED
...

### LOW
...

## 关联 changelog

- [CHANGELOG_<Y>.md](../changelogs/CHANGELOG_<Y>.md)：本次修复落地

## Agent 踩坑沉淀（如有）

本次 review 提炼出 N 条 agent-pitfall 候选（见项目根 `ref/conventions/tally.md`「Agent 踩坑候选」section）。同主题再撞 2 次会触发升级为 `ref/conventions/<X>-<topic>.md`（不再写项目 CLAUDE.md）。
