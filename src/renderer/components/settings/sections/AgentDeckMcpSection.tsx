import { type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { Section, Toggle, NumberInput } from '../controls';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

/**
 * 「Agent Deck MCP server」settings section（B'0 ADR §7 / B'6,CHANGELOG_160 简化）。
 *
 * 功能：让 claude / deepseek / codex / 第三方 MCP client 通过 17 个 tool 跨 adapter
 * 编排其他 coding agent session、请求 plan 检阅、管理结构化任务并上报 issue。
 *
 * UI 布局（自顶向下）：
 * 1. 总开关 enableAgentDeckMcp + 描述
 * 2. 三 transport 简介（CHANGELOG_160:transport 子开关 toggle 已删,默认三 transport 都
 *    enable;字段 mcpHttpEnabled / mcpStdioEnabled 仍持久化但 UI 不暴露,user 想关单独
 *    transport 编辑 settings.json)
 * 3. 防递归 3 条规则的可调阈值（depth / spawn-rate / fan-out）
 * 4. mcpServerToken 显示（只读 + 复制按钮，自动生成不允许改）
 *
 * 与 ExperimentalSection 区分：那边是「实验功能」（Claude / Codex 沙盒档位），
 * 这边是「跨 runtime 编排 + 结构化任务管理」独立 section。
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
        开启后,Claude / Deepseek / Codex / 任何支持 MCP 的 AI 客户端都能在会话里调用工具,编排其他会话、请求计划检阅、管理团队任务并上报 issue。
        <details className="mt-1">
          <summary className="cursor-pointer text-deck-muted hover:text-deck-text/85">查看完整工具清单（17 个）</summary>
          <div className="mt-1 pl-2 text-deck-muted/80">
            <strong className="text-deck-text/85">会话编排</strong>:
            <code className="rounded bg-white/5 px-1">spawn_session</code> /
            <code className="rounded bg-white/5 px-1">send_message</code> /
            <code className="rounded bg-white/5 px-1">request_plan_review</code> /
            <code className="rounded bg-white/5 px-1">list_sessions</code> /
            <code className="rounded bg-white/5 px-1">get_session</code> /
            <code className="rounded bg-white/5 px-1">shutdown_session</code> /
            <code className="rounded bg-white/5 px-1">hand_off_session</code>
            <br />
            <strong className="text-deck-text/85">Worktree</strong>:
            <code className="rounded bg-white/5 px-1">enter_worktree</code> /
            <code className="rounded bg-white/5 px-1">exit_worktree</code>
            <br />
            <strong className="text-deck-text/85">结构化任务</strong>:
            <code className="rounded bg-white/5 px-1">task_create</code> /
            <code className="rounded bg-white/5 px-1">task_list</code> /
            <code className="rounded bg-white/5 px-1">task_get</code> /
            <code className="rounded bg-white/5 px-1">task_update</code> /
            <code className="rounded bg-white/5 px-1">task_delete</code>
            <br />
            <strong className="text-deck-text/85">Issue 跟踪</strong>:
            <code className="rounded bg-white/5 px-1">report_issue</code> /
            <code className="rounded bg-white/5 px-1">append_issue_context</code> /
            <code className="rounded bg-white/5 px-1">update_issue_status</code>
          </div>
        </details>
        <div className="mt-1">
          <strong className="text-deck-text/85">任务权限</strong>:任务归创建会话所有;跨会话写需同属一个团队,外部客户端只能读取。
        </div>
        <div className="mt-1">
          <strong className="text-amber-300/90">⚠️ 仅对新建会话生效。</strong>修改总开关后需要重启应用。
        </div>
      </div>

      <div className="mt-3 border-t border-deck-border/50 pt-3">
        <div className="text-[11px] font-medium text-deck-text/85">三种连接方式（默认全部启用）</div>
        <table className="mt-1.5 w-full border-collapse text-[10px] leading-snug">
          <tbody>
            <tr className="border-b border-deck-border/40">
              <td className="py-1 pr-2 align-top font-medium text-deck-text/85">应用内</td>
              <td className="py-1 text-deck-muted/80">
                Claude Code SDK 会话自动连接,无需鉴权,延迟最低
              </td>
            </tr>
            <tr className="border-b border-deck-border/40">
              <td className="py-1 pr-2 align-top font-medium text-deck-text/85">HTTP</td>
              <td className="py-1 text-deck-muted/80">
                Codex 自动连接;Cursor / Continue / Claude Desktop 等外部客户端也可用
                <code className="rounded bg-white/5 px-1">/mcp</code> 端点(需下方 Bearer Token)
              </td>
            </tr>
            <tr>
              <td className="py-1 pr-2 align-top font-medium text-deck-text/85">stdio</td>
              <td className="py-1 text-deck-muted/80">
                外部客户端通过 <code className="rounded bg-white/5 px-1">agent-deck mcp</code> 子命令连接;只读模式,不可写
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="mt-3 border-t border-deck-border/50 pt-3">
        <div className="text-[11px] font-medium text-deck-text/85">防递归阈值（即时生效）</div>
        <div className="mt-1.5 flex flex-col gap-1.5">
          <NumberInput
            label="最大调用深度"
            value={settings.mcpMaxSpawnDepth}
            min={1}
            max={10}
            onChange={(v) => void update({ mcpMaxSpawnDepth: v })}
          />
          <NumberInput
            label="每分钟启动上限"
            value={settings.mcpSpawnRatePerMinute}
            min={1}
            max={60}
            onChange={(v) => void update({ mcpSpawnRatePerMinute: v })}
          />
          <NumberInput
            label="单会话最大子会话数"
            value={settings.mcpMaxFanOutPerParent}
            min={1}
            max={20}
            onChange={(v) => void update({ mcpMaxFanOutPerParent: v })}
          />
        </div>
        <div className="mt-1 text-[10px] leading-snug text-deck-muted/70">
          <strong>调用深度</strong>:负责人 → 协作者 → 子协作者 三层够大多数场景。
          <br />
          <strong>启动上限</strong>:跨所有会话累计;深度评审跑多对评审员时建议 ≥ 10/分钟。
          <br />
          <strong>子会话数</strong>:单个会话同时活跃子会话上限。
        </div>
      </div>

      <div className="mt-3 border-t border-deck-border/50 pt-3">
        <div className="text-[11px] font-medium text-deck-text/85">MCP Bearer Token（HTTP / stdio）</div>
        <div className="mt-1.5 flex items-center gap-1.5">
          <input
            type="text"
            readOnly
            value={settings.mcpServerToken ?? '（未生成，请重启应用）'}
            className="no-drag min-w-0 flex-1 rounded border border-deck-border bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] text-deck-muted/80 outline-none"
          />
          <button
            type="button"
            onClick={() => {
              if (settings.mcpServerToken) {
                void navigator.clipboard.writeText(settings.mcpServerToken);
              }
            }}
            disabled={!settings.mcpServerToken}
            className="no-drag shrink-0 rounded bg-white/10 px-2 py-0.5 text-[10px] text-deck-text hover:bg-white/20 disabled:opacity-40"
          >
            复制
          </button>
        </div>
        <div className="mt-1 text-[10px] leading-snug text-deck-muted/70">
          首次启动随机生成,持久化保持稳定。Codex 自动连接时通过环境变量
          <code className="rounded bg-white/5 px-1">AGENT_DECK_MCP_TOKEN</code> 引用;
          外部客户端配置 HTTP 连接时复制此 Token 作为 Bearer。
          <br />
          <strong className="text-amber-300/90">⚠️ 不要修改</strong>。如怀疑泄漏,删除设置文件
          <code className="rounded bg-white/5 px-1">~/Library/Application Support/Agent Deck/agent-deck-settings.json</code>
          中的 <code className="rounded bg-white/5 px-1">mcpServerToken</code> 字段并重启,会自动重新生成。
        </div>
      </div>
    </Section>
  );
}
