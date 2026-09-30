import { AgentDeckClientErrorCode, isCoreMethodGranted, parseSessionNameUpdate, type CoreMethod,
  type JsonValue } from '@contracts/index';
import { DaemonRequestError, type DaemonCoreRuntime, type DaemonRequestInput,
  type DaemonRequestResult } from '@hosts/daemon';
import type { ServerCoreSessionNameService } from './session-name-service';

const METHOD = 'session.name.update' as const;
export class ServerCoreSessionNameRuntime implements DaemonCoreRuntime {
  readonly supportedMethods: readonly CoreMethod[];
  readonly subscribe?: DaemonCoreRuntime['subscribe'];
  constructor(private readonly base: DaemonCoreRuntime, private readonly names: ServerCoreSessionNameService) {
    this.supportedMethods = Object.freeze([...new Set([...base.supportedMethods, METHOD])]);
    if (base.subscribe) this.subscribe = base.subscribe.bind(base);
  }
  start(): Promise<void> { return this.base.start(); }
  stop(reason: string): Promise<void> { return this.base.stop(reason); }
  currentRevision(...args: Parameters<DaemonCoreRuntime['currentRevision']>): Promise<number> | number {
    return this.base.currentRevision(...args);
  }
  async execute(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    if (input.method !== METHOD) return this.base.execute(input);
    if (!isCoreMethodGranted(input.access, METHOD) || input.access.kind !== 'authenticated-client' ||
      input.access.authority !== 'owner-equivalent') throw new DaemonRequestError(AgentDeckClientErrorCode.AccessDenied, 'Owner access is required');
    if (input.signal.aborted) throw new DaemonRequestError(AgentDeckClientErrorCode.Cancelled, 'Name update cancelled');
    if (!input.idempotencyKey) throw new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest, 'Stable name-update identity is required');
    let params;
    try { params = parseSessionNameUpdate(input.params); }
    catch { throw new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest,
      'Name update requires a canonical sessionId, single-line non-empty title within 512 UTF-8 bytes and the last-read expectedTitle'); }
    const result = this.names.update(params, {
      connectionScope: input.access.connectionScope, accessSurface: input.access.surface,
      idempotencyKey: input.idempotencyKey,
    });
    return { result: result as unknown as JsonValue, revision: result.revision };
  }
}
