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
  /** 权限请求未响应自动 abort 的阈值（毫秒）。0 = 不超时。 */
  permissionTimeoutMs: number;
  alwaysOnTop: boolean;
  /**
   * pin（始终置顶）时是否同步关闭系统 vibrancy（macOS 「under-window」毛玻璃）让 CSS 主导通透。
   * - true（默认，与历史行为一致）：pin 时去掉浅灰玻璃基底，肉眼能透到下层桌面 / 其它 app；
   *   配合 startInvalidateLoop + setBackgroundThrottling(false) 持续刷新下层像素。
   * - false：pin 时仍保留 'under-window' 实玻璃，看不到下层。
   * 改动即时生效（不需要重启 / 重建窗口）。
   */
  transparentWhenPinned: boolean;
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
   * - **skills**：以 `agent-deck:<skill-name>` 命名空间注册（如 `agent-deck:deep-code-review`，
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
  /**
   * Agent Teams 实验特性总开关（默认 OFF）。开启后 NewSessionDialog 暴露 teamName 输入框；
   * 用户填了 teamName 的 SDK 会话在 spawn 时注入 env `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`，
   * 让 Claude 内部启用 agent teams（lead spawn teammates、共享 task list、3 个新 hook 事件）。
   *
   * 兼容性：需 Claude Code CLI ≥ v2.1.32（应用启动时 `claude --version` 自检；< 2.1.32
   * 自动跳过 hook 注入并在 SettingsDialog 显示版本不足提示）。Opus 4.6+ 推荐。
   *
   * 已知限制（Anthropic 官方）：no `/resume` 与 `/rewind`；no nested teams；one team per
   * session；lead 终身固定。**关闭开关只影响下次新建会话**——CLI 子进程已按 team 模式启动，
   * env 是 spawn 时一次性传入，不会被撤销。
   */
  agentTeamsEnabled: boolean;
  /**
   * SDK Task Manager 总开关（默认 OFF / CHANGELOG_43）。开启后 SDK 会话 `query()`
   * 注入 5 个 in-process MCP tools（mcp__tasks__task_create / list / get / update /
   * delete），让 Claude 能跨 SDK Agent 协作管理结构化任务（与 ~/.claude/tasks/<team>/
   * <list>.md 自然语言任务并行；本工具是结构化、可被 tool 精确调用的另一套）。
   *
   * 与 injectAgentDeckPlugin / agentTeamsEnabled 同模式：spawn-time 注入，关掉**只影响
   * 下次新建会话**——已起的 CLI 子进程已按这个 flag 启动 mcpServers / allowedTools，
   * 撤不掉。summarizer 走自己的 query() 不受本开关影响（设计与 sandbox 同隔离）。
   *
   * Closure 自动注入 team_name：每个 SDK 会话的 task_create / task_update / task_delete
   * 强制用当前 session.team_name（agent 不必也不能瞎传），避免任务漂到别的 team；
   * task_list / task_get 是只读，允许 args 显式跨 team 查询协调。
   */
  enableTaskManager: boolean;
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
   * Teammate 权限 auto-approve 档位（CHANGELOG_<X> B2）。Agent Teams in-process backend
   * 的 teammate 调工具走 inbox 协议（`~/.claude/teams/<X>/inboxes/team-lead.json`），**不会**
   * 回到 lead 的 SDK canUseTool 回调（CHANGELOG_45），所以 lead 的 permissionMode /
   * settings.json permissions.allow / READ_ONLY_TOOLS 白名单在 teammate 这边全失效。
   * inbox-watcher 检测到 permission_request 时按本档位决定是否应用层主动写 inbox response
   * allow，跳过 UI 弹框。**对 lead 自己的工具调用零影响**（lead 走 SDK canUseTool，
   * 已经有自己的 READ_ONLY_TOOLS 白名单）。
   *
   * 三档语义：
   * - `'off'`：一律弹 UI（旧行为）
   * - `'read-only'`：READ_ONLY_TOOLS（Read/Grep/Glob/LS/WebFetch/WebSearch/TodoWrite/NotebookRead）
   *   + `__ImageRead` 后缀 + `mcp__tasks__*` 前缀自动允许（默认）
   * - `'follow-lead'`：以上 + 跟随 lead permissionMode；
   *   lead `acceptEdits` → 加放行 EDIT_TOOLS（Edit / Write / MultiEdit / NotebookEdit）；
   *   lead `bypassPermissions` → 全放行；
   *   lead `default` / `plan` / null → 降回 read-only
   *
   * **运行时立即生效**（不像 mcpServers / sandbox 那样 spawn-time 固化）——inbox-watcher
   * 每次 processInboxFile 都从 settingsStore 读 current 值。
   */
  autoApproveTeammateMode: 'off' | 'read-only' | 'follow-lead';

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
   * 与 enableTaskManager 同模式：spawn-time 注入，关掉只影响**下次新建会话**。
   * HTTP 路由 hot-toggle 立即生效。
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
   * MCP `spawn_session` 防递归：应用级全局 spawn-rate 上限（默认 10/min，范围 [1, 60]）。
   * 滑动窗口跨所有 caller 累计。触顶 → handler 返回 isError + retry_after_ms。
   * 默认 10 是 reviewer 双对抗 MED 修法（原 5 偏紧，并行 deep-review 留 buffer）。
   * 详 B'0 §6.3。
   */
  mcpSpawnRatePerMinute: number;
  /**
   * MCP `spawn_session` 防递归：单 caller 的 active children 上限（默认 5，范围 [1, 20]）。
   * 触顶 → handler 返回 isError「fan-out N reached for parent X」。
   * 详 B'0 §6.4。
   */
  mcpMaxFanOutPerParent: number;
  /**
   * MCP `wait_reply` 的 idle 静默判定阈值（默认 5000ms，范围 [1000, 60000]）。
   * `until: 'idle'` 模式下，session 在该阈值内无新事件即返回。
   * **不**暴露给 tool args（避免 prompt 注入打死循环）；用户可在 Settings UI 调全局值。
   * 高 reasoning effort（codex xhigh / claude opus）场景推荐用 `until: 'turn_complete'`
   * 而非 idle，避免误判。详 B'0 §3.3.1 / §11.4。
   */
  mcpWaitReplyIdleQuietMs: number;
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
  permissionTimeoutMs: 5 * 60 * 1000,
  alwaysOnTop: true,
  transparentWhenPinned: true,
  startOnLogin: false,
  historyRetentionDays: 30,
  codexCliPath: null,
  injectAgentDeckClaudeMd: true,
  injectAgentDeckCodexAgentsMd: true,
  injectAgentDeckCodexSkills: true,
  injectAgentDeckPlugin: true,
  agentTeamsEnabled: false,
  enableTaskManager: false,
  claudeCodeSandbox: 'off',
  codexSandbox: 'workspace-write',
  codexMcpServers: [],
  autoApproveTeammateMode: 'read-only',
  // R2 / B'0 ADR §7：Agent Deck MCP server 默认 OFF（与 enableTaskManager 同模式）
  enableAgentDeckMcp: false,
  mcpServerToken: null,
  mcpHttpEnabled: true,
  mcpStdioEnabled: false,
  mcpMaxSpawnDepth: 3,
  mcpSpawnRatePerMinute: 10,
  mcpMaxFanOutPerParent: 5,
  mcpWaitReplyIdleQuietMs: 5000,
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
