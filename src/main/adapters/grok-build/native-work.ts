import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { AgentEvent } from '@shared/types';
import { isTerminalNativeWork, sameNativeWorkRef, type NativeWorkRef, type NativeWorkSnapshot, type NativeWorkStopResult } from '@shared/native-work';
import { NativeWorkTracker } from '../native-work-tracker';
import { readOwnedNativeOutput } from '../native-work-output';
import type { GrokAcpSession } from './acp-process';
import type { GrokRuntime } from './runtime-types';
import type { GrokExtensionNotification } from './extension';
import { createGrokTranslationState, flushGrokTextUpdates, translateGrokUpdate, type GrokTranslationState } from './translate';

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const state = (value: unknown): NativeWorkSnapshot['status'] => ({ running: 'running', initializing: 'pending',
  completed: 'completed', failed: 'failed', cancelled: 'stopped', killed: 'stopped', stopped: 'stopped' } as Record<string, NativeWorkSnapshot['status']>)[String(value)] ?? 'unknown';
const unsupported = (error: unknown) => /method.*not.*found|unknown method|unsupported/i.test(String(error));
function startKey(input: Row): string | undefined {
  const time = row(input.start_time);
  if (typeof time.secs_since_epoch === 'number') return String(time.secs_since_epoch * 1000 + Math.floor(Number(time.nanos_since_epoch ?? 0) / 1000000));
  const started = text(input.started_at);
  return started && Number.isFinite(Date.parse(started)) ? String(Date.parse(started)) : undefined;
}
interface Child { taskId: string; parent: string; runId: string; epoch?: number; translation: GrokTranslationState; sequence: number }

export class GrokNativeWork {
  readonly tracker: NativeWorkTracker;
  private children = new Map<string, Child>();
  private shells = new Map<string, { owner: string; started?: string }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private childSupported = true;
  private shellSupported = true;
  private polling: Promise<void> | null = null;
  constructor(private readonly runtime: GrokRuntime, private readonly process: GrokAcpSession,
    emit: (event: AgentEvent) => void, private readonly localFiles: boolean) {
    this.tracker = new NativeWorkTracker(runtime.applicationSessionId, 'grok-build', emit);
    this.schedule();
  }
  private live(): boolean { return !this.closed && !this.runtime.closed && this.runtime.ready &&
    this.runtime.process === this.process && !this.process.isStopping; }
  private owns(sessionId: string): boolean { return sessionId === this.runtime.nativeSessionId || this.children.has(sessionId); }
  private schedule(): void {
    if (this.closed) return;
    this.timer = setTimeout(() => { this.timer = null; void this.refresh().finally(() => this.schedule()); }, 3000);
    this.timer.unref?.();
  }
  private async request(method: string, params: Row): Promise<Row> {
    if (!this.live()) throw new Error('Stale Grok runtime');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = row(await this.process.connection.agent.request<unknown, Row>(`_x.ai/${method}`, params,
        { cancellationSignal: controller.signal }));
      if (!this.live()) throw new Error('Stale Grok runtime');
      if (response.error) throw new Error(JSON.stringify(response.error));
      return 'result' in response ? row(response.result) : response;
    } finally { clearTimeout(timer); }
  }
  extension(notification: GrokExtensionNotification): boolean {
    const owner = notification.sessionId;
    if (!this.live() || !id(owner) || !this.owns(owner)) return false;
    const update = row(notification.update), kind = update.sessionUpdate;
    if (kind === 'subagent_spawned' || kind === 'subagent_progress' || kind === 'subagent_finished') {
      const taskId = update.subagent_id, childId = update.child_session_id;
      if (!id(taskId) || !id(childId) || (kind !== 'subagent_finished' && update.parent_session_id !== owner)) return true;
      const previous = this.children.get(childId);
      const runId = id(update.attempt_id) ? update.attempt_id : previous?.runId ?? childId;
      if (kind !== 'subagent_spawned' && (!previous || previous.runId !== runId || previous.taskId !== taskId)) return true;
      if (kind === 'subagent_spawned') {
        if (previous && previous.runId === runId && isTerminalNativeWork(this.tracker.tasks.get(taskId)?.status ?? 'unknown')) return true;
      }
      const task = this.tracker.observe({ taskId, workKind: 'subagent', runId,
        description: text(update.description)?.slice(0, 2000) ?? this.tracker.tasks.get(taskId)?.description ?? '子代理',
        status: kind === 'subagent_finished' ? state(update.status) : 'running',
        parentTaskId: this.children.get(owner)?.taskId,
        ...(kind === 'subagent_spawned' ? { canStop: false, controlReason: '等待运行实例确认当前子代理' } : {}),
        ...(text(update.error) ? { error: text(update.error)!.slice(0, 2000) } : {}),
      }, kind === 'subagent_spawned');
      if (!task || task.runId !== runId) return true;
      if (kind === 'subagent_spawned') this.children.set(childId, { taskId, parent: owner, runId,
        translation: previous?.runId === runId ? previous.translation : createGrokTranslationState(),
        sequence: previous?.runId === runId ? previous.sequence : 0 });
      if (kind === 'subagent_finished' && task) {
        const child = this.children.get(childId)!;
        this.capture(child, flushGrokTextUpdates(childId, child.translation));
        if (text(update.output)) this.tracker.detail(taskId, `result:${runId}`, 'output', text(update.output)!);
      }
      return true;
    }
    if (kind === 'task_backgrounded') {
      this.shell(owner, { ...update, status: 'running' }); return true;
    }
    if (kind === 'background_tasks') {
      if (!Array.isArray(update.tasks)) return true;
      const seen = new Set<string>();
      for (const value of update.tasks) { const task = row(value); if (id(task.task_id)) { seen.add(task.task_id); this.shell(owner, task); } }
      if (update.truncated !== true) for (const [taskId, shell] of this.shells) {
        const task = this.tracker.tasks.get(taskId)!;
        if (shell.owner === owner && !seen.has(taskId) && !isTerminalNativeWork(task.status)) {
          this.tracker.observe({ taskId, workKind: 'shell', status: 'unknown', canStop: false, controlReason: '等待任务最终结果' });
        }
      }
      return true;
    }
    if (kind === 'task_completed') { this.shell(owner, row(update.task_snapshot)); return true; }
    return false;
  }
  child(notification: SessionNotification): boolean {
    const child = this.children.get(notification.sessionId);
    if (!this.live() || !child) return false;
    this.capture(child, translateGrokUpdate(notification.sessionId, this.runtime.cwd, notification.update, child.translation));
    // Persist progressive text under one stable record, without touching parent live-rate state.
    const pending = child.translation.pendingText;
    if (pending) this.tracker.detail(child.taskId, pending.messageId ?? `text:${child.sequence}`, pending.kind, pending.chunks.join(''));
    return true;
  }
  private capture(child: Child, events: AgentEvent[]): void {
    for (const event of events) {
      const payload = row(event.payload);
      if (!['message', 'thinking', 'tool-use-start', 'tool-use-end', 'file-changed'].includes(event.kind)) continue;
      const recordId = id(payload.toolUseId) ? `${event.kind}:${payload.toolUseId}` :
        id(payload.messageId) ? payload.messageId : `text:${child.sequence++}`;
      const content = text(payload.text) ?? JSON.stringify(payload.toolResult ?? payload.toolInput ?? payload);
      this.tracker.detail(child.taskId, recordId, event.kind as 'message', content, { toolName: text(payload.toolName) });
    }
  }
  private shell(owner: string, input: Row): void {
    if (!id(input.task_id) || (id(input.owner_session_id) && input.owner_session_id !== owner)) return;
    const taskId = input.task_id;
    const prior = this.shells.get(taskId);
    if (prior && prior.owner !== owner) return;
    const started = startKey(input) ?? prior?.started;
    const current = this.tracker.tasks.get(taskId);
    this.shells.set(taskId, { owner, started });
    const status = input.explicitly_killed === true ? 'stopped' : input.completed === true
      ? input.exit_code === 0 ? 'completed' : 'failed' : input.status === undefined ? 'running' : state(input.status);
    // task IDs are registry identities; start evidence detects their reuse without ordering strings.
    const runId = prior && started && prior.started && started !== prior.started ? `${taskId}:${started}` : current?.runId ?? taskId;
    const task = this.tracker.observe({ taskId, workKind: 'shell', runId, status,
      description: (text(input.description) ?? text(input.display_command) ?? text(input.command) ?? current?.description ?? '后台命令').slice(0, 2000),
      parentTaskId: this.children.get(owner)?.taskId, canStop: this.shellSupported,
      ...(input.truncated === true ? { detailStatus: 'partial' } : {}),
    }, true);
    if (!task) return;
    if (text(input.output) !== undefined) this.tracker.detail(taskId, 'output', 'output', text(input.output)!, { sourceTruncated: input.truncated === true });
    if (text(input.command)) this.tracker.detail(taskId, 'command', 'tool-use-start', text(input.display_command) ?? text(input.command)!, { toolName: 'shell' });
    if (this.localFiles && text(input.output_file)) {
      const run = task.runId;
      void readOwnedNativeOutput(text(input.output_file)!).then(output => {
        if (this.live() && this.tracker.tasks.get(taskId)?.runId === run) this.tracker.detail(taskId, 'output', 'output', output.text, { sourceTruncated: output.truncated });
      }).catch(() => {});
    }
  }
  refresh(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = this.poll().catch(() => {}).finally(() => { this.polling = null; }); return this.polling;
  }
  private async poll(): Promise<void> {
    if (!this.live()) return;
    if (this.childSupported) {
      try {
        const list = await this.request('subagent/list_running', { sessionId: this.runtime.nativeSessionId });
        for (const value of Array.isArray(list.subagents) ? list.subagents : []) {
          const item = row(value);
          if (!id(item.parentSessionId) || item.parentSessionId !== this.runtime.nativeSessionId || !id(item.subagentId) || !id(item.childSessionId)) continue;
          if (!this.children.has(item.childSessionId)) this.extension({ sessionId: item.parentSessionId, update: {
            sessionUpdate: 'subagent_spawned', parent_session_id: item.parentSessionId, child_session_id: item.childSessionId,
            subagent_id: item.subagentId, attempt_id: `${item.subagentId}:${item.startedAtEpochMs}`, description: item.description } });
        }
        for (const [childId, child] of this.children) {
          const response = await this.request('subagent/get', { subagentId: child.taskId, block: false });
          if (this.children.get(childId) !== child) continue;
          const snapshot = row(response.snapshot);
          if (snapshot.parentSessionId !== child.parent || snapshot.childSessionId !== childId || typeof snapshot.startedAtEpochMs !== 'number') continue;
          if (child.epoch !== undefined && child.epoch !== snapshot.startedAtEpochMs) continue;
          child.epoch = snapshot.startedAtEpochMs;
          this.tracker.observe({ taskId: child.taskId, workKind: 'subagent', status: state(snapshot.status),
            canStop: snapshot.status === 'running' || snapshot.status === 'initializing', controlReason: undefined });
          if (text(snapshot.output)) this.tracker.detail(child.taskId, `result:${child.runId}`, 'output', text(snapshot.output)!);
        }
      } catch (error) { if (unsupported(error)) { this.childSupported = false;
        for (const child of this.children.values()) this.tracker.observe({ taskId: child.taskId, workKind: 'subagent', canStop: false, controlReason: '当前 Grok 不支持子代理状态查询' });
      } }
    }
    if (this.shellSupported) for (const owner of [this.runtime.nativeSessionId!, ...this.children.keys()]) {
      try {
        const response = await this.request('task/list', { sessionId: owner });
        for (const value of Array.isArray(response.tasks) ? response.tasks : []) {
          const input = row(value);
          if (input.is_backgrounded === true || id(input.task_id) && this.shells.has(input.task_id)) this.shell(owner, input);
        }
      } catch (error) { if (unsupported(error)) this.shellSupported = false; }
    }
  }
  async stop(ref: NativeWorkRef): Promise<NativeWorkStopResult> {
    if (!this.live()) return { status: 'stale' };
    return this.tracker.stop(ref, async task => {
      try {
        const shell = this.shells.get(task.taskId);
        if (shell) {
          const current = await this.request('task/list', { sessionId: shell.owner });
          const match = (Array.isArray(current.tasks) ? current.tasks.map(row) : []).find(value => value.task_id === task.taskId);
          if (!match || match.owner_session_id && match.owner_session_id !== shell.owner ||
            shell.started && startKey(match) !== shell.started) return { status: 'stale' };
          if (!sameNativeWorkRef(this.tracker.tasks.get(ref.nativeId)!.native, ref)) return { status: 'stale' };
          const result = await this.request('task/kill', { sessionId: shell.owner, taskId: task.taskId });
          if (result.taskId !== task.taskId) return { status: 'failed' };
          if (result.outcome === 'killed') { this.tracker.observe({ taskId: task.taskId, workKind: 'shell', status: 'stopped', canStop: false }); return { status: 'accepted' }; }
          if (result.outcome === 'not_found') return { status: 'stale' };
          await this.refresh();
          return isTerminalNativeWork(this.tracker.tasks.get(task.taskId)!.status) ? { status: 'already-terminal' } : { status: 'failed' };
        }
        const entry = [...this.children.entries()].find(([, child]) => child.taskId === task.taskId);
        if (!entry || entry[1].epoch === undefined) return { status: 'stale' };
        const [childId, child] = entry;
        const current = row((await this.request('subagent/get', { subagentId: task.taskId, block: false })).snapshot);
        if (current.parentSessionId !== child.parent || current.childSessionId !== childId || current.startedAtEpochMs !== child.epoch) return { status: 'stale' };
        if (!sameNativeWorkRef(this.tracker.tasks.get(ref.nativeId)!.native, ref)) return { status: 'stale' };
        const result = await this.request('subagent/cancel', { subagentId: task.taskId });
        if (result.subagentId !== task.taskId) return { status: 'failed' };
        const outcome = row(result.outcome);
        if (outcome.kind === 'cancelled' || result.cancelled === true) return { status: 'accepted' };
        if (outcome.kind === 'not_found') return { status: 'stale' };
        if (outcome.kind === 'already_finished' && isTerminalNativeWork(state(outcome.status))) {
          this.tracker.observe({ taskId: task.taskId, workKind: 'subagent', status: state(outcome.status), canStop: false });
          return { status: 'already-terminal' };
        }
        return { status: 'failed' };
      } catch (error) {
        if (unsupported(error)) { this.tracker.observe({ taskId: task.taskId, workKind: task.workKind, canStop: false,
          controlReason: '当前 Grok 不支持此任务的单独停止' }); return { status: 'unsupported' }; }
        return { status: 'failed' };
      }
    });
  }
  dispose(): void { this.closed = true; if (this.timer) clearTimeout(this.timer); this.tracker.dispose(); this.children.clear(); }
}
