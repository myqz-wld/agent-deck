import { useMemo, useState, type JSX } from 'react';
import type { AgentEvent, SessionRecord } from '@shared/types';
import { isImageTool } from '@shared/mcp-tools';
import { StatusBadge } from './StatusBadge';
import { useSessionStore } from '@renderer/stores/session-store';
import { toolIcon } from './activity-feed/tool-icons';
import { agentIdLabel } from './TeamDetail/helpers';
import { SessionMetadataChips } from './SessionMetadataChips';

interface Props {
  session: SessionRecord;
  selected: boolean;
  onSelect: () => void;
  /**
   * Phase C (CHANGELOG_77) + plan session-list-handoff-role-badge-20260526 (v4 §D1/D3):
   * 在 team 中的角色 badge,数据来源走 `deriveTeamRole` shared util (SessionList / PendingTab 共用):
   * - 'lead': 优先看 session.teams[*].role==='lead' (任一 lead);退化看是否为纯 spawn 链
   *   的 owner (visible children > 0 且全无 universal team)
   * - 'teammate': 优先看 session.teams[*].role==='teammate';退化看是否在纯 spawn 链
   *   的子位置 (hasOwner=true 且 self / owner 全无 universal team)
   * - undefined: 既无 universal team membership,也不是纯 spawn 链相关节点
   *
   * SessionList 在树形分组时计算 owner→children Map (spawn-link 优先 + universal team
   * 收编 fallback,详 plan §D2) 后传入。SessionList / PendingTab 共用同一份 deriveTeamRole
   * util 保持行为一致 (plan §HIGH-1)。
   *
   * lead 走「蓝边」(border 颜色);teammate 走「浅蓝小 chip」(bg+text),与现有 🛡 teamName
   * chip 风格一致。
   */
  teamRole?: 'lead' | 'teammate';
}

const EMPTY_EVENTS: AgentEvent[] = [];

export function SessionCard({ session, selected, onSelect, teamRole }: Props): JSX.Element {
  const recent = useSessionStore((s) => s.recentEventsBySession.get(session.id) ?? EMPTY_EVENTS);
  const latestSummary = useSessionStore((s) => s.latestSummaryBySession.get(session.id));
  const [menuOpen, setMenuOpen] = useState(false);

  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault();
    setMenuOpen(true);
  };

  const close = (): void => setMenuOpen(false);

  const archive = async (): Promise<void> => {
    await window.api.archiveSession(session.id);
    close();
  };
  const reactivate = async (): Promise<void> => {
    await window.api.reactivateSession(session.id);
    close();
  };
  const remove = async (): Promise<void> => {
    const ok = await window.api.confirmDialog({
      title: '删除会话',
      message: `确定要删除会话「${session.title}」吗？`,
      detail: '此操作不可恢复，会话的所有事件、文件改动和总结都会一并删除。',
      okLabel: '删除',
      cancelLabel: '取消',
      destructive: true,
    });
    if (!ok) return;
    await window.api.deleteSession(session.id);
    close();
  };

  // 「在干嘛」：当前活动详情（实时） + 最近一次总结（一句话）
  // Phase 5 Step 5.4（plan mcp-bug-and-feature-batch-20260513 §决策 4 L1）：liveLines 最多
  // 3 行（原 1 行）—— 让用户瞄一眼卡片就知道最近 3 个 tool 用了什么；useMemo 防 recent 引用
  // 稳定时不重算（已知踩坑：L SessionCard 大改影响 SessionList 滚动性能）。
  // 第 4 行是较稳定的总结（5min/10events 才更新一次），缺失时回退到 cwd。
  const liveLines = useMemo(() => describeLiveActivity(session, recent), [session, recent]);
  const summaryLine = latestSummary?.content?.split('\n')[0]?.trim() || session.cwd || '无工作目录';

  // plan team-cohesion-fix-20260513 Phase A：teams[] 是 universal team backend 投影
  // （sessionManager.enrichWithTeams 在 IPC 桥点统一注入）。v014 drop sessions.team_name
  // 后老 teamName 字段已删，纯走 teams[0]。
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
            🛡 {displayTeamName}
            {teamCount > 1 && <span className="ml-0.5 text-purple-300/70">+{teamCount - 1}</span>}
          </span>
        )}
        {teamRole === 'lead' && (
          <span
            className="rounded bg-blue-400/15 px-1 py-0.5 text-[9px] font-medium text-blue-200"
            title={teamHoverTitle || '本会话是某团队的负责人'}
          >
            👑 负责人
          </span>
        )}
        {teamRole === 'teammate' && (
          <span
            className="rounded bg-blue-400/10 px-1 py-0.5 text-[9px] font-medium text-blue-200/85"
            title={teamHoverTitle || '本会话是某团队的协作者'}
          >
            ↳ 协作者
          </span>
        )}
        <span className="text-[9px] text-deck-muted/60">{agentIdLabel(session.agentId)}</span>
      </div>
      <div className="mt-1">
        <SessionMetadataChips session={session} compact />
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
      <div className="mt-0.5 truncate text-[10px] text-deck-muted/70" title={summaryLine}>
        {summaryLine}
      </div>
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
                归档
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
                重新激活
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
              删除
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 把会话的实时状态浓缩成最多 3 行短文案。waiting 优先级最高（仅返回 1 行），否则按事件 kind
 * 翻译，尽量从 payload 里抠出文件名 / 工具名等可读信息。
 *
 * Phase 5 Step 5.4（plan mcp-bug-and-feature-batch-20260513 §决策 4 L1）：返回数组（最多 3
 * 行，去重连续同行）让用户瞄一眼卡片就知道最近 N 个 tool 用了什么 —— 比 1 行信息密度高 3x。
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
      return detail ? `${toolIcon(tool)} ${tool} · ${detail}` : `${toolIcon(tool)} ${tool}`;
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
  if (type === 'permission-cancelled') return '⚪ 权限请求已取消';
  if (type === 'ask-question-cancelled') return '⚪ 提问已取消';
  if (type === 'exit-plan-cancelled') return '⚪ 计划批准请求已取消';
  const message = textValue(p.message);
  return `⚠️ 等待你的输入${message ? ` · ${message.slice(0, 60)}${message.length > 60 ? '…' : ''}` : ''}`;
}

function summariseToolInput(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  switch (toolName) {
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
      // Phase 5 Step 5.3（plan mcp-bug-and-feature-batch-20260513 §决策 4 L2）：显示进度
      // [N/M done]，让用户瞄一眼卡片就知道任务推进度。原来 return null 完全丢信息。
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
      // Phase 5 Step 5.3（plan §决策 4 L2）：显示 query 摘要让用户知道在搜什么
      const query = typeof o.query === 'string' ? o.query.replace(/\s+/g, ' ').trim() : '';
      if (!query) return null;
      return `"${query.slice(0, 50)}${query.length > 50 ? '…' : ''}"`;
    }
    case 'WebFetch': {
      // Phase 5 Step 5.3（plan §决策 4 L2）：显示 url + 简短 prompt
      const url = typeof o.url === 'string' ? o.url : '';
      if (!url) return null;
      // url 长度截 60 字（host 一般够看，太长 prompt 主导）
      return url.slice(0, 60) + (url.length > 60 ? '…' : '');
    }
    case 'Task':
    case 'Agent': {
      // Phase 5 Step 5.3（plan §决策 4 L2）：spawn subagent 时显示 subagent_type 让用户知道
      // 是 explore / general-purpose / agent-deck:reviewer-claude 等谁在干活
      const sub = typeof o.subagent_type === 'string' ? o.subagent_type : '';
      const desc = typeof o.description === 'string' ? o.description.replace(/\s+/g, ' ').trim() : '';
      if (!sub && !desc) return null;
      const descShort = desc.length > 40 ? desc.slice(0, 40) + '…' : desc;
      if (sub && desc) return `${sub} · ${descShort}`;
      return sub || descShort;
    }
    case 'Skill': {
      // Skill input shape：{ skill: "<plugin:name>" | "<name>", args?: string }
      // 与 activity-feed/describe.ts 的 Skill case 同步；这两份重复实现是历史债（见 REVIEW_16）。
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
