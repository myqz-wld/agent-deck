import { useState, type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { Section, Toggle, NumberInput } from '../controls';
import { CopyIcon } from '../../icons';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

/**
 * 「Agent Deck MCP server」settings section（B'0 ADR §7 / B'6,CHANGELOG_160 简化）。
 *
 * 功能：让 claude / deepseek / codex / 第三方 MCP client 通过 19 个 tool 跨 adapter
 * 编排其他 coding agent session、向用户展示 plan / diff 并收集确认或反馈、管理结构化任务并上报 issue。
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
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <Section title="Agent Deck MCP" storageKey="agent-deck-mcp" defaultOpen={false}>
      <Toggle
        label="启用 Agent Deck MCP"
        value={settings.enableAgentDeckMcp}
        onChange={(v) => void update({ enableAgentDeckMcp: v })}
      />
      <div className="text-[10px] leading-snug text-deck-muted/70">
        让 Claude、Deepseek、Codex 等 MCP 客户端跨会话协作、展示计划和 diff，并管理任务与 Issue。
        <details className="mt-1">
          <summary className="cursor-pointer text-deck-muted hover:text-deck-text/85">查看全部 19 个工具</summary>
          <div className="mt-1 pl-2 text-deck-muted/80">
            <strong className="text-deck-text/85">会话编排</strong>：
            <code className="rounded bg-white/5 px-1">spawn_session</code> /
            <code className="rounded bg-white/5 px-1">send_message</code> /
            <code className="rounded bg-white/5 px-1">list_sessions</code> /
            <code className="rounded bg-white/5 px-1">get_session</code> /
            <code className="rounded bg-white/5 px-1">list_session_events</code> /
            <code className="rounded bg-white/5 px-1">shutdown_session</code> /
            <code className="rounded bg-white/5 px-1">hand_off_session</code>
            <br />
            <strong className="text-deck-text/85">用户展示</strong>：
            <code className="rounded bg-white/5 px-1">present_plan</code> /
            <code className="rounded bg-white/5 px-1">present_diff</code>
            <br />
            <strong className="text-deck-text/85">Worktree</strong>：
            <code className="rounded bg-white/5 px-1">enter_worktree</code> /
            <code className="rounded bg-white/5 px-1">exit_worktree</code>
            <br />
            <strong className="text-deck-text/85">结构化任务</strong>：
            <code className="rounded bg-white/5 px-1">task_create</code> /
            <code className="rounded bg-white/5 px-1">task_list</code> /
            <code className="rounded bg-white/5 px-1">task_get</code> /
            <code className="rounded bg-white/5 px-1">task_update</code> /
            <code className="rounded bg-white/5 px-1">task_delete</code>
            <br />
            <strong className="text-deck-text/85">Issue 跟踪</strong>：
            <code className="rounded bg-white/5 px-1">report_issue</code> /
            <code className="rounded bg-white/5 px-1">append_issue_context</code> /
            <code className="rounded bg-white/5 px-1">update_issue_status</code>
          </div>
        </details>
        <div className="mt-1">
          <strong className="text-deck-text/85">任务权限：</strong>个人任务归创建它的会话所有；团队成员可写团队任务；外部客户端只读。
        </div>
        <div className="mt-1">
          <strong className="text-amber-300/90">MCP 开关修改后需重启应用，且只影响之后新建的会话。</strong>
        </div>
      </div>

      <div className="mt-3 border-t border-deck-border/50 pt-3">
        <div className="text-[11px] font-medium text-deck-text/85">三种连接方式（默认全部启用）</div>
        <table className="mt-1.5 w-full border-collapse text-[10px] leading-snug">
          <tbody>
            <tr className="border-b border-deck-border/40">
              <td className="py-1 pr-2 align-top font-medium text-deck-text/85">应用内</td>
              <td className="py-1 text-deck-muted/80">
                Claude Code SDK 会话自动连接，无需手动配置
              </td>
            </tr>
            <tr className="border-b border-deck-border/40">
              <td className="py-1 pr-2 align-top font-medium text-deck-text/85">HTTP</td>
              <td className="py-1 text-deck-muted/80">
                Codex 自动连接；外部客户端可连接
                <code className="rounded bg-white/5 px-1">/mcp</code>（需要下方 Token）
              </td>
            </tr>
            <tr>
              <td className="py-1 pr-2 align-top font-medium text-deck-text/85">stdio</td>
              <td className="py-1 text-deck-muted/80">
                外部客户端通过 <code className="rounded bg-white/5 px-1">agent-deck mcp</code> 连接，仅可读取
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="mt-3 border-t border-deck-border/50 pt-3">
        <div className="text-[11px] font-medium text-deck-text/85">防递归阈值（即时生效）</div>
        <div className="mt-1.5 flex flex-col gap-1.5">
          <NumberInput
            label="最大协作层级"
            value={settings.mcpMaxSpawnDepth}
            min={1}
            max={10}
            onChange={(v) => void update({ mcpMaxSpawnDepth: v })}
          />
          <NumberInput
            label="每分钟最多启动"
            value={settings.mcpSpawnRatePerMinute}
            min={1}
            max={60}
            onChange={(v) => void update({ mcpSpawnRatePerMinute: v })}
          />
          <NumberInput
            label="每个会话最多子会话"
            value={settings.mcpMaxFanOutPerParent}
            min={1}
            max={20}
            onChange={(v) => void update({ mcpMaxFanOutPerParent: v })}
          />
        </div>
        <div className="mt-1 text-[10px] leading-snug text-deck-muted/70">
          <strong>协作层级：</strong>负责人 → 协作者 → 子协作者，默认三层。
          <br />
          <strong>启动速度：</strong>所有会话合计的每分钟上限。
          <br />
          <strong>子会话数：</strong>每个会话可同时运行的子会话上限。
        </div>
      </div>

      <div className="mt-3 border-t border-deck-border/50 pt-3">
        <div className="text-[11px] font-medium text-deck-text/85">访问 Token</div>
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
                setCopyStatus('idle');
                void navigator.clipboard
                  .writeText(settings.mcpServerToken)
                  .then(() => setCopyStatus('copied'))
                  .catch(() => setCopyStatus('failed'));
              }
            }}
            disabled={!settings.mcpServerToken}
            className="no-drag shrink-0 rounded bg-white/10 px-2 py-0.5 text-[10px] text-deck-text hover:bg-white/20 disabled:opacity-40"
          >
            <CopyIcon className="mr-1 inline h-3 w-3" />
            {copyStatus === 'copied' ? '已复制' : '复制'}
          </button>
        </div>
        {copyStatus === 'failed' && (
          <div className="mt-1 text-[10px] text-status-waiting">复制失败，请手动选择 Token。</div>
        )}
        <div className="mt-1 text-[10px] leading-snug text-deck-muted/70">
          首次启动时自动生成并保存。Codex 会读取环境变量
          <code className="rounded bg-white/5 px-1">AGENT_DECK_MCP_TOKEN</code>；
          外部 HTTP 客户端将此值用作 Bearer Token。
          <br />
          如 Token 泄漏，请删除应用配置目录中
          <code className="rounded bg-white/5 px-1">agent-deck-settings.json</code>
          的 <code className="rounded bg-white/5 px-1">mcpServerToken</code>，再重启应用。
        </div>
      </div>
    </Section>
  );
}
