---
review_id: 24
reviewed_at: 2026-05-12
expired: false
skipped_expired: []
---

# REVIEW_24: R4 Generic-PTY adapter + aider PTY 实装异构对抗

## 触发场景

R4 7 atomic commit 落地（CHANGELOG_66：F1 → F2 → F3 → F4 → F-bonus → F5 → F-doc，~2700 LOC churn 含新建 5 文件 / migration / sessionRepo 17 列对齐 / IPC zod parse / renderer 子组件）后，按 plan §F-doc 节 optional review 项主动跑一轮异构对抗，覆盖 race / leak / TOCTOU / 边角条件 / 持久化一致 / 协议契约 / 安全 / 测试盲区 8 类问题。

## 方法

**双异构 reviewer 配对**（CLAUDE.md「决策对抗」§主路径）：

- **reviewer-claude**（Opus 4.7 xhigh subagent，agent-deck plugin 注入）：一次完整 audit
- **reviewer-codex**（gpt-5.5 xhigh CLI wrapper，agent-deck plugin 注入）：**三试上游 503 / Reconnecting / 静默 timeout 全部失败**（xaminim 平台 gpt-5.5 渠道持续不可用），用户三次决策「等几分钟重试 / 再等 / 等几分钟」后第四次绕过 wrapper agent **直接 Bash 调外部 codex CLI** 拆 2 批 background 并发跑通（仍保留异构原则 — wrapper 只是搬运层不参与思考；codex CLI 本身是 gpt-5.5 不是 Claude 同源）

**范围**：12 R4 文件 + sessionRepo 增量 + IPC 增量 + NewSessionDialog 增量 + package.json 增量

```text
PTY core:
  src/main/adapters/generic-pty/{index,pty-bridge,ansi-parser,file-watcher}.ts
  src/main/adapters/aider/index.ts
  scripts/fix-pty-permissions.mjs

持久化 + IPC + renderer + 配置:
  src/shared/types/{generic-pty,session}.ts
  src/main/adapters/types.ts
  src/main/store/migrations/v012_sessions_generic_pty_config.sql
  src/main/store/session-repo.ts
  src/main/ipc/adapters.ts
  src/renderer/components/{GenericPtyConfigForm,NewSessionDialog}.tsx
  package.json
```

**机器可读范围**（File-level Review Expiry 用）：

```review-scope
package.json
scripts/fix-pty-permissions.mjs
src/main/adapters/aider/index.ts
src/main/adapters/generic-pty/ansi-parser.ts
src/main/adapters/generic-pty/file-watcher.ts
src/main/adapters/generic-pty/index.ts
src/main/adapters/generic-pty/pty-bridge.ts
src/main/adapters/types.ts
src/main/ipc/adapters.ts
src/main/store/migrations/v012_sessions_generic_pty_config.sql
src/main/store/session-repo.ts
src/renderer/components/GenericPtyConfigForm.tsx
src/renderer/components/NewSessionDialog.tsx
src/shared/types/generic-pty.ts
src/shared/types/session.ts
```

**约束**：本 REVIEW 不审 R3 老文件（universal-message-watcher / agent-deck-message-repo / claude-code/codex-cli adapter / hook-installer / agent-deck-team-repo），不审 node-pty / chokidar 上游库实现，不再争论 plan §F-bonus 选项 A vs B / generic-pty 不读 file content / 不复刻 SDK 细粒度 tool event 等已记设计取舍。

## 三态裁决结果

> 验证手段栏：✅ 必须带 grep 输出 / Node 实测脚本 / 跑命令；纯文本推理 → ❓ + 自降级非 HIGH

### ✅ 真问题（双方独立提出 / 一方提出且现场实践验证成立）

| # | 严重度 | 文件:行号 | 问题 | C | X | 验证手段 |
|---|---|---|---|---|---|---|
| 1 | HIGH | `src/main/adapters/generic-pty/ansi-parser.ts:65-86` | PtyOutputBuffer 单 chunk ≥ capacity 时整 buffer 归零 → IdleDetector promptSuffixRegex 末尾匹配彻底失效（aider --no-stream 5-15KB chunk + `> ` prompt 必中） | ✅ | (skip) | claude 内联 Node 复刻 + 我用 cap=10 / push 5+13 char 验证 size=0 / str="" |
| 2 | HIGH | `src/main/adapters/generic-pty/pty-bridge.ts:50` ⊗ `src/main/store/agent-deck-message-repo.ts:208` | bridge cap (byteLength 100_000) ↔ messageRepo cap (length 102_400) 不一致 → CJK / 接近 ASCII 上限的 cross-adapter message 在 watcher 入队 OK 但 bridge throw → markFailed 重试 3 次都同款 fail | ✅ | (skip 已知) | claude 内联 Node 跑两条数值：ASCII 102_400 byte 入队 OK 投递 throw / CJK 33_335 char 触发 |
| 3 | MED | `src/main/adapters/generic-pty/pty-bridge.ts:344-372` | closeSession 顺序：await fileWatcher.close() 在 SIGTERM 之前 → watcher close 慢 / throw 时 SIGTERM 路径不可达；killTimer 设置不 check sessions Map 致 onExit 已 delete 后 timer 仍持 event loop 10s | ❌ | ✅ MED 1+2 | codex 读 closeSession + onExit + shutdownAll 三段真实代码行序 |
| 4 | MED | `src/main/adapters/generic-pty/pty-bridge.ts:301-325` | closeSession 后 sendMessage / receiveTeammateMessage 仍写 PTY → SIGTERM 后 broken pipe → throw EIO → watcher retry 3 次都同款 fail markFailed reason 不准 | ✅ MED-4 | (角度交叉) | claude 读代码链 + 对照 universal-message-watcher.ts:447-462 retry 路径；窗口期实测 SIGTERM → onExit 5-50ms |
| 5 | MED | `src/main/adapters/generic-pty/pty-bridge.ts:413-438` | spawn-helper asar 路径替换裸 String.replace 不锚定路径段（case 2 `app.asar.unpacked.unpacked` / case 3 用户路径含 `app.asar` 子串误吃） | ✅ MED-3 | (skip 已知) | claude 内联 Node 跑两套 replace 函数对 4 个路径场景比对；与 sdk-runtime.ts:87 同款最佳实践不一致 |
| 6 | MED | `src/main/adapters/generic-pty/pty-bridge.ts:417-435` | ensureSpawnHelperExecutable boolean 单飞标记前置但 chmod 异步 → race window：A await chmod 期间 B 看到 ready=true → ptySpawn 在 chmod 前跑 → spawn-helper 仍无 +x → posix_spawnp failed | ✅ MED-5 | (skip 已知) | claude 读代码顺序 + 对照 sdk-bridge `recovering: Map<sid, Promise>` 同款 promise 单飞模式 |
| 7 | MED | `src/main/adapters/generic-pty/ansi-parser.ts:149` | promptSuffixRegex 在 main process timer callback 中同步 test() 无 ReDoS 防护 — 用户配置或意外灾难回溯 regex 阻塞主进程 | (漏) | ✅ MED 3 | codex grep 仅 `new RegExp` + `.test()`，无 safe-regex / 超时 / 长度外的防护 |
| 8 | MED | `src/main/store/session-repo.ts:65` | parseGenericPtyConfigJson 仅 JSON.parse + cast，合法 JSON 如 `"x"` / `42` / `[]` / `{}` 不 fallback null 而被当 GenericPtyConfig 返回 → 下游 spawn 失败或 silent 误用 | (漏) | ✅ MED 6 | codex `node -e` 实测合法脏 JSON 返回 string/number/array/object |
| 9 | MED | `src/renderer/components/GenericPtyConfigForm.tsx:74` ⊗ `src/renderer/components/NewSessionDialog.tsx:281` | adapterId props 变化时 form 内部 useState 不刷新（aider ↔ generic-pty 切换时旧 config 残留） | ✅ MED-6 | ✅ MED 7 | codex grep 无 useEffect 依赖 adapterId / 无 `key={agentId}` remount |
| 10 | LOW | `scripts/fix-pty-permissions.mjs:45` | access + chmod 两步式 TOCTOU pattern；可直接 chmod 捕 ENOENT silent | (漏) | ✅ LOW 5 | codex 读 `sed -n '44,53p'` 确认顺序 |
| 11 | LOW | `src/renderer/components/GenericPtyConfigForm.tsx:61` | args parse 注释「引号包裹保留为整体」与实现 `split(/\s+/)` 不符（`--msg "hello world"` 拆错） | (漏) | ✅ LOW 9 | codex `node -e` 实测 split 输出 |

### ❌ 反驳（被对抗或现场核实证伪）

| 报告方 | 报项 | 反驳依据（验证手段 + 结论） |
|---|---|---|
| Codex | LOW 4 PtyOutputBuffer 跨 chunk 丢 head 不切尾 | **部分证伪 + 部分采纳**：跨 chunk 累加超 capacity 时确实从头丢 chunk，但这是设计取舍（plan §F3 「保留最近 N 字节」not 「跨 chunk byte-precise」）。HIGH-1 修复已覆盖单 chunk ≥ capacity 路径（最常见的 aider --no-stream 一次性 emit 长答复 case），跨多个小 chunk 累加场景 user-facing 影响小且修复需要重写 buffer 数据结构。**降级 INFO 不修，注释里说明设计取舍。** |
| Claude | LOW 测试盲区（onExit + closeSession race / shutdownAll 中途 throw / chmod 单飞并发） | 已通过 C1 commit 加 3 case 守门（sendMessage 在 closeSession 后 throw / SIGTERM 先于 fileWatcher.close / promptSuffixRegex 超长拒绝），剩余 race case 实装的 try/catch/finally 兜底已完整，未观察到泄漏 / 崩溃，**降级 INFO 不修**。 |

### ❓ 部分 / 未验证（双方角度不同 / 一方提出但未实践验证）

| 现场 | 视角 | 是否已验证 | 结论 |
|---|---|---|---|
| Claude LOW useMemo 内调 setError | render-phase side effect React 反模式 | 部分（Codex 也提 LOW 8）— React 18+ dev warn but prod works | **降级 INFO 不修**：当前 form 渲染稳定，dev warn 不影响 user。如未来加 React strict mode 或重构 form 时同步重构。 |
| Claude LOW placeholder `&#10;` | textarea 多行 placeholder 渲染不一致 | 未验证 | **降级 INFO**：UI 显示影响微小，且 ChatGPT 类 textarea 行为本就 user-agent 依赖。 |
| Claude LOW pty.onData 注册晚 | 子进程立即输出可能丢首条 chunk *未验证* | **未验证** — 依赖 node-pty native 内部 buffer 行为；macOS 实测第一个 data tick 至少在 next macroTask | **❓ 不修**：plan §1.2 已说不复刻 SDK 细粒度事件，理论性风险接受。 |
| Codex LOW 10 promptSuffixRegex 缺长度守门 *未验证* | 与 MED 3 重合 | 已通过 MED 3 修复覆盖 | ✅ MED 3 修复已含此 LOW 10 |

## 修复（CHANGELOG_67 落地）

### HIGH

1. **`src/main/adapters/generic-pty/ansi-parser.ts:65-86`** — PtyOutputBuffer 单 chunk ≥ capacity 走快路径只保留尾部 capacity 字符（commit `d6f31b4`）
2. **`src/main/adapters/generic-pty/pty-bridge.ts:50`** — MAX_FIRST_PROMPT_BYTES (100_000 byte) → MAX_PROMPT_LENGTH (102_400 char) 与 messageRepo 对齐；R3 老 adapter (claude-code/codex-cli) cap 留 follow-up（commit `bf9a302`）

### MED

3. **`src/main/adapters/generic-pty/pty-bridge.ts:344-372`** — closeSession 序：先 SIGTERM → check sessions.has() 才设 killTimer → fileWatcher.close fire-and-forget（shutdownAll 路径仍 await all close）（commit `bf9a302`）
4. **`src/main/adapters/generic-pty/pty-bridge.ts:301-325`** — sendMessage 顶部 check intentionallyClosed 立即 throw "session is closing"（commit `bf9a302`）
5. **`src/main/adapters/generic-pty/pty-bridge.ts:413-438`** — spawn-helper asar 路径用 regex 锚定（与 sdk-runtime.ts:87 同款）（commit `bf9a302`）
6. **`src/main/adapters/generic-pty/pty-bridge.ts:417-435`** — ensureSpawnHelperExecutable boolean → promise 单飞，后续 caller await 同一 promise（commit `bf9a302`）
7. **`src/main/adapters/generic-pty/ansi-parser.ts:143-167`** — promptSuffixRegex 长度上限 200 char，超出 fallback null + warn（commit `bf9a302`）
8. **`src/main/store/session-repo.ts:65-78`** — parseGenericPtyConfigJson 加 `genericPtyConfigSchema.safeParse` 二次校验（commit `94f2a90`）
9. **`src/renderer/components/NewSessionDialog.tsx:281-289`** — `<GenericPtyConfigForm key={agentId} ... />` 强制 remount（commit `94f2a90`）

### LOW

10. **`scripts/fix-pty-permissions.mjs:45`** — 删 access，直接 chmod 捕 ENOENT silent（commit `bf9a302`）
11. **`src/renderer/components/GenericPtyConfigForm.tsx:60-72,156`** — args parse 注释明确「不支持引号」+ field label 加「（空格分隔，不支持引号）」（commit `94f2a90`）

## 关联 changelog

- [CHANGELOG_66.md](../../changelogs/history/CHANGELOG_66.md)：R4 7 commit 实装记录
- [CHANGELOG_67.md](../../changelogs/history/CHANGELOG_67.md)：本轮 review 落地修复（HIGH-1 + HIGH-2 + 8 MED + 2 LOW，共 4 commit）

## 异构对抗失败兜底记录

reviewer-codex wrapper 三连失败（503 → Reconnecting → 静默 timeout）皆 xaminim 平台 gpt-5.5 渠道不可用所致，按 CLAUDE.md「reviewer-codex 失败兜底」节用户每次决策（不自动降级双 Claude 同源）。第四轮用户决策「试新 bash 环境唤起 codex」绕过 wrapper agent，**直接 Bash 调外部 codex CLI 拆 2 批 background 并发**（按 CLAUDE.md「外部 CLI 对抗 Agent 通用姿势」节模板：zsh -i -l -c / read-only sandbox / skip-git-repo-check / -C 项目路径 / -o 抓最终答案 / xhigh / stdin prompt）— 第三批 codex 上游恢复（pong 验通），两批均成功生成 finding。**异构原则保留**：codex CLI 是 gpt-5.5（与 Claude Opus 4.7 异源），wrapper 只是搬运层不参与思考。

## Agent 踩坑沉淀（如有）

无新踩坑候选 — 本轮 finding 模式（race / TOCTOU / 协议 cap 不一致 / 弱 cast / props 不刷新）皆已在历史 reviews + CLAUDE.md 项目特定约定节有覆盖。但「PTY backend 写 stdin 是 char-based 不挑 byte，与 messageRepo length cap 对齐而非 byteLength」这条规律值得记入 R5+ 引入新 backend adapter 时的检查清单（暂不升级约定）。
