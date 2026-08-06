import { CodexAppServerClient } from './client';
import { desktopCodexClientHost } from './client-diagnostics';
import type {
  CodexAppServerNotification,
  CodexAppServerStreamEvent,
} from './protocol';

const THREAD_OPTIONS = {
  workingDirectory: '/repo',
  sandboxMode: 'workspace-write' as const,
  approvalPolicy: 'never' as const,
  skipGitRepoCheck: true,
};

export class ScriptedClient extends CodexAppServerClient {
  private readonly listeners = new Set<(notification: CodexAppServerNotification) => void>();
  readonly recycles: Array<{
    expectedGeneration: number;
    threadId: string;
    turnId: string;
    message: string;
  }> = [];
  turnStartCalls = 0;
  pendingTurnStartRejected = false;
  private rejectPendingTurnStart: ((err: Error) => void) | null = null;

  constructor(
    timeoutMs: number,
    private readonly afterTurnStart?: (client: ScriptedClient) => void,
    private readonly responseDelayMs: number | null = 0,
    private readonly emitTurnStarted = true,
    private readonly afterResponseResolved?: (client: ScriptedClient) => void,
  ) {
    super({ env: {}, config: null, firstModelEventTimeoutMs: timeoutMs }, desktopCodexClientHost);
  }

  override request<T = unknown>(method: string, _params: unknown): Promise<T> {
    if (method === 'thread/start') {
      return Promise.resolve({ thread: { id: 'thread-1' } } as T);
    }
    if (method === 'turn/start') {
      this.turnStartCalls += 1;
      if (this.emitTurnStarted) {
        this.emit(notify('turn/started', {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'inProgress', items: [] },
        }));
      }
      this.afterTurnStart?.(this);
      if (this.responseDelayMs === null) {
        return new Promise<T>((_resolve, reject) => {
          this.rejectPendingTurnStart = reject;
        });
      }
      if (this.responseDelayMs > 0) {
        return new Promise<T>((resolve) => {
          setTimeout(() => resolve({ turn: { id: 'turn-1' } } as T), this.responseDelayMs!);
        });
      }
      if (this.afterResponseResolved) {
        return new Promise<T>((resolve) => {
          resolve({ turn: { id: 'turn-1' } } as T);
          this.afterResponseResolved?.(this);
        });
      }
      return Promise.resolve({ turn: { id: 'turn-1' } } as T);
    }
    return Promise.resolve({} as T);
  }

  override subscribe(listener: (notification: CodexAppServerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  override hasExclusiveNotificationSubscriber(): boolean {
    return this.listeners.size === 1;
  }

  override abortTurnAndRecycleGeneration(
    expectedGeneration: number,
    threadId: string,
    turnId: string,
    err: Error,
  ): boolean {
    this.recycles.push({ expectedGeneration, threadId, turnId, message: err.message });
    if (this.rejectPendingTurnStart) {
      const reject = this.rejectPendingTurnStart;
      this.rejectPendingTurnStart = null;
      this.pendingTurnStartRejected = true;
      reject(err);
    }
    this.emit(notify('error', {
      threadId,
      turnId,
      willRetry: false,
      error: { message: err.message },
    }));
    return true;
  }

  emit(notification: CodexAppServerNotification): void {
    for (const listener of [...this.listeners]) listener(notification);
  }
}

export class ConcurrentScriptedClient extends CodexAppServerClient {
  private readonly listeners = new Set<(notification: CodexAppServerNotification) => void>();
  private nextThread = 1;
  turnStartCalls = 0;

  constructor(timeoutMs: number) {
    super({ env: {}, config: null, firstModelEventTimeoutMs: timeoutMs }, desktopCodexClientHost);
  }

  override request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (method === 'thread/start') {
      const ordinal = this.nextThread++;
      const threadId = `thread-${ordinal}`;
      return Promise.resolve({
        thread: { id: threadId },
        model: `gpt-${ordinal}`,
        modelProvider: 'openai',
      } as T);
    }
    if (method === 'turn/start') {
      this.turnStartCalls += 1;
      const threadId = (params as { threadId: string }).threadId;
      const turnId = threadId.replace('thread-', 'turn-');
      if (this.turnStartCalls === 2) {
        setTimeout(() => this.emit(notify('turn/started', {
          turn: { id: 'orphan-turn', status: 'inProgress', items: [] },
        })), 0);
      }
      return new Promise<T>((resolve) => {
        setTimeout(() => resolve({ turn: { id: turnId } } as T), 40);
      });
    }
    return Promise.resolve({} as T);
  }

  override subscribe(listener: (notification: CodexAppServerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  override hasExclusiveNotificationSubscriber(): boolean {
    return this.listeners.size === 1;
  }

  emit(notification: CodexAppServerNotification): void {
    for (const listener of [...this.listeners]) listener(notification);
  }
}

export async function collectTurn(
  client: CodexAppServerClient,
): Promise<CodexAppServerStreamEvent[]> {
  const thread = client.startThread(THREAD_OPTIONS);
  const { events } = await thread.runStreamed([
    { type: 'text', text: 'do work', text_elements: [] },
  ]);
  const collected: CodexAppServerStreamEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

export async function* replay(events: CodexAppServerStreamEvent[]) {
  for (const event of events) yield event;
}

export function completedTurn(
  threadId = 'thread-1',
  turnId = 'turn-1',
): CodexAppServerNotification {
  return notify('turn/completed', {
    threadId,
    turn: { id: turnId, status: 'completed', items: [] },
  });
}

export function notify(method: string, params?: unknown): CodexAppServerNotification {
  return { method, ...(params === undefined ? {} : { params }) };
}

export function eventName(event: CodexAppServerStreamEvent): string {
  if (event.type === 'thread.started' || event.type === 'turn.accepted') return event.type;
  return `${event.type}:${event.notification.method}`;
}
