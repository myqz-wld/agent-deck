import { AgentDeckClientErrorCode, isCoreMethodGranted, parseFeishuPreferencesUpdate,
  type CoreMethod, type JsonValue, type FeishuPreferencesResult } from '@contracts/index';
import { DaemonRequestError, type DaemonCoreRuntime, type DaemonRequestInput,
  type DaemonRequestResult } from '@hosts/daemon';
import type { FeishuPreferenceStore } from './feishu-preference-store';
import type { ServerCoreIssueMetadataPort } from './issue-runtime';
import type { ServerCoreSessionCreateCapabilities } from './session-create-capabilities';
import { ServerCoreFeishuPreferenceService } from './feishu-preference-service';
export { validateFeishuPreferenceChoices } from './feishu-preference-service';

const METHODS = ['feishu.preferences.get', 'feishu.preferences.update'] as const;
/** Both owner surfaces and registered assistant tools share one persistence authority. */
export class ServerCoreFeishuPreferencesRuntime implements DaemonCoreRuntime {
  readonly supportedMethods: readonly CoreMethod[];
  readonly subscribe?: DaemonCoreRuntime['subscribe'];
  readonly service: ServerCoreFeishuPreferenceService;
  constructor(private readonly base: DaemonCoreRuntime, store: FeishuPreferenceStore,
    metadata: ServerCoreIssueMetadataPort, capabilities: Pick<ServerCoreSessionCreateCapabilities, 'describe'>) {
    this.service = new ServerCoreFeishuPreferenceService(store, metadata, capabilities);
    this.supportedMethods = Object.freeze([...new Set([...base.supportedMethods, ...METHODS])]);
    if (base.subscribe) this.subscribe = base.subscribe.bind(base);
  }
  start(): Promise<void> { return this.base.start(); }
  stop(reason: string): Promise<void> { return this.base.stop(reason); }
  currentRevision(...args: Parameters<DaemonCoreRuntime['currentRevision']>): Promise<number> | number {
    return this.base.currentRevision(...args);
  }
  snapshot(): FeishuPreferencesResult { return this.service.read(); }
  async execute(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    if (!(METHODS as readonly CoreMethod[]).includes(input.method)) return this.base.execute(input);
    if (!isCoreMethodGranted(input.access, input.method) || input.access.kind !== 'authenticated-client' ||
      input.access.authority !== 'owner-equivalent') {
      throw new DaemonRequestError(AgentDeckClientErrorCode.AccessDenied, 'Owner access is required');
    }
    if (input.signal.aborted) throw new DaemonRequestError(AgentDeckClientErrorCode.Cancelled, 'Request cancelled');
    let result: FeishuPreferencesResult;
    if (input.method === 'feishu.preferences.get') {
      if (Object.keys(input.params).length > 0) throw new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest, 'Unexpected parameters');
      result = this.service.read();
    } else {
      let params;
      try { params = parseFeishuPreferencesUpdate(input.params); }
      catch { throw new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest, 'Invalid preference fields'); }
      result = await this.service.update(params, {
        connectionScope: input.access.connectionScope, accessSurface: input.access.surface,
        idempotencyKey: input.idempotencyKey ?? '',
      }, input.signal);
    }
    return { result: result as unknown as JsonValue, revision: result.revision };
  }
}
