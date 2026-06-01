# CHANGELOG_195 — resume/fallback 注入 DB 真实历史消息（总结 + 最近 N 条原始对话）

## 概要

升级「丢消息的 resume」——jsonl-missing fallback 起 fresh CLI/thread 时，除了原有 LLM 总结段，**额外注入应用内 DB（events 表）最近 N 条原始对话消息**，让 Claude/Codex 续聊不只看压缩总结，还能看到原始上下文细节（背景：本会话从 SQLite 还原丢失会话上下文的经历本身就证明「原始消息比总结更可靠」）。

同时**首次接通 codex 端历史注入**（codex 原本完全不注入，只 emit「请下条消息把背景给 Codex」）—— 解开 [REVIEW_60](../reviews/REVIEW_60.md) F5 待办（卡在「`prependHistorySummary` 耦合 claude `MAX_MESSAGE_LENGTH` + codex 总结函数签名不同」）。claude/codex 两端现走同一 adapter 无关共享层、同款三段结构、同款 N、同款总结（都走本地 OAuth claude oneshot，agentName 按 adapter 视角参数化）。

承接 [plan `resume-inject-raw-messages-20260601`](../plans/resume-inject-raw-messages-20260601.md)（RFC 三轮 + 4 spike + Deep-Review R1-R4 收口 + worktree 隔离实施）。**架构地基（spike4 codex 源码铁证）**：当前 SDK 版本下传 app DB 文本历史给新会话的唯一正确做法 = 拼 1 条结构化 user message（`shouldQuery` 逐条 append / 多条 AsyncIterable message / `SDKUserMessageReplay` 全是死路）。

`hand_off_session` 不动（baton 单向交接，注入对话历史不符合其语义）。

## 变更内容

### Step 1 — 新建 adapter 无关共享层（`src/main/session/resume-history/`）

- `inject-history.ts` `injectResumeHistory(opts)`：拼「总结段 + 最近原始对话消息段 + 用户当前消息」三段结构化文本。
- 签名参数化解耦：`maxLength`（两端同传 102_400，去 claude constants 耦合）/ `agentName`（'Claude'|'Agent'）/ `recentMessagesCount` / `maxEventIdFn`(thunk) / 双数据源 `listEventsFn`(全量喂总结) + `listMessagesFn`(message-only 拼 raw 段)。
- **预算式拼接** `buildRawSegment`：raw 列表从最新往旧逐条加入，累计逼近预算（`maxLength − 总结段 − 当前消息 − wrapper`）就停（动态条数 ≤ N，优先保最新对话，恒 fit）+ `.reverse()` 成 chronological 升序。
- **D6 降级链**（永不抛错，§不变量 1）：`original-over-length`（唯一阻塞态，caller 不进 createSession）/ `no-history` / `over-length-dropped-summary`（总结段超大丢总结保 raw）/ `summary-failed-raw-used`（总结 throw/null/空仍注 raw，§D7 原始消息更可靠）/ `history-budget-empty`（wrapper 边界兜底，正常不可达）。
- 4 个 thunk（maxEventIdFn/summariseFn/listEventsFn/listMessagesFn）全在 helper 内 try/catch（任一抛错降级继续 fallback，永不阻塞 fresh CLI/thread）。

### Step 2 — message-only repo 查询（`src/main/store/event-repo.ts`）

- `listRecentMessages(sessionId, limit, beforeIdInclusive?)`：SQL `kind='message' AND role IN ('user','assistant') AND (error IS NULL OR error=0) [AND id <= ?] ORDER BY ts DESC, id DESC LIMIT ?`。直接拿正好 N 条对话，不受 raw events 密度影响（`listForSession` 默认 limit=200 会被 tool-use 占满取不到更早对话）。
- `maxEventId(sessionId)`：`SELECT MAX(id)`（无 row 返 null）。caller 在 entry emit user 前固化作 `beforeIdInclusive` 边界，`<=` 保留 emit 前全部历史 + 排除 emit 的当前消息（off-by-one：`<` 会漏掉最后一条真实历史）。

### Step 3 — agentName 参数化总结 runner（`src/main/session/summarizer/llm-runners.ts`）

- `summariseSessionForHandOff(cwd, events, agentName='Claude')` 加可选第三参（向后兼容所有现有 caller；codex fallback 传 'Agent' 让 codex 会话总结不自称「Claude 会话」）。

### Step 4 — settings 字段（`resumeRecentMessagesCount`）

- 加到 `app-settings.ts` + `defaults.ts`（default 30）+ 设置面板「生命周期」section NumberInput（min=1，与 historyRetentionDays 同属会话历史/恢复语义）。即改即生效（消费侧每次 fallback 临时 `settingsStore.get`，无 apply* helper）。
- **删 `autoSummariseOnFallback`**（UI toggle 早删成孤儿）：app-settings decl + defaults 删 + `settings-store.ts REMOVED_KEYS` 加清历史孤儿 + ExperimentalSection/AgentDeckMcpSection 注释同步。fallback 路径改**无条件注入**（DB 有历史就注，§不变量 7）。

### Step 5 — claude 接入（`claude-code/sdk-bridge/`）

- `jsonl-fallback.ts maybeJsonlFallback` 改调 `injectResumeHistory`（替原 `prependHistorySummary`）+ `original-over-length` throw 给 caller catch（不进 createSession，覆盖 restart 传 handoffPrompt 含 plan 无 cap 的 caller）。
- `JsonlFallbackCtx` 加 `listMessagesFn` / `JsonlFallbackOptsBase` 加 `maxEventIdFn`。
- `index.ts` 加 protected `listRecentMessagesForSession` wrapper + RestartController/SessionRecoverer ctor 传 `listMessagesFn`。
- `recover-and-send-impl.ts` 在 entry emit user **前**固化 `maxEventIdBefore` + 传 `() => maxEventIdBefore`。restart-controller 2 caller 传 `listMessagesFn` + `maxEventIdFn: () => null`（restart handoffPrompt 不入库无需排除）。
- 删 `recoverer-helpers.ts`（`prependHistorySummary` 平移到共享层）。

### Step 6 — codex 接入（首次接通历史注入，对称 claude）

- `recoverer.ts` ctor +3 thunk（summariseFn/listEventsFn/listMessagesFn；maxEventIdFn 不走 ctor，recover-and-send-impl 直接 `eventRepo.maxEventId` 在 entry emit 前固化）。
- `recoverer/_deps.ts` 加 4 thunk type；`recover-and-send-impl.ts` `RecoverAndSendDeps` +3 + 固化 maxEventIdBefore。
- `codex-jsonl-fallback.ts` `CodexJsonlFallbackCtx` +3 / `CodexJsonlFallbackOpts` +prependCwd+maxEventIdFn；调 `injectResumeHistory`（agentName='Agent'）+ `original-over-length` throw + emit 双 builder（`buildCodexJsonlMissingSummaryUsed/SkippedText` 替旧单一 `NoSummaryText`）。
- `index.ts` `new SessionRecoverer(...)` +3 实参 + 3 protected wrapper（summariseForHandOff bind `summariseSessionForHandOff(_,_,'Agent')` / listEventsForSession / listRecentMessagesForSession）+ import eventRepo + summariseSessionForHandOff。
- jsdoc 同步（recoverer/_deps/codex-jsonl-fallback/codex-recoverer-messages「codex 无 LLM 摘要 prepend」→「已与 claude 对称」）。

### Step 7 — 测试

- `resume-history/__tests__/inject-history.test.ts`（16 it，纯函数直注）：双数据源 / 三段顺序 / chronological reverse / agentName 前缀 / maxEventIdFn 作 beforeId + null 退化 / 4 thunk throw 永不抛错 / 各 failReason / 预算式动态条数。
- `store/__tests__/event-repo-recent-messages.test.ts`（11 it，SQLite 真测走 binding skip 守门 `pnpm test` Electron-as-node）：role/error/非 message 过滤 / 「最近 200 全 tool-use + 更早 message」/ LIMIT N / id DESC tie-breaker / beforeIdInclusive off-by-one `<=` / maxEventId / 跨 session 隔离。
- claude/codex recovery + jsonl-fallback + restart 回归全绿；修 helper 逻辑 bug（summariseFn 返 null 现正确标 `summary-failed-raw-used`）。
- **全套 113 文件 / 1541 测试全绿**（Electron-as-node binding 真跑无 corruption）；typecheck + build 双绿。

## 不变量

1. **永不阻塞 fallback 主路径**：注入任何环节失败一律分级降级，fresh CLI/thread 必须能起来（唯一例外 `original-over-length` 让 caller 不进 createSession + emit 清晰错误）。
2. 注入 = 总结段 + 原始消息段 + 当前消息，三段顺序固定；总结段可降级缺省，原始消息段 + 当前消息是底线。
3. 不持久化（每次 fallback 重算）。
4. 双数据源都走 DB（不碰 jsonl，jsonl 丢失正是触发本路径的原因）。
5. 两端行为对称（同款三段 / N / 总结 / 文案仅 adapter 视角差异）。
6. cap 参数化保留（102_400）+ 预算式拼接（raw 段恒 fit）。
7. 无条件注入（删 autoSummariseOnFallback 开关）。
