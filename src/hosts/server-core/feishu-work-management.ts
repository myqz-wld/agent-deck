import { createHash } from 'node:crypto';
import { AgentDeckClientErrorCode, SESSION_CONSOLE_CREATE_OPTION_KEYS, FEISHU_PREFERENCE_OPTION_KEYS,
  isJsonObject, mergeFeishuModelPreference, parseFeishuPreferencePatch, parseFeishuRequestId, parseFeishuPreferencesResult,
  parseFeishuWorkCreateArgs, parseFeishuWorkCreateResult, type FeishuModelPreference,
  type FeishuPreferencePurpose, type FeishuPreferencesResult, type FeishuWorkCreateArgs,
  type FeishuWorkCreateResult, type JsonValue, type SessionConsoleCreateOptions,
  type SessionNameUpdateParams, type SessionNameUpdateResult } from '@contracts/index';
import { DaemonRequestError } from '@hosts/daemon';
import type { SessionRecord } from '@shared/types';
import type { FeishuAssistantAuthority } from './feishu-assistant-authority';
import { validateFeishuPreferenceChoices, type ServerCoreFeishuPreferenceService } from './feishu-preference-service';
import type { ServerCoreRuntimeMetadataStore } from './runtime-metadata-store';
import type { ServerCoreSessionConsoleAuthority } from './session-console-authority';
import type { ServerCoreSessionCreateCapabilities } from './session-create-capabilities';
import type { ServerCoreSessionNameService } from './session-name-service';
import type { ServerCoreSpawnGuardLease } from './mcp-spawn-guard';

export interface FeishuPreferenceWriteArgs {
  requestId: string;
  purpose: FeishuPreferencePurpose;
  preference: Partial<FeishuModelPreference>;
  expectedSettingsRevision: number;
}
export interface FeishuWorkManagementPort {
  create(callerId: string, args: FeishuWorkCreateArgs): Promise<FeishuWorkCreateResult>;
  rename(callerId: string, args: SessionNameUpdateParams & { requestId: string }): SessionNameUpdateResult;
  updatePreferences(callerId: string, args: FeishuPreferenceWriteArgs): Promise<FeishuPreferencesResult>;
}
type Metadata = Pick<ServerCoreRuntimeMetadataStore, 'claimMutation' | 'releaseMutationClaim' |
  'completeMutation' | 'commitFeishuWorkCreate' | 'appendChange' | 'subscribe'>;

export class ServerCoreFeishuWorkManagement implements FeishuWorkManagementPort {
  constructor(private readonly options: {
    assistants: FeishuAssistantAuthority;
    sessions: { get(id: string): SessionRecord | null; setTitle(id: string, title: string): void };
    preferences: ServerCoreFeishuPreferenceService;
    names: ServerCoreSessionNameService;
    metadata: Metadata;
    authority: Pick<ServerCoreSessionConsoleAuthority, 'createSpawnSession'>;
    capabilities: Pick<ServerCoreSessionCreateCapabilities, 'describe'>;
    reserve(caller: SessionRecord): ServerCoreSpawnGuardLease;
    rollback(adapterId: string, sessionId: string): Promise<void>;
  }) {}

  private scope(callerId: string, requestId: string) {
    this.options.assistants.caller(callerId);
    return { connectionScope: `feishu-assistant:${callerId}`, accessSurface: 'feishu' as const,
      idempotencyKey: parseFeishuRequestId(requestId) };
  }

  rename(callerId: string, args: SessionNameUpdateParams & { requestId: string }): SessionNameUpdateResult {
    const scope = this.scope(callerId, args.requestId);
    this.options.assistants.work(callerId, args.sessionId);
    return this.options.names.update({ sessionId: args.sessionId, title: args.title, expectedTitle: args.expectedTitle }, scope);
  }

  async updatePreferences(callerId: string, args: FeishuPreferenceWriteArgs): Promise<FeishuPreferencesResult> {
    const scope = this.scope(callerId, args.requestId);
    if (!['conversation', 'session'].includes(args.purpose)) throw new Error('Choose conversation or session defaults');
    const patch = parseFeishuPreferencePatch(args.preference);
    const identity = { ...scope, method: 'feishu.preferences.patch', requestFingerprint: createHash('sha256')
      .update(JSON.stringify({ purpose: args.purpose, patch, expectedSettingsRevision: args.expectedSettingsRevision })).digest('hex') };
    const claim = this.options.metadata.claimMutation(identity);
    if (claim.state === 'completed') return parseFeishuPreferencesResult(claim.result);
    if (claim.state !== 'claimed') throw new DaemonRequestError(AgentDeckClientErrorCode.Conflict,
      'Preference update requires reconciliation; read get_feishu_preferences before another request');
    let writing = false;
    try {
      const current = this.options.preferences.read();
      const preference = mergeFeishuModelPreference(current[args.purpose], patch);
      writing = true;
      const result = await this.options.preferences.update({ purpose: args.purpose, preference,
        expectedSettingsRevision: args.expectedSettingsRevision }, { ...scope, idempotencyKey: `saved-choice:${args.requestId}` },
        undefined, () => { this.options.assistants.caller(callerId); });
      this.options.metadata.completeMutation(identity, result as unknown as JsonValue, result.revision);
      return result;
    } catch (error) {
      if (!writing) this.options.metadata.releaseMutationClaim(identity);
      throw error;
    }
  }

  async create(callerId: string, input: FeishuWorkCreateArgs): Promise<FeishuWorkCreateResult> {
    const args = parseFeishuWorkCreateArgs(input);
    const scope = this.scope(callerId, args.requestId);
    const identity = { ...scope, method: 'feishu.work.create',
      requestFingerprint: createHash('sha256').update(JSON.stringify(args)).digest('hex') };
    const claim = this.options.metadata.claimMutation(identity);
    if (claim.state === 'completed') return parseFeishuWorkCreateResult(claim.result);
    if (claim.state !== 'claimed') throw new DaemonRequestError(
      claim.state === 'conflict' ? AgentDeckClientErrorCode.Conflict : AgentDeckClientErrorCode.ProviderLost,
      'Work creation must be reconciled with list_work_sessions before another request; do not create a new requestId',
    );
    let lease: ServerCoreSpawnGuardLease | undefined;
    let targetId: string | null = null;
    let adapterId: string | null = null;
    let registered = false;
    let failedRegistration = false;
    const event = { assistantSessionId: callerId, requestId: args.requestId };
    const releaseEvents = this.options.metadata.subscribe(change => {
      if (change.kind === 'session.renamed' && isJsonObject(change.payload) &&
        change.payload.fromId === targetId && typeof change.payload.toId === 'string') targetId = change.payload.toId;
    });
    try {
      const current = this.options.preferences.read();
      const preference = mergeFeishuModelPreference(current.session, args.selection);
      if (!preference.adapterId) throw new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest, 'Choose work defaults with /settings session before creation');
      adapterId = preference.adapterId;
      const caps = await this.options.capabilities.describe({ adapterId: preference.adapterId,
        provider: preference.provider, workingDirectory: args.workingDirectory });
      validateFeishuPreferenceChoices(preference, caps);
      let settingsRevision = current.settingsRevision;
      if (Object.keys(args.selection).length) {
        const saved = await this.options.preferences.update({ purpose: 'session', preference,
          expectedSettingsRevision: args.expectedSettingsRevision }, { ...scope, idempotencyKey: `work-choice:${args.requestId}` },
          undefined, () => { this.options.assistants.caller(callerId); });
        settingsRevision = saved.settingsRevision;
      } else if (settingsRevision !== args.expectedSettingsRevision) {
        throw new DaemonRequestError(AgentDeckClientErrorCode.Conflict, 'Work defaults changed; read get_feishu_preferences before creating');
      }
      if (this.options.preferences.read().settingsRevision !== settingsRevision) {
        throw new DaemonRequestError(AgentDeckClientErrorCode.Conflict, 'Work defaults changed during preparation; refresh before creating');
      }
      lease = this.options.reserve(this.options.assistants.caller(callerId));
      const options = Object.fromEntries(SESSION_CONSOLE_CREATE_OPTION_KEYS.map(key =>
        [key, caps.create.options[key].defaultValue])) as unknown as SessionConsoleCreateOptions;
      for (const key of FEISHU_PREFERENCE_OPTION_KEYS) if (preference[key]) options[key] = preference[key]!;
      const created = await this.options.authority.createSpawnSession({
        params: { adapterId: preference.adapterId, options, attachments: [],
          capabilityRevision: caps.capabilityRevision, workingDirectory: args.workingDirectory,
          initialMessage: args.initialMessage, projectTrust: { revision: caps.projectTrust.revision, grant: false } },
        initialSessionRegistration: {
          spawnLink: { parentSessionId: callerId, depth: lease.parentDepth + 1 },
          onRegistered: id => {
            if (registered) throw new Error('Provider registered multiple work targets');
            const record = this.options.sessions.get(id);
            if (!record || record.spawnedBy !== callerId) throw new Error('Work target has no authenticated creation edge');
            targetId = id; registered = true;
            this.options.assistants.caller(callerId);
            this.options.sessions.setTitle(id, args.title);
            lease?.release();
            this.options.metadata.appendChange('feishu.work.registered', id, event);
          },
        },
      });
      if (!targetId || targetId !== created.sessionId || this.options.sessions.get(targetId)?.spawnedBy !== callerId) {
        throw new Error('Provider work target did not resolve to its registered canonical session');
      }
      this.options.assistants.caller(callerId);
      return this.options.metadata.commitFeishuWorkCreate(identity, {
        sessionId: targetId, title: this.options.sessions.get(targetId)!.title,
        preference, settingsRevision,
      }, event);
    } catch (error) {
      if (targetId) {
        try {
          await this.options.rollback(adapterId!, targetId);
          this.options.metadata.appendChange('feishu.work.failed', targetId, event);
        } catch { failedRegistration = true; }
      }
      if (failedRegistration) throw new DaemonRequestError(AgentDeckClientErrorCode.ProviderLost,
        'Work startup/rollback is uncertain; inspect list_work_sessions and do not create another requestId');
      this.options.metadata.releaseMutationClaim(identity);
      throw error;
    } finally { releaseEvents(); lease?.release(); }
  }
}
