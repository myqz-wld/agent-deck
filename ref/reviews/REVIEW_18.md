---
review_id: 18
reviewed_at: 2026-05-01
expired: false
skipped_expired: []
heterogeneous_dual_completed: false
notes: |
  reviewer-codex 全部 3 batch 因 codex provider 402 Payment Required（账号余额耗尽）
  失败，按 reviewer-codex agent body / CLAUDE.md「reviewer-codex 失败兜底」节
  严禁自动降级到同源双 Claude。本轮仅 reviewer-claude 单方完成；用户两次
  AskUserQuestion 均未作答（bypass 模式自主推进），按合法选项「单方 reviewer-claude
  出结论」处理 + 此处明标置信度降低。后续 codex 余额恢复后可起 R2 反向校验。
---

# REVIEW_18: 大文件拆分 (S1+S2+S3) 重构落地校验

## 触发场景

CHANGELOG_50 落地后的强制 review：S1 (`src/shared/types.ts` 777→13 barrel + 8 domain module) / S2 (`src/main/ipc.ts` 997→`ipc/` 10 子文件 per-domain register) / S3 (`sdk-bridge.ts` 抽 `formatAskAnswers` 纯函数到 `sdk-bridge-helpers.ts`) 三个 atomic refactor commit 是否真零行为变更。

明确不在 scope 的「保护文件」（`session/manager.ts` / `codex-cli/sdk-bridge.ts` / 4 个 UI 组件 / `sdk-bridge.ts` class 主体）按 CHANGELOG_50 §S4 单独评审。

## 方法

**双对抗配对**（按 `~/.claude/CLAUDE.md`「决策对抗」节）：

| Reviewer | 模型 / reasoning | 实际结果 |
|---|---|---|
| reviewer-claude | Opus 4.7 xhigh subagent | ✅ 完整跑完 (382s / 142k tokens / 57 tool uses)，给出完整 §full_review 输出 + 字节级验证表 |
| reviewer-codex | gpt-5.5 xhigh wrapper（外部 codex CLI） | ❌ **失败** — 3 个 batch 全部 402 Payment Required（codex provider `xaminim` 账号余额耗尽，非本仓库可控） |

**异构对抗状态**：未完成（仅单方 reviewer-claude）。按 CLAUDE.md「reviewer-codex 失败兜底」节明列合法选项「单方 reviewer-claude 出结论」推进，置信度低于完整双对抗；本轮发现的「✅ 可合」结论暂用。后续 codex 余额恢复可起一次反向校验（独立 R2，本份 review 已结案）。

**范围**：21 个文件 / 3 个 refactor commit / +2023 / -1793

```text
S1 (de25271 / types barrel)：
  src/shared/types.ts                       (777→13 barrel)
  src/shared/types/{agent,session,team,permission,file,summary,task,settings}.ts × 8

S2 (a6085ab / ipc 拆分)：
  src/main/ipc.ts                           (delete)
  src/main/ipc/{_helpers,window-app,sessions,hooks,settings,adapters,permissions,images,teams,index}.ts × 10

S3 (1b5be05 / formatAskAnswers extract)：
  src/main/adapters/claude-code/sdk-bridge.ts          (1995→1972)
  src/main/adapters/claude-code/sdk-bridge-helpers.ts  (新 31 行)
```

**机器可读范围**（File-level Review Expiry 用；一行一个仓库相对路径，按字典序、去重；禁止目录 / glob / brace expansion）：

```review-scope
src/main/adapters/claude-code/sdk-bridge-helpers.ts
src/main/adapters/claude-code/sdk-bridge.ts
src/main/ipc/_helpers.ts
src/main/ipc/adapters.ts
src/main/ipc/hooks.ts
src/main/ipc/images.ts
src/main/ipc/index.ts
src/main/ipc/permissions.ts
src/main/ipc/sessions.ts
src/main/ipc/settings.ts
src/main/ipc/teams.ts
src/main/ipc/window-app.ts
src/shared/types.ts
src/shared/types/agent.ts
src/shared/types/file.ts
src/shared/types/permission.ts
src/shared/types/session.ts
src/shared/types/settings.ts
src/shared/types/summary.ts
src/shared/types/task.ts
src/shared/types/team.ts
```

**约束**：

- focus = 拆分完整性 + 零行为变更校验（不重审 REVIEW_17 已结案 13 ✅ HIGH/MED 修复语义）
- skip = 明确不动的文件（session/manager.ts / codex-cli/sdk-bridge.ts / 4 个 UI 组件）
- 严重度分级：HIGH / MED / LOW / INFO
- 验证手段必填（grep / 写小 test / 跑命令对比 git diff）

## 三态裁决结果

> 本节遵循全局「决策对抗」节的验证纪律：每条 ✅ 必须带**验证手段**（grep / 写小 test / 跑命令 / 读真实代码），未验证的 finding 强制降级 ❓ + 非 HIGH。弱断言关键词（"可能 / 也许 / 看起来"）只允许出现在 *未验证* 条目里。

### ✅ 真问题（双方独立提出 / 一方提出且现场实践验证成立）

**0 HIGH / 0 MED / 0 LOW**

reviewer-claude 完整字节级比对 + 静态 / 动态验证后，未发现回归 / 死代码 / 隐蔽缺。

| # | 严重度 | 文件:行号 | 问题 | A | B | 验证手段 |
|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — |

### ❌ 反驳（被对抗或现场核实证伪）

无（reviewer-codex 缺席 → 无单方独有 HIGH 触发反驳轮）。

### ❓ 部分 / 未验证（双方角度不同 / 一方提出但未实践验证）

无可裁决条目（reviewer-codex 缺席）。

### ℹ️ INFO（不修，仅记录）

| # | 文件:行号 | 描述 |
|---|---|---|
| INFO-1 | `src/main/ipc/index.ts:3` | docstring「按原 src/main/ipc.ts:bootstrapIpc() 的顺序调用各 register 函数」表述精度问题：在「每个新 register 函数中第一个 channel 在原文件首次出现位置」层面顺序单调递增（AppGetVersion=L263→SessionList=L281→HookInstall=L324→SettingsGet=L353→AdapterList=L415→PermissionScanCwd=L675→ImageLoadBlob=L720→SummarizerLastErrors=L725），但 channel 级在原文件中部分曾交错（DialogChooseDirectory/SoundFile/Executable + AppPlayTestSound/AppShowTestNotification + DialogConfirm + ClaudeMd* 这几组在原 ipc.ts 中并非紧邻所属 domain）。新结构里这些被合并到 window-app.ts / settings.ts。`ipcMain.handle` 是 channel-name keyed Map dispatch，组内顺序变化无运行时影响。**无运行时影响，文档表述瑕疵**，不修；后续若追求字面一致可改成「按原 ipc.ts 中每个新 register 函数首个 channel 出现的顺序排列；ipcMain.handle 是 channel-keyed 注册，组内顺序变化无功能影响」。 |

## reviewer-claude 验证锚点表（reference）

下表来自 reviewer-claude 完整执行：

| 维度 | 验证手段 | 结果 |
|---|---|---|
| S1 types 完整性 | `python3 normalize → diff` 8 子模块 concat vs 原 types.ts | 仅多 2 行 `import type {AgentEvent/SessionRecord}`（team.ts 跨域，已用 `import type` 安全），其余字节等价 |
| S1 export 名集合 | `grep -E '^export (interface|type|const)'` 排序对比 | 44 个 export 完全相等（`diff === EQUAL`） |
| S1 callsite 不变 | `grep "from '@shared/types'"` | 65 个调用方全用 barrel 路径，0 个 sub-path import |
| S1 isolatedModules 兼容 | `tsc --isolatedModules src/shared/types/team.ts` | 无错（cross-import 全 `import type` 安全） |
| S2 channel 完整性 | 53 vs 53 完全相等，无重复注册 | `diff /tmp/old_channels.txt /tmp/new_channels.txt === EQUAL`、`uniq -c` 全部 1 |
| S2 handler 体等价 | `python3 normalize` 后 sort+diff 仅 9 行差（全是 import / export 包装差异） | byte-equivalent |
| S2 旧文件 rm | `ls src/main/ipc.ts` → No such file；唯一 `from './ipc'` 是 index.ts:6（resolve 到 ipc/index.ts） | ✓ |
| S2 SetPermissionMode 冷切 + 回滚护栏（REVIEW_11 Bug 2） | adapters.ts L148-172 与原 L536-560 字符级一致 | ✓ |
| S2 SettingsSet APPLY_FNS 顺序 + 回滚（REVIEW_4 H2 / REVIEW_7 L3） | settings.ts L143-176 与原 L376-409 字符级一致 | ✓ |
| S2 Image 双白名单 + TOCTOU + 单 fd（CHANGELOG_47） | images.ts L42-149 与原 L865-997 字符级一致 | ✓ |
| S2 TeamForceCleanup C 方案 + unsetTeam（REVIEW_17 R1 / M6） | teams.ts L75-86 与原 L773-784 字符级一致 | ✓ |
| S2 TeamRespondPermission inbox + markResponded + emit | teams.ts L110-149 与原 L808-847 字符级一致 | ✓ |
| S3 sdk-bridge.ts class 主体不变 | `git diff de25271^..1b5be05 -- sdk-bridge.ts` 仅 +1 import +0/-24 末尾 helpers | ✓ |
| S3 formatAskAnswers 字节等价 | sdk-bridge-helpers.ts L9-31 函数体与原 L1973-1994 完全相同 | ✓ |
| S3 单调用 + import 复用 | call site sdk-bridge.ts:354；AskUserQuestionItem/Answer 仍在 L12-13/95/331/1053 active 使用，import 不孤儿 | ✓ |
| typecheck | `pnpm typecheck` | ✓ |
| build | `pnpm build` | ✓（main 266.94 kB + preload 16.22 kB + renderer 1.17 MB） |
| test | `pnpm exec vitest run` | ✓ 165 passed / 26 skipped（task-repo skip 是 better-sqlite3 ABI mismatch，CLAUDE.md 已记录的预存在状态，非本次引入） |

## 修复

无 HIGH / MED / LOW 必修项。INFO-1 不修。

## 关联 changelog

- [CHANGELOG_50.md](../changelog/CHANGELOG_50.md)：本次重构 S1+S2+S3 全部内容

## Agent 踩坑沉淀

无新 agent-pitfall 候选；本期是一次完美的「机械式 + 字节级 verify」拆分，没有踩到新问题。

## 残留 / 后续

1. **reviewer-codex 余额恢复后可补一次 R2 反向校验**（独立起，不阻断本份结案）。届时 focus 同本份 + 重点关注「reviewer-claude 是否有同源盲区漏掉」
2. **保护文件未审范围**（按 CHANGELOG_50 §S4）：`session/manager.ts` / `codex-cli/sdk-bridge.ts` / 4 个 UI 组件需各自单独 plan + review，不在本份 scope
3. INFO-1 docstring 措辞优化可在下次顺手 commit 中带过
