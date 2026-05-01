---
review_id: 19
reviewed_at: 2026-05-01
expired: false
skipped_expired: []
heterogeneous_dual_completed: true
notes: |
  reviewer-claude (Opus 4.7 xhigh subagent) + reviewer-codex (gpt-5.5 xhigh，
  fallback 手动 Bash 调外部 codex CLI — reviewer-codex subagent 内部 Bash/Read
  权限被拦截、3 个 batch 文件未生成；按 CLAUDE.md `Fallback 手动模板` 节由 lead
  自己直接 Bash 调 codex CLI 拿独立结论，仍维持异构对抗) 双方完整跑完。
  双方一致裁决「可合」，无 HIGH/MED 回归；仅注释 stale / 标点 / 措辞共 4 处 INFO
  已在本份 review 同期 commit 修掉。
---

# REVIEW_19: 第二轮大文件拆分 (P1+P2+P3+P4) 重构落地校验

## 触发场景

CHANGELOG_51 落地后的强制 review：P1 (`pending-rows/index.tsx` 728→22 barrel + 4 row + helper) / P2 (`SessionDetail.tsx` 618→322 目录化 + 5 sub-component) / P3 (`TeamDetail.tsx` 587→257 目录化 + 6 sub-component) / P4 (`session/manager.ts` 548→486 抽 4 pure helpers，class 主体字节零变更) 四个 atomic refactor commit 是否真零行为变更。

明确不在 scope 的「保护文件」（`SessionManagerClass` 主体 / `sdk-bridge.ts` class / `codex-cli/sdk-bridge.ts` / `stores/session-store.ts` / `claude-code/translate.ts`）按 CHANGELOG_51 §S5 单独评审。

## 方法

**双对抗配对**（按 `~/.claude/CLAUDE.md`「决策对抗」节）：

| Reviewer | 模型 / reasoning | 实际结果 |
|---|---|---|
| reviewer-claude | Opus 4.7 xhigh subagent | ✅ 完整跑完 (407s / 138k tokens / 80 tool uses)，逐 commit 字节级 diff 对比 + typecheck + 单元测试三重验证 |
| reviewer-codex | gpt-5.5 xhigh（外部 codex CLI） | ⚠️ subagent wrapper 内部 Bash / Read 工具被沙箱拒，3 batch 文件未生成；**lead 按 CLAUDE.md `Fallback 手动模板` 节直接 Bash 调外部 codex CLI**（仍 gpt-5.5 read-only sandbox），154k tokens 完整跑完独立结论 |

**异构对抗状态**：完成（lead Bash 调外部 codex CLI 仍是 gpt-5.5 后端，与 reviewer-claude Opus 4.7 异构原则保留）。两路独立 finding 一致裁决「可合」。

**范围**：19 个文件 / 4 个 refactor commit / +1675 / -1644

```text
P1 (a73c744 / pending-rows 拆分)：
  src/renderer/components/pending-rows/index.tsx           (728→22 barrel)
  src/renderer/components/pending-rows/{PermissionRow,AskRow,ExitPlanRow,TeamPermissionRow,tool-input-diff}.{tsx,ts} × 5

P2 (9b8fbd2 / SessionDetail 目录化)：
  src/renderer/components/SessionDetail/index.tsx          (322 行，迁过来的主体)
  src/renderer/components/SessionDetail/{SourceBadge,ComposerSdk,CliFooter,ChangeTimeline,helpers}.{tsx,ts} × 5
  原 src/renderer/components/SessionDetail.tsx 已 rm

P3 (519f726 / TeamDetail 目录化)：
  src/renderer/components/TeamDetail/index.tsx             (257 行，迁过来的主体)
  src/renderer/components/TeamDetail/{lead-session,SendToTeammate,ForceCleanupButton,TeamEventRow,chrome}.{tsx,ts} × 5
  原 src/renderer/components/TeamDetail.tsx 已 rm

P4 (c2ace5c / session/manager pure helpers extract)：
  src/main/session/manager.ts                              (548→486 仅 import + 删 4 helper 定义)
  src/main/session/manager-helpers.ts                      (新 81 行)
```

**机器可读范围**（File-level Review Expiry 用）：

```review-scope
src/main/session/manager-helpers.ts
src/main/session/manager.ts
src/renderer/components/SessionDetail/ChangeTimeline.tsx
src/renderer/components/SessionDetail/CliFooter.tsx
src/renderer/components/SessionDetail/ComposerSdk.tsx
src/renderer/components/SessionDetail/SourceBadge.tsx
src/renderer/components/SessionDetail/helpers.ts
src/renderer/components/SessionDetail/index.tsx
src/renderer/components/TeamDetail/ForceCleanupButton.tsx
src/renderer/components/TeamDetail/SendToTeammate.tsx
src/renderer/components/TeamDetail/TeamEventRow.tsx
src/renderer/components/TeamDetail/chrome.tsx
src/renderer/components/TeamDetail/index.tsx
src/renderer/components/TeamDetail/lead-session.ts
src/renderer/components/pending-rows/AskRow.tsx
src/renderer/components/pending-rows/ExitPlanRow.tsx
src/renderer/components/pending-rows/PermissionRow.tsx
src/renderer/components/pending-rows/TeamPermissionRow.tsx
src/renderer/components/pending-rows/index.tsx
src/renderer/components/pending-rows/tool-input-diff.ts
```

**约束**：

- focus = 拆分完整性 + 零行为变更校验（不重审 REVIEW_17 已结案 13 ✅ HIGH/MED 修复语义；保护文件不在 scope）
- 严重度分级：HIGH / MED / LOW / INFO
- 验证手段必填（grep / 写小 test / 跑命令对比 git diff）

## 三态裁决结果

### ✅ 真问题

**0 HIGH / 0 MED / 1 LOW + 3 INFO**

| # | 严重度 | 文件:行号 | 问题 | reviewer-claude | reviewer-codex | 验证手段 | 修复 |
|---|---|---|---|---|---|---|---|
| L1 | LOW | `SessionDetail/ComposerSdk.tsx:49` | 注释末尾英文逗号 `,`（拆分手误，原文中文 `，`）— 与「拆分零字符变更」纪律不符 | ✅ 提出 | 未独立提出 | reviewer-claude `diff` 旧/新 ComposerSdk 输出仅显示此点 + `function` → `export function` 包装差 | `git show` 修回 `，` ✓ |
| INFO-1 | INFO | `pending-rows/index.tsx:5-12` | 注释说「三个 Row」但实际 4 个 Row，且 `TeamPermissionRow` props 不含 `agentId/isSdk`（走 inbox 文件协议非 SDK canUseTool）—— 可能误导后续搬运 | 未独立提出 | ✅ 提出 | `rg "三个 Row\|M2 不加"` 命中；旧 blob 对比确认 4 row + helper 函数体匹配，调用点 diff 空 | 改成「4 个 Row」+ TeamPermissionRow 例外说明 ✓ |
| INFO-2 | INFO | `TeamDetail/index.tsx:24` | stale comment「M2 不加 force-cleanup 按钮」但同文件 L274 已渲染 `<ForceCleanupButton>` | 未独立提出 | ✅ 提出 | `rg "M2 不加\|ForceCleanupButton"` 同时命中；TeamDetail 主体 + ForceCleanupButton 已确认搬运行为不变 | 更新 docblock 为 M3 现状 + 保留异步 cleanup 风险说明 ✓ |
| INFO-3 | INFO | `manager-helpers.ts:12` | 注释「无 IO 副作用」措辞不准（`normalizeCwd` 调 `realpathSync` 读 FS） | 未独立提出 | ✅ 提出 | `rg "realpathSync"` 命中 | 改为「无 mutable state / 无写入副作用；`normalizeCwd` 会读 FS 做 realpath 标准化」 ✓ |
| INFO-4 | INFO | `TeamDetail/chrome.tsx:30,31` | `Section` 的 `right?: React.ReactNode` 改成 `import { type ReactNode }` 顶层 import + 用 `ReactNode`。两者类型完全等价（`React.ReactNode === ReactNode`）。仅风格差异。 | ✅ 提出 | 未独立提出 | reviewer-claude `diff` 旧/新 chrome 仅显示这两行差异；typecheck 通过 | 不修（与 P3 拆分动机匹配「目录化优先 + 移除 namespace 风格」），仅记录 |

### ❌ 反驳

无（双方独有 finding 都是 INFO 级注释问题，按 SKILL §反驳轮触发条件「单方独有 + HIGH」不触发反驳轮，lead 自己 grep 验证后直接修）。

### ❓ 部分 / 未验证

无（双方都做了完整字节级实证）。

## reviewer-claude 验证锚点表

| 维度 | 验证手段 | 结果 |
|---|---|---|
| P1 字节级匹配 | sed 切片 + diff 5 row/helper vs 原 728 行 index.tsx 对应区段 | 零差异（含 toolInputToDiff 字节级匹配 L680-728） |
| P1 barrel export 完整 | grep `from '@renderer/components/pending-rows'` 3 站点 | 符号 + 路径完全未改 |
| P2 SessionDetail 主体 | sed 切片 SDETAIL_BODY 33-328 vs 老 27-322 | BYTE-IDENTICAL |
| P2 子组件搬运 | diff 5 子组件 vs 老对应区段 | 仅 `function` → `export function` + 1 LOW 标点（已修） |
| P2 ComposerSdk 关键护栏 | useSessionStore permissionMode 读 + bypass 冷切 confirm 逻辑 | 原样保留 |
| P3 TeamDetail 主体 | sed 切片 TEAMDETAIL_BODY 27-289 vs 老 22-284 | BYTE-IDENTICAL |
| P3 snapRef 护栏 (REVIEW_17 R1/M3) | useRef + snapRef.current = snap effect + listener 通过 ref 读，deps `[name, refresh]` | 完整保留 |
| P3 SendToTeammate prompt-injection 防护 (REVIEW_17 R3 M1-R3) | charset `^[A-Za-z0-9._-]{1,64}$` + fenced code block 包装 | 字节级匹配 |
| P3 ForceCleanupButton 1.2s 反馈 | `setTimeout(onCleaned, 1200)` 防 onBack 抢切 | 字节级匹配 |
| P4 helpers 字节级匹配 | diff 4 helper vs 原 manager.ts L14/L504-546 | 仅 `function` → `export function` |
| P4 SessionManagerClass 字节零变更 | sed 切片 + diff vs 原 class 区段 | CLASS_BODY: BYTE-IDENTICAL |
| P4 import 站点零变更 | grep `from '@main/session/manager'` 8 站点 | 全部仍 `sessionManager` / `setSessionCloseFn` |
| P4 manager.ts 顶部 import 清理 | grep `ActivityState\|realpathSync\|resolvePath` | 不再 import（仅注释中残留） |
| typecheck | `pnpm typecheck` × 5 (P1/P2/P3/P4 + 收口) | ✓ 全过 |
| build | `pnpm build` | ✓ |
| vitest | `pnpm exec vitest run` 3 套（sdk-bridge / inbox-protocol / manager） | ✓ 54/54 全过（含 manager.test.ts 14 测验证 P4 nextActivityState/normalizeCwd 行为等价） |

## reviewer-codex 验证锚点表

| 维度 | 验证手段 | 结果 |
|---|---|---|
| P1 旧 blob 对比 | git show 旧 728 行 vs 新 5 文件函数体 | 4 Row + toolInputToDiff 全部匹配 |
| P1 调用点 diff | git diff 3 import 站点 | 空 diff |
| P2 BYTE-IDENTICAL | git diff + sed 切片 | SDETAIL_BODY 全部匹配 |
| P3 BYTE-IDENTICAL | git diff + sed 切片 | TEAMDETAIL_BODY 全部匹配；ForceCleanupButton 字节级；snapRef 护栏完整 |
| P4 BYTE-IDENTICAL | git diff + sed 切片 | normalizeCwd / nextActivityState / extractCwd / deriveTitle / SessionManagerClass 全部 _MATCH |
| typecheck | `npm run typecheck` (zsh -lc) | ✓ |
| vitest | 试跑 manager.test.ts | 被只读沙箱阻止（EPERM mkdir / write `node_modules/.vite/vitest/results.json`），由 lead 端在主 session 内已跑 14/14 全过 |

## 修复

无 HIGH / MED 必修项。LOW + 3 INFO 已在本份 review 同期 commit 修掉（一个独立 commit `docs: REVIEW_19 注释 stale 收口`）：

| # | 文件 | 改动 |
|---|---|---|
| L1 | `SessionDetail/ComposerSdk.tsx:49` | 英文 `,` → 中文 `，` |
| INFO-1 | `pending-rows/index.tsx:5-12` | 注释「三个 Row」→「4 个 Row」+ TeamPermissionRow 例外说明 |
| INFO-2 | `TeamDetail/index.tsx:24` | stale 「M2 不加」→ M3 现状 + 保留异步 cleanup 风险说明 |
| INFO-3 | `manager-helpers.ts:12` | 「无 IO 副作用」→「无 mutable state / 无写入副作用；normalizeCwd 会读 FS」 |
| INFO-4 | `TeamDetail/chrome.tsx:30,31` | 不修（`React.ReactNode === ReactNode` 类型等价，目录化拆分允许风格调整） |

## 关联 changelog

- [CHANGELOG_51.md](../changelog/CHANGELOG_51.md)：本次重构 P1+P2+P3+P4 全部内容

## Agent 踩坑沉淀

无新 agent-pitfall 候选；本期是又一次「机械式 + 字节级 verify」拆分，没有踩到新问题。

**仅记录一个 subagent 工具权限观察**（不升级约定，留作下次复审）：reviewer-codex subagent wrapper 在它的 process 内 Bash/Read 工具被沙箱拒绝，无法启动外部 codex CLI 也无法读 batch 输出文件。**lead 在主 session 内 Bash 工具完全可用**，按 CLAUDE.md `Fallback 手动模板` 节直接调外部 codex CLI 拿独立结论是合规备份姿势（异构原则保留 = 后端仍是 gpt-5.5）。

## 残留 / 后续

1. **保护文件未审范围**（按 CHANGELOG_51 §S5）：`SessionManagerClass` 主体 / `sdk-bridge.ts` class / `codex-cli/sdk-bridge.ts` / `stores/session-store.ts` / `claude-code/translate.ts` 各自需单独 plan + review，不在本份 scope
2. INFO-4 (`TeamDetail/chrome.tsx` ReactNode 风格调整) 不修，但若未来全仓 namespace import 风格统一时可一并归一
