/**
 * 跨进程共享：AppSettings + Hook 安装状态 + 权限设置扫描结果类型。
 */

/**
 * Codex MCP server 配置（CHANGELOG_<X> A4b 起跨进程共享）。
 *
 * 字段集对应 codex CLI `~/.codex/config.toml` 的 `[mcp_servers.X]` 段。
 * 与 src/main/codex-config/toml-writer.ts 的 CodexMcpServerConfig 同形态——
 * 后者是 main-only 镜像（toml-writer 是 main 模块），shared 这里是给
 * AppSettings + IPC + renderer 复用的同结构。
 *
 * 不在 main 单独定义 / shared 单独定义两个差异类型 —— 字段集就是 codex CLI
 * 的 wire format，跨进程一致。
 */
export interface CodexMcpServerConfigShared {
  /** server 名称，用作 [mcp_servers.<name>] 段名。codex 内部用此名识别 tool 出处。 */
  name: string;
  /** stdio transport：command + args + env */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http transport：url + bearer_token_env_var */
  url?: string;
  bearerTokenEnvVar?: string;
}

export interface AppSettings {
  hookServerPort: number;
  /**
   * HookServer Bearer 鉴权 token：本机任何进程都能 curl 127.0.0.1:port，
   * 没有 token 校验就能伪造 AgentEvent 污染 SQLite / 注入假会话。
   * 首次启动由 settings-store 自动生成 32 字节随机 hex 并持久化，
   * 后续保持稳定（让已安装的 hook 命令不会因 token 变动失效）。
   * 用户**不应**在 UI 上修改此值；仅在被泄漏需要轮换时手动清掉持久化文件让它重生成。
   */
  hookServerToken: string | null;
  enableSound: boolean;
  enableSystemNotification: boolean;
  silentWhenFocused: boolean;
  /** waiting 提示音文件绝对路径（mp3/wav/aiff/m4a）；null = 用 resources/sounds 默认或系统声音 */
  waitingSoundPath: string | null;
  /** finished 提示音文件绝对路径；null = 同上 */
  finishedSoundPath: string | null;
  activeWindowMs: number; // active → dormant 阈值
  closeAfterMs: number; // dormant → closed 阈值
  summaryIntervalMs: number; // 总结时间触发
  summaryEventCount: number; // 总结事件数触发
  summaryMaxConcurrent: number; // 同时跑 LLM 总结的会话上限
  /**
   * 单个 LLM oneshot 总结的超时阈值（毫秒）。0 = 永不超时。
   * SDK 一旦因代理超时 / 鉴权死锁 / API 限流卡在等 result，循环就永远不会退出，
   * inFlight 槽永不释放，maxConcurrent 个卡死后整个 Summarizer 不再产新总结。
   */
  summaryTimeoutMs: number;
  /**
   * 周期性 summarize 走哪个 LLM provider(plan prancy-forging-penguin)。决定 summarizer 在
   * `adapterRegistry.get(...)` 选 claude-code adapter 还是 codex-cli adapter 出 summary,
   * **与被总结 session 自身的 adapter 无关**(claude session 也可能由 codex SDK 总结,反之亦然
   * — 由 user 在 settings 决定)。
   *
   * - `'claude'`(默认): 走 claude SDK + settings.summaryModel 字段
   * - `'codex'`: 走 codex SDK + settings.summaryModel 字段 + settings.summaryReasoning 档位
   *
   * 切档即时生效:summarizer 每次 scanAll() 重读本字段,无 cache。已在跑的 in-flight LLM
   * 调用不撤回(也不会回收 — 完成的 summary 落到 summaryRepo 不影响下次 provider 决策)。
   */
  summaryProvider: 'claude' | 'codex';
  /**
   * 周期性 summarize 用的 LLM model id(覆盖 env / alias 兜底,plan prancy-forging-penguin)。
   *
   * 优先级链(provider='claude' 时由 summariseViaLlm 实施):
   *   `settings.summaryModel` ＞ `ANTHROPIC_DEFAULT_HAIKU_MODEL` env ＞ `ANTHROPIC_MODEL` env
   *   ＞ 'haiku' alias 兜底
   *
   * 优先级链(provider='codex' 时由 summariseCodexSessionViaOneshot 实施):
   *   `settings.summaryModel` ＞ `CODEX_SUMMARY_MODEL` env ＞ undefined (fallback
   *   `~/.codex/config.toml` 顶层 `model` 配置)
   *
   * - `''`(默认空) = 沿用各 provider 自己的 env / alias / config.toml 链
   * - 非空 = 覆盖,直接传给对应 SDK 的 options.model;**填的 model id 必须对当前 provider 可用**
   *   (claude 端 'haiku'/'sonnet' alias OK, codex 端典型用 'gpt-5.5-mini')
   *
   * **provider × model 匹配是 user 责任**:settings.summaryProvider='codex' + summaryModel='haiku'
   * 会撞 codex SDK 不识别报错,日志会清楚。
   */
  summaryModel: string;
  /**
   * 周期性 summarize 的 reasoning effort 档位(plan prancy-forging-penguin)。
   *
   * **仅 summaryProvider='codex' 时生效**:codex SDK 原生支持 ThreadOptions.modelReasoningEffort
   * 4 档枚举。claude SDK 端无独立 reasoning 字段,thinking 走 model id 后缀(如
   * `claude-opus-4-7-thinking-max[1m]`),本字段被 claude provider 忽略。
   *
   * - default `'low'`: 与原 hardcoded summarize='low' 行为对齐,省 token + 出字快
   * - `'medium'/'high'`: 用户需精度时升档(注意成本与延迟)
   * - `'minimal'`: codex 最轻档,极短输出
   */
  summaryReasoning: 'minimal' | 'low' | 'medium' | 'high';
  /**
   * Hand-off 接力简报走哪个 LLM provider(plan prancy-forging-penguin)。语义同 summaryProvider
   * 但作用于 IPC `SessionHandOffSummarize` handler(手动 UI 按钮触发的 4 节结构化简报):
   * **决定出简报的 adapter,与被 hand-off 的目标会话原 adapter 无关**(目标会话保持自己 adapter 不变,
   * 仅是简报这一段由 user 选的 provider 出)。
   */
  handOffProvider: 'claude' | 'codex';
  /**
   * Hand-off 接力简报用的 LLM model id(覆盖 env / alias 兜底,plan prancy-forging-penguin)。
   *
   * 优先级链(provider='claude' 时由 summariseSessionForHandOff 实施):
   *   `settings.handOffModel` ＞ `ANTHROPIC_DEFAULT_HAIKU_MODEL` env ＞ `ANTHROPIC_MODEL` env
   *   ＞ 'haiku' alias 兜底
   *
   * 优先级链(provider='codex' 时由 summariseCodexSessionForHandOff 实施):
   *   `settings.handOffModel` ＞ `CODEX_HANDOFF_MODEL` env ＞ undefined (fallback config.toml)
   *
   * - `''`(默认空) = 沿用各 provider env / alias / config.toml 链
   * - 非空 = 覆盖
   *
   * **plan prancy-forging-penguin 改动**:claude 端 fallback alias 从 'sonnet' → 'haiku' 与
   * summaryModel 对齐(默认 haiku 让简报与周期总结同价位;user 想升 sonnet 自己填)。
   */
  handOffModel: string;
  /**
   * Hand-off 接力简报的 reasoning effort 档位(plan prancy-forging-penguin)。
   *
   * **仅 handOffProvider='codex' 时生效**(claude provider 忽略,thinking 走 model id 后缀)。
   *
   * - default `'medium'`: 与原 hardcoded handoff='medium' 行为对齐 — hand-off 4 节结构化输出
   *   对模型理解力要求高,medium 是 spike 实测下的最佳折中(high 太慢、low 输出结构常常错位)
   * - `'low'`/`'minimal'`: user 想省 token / 出字快时降档
   * - `'high'`: 极端结构精度需求(注意 spike 实测 30s+)
   */
  handOffReasoning: 'minimal' | 'low' | 'medium' | 'high';
  /** 权限请求未响应自动 abort 的阈值（毫秒）。0 = 不超时。 */
  permissionTimeoutMs: number;
  alwaysOnTop: boolean;
  /**
   * 窗口是否启用透明效果（macOS 关闭 vibrancy 让 CSS frosted-frame 主导通透感，看到下层桌面）。
   *
   * Phase 5 Step 5.6（plan mcp-bug-and-feature-batch-20260513）：从 `transparentWhenPinned`
   * 重命名 + 解耦：原字段语义「pin 时是否同步关闭 vibrancy」让透明绑定 pin，独立快捷键
   * `Cmd+Alt+T`（CHANGELOG_75）后绑定不再合理 —— 现在透明独立于 alwaysOnTop。
   *
   * - true（默认，与原 `transparentWhenPinned: true` 默认一致）：vibrancy null + CSS
   *   `data-transparent='true'`，透到下层桌面 / 其它 app；配合 startInvalidateLoop +
   *   setBackgroundThrottling(false) 持续刷新下层像素。
   * - false：vibrancy `under-window` 实玻璃，看不到下层。
   *
   * 改动即时生效（不需要重启 / 重建窗口）。
   *
   * 与 `alwaysOnTop` 独立：四种组合都合法 —— 「pin + 透明」（最常用）/「pin + 不透明」/
   * 「不 pin + 透明」（窗口不在最前，但仍能透到桌面）/「不 pin + 不透明」（普通窗口）。
   */
  windowTransparent: boolean;
  startOnLogin: boolean;
  /**
   * 历史会话自动清理保留天数（基于 lastEventAt）。
   * - 正数：超过该天数的「历史会话」（lifecycle = closed 或 archived_at IS NOT NULL）
   *   将被 LifecycleScheduler 在每次扫描时批量删除（事件 / 文件改动 / 总结一并 CASCADE）。
   * - 0：禁用自动清理（永远保留历史）。
   * 不影响 active / dormant：那些先由生命周期阈值推到 closed 后才进入清理候选。
   */
  historyRetentionDays: number;
  /**
   * Codex CLI 二进制绝对路径（@openai/codex-sdk 的 codexPathOverride）。
   * - null：用 SDK 自带的 vendored 二进制（@openai/codex 跟随 npm 装上，已打包进 .app）
   * - 绝对路径：覆盖为外部 codex（例如用户自装的更新版 `which codex` 给的路径）
   * agent-deck 不读不写 codex 鉴权（`~/.codex/config.toml` / 环境变量），全由用户终端配置。
   */
  codexCliPath: string | null;
  /**
   * Claude CLI 二进制绝对路径（claude-agent-sdk 的 pathToClaudeCodeExecutable override）。
   * - null：用 SDK 自带的 vendored 二进制（@anthropic-ai/claude-agent-sdk-{platform}-{arch} 跟随 npm 装上，已打包进 .app.unpacked）
   * - 绝对路径：覆盖为外部 claude（例如用户自装的更新版 `which claude` 给的路径）
   * agent-deck 不读不写 claude 鉴权（`~/.claude/.credentials.json`），全由用户终端 OAuth 处理。
   * 与 codexCliPath 字面镜像(plan add-claude-cli-path-override-and-bump-sdks-20260520 §不变量 N1)。
   * spawn-time options:改设置项不影响在跑会话(新建 SDK 会话才取新值,plan §N6 同款 codex 语义)。
   */
  claudeCliPath: string | null;
  /**
   * 是否把 agent-deck 自带的 CLAUDE.md（`resources/claude-config/CLAUDE.md` 或用户副本
   * `userData/agent-deck-claude.md`）注入到 SDK 会话 system prompt 末尾。
   * - true（默认）：注入，让会话遵循 agent-deck 项目内通用约定
   * - false：不注入，会话只受 user/project/local CLAUDE.md 控制
   *
   * 改这个开关只影响**下次新建**的会话；已运行的 SDK 会话已经把 system prompt
   * 固化进 LLM 上下文，关掉不会回收。
   */
  injectAgentDeckClaudeMd: boolean;
  /**
   * 是否把 agent-deck 自带的应用约定同步到 codex `~/.codex/AGENTS.md` 的 marker 段
   * （CHANGELOG_<X> D1）。Agent Deck 复用同一份 CLAUDE.md 内容（用户副本 →
   * 内置回落）写到 codex 一侧的 AGENTS.md，让 codex 会话也享受应用约定。
   *
   * - true（默认）：app ready / settings 变 / CLAUDE.md 编辑器保存后同步写入
   *   ~/.codex/AGENTS.md 的 `<!-- === Agent Deck START ===  ... === END === -->` 段
   * - false：移除 Agent Deck 段（保留用户其他内容）
   *
   * **D5 决策**：单向 overwrite Agent Deck 段，用户段（marker 之外）严格保留；
   * 用户在 Agent Deck 段内手改不反向同步，下次同步会被覆盖。
   *
   * 与 injectAgentDeckClaudeMd 平行（前者影响 claude 会话 system prompt 注入，后者
   * 影响 codex 会话的 AGENTS.md 自动加载）。改这个开关只影响**下次新建**的 codex
   * 会话；已 spawn 的 codex thread 已加载当时的 AGENTS.md。
   */
  injectAgentDeckCodexAgentsMd: boolean;
  /**
   * 是否把 agent-deck 自带 plugin 的 skills 同步到 codex `~/.codex/skills/agent-deck/`
   * （CHANGELOG_<X> D2）。
   *
   * - true（默认）：app ready / settings 变 / 写一遍内置 skills 到 codex skills 目录
   * - false：移除 ~/.codex/skills/agent-deck/ 整个目录（保留用户在 ~/.codex/skills/
   *   其他自管目录）
   *
   * 与 injectAgentDeckPlugin（claude）平行：前者控制 claude 会话挂 plugin（含 skills +
   * agents），后者控制 codex 一侧的 skills 镜像（codex 没有 plugin 概念，仅 skills）。
   * 改这个开关只影响**下次新建**的 codex 会话；已 spawn 的 codex thread 已加载当时的
   * skills（codex 启动时扫 ~/.codex/skills/）。
   */
  injectAgentDeckCodexSkills: boolean;
  /**
   * 是否把 agent-deck 自带的 plugin（`resources/claude-config/agent-deck-plugin/`）
   * 注入到 SDK 会话。**plugin 整体注入或整体不注入**——一个 toggle 同时控制两类内容：
   *
   * - **skills**：以 `agent-deck:<skill-name>` 命名空间注册（如 `agent-deck:deep-review`，
   *   多轮异构 review × fix 收口工作流）
   * - **agents**：以 `agent-deck:<agent-name>` 命名空间注册（如 `agent-deck:reviewer-claude`、
   *   `agent-deck:reviewer-codex`，异构对抗 reviewer subagent）
   *
   * SDK plugin 协议自动扫描 `<plugin>/skills/` 与 `<plugin>/agents/` 子目录，应用层只传
   * plugin path 即可。与用户 `~/.claude/skills/` + `~/.claude/agents/` + project
   * `.claude/skills/` + `.claude/agents/` 都不冲突（plugin 强制命名空间前缀）。
   *
   * 改这个开关只影响**下次新建**的会话；已运行的 SDK 会话已经在启动时拿到 plugin 列表，
   * 关掉不会撤销。
   */
  injectAgentDeckPlugin: boolean;
  // R3.E6 (PR-B) 删除：原 `agentTeamsEnabled` / `autoApproveTeammateMode` 字段下线，
  // 由新 universal team backend 取代（详 docs/agent-deck-team-protocol.md）。
  // plan task-mcp-merge-into-agent-deck-mcp-20260521：原 `enableTaskManager` 字段下线，
  // 5 个 task tool 合并入 agent-deck-mcp namespace，跟随 enableAgentDeckMcp 开关；
  // settings-store REMOVED_KEYS + smart migration 守护老用户 ON 值不丢失能力。
  /**
   * CHANGELOG_107:fallback 路径(jsonl missing / cwdFellBack=true)起 fresh CLI 之前
   * 自动调 LLM 生成历史摘要 prepend 到首条 prompt(让用户体感「Claude 还能续聊」,
   * 而不是 CHANGELOG_106 兜底「请下条消息把背景告诉它一次」的手动补)。
   *
   * - true(默认):每次 fallback 触发都跑一次 LLM(sonnet,~10-30s,4000 字摘要),
   *   prepend 到 fresh CLI 首条 prompt 前。LLM 失败 / DB 没历史 / 摘要超长 → 静默退回
   *   原 fallback 路径(emit「请补背景」与 CHANGELOG_106 行为一致)。
   * - false:跳过摘要,fallback 直接走 CHANGELOG_106 原路径。成本敏感用户可关
   *   (sonnet 摘要按调用计费;fallback 频繁的长历史会话有可观成本)。
   *
   * 不影响正常 resume 路径(jsonl 在 + cwd 在 → CLI 自续 jsonl,Claude 看完整对话)。
   *
   * 即改即生效:消费者(recoverer Step 3/4)每次 fallback 触发临时 settingsStore.get,
   * 无 cache 需 invalidate;ipc/settings.ts 无 apply* helper(同 enableSound 等纯 boolean)。
   */
  autoSummariseOnFallback: boolean;
  /**
   * Claude Code SDK 子进程的 OS 级沙盒档位（默认 'off'）。SDK 0.2.118 内置 sandbox 能力
   * （macOS Seatbelt / Linux bubblewrap），让用户在 UI 主动开启文件系统 + 网络 OS 级隔离。
   *
   * 三档语义：
   * - `'off'`：不启用沙盒，行为同现状（仅应用层 canUseTool 弹框决策）
   * - `'workspace-write'`：cwd 可写、用户敏感目录（~/.ssh / ~/.aws / ~/.config）只读、
   *   网络默认 deny；保留 `dangerouslyDisableSandbox` 逃逸路径（model fallback 时弹给用户审批）
   * - `'strict'`：cwd 只读、网络默认 deny + `failIfUnavailable: true`（沙盒不可用直接报错退出）
   *   + `allowUnsandboxedCommands: false`（封死 dangerouslyDisableSandbox 逃逸）
   *
   * 与 codex-cli 已默认的 `sandboxMode: 'workspace-write'` 对齐策略：默认 off 让用户主动开
   * （REVIEW_14 推荐路径阶段 2），观察 1-2 周用户反馈无异常后阶段 3 再考虑切默认 on。
   *
   * **关闭开关只影响下次新建会话**——已在跑的 SDK 子进程已按当前档位 spawn，sandbox 是
   * spawn-time options，不会被撤销（与 agentTeamsEnabled 同模式）。
   *
   * **summarizer 不被污染**：summarizer 走 `settingSources: []` + 自己 query() 调用，
   * 不读 sandbox 设置（与 agentTeamsEnabled 隔离同模式）。
   */
  claudeCodeSandbox: 'off' | 'workspace-write' | 'strict';
  /**
   * Codex CLI 子进程的 OS 级沙盒档位（默认 'workspace-write'，与 CHANGELOG_41 之前的硬编码值
   * 一致，零行为变更）。直接复用 codex SDK 原生 `SandboxMode` union 的字面量，不做映射。
   *
   * 三档语义（由 codex SDK / Codex CLI 自身定义，应用层只是透传）：
   * - `'workspace-write'`：cwd 可写、其他位置只读、网络默认 deny（默认）
   * - `'read-only'`：所有位置只读
   * - `'danger-full-access'`：完全不沙盒（同 codex CLI `--dangerously-bypass-approvals-and-sandbox`）
   *
   * 与 claudeCodeSandbox 独立维护：两个 SDK 的 sandboxMode 字符串值不重叠（claude:
   * off/workspace-write/strict；codex: read-only/workspace-write/danger-full-access），
   * 强行复用一个 setting 必然要做名字映射，反而引入混乱。
   *
   * **关闭开关只影响下次新建会话**——已在跑的 codex thread 已按当前档位 spawn，
   * sandboxMode 是 startThread 时一次性传入，不会被撤销（与 claudeCodeSandbox 同模式）。
   */
  codexSandbox: 'workspace-write' | 'read-only' | 'danger-full-access';
  /**
   * Codex MCP servers 配置（CHANGELOG_<X> A4b）。Agent Deck 自管的 mcp_servers 段
   * 写入 `~/.codex/config.toml` 用 marker 包裹，**不破坏**用户手写的其他段。
   * 详见 `src/main/codex-config/toml-writer.ts`。
   *
   * 字段值：CodexMcpServerConfigShared 数组。空数组 = 不写 server（marker 仍写入但内容为空）。
   *
   * 改这个设置 → ipc/settings.ts apply* 调 writeMcpServersToCodexConfig 同步写盘 →
   * 下次新建 codex 会话生效。已在跑的 thread 已按 spawn-time 加载的 mcp_servers 配置
   * 跑，关掉不会撤销。
   *
   * 与 settings.codexCliPath 同模式：spawn-time options，不影响在跑会话。
   */
  codexMcpServers: CodexMcpServerConfigShared[];
  /**
   * Teammate 权限 auto-approve 档位（**R3.E6 删除占位字段，下方 R3 新字段取代**）。
   * 老 inbox 协议下线后，新 universal team backend 不需要档位选择 —— teammate 调工具走自己
   * adapter 的 canUseTool / hook（即「自己 session 的权限边界」），不再走 lead inbox。
   */
  // (字段删除；settings-store REMOVED_KEYS 自动清历史)

  // ─────────────────────────────────────── Agent Deck MCP server (R2 / B'0 ADR §7)

  /**
   * Agent Deck MCP server 总开关（默认 false / R2 / B'0 ADR §7）。
   *
   * 开 → 三 transport 同时启用：
   * - in-process（claude SDK 会话自动挂，B'3）
   * - HTTP（fastify HookServer `/mcp` 路由，B'4 + codex 自动注入）
   * - stdio（`agent-deck mcp` 子命令，B'1，外部 MCP client 用）
   *
   * 关 → in-process 不挂 + HTTP 路由 401 + stdio 子命令报「未启用」 +
   * Codex config.toml 自动剥离 `mcp_servers.agent_deck` 段。
   *
   * 与 injectAgentDeckPlugin 同模式：spawn-time 注入，关掉只影响**下次新建会话**。
   * HTTP 路由 hot-toggle 立即生效。
   *
   * **plan task-mcp-merge-into-agent-deck-mcp-20260521**：原 enableTaskManager 字段下线后，
   * 5 个 task tool（task_create / task_list / task_get / task_update / task_delete）
   * 也跟随本开关，工具名 mcp__agent-deck__task_*（breaking from mcp__tasks__*）。
   */
  enableAgentDeckMcp: boolean;
  /**
   * MCP HTTP / stdio transport Bearer token（默认 null → 首次启用时 settings-store
   * 自动生成 32 字节 hex 持久化）。与 hookServerToken **独立**：
   * - hook token 嵌进每个 CLI 子进程 spawn 的 hook 命令，泄漏面广
   * - mcp token 仅嵌进 codex `~/.codex/config.toml` mcp_servers 段（B'4）+ Settings
   *   UI 显示给用户复制（外部 MCP client 用），泄漏面窄
   *
   * in-process transport 不走 token（同进程闭包，B'3）。用户**不应**在 UI 上修改此值；
   * 仅在被泄漏需要轮换时手动清掉持久化文件让它重生成。
   */
  mcpServerToken: string | null;
  /**
   * HTTP `/mcp` 路由开关（默认 true，配 codex 自动注入用）。
   * `enableAgentDeckMcp` ON 但本字段 OFF → 仅 in-process 给 claude（codex 没法连）。
   * Hot-toggle 立即生效。
   */
  mcpHttpEnabled: boolean;
  /**
   * stdio 子命令开关（默认 false / 仅外部用户主动开）。
   * 影响 `agent-deck mcp` 子命令是否真启 stdio transport，OFF 时报「未启用」错退出。
   * 默认 false 是因为 stdio external caller 默认 deny spawn_session（详 B'0 §4.3）。
   */
  mcpStdioEnabled: boolean;
  /**
   * MCP `spawn_session` 防递归：spawn 链最大深度（默认 3，范围 [1, 10]）。
   * 触顶 → handler 返回 isError「spawn depth N >= max M」。
   * lead → teammate → sub-teammate → leaf 三层够大多数场景；hierarchical 4 层
   * 用例可调到 4。详 B'0 §6.1 / §11.6。
   */
  mcpMaxSpawnDepth: number;
  /**
   * MCP `spawn_session` 防递归：应用级全局 spawn-rate 上限（默认 20/min，范围 [1, 60]）。
   * 滑动窗口跨所有 caller 累计。触顶 → handler 返回 isError + retry_after_ms。
   * 默认 20 是 P5 plan codex-handoff-team-alignment-20260518 deep-review 多 batch 并发实跑修法
   * （原 10 在 3 batch × 2 reviewer = 6 并发 spawn 时偏紧）。详 B'0 §6.3。
   */
  mcpSpawnRatePerMinute: number;
  /**
   * MCP `spawn_session` 防递归：单 caller 的 active children 上限（默认 10，范围 [1, 20]）。
   * 触顶 → handler 返回 isError「fan-out N reached for parent X」。
   * 默认 10 是 P5 plan codex-handoff-team-alignment-20260518 deep-review 多 batch 并发实跑修法
   * （原 5 在 3 batch × 2 reviewer = 6 teammate 时撞顶 + 加一对反驳轮就溢出）。详 B'0 §6.4。
   */
  mcpMaxFanOutPerParent: number;

  // ─────────────────────────────────────── R3 universal team backend (E0 ADR §7.5)

  /**
   * universal-message-watcher per-team rate limit（默认 60 messages/min，范围 [10, 600]）。
   *
   * messageRepo.insert 入口校验：覆盖 IPC + MCP 两路；超限抛 `team-rate-limit-exceeded` +
   * retryAfterMs，caller decide 重试。详 docs/agent-deck-team-protocol.md §7.5。
   *
   * 调高规则：deep-review 反驳轮 + cross-adapter 协作场景下 60/min 偶有不足时，调到
   * 120-180。调到 ≥ 300 前请确认 codex MAX_PENDING_MESSAGES=20 队列不会被堵死
   * （per-target backpressure 兜底，但会触发 caller-side 重试风暴）。
   */
  mcpMessageRatePerTeamPerMin: number;

  /**
   * universal-message-watcher per-target backpressure 阈值（默认 10，范围 [1, 50]）。
   *
   * watcher 每轮 claim 前查 `to_session_id` 当前 in-flight count（status IN ('pending','delivering')），
   * 超过阈值则跳过本 row 本轮；下次 poll 重试。caller-side 不阻塞 enqueue（避免 lead 卡死）。
   *
   * 设计动机：避免 burst 投递把 codex MAX_PENDING_MESSAGES=20 队列灌爆。
   */
  mcpMessageMaxTargetInflight: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  hookServerPort: 47821,
  hookServerToken: null,
  enableSound: true,
  enableSystemNotification: true,
  silentWhenFocused: true,
  waitingSoundPath: null,
  finishedSoundPath: null,
  activeWindowMs: 30 * 60 * 1000,
  closeAfterMs: 24 * 60 * 60 * 1000,
  summaryIntervalMs: 5 * 60 * 1000,
  summaryEventCount: 10,
  summaryMaxConcurrent: 2,
  summaryTimeoutMs: 60 * 1000,
  // plan prancy-forging-penguin: provider × model × reasoning 三联字段(summary / handoff 两组)
  // - summaryModel/handOffModel: 默认空 = 沿用各 provider env / alias / config.toml 链
  // - summaryProvider/handOffProvider: 默认 'claude'(走 claude SDK + OAuth 凭证)
  // - summaryReasoning/handOffReasoning: 默认 low/medium 与原 hardcoded 行为对齐(仅 codex provider 生效)
  summaryProvider: 'claude',
  summaryModel: '',
  summaryReasoning: 'low',
  handOffProvider: 'claude',
  handOffModel: '',
  handOffReasoning: 'medium',
  permissionTimeoutMs: 5 * 60 * 1000,
  alwaysOnTop: true,
  windowTransparent: true,
  startOnLogin: false,
  historyRetentionDays: 30,
  codexCliPath: null,
  claudeCliPath: null,
  injectAgentDeckClaudeMd: true,
  injectAgentDeckCodexAgentsMd: true,
  injectAgentDeckCodexSkills: true,
  injectAgentDeckPlugin: true,
  // R3.E6 (PR-B) 删 agentTeamsEnabled / autoApproveTeammateMode；
  // plan task-mcp-merge-into-agent-deck-mcp-20260521 删 enableTaskManager；
  // REMOVED_KEYS + smart migration 自动清历史 + 守护老用户 ON 值（详 settings-store.ts）
  autoSummariseOnFallback: true,
  claudeCodeSandbox: 'off',
  codexSandbox: 'workspace-write',
  codexMcpServers: [],
  // R3.E6 删 autoApproveTeammateMode；REMOVED_KEYS 自动清历史
  // B'0 ADR §7：Agent Deck MCP server 默认 OFF（task tools 跟随，详 enableAgentDeckMcp jsdoc）
  enableAgentDeckMcp: false,
  mcpServerToken: null,
  mcpHttpEnabled: true,
  mcpStdioEnabled: true,
  mcpMaxSpawnDepth: 3,
  mcpSpawnRatePerMinute: 20,
  mcpMaxFanOutPerParent: 10,
  // R3.E0 ADR §7.5：universal-message-watcher 限流默认值
  mcpMessageRatePerTeamPerMin: 60,
  mcpMessageMaxTargetInflight: 10,
};

// ───────────────────────────────────────────────────────── Hook Status

export interface HookInstallStatus {
  installed: boolean;
  scope: 'user' | 'project' | null;
  settingsPath: string | null;
  installedHooks: string[];
}

// ───────────────────────────────────────────────────────── Permission Settings Scan

/**
 * Claude Code 的 settings 四层来源（与 SDK 实际读取行为对齐）。
 * 优先级低 → 高（高覆盖低）：
 * - user:       ~/.claude/settings.json
 * - user-local: ~/.claude/settings.local.json   ← 官方文档未明示，但 SDK / CLI 实际会读
 * - project:    <cwd>/.claude/settings.json
 * - local:      <cwd>/.claude/settings.local.json
 */
export type SettingsSource = 'user' | 'user-local' | 'project' | 'local';

/** 每层 settings.json 解析出的 permissions 字段（按 SDK schema 抽取，未知字段忽略）。 */
export interface SettingsPermissionsBlock {
  allow: string[];
  deny: string[];
  ask: string[];
  additionalDirectories: string[];
  defaultMode: string | null;
}

/** 单层 settings 文件的扫描结果。文件不存在也会返回（exists=false + raw=null）。 */
export interface SettingsLayer {
  source: SettingsSource;
  /** 推断出的绝对路径，无论是否存在 */
  path: string;
  exists: boolean;
  /** 原文（pretty-print 后），文件不存在为 null */
  raw: string | null;
  /** JSON.parse 结果，解析失败 / 文件不存在为 null */
  parsed: unknown | null;
  /** 解析失败时记错误消息 */
  parseError: string | null;
  /** 提取出的 permissions 块；不存在 / 解析失败时为 null */
  permissions: SettingsPermissionsBlock | null;
}

/** 合并视图：去重后每条规则带来源层标签。 */
export interface MergedRule {
  rule: string;
  sources: SettingsSource[];
}

export interface MergedDirectory {
  dir: string;
  sources: SettingsSource[];
}

export interface MergedPermissions {
  allow: MergedRule[];
  deny: MergedRule[];
  ask: MergedRule[];
  additionalDirectories: MergedDirectory[];
  /** 倒序找第一个非 null：local > project > user-local > user */
  defaultMode: { value: string; source: SettingsSource } | null;
}

export interface PermissionScanResult {
  /** 入参 cwd 原值（trim 后；为空时 main 进程会替换成 homedir，并在 cwdResolved 标记） */
  cwd: string;
  /** 实际用于解析 project / local 的 cwd（兜底为 homedir） */
  cwdResolved: string;
  user: SettingsLayer;
  /** ~/.claude/settings.local.json，user 级个人覆盖 */
  userLocal: SettingsLayer;
  project: SettingsLayer;
  local: SettingsLayer;
  merged: MergedPermissions;
}
