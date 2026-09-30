import { createHash } from 'node:crypto';
import {
  AgentDeckClientErrorCode, isCoreMethodGranted, parseFeishuPreferencesResult,
  parseFeishuPreferencesUpdate, type FeishuModelPreference, type FeishuPreferencesResult,
  type CoreMethod, type JsonValue, type SessionConsoleCapabilitiesResult,
} from '@contracts/index';
import { DaemonRequestError, type DaemonCoreRuntime, type DaemonRequestInput,
  type DaemonRequestResult } from '@hosts/daemon';
import type { FeishuPreferenceStore } from './feishu-preference-store';
import type { ServerCoreIssueMetadataPort } from './issue-runtime';
import type { ServerCoreSessionCreateCapabilities } from './session-create-capabilities';

const METHODS = ['feishu.preferences.get', 'feishu.preferences.update'] as const;

export function validateFeishuPreferenceChoices(
  preference: FeishuModelPreference, capability: SessionConsoleCapabilitiesResult,
): void {
  if (!capability.create.enabled || capability.selectedAdapterId !== preference.adapterId) {
    throw new DaemonRequestError(AgentDeckClientErrorCode.CapabilityUnavailable, 'Selected adapter is unavailable');
  }
  for (const key of ['provider', 'model', 'thinking'] as const) {
    const value = preference[key];
    if (!value) continue;
    const descriptor = capability.create.options[key];
    if (!descriptor.enabled || (!descriptor.allowCustom && !descriptor.allowedValues?.includes(value))) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest, 'Selected model option is unavailable');
    }
  }
}

/** Both the Desktop and Feishu owner surfaces read and update this one Core-owned selection. */
export class ServerCoreFeishuPreferencesRuntime implements DaemonCoreRuntime {
  readonly supportedMethods: readonly CoreMethod[];
  readonly subscribe?: DaemonCoreRuntime['subscribe'];
  constructor(
    private readonly base: DaemonCoreRuntime,
    private readonly store: FeishuPreferenceStore,
    private readonly metadata: ServerCoreIssueMetadataPort,
    private readonly capabilities: Pick<ServerCoreSessionCreateCapabilities, 'describe'>,
  ) {
    this.supportedMethods = Object.freeze([...new Set([...base.supportedMethods, ...METHODS])]);
    if (base.subscribe) this.subscribe = base.subscribe.bind(base);
  }
  start(): Promise<void> { return this.base.start(); }
  stop(reason: string): Promise<void> { return this.base.stop(reason); }
  currentRevision(...args: Parameters<DaemonCoreRuntime['currentRevision']>): Promise<number> | number {
    return this.base.currentRevision(...args);
  }
  snapshot(): FeishuPreferencesResult {
    return { ...this.store.read(), revision: this.metadata.currentRevision() };
  }
  async execute(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    if (!(METHODS as readonly CoreMethod[]).includes(input.method)) return this.base.execute(input);
    if (!isCoreMethodGranted(input.access, input.method) || input.access.kind !== 'authenticated-client' ||
      input.access.authority !== 'owner-equivalent') {
      throw new DaemonRequestError(AgentDeckClientErrorCode.AccessDenied, 'Owner access is required');
    }
    if (input.signal.aborted) throw new DaemonRequestError(AgentDeckClientErrorCode.Cancelled, 'Request cancelled');
    if (input.method === 'feishu.preferences.get') {
      if (Object.keys(input.params).length > 0) throw new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest, 'Unexpected parameters');
      const result = this.snapshot();
      return { result: result as unknown as JsonValue, revision: result.revision };
    }
    let params;
    try { params = parseFeishuPreferencesUpdate(input.params); }
    catch { throw new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest, 'Invalid preference fields'); }
    if (!input.idempotencyKey) throw new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest, 'Stable idempotency is required');
    const identity = {
      connectionScope: input.access.connectionScope, accessSurface: input.access.surface,
      method: input.method, idempotencyKey: input.idempotencyKey,
      requestFingerprint: createHash('sha256').update(JSON.stringify(params)).digest('hex'),
    };
    const claim = this.metadata.claimMutation(identity);
    if (claim.state === 'completed') {
      const result = parseFeishuPreferencesResult(claim.result);
      return { result: result as unknown as JsonValue, revision: claim.revision };
    }
    if (claim.state !== 'claimed') throw new DaemonRequestError(
      claim.state === 'conflict' ? AgentDeckClientErrorCode.Conflict : AgentDeckClientErrorCode.ProviderLost,
      'Previous preference update must be reconciled',
    );
    let written = false;
    try {
      if (params.preference.adapterId) validateFeishuPreferenceChoices(params.preference,
        await this.capabilities.describe({ adapterId: params.preference.adapterId,
          provider: params.preference.provider, workingDirectory: '.' }));
      if (input.signal.aborted) throw new DaemonRequestError(AgentDeckClientErrorCode.Cancelled, 'Request cancelled');
      const current = this.store.read();
      if (current.settingsRevision !== params.expectedSettingsRevision) {
        throw new DaemonRequestError(AgentDeckClientErrorCode.Conflict, 'Preferences changed; refresh before saving');
      }
      if (current.settingsRevision === Number.MAX_SAFE_INTEGER) {
        throw new DaemonRequestError(AgentDeckClientErrorCode.Conflict, 'Preference revision exhausted');
      }
      const next = { ...current, [params.purpose]: params.preference, settingsRevision: current.settingsRevision + 1 };
      // A file write may report an fsync error after rename; retain the claim on any write attempt.
      written = true;
      this.store.write(next);
      const revision = this.metadata.appendChange('feishu.preferences.updated', null, { settingsRevision: next.settingsRevision });
      const result = { ...next, revision };
      this.metadata.completeMutation(identity, result as unknown as JsonValue, revision);
      return { result: result as unknown as JsonValue, revision };
    } catch (error) {
      if (!written) this.metadata.releaseMutationClaim(identity);
      throw error;
    }
  }
}
