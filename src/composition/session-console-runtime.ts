import {
  AgentDeckClientErrorCode,
  isJsonValue,
  SessionConsoleContractError,
  type CoreMethod,
} from '@contracts/index';
import {
  SessionConsoleCoreDispatcher,
  SessionConsoleDispatchError,
  isSessionConsoleCoreMethod,
  type AuthoritativeSessionConsolePort,
} from '@core/session-console';
import {
  DaemonRequestError,
  type DaemonCoreRuntime,
  type DaemonRequestInput,
  type DaemonRequestResult,
} from '@hosts/daemon';

function supportedMethods(base: DaemonCoreRuntime): readonly CoreMethod[] {
  return Object.freeze([
    ...new Set<CoreMethod>([
      ...base.supportedMethods,
      'project.list',
      'session.console.capabilities',
      'session.console.create',
      'session.console.get',
      'session.console.list',
      'workspace.directory.list',
    ]),
  ]);
}

/** Adds only cwd-free protocol-v2 methods; all other Core execution stays on the injected runtime. */
export class SessionConsoleDaemonRuntime implements DaemonCoreRuntime {
  readonly supportedMethods: readonly CoreMethod[];
  readonly subscribe?: DaemonCoreRuntime['subscribe'];
  private readonly dispatcher: SessionConsoleCoreDispatcher;

  constructor(
    private readonly base: DaemonCoreRuntime,
    authority: AuthoritativeSessionConsolePort,
  ) {
    this.supportedMethods = supportedMethods(base);
    this.dispatcher = new SessionConsoleCoreDispatcher(authority);
    if (base.subscribe) {
      const subscribe = base.subscribe.bind(base);
      this.subscribe = (input) => subscribe(input);
    }
  }

  start(): Promise<void> {
    return this.base.start();
  }

  stop(reason: string): Promise<void> {
    return this.base.stop(reason);
  }

  currentRevision(...args: Parameters<DaemonCoreRuntime['currentRevision']>): Promise<number> | number {
    return this.base.currentRevision(...args);
  }

  async execute(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    if (!isSessionConsoleCoreMethod(input.method)) return this.base.execute(input);
    try {
      const result = await this.dispatcher.execute(input.method, input.params, {
        access: input.access,
        idempotencyKey: input.idempotencyKey,
        expectedRevision: input.expectedRevision,
        deadlineAt: input.deadlineAt,
        signal: input.signal,
      });
      if (!isJsonValue(result) || !Number.isSafeInteger(result.revision) || result.revision < 0) {
        throw new Error('session-console authority returned an invalid result');
      }
      return { result, revision: result.revision };
    } catch (error) {
      if (error instanceof DaemonRequestError) throw error;
      if (input.signal.aborted) {
        throw new DaemonRequestError(
          AgentDeckClientErrorCode.Cancelled,
          'Request was cancelled',
        );
      }
      if (
        error instanceof SessionConsoleContractError &&
        error.field.includes('params')
      ) {
        throw new DaemonRequestError(
          AgentDeckClientErrorCode.InvalidRequest,
          'Request rejected',
        );
      }
      if (error instanceof SessionConsoleDispatchError) {
        throw new DaemonRequestError(
          AgentDeckClientErrorCode.AccessDenied,
          'Request rejected',
        );
      }
      throw error;
    }
  }
}
