# CHANGELOG_27: CLI streaming + resume 隐式 fork 兜底（consume 内 OLD_ID → NEW_ID rename）

## 概要

CHANGELOG_26（B 方案）落地后用户实测「点了恢复后表现像新开会话」体感未根治：detail 卡在「⚠ SDK 通道已断开」占位 message 后无下文，实时面板冒一条新 SDK 会话。REVIEW_6 双对抗 + 最小复现脚本铁证根因 = **Claude Code CLI 在 streaming input + resume + 新 prompt 下隐式 fork**（与 sdk.d.ts:1255-1258 文档「forkSession=false 默认续同 ID」不一致）。本批在 sdk-bridge.consume() 内补 fork detection 兜底：first realId ≠ opts.resume 时把 OLD_ID 整体 rename 成 NEW_ID（DB record + events + file_changes + summaries 子表全迁），renderer 通过现有 session-renamed 链路自动切 selectedSessionId / sessions Map。

## 变更内容

### 主进程 / adapter owner 层

#### `src/main/adapters/claude-code/sdk-bridge.ts`

- `consume()` signature 加 `resumeId?: string` 参数
- `consume()` 内 first realId 拿到时新增 fork detection 分支：
  ```ts
  if (resumeId && resumeId !== realId) {
    sessionManager.releaseSdkClaim(resumeId);
    sessionManager.renameSdkSession(resumeId, realId);
  }
  ```
  调 `sessionRepo.rename` 把 OLD_ID record + 子表（events / file_changes / summaries）整体迁到已存在的 NEW_ID（manager.ensure 已先创建 NEW_ID record，`sessionRepo.rename` 走 toExists 分支：不复制 fromRow 但子表全迁，再 delete fromRow）
- `waitForRealSessionId` 调 consume 时透传已有的 `resumeId` 参数

### 渲染层 / 视图派生

#### `src/renderer/App.tsx`

- 新增 `useEffect` 监听 `window.api.onSessionRenamed`：当 historySession.id === from 时切 historySession.id 到 to
- 解决「fork 触发 rename → store.sessions 已切 NEW_ID 但 historySession 是本地 state（store 不知道它）→ detail 仍按 OLD_ID 走 → ComposerSdk 调 sendAdapterMessage(OLD_ID) 又触发 not found → 又一轮 recovery → 死循环」

### 测试

#### `src/main/adapters/claude-code/__tests__/sdk-bridge.test.ts`

新增 2 case 覆盖 fork detection：

5. **first realId ≠ opts.resume → 调 sessionManager.renameSdkSession(OLD_ID, NEW_ID) + release OLD claim**：用 fake async generator 模拟 SDK 流（first message 带 NEW_ID），断言 sessionManager.releaseSdkClaim / renameSdkSession 被调
6. **first realId === opts.resume → 不触发 fork 分支**：断言 renameSdkSession(SAME_ID, SAME_ID) 没被调（防止误触发空 rename）

### 文档 / 约定

#### `CLAUDE.md`「会话恢复 / 断连 UX（resume 优先）」节

- 补 fork 边界子条：「Claude Code CLI 在 SDK streaming + resume + 新 prompt 下隐式 fork（实测铁证 REVIEW_6），sdk-bridge.consume 必须有 OLD_ID → NEW_ID rename 兜底（CHANGELOG_27）；这是 CLI native binary 内置行为，应用层无法关掉，约定改动以未来 SDK 修复为准」

#### `.claude/conventions-tally.md`

- 新增 U3 Agent 踩坑候选（count=1）：「依赖上游文档默认行为前必先实测验证」

## 验证

```bash
pnpm typecheck   # ok
pnpm vitest run  # 44/44（manager 13 + payload-truncate 12 + search-predicate 13 + sdk-bridge 6）
```

改 main 进程，按 CLAUDE.md 必须重启 dev：

```bash
lsof -ti:47821,5173 2>/dev/null | xargs -r kill -9
pkill -f "electron-vite dev" 2>/dev/null
pkill -f "Electron.app/Contents/MacOS/Electron" 2>/dev/null
pnpm dev
```

手测复现 → 验证：

1. 触发断连（dev 期间重启 main / 等会话 lifecycle 走到 dormant、closed）
2. 历史 tab 选这条 SDK 会话 → detail 输入消息 → 直接发送
3. 期望：
   - 活动流冒一行「⚠ SDK 通道已断开，正在自动恢复…」
   - 几秒后 SDK 启动，控制台 log 看到 `[sdk-bridge] CLI forked: requested resume=OLD_ID but got realId=NEW_ID; renaming OLD record → NEW`
   - **detail 内容连续接续**（不再卡占位 message）
   - 实时面板**不冒新会话**（OLD_ID 已 rename 成 NEW_ID，只是 ID 字段变了内容连续）
   - 后续 send 走 NEW_ID 正常工作

## 备注 / 决策追溯

- **根因不在我们代码**：CLI native binary 内置 fork 行为，sdk.d.ts 文档说「forkSession=false 不 fork」与实测不符。无可读源码（CLI 是 207MB native binary）。可疑触发条件：streaming input + resume + 新 prompt 让 CLI 内部强制开新 session_id 避免污染原 jsonl 状态机
- **修法是 sdk-bridge 层适配**：把 OLD_ID 的 DB record + 子表全迁到 NEW_ID 名下（codex 推荐 + Opus 4.7 subagent 推荐路径之一）；副作用：会话 id 字段变了（与 jsonl 文件名一致），但 UI 不显示 sessionId 给用户，体感等同「会话续上」
- **F2 反向 alias 方案没采纳**：sdk-bridge 内部维持 external_id=OLD_ID + sdk_real_id=NEW_ID 双 ID 映射工程量大且 fragile（每个 emit / sessions Map 操作要区分），下次再恢复同会话又 fork 出 NEW_ID2 → 杂物文件累积；F1 正向 rename 复用现有 renameSdkSession + 文件层一致
- **CHANGELOG_24 备注早预警过这个边界但没修**：当时基于「SDK 默认不 fork」假设写的「当前不在范围内」，本批用最小复现脚本验证假设错误后落地兜底。教训写入 .claude/conventions-tally.md U3
- **CHANGELOG_25 + CHANGELOG_26 + CHANGELOG_27 是同一根因的三层修复**：25 修 UX（删红条按钮直接走自动续）+ 26 把恢复语义下沉到 sdk-bridge.sendMessage（B 方案）+ 27 在 consume 内补 fork 兜底（最深层根因）
- 关联 [REVIEW_6.md](../reviews/REVIEW_6.md)：本次 review 报告

## 上游 issue 待办（不阻塞）

CLI 在 forkSession=false + streaming input + resume + 新 prompt 下隐式 fork 与文档不符，建议向 Anthropic Claude Code CLI 团队提 issue 让它修。本批的 sdk-bridge.consume 兜底是 workaround，未来 SDK / CLI 修复后可移除。
