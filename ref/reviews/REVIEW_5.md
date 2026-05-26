---
review_id: 5
reviewed_at: 2026-04-24
expired: false
skipped_expired: []
---

# REVIEW_5: 历史会话「继续聊天」实时面板出现两条 active 重复会话（用户报项）

## 触发场景

用户主诉：从「历史」tab 点开一个历史会话，在 SessionDetail 底部 ComposerSdk 输入消息发送后，左侧实时面板（SessionList）出现**两条 active 会话**，title/cwd 看起来完全一样。用户记不清原历史会话原状态，只确认两条都是「活跃」。

附带一条体感问题：长 message / thinking 「展开」后内容仍不完整（带 `[truncated XX bytes]` 标记），用户主诉「破截断逻辑修一下」。

## 方法

**双对抗配对**（`~/.claude/CLAUDE.md`「决策对抗」节）：

- **Agent A**：Claude 内部 `Plan` subagent，**Opus 4.7 xhigh**，挑刺型 prompt 写死要读的 9 个文件（manager / sdk-bridge / session-repo / SessionDetail / App / use-event-bridge / session-store / SessionList / session-selectors）+ 已知 SDK resume 行为提示，要求按可能性排序列出 3-5 条根因
- **Agent B**：外部 Codex CLI，**gpt-5.4 xhigh**（`zsh -i -l -c codex exec --sandbox read-only --skip-git-repo-check -c model_reasoning_effort=xhigh -C <abs> -o <out>`），同主题但更精简 prompt（只列文件清单 + 重点盲点 + 输出格式要求 300-500 字）

**实际执行**：

- 两 Agent 并发起单条消息内启动；A 用单实例（深度优先），B 起后台 codex 进程（约 6 分钟收齐）
- 关键结论现场用 Read 核实代码（dedupOrClaim 第二条 `!sessionRepo.get` 守卫位置 / waitForRealSessionId fallback emit / sessionRepo.rename toExists 分支 / renderer renameSession no-op 路径）
- 截断主诉用 Grep 盘点所有 `slice/truncate/max-h-` 后定位到 `payload-truncate.ts MAX_FIELD_BYTES = 8 * 1024`

**约束**：只查根因不立刻改代码；输出格式带 `文件:行号` + ≤5 行代码片段；不复述用户问题。

```text
src/main/session/manager.ts
src/main/store/session-repo.ts
src/main/adapters/claude-code/sdk-bridge.ts
src/main/adapters/claude-code/translate.ts
src/main/adapters/claude-code/hook-routes.ts
src/renderer/components/SessionDetail.tsx
src/renderer/App.tsx
src/renderer/hooks/use-event-bridge.ts
src/renderer/stores/session-store.ts
src/renderer/components/SessionList.tsx
src/renderer/lib/session-selectors.ts
src/main/store/payload-truncate.ts
src/renderer/components/activity-feed/rows/message-row.tsx
src/renderer/components/activity-feed/rows/thinking-row.tsx
src/renderer/components/activity-feed/rows/tool-row.tsx
```

```review-scope
src/main/adapters/claude-code/hook-routes.ts
src/main/adapters/claude-code/sdk-bridge.ts
src/main/adapters/claude-code/translate.ts
src/main/session/manager.ts
src/main/store/payload-truncate.ts
src/main/store/session-repo.ts
src/renderer/App.tsx
src/renderer/components/SessionDetail.tsx
src/renderer/components/SessionList.tsx
src/renderer/components/activity-feed/rows/message-row.tsx
src/renderer/components/activity-feed/rows/thinking-row.tsx
src/renderer/components/activity-feed/rows/tool-row.tsx
src/renderer/hooks/use-event-bridge.ts
src/renderer/lib/session-selectors.ts
src/renderer/stores/session-store.ts
```

## 三态裁决结果

### ✅ 真问题（双方独立提出且代码可证实）

| # | 严重度 | 文件:行号 | 问题 | A | B |
|---|---|---|---|---|---|
| 1 | HIGH | `src/main/session/manager.ts:191-208` + `src/main/adapters/claude-code/sdk-bridge.ts:425-440 / 838-861` | **两条 active record 同时出现的核心根因**：dedupOrClaim 第二条 cwd 兜底 claim 仅在 `!sessionRepo.get(id)` 时进入，而 resume 路径下 OLD_ID 在历史 DB 里**一定 existing**，hook（CLI 子进程内部 SessionStart 携带 OLD_ID）直接通过 → ensure 把 OLD_ID 复活成 `lifecycle:active, source:cli`；同时 SDK 通道 30s 内没拿到 first SDKMessage 时 fallback `emit({sessionId: tempKey, ...})` 会创建第二条 `lifecycle:active, source:sdk` record。两条 cwd/title 视觉相同 → 实时面板「两条 active 看起来一样」 | ✅ 提出 | ✅ 提出（候选 1） |
| 2 | MED | `src/main/store/payload-truncate.ts:23` | `MAX_FIELD_BYTES = 8 * 1024`：单字段 8KB 太激进，message / thinking / toolResult 稍长就被尾切 + `\n…[truncated XX bytes]` marker。即便 UI 点了「展开」（移除 max-h-72 限制）看到的也是 main 已经截过的版本 → 用户主诉「展开后内容也不全」 | ✅（追加盘点）| 主路径未提，盘点后定位 |

### ⚠️ 部分（叠加副作用，非独立根因）

| 现场 | A 视角 | B 视角 | 结论 |
|---|---|---|---|
| `session-repo.ts:189-216` rename `toExists` 分支 + `session-store.ts:405-433` renameSession `if (fromRec)` no-op | 30s fallback 后真实 OLD_ID 终于到达 → renameSdkSession(tempKey, OLD_ID)；rename SQL 删 tempKey + 子表迁过去；renderer 收到 session-renamed 时 store sessions.has(tempKey)=true 走移名 → tempKey 内容被改 id 为 OLD_ID 后覆盖 hook 复活那条 OLD_ID（source / permissionMode 字段错位） | 同方向 + 强调 renderer 残留路径（store 已收到 session-upserted(tempKey) 但后到的 rename 在没有 fromRec 时丢失同步） | ⚠️ 叠加副作用：不能产生第三份 record 但会让 source / permissionMode 字段错位；H4 修法（fallback 改用 OLD_ID 不再造 tempKey）天然消除这条 race |

### ❌ 反驳

| 报告方 | 报项 | 反驳依据 |
|---|---|---|
| Agent A | 候选 5：`SessionDetail.tsx:398` `msg.includes('not found')` 粗判可能误触 resume | 即便误触，仍只产生一条 NEW_ID 或 tempKey active record，不能匹配「两条都 active」 |
| Agent A | 候选 3：纯 30s fallback（hook 没装） | 只能产生一份 tempKey active；不匹配现象 |
| Agent B | 候选 3：用户连点「恢复会话」启动多个 SDK query | 每次 first id 都是 OLD_ID（resume 复用 sid）→ 后启动的 internal 覆盖前者，sessions Map 仍只有 OLD_ID 一份；可能造成消息重复但不是「两条 active record」根因 |

## 修复（CHANGELOG_24 落地）

### HIGH

1. **`src/main/adapters/claude-code/sdk-bridge.ts:151+ / 432 / 440-441 / 838-878`** — H4 双重防线
   - createSession 入口在 `expectSdkSession(opts.cwd)` 之后立即 `sessionManager.claimAsSdk(opts.resume)`（仅当 opts.resume 存在）：抢在 CLI 内部 hook 之前把 OLD_ID 加入 sdkOwned，hook 进 ingest 时第一道防线 `sdkOwned.has(event.sessionId)` 直接 skip
   - waitForRealSessionId 新增 `resumeId?` 参数，30s fallback emit 错误消息时用 `resumeId ?? tempKey` 作 sessionId：让 ingest 走 `existing` 分支不再创建 tempKey 占位 active record
   - catch 路径补 `if (opts.resume) sessionManager.releaseSdkClaim(opts.resume)`，避免失败后 sdkOwned 残留误吞同 sessionId 的真实 hook / 终端 CLI 会话

2. **`src/main/session/manager.ts:188-237`** — H1 dedupOrClaim 加 B 分支（双保险）
   - 在原 A 分支（`!sessionRepo.get(id)` + cwd 命中 pendingSdkCwds → claim）基础上新增 B 分支：hook 事件即便 sessionId 已 existing，cwd 命中 pendingSdkCwds 时也 claim + skip
   - 防御 sdk-bridge.ts H4 修法的极短窗口（expectSdkSession 已注册但 `claimAsSdk(opts.resume)` 还没到 microtask 调度）+ 任何未来可能的别的入口绕过预占 claim 的场景

### MED

3. **`src/main/store/payload-truncate.ts:23-32`** — `MAX_FIELD_BYTES` 从 `8 * 1024` 提到 `64 * 1024`
   - 8KB 在长一点的 message / thinking / tool result 上很容易被截，UI 即便点「展开」也只看到截断后版本
   - 64KB ≈ 2 万中文字符 / 6 万英文字符，覆盖绝大多数对话场景；与 256KB 总上限协调（最多 4 个 64KB 大字段）
   - 极长（> 64KB 单字段）仍截并保留 marker，避免 GB 级 Bash 输出 / 文件 dump 撑爆 SQLite

### 测试覆盖

- **`src/main/session/__tests__/manager.test.ts`** 新增 H1 case：「hook 抢先复活 OLD_ID（resume 路径）→ cwd 命中 pendingSdkCwds 即便 record 已存在也 skip+claim」，断言 record 仍 closed、source 仍 sdk、events 表无新增、session-upserted 没多余广播；后续同 id hook 也被 dedup
- payload-truncate 现有 12 个 test 全部用 `PAYLOAD_LIMITS.MAX_FIELD_BYTES + 100` 动态读阈值，64KB 改动无破坏；本批 38 / 38 测试 pass

### 用户保留 / 不动

- `src/renderer/components/activity-feed/rows/message-row.tsx:9` `COLLAPSE_THRESHOLD_CHARS = 800` + `max-h-72`、`thinking-row.tsx:8` `600 / max-h-56`、`tool-row.tsx` 多处 max-h —— 用户明确「默认折叠可以留着」（折叠入口对超长事件防止整列表撑成一面墙仍有价值），实际「展开后看不全」根因在 main 字段截断已修
- `SessionCard.tsx:181` 「在干嘛」预览 `text.slice(0, 80)` —— 用户明确「卡片预览 80 字不动」（实时预览定位）

## 关联 changelog

- [CHANGELOG_24.md](../changelog/CHANGELOG_24.md)：本次修复落地

## Agent 踩坑沉淀（如有）

本次根因调研用到 Agent 的「**对外部 SDK 行为先 WebSearch 确认（claude-agent-sdk resume 默认是否 fork）**」节奏 —— 比直接读源猜更高效。代码注释里写「session_id 就是这个 sid」是对的（默认不 fork），但**没说 hook 通道 SessionStart 会同步携带这个 sid 抢先到达**，dedupOrClaim 守卫的盲点 = 设计假设与实际时序之间的缺口。同主题候选可放 `.claude/conventions-tally.md`「Agent 踩坑候选」section：「外部 SDK 行为对 manager dedup 时序的影响必须在引入 SDK 时画一遍 `(SDK 通道首条事件 ts) vs (CLI 内部 hook 首条事件 ts)` 时间轴」。当前只是单点踩坑，count 够 3 再升级。
