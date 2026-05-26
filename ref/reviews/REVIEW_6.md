---
review_id: 6
reviewed_at: 2026-04-24
expired: false
---

# REVIEW_6: SDK CLI 隐式 fork 根因调研（resume 路径下 first session_id ≠ opts.resume）

## 触发场景

CHANGELOG_26（B 方案）落地后用户实测：在 dormant/closed 历史 SDK 会话 detail 输入 "hello" 发送，活动流冒一条「⚠ SDK 通道已断开，正在自动恢复…」占位 message 后**无下文**；同时实时面板冒一条新 SDK 会话 = NEW_ID（hello / 你好对话全在 NEW_ID 名下）。等于「点了恢复后表现像新开会话」体感未根治，CHANGELOG_25 总纲「凡让用户感觉像新开会话都是 bug」被违反。

用户追问后启对抗调研。

## 方法

**双对抗配对**（见 `~/.claude/CLAUDE.md`「决策对抗」节）：

- **Claude Opus 4.7 xhigh subagent**（Explore + general-purpose）：读 sdk.d.ts / sdk.mjs / sdk-bridge.ts / manager.ts，追 resume 在 SDK 内部如何翻译；在线写最小复现脚本 `/tmp/repro-resume-fork.mjs` 直接调 `query({prompt, options:{resume,cwd}})` 实测 first session_id
- **Codex CLI gpt-5.4 xhigh**（独立读同范围 + sdk.d.ts:1175-1260 / sdk-bridge.ts:400-430,1039-1065 / manager.ts:406-412 / CHANGELOG_24:58）：独立判定 fork 触发层级 + 修法可行性

**范围**：
- SDK 包装层：`node_modules/@anthropic-ai/claude-agent-sdk/sdk.{mjs,d.ts}`
- 应用 adapter：`src/main/adapters/claude-code/sdk-bridge.ts` createSession + waitForRealSessionId + consume
- 应用 manager：`src/main/session/manager.ts` dedupOrClaim + ensure + renameSdkSession
- 关联记录：`changelog/CHANGELOG_24.md` 备注（fork 边界预警）+ `changelog/CHANGELOG_26.md`（B 方案上下文）

**机器可读范围**（File-level Review Expiry 用）：

```review-scope
src/main/adapters/claude-code/sdk-bridge.ts
src/main/session/manager.ts
src/renderer/App.tsx
```

**约束**：本次 review 不修改 / 不审 manager / sessionRepo 主时序逻辑（REVIEW_5 / CHANGELOG_24 刚加固完），只查 fork 边界 + adapter 层适配方案。

## 三态裁决结果

### ✅ 真问题（双方独立 + 实测一致）

| # | 严重度 | 文件:行号 | 问题 | A | B |
|---|---|---|---|---|---|
| 1 | HIGH | `sdk-bridge.ts:1039-1066`（修复前） | `consume()` 只处理 `tempKey !== realId` 的 rename，没处理 `opts.resume && realId !== opts.resume` 分支 → CLI fork 时 NEW_ID 被 manager.ensure 当全新会话落库，OLD_ID record 不动 → 用户场景下「detail 卡占位 + 实时面板冒新会话」 | ✅ | ✅ |
| 2 | INFO | `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` | sdk.mjs 把 `resume` 翻译为 `--resume <ID>`；`--fork-session` flag 只在显式 `forkSession=true` 时加。我们没传 forkSession → SDK 包装层是干净的，fork 不在 SDK | ✅ | ✅ |
| 3 | INFO | `~/.nvm/versions/node/v24.10.0/bin/claude` (CLI native binary, 207MB) | CLI 在 `forkSession=false` 时仍试图沿用旧 id（codex 找到了相关 JS 包装层 line 27312-27318 / 8621-8665），但**实测 first session_id ≠ resume**，证明 fork 在更深的 native binary 内（不可读源码）。可疑触发条件：streaming input mode + resume + 新 prompt 让 CLI 内部强制 fork 避免污染原 jsonl 状态机 | ✅ | ✅ |

### ⚠️ 部分（双方角度不同）

| 现场 | A 视角 | B 视角 | 结论 |
|---|---|---|---|
| 修法方向 | F1 正向 rename（OLD_ID record + 子表整体 rename 成 NEW_ID）+ F2 反向 alias（NEW_ID 永远翻译成 OLD_ID 对外）两种都列 | 推 F1（renameSdkSession 已存在，复用即可；不建议磁盘层 jsonl rename） | F1 落地：codex 推荐 + A 推荐路径其一 + 工程量最小 + 复用现有 API |

### ❌ 反驳

无（两 Agent 结论一致 + 最小复现脚本铁证）。

## 实测证据

最小复现脚本 `/tmp/repro-resume-fork.mjs`：

```javascript
import { query } from '@anthropic-ai/claude-agent-sdk/sdk.mjs';
const RESUME_ID = '00356caf-8a33-46a2-9d99-09c46fef93cc'; // jsonl 文件确认存在
const q = query({
  prompt: userInputAsyncIterable(),
  options: { cwd: '/Users/apple/Repository/personal/agent-deck', resume: RESUME_ID, ... },
});
for await (const msg of q) {
  if (msg.session_id) {
    console.log(`first session_id from SDK: ${msg.session_id}`);
    console.log(`=== RESUME_ID ? ${msg.session_id === RESUME_ID}`);
    break;
  }
}
```

**输出**：

```
[repro] resume=00356caf-8a33-46a2-9d99-09c46fef93cc
[repro] FIRST session_id from SDK: 512dee8d-32d8-4310-b7f9-49de9fa0b324
[repro] === RESUME_ID ? false   ← CLI 静默 fork
```

铁证：相同条件下 CLI 行为偏离 SDK 文档（sdk.d.ts:1255-1258 写「forkSession=false 默认续同 ID」）。这是上游 Claude Code CLI 自身的内置行为，应用层无法关掉。

## 修复（CHANGELOG_27 落地）

### HIGH

1. **`sdk-bridge.ts` consume()** — 加 fork detection 分支：first realId 拿到时 if `resumeId && resumeId !== realId` → `releaseSdkClaim(resumeId)` + `renameSdkSession(resumeId, realId)`，把 OLD_ID 的 DB record + 子表（events / file_changes / summaries）整体迁到 NEW_ID 名下；renderer 通过已有 `session-renamed` 事件链路自动切 selectedSessionId / sessions Map / by-session state（store.renameSession 已实现）
2. **`waitForRealSessionId`** signature 加 resumeId 参数透传给 consume；createSession 调用处已经有 opts.resume，链路通
3. **`App.tsx`** — historySession 是本地 state，store.renameSession 不知道它；加 `window.api.onSessionRenamed` listener 单独切 historySession.id，否则 detail 卡在已删除的 OLD_ID record

### MED

4. **`sdk-bridge.test.ts`** — 补 2 case 覆盖 fork 路径：(a) realId ≠ opts.resume → renameSdkSession 被调（OLD_ID, NEW_ID）+ release OLD claim；(b) realId === opts.resume → 不触发 fork 分支（不调 SAME_ID, SAME_ID 这种空 rename）

### LOW

5. **`CLAUDE.md`「会话恢复 / 断连 UX」节** — 补 fork 边界注释：CLI 在 streaming + resume 下隐式 fork 是上游 SDK / Claude Code CLI 自身行为，应用层在 sdk-bridge.consume 内做 OLD→NEW rename 适配；约定改动以未来 SDK 修复为准

## 关联 changelog

- [CHANGELOG_27.md](../changelog/CHANGELOG_27.md)：本次修复落地

## Agent 踩坑沉淀

本次 review 提炼出 1 条 agent-pitfall 候选（写入 `.claude/conventions-tally.md`「Agent 踩坑候选」section）：

> **U3：依赖上游文档默认行为前必先实测验证**
>
> 触发：CHANGELOG_24 备注「SDK 默认 resume: sessionId（不 fork）路径完全收敛」基于 sdk.d.ts 文档断言，但实测 CLI 行为完全相反 → CHANGELOG_26 B 方案落地后用户场景仍然崩
>
> 教训：涉及上游 SDK / CLI 行为的关键假设（fork / resume / streaming 等）必须最小复现脚本实测一遍，文档与实际行为不符是常态而非例外
