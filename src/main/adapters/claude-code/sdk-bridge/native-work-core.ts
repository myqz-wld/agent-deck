import type { AgentEvent } from '@shared/types';
import type { BackgroundTaskSnapshot } from '@shared/background-task';
import type { NativeWorkRef, NativeWorkStopResult } from '@shared/native-work';
import { NativeWorkTracker } from '../../native-work-tracker';
import { readOwnedNativeOutput } from '../../native-work-output';
import { loadSdk } from '../sdk-loader';
import type { InternalSession } from './types';

type Frame = { type: string; [key: string]: unknown };
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const printable = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value ?? '');

export class ClaudeNativeWork {
  readonly tracker: NativeWorkTracker;
  private owners = new Map<string, { taskId: string; runId: string }>();
  private pending: Frame[] = [];
  private pendingBytes = 0;
  private importing = new Set<string>();
  private closed = false;
  constructor(private readonly internal: InternalSession, sessionId: string,
    emit: (event: AgentEvent) => void, now: () => number) {
    this.tracker = new NativeWorkTracker(sessionId, 'claude-code', emit, now);
  }

  snapshot(snapshot: BackgroundTaskSnapshot, frame: Frame): void {
    if (this.closed || this.internal.expectedClose) return;
    const previous = this.tracker.tasks.get(snapshot.taskId);
    const subagent = snapshot.taskType === 'local_agent' || typeof frame.subagent_type === 'string';
    const task = this.tracker.observe({ ...snapshot,
      description: snapshot.description.slice(0, 2000), summary: snapshot.summary?.slice(0, 2000),
      error: snapshot.error?.slice(0, 2000),
      runId: snapshot.runId ?? previous?.runId,
      workKind: subagent || previous?.workKind === 'subagent' ? 'subagent' : 'shell',
      ...(typeof frame.parent_task_id === 'string' ? { parentTaskId: frame.parent_task_id } : {}),
      canStop: typeof this.internal.query?.stopTask === 'function',
      detailStatus: previous?.detailStatus === 'partial' ? 'partial' : snapshot.summary ? 'available' : previous?.detailStatus ?? 'unavailable',
      ...(!this.internal.query?.stopTask ? { controlReason: '当前 Claude 运行实例不支持单独停止' } : {}),
    }, true); // Existing Claude reducer already rejects lexically older native runs.
    if (!task) return;
    if (snapshot.toolUseId) this.owners.set(snapshot.toolUseId, { taskId: task.taskId, runId: task.runId });
    const pending = this.pending; this.pending = []; this.pendingBytes = 0;
    for (const msg of pending) this.child(msg);
    if (snapshot.summary) this.tracker.detail(task.taskId, `summary:${task.runId}`, 'output', snapshot.summary);
    if (snapshot.outputFile) void this.output(task.taskId, task.runId, snapshot.outputFile);
    if (task.workKind === 'subagent' && ['completed', 'failed', 'stopped'].includes(task.status)) void this.history(task.taskId, task.runId);
  }

  child(frame: Frame): void {
    if (this.closed || this.internal.expectedClose) return;
    const owner = typeof frame.parent_tool_use_id === 'string' ? this.owners.get(frame.parent_tool_use_id) : undefined;
    if (!owner) {
      const bytes = Buffer.byteLength(JSON.stringify(frame));
      if (bytes <= 256 * 1024 && this.pending.length < 128 && this.pendingBytes + bytes <= 1024 * 1024) {
        this.pending.push(frame); this.pendingBytes += bytes;
      }
      return;
    }
    if (this.tracker.tasks.get(owner.taskId)?.runId === owner.runId) this.message(owner.taskId, frame);
  }

  private message(taskId: string, frame: Frame): void {
    const message = record(frame.message);
    const id = typeof frame.uuid === 'string' ? frame.uuid : typeof message.id === 'string' ? message.id : null;
    if (!id || !Array.isArray(message.content)) return;
    message.content.forEach((value, index) => {
      const block = record(value);
      if (block.type === 'tool_use') this.tracker.detail(taskId, `${id}:${index}`, 'tool-use-start', printable(block.input), {
        toolName: typeof block.name === 'string' ? block.name : undefined,
        toolUseId: typeof block.id === 'string' ? block.id : undefined, toolStatus: 'inProgress' });
      else if (block.type === 'tool_result') this.tracker.detail(taskId, `${id}:${index}`, 'tool-use-end', printable(block.content), {
        toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
        toolStatus: block.is_error === true ? 'failed' : 'completed' });
      else if (block.type === 'text' && typeof block.text === 'string') this.tracker.detail(taskId, `${id}:${index}`, 'message', block.text,
        { role: frame.type === 'user' ? 'user' : 'assistant' });
      else if (block.type === 'thinking' && typeof block.thinking === 'string') this.tracker.detail(taskId, `${id}:${index}`, 'thinking', block.thinking);
    });
  }

  private async output(taskId: string, runId: string, path: string): Promise<void> {
    const key = `output:${taskId}:${runId}`;
    if (this.importing.has(key)) return;
    this.importing.add(key);
    try {
      const output = await readOwnedNativeOutput(path);
      if (this.closed || this.internal.expectedClose || this.tracker.tasks.get(taskId)?.runId !== runId) return;
      this.tracker.detail(taskId, key, 'output', output.text, { sourceTruncated: output.truncated });
    } catch { /* A removed/provider-redacted output is unavailable, never an arbitrary fallback path. */ }
    finally { this.importing.delete(key); }
  }

  private async history(taskId: string, runId: string): Promise<void> {
    const sessionId = this.internal.cliSessionId;
    if (!sessionId || this.importing.has(taskId)) return;
    this.importing.add(taskId);
    try {
      const sdk = await loadSdk();
      const agents = await sdk.listSubagents(sessionId, { dir: this.internal.cwd });
      if (!agents.includes(taskId)) return; // Never infer an agent ID or search other projects.
      for (let offset = 0; offset < 4096; offset += 64) {
        if (this.closed || this.internal.expectedClose || this.tracker.tasks.get(taskId)?.runId !== runId) return;
        const page = await sdk.getSubagentMessages(sessionId, taskId, { dir: this.internal.cwd, offset, limit: 64 });
        if (this.closed || this.internal.expectedClose || this.tracker.tasks.get(taskId)?.runId !== runId) return;
        const ownerTool = this.tracker.tasks.get(taskId)?.toolUseId;
        for (const message of page) {
          if (ownerTool && message.parent_tool_use_id === ownerTool) this.message(taskId, message);
        }
        if (page.length < 64) return;
      }
      const task = this.tracker.tasks.get(taskId)!;
      this.tracker.observe({ taskId, workKind: task.workKind, detailStatus: 'partial' });
    } catch { /* Live child content remains retained when the native transcript is unavailable. */ }
    finally { this.importing.delete(taskId); }
  }

  stop(ref: NativeWorkRef): Promise<NativeWorkStopResult> {
    return this.tracker.stop(ref, async task => {
      if (this.internal.expectedClose || this.closed) return { status: 'stale' };
      await this.internal.query.stopTask(task.taskId);
      return { status: 'accepted' }; // Terminal notification, not the RPC, confirms stopping.
    });
  }
  dispose(): void { this.closed = true; this.pending = []; this.tracker.dispose(); }
}
