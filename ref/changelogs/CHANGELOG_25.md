# CHANGELOG_25: 应用内会话「断连自动续」+ 历史 detail 跟随 sessions Map

## 概要

用户反馈「不要弹恢复对话按钮再让用户点一次，直接连贯更好」+「点了恢复后表现像新开了个会话」。本次把 ComposerSdk 的「会话已断开」红条 + 「恢复会话」按钮删掉，sendMessage 抛 `not found` 时直接走 SDK resume 流程，对外只表现为「这条消息发出去了」；同时把 App.tsx 历史 tab 的 detailSession 接到 sessions Map，让 closed→active 复活立刻被 detail 看见，不再卡在 fetch 时的静态拷贝上。

## 变更内容

### 渲染层 / 输入框

#### `src/renderer/components/SessionDetail.tsx`（ComposerSdk）

- 删除 `resumable` / `resuming` state 和 `resume()` 函数，sendError 红条里的「恢复会话」按钮一并去掉
- `send()` catch 分支按错误类型分流：`msg.includes('not found')` → 直接 `await window.api.createAdapterSession(agentId, { cwd, prompt: t, resume: sessionId })`，整段 try/catch 内 busy 锁定到 resume 完成 / 失败为止，用户看到的就是「发送中… → 完成」一段连贯过程
- resume 失败回退原 text + 显错（前缀「自动恢复失败」），其它错误（字节超限 / 队列满 / SDK 内部异常）保持原行为：回退 text + 显原 message
- 注释强调：sessionId 不变 → SessionDetail 不会切到「新会话」；sdk-bridge H4（CHANGELOG_24）走 resume 路径不会造重复 active record；副作用是 SDK fallback 最长 30s 才恢复（已在 sdk-bridge 兜底）

### 渲染层 / 视图派生

#### `src/renderer/App.tsx`

- `detailSession` 在 `view === 'history'` 时也优先从 `sessions.get(historySession.id)` 取最新 record，fallback 到 `historySession` 自身（id 还没 upsert 的瞬间兜底）
- 解决「历史 detail 里发消息触发自动恢复 → 后端把 lifecycle 从 closed 复活到 active 并广播 session-upserted → store.sessions 已更新但 historySession 是 fetch 时静态拷贝 → SourceBadge / ComposerSdk 仍按旧 record 走」造成的「点了恢复后表现像新开了个会话」误解
- 行为兜底：HistoryPanel 自身列表不会自动 reload，那条 active 仍可能临时留在历史列表里，但用户进入 detail 看到的就是真实 active 状态；下次切 filter / 进列表 reload 就会从历史列表消失

## 验证

```bash
pnpm typecheck   # ok
pnpm vitest run  # 38/38（manager 13 + payload-truncate 12 + search-predicate 13）
```

改 renderer，HMR 自动推送，不需要重启 dev。建议手测：

1. 触发断连：dev 期间重启 main / 等会话 lifecycle 走到 dormant、closed
2. 历史 tab 选这条会话 → detail 输入消息 → 直接发送
3. 期望：busy 转圈 → 完成；不再弹「会话已断开」红条；detail 里看到 lifecycle 已变 active；左侧实时面板这条会话继续工作

## 备注

- 本次不动 sdk-bridge / manager / session-repo —— REVIEW_5（CHANGELOG_24）已经把 resume 路径下两条 active record 的根因修了，本次只是把上层 UX 也做平滑
- 顺手补史 detail 跟随 sessions Map 这个改动很小但很关键 —— 没它的话「自动恢复」即便后端走通，用户在 history 入口看到的 detail 仍是旧 record，会以为「自动恢复也没用」
- `historySession` 这个独立 state 暂时保留（HistoryPanel 单条 fetch 走的是后端 getSession，不一定 ID 都在 store 里）。彻底统一到 selectedSessionId 是更大重构，超出本次范围
- CHANGELOG_24 备注里提到的「用户连点恢复多次起多个 SDK query」边界仍在 —— 自动续后 busy=true 锁定到 resume 完成为止，正常路径下不会触发；如果 resume 自身阻塞 30s（waitForRealSessionId fallback），用户多按几次 send 也会被 `if (!t || busy) return` 提前挡住，不存在比手动按钮路径更糟的并发

## 约定升级（同批次延伸）

`.claude/conventions-tally.md` U2 候选随本次反馈累计到 count=3，走双对抗三态裁决（Claude Opus 4.7 xhigh subagent + codex CLI gpt-5.4 xhigh，结论一致：**修改后落地**），新建「**会话恢复 / 断连 UX（resume 优先）**」节升入 [CLAUDE.md](../CLAUDE.md)「项目特定约定」，放「事件去重与生命周期」节之后。修订点：

- 总纲句：「凡让用户感觉像新开会话 / 跳回列表 / 还要点恢复按钮的路径都是 bug」
- 边界限定：仅 `'not found'` 类信号触发自动 resume；字节超限 / 队列满 / 鉴权异常等透传 sendError
- busy 锁定子条：自动 resume 期间 send 入口锁定到完成 / 失败为止
- 措辞修正：删掉草稿「能 resume 的会话保留 dormant」（与 manager 现状不符 —— closed→active 复活路径仍走）+「内部 id 切换用 sessionRepo.rename」（实际 resume 路径不切 id；切 id 走 `renameSdkSession` 仅 SDK fallback tempKey→realId 路径）
- detail 视图权威性：`store.sessions` Map 优先，本地临时 state 只兜底
