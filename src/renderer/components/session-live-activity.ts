import type { ActivityState, AgentEvent, SessionRecord } from '@shared/types';
import { describeAgentToolInput, describeToolInput, resolveToolNameAlias } from './activity-feed/describe';
import { turnOutcome } from './activity-feed/turn-outcome';
import type { ActivityIconKind } from './activity-feed/activity-icon';

export interface LiveActivitySummary {
  text: string;
  icon: ActivityIconKind;
  tool?: { name: string; kind?: unknown; input?: unknown };
}

export function sessionActivitySummary(activity: ActivityState): LiveActivitySummary {
  switch (activity) {
    case 'waiting': return { text: '等待你的输入', icon: 'waiting' };
    case 'finished': return { text: '一轮完成', icon: 'success' };
    case 'working': return { text: '工作中', icon: 'working' };
    default: return { text: '空闲', icon: 'idle' };
  }
}

/** Waiting takes priority; otherwise retain at most three informative, consecutive-unique rows. */
export function describeLiveActivity(
  session: Pick<SessionRecord, 'activity'>,
  recent: readonly AgentEvent[],
): LiveActivitySummary[] {
  if (session.activity === 'waiting') {
    const waiting = recent.find((event) => event.kind === 'waiting-for-user');
    return [waiting ? eventActivitySummary(waiting)! : sessionActivitySummary('waiting')];
  }
  if (session.activity === 'finished' && recent[0]?.kind !== 'tool-use-start') {
    const finished = recent.find((event) => event.kind === 'finished');
    return [finished ? eventActivitySummary(finished)! : sessionActivitySummary('finished')];
  }
  const lines: LiveActivitySummary[] = [];
  for (const event of recent.slice(0, 12)) {
    const line = eventActivitySummary(event);
    const previous = lines.at(-1);
    if (!line || (line.text === previous?.text && line.icon === previous.icon)) continue;
    lines.push(line);
    if (lines.length >= 3) break;
  }
  return lines;
}

/** Text-only consumers receive the same summary without embedding decorative glyphs. */
export function formatEventLine(event: AgentEvent): string | null {
  return eventActivitySummary(event)?.text ?? null;
}

function eventActivitySummary(event: AgentEvent): LiveActivitySummary | null {
  const p = payloadObject(event.payload);
  switch (event.kind) {
    case 'tool-use-start': {
      const name = textValue(p.toolName) || '工具';
      const detail = summariseToolInput(name, p.toolInput);
      return { text: detail ? `${name} · ${detail}` : name, icon: 'tool',
        tool: { name, kind: p.toolKind, input: p.toolInput } };
    }
    case 'file-changed': {
      const path = textValue(p.filePath);
      return path ? { text: shortenPath(path), icon: 'edit' } : null;
    }
    case 'message':
    case 'message-display': {
      const text = textValue(event.kind === 'message' ? p.text : p.delta).replace(/\s+/g, ' ').trim();
      return text ? { text: `${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`,
        icon: Array.isArray(p.images) && p.images.length > 0 ? 'image' : 'message' } : null;
    }
    case 'context-compaction-start': return { text: '正在压缩上下文', icon: 'compaction' };
    case 'context-compaction-end': return { text: '上下文压缩完成', icon: 'compaction' };
    case 'subagent-start':
    case 'subagent-end': {
      const type = textValue(p.subagentType);
      return { text: `子代理${event.kind === 'subagent-start' ? '开始' : '结束'}${type ? ` · ${type}` : ''}`, icon: 'agent' };
    }
    case 'waiting-for-user': return waitingSummary(p);
    case 'finished': return turnOutcome(p);
    case 'session-end': return { text: '会话结束', icon: 'stopped' };
    default: return null;
  }
}

function waitingSummary(p: Record<string, unknown>): LiveActivitySummary {
  const type = textValue(p.type);
  if (type === 'permission-request') {
    const tool = textValue(p.toolName) || '工具';
    const detail = summariseToolInput(tool, p.toolInput);
    return { text: `等待你授权 ${tool}${detail ? ` · ${detail}` : ''}`, icon: 'permission' };
  }
  if (type === 'ask-user-question') return { text: '收到一个问题', icon: 'question' };
  if (type === 'exit-plan-mode') {
    const first = textValue(p.plan).split('\n').find((line) => line.trim())?.trim();
    return { text: first ? `等待批准计划 · ${first.slice(0, 60)}${first.length > 60 ? '…' : ''}` : '收到一个执行计划', icon: 'plan' };
  }
  if (type === 'codex-terminal-permission-request') {
    return { text: `Codex CLI 等待终端授权 ${textValue(p.toolName) || '工具'}`, icon: 'permission' };
  }
  if (type === 'permission-cancelled') return { text: '权限请求已取消', icon: 'cancelled' };
  if (type === 'ask-question-cancelled') return { text: '提问已取消', icon: 'cancelled' };
  if (type === 'exit-plan-cancelled') return { text: '计划批准请求已取消', icon: 'cancelled' };
  const message = textValue(p.message);
  return { text: `等待你的输入${message ? ` · ${message.slice(0, 60)}${message.length > 60 ? '…' : ''}` : ''}`, icon: 'waiting' };
}

function summariseToolInput(toolName: string, input: unknown): string | null {
  const canonical = resolveToolNameAlias(toolName);
  if (canonical === 'Agent' || canonical === 'Task') return describeAgentToolInput(payloadObject(input), 40);
  const detail = describeToolInput(toolName, input);
  return detail && ['Read', 'Edit', 'Write', 'MultiEdit', 'ImageView'].includes(canonical)
    ? shortenPath(detail) : detail;
}

function payloadObject(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown> : {};
}
function textValue(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function shortenPath(path: string): string {
  const parts = path.split('/');
  return parts.length <= 3 ? path : '…/' + parts.slice(-2).join('/');
}
