import { useState, type JSX } from 'react';
import type { AgentEvent, SessionRecord } from '@shared/types';
import { isImageTool } from '@shared/mcp-tools';
import { StatusBadge } from './StatusBadge';
import { useSessionStore } from '@renderer/stores/session-store';

interface Props {
  session: SessionRecord;
  selected: boolean;
  onSelect: () => void;
}

const EMPTY_EVENTS: AgentEvent[] = [];

export function SessionCard({ session, selected, onSelect }: Props): JSX.Element {
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
      message: `确定要删除会话「${session.title}」？`,
      detail: '该操作不可恢复，将连同所有事件、文件改动、总结一并删除。',
      okLabel: '删除',
      cancelLabel: '取消',
      destructive: true,
    });
    if (!ok) return;
    await window.api.deleteSession(session.id);
    close();
  };

  // 「在干嘛」：当前活动详情（实时） + 最近一次总结（一句话）
  // 双行结构：第一行是当下动作（来自最近 events，2-3 秒内会变），
  // 第二行是较稳定的总结（5min/10events 才更新一次），缺失时回退到 cwd。
  const liveLine = describeLiveActivity(session, recent);
  const summaryLine = latestSummary?.content?.split('\n')[0]?.trim() || session.cwd || '无 cwd';

  return (
    <div
      onClick={onSelect}
      onContextMenu={onContextMenu}
      className={`group relative cursor-pointer rounded-lg border px-3 py-2 transition ${
        selected
          ? 'border-white/30 bg-white/10'
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
          title={session.source === 'sdk' ? '应用内创建（SDK 通道）' : '外部终端 CLI 会话'}
        >
          {session.source === 'sdk' ? '内' : '外'}
        </span>
        <span className="text-[9px] text-deck-muted/60">{session.agentId}</span>
      </div>
      {liveLine && (
        <div
          className="mt-1 truncate text-[10px] text-deck-text/85"
          title={liveLine}
        >
          {liveLine}
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
 * 把会话的实时状态浓缩成一行短文案。waiting 优先级最高，否则按事件 kind 翻译，
 * 尽量从 payload 里抠出文件名 / 工具名等可读信息。
 */
function describeLiveActivity(
  session: SessionRecord,
  recent: AgentEvent[],
): string | null {
  if (session.activity === 'waiting') return '⚠ 等待你的输入';
  if (session.activity === 'finished' && recent[0]?.kind !== 'tool-use-start') {
    return '✅ 一轮完成';
  }
  // 取最近 8 条里"最有信息量"的一条
  for (const e of recent.slice(0, 8)) {
    const line = formatEventLine(e);
    if (line) return line;
  }
  return null;
}

function formatEventLine(e: AgentEvent): string | null {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  switch (e.kind) {
    case 'tool-use-start': {
      const tool = (p.toolName as string) || '工具';
      const detail = summariseToolInput(tool, p.toolInput);
      return detail ? `🔧 ${tool} · ${detail}` : `🔧 ${tool}`;
    }
    case 'file-changed': {
      const path = (p.filePath as string) || '';
      return `📝 ${shortenPath(path)}`;
    }
    case 'message': {
      const text = typeof p.text === 'string' ? p.text.replace(/\s+/g, ' ').trim() : '';
      if (!text) return null;
      return `💬 ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`;
    }
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
    case 'TodoWrite':
      return null;
    default: {
      // 兜底：mcp 图片工具（mcp__<server>__Image*）也走 file_path 摘要
      if (isImageTool(toolName) && typeof o.file_path === 'string') {
        return shortenPath(o.file_path);
      }
      return null;
    }
  }
}

function shortenPath(p: string): string {
  if (!p) return '';
  const parts = p.split('/');
  if (parts.length <= 3) return p;
  return '…/' + parts.slice(-2).join('/');
}

