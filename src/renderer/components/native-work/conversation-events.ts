import type { AgentEvent } from '@shared/types';
import { nativeWorkAttemptKey, type NativeWorkDetail, type NativeWorkSnapshot } from '@shared/native-work';

export type JoinedWorkRecord = NativeWorkDetail & { incomplete: boolean };
type Payload = Record<string, unknown>;
const object = (value: unknown): Payload => value && typeof value === 'object' && !Array.isArray(value) ? value as Payload : {};
function parse(text: string): unknown { try { return JSON.parse(text); } catch { return text; } }
function reasoning(text: string): string {
  const value = parse(text);
  if (!Array.isArray(value)) return text;
  const parts = value.map(part => typeof part === 'string' ? part : object(part).text);
  return parts.every(part => typeof part === 'string') ? parts.join('\n\n') : text;
}
const terminal = new Set(['completed', 'failed', 'error', 'interrupted', 'cancelled', 'canceled', 'stopped', 'denied', 'declined']);

/** View-only projection into the same rows as the parent; it cannot publish parent events. */
export function nativeWorkConversationEvents(task: NativeWorkSnapshot, records: readonly JoinedWorkRecord[]): AgentEvent[] {
  const attempt = nativeWorkAttemptKey(task.native);
  const events: AgentEvent[] = [];
  const starts = new Map<string, AgentEvent>();
  const outputs = new Map<string, AgentEvent>();
  const event = (record: JoinedWorkRecord, kind: AgentEvent['kind'], payload: Payload): AgentEvent => ({
    sessionId: task.native.sessionId, agentId: task.native.provider, source: 'sdk', ts: record.ts, kind,
    payload: { messageId: `${attempt}:${record.recordId}`, ...payload,
      nativeWorkOwner: task.native.nativeId, nativeWorkToolUseId: record.toolUseId },
  });
  for (const record of records) {
    const toolUseId = record.toolUseId ? `${attempt}:tool:${record.toolUseId}` : undefined;
    const partial = record.incomplete || record.sourceTruncated;
    if (record.kind === 'message' || record.kind === 'thinking' || record.kind === 'output' && !toolUseId) {
      const text = record.kind === 'thinking' ? reasoning(record.text) : record.text;
      if (record.kind === 'thinking' && !text.trim()) continue;
      events.push(event(record, record.kind === 'thinking' ? 'thinking' : 'message', {
        role: record.role ?? 'assistant', text,
      }));
      continue;
    }
    if (record.kind === 'file-changed') {
      const value = object(parse(record.text));
      const changes = Array.isArray(value.changes) ? value.changes.map(object) : [value];
      const readable = changes.filter(change => typeof (change.filePath ?? change.path) === 'string');
      if (readable.length) readable.forEach((change, index) => events.push(event(record, 'file-changed', {
        messageId: `${attempt}:${record.recordId}:${index}`, filePath: change.filePath ?? change.path,
        changeType: change.changeType ?? object(change.kind).type ?? change.kind,
        diff: change.diff, ...(toolUseId ? { toolCallId: toolUseId } : {}),
      })));
      else events.push(event(record, 'tool-use-end', { toolName: '文件改动', toolResult: parse(record.text), status: record.toolStatus ?? 'unknown' }));
      continue;
    }
    const decoded = parse(record.text), raw = object(decoded);
    const envelope = ['mcpToolCall', 'dynamicToolCall', 'functionCallOutput'].includes(String(raw.type));
    const toolName = record.toolName === 'shell' ? 'Bash' : record.toolName
      ?? (envelope && typeof raw.tool === 'string' ? raw.tool : '工具');
    const status = record.toolStatus ?? (typeof raw.status === 'string' && envelope ? raw.status : undefined);
    const payload: Payload = { toolName, ...(toolUseId ? { toolUseId } : {}),
      nativeWorkOwner: task.native.nativeId, nativeWorkToolUseId: record.toolUseId,
      status: status === 'declined' ? 'denied' : status ?? (record.kind === 'tool-use-end' ? 'completed' : 'unknown'),
      ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }) };
    if (record.kind === 'tool-use-start') {
      payload.toolInput = toolName === 'Bash' && (task.native.provider === 'codex-cli' || typeof decoded === 'string')
        ? { command: record.text } : decoded;
      if (partial) payload.toolInputTruncated = true;
      const start = event(record, 'tool-use-start', payload);
      events.push(start); if (toolUseId) starts.set(toolUseId, start);
    } else {
      payload.toolResult = record.kind === 'output' ? record.text
        : envelope ? raw.result ?? raw.output ?? raw.content ?? raw.error ?? decoded : decoded;
      if (envelope) payload.toolInput = raw.arguments ?? raw.input;
      if (partial) payload.toolResultTruncated = true;
      if (record.kind === 'output' && toolUseId && !terminal.has(status ?? '') && record.exitCode === undefined) {
        // Partial output is not proof of completion. Keep one live tool row, with its actual status.
        payload.aggregatedOutput = payload.toolResult;
        const output = event(record, 'tool-use-start', payload);
        outputs.set(toolUseId, output); events.push(output);
      } else events.push(event(record, 'tool-use-end', payload));
    }
  }
  for (const [id, output] of outputs) {
    const start = starts.get(id);
    if (start) output.payload = { ...object(start.payload), ...object(output.payload) };
  }
  for (const current of events) {
    if (current.kind !== 'tool-use-end') continue;
    const payload = object(current.payload), start = starts.get(String(payload.toolUseId));
    if (start) current.payload = { ...object(start.payload), ...payload,
      toolName: payload.toolName === '工具' ? object(start.payload).toolName : payload.toolName,
      toolInput: payload.toolInput ?? object(start.payload).toolInput };
  }
  return events.filter(current => current.kind !== 'tool-use-start' ||
    !outputs.has(String(object(current.payload).toolUseId)) || outputs.get(String(object(current.payload).toolUseId)) === current);
}
