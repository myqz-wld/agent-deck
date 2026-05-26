# CHANGELOG_26: 断连自愈下沉到 sdk-bridge（B 方案）+ 30s UX 占位 + 单飞锁

## 概要

用户对 CHANGELOG_25 的 A 方案追问「这是最好的方案吗，还是只是考虑了成本」。承认 A 是 trade-off 后，启双对抗 Agent（Claude Opus 4.7 xhigh subagent + codex CLI gpt-5.4 xhigh）评估 A/B/C/D 候选，结论一致 **B 方案最优**：把断连恢复语义从 renderer ComposerSdk 下沉到 sdk-bridge.sendMessage 内部。本次完成 B 落地 + 配套 30s UX 占位 message + 单飞锁 + 4 case vitest 覆盖。

## 变更内容

### 主进程 / adapter owner 层（B 方案核心）

#### `src/main/adapters/claude-code/sdk-bridge.ts`

- 类内新增 `recovering: Map<sessionId, Promise<void>>` 单飞表
- `sendMessage` 检测 `!this.sessions.has(sessionId)` 时不再 `throw 'not found'`，改为委托新的 `recoverAndSend(sessionId, text)`，返回后保持原 API 语义（永远成功 / throw 真错）
- 新增私有方法 `recoverAndSend`：
  - **单飞**：拿到 `recovering.get(sessionId)` inflight 后等它完成 → 再调 `this.sendMessage(sessionId, text)` 走完整 push 路径（不让等待者塞同一个 createSession 首条 prompt）
  - **record 不在**：抛 `session ${sessionId} not found` 与原行为一致，让 IPC 把错原样透传
  - **字节上限校验**：恢复路径不绕过 MAX_MESSAGE_BYTES，防超长 prompt 被当作首条消息送进 createSession
  - **占位 message**：进入恢复立刻 emit `{kind:'message', text:'⚠ SDK 通道已断开，正在自动恢复…'}` 非 error，让 UI 在 30s fallback 期间不哑巴 busy
  - **完整复用 createSession**：用 `cwd / permissionMode` 从 `sessionRepo.get(sessionId)` 补回（permissionMode 不能默认 'default' 否则用户辛苦切到的 plan/acceptEdits 被静默重置）
  - **失败补 error message**：createSession 抛错时再 emit `{error:true, text:'⚠ 自动恢复失败：...'}` 让用户看到原因，再 throw 给上层
  - finally `recovering.delete(sessionId)` 释放单飞锁

### 渲染层 / 简化（断连判断不再外露）

#### `src/renderer/components/SessionDetail.tsx`

- `ComposerSdk.send()` catch 分支删除 `if (msg.includes('not found'))` 字符串匹配 + `createAdapterSession({resume})` 备选逻辑
- 现在 send 永远只调 `sendAdapterMessage` 一次：成功 / 真错（字节超限 / 队列满 / record 不在 / 鉴权异常）两条路；恢复完全由 main 进程内部完成，renderer 不感知 resume 实现细节
- 顺手清理：ComposerSdk 不再需要 `cwd` prop（恢复路径已下沉，不再 renderer 拼 createAdapterSession 参数）

### 测试

#### `src/main/adapters/claude-code/__tests__/sdk-bridge.test.ts`（新文件）

新增 4 case 覆盖 B 路径核心约束（mock sessionRepo / sessionManager / sdk-loader / sdk-runtime / sdk-injection；子类化 ClaudeSdkBridge 覆盖 createSession 不真起 SDK CLI）：

1. **record 在 → emit 占位 message + createSession({resume,prompt,cwd,permissionMode}) 调一次**
2. **record 不在 → throw not found，createSession 不被调，也不污染活动流（不 emit 占位）**
3. **单飞**：同 sessionId 并发两次 sendMessage（block 模式让 inflight 不 resolve）→ createSession 只被调一次，第二条等同一 inflight
4. **createSession 失败 → 占位 message 后再补 error message，throw 给上层**

### 文档 / 约定

#### `CLAUDE.md`「会话恢复 / 断连 UX（resume 优先）」节

- 主语从「应用内 SDK detail 发送路径」下沉到「sdk-bridge.sendMessage」
- 删掉「字符串匹配 'not found' 触发自动 resume」的过时表述（renderer 不应承担断连判断）
- 加单飞 / 占位 message / sessionRepo 补回 permissionMode / 不要在 recoverAndSend 自拼 emit 4 条硬约束
- 保留原 detail 视图权威 + sessionRepo.renameSdkSession 仅 fallback 路径用 等约定不变

## 验证

```bash
pnpm typecheck   # ok
pnpm vitest run  # 42/42（manager 13 + payload-truncate 12 + search-predicate 13 + sdk-bridge 4）
```

改 main 进程，按 CLAUDE.md 必须重启 dev：

```bash
lsof -ti:47821,5173 2>/dev/null | xargs -r kill -9
pkill -f "electron-vite dev" 2>/dev/null
pkill -f "Electron.app/Contents/MacOS/Electron" 2>/dev/null
pnpm dev
```

手测：

1. 触发断连（dev 期间重启 main / 等会话 lifecycle 走到 dormant、closed）
2. 历史 tab 选这条 SDK 会话 → detail 输入消息 → 直接发送
3. 期望：busy 转圈 → 活动流冒一行「⚠ SDK 通道已断开，正在自动恢复…」→ 几秒（最长 30s）后正常 message 流接续，不再弹任何按钮 / 红条；左侧实时面板这条会话继续工作

## 备注 / 决策追溯

- B 方案的对抗评审：[CLAUDE Opus 4.7 subagent + codex gpt-5.4 xhigh] 双 Agent 都推 B + 都明确指 C 只是 A 的减债版（不解抽象 / 测试 / 复用问题）+ D 为了解 30s 反馈引入更重的两阶段协议得不偿失
- 落地时严格按两 Agent 共识的 4 条硬约束做：单飞 / 完整复用 createSession / 用户消息只 emit 一次 / 占位 message。任何捷径都会重打开 REVIEW_5 修过的「两条 active record」bug
- CHANGELOG_24 备注挂的「用户连点恢复多次起多个 SDK query」边界由本批 `recovering` 单飞锁正式收敛
- HistoryPanel 列表本身仍不跟随 lifecycle 复活刷新（独立 UI 题，超出本批），但用户进入 detail 看到的就是真实状态（CHANGELOG_25 已修）
- 对 codex-cli adapter 复用：本批没动 codex-cli 的 sendMessage（codex SDK 协议 / 错误信号不同），但 owner 层自愈是通用思路，未来 codex 撞同问题时按本节模式镜像加自己的 recoverAndSend，不要回到 renderer 字符串匹配
