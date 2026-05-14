/**
 * SDK query() options 构造器（CHANGELOG_85 Step 3.2）。
 *
 * 抽自 ClaudeSdkBridge.createSession 内 query() options 整段（原 ~95 行 + 完整设计
 * 注释紧贴各字段）。把所有 SDK 配置项收口到一个 pure builder 里，让 facade
 * createSession 只关心拼装结果而非每个字段的设计取舍。
 *
 * **完整保留所有原 jsdoc**（SDK options 字段旁的「为什么这么传」注释是 review-time
 * 关键 context，不能丢）。
 *
 * pure function（无 I/O / 无 side effect）：所有外部依赖通过 args 显式注入，不
 * 直接读 settingsStore / sessionRepo / eventBus。caller 负责 await load 各项后传入。
 */

import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { buildSandboxOptions } from '@main/adapters/claude-code/sandbox-config';
import type {
  getAgentDeckPluginsForSession,
  getAgentDeckSystemPromptAppend,
} from '@main/adapters/claude-code/sdk-injection';
import type { getSdkRuntimeOptions } from '@main/adapters/claude-code/sdk-runtime';
import { AGENT_DECK_MCP_TOOL_PATTERN } from '@main/agent-deck-mcp/server';

export interface BuildClaudeQueryOptionsArgs {
  cwd: string;
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  resume?: string;
  canUseTool: CanUseTool;
  sandboxOpts: ReturnType<typeof buildSandboxOptions>;
  systemPromptAppend: ReturnType<typeof getAgentDeckSystemPromptAppend>;
  plugins: ReturnType<typeof getAgentDeckPluginsForSession>;
  runtime: ReturnType<typeof getSdkRuntimeOptions>;
  /** undefined → SDK 自己解析；非 undefined → 显式覆盖 .app/asar.unpacked 路径 */
  claudeBinary: string | undefined;
  mcpServers: {
    tasksServer: McpSdkServerConfigWithInstance | null;
    agentDeckMcpServer: McpSdkServerConfigWithInstance | null;
  };
  /**
   * plan model-wiring-and-handoff-20260514 Step 2.3：SDK model 透传。
   * undefined → 不传 model 字段，SDK 自己读 ANTHROPIC_MODEL env / 默认 model；
   * 非 undefined → 'opus' / 'sonnet' / 'haiku' alias 或具体 model id（详
   * model-resolve.ts fallback 链）。
   */
  model?: string;
}

/**
 * 构造 SDK `query({ prompt, options: <here> })` 用的 options 对象。
 *
 * 与原 createSession 内联拼装行为字节级等价，所有字段 jsdoc 完整保留。
 */
export function buildClaudeQueryOptions(args: BuildClaudeQueryOptionsArgs): Options {
  const {
    cwd,
    permissionMode,
    resume,
    canUseTool,
    sandboxOpts,
    systemPromptAppend,
    plugins,
    runtime,
    claudeBinary,
    mcpServers: { tasksServer, agentDeckMcpServer },
    model,
  } = args;

  return {
    cwd,
    permissionMode: permissionMode ?? 'default',
    // bypassPermissions 是 SDK 的"敏感档"，必须配套显式打开 allowDangerouslySkipPermissions
    // 否则 CLI 子进程会拒绝该模式（sdk.mjs 把它们当两个独立 CLI flag 传）。
    // 只在用户明确选了 bypassPermissions 时才开 —— 这样运行时 setPermissionMode 切到
    // 别的模式后，flag 不会留下残余权限放大风险（CLI 子进程已经按这个 flag 启动）。
    allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions',
    // Claude Code 默认 system prompt + agent-deck 自带 CLAUDE.md（追加到末尾）。
    // append 文本读自 resources/claude-config/CLAUDE.md，跟随应用打包；
    // 实际位置在 user/project/local 三层 CLAUDE.md 全部加载完之后，
    // LLM 上下文末尾位置 instruction following 最强。
    // 已去掉用户自定义 systemPrompt 功能（避免 isolation mode 与 agent-deck 约定冲突）。
    //
    // CHANGELOG_46 起 team 名由 lead 在会话内自由建（NewSessionDialog 删了 teamName
    // 输入框），spawn 时不需要在 systemPrompt 拼 per-session team 元信息——team-coordinator
    // 通过 PreToolUse hook / fs watcher / hook 三层反向同步即可。
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: systemPromptAppend,
    },
    // agent-deck 自带 plugin：受 settings.injectAgentDeckPlugin 开关控制
    // （与 CLAUDE.md 注入开关同模式）。开 → skill 以 `agent-deck:<skill-name>`
    // 命名空间注册；关 → 返回空数组，会话只能用 user/project/local 范围 skill。
    // 与用户 ~/.claude/skills/ + project .claude/skills/ 都不冲突
    // （plugin 强制命名空间前缀）。
    plugins,
    // Task Manager（CHANGELOG_43）+ Agent Deck MCP（B'3）：开关开 → 挂对应
    // in-process MCP server + pre-approve `mcp__<name>__*` 通配（应用工具属于
    // 受控工具，不走 canUseTool 弹框）。两者独立 toggle，可同开 / 同关 / 单挂。
    // 开关关 → 不展开两字段，与不挂 plugin 同语义零副作用。
    ...(tasksServer || agentDeckMcpServer
      ? {
          mcpServers: {
            ...(tasksServer ? { tasks: tasksServer } : {}),
            ...(agentDeckMcpServer ? { 'agent-deck': agentDeckMcpServer } : {}),
          },
          allowedTools: [
            ...(tasksServer ? ['mcp__tasks__*'] : []),
            ...(agentDeckMcpServer ? [AGENT_DECK_MCP_TOOL_PATTERN] : []),
          ],
        }
      : {}),
    // 复用本地 Claude Code 配置（hooks / MCP / agents / permissions）
    settingSources: ['user', 'project', 'local'],
    canUseTool,
    // resume：传入历史 sessionId，SDK 会让 CLI 加载 ~/.claude/projects/<cwd>/<sid>.jsonl
    // 续上之前的对话，第一条 SDKMessage 的 session_id 就是这个 sid。
    resume,
    // SDK 默认 spawn 'node'，但 .app 走 launchd 启动时 PATH 不含 nvm/homebrew 的 node。
    // 用 Electron 二进制 + ELECTRON_RUN_AS_NODE=1 复用内置 Node runtime（详见 sdk-runtime.ts）。
    executable: runtime.executable,
    // REVIEW_12 Bug 5：注入 AGENT_DECK_ORIGIN=sdk env，CLI 子进程继承后由 hook curl
    // 命令转发为 X-Agent-Deck-Origin: sdk header；HookServer 据此把 event.hookOrigin
    // 标为 'sdk'。即便 OLD CLI 被 SIGTERM 后内部 fork 出新 sessionId + cwd=home dir
    // fallback 飞回迟到 hook event，仍带 hookOrigin='sdk'，ingest 入口能据此 skip
    // 不创建 source='cli' 孤儿 record。用户独立终端跑 `claude` 没有此 env，header
    // 走默认 'cli'，不受影响。
    //
    // R3.E6：删除 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS env 注入。
    // universal team backend (DB watcher) 不依赖 CLI 实验特性。
    env: {
      ...runtime.env,
      AGENT_DECK_ORIGIN: 'sdk',
    },
    // SDK 0.2.x 把 cli.js 拆成 native binary（platform-specific 包），SDK 内部
    // require.resolve 拿到的路径在 .app 里走 `app.asar/...`，spawn 走系统 syscall
    // 不经 Electron fs patch → ENOTDIR → query 立刻死。显式传解析后的 unpacked 路径
    // 绕开 SDK 自带 K7。dev 模式下函数返回真实 node_modules 路径，无副作用。
    ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
    // plan model-wiring-and-handoff-20260514 Step 2.3：spawn 时 frontmatter `model` 透传给
    // SDK。空（undefined）→ 不展开此字段，SDK 自己读 ANTHROPIC_MODEL env / 默认 model；
    // 非空 → 'opus' / 'sonnet' / 'haiku' alias 或具体 model id（如
    // 'claude-opus-4-7-thinking-max[1m]'），SDK CLI 透传给 API 决定模型。
    // 优先级链由 model-resolve.ts 负责（opts.model > sessionRepo.model > undefined）。
    ...(model ? { model } : {}),
    // OS 级沙盒（REVIEW_14 阶段 2 + REVIEW_15 实测纠错）：根据 settings.claudeCodeSandbox
    // 档位拼装**顶层 sandbox 字段**（REVIEW_15 实测铁证：managedSettings.sandbox 包装无效，
    // 必须用顶层 `sandbox: SandboxSettings` 字段，详 sandbox-config.ts 头注释决策 #1）。
    // 'off' 返回空对象，无 sandbox 字段，行为同现状（仅 canUseTool 弹框）。
    // 'workspace-write' / 'strict' 返回 `{ sandbox: {...} }` 顶层（spread 到 SDK options 顶层）。
    //
    // **summarizer 不被污染**：summarizer 走 `settingSources: []` + 自己 query() 调用，
    // 不读 sandbox 设置（与 agentTeamsEnabled 隔离同模式）。
    //
    // **双弹框 UX 收口**：sandbox 启用后 model 想联网会触发 SDK 内置的
    // `SandboxNetworkAccess` 工具 → canUseTool 顶部自动 deny + message → model
    // fallback `dangerouslyDisableSandbox: true` 重试 → canUseTool 弹给用户审批
    // （仅 1 次弹框）。strict 档因 `allowUnsandboxedCommands: false` 直接封死
    // 逃逸路径，model 报「无法联网」给用户。
    //
    // 用前面预算好的 sandboxOpts（避免重复 settingsStore.get + 让 console.log 与
    // 实际传给 SDK 的值一定一致，杜绝「log 说 enabled 但实际没传」的矛盾）。
    ...sandboxOpts,
  } as Options;
}
