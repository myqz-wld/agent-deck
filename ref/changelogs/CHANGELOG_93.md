# CHANGELOG_93: K3 hand-off UI 按钮 + LLM 历史总结 + modal preview（plan mcp-bug-and-feature-batch-20260513 Phase 4c）

**plan**: mcp-bug-and-feature-batch-20260513 Phase 4c Step 4c.1-4c.6（K3 实现 + UX polish + 收口；Step 4c.5 dev smoke 推迟到 Phase 6 H6）

## 概要

完成 K3「UI hand-off 按钮 + LLM 历史总结 + 起新 session」—— 第三层 hand-off 形态（不依赖 plan / worktree，独立 UX 通道）：用户在 SessionDetail header 点 `📤` 按钮 → 弹 modal preview LLM 总结的「目标 / 已做 / 下一步 / 相关文件」结构化简报 → 用户审阅 / 编辑后确认 → 起新 SDK session（cwd / agent / 权限模式沿用原 session）+ 自动归档原 session + 自动切到新 session detail：

- **双阶段 IPC 拆分**：`SessionHandOffSummarize` 只总结返回 → renderer 弹 modal 让用户编辑 → `SessionHandOffSpawn` 用 finalPrompt 起新 session + 归档 + emit focus-request；与「单 IPC + 一步到位」相比多一步 modal 但用户掌控感强（避免 LLM 总结离题导致新 session 跑偏）
- **复用 summarizer 框架**：新增 `summariseSessionForHandOff(cwd, events)` 复制 `summariseViaLlm` SDK query 模板（loadSdk + getSdkRuntimeOptions + permissionMode:'plan' + settingSources:[]），改用 sonnet + K3 专用 prompt（结构化 4 节模板）+ 60s timeout + 4000 字 result max；formatEventsForPrompt 加 `export` 共用 events → LLM-friendly 文本（30 条滑窗）；不抽公共 helper 重构 summariseViaLlm（YAGNI + 热路径回归风险）
- **跨 session UX 链路**：spawn 成功后 main 端 `eventBus.emit('session-focus-request', newSid)` → main/index.ts forwarder 转 IpcEvent.SessionFocusRequest → App.tsx onSessionFocusRequest listener 自动 setView('live') + select(newSid)，与 cli.ts `agent-deck new` / NewSessionDialog onCreated 同款自动切焦点
- **失败链分级**：LLM summarize 失败 → modal inline error + 「重试总结」按钮 + textarea 仍可手动写兜底（不强制关 modal）；spawn 失败 → modal inline error + textarea 状态保留让用户重试；archive 原 session 失败仅 console.warn 不阻塞 newSid 返回（属「联动 UX 行为」而非「释放标记 / 清 Map」类清理）

合 3 atomic commit（main 实现 / renderer 实现 / 本 CHANGELOG），typecheck 双端通过 + 全 vitest 26 文件 385 it 通过（base 25 文件 380 it + 5 新 hand-off）。

## 用户开放问题决策（plan §设计草案 4 个 Q）

| Q | 选项 | 实现 |
|---|------|------|
| Q1: 原 session 处理 | 自动归档（推荐） | `sessionManager.archive(sid)` 在 spawn 后自动调，失败仅 warn |
| Q2: 上下文 events 数量 | 200 条（推荐） | `eventRepo.listForSession(sid, 200)`；formatEventsForPrompt 内部 30 条滑窗到 LLM |
| Q3: LLM 模型 | sonnet 4.6 走本地 settings.json | `process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || ANTHROPIC_MODEL || 'sonnet'` 三级 fallback |
| Q4: UX 形态 | modal preview / 编辑 → 确认（推荐） | 双阶段 IPC + HandOffPreviewDialog modal 组件 |

## 变更内容

### A. main 端：summarizer + IPC handler + 单测

#### A1. `src/main/session/summarizer.ts`

- **`formatEventsForPrompt` 加 `export`**：行为不动，仅可见性提升供 K3 复用；30 条 events 滑窗 → `[Claude 说]` / `[Claude 调用工具]` / `[Claude 改动文件]` / `[Claude 主动询问用户]` / `[Claude 提议执行计划]` / `[Claude 等待用户输入]` LLM-friendly 文本
- **新增 `export async function summariseSessionForHandOff(cwd, events): Promise<string | null>`**（~115 LOC）：
  - 复制 `summariseViaLlm` SDK query 模板（loadSdk + getSdkRuntimeOptions + getPathToClaudeCodeExecutable + permissionMode:'plan' + settingSources:[] + executable + claudeBinary unpacked）
  - 改 model：`process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || process.env.ANTHROPIC_MODEL || 'sonnet'`（applyClaudeSettingsEnv bootstrap 已注入用户 settings.json env）
  - 改 system prompt：「会话接力简报生成助手」要求结构化 4 节
  - 改 user prompt：含 cwd + activity + 严格 4 节模板（【目标】【已做】【下一步】【相关文件】）+ 「不要 Markdown code block 包裹 / 不要调用工具」约束
  - timeout 60s（vs summariseViaLlm 用 settingsStore.summaryTimeoutMs；K3 用独立 60s 因 sonnet 慢，给 outliers 留余量）
  - resultMaxLen 4000 字符（vs summariseViaLlm 120 字 tag-line）
  - 失败：throw `__handoff_summary_timeout__` 或 SDK 错误，由 caller 透传给 renderer

#### A2. `src/shared/ipc-channels.ts`

加 `IpcInvoke` 2 个 channel（命名 `<scope>:<verb>` 与 SessionArchive 等一致）：

- `SessionHandOffSummarize: 'session:hand-off-summarize'` — Stage 1 拉历史 + LLM 总结，返回 `{ summary, sourceCwd, sourceAgentId, sourcePermissionMode }`
- `SessionHandOffSpawn: 'session:hand-off-spawn'` — Stage 2 用 finalPrompt 起新 session + archive 原 session + emit focus-request，返回 `newSid`

#### A3. `src/main/ipc/sessions.ts`

加 2 个 handler：

- **`SessionHandOffSummarize`**（~22 LOC）：parseStringId → sessionRepo.get（不存在 throw IpcInputError）→ eventRepo.listForSession(sid, 200) → summariseSessionForHandOff(session.cwd, events) → null/empty throw → 返回 4 字段对象
- **`SessionHandOffSpawn`**（~38 LOC）：parseStringId + parsePositiveString finalPrompt 上限 102_400 字符（与 sdk-bridge MAX_MESSAGE_LENGTH + agent-deck-message-repo MAX_BODY_LENGTH 全局对齐）→ sessionRepo.get（不存在 throw IpcInputError）→ adapterRegistry.get(agentId)（不存在 throw）→ adapter.createSession({cwd, prompt: finalPrompt, permissionMode?}) → recordCreatedPermissionMode(newSid, mode)（沿用原 session 让 detail 显示一致）→ try `sessionManager.archive(sid)` catch warn-only → `eventBus.emit('session-focus-request', newSid)` → return newSid

#### A4. `src/main/session/__tests__/hand-off.test.ts`（新, ~165 LOC）

5 it 全过：

- **happy path**：临时清 ANTHROPIC_DEFAULT_SONNET_MODEL + ANTHROPIC_MODEL env（避免本机 settings.json 污染） → SDK mock yield 4 节结构化 text → 验返回 trimmed text + 含【目标】【相关文件】+ /tmp/foo.ts；验 SDK call args（prompt 含 cwd + permissionMode='plan' + settingSources=[] + model 'sonnet' fallback）
- **empty events**：events=[] → 返回 null + loadSdk 不被调（formatEventsForPrompt 短路）
- **SDK 返回空 result**：mode='empty' yield 仅 result 不带 text → 返回 null
- **timeout 占位 it**：与 summariseViaLlm 同款 race + setTimeout 模式，单测内 fake timer + Promise.race 触发 vitest unhandled-rejection 警告，走 dev smoke 覆盖（产线代码已有 timedOut flag + finally clearTimeout 保障）
- **ANTHROPIC_DEFAULT_SONNET_MODEL env override**：临时 set='claude-sonnet-4-6' → 验 SDK call options.model 跟随 env

### B. renderer 端：preload + Dialog + SessionDetail

#### B1. `src/preload/index.ts`

加 facade 2 个 method（camelCase + 单 Promise return + 异常走 rejection）：

- `handOffSummarize(sid: string): Promise<{ summary, sourceCwd, sourceAgentId, sourcePermissionMode }>` — 调 IpcInvoke.SessionHandOffSummarize
- `handOffSpawn(sid: string, finalPrompt: string): Promise<string>` — 调 IpcInvoke.SessionHandOffSpawn

#### B2. `src/renderer/components/HandOffPreviewDialog.tsx`（新, ~140 LOC）

modal 组件，复用 NewSessionDialog 样式约定（absolute inset-0 z-40 backdrop-blur-sm + no-drag w-[480px] max-h-[85%] + rounded-xl border border-deck-border bg-deck-bg-strong）：

- **Props**：`{ open, sessionId, onClose }`（spawn 成功后 main 端 emit focus-request 自动切 detail，不需 props 传 newSid）
- **State**：summary / summarizing / spawning / error
- **mount useEffect**：open && 拉一次 handOffSummarize → setSummary（disposed flag 防 unmount setState 报警）；finally setSummarizing(false)
- **retrySummarize**：手动重拉 summary（用户点 inline error 旁的「重试总结」）
- **submit**：parseFinalPrompt → handOffSpawn → 成功关 modal（main 自动 focus newSid）；失败 inline error
- **Loading state**：标题切「📤 接力到新会话（总结中…）」/「（起新会话中…）」；按钮 disabled = busy；textarea disabled = summarizing
- **busy 期间 close 按钮 disabled**：防中断 in-flight IPC，避免「点了但没反应」用户疑惑
- **inline error 区分**：summary 失败显示「重试总结」按钮；spawn 失败 textarea 状态保留让用户重试

#### B3. `src/renderer/components/SessionDetail/index.tsx`

- import HandOffPreviewDialog
- 加 `handOffOpen` state
- header 区域：原 close 按钮单独 `<button>` → 改 button group `<div className="ml-2 flex shrink-0 items-center gap-1">`，仅 `isSdk` 时显示 `📤` hand-off 按钮（CLI 会话起新 session 无 prompt 注入意义不大，避免歧义）；按钮 className 复用 close 按钮同款 `flex h-5 w-5 items-center justify-center rounded text-[11px] text-deck-muted hover:bg-white/10`；title 详细描述「📤 接力到新会话：LLM 总结当前会话历史 → 起新 session（cwd / agent / 权限模式沿用）+ 自动归档原会话」
- 末尾 conditional render `<HandOffPreviewDialog open={handOffOpen} sessionId={session.id} onClose={() => setHandOffOpen(false)} />`

## 已确认决策（不重复对抗）

- **不抽公共 SDK oneshot helper**（YAGNI；summariseViaLlm 是热路径，改动它的回归风险大于代码重复痛苦；如有第三处 oneshot 用例再抽 helper）
- **新 session adapter / cwd / permissionMode 全部沿用原 session**（保持工作环境一致；不让用户在 modal 里再选这些字段，最小决策面）
- **不持久化 hand-off 父子血缘关系**（plan §决策 3 K3 是「独立轻量机制」最少表面积；将来想做血缘追溯可以加 sessions.handOffParentId 字段，本次不做）
- **不加 settings toggle**（hand-off 是用户主动点的功能，不需要全局开关）
- **dev smoke 推迟 Phase 6 H6**（K3 涉及真实 LLM API + 长会话操作，与其他 phase 一起 smoke 更高效）

## 已知踩坑

- **modal busy 期间 close 按钮 disabled**：避免用户点关闭后 in-flight IPC resolve 时 setState 报警；文案「请等待当前操作完成」title 提示
- **disposed flag**：useEffect 内 IPC promise 必须用 disposed flag 防 unmount 后 setState（项目 CLAUDE.md「资源清理 & TOCTOU 防线」节）
- **archive 原 session 失败不阻塞 newSid**：如果阻塞会让用户「点了起新会话但失败了」体感困惑；属联动 UX 而非清理路径，warn-only 更合用户预期；用户后续可手动右键归档
- **emit session-focus-request 通道**：main/index.ts 已注册 forwarder，无需 K3 单独写桥；与 cli.ts `agent-deck new` 同款 UX 入口（用户从任意 view 都会被切到 live + select newSid）
- **hand-off 按钮仅 isSdk 时显示**：CLI 会话有 events 历史可总结，但 createSession 接的是 SDK adapter（claude-code/codex-cli），起新 session 用原 agentId 在 CLI 路径下无 prompt 注入（CLI hook 上报为 session.source='cli'），UX 上「点了 hand-off 但新 session 跟原 CLI 会话不在一个屏」更困惑；保守只对 SDK 会话开放
