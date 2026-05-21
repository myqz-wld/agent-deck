import { type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { Section, Toggle, NumberInput } from '../controls';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

/**
 * 「Agent Deck MCP server」settings section（B'0 ADR §7 / B'6）。
 *
 * 功能：让 claude / codex / 第三方 MCP client 通过 10 个 tool（spawn_session /
 * send_message / list_sessions / get_session / shutdown_session / archive_plan /
 * hand_off_session / enter_worktree / exit_worktree / shutdown_baton_teammates）跨 adapter 编排其他 coding agent session。
 *
 * UI 布局（自顶向下）：
 * 1. 总开关 enableAgentDeckMcp + 描述
 * 2. transport 子开关：mcpHttpEnabled（codex / 外部 client 用）/ mcpStdioEnabled（外部 stdio 用）
 * 3. 防递归 3 条规则的可调阈值（depth / spawn-rate / fan-out）
 * 4. mcpServerToken 显示（只读 + 复制按钮，自动生成不允许改）
 *
 * 与 ExperimentalSection 区分：那边是「实验功能」（agentTeamsEnabled / TaskManager / sandbox），
 * 这边是「跨 runtime 编排」独立 section。
 *
 * 改 mcpHttpEnabled / mcpStdioEnabled 提示：HTTP transport 需要重启应用生效（fastify 不支持
 * 运行时 deregister 路由）；mcpHttpEnabled / mcpStdioEnabled / enableAgentDeckMcp 任一从 OFF
 * → ON 都需重启。spawnRatePerMinute / fanOutPerParent 是热生效。
 */
export function AgentDeckMcpSection({ settings, update }: Props): JSX.Element {
  return (
    <Section title="Agent Deck MCP server" storageKey="agent-deck-mcp" defaultOpen={false}>
      <Toggle
        label="启用 Agent Deck MCP server"
        value={settings.enableAgentDeckMcp}
        onChange={(v) => void update({ enableAgentDeckMcp: v })}
      />
      <div className="text-[10px] leading-snug text-deck-muted/70">
        让 claude / codex / 任何支持 MCP 的 coding agent 通过 10 个 tool 跨 adapter
        编排其他会话：<code className="rounded bg-white/5 px-1">spawn_session</code> /
        <code className="rounded bg-white/5 px-1">send_message</code> /
        <code className="rounded bg-white/5 px-1">list_sessions</code> /
        <code className="rounded bg-white/5 px-1">get_session</code> /
        <code className="rounded bg-white/5 px-1">shutdown_session</code> /
        <code className="rounded bg-white/5 px-1">archive_plan</code> /
        <code className="rounded bg-white/5 px-1">hand_off_session</code> /
        <code className="rounded bg-white/5 px-1">enter_worktree</code> /
        <code className="rounded bg-white/5 px-1">exit_worktree</code> /
        <code className="rounded bg-white/5 px-1">shutdown_baton_teammates</code>。
        <br />
        <strong className="text-deck-text/85">三 transport 并存</strong>：
        in-process（claude SDK 会话自动挂）/ HTTP（codex 自动挂 + 外部 MCP client） /
        stdio（外部 client 子命令）。
        <br />
        <strong className="text-amber-300/90">⚠ 关掉只影响下次新建会话</strong>——已 spawn
        的 SDK 会话已固化 mcpServers 列表；HTTP / stdio transport 改 toggle 后需要重启应用
        （fastify 不支持运行时 deregister 路由）。
      </div>

      <div className="mt-3 border-t border-deck-border/50 pt-3">
        <div className="text-[11px] font-medium text-deck-text/85">Transport 子开关</div>
        <div className="mt-1.5">
          <Toggle
            label="HTTP transport（/mcp 路由 + codex 自动注入）"
            value={settings.mcpHttpEnabled}
            onChange={(v) => void update({ mcpHttpEnabled: v })}
          />
        </div>
        <div className="text-[10px] leading-snug text-deck-muted/70">
          开启后 HookServer 挂 <code className="rounded bg-white/5 px-1">/mcp</code> 路由
          （Bearer token 鉴权独立于 hook token），codex 启动时通过 SDK config 自动注入
          <code className="rounded bg-white/5 px-1">mcp_servers.agent-deck</code> 段连接到本应用。
          关闭 → codex 不挂 agent-deck server，外部 MCP client 也无法连。
        </div>
        <div className="mt-2">
          <Toggle
            label="stdio transport（外部 MCP client 子命令）"
            value={settings.mcpStdioEnabled}
            onChange={(v) => void update({ mcpStdioEnabled: v })}
          />
        </div>
        <div className="text-[10px] leading-snug text-deck-muted/70">
          开启后允许外部 MCP client（Cursor / Continue / Claude Desktop）通过
          <code className="rounded bg-white/5 px-1">agent-deck mcp</code> 子命令以 stdio 方式连接。
          外部 caller（<code className="rounded bg-white/5 px-1">caller_session_id=__external__</code>）
          仅允许只读 tool（<code className="rounded bg-white/5 px-1">list_sessions</code> /
          <code className="rounded bg-white/5 px-1">get_session</code>），spawn / send / shutdown 默认 deny。
          <br />
          默认关 —— 仅在你确实需要外部工具调用 agent-deck 时打开。
        </div>
      </div>

      <div className="mt-3 border-t border-deck-border/50 pt-3">
        <div className="text-[11px] font-medium text-deck-text/85">防递归阈值（运行时即时生效）</div>
        <div className="mt-1.5 flex flex-col gap-1.5">
          <NumberInput
            label="spawn 链最大深度（mcpMaxSpawnDepth）"
            value={settings.mcpMaxSpawnDepth}
            min={1}
            max={10}
            onChange={(v) => void update({ mcpMaxSpawnDepth: v })}
          />
          <NumberInput
            label="每分钟 spawn 上限（mcpSpawnRatePerMinute）"
            value={settings.mcpSpawnRatePerMinute}
            min={1}
            max={60}
            onChange={(v) => void update({ mcpSpawnRatePerMinute: v })}
          />
          <NumberInput
            label="单 caller 最大子会话（mcpMaxFanOutPerParent）"
            value={settings.mcpMaxFanOutPerParent}
            min={1}
            max={20}
            onChange={(v) => void update({ mcpMaxFanOutPerParent: v })}
          />
        </div>
        <div className="mt-1 text-[10px] leading-snug text-deck-muted/70">
          <strong>depth</strong>：lead → teammate → sub-teammate → leaf 三层够大多数场景；
          调高需注意 fan-out × spawn-rate 乘积仍由后两条规则兜底（极端 5³=125 descendants 一分钟内会撞 spawn-rate 限流）。
          <br />
          <strong>spawn-rate</strong>：滑动窗口跨所有 caller 累计；deep-review 并行多对 reviewer 时建议 ≥ 10/min。
          <br />
          <strong>fan-out</strong>：单 caller 同时活跃 child 上限；DB 已落地 + 本进程 in-flight 叠加计数。
          <br />
          <strong>idleQuiet</strong>：<code className="rounded bg-white/5 px-1">until: 'idle'</code> 的静默阈值；
          codex xhigh / claude opus 高 reasoning effort 推荐用
          <code className="rounded bg-white/5 px-1">until: 'turn_complete'</code> 而非 idle，避免 thinking 间隔误判。
        </div>
      </div>

      <div className="mt-3 border-t border-deck-border/50 pt-3">
        <div className="text-[11px] font-medium text-deck-text/85">MCP Bearer token（HTTP / stdio）</div>
        <div className="mt-1.5 flex items-center gap-1.5">
          <input
            type="text"
            readOnly
            value={settings.mcpServerToken ?? '(未生成 — 重启应用)'}
            className="no-drag w-full rounded border border-deck-border bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] text-deck-muted/80 outline-none"
          />
          <button
            type="button"
            onClick={() => {
              if (settings.mcpServerToken) {
                void navigator.clipboard.writeText(settings.mcpServerToken);
              }
            }}
            disabled={!settings.mcpServerToken}
            className="no-drag rounded bg-white/10 px-2 py-0.5 text-[10px] text-deck-text hover:bg-white/20 disabled:opacity-40"
          >
            复制
          </button>
        </div>
        <div className="mt-1 text-[10px] leading-snug text-deck-muted/70">
          首次启动随机生成 32 字节（256-bit hex）；持久化保持稳定。
          codex 自动挂时通过 env var <code className="rounded bg-white/5 px-1">AGENT_DECK_MCP_TOKEN</code>
          引用。外部 MCP client 配置 HTTP transport 时复制此 token 作 Bearer。
          <br />
          <strong className="text-amber-300/90">⚠ 不要修改</strong>——如怀疑泄漏，删除
          <code className="rounded bg-white/5 px-1">~/Library/Application Support/Agent Deck/agent-deck-settings.json</code>
          的 <code className="rounded bg-white/5 px-1">mcpServerToken</code> 字段并重启，自动重生成。
        </div>
      </div>
    </Section>
  );
}
