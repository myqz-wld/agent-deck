import {
  AgentDeckClientErrorCode,
  isCoreMethodGranted,
  isJsonValue,
  parseDesktopBrokerNextParams,
  parseDesktopBrokerRespondParams,
  SessionConsoleContractError,
  type CoreMethod,
} from '@contracts/index';
import {
  DaemonRequestError,
  type DaemonCoreRuntime,
  type DaemonEventSubscriptionInput,
  type DaemonRequestInput,
  type DaemonRequestResult,
} from '@hosts/daemon';

import {
  ServerCoreDesktopBrokerError,
  type ServerCoreDesktopBrokerPort,
} from './desktop-broker-port';

export const SERVER_CORE_DESKTOP_BROKER_METHODS = Object.freeze([
  'desktop.broker.next',
  'desktop.broker.respond',
] as const satisfies readonly CoreMethod[]);

type DesktopBrokerMethod = (typeof SERVER_CORE_DESKTOP_BROKER_METHODS)[number];

function isDesktopBrokerMethod(method: CoreMethod): method is DesktopBrokerMethod {
  return (SERVER_CORE_DESKTOP_BROKER_METHODS as readonly CoreMethod[]).includes(method);
}

/** Adds desktop long-poll broker methods without persisting browser request bodies in replay. */
export class ServerCoreDesktopBrokerRuntime implements DaemonCoreRuntime {
  readonly supportedMethods: readonly CoreMethod[];
  readonly subscribe?: DaemonCoreRuntime['subscribe'];

  constructor(
    private readonly base: DaemonCoreRuntime,
    private readonly broker: ServerCoreDesktopBrokerPort,
  ) {
    this.supportedMethods = Object.freeze([
      ...new Set([...base.supportedMethods, ...SERVER_CORE_DESKTOP_BROKER_METHODS]),
    ]);
    if (base.subscribe) {
      const subscribe = base.subscribe.bind(base);
      this.subscribe = (input: DaemonEventSubscriptionInput) => subscribe(input);
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
    if (!isDesktopBrokerMethod(input.method)) return this.base.execute(input);
    if (!isCoreMethodGranted(input.access, input.method)) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.AccessDenied, 'Request rejected');
    }
    if (input.signal.aborted) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.Cancelled, 'Request was cancelled');
    }
    try {
      if (input.method === 'desktop.broker.next') {
        const value = await this.broker.next(
          input.access,
          parseDesktopBrokerNextParams(input.params),
          input.signal,
        );
        const revision = await this.base.currentRevision(input.access);
        const result = { ...value, revision };
        if (!isJsonValue(result)) throw new Error('Desktop broker result is not JSON-safe');
        return { result, revision };
      }
      const value = this.broker.respond(
        input.access,
        parseDesktopBrokerRespondParams(input.params),
      );
      const revision = await this.base.currentRevision(input.access);
      const result = { ...value, revision };
      if (!isJsonValue(result)) throw new Error('Desktop broker result is not JSON-safe');
      return { result, revision };
    } catch (error) {
      if (error instanceof SessionConsoleContractError) {
        throw new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest, 'Request rejected');
      }
      if (error instanceof ServerCoreDesktopBrokerError) throw this.project(error);
      throw error;
    }
  }

  private project(error: ServerCoreDesktopBrokerError): DaemonRequestError {
    switch (error.code) {
      case 'cancelled':
        return new DaemonRequestError(AgentDeckClientErrorCode.Cancelled, 'Desktop poll cancelled');
      case 'conflict':
        return new DaemonRequestError(AgentDeckClientErrorCode.Conflict, 'Browser request changed');
      case 'not-found':
        return new DaemonRequestError(AgentDeckClientErrorCode.NotFound, 'Browser request expired');
      case 'limit':
        return new DaemonRequestError(AgentDeckClientErrorCode.Conflict, 'Desktop broker is busy');
      case 'timeout':
        return new DaemonRequestError(AgentDeckClientErrorCode.DeadlineExceeded, 'Browser request expired');
      case 'stopped':
      case 'unavailable':
        return new DaemonRequestError(AgentDeckClientErrorCode.ProviderLost, 'Desktop broker unavailable', true);
    }
  }
}
