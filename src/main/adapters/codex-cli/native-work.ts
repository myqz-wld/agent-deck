import type { AgentEvent } from '@shared/types';
import { isTerminalNativeWork, sameNativeWorkRef, type NativeWorkRef, type NativeWorkSnapshot, type NativeWorkStopResult } from '@shared/native-work';
import { NativeWorkTracker } from '../native-work-tracker';
import type { CodexAppServerClient, CodexAppServerNotification } from './app-server/client';
import type { InternalSession } from './sdk-bridge/types';

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const status = (value: unknown): NativeWorkSnapshot['status'] => ({ pendingInit: 'pending', running: 'running',
  inProgress: 'running', completed: 'completed', interrupted: 'stopped', shutdown: 'stopped',
  errored: 'failed', failed: 'failed', notFound: 'unknown' } as Record<string, NativeWorkSnapshot['status']>)[String(value)] ?? 'unknown';
const unsupported = (error: unknown) => /method.*not.*found|unknown method|unsupported|experimental.*disabled/i.test(String(error));
interface Terminal { threadId: string; processId: string; itemId: string }

/** A subscription owned by the session, independent of foreground turn iterators and UI mounts. */
export class CodexNativeWork {
  private tracker: NativeWorkTracker | null = null;
  private generation = -1;
  private unsubscribe: () => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private children = new Map<string, string>();
  private terminals = new Map<string, Terminal>();
  private recentItems = new Map<string, Row>();
  private textStreams = new Map<string, string>();
  private polling: Promise<void> | null = null;
  private closed = false;
  private terminalSupported = true;
  private historySupported = true;
  private parentHistoryRead = false;
  constructor(private readonly internal: InternalSession, private readonly client: CodexAppServerClient,
    private readonly emit: (event: AgentEvent) => void) {
    this.unsubscribe = client.subscribe(notification => this.notification(notification));
    this.schedule();
  }
  private active(): NativeWorkTracker | null {
    if (this.closed || this.internal.intentionallyClosed || !this.client.isProcessAlive || !this.internal.threadId) return null;
    if (this.generation !== this.client.generation || this.tracker?.sessionId !== this.internal.applicationSid) {
      this.tracker?.dispose();
      this.generation = this.client.generation;
      this.tracker = new NativeWorkTracker(this.internal.applicationSid, 'codex-cli', this.emit);
      this.children.clear(); this.terminals.clear(); this.recentItems.clear(); this.textStreams.clear();
      this.terminalSupported = true; this.historySupported = true; this.parentHistoryRead = false;
    }
    return this.tracker;
  }
  private owns(threadId: string): boolean {
    return threadId === this.internal.threadId || this.children.has(threadId);
  }
  private request<T>(method: string, params: unknown): Promise<T> {
    return this.client.requestLive<T>(method, params, this.generation);
  }
  private schedule(): void {
    if (this.closed) return;
    this.timer = setTimeout(() => { this.timer = null; void this.refresh().finally(() => this.schedule()); }, 3000);
    this.timer.unref?.();
  }
  notification(notification: CodexAppServerNotification): void {
    const tracker = this.active();
    if (!tracker) return;
    const params = row(notification.params), thread = row(params.thread);
    if (notification.method === 'thread/started' && id(thread.id) && id(thread.parentThreadId) && this.owns(thread.parentThreadId)) {
      this.registerChild(thread.id, thread.parentThreadId, typeof thread.agentNickname === 'string' ? thread.agentNickname : '子代理');
    }
    const threadId = params.threadId;
    if (!id(threadId) || !this.owns(threadId)) return;
    const child = this.children.has(threadId);
    if (id(params.itemId) && typeof params.delta === 'string') {
      const key = `${threadId}:${params.turnId}:${params.itemId}:${notification.method}`;
      const before = this.textStreams.get(key) ?? '';
      const combined = before + params.delta;
      const text = combined.slice(0, 1024 * 1024);
      this.textStreams.set(key, text);
      if (this.textStreams.size > 256) this.textStreams.delete(this.textStreams.keys().next().value!);
      if (notification.method === 'item/commandExecution/outputDelta') {
        const itemKey = `${threadId}:${params.itemId}`;
        const item = { ...(this.recentItems.get(itemKey) ?? { id: params.itemId, type: 'commandExecution' }), aggregatedOutput: text,
          outputTruncated: combined.length > text.length };
        this.item(threadId, item, id(params.turnId) ? params.turnId : undefined);
      } else if (child && tracker.tasks.get(threadId)?.runId === params.turnId &&
        ['item/agentMessage/delta', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta'].includes(notification.method)) {
        tracker.detail(threadId, params.itemId, notification.method === 'item/agentMessage/delta' ? 'message' : 'thinking', text,
          { sourceTruncated: combined.length > text.length });
      }
      return;
    }
    if (notification.method === 'turn/started' || notification.method === 'turn/completed') {
      const turn = row(params.turn);
      if (child && id(turn.id)) tracker.observe({ taskId: threadId, workKind: 'subagent', runId: turn.id,
        status: status(turn.status), canStop: turn.status === 'inProgress' }, notification.method === 'turn/started');
      // Parent finish is deliberately not propagated to children.
      return;
    }
    if (notification.method === 'item/started' || notification.method === 'item/completed') {
      this.item(threadId, row(params.item), id(params.turnId) ? params.turnId : undefined);
    }
  }
  private registerChild(threadId: string, parentId: string, description: string): void {
    if (!this.tracker || threadId === this.internal.threadId || !this.owns(parentId)) return;
    this.children.set(threadId, parentId);
    if (!this.tracker.tasks.has(threadId)) this.tracker.observe({ taskId: threadId, workKind: 'subagent',
      description: description.slice(0, 2000), parentTaskId: parentId === this.internal.threadId ? undefined : parentId,
      status: 'pending', canStop: false, controlReason: '等待子代理当前轮次' });
  }
  private item(threadId: string, item: Row, turnId?: string): void {
    const tracker = this.tracker;
    if (!tracker || !id(item.id)) return;
    if (item.type === 'collabAgentToolCall' && item.senderThreadId === threadId && Array.isArray(item.receiverThreadIds)) {
      for (const childId of item.receiverThreadIds) {
        if (!id(childId)) continue;
        // Only spawn is ownership evidence; send/wait can name pre-existing unrelated agents.
        if (item.tool === 'spawnAgent') this.registerChild(childId, threadId, '子代理');
        if (!this.children.has(childId)) continue;
        const state = row(row(item.agentsStates)[childId]);
        const current = tracker.tasks.get(childId);
        if (current && id(state.status)) tracker.observe({ taskId: childId, workKind: 'subagent',
          status: status(state.status), ...(typeof state.message === 'string' ? { summary: state.message.slice(0, 2000) } : {}) });
        if (typeof state.message === 'string') tracker.detail(childId, `state:${item.id}`, 'output', state.message);
      }
    }
    if (item.type === 'subAgentActivity' && item.kind === 'started' && id(item.agentThreadId)) {
      this.registerChild(item.agentThreadId, threadId, '子代理');
    }
    if (item.type === 'commandExecution') {
      this.recentItems.set(`${threadId}:${item.id}`, item);
      if (this.recentItems.size > 256) this.recentItems.delete(this.recentItems.keys().next().value!);
      for (const [taskId, terminal] of this.terminals) {
        if (terminal.threadId === threadId && terminal.itemId === item.id) this.command(taskId, item);
      }
    }
    if (!this.children.has(threadId)) return;
    const task = tracker.tasks.get(threadId);
    if (turnId && task?.runId !== turnId) return; // A delayed previous-turn item cannot enter a new attempt.
    if (item.type === 'agentMessage' && typeof item.text === 'string') tracker.detail(threadId, item.id, 'message', item.text, { role: 'assistant' });
    else if (item.type === 'userMessage' && Array.isArray(item.content)) {
      const text = item.content.map(row).filter(value => value.type === 'text' && typeof value.text === 'string')
        .map(value => value.text).join('\n');
      if (text) tracker.detail(threadId, item.id, 'message', text, { role: 'user' });
    }
    else if (item.type === 'reasoning') tracker.detail(threadId, item.id, 'thinking', JSON.stringify(item.summary ?? item.content ?? []));
    else if (item.type === 'commandExecution') this.command(threadId, item);
    else if (['mcpToolCall', 'dynamicToolCall', 'fileChange', 'functionCallOutput'].includes(String(item.type))) {
      tracker.detail(threadId, item.id, item.type === 'fileChange' ? 'file-changed' : 'tool-use-end', JSON.stringify(item), {
        toolUseId: item.id, toolStatus: typeof item.status === 'string' ? item.status : undefined });
    }
  }
  private command(taskId: string, item: Row): void {
    const tracker = this.tracker!;
    const metadata = { toolUseId: String(item.id), toolName: 'Bash',
      toolStatus: typeof item.status === 'string' ? item.status : undefined,
      exitCode: typeof item.exitCode === 'number' ? item.exitCode : undefined };
    if (typeof item.command === 'string') tracker.detail(taskId, `${item.id}:command`, 'tool-use-start', item.command, metadata);
    if (typeof item.aggregatedOutput === 'string') tracker.detail(taskId, `${item.id}:output`, 'output', item.aggregatedOutput,
      { ...metadata, sourceTruncated: item.outputTruncated === true });
    if (this.terminals.has(taskId) && typeof item.exitCode === 'number') tracker.observe({ taskId, workKind: 'shell',
      status: item.exitCode === 0 ? 'completed' : 'failed' });
  }
  refresh(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = this.poll().catch(() => {}).finally(() => { this.polling = null; });
    return this.polling;
  }
  private async poll(): Promise<void> {
    const tracker = this.active();
    if (!tracker) { this.tracker?.dispose(); return; }
    const generation = this.generation;
    if (!this.parentHistoryRead && this.historySupported) {
      await this.items(this.internal.threadId!);
      this.parentHistoryRead = true;
    }
    for (const childId of this.children.keys()) {
      if (this.closed || generation !== this.client.generation) return;
      try {
        const beforeRun = tracker.tasks.get(childId)?.runId;
        const response = await this.request<{ data: Row[] }>('thread/turns/list', { threadId: childId, limit: 1, sortDirection: 'desc', itemsView: 'summary' });
        const turn = response.data?.[0];
        const currentRun = tracker.tasks.get(childId)?.runId;
        if (currentRun !== beforeRun && turn?.id !== currentRun) continue;
        if (turn && id(turn.id)) {
          tracker.observe({ taskId: childId, workKind: 'subagent', runId: turn.id, status: status(turn.status),
            canStop: turn.status === 'inProgress', controlReason: undefined }, true);
          await this.items(childId, turn.id);
        }
      } catch (error) {
        if (unsupported(error)) tracker.observe({ taskId: childId, workKind: 'subagent', canStop: false, controlReason: '当前 Codex 不支持子代理轮次查询' });
      }
    }
    if (this.terminalSupported) for (const threadId of [this.internal.threadId!, ...this.children.keys()]) {
      if (this.closed || generation !== this.client.generation) return;
      await this.backgroundTerminals(threadId);
    }
  }
  private async items(threadId: string, turnId?: string): Promise<void> {
    if (!this.historySupported) return;
    try {
      let cursor: string | null = null;
      for (let page = 0; page < 32; page++) {
        const result: { data: Row[]; nextCursor: string | null } = await this.request('thread/items/list',
          { threadId, ...(turnId ? { turnId } : {}), cursor, limit: 64, sortDirection: 'asc' });
        for (const entry of result.data ?? []) this.item(threadId, row(entry.item), id(entry.turnId) ? entry.turnId : turnId);
        if (!result.nextCursor || result.nextCursor === cursor) return;
        cursor = result.nextCursor;
      }
      if (this.children.has(threadId)) this.tracker?.observe({ taskId: threadId, workKind: 'subagent', detailStatus: 'partial' });
    } catch (error) { if (unsupported(error)) this.historySupported = false; }
  }
  private async backgroundTerminals(threadId: string): Promise<void> {
    try {
      let cursor: string | null = null;
      const seen = new Set<string>();
      for (let page = 0; page < 32; page++) {
        const response: { data: Row[]; nextCursor: string | null } = await this.request('thread/backgroundTerminals/list', { threadId, cursor, limit: 64 });
        for (const terminal of response.data ?? []) {
          if (!id(terminal.processId) || !id(terminal.itemId)) continue;
          const taskId = `${threadId}:${terminal.processId}`;
          seen.add(taskId);
          this.terminals.set(taskId, { threadId, processId: terminal.processId, itemId: terminal.itemId });
          this.tracker!.observe({ taskId, workKind: 'shell', runId: terminal.itemId, status: 'running', canStop: true,
            toolUseId: terminal.itemId,
            description: typeof terminal.command === 'string' ? terminal.command.slice(0, 2000) : '后台命令',
            parentTaskId: this.children.has(threadId) ? threadId : undefined }, true);
          const item = this.recentItems.get(`${threadId}:${terminal.itemId}`);
          if (item) this.command(taskId, item);
        }
        if (!response.nextCursor) {
          for (const [taskId, terminal] of this.terminals) {
            const task = this.tracker!.tasks.get(taskId)!;
            if (terminal.threadId === threadId && !seen.has(taskId) && !isTerminalNativeWork(task.status)) {
              this.tracker!.observe({ taskId, workKind: 'shell', status: 'unknown', canStop: false, controlReason: '任务已不在运行列表中，等待最终结果' });
            }
          }
          return;
        }
        if (response.nextCursor === cursor) return;
        cursor = response.nextCursor;
      }
    } catch (error) { if (unsupported(error)) this.terminalSupported = false; }
  }
  list(): NativeWorkSnapshot[] { if (!this.active()) this.tracker?.dispose(); return this.tracker?.list() ?? []; }
  async stop(ref: NativeWorkRef): Promise<NativeWorkStopResult> {
    const tracker = this.active();
    if (!tracker) return { status: 'stale' };
    return tracker.stop(ref, async task => {
      try {
        const terminal = this.terminals.get(task.taskId);
        if (terminal) {
          let cursor: string | null = null;
          let verified = false;
          for (let page = 0; page < 32; page++) {
            const current: { data: Row[]; nextCursor: string | null } = await this.request('thread/backgroundTerminals/list',
              { threadId: terminal.threadId, cursor, limit: 64 });
            const match = current.data?.find(value => value.processId === terminal.processId);
            if (match) { verified = match.itemId === terminal.itemId; break; }
            if (!current.nextCursor || current.nextCursor === cursor) break;
            cursor = current.nextCursor;
          }
          if (!verified || !sameNativeWorkRef(tracker.tasks.get(ref.nativeId)!.native, ref)) return { status: 'stale' };
          const response = await this.request<{ terminated: boolean }>('thread/backgroundTerminals/terminate', { threadId: terminal.threadId, processId: terminal.processId });
          if (!response.terminated) return { status: 'failed', reason: '运行实例未确认终止该任务' };
          tracker.observe({ taskId: task.taskId, workKind: 'shell', status: 'stopped', canStop: false });
        } else {
          if (!this.children.has(task.taskId)) return { status: 'stale' };
          const response = await this.request<{ data: Row[] }>('thread/turns/list', { threadId: task.taskId, limit: 1, sortDirection: 'desc', itemsView: 'summary' });
          if (response.data?.[0]?.id !== ref.runId || response.data[0].status !== 'inProgress') return { status: 'stale' };
          if (!sameNativeWorkRef(tracker.tasks.get(ref.nativeId)!.native, ref)) return { status: 'stale' };
          await this.request('turn/interrupt', { threadId: task.taskId, turnId: ref.runId });
        }
        return { status: 'accepted' };
      } catch (error) {
        if (unsupported(error)) { tracker.observe({ taskId: task.taskId, workKind: task.workKind, canStop: false, controlReason: '当前 Codex 不支持此任务的单独停止' }); return { status: 'unsupported' }; }
        return { status: 'failed' };
      }
    });
  }
  dispose(): void { this.closed = true; if (this.timer) clearTimeout(this.timer); this.unsubscribe(); this.tracker?.dispose(); }
}
