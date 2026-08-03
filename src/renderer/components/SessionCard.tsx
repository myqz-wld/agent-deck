import { useMemo, useState, type JSX } from 'react';
import type { AgentEvent, SessionRecord } from '@shared/types';
import { isImageTool } from '@shared/mcp-tools';
import { StatusBadge } from './StatusBadge';
import { useSessionStore } from '@renderer/stores/session-store';
import { toolIcon } from './activity-feed/tool-icons';
import { describeAgentToolInput, resolveToolNameAlias } from './activity-feed/describe';
import { agentIdLabel } from './TeamDetail/helpers';
import { SessionMetadataChips } from './SessionMetadataChips';
import { SessionContextUsageChip } from './SessionContextUsageChip';
import { SessionPinButton } from './SessionPinButton';
import { ArchiveIcon, CrownIcon, RefreshIcon, ShieldIcon, TrashIcon, UsersIcon } from './icons';
import { errorMessage } from '@renderer/lib/error-message';

interface Props {
  session: SessionRecord;
  selected: boolean;
  onSelect: () => void;
  branch?: string | null;
  /**
   * 由上游 deriveTeamRole 统一计算的团队角色。universal team membership 优先，纯 spawn 链
   * 才按 owner/child 位置回退；lead 使用蓝色边框和标签，teammate 使用浅蓝标签。
   */
  teamRole?: 'lead' | 'teammate';
}

const EMPTY_EVENTS: AgentEvent[] = [];

export function SessionCard({
  session,
  selected,
  onSelect,
  branch,
  teamRole,
}: Props): JSX.Element {
  const recent = useSessionStore((s) => s.recentEventsBySession.get(session.id) ?? EMPTY_EVENTS);
  const latestSummary = useSessionStore((s) => s.latestSummaryBySession.get(session.id));
  const [menuOpen, setMenuOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault();
    setMenuOpen(true);
  };

  const close = (): void => setMenuOpen(false);

  const archive = async (): Promise<void> => {
    setActionError(null);
    try {
      await window.api.archiveSession(session.id);
      close();
    } catch (err) {
      setActionError(`归档失败：${errorMessage(err)}`);
    }
  };
  const reactivate = async (): Promise<void> => {
    setActionError(null);
    try {
      await window.api.reactivateSession(session.id);
      close();
    } catch (err) {
      setActionError(`重新激活失败：${errorMessage(err)}`);
    }
  };
  const remove = async (): Promise<void> => {
    setActionError(null);
    try {
      const ok = await window.api.confirmDialog({
        title: '删除会话',
        message: `确定要删除会话「${session.title}」吗？`,
        detail: '此操作无法撤销，相关事件、文件改动和总结也会删除。',
        okLabel: '删除',
        cancelLabel: '取消',
        destructive: true,
      });
      if (!ok) return;
      await window.api.deleteSession(session.id);
      close();
    } catch (err) {
      setActionError(`删除失败：${errorMessage(err)}`);
    }
  };

  // 卡片展示最多三行去重后的实时活动，并用 useMemo 避免 recent 引用稳定时重复计算。
  // 最后一行展示较稳定的总结，缺失时回退到 cwd。
  const liveLines = useMemo(() => describeLiveActivity(session, recent), [session, recent]);
  const summaryHeadline = latestSummary?.content?.split('\n')[0]?.trim();
  const summaryLine = summaryHeadline
    ? `${latestSummary?.generationSource === 'assistant-fallback' || latestSummary?.generationSource === 'stats-fallback' ? '降级 · ' : ''}${summaryHeadline}`
    : session.cwd || '无工作目录';
  const summaryTitle = latestSummary?.content?.trim() || summaryLine;

  // teams[] 是 universal team backend 的统一投影，首个 membership 提供主团队标签。
  const primaryTeam = session.teams?.[0];
  const displayTeamName = primaryTeam?.teamName ?? null;
  const teamCount = session.teams?.length ?? 0;
  const teamHoverTitle =
    teamCount > 1
      ? `所在团队 (${teamCount}):\n${session.teams!.map((t) => `· ${t.teamName} [${t.role === 'lead' ? '负责人' : '协作者'}]`).join('\n')}`
      : displayTeamName
        ? `团队: ${displayTeamName}`
        : '';

  return (
    <div
      onClick={onSelect}
      onContextMenu={onContextMenu}
      className={`group relative cursor-pointer rounded-lg border px-3 py-2 transition ${
        selected
          ? 'border-white/30 bg-white/10'
          : teamRole === 'lead'
            ? 'border-blue-400/40 bg-white/[0.02] hover:bg-white/[0.06]'
            : 'border-deck-border bg-white/[0.02] hover:bg-white/[0.06]'
      }`}
    >
      <div className="flex items-center gap-2">
        <StatusBadge
          activity={session.activity}
          lifecycle={session.lifecycle}
          archived={session.archivedAt !== null}
        />
        <div className="flex-1 truncate text-[12px] font-medium">{session.title}</div>
        <SessionPinButton session={session} />
        <span
          className={`rounded px-1 py-0.5 text-[8px] font-medium uppercase tracking-wider ${
            session.source === 'sdk'
              ? 'bg-status-working/20 text-status-working'
              : 'bg-white/8 text-deck-muted'
          }`}
          title={session.source === 'sdk' ? '应用内创建的会话' : '终端启动的会话'}
        >
          {session.source === 'sdk' ? '内' : '外'}
        </span>
        {displayTeamName && (
          <span
            className="max-w-[6rem] truncate rounded bg-purple-500/20 px-1 py-0.5 text-[9px] font-medium text-purple-300"
            title={teamHoverTitle}
          >
            <ShieldIcon className="mr-0.5 inline h-3 w-3" />{displayTeamName}
            {teamCount > 1 && <span className="ml-0.5 text-purple-300/70">+{teamCount - 1}</span>}
          </span>
        )}
        {teamRole === 'lead' && (
          <span
            className="rounded bg-blue-400/15 px-1 py-0.5 text-[9px] font-medium text-blue-200"
            title={teamHoverTitle || '本会话是某团队的负责人'}
          >
            <CrownIcon className="mr-0.5 inline h-3 w-3" />负责人
          </span>
        )}
        {teamRole === 'teammate' && (
          <span
            className="rounded bg-blue-400/10 px-1 py-0.5 text-[9px] font-medium text-blue-200/85"
            title={teamHoverTitle || '本会话是某团队的协作者'}
          >
            <UsersIcon className="mr-0.5 inline h-3 w-3" />协作者
          </span>
        )}
        <span className="text-[9px] text-deck-muted/60">{agentIdLabel(session.agentId)}</span>
      </div>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
        <SessionMetadataChips session={session} branch={branch} compact />
        <SessionContextUsageChip session={session} />
      </div>
      {liveLines.length > 0 && (
        <div className="mt-1 flex flex-col gap-0.5">
          {liveLines.map((line, i) => (
            <div
              key={`${i}-${line}`}
              className={`truncate text-[10px] ${
                i === 0 ? 'text-deck-text/85' : 'text-deck-text/60'
              }`}
              title={line}
            >
              {line}
            </div>
          ))}
        </div>
      )}
      <div className="mt-0.5 truncate text-[10px] text-deck-muted/70" title={summaryTitle}>
        {summaryLine}
      </div>
      {actionError && (
        <div className="mt-1 truncate text-[10px] text-status-waiting" title={actionError}>
          {actionError}
        </div>
      )}
      {menuOpen && (
        <>
          <div
            className="fixed inset-0 z-20"
            onClick={(e) => {
              e.stopPropagation();
              close();
            }}
          />
          <div className="absolute right-2 top-2 z-30 w-32 overflow-hidden rounded-md border border-white/10 bg-deck-bg-strong shadow-lg">
            {session.archivedAt === null && (
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left text-[11px] hover:bg-white/10"
                onClick={(e) => {
                  e.stopPropagation();
                  void archive();
                }}
              >
                <ArchiveIcon className="mr-1 inline h-3 w-3" />归档
              </button>
            )}
            {(session.lifecycle === 'closed' || session.lifecycle === 'dormant') && session.archivedAt === null && (
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left text-[11px] hover:bg-white/10"
                onClick={(e) => {
                  e.stopPropagation();
                  void reactivate();
                }}
              >
                <RefreshIcon className="mr-1 inline h-3 w-3" />重新激活
              </button>
            )}
            <button
              type="button"
              className="block w-full px-3 py-1.5 text-left text-[11px] text-status-waiting hover:bg-white/10"
              onClick={(e) => {
                e.stopPropagation();
                void remove();
              }}
            >
              <TrashIcon className="mr-1 inline h-3 w-3" />删除
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 把会话的实时状态浓缩成最多 3 行短文案。waiting 优先级最高（仅返回 1 行），否则按事件 kind
 * 翻译并提取文件名、工具名等可读信息；连续重复行会合并。
 */
function describeLiveActivity(
  session: SessionRecord,
  recent: AgentEvent[],
): string[] {
  if (session.activity === 'waiting') {
    const waitingLine = recent.find((e) => e.kind === 'waiting-for-user');
    return [waitingLine ? formatEventLine(waitingLine) || '⚠️ 等待你的输入' : '⚠️ 等待你的输入'];
  }
  if (session.activity === 'finished' && recent[0]?.kind !== 'tool-use-start') {
    return ['✅ 一轮完成'];
  }
  // 取最近 12 条里最多 3 个有信息量的行（去重连续同行避免「Edit foo.ts × 5」刷屏）
  const lines: string[] = [];
  let lastLine: string | null = null;
  for (const e of recent.slice(0, 12)) {
    const line = formatEventLine(e);
    if (!line) continue;
    if (line === lastLine) continue;
    lines.push(line);
    lastLine = line;
    if (lines.length >= 3) break;
  }
  return lines;
}

export function formatEventLine(e: AgentEvent): string | null {
  const p = payloadObject(e.payload);
  switch (e.kind) {
    case 'tool-use-start': {
      const tool = textValue(p.toolName) || '工具';
      const detail = summariseToolInput(tool, p.toolInput);
      return detail
        ? `${toolIcon(tool, p.toolKind)} ${tool} · ${detail}`
        : `${toolIcon(tool, p.toolKind)} ${tool}`;
    }
    case 'file-changed': {
      const path = textValue(p.filePath);
      return path ? `📝 ${shortenPath(path)}` : null;
    }
    case 'message': {
      const text = typeof p.text === 'string' ? p.text.replace(/\s+/g, ' ').trim() : '';
      if (!text) return null;
      return `💬 ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`;
    }
    case 'message-display': {
      const delta = textValue(p.delta).replace(/\s+/g, ' ');
      if (!delta) return null;
      return `💬 ${delta.slice(0, 80)}${delta.length > 80 ? '…' : ''}`;
    }
    case 'context-compaction-start':
      return '🧭 正在压缩上下文';
    case 'context-compaction-end':
      return '🧭 上下文压缩完成';
    case 'subagent-start': {
      const type = textValue(p.subagentType);
      return `🤖 子代理开始${type ? ` · ${type}` : ''}`;
    }
    case 'subagent-end': {
      const type = textValue(p.subagentType);
      return `🤖 子代理结束${type ? ` · ${type}` : ''}`;
    }
    case 'waiting-for-user':
      return formatWaitingLine(p);
    case 'session-start':
      return null; // 太弱，跳过让循环找下一个更具体的
    case 'tool-use-end':
      return null;
    case 'finished':
      return '✅ 一轮完成';
    case 'session-end':
      return '⏹ 会话结束';
    default:
      return null;
  }
}

function formatWaitingLine(p: Record<string, unknown>): string {
  const type = textValue(p.type);
  if (type === 'permission-request') {
    const tool = textValue(p.toolName) || '工具';
    const detail = summariseToolInput(tool, p.toolInput);
    return detail ? `⚠️ 等待你授权 ${tool} · ${detail}` : `⚠️ 等待你授权 ${tool}`;
  }
  if (type === 'ask-user-question') return '❓ 收到一个问题';
  if (type === 'exit-plan-mode') {
    const plan = textValue(p.plan);
    const firstLine = plan.split('\n').find((line) => line.trim())?.trim();
    return firstLine
      ? `📋 等待批准计划 · ${firstLine.slice(0, 60)}${firstLine.length > 60 ? '…' : ''}`
      : '📋 收到一个执行计划';
  }
  if (type === 'codex-terminal-permission-request') {
    const tool = textValue(p.toolName) || '工具';
    return `⚠️ Codex CLI 等待终端授权 ${tool}`;
  }
  if (type === 'permission-cancelled') return '⚪ 权限请求已取消';
  if (type === 'ask-question-cancelled') return '⚪ 提问已取消';
  if (type === 'exit-plan-cancelled') return '⚪ 计划批准请求已取消';
  const message = textValue(p.message);
  return `⚠️ 等待你的输入${message ? ` · ${message.slice(0, 60)}${message.length > 60 ? '…' : ''}` : ''}`;
}

function summariseToolInput(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const resolvedToolName = resolveToolNameAlias(toolName);
  switch (resolvedToolName) {
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'MultiEdit':
      return typeof o.file_path === 'string' ? shortenPath(o.file_path) : null;
    case 'Bash': {
      const cmd = typeof o.command === 'string' ? o.command.replace(/\s+/g, ' ').trim() : '';
      return cmd ? cmd.slice(0, 60) + (cmd.length > 60 ? '…' : '') : null;
    }
    case 'Glob':
      return typeof o.pattern === 'string' ? o.pattern : null;
    case 'Grep':
      return typeof o.pattern === 'string' ? o.pattern : null;
    case 'TodoWrite': {
      // 显示完成数量和当前任务，让卡片保留待办进度。
      // todos schema：{ content, status, activeForm }[]，status: 'pending' | 'in_progress' | 'completed'
      const todos = Array.isArray(o.todos)
        ? o.todos.filter(
            (t): t is { status?: string; activeForm?: string } =>
              t !== null && typeof t === 'object',
          )
        : [];
      if (todos.length === 0) return null;
      const done = todos.filter((t) => t.status === 'completed').length;
      const inProgress = todos.find((t) => t.status === 'in_progress');
      const inProgressLabel =
        inProgress && typeof (inProgress as { activeForm?: string }).activeForm === 'string'
          ? ` · ${(inProgress as { activeForm: string }).activeForm.slice(0, 40)}${
              (inProgress as { activeForm: string }).activeForm.length > 40 ? '…' : ''
            }`
          : '';
      return `已完成 ${done}/${todos.length}${inProgressLabel}`;
    }
    case 'WebSearch': {
      // 显示 query 摘要。
      const query = typeof o.query === 'string' ? o.query.replace(/\s+/g, ' ').trim() : '';
      if (!query) return null;
      return `"${query.slice(0, 50)}${query.length > 50 ? '…' : ''}"`;
    }
    case 'WebFetch': {
      // 显示截断后的 URL。
      const url = typeof o.url === 'string' ? o.url : '';
      if (!url) return null;
      // url 长度截 60 字（host 一般够看，太长 prompt 主导）
      return url.slice(0, 60) + (url.length > 60 ? '…' : '');
    }
    case 'Task':
    case 'Agent': {
      return describeAgentToolInput(o, 40);
    }
    case 'Skill': {
      // Skill input shape：{ skill: "<plugin:name>" | "<name>", args?: string }
      // 与 activity-feed/describe.ts 的 Skill 摘要保持一致。
      const skill = typeof o.skill === 'string' ? o.skill : '';
      const args = typeof o.args === 'string' ? o.args.replace(/\s+/g, ' ').trim() : '';
      if (!skill) return null;
      if (args) {
        const argsShort = args.length > 60 ? args.slice(0, 60) + '…' : args;
        return `${skill} · ${argsShort}`;
      }
      return skill;
    }
    default: {
      // 兜底：mcp 图片工具（mcp__<server>__Image*）也走 file_path 摘要
      if (isImageTool(toolName) && typeof o.file_path === 'string') {
        return shortenPath(o.file_path);
      }
      return null;
    }
  }
}

function payloadObject(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function shortenPath(p: string): string {
  if (!p) return '';
  const parts = p.split('/');
  if (parts.length <= 3) return p;
  return '…/' + parts.slice(-2).join('/');
}
