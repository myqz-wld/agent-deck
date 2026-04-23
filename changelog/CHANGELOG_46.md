# CHANGELOG_46: 修打包后 summary 全降级根因——SDK 0.2.x ENOTDIR + Layer 1/2 兜底三处 bug

## 概要

用户反馈「summary 总结出问题了，取最近一条 assistant msg 的逻辑也失效了，直接到了事件统计」。直接读真实运行日志（重定向 stdio 到 /tmp/agent-deck.log）+ SQLite 实证 + 直接 `child_process.spawn` 实测，**100% 锁定根因**：CHANGELOG_44 升 SDK `@anthropic-ai/claude-agent-sdk` 0.1.77 → 0.2.118 时漏识别一个语义变化——0.2.x 把 `cli.js` 拆成 platform-specific native binary 包（`@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` 等，约 207 MB），SDK 内部 `K7()` 通过 `require.resolve('@anthropic-ai/claude-agent-sdk-${plat}-${arch}/claude')` 拿到的路径在打包后 .app 里是 `app.asar/...` 字符串路径；Electron fs patch 让 `existsSync` / `statSync` 透明回退到 `app.asar.unpacked/`，但 `child_process.spawn` 走系统 `posix_spawn` syscall **不经过 fs patch** → spawn `app.asar/.../claude` 同步抛 `ENOTDIR`（OS 把 app.asar 这个普通文件当目录访问失败）→ summarizer LLM 100% 失败 → 全降级到第二层兜底；与 CHANGELOG_43 修 codex `spawn ENOTDIR` 是同一类问题（codex 当时已用 `PLATFORM_BINARY_MAP` + `resolveBundledCodexBinary` 修了，claude SDK 升级后撞到镜像问题没复刻该套路）。**额外影响**：`sdk-bridge.ts` 的应用内 SDK 会话发消息也走同一条 `query()` 路径，理论上也死，只是用户日常多走 hook 通道（外部终端 `claude` 上报）所以没显性暴露。

双对抗 Agent（Codex CLI xhigh + Claude Explore subagent）独立读代码评估初版方案后，又抓出 summarizer 内更深的两个 bug：(a) `formatEventsForPrompt` 取「最新 40 条」 events（DESC）后 `sort((a,b)=>a.ts-b.ts)` 升序，再 `if (lines.length >= 30) break` —— 升序遍历里 break 早，**实际丢的是最新 10 条而不是最旧 10 条**，LLM 看到的活动一直是会话开头那段旧上下文，越往后看到的越旧；(b) Layer 1 prompt 的 `if (e.kind === 'message')` 完全没过滤 `role: 'user'` / `error: true`，把用户输入（"push 一下"）和 ⚠ 警告也写成「Claude 说 …」喂给总结 LLM。Layer 2 兜底的「`events.find(e => e.kind === 'message')`」原本就有四叠加 bug：(1) 没过滤 role → 拿到 user 输入；(2) 没过滤 error → 拿到 ⚠ 警告；(3) 没时间窗 → 拿到几小时前的旧 assistant 话；(4) `limit=40` 在 tool 密集会话被挤干 → 直接 undefined → 落到事件统计（即用户报告的现象）。SQL 取证：summary 表实例 id=675 content=`⚠`（命中 (2)）、id=676 content=`Push 成功。 ...`（命中 (1)/(3)）、id=677 content=`最近 40 条事件；tool-use-start×21，tool-use-end×18`（命中 (4)）；同会话 98f3abd5 最近 40 条 events kind 分布 `tool-use-start×21 / tool-use-end×19 / 0 条 message / 0 条 thinking`。

**修复**（一并改 5 处）：(1) `sdk-runtime.ts` 新增 `getPathToClaudeCodeExecutable()` 复刻 SDK K7 的解析顺序（含 linux musl 优先 + glibc 兜底，darwin/win32 单包，win32 binary `.exe` 后缀），结果用「路径段级 regex」`/([\\/])app\.asar([\\/])/` 替换成 `app.asar.unpacked` 段（前后必须是 `/` 或 `\` 才匹配，既避免误吃祖先目录里恰好含 `app.asar` 子串、也避免把已经 unpacked 的路径再加一层 `.unpacked`），dev 模式 `require.resolve` 直接命中 node_modules 真实路径不含 asar，replace 是 no-op 无副作用；(2) `summarizer.ts` + `sdk-bridge.ts` 的 `query({ options })` 都加 `pathToClaudeCodeExecutable: claudeBinary`（undefined 时走 conditional spread 不传字段，让 SDK 走默认 K7）；(3) `formatEventsForPrompt` 改成先 `sort` 升序再 `slice(-30)` 取末尾——保证总是看最新 30 条而非最旧 30 条；(4) 同函数 `if (e.kind === 'message')` 加 `if (p.role === 'user' || p.error === true) continue` 过滤；(5) `event-repo.ts` 新增 `findLatestAssistantMessage(sessionId, sinceTs)` SQL helper，用 `json_extract(payload_json, '$.role') = 'assistant'` + `(json_extract(payload_json, '$.error') IS NULL OR = 0)` + `ts >= ?` 单 query 拿最近一条「Claude 自己说的话」，summarizer Layer 2 改用它（sinceTs = `lastSummarizedAt ?? startedAt` 的增量语义，避免回到旧 assistant 内容重复展示）；(6) `package.json` `asarUnpack` 显式加 `@anthropic-ai/claude-agent-sdk-{darwin,linux,win32}-*/**` 三条硬化（虽然 electron-builder 当前自动识别并 unpack，但显式声明防 builder 未来启发式变化）。

Codex 在评估里另提出「让 Layer 1/3 也吃 sinceTs 统一增量语义」的 design suggestion，本次未采纳（保持当前「Layer 1 prompt 看最新 30 条全活动 → Layer 2 看 sinceTs 后最新 assistant message → Layer 3 事件统计」三层不同语义）：Layer 1 LLM 需要前后上下文判断当前任务，纯增量看不到全貌；Layer 2 是「最新一句话 fallback」性质，增量语义最贴合；Layer 3 兜底就该看历史 40 条避免空。

## 变更内容

### Layer 1 spawn ENOTDIR 修复

#### `src/main/adapters/claude-code/sdk-runtime.ts`

- 顶部 JSDoc 完整重写，明确区分 0.1.x（cli.js + node spawn / `executable` 起作用）与 0.2.x（native binary 直接 spawn / `executable` 完全被绕过）两个时代行为差异，并解释 ENOTDIR 根因（Electron fs patch 不覆盖 `child_process.spawn`）。
- `getSdkRuntimeOptions()` 实现保持不变（`executable: process.execPath` + `ELECTRON_RUN_AS_NODE: '1'`，0.2.x 下不起作用但保留无害）。
- 新增 `getPathToClaudeCodeExecutable(): string | undefined`：用 `createRequire(__filename)` 拿 `requireFromHere`（main 是 CJS 但用 createRequire 形式更显式 / 对未来切 ESM friendly），按 SDK K7 顺序枚举候选包名（linux 先 `-musl` 后无后缀，其他单包），对每个候选 try `require.resolve(`${pkg}/claude${ext}`)`；命中后用 `replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')` 做路径段级转换；全部 catch 时返回 `undefined` 让调用方 conditional spread 不传字段。

#### `src/main/adapters/claude-code/sdk-bridge.ts`

- import 加 `getPathToClaudeCodeExecutable`。
- `query({ options })` 之前 `const claudeBinary = getPathToClaudeCodeExecutable()`；options 末尾追加 `...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {})`，附 5 行注释说明 0.2.x ENOTDIR 根因 + dev 模式无副作用 + 详见 sdk-runtime.ts。

#### `src/main/session/summarizer.ts`（query options 部分）

- import 加 `getPathToClaudeCodeExecutable`。
- `summariseViaLlm` 内 `const claudeBinary = getPathToClaudeCodeExecutable()` + `query({ options })` 末尾同样的 conditional spread 追加。

### Layer 2 兜底重构

#### `src/main/store/event-repo.ts`

- 新增 `findLatestAssistantMessage(sessionId: string, sinceTs?: number): { text: string; ts: number } | null`：单 SQL `WHERE kind='message' AND json_extract(payload_json,'$.role')='assistant' AND (json_extract(payload_json,'$.error') IS NULL OR json_extract(payload_json,'$.error')=0) AND ts >= ? ORDER BY ts DESC LIMIT 1`，sinceTs 缺省时去掉 `AND ts >= ?` 子句；JSON.parse 容错（payload 损坏返 null 而不是抛）。
- JSDoc 写明四叠加 bug 与「为什么不在调用方过滤 events 数组」+ sqlite3 json_extract 三类返回（true→1 / false→0 / 字段缺失→SQL NULL）。

#### `src/main/session/summarizer.ts`（fallback 部分）

- Layer 2 原 `events.find(e => e.kind === 'message')` 改成 `eventRepo.findLatestAssistantMessage(sessionId, sinceTs)`，sinceTs = `this.lastSummarizedAt.get(sessionId) ?? session.startedAt`；命中时取 `text` 做 trim/slice(0,100)。
- 注释扩展说明四叠加 bug + 为什么用增量 sinceTs（不要回到旧 assistant 内容重复展示）。
- Layer 1/3 不动（Layer 1 看最新 40 条全活动给 LLM 判断；Layer 3 兜底就该看历史 events 避免空）。

### Layer 1 prompt 两处隐 bug 修复

#### `src/main/session/summarizer.ts`（formatEventsForPrompt）

- 顶部 JSDoc 重写：明确「`events` 入参按 ts DESC（listForSession 语义），先升序排回去再取末尾 30」，并指出原 `if (lines.length >= 30) break` 在升序遍历里实际**丢最新 10 条而不是最旧 10 条**这个隐 bug。
- `const ordered = [...events].sort((a, b) => a.ts - b.ts).slice(-30)`；循环里删 `if (lines.length >= 30) break`。
- `if (e.kind === 'message')` 分支首行加 `if (p.role === 'user' || p.error === true) continue`，附「过滤用户输入和错误警告」一行注释。

### 打包配置硬化

#### `package.json`

- `build.asarUnpack` 追加三条：`node_modules/@anthropic-ai/claude-agent-sdk-darwin-*/**/*`、`-linux-*/**/*`、`-win32-*/**/*`。electron-builder 当前自动识别并 unpack 这些 native 包，显式声明防 builder 未来变化（与 CHANGELOG_43 给 codex 系列加显式 unpack 同思路）。

## 验证

- `pnpm typecheck` 一次过（修了 sdk-runtime.ts JSDoc 里 `*/**/*` 字符串被 TS 误判为注释结束符的小坑——把字符串改写避开 `*/`）。
- 后续手动跑 `rm -rf release && pnpm dist` + 覆盖安装 + ad-hoc 重签 + xattr + pkill + 重启，验证 `/tmp/agent-deck.log` 不再出现 `[summarizer] LLM failed for ... spawn ENOTDIR`、新写入的 summary 不再出现 `最近 N 条事件；...` 那种事件统计兜底（除非 LLM 真失败）、不再出现 `⚠` 单字 / 用户输入原话作为 summary。

## 调查方法（值得记的工程套路）

- **stdio 重定向拉真实日志**：打包 .app 经 launchd 启动时 stdout/stderr 不接终端，`console.warn` 完全不可见。`pkill` + `nohup ".app/Contents/MacOS/Agent Deck" > /tmp/agent-deck.log 2>&1 & disown` 就能拿到完整 console 流，比加 file logger 改代码再 dist 验证快一个量级（首次 GUI app 起不来加上 `rm -f userData/Singleton*` 清单实例锁）。
- **SQLite 直读 DB 实证**：用户报告「summary 出问题」，直接 `sqlite3 agent-deck.db "SELECT trigger, content FROM summaries ORDER BY ts DESC LIMIT N"` 看真实落库的兜底产物，比口头描述精确十倍。同会话 events kind 分布同理。
- **隔离 spawn 实测**：怀疑是 spawn 路径问题就最小化复现 —— `ELECTRON_RUN_AS_NODE=1 ".app/.../Agent Deck" -e 'spawn(asarPath,...) vs spawn(unpackedPath,...)'`，5 行直接看哪条路径同步抛 ENOTDIR、哪条 exit=0，胜过看 SDK 半 minified 源码推断。
- **双 Agent 对抗（Codex xhigh + Claude Explore）评估方案而非只评估根因**：Codex 抓出 Layer 1 prompt 的两个隐 bug（升序后丢最新 10 条 + 没过滤 role/error），Claude Explore 抓出 regex `\b` 边界理论风险（虽然实测路径不会触发但写得更紧 robust）。把方案丢给两个 Agent 各 6 题三态裁决，比单线写完直接 dist 大幅降低「修一个引入两个」的风险。
