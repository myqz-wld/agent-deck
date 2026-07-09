# CHANGELOG_66: R4 Generic-PTY adapter + aider PTY 接入 + universal team backend cross-adapter 收口

## 概要

R3 Universal Team Backend 硬切（CHANGELOG_65）已让 team 抽象脱钩 Claude Code in-process backend，但 aider / generic-pty adapter 当时还是 `canCollaborate: false` 占位 —— **今天**真正落地：用 `node-pty` 包装任意 stdin/stdout-only CLI，aider 作为 preset case 自动可用，两类 adapter 都开启 `canCollaborate: true` 让 universal team backend 能跨 adapter 投递消息。F1-F5 + F-bonus 6 atomic commit 推进 plan v3 §F 全 5 任务 + 把 R3 留下的 follow-up 一并带上。

## 变更内容

### F1（src/shared/types/generic-pty.ts + barrel + tests，258 行）

- 新建 `GenericPtyConfig` type + `GENERIC_PTY_PRESETS`（aider + continue 两条内置）+ zod schema + `parseGenericPtyConfig` helper；放 `shared/types` 让 main + renderer 都能 zod parse 防脏
- aider 默认 args `['--no-stream', '--no-pretty']` + promptSuffixRegex `'\\>\\s*$'`（aider 实测的 `> ` prompt 末尾）；继续 preset 留空让用户自填
- 14 case zod 守门：valid / partial defaults / 空 command / 负 idleQuietMs / env 类型 / preset 自检
- 设计决策：plan §F-bonus **选项 B**（共享 GenericPtyBridge class，aider/generic-pty 各 own instance；保留两个独立 adapter 让 UI 暴露差异，但 backend 共享）

### F2（PTY bridge 主体，1025 行）

- `src/main/adapters/generic-pty/pty-bridge.ts` 新建 `GenericPtyBridge` class
  - per-session `Map<sid, PtySessionState>` + nanoid generate sessionId（PTY backend 没有 server-assigned id）
  - `createSession` → spawn → emit `session-start` + 首条 user message → 注册 `onData/onExit` listener → 写 stdin（自动补 `\n`）
  - `sendMessage` / `interrupt`（写 `\x03` Ctrl+C）/ `closeSession`（SIGTERM → 10s grace → SIGKILL 兜底）/ `shutdownAll`（app shutdown SIGKILL all）
  - `ensureSpawnHelperExecutable`（lazy chmod 0o755）：node-pty 1.1.0 prebuilds/`<arch>`/spawn-helper 经 pnpm install 后丢 +x bit（实测 -rw-r--r--）→ posix_spawnp failed
- `src/main/adapters/generic-pty/index.ts` 重写：capabilities 全开 + 委托 bridge instance
- 持久化：v012 migration `ALTER TABLE sessions ADD COLUMN generic_pty_config TEXT` + `SessionRecord.genericPtyConfig?: GenericPtyConfig | null` + sessionRepo Row/rowToRecord/upsert/rename 全链补字段（rename 列数 16→17 + ? 数对齐 + toExists 兜底覆盖，与 `codex_sandbox` 同模式 / CHANGELOG_35 教训）
- IPC `createAdapterSession` handler zod parse `raw.genericPtyConfig` 防 IPC bypass
- 打包：`asarUnpack` 加 `node_modules/node-pty/**` + `node_modules/.pnpm/node-pty@*/node_modules/node-pty/**`；新增 `scripts/fix-pty-permissions.mjs` 给 postinstall 自动 chmod +x prebuilds/`<arch>`/spawn-helper（双层 spawn-helper 权限保护：install-time + runtime）
- 单测：完全 mock node-pty + sessionRepo 的 20 case 守门 lifecycle / sendMessage / interrupt / close / shutdownAll / 边界（无 config / 空 command / >100KB）

### F3（ANSI strip + idle 检测，598 行）

- `src/main/adapters/generic-pty/ansi-parser.ts` 新建：
  - `stripAnsi(input)` inline regex 实现（抄自 sindresorhus/ansi-regex@6 MIT），覆盖 CSI / SGR / OSC，保留 `\r\n \t`；不引 `strip-ansi` npm 依赖（v7+ ESM-only interop 麻烦 + 减一个 dep）
  - `PtyOutputBuffer` 环形 buffer（默认 8KB），push 累积超 capacity 从头截断
  - `IdleDetector`：onData reset 定时器；idleQuietMs 后 fire callback；可选 `promptSuffixRegex` 二次校验；invalid regex 安全 fallback；dispose / cancel 取消未到期 timer
- `pty-bridge.ts` 集成：onData strip ANSI → push buffer → reset detector → emit `message`（stripped text）；idle fire emit `waiting-for-user`（payload.source='pty-idle' + dedup 同段静默不重复）；close 立刻 `dispose` detector
- 单测：22 case ansi-parser + 6 case bridge idle 集成（共 48 测）

### F4（chokidar file-watcher，514 行）

- `src/main/adapters/generic-pty/file-watcher.ts` 新建 `PtyFileWatcher` class
  - `DEFAULT_IGNORED_PATTERNS`：node_modules / .git / dist / build / .next / .turbo / .cache / coverage / out / .DS_Store / Thumbs.db / *.log / *.swp / *.tmp / __pycache__
  - 配置：`ignoreInitial: true`（首次启动不报现有文件）/ `awaitWriteFinish` 100ms（防 partial write 多次 change）/ `followSymlinks: false`（防 symlink 循环）
  - `skipHomedirWatch: true` 默认：cwd=~ 时不 watch（防扫 home 卡 1-3s + 高 fd 占用）
  - `close` 必 `await` + 多次 close 安全 + close 后 emit noop（race 保护）
  - emit `file-changed` payload：`{ cwd, filePath, kind:'fs-event', before:null, after:null, metadata:{ source:'pty-fs-watch', fsEvent:'add'|'change'|'unlink' } }`（不读 file content；UI 想看 diff 用 git diff 兜底）
  - `watchFactory` 注入位（vitest 测试用 fake chokidar）
- `pty-bridge.ts` 集成：createSession 构造 + void start fire-and-forget（chokidar fsevents init 异步）；closeSession await fileWatcher.close（与 R3 老 team-watcher 同教训）；shutdownAll 并发 `Promise.all` all close
- 单测：14 case file-watcher（mock chokidar）+ 3 case bridge 集成（共 65 测）

### F-bonus（aider/generic-pty `receiveTeammateMessage` + `canCollaborate=true`，231 行）

- `src/main/adapters/generic-pty/index.ts`：`canCollaborate: false → true` + 实装 `receiveTeammateMessage(sid, fromMemberId, body)` → `bridge.sendMessage`（与 claude-code/codex-cli 同模式：watcher 已拼好 `[from <name> @ <adapter>]` 前缀，adapter 直接透传给 stdin write）
- `src/main/adapters/aider/index.ts` 完整重写（占位 → 完整 adapter）：
  - 与 generic-pty 同 capabilities 集合（PTY 全开），`canCollaborate=true`
  - own 自己的 GenericPtyBridge instance，构造时 `fallbackConfig` 注入 `GENERIC_PTY_PRESETS[0]`（'aider' preset）
  - 用户在 NewSessionDialog 不传 `genericPtyConfig` 也能创建 aider session（差别于 generic-pty 强制传 config 的 UX；aider 是 preset 友好型 adapter）
  - 启动时校验 GENERIC_PTY_PRESETS 含 'aider'，缺失 throw（防 preset 列表漂移）
- adapter-level smoke 单测：7 case 守门 capabilities + receiveTeammateMessage 接口契约 + aider preset fallback path

### F5（NewSessionDialog 加 generic-pty / aider 分支 + GenericPtyConfigForm，255 行）

- `src/renderer/components/GenericPtyConfigForm.tsx` 新建：
  - preset 下拉：Aider / Continue / 自定义（GENERIC_PTY_PRESETS + 'custom'）
  - 字段：command (必填) / args (空格分隔) / env (KEY=VALUE 多行) / cwd (留空跟主 cwd) / idleQuietMs / promptSuffixRegex
  - 实时 zod parse + valid 时 onChange(config) / invalid → onChange(null)
  - 命令预览 + inline 错误提示
  - aider adapter 默认填 'aider' preset；generic-pty 默认 'custom'（用户必填 command）
- `src/renderer/components/NewSessionDialog.tsx`：adapter='generic-pty' / 'aider' 时显示 GenericPtyConfigForm；submit 前校验 config 非 null（form 内 zod parse 失败 → null → 提示「Generic PTY 配置无效」拒绝提交）；createAdapterSession opts 透传 genericPtyConfig（与 codexSandbox / permissionMode 同样的条件 spread 模式）
- 不做（plan §F5 注解）：
  - e2e UI 实测 — 留用户手动跑（renderer 项目无 React testing lib，自动化 UI 测成本高于收益）
  - Settings 全局 GenericPtySection — 取消（当前 PTY 配置全在 NewSessionDialog 落地 per-session，preset 是 const 内置；power-user ignored 列表自定义留 future ticket）

## 备注

- node-pty 1.1.0 选型：N-API binding ABI-stable，prebuilds/darwin-arm64 含 N-API binary，runtime auto-fallback `build/Release` → `prebuilds/<platform>-<arch>`；`scripts/fix-pty-permissions.mjs` postinstall + `GenericPtyBridge.ensureSpawnHelperExecutable` lazy chmod 双层兜底 spawn-helper 权限丢失（pnpm install hard-link 拷贝实测掉 +x bit）
- 与 R3 universal team backend 衔接：F-bonus 让 aider / generic-pty 加 `canCollaborate: true` 后，`mcp__agent_deck__spawn_session({adapter:'generic-pty'/'aider', ...})` 就能起 cross-adapter teammate；universal-message-watcher 投递走 receiveTeammateMessage stdin write 路径
- generic-pty session 不挂 mcp_servers（Claude/Codex SDK 才挂），所以 generic-pty teammate 看不到 `mcp__tasks__*` 工具；如未来要加 task 协作，需用 prompt 注入「请告诉 lead 你现在跑到哪一步」走 message channel
- 验证：pnpm typecheck clean / pnpm build 全栈成功（main + preload + renderer）/ 全量 vitest 319 passed | 55 skipped（skipped 是 better-sqlite3 binding 自动跳，预期）
- worktree 实施：`.claude/worktrees/r4-generic-pty-20260511/`（独立 node_modules + electron 重 install 无 main repo 污染）；6 atomic commit（F1 → F2 → F3 → F4 → F-bonus → F5 → 本 doc）；plan `~/.claude/plans/r4-generic-pty-20260511.md`
