# CHANGELOG_28: 第二种 fork 边界兜底（jsonl 不在 → 预检 + 不带 resume 新建 + 手工 rename）

## 概要

CHANGELOG_27 修了第一种 fork 边界（CLI 给新 session_id 但流正常 → consume 内 OLD_ID → NEW_ID rename），用户实测 hilo-agent-opencode 项目历史会话仍崩：detail 卡在「⚠ SDK 通道已断开」+「⚠ SDK 流中断: No conversation found with session ID」+「会话结束」三条红字之间。根因 = **第二种 fork 边界**：`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` 文件不存在（CLI 自身清理 / 用户手动删 / 跨设备同步未带 jsonl 等），CLI `--resume <sid>` 直接 hard fail，consume 流中断 emit error message + finally session-end，createSession 本身不抛错（waitForRealSessionId 走 30s fallback 用 tempKey 注册无 SDK 状态的占位 session）。

本批在 recoverAndSend 内**预检 jsonl 是否存在**（比 try/catch + 字符串匹配错误 message 更可靠，正是 P12 教训），不存在则直接走不带 resume 的 createSession + 事后手工 rename(OLD_ID, newRealId) 把应用层 events / file_changes / summaries 子表迁过去。CLI 拿不到 jsonl 历史 context（Claude 像首条问），但应用层 DB 历史保留 + sessionId 通过同样链路切到新 ID。

## 变更内容

### 主进程 / adapter owner 层

#### `src/main/adapters/claude-code/sdk-bridge.ts`

- 顶部新增 import `existsSync from 'node:fs'` + `homedir from 'node:os'`
- 新增 protected 方法 `resumeJsonlExists(cwd, sessionId)`：拼 `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`（encoded-cwd 规则：把绝对路径 `/` 全替换为 `-` + 顶部前缀 `-`，实测 macOS）→ `existsSync`。catch 任意异常（cwd 解析 / FS 权限）→ 退化 return true 让 createSession 自己 try
- `recoverAndSend` 进入 createSession 前预检：jsonl 不在 → 走不带 resume 的新建路径（保留 cwd / permissionMode），事后手工查 sessions Map 找 cwd === rec.cwd 的最新 SDK session id 即 newRealId，调 `sessionManager.releaseSdkClaim(OLD_ID) + renameSdkSession(OLD_ID, newRealId)` 把应用层身份转过去
- jsonl 在 → 走原 createSession({resume,...}) 主路径，consume 内的 fork detection 处理 first realId ≠ resume 的「软 fork」（CHANGELOG_27 路径）

### 测试

#### `src/main/adapters/claude-code/__tests__/sdk-bridge.test.ts`

- TestBridge 加 `jsonlExistsOverride` 字段 + 覆盖 `resumeJsonlExists` 让单测不依赖真 ~/.claude/projects 目录
- 新增 1 case：jsonl 不存在 → fallback 走不带 resume 的 createSession + 占位 message 仍 emit + permissionMode 仍复原
- 7 case 全过（5 sendMessage 路径 + 2 consume fork detection）

### 文档 / 约定

#### `CLAUDE.md`「会话恢复 / 断连 UX（resume 优先）」节

- 把 CLI 隐式 fork 子条扩成两类：
  - **第一种（软 fork）**：jsonl 在 + CLI 给新 session_id → consume 内 OLD_ID → NEW_ID rename（CHANGELOG_27）
  - **第二种（jsonl 不在）**：CLI hard fail "No conversation found" → recoverAndSend 预检 + 不带 resume 新建 + 手工 rename（CHANGELOG_28）

## 验证

```bash
pnpm typecheck   # ok
pnpm vitest run  # 45/45（manager 13 + payload-truncate 12 + search-predicate 13 + sdk-bridge 7）
```

改 main 进程，按 CLAUDE.md 必须重启 dev：

```bash
lsof -ti:47821,5173 2>/dev/null | xargs -r kill -9
pkill -f "electron-vite dev" 2>/dev/null
pkill -f "Electron.app/Contents/MacOS/Electron" 2>/dev/null
pnpm dev
```

手测复现 → 验证：

1. 选一条 jsonl 已被 CLI 清理 / 不存在的历史 SDK 会话（如 hilo-agent-opencode 老会话）
2. detail 输入消息发送
3. 期望：
   - 活动流冒一行「⚠ SDK 通道已断开，正在自动恢复…」
   - 控制台 log 看到 `[sdk-bridge] resume jsonl missing for <OLD_ID> @ <cwd>, falling back to new CLI session` + `[sdk-bridge] post-fallback rename <OLD_ID> → <newRealId>`
   - **detail 内容连续接续**（应用层历史 events 都在），新对话被 Claude 正常回复（虽然 Claude 把它当首条问，没 jsonl context）
   - 实时面板**不冒新会话**

## 备注 / 决策追溯

- **预检 vs try-and-catch**：try createSession({resume}) → catch "No conversation found" → retry without resume 看着更优雅，但 createSession 内部 consume 把流错误吞了只 emit message 自己不抛错，catch 永远抓不到。预检是最稳的方案 + 不依赖 SDK 错误字符串匹配（正是 P12「依赖上游文档默认行为前必先实测验证」的延伸 —— 错误信息也算「上游文档」）
- **CLI 历史失去**：fallback 路径下 Claude 拿不到 jsonl，等于把这条新消息当首条问。但应用层 events 在 detail 里都看得到（用户回看完整对话），且 Claude 的回复会续在新 sessionId 名下。这比「红色无法恢复 + 让用户新建会话」体感好得多
- **encoded-cwd 跨 OS**：macOS / Linux 实测都是 `/` → `-` + 前缀 `-`；Windows 未验证。如果未来 CLI 改 encoding 规则，预检会假阴性（永远走 fallback 路径）→ 退化到原 try-and-fail 行为，最差不过用户体感回到 CHANGELOG_27 之前
- **CHANGELOG_25 → 26 → 27 → 28 是同一根因的四层修复**：25 删红条按钮 + 26 把恢复语义下沉 + 27 软 fork 兜底 + 28 hard fail 兜底。每层都是上一层暴露的边界
- 关联 [REVIEW_6.md](../reviews/REVIEW_6.md)：CLI fork 根因调研报告（结论同样适用本批）

## 上游 issue 待办（不阻塞）

CLI 的 jsonl 清理策略 + `--resume <sid>` hard fail 信号 + streaming + resume 隐式 fork 三件事都建议向 Anthropic Claude Code 团队提 issue。本批的 sdk-bridge 预检 + fallback 是 workaround，未来 SDK / CLI 提供更好的 API（如 resumeIfExists / resumable 检测接口）后可移除。
