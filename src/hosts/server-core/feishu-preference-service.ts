import { createHash } from 'node:crypto';
import { AgentDeckClientErrorCode, FEISHU_PREFERENCE_OPTION_KEYS, parseFeishuPreferencesResult,
  parseFeishuPreferencesUpdate, type FeishuModelPreference, type FeishuPreferencesResult,
  type FeishuPreferencesUpdateParams, type JsonValue, type SessionConsoleCapabilitiesResult } from '@contracts/index';
import { DaemonRequestError } from '@hosts/daemon';
import type { FeishuPreferenceStore } from './feishu-preference-store';
import type { ServerCoreIssueMetadataPort } from './issue-runtime';
import type { ServerCoreSessionCreateCapabilities } from './session-create-capabilities';
import type { SessionNameMutationScope } from './session-name-service';

export function validateFeishuPreferenceChoices(
  preference: FeishuModelPreference, capability: SessionConsoleCapabilitiesResult,
): void {
  if (!capability.create.enabled || capability.selectedAdapterId !== preference.adapterId) {
    throw new DaemonRequestError(AgentDeckClientErrorCode.CapabilityUnavailable, 'Selected adapter is unavailable');
  }
  for (const key of FEISHU_PREFERENCE_OPTION_KEYS) {
    const value = preference[key];
    if (!value) continue;
    const descriptor = capability.create.options[key];
    if (!descriptor.enabled || (!descriptor.allowCustom && !descriptor.allowedValues?.includes(value))) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest, 'Selected session option is unavailable');
    }
  }
}

export class ServerCoreFeishuPreferenceService {
  constructor(private readonly store: FeishuPreferenceStore,
    private readonly metadata: ServerCoreIssueMetadataPort,
    private readonly capabilities: Pick<ServerCoreSessionCreateCapabilities, 'describe'>) {}
  read(): FeishuPreferencesResult {
    return { ...this.store.read(), revision: this.metadata.currentRevision() };
  }
  async update(raw: FeishuPreferencesUpdateParams, scope: SessionNameMutationScope,
    signal?: AbortSignal, beforeWrite?: () => void): Promise<FeishuPreferencesResult> {
    if (signal?.aborted) throw new DaemonRequestError(AgentDeckClientErrorCode.Cancelled, 'Preference update cancelled');
    let params;
    try { params = parseFeishuPreferencesUpdate(raw); }
    catch { throw new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest, 'Invalid preference fields'); }
    if (!scope.idempotencyKey) throw new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest, 'Stable idempotency is required');
    const identity = {
      connectionScope: scope.connectionScope, accessSurface: scope.accessSurface,
      method: 'feishu.preferences.update', idempotencyKey: scope.idempotencyKey,
      requestFingerprint: createHash('sha256').update(JSON.stringify(params)).digest('hex'),
    };
    const claim = this.metadata.claimMutation(identity);
    if (claim.state === 'completed') {
      const result = parseFeishuPreferencesResult(claim.result);
      return result;
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
      if (signal?.aborted) throw new DaemonRequestError(AgentDeckClientErrorCode.Cancelled, 'Request cancelled');
      beforeWrite?.();
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
      return result;
    } catch (error) {
      if (!written) this.metadata.releaseMutationClaim(identity);
      throw error;
    }
  }
}
