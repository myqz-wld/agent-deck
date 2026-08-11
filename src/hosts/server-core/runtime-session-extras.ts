import {
  AgentDeckClientErrorCode,
  SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_BYTES,
  SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_COUNT,
  SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_TOTAL_BYTES,
  SESSION_CONSOLE_REMOTE_ATTACHMENT_MIME_TYPES,
  parseSessionHandOffCommitParams,
  parseSessionHandOffPreviewParams,
  type JsonObject,
  type SessionHandOffPreviewResult,
} from '@contracts/index';
import {
  DaemonRequestError,
  type DaemonRequestInput,
  type DaemonRequestResult,
} from '@hosts/daemon';

import type { ServerCoreDaemonRuntimeOptions } from './runtime-core';
import { ServerCoreHandOffPreviewConflictError } from './mcp-handoff-errors';
import {
  serverCoreHandOffArgs,
  serverCoreHandOffCommitResult,
} from './runtime-handoff';
import { canAcceptServerCoreSessionAttachments } from './session-attachment-capability';
import { parseSessionTargetParams } from './runtime-validation';

export type ServerCoreSessionExtraMutation = (
  input: DaemonRequestInput,
  kind: string,
  entityId: string,
  invoke: () => Promise<(revision: number) => JsonObject>,
) => Promise<DaemonRequestResult>;

/** Capability-gated session reads and the atomic handoff mutation. */
export class ServerCoreSessionExtras {
  constructor(
    private readonly options: ServerCoreDaemonRuntimeOptions,
    private readonly mutate: ServerCoreSessionExtraMutation,
  ) {}

  execute(input: DaemonRequestInput): Promise<DaemonRequestResult> | null {
    switch (input.method) {
      case 'session.context.get': return Promise.resolve(this.contextUsage(input));
      case 'session.input.capabilities': return Promise.resolve(this.inputCapabilities(input));
      case 'session.handoff.preview': return this.handOffPreview(input);
      case 'session.handoff.commit': return this.handOffCommit(input);
      default: return null;
    }
  }

  private contextUsage(input: DaemonRequestInput): DaemonRequestResult {
    const { sessionId } = parseSessionTargetParams(input.params);
    const record = this.requireSession(sessionId);
    const revision = this.options.metadata.currentRevision();
    return {
      result: {
        contextUsage: record.contextUsage ? {
          usedTokens: record.contextUsage.usedTokens,
          windowTokens: record.contextUsage.windowTokens,
          updatedAt: record.contextUsage.updatedAt,
          runtimeIdentity: record.contextUsage.runtimeIdentity
            ? { ...record.contextUsage.runtimeIdentity }
            : null,
        } : null,
        revision,
      },
      revision,
    };
  }

  private inputCapabilities(input: DaemonRequestInput): DaemonRequestResult {
    const { sessionId } = parseSessionTargetParams(input.params);
    const { adapter, record } = this.requireProviderSession(sessionId);
    const enabled = canAcceptServerCoreSessionAttachments(adapter, sessionId);
    const revision = this.options.metadata.currentRevision();
    return {
      result: {
        adapterId: record.agentId,
        activeTurn: {
          mode: record.agentId === 'claude-code'
            ? 'queue'
            : record.agentId === 'codex-cli' ? 'steer' : 'interject',
          attachments: {
            disabledReason: enabled ? null : '当前 Provider 运行时未声明图片输入能力。',
            enabled,
            maxBytesEach: SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_BYTES,
            maxBytesTotal: SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_TOTAL_BYTES,
            maxCount: SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_COUNT,
            mimeTypes: [...SESSION_CONSOLE_REMOTE_ATTACHMENT_MIME_TYPES],
          },
        },
        revision,
      },
      revision,
    };
  }

  private async handOffPreview(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    if (!this.options.handoff) this.unavailable();
    let params;
    try { params = parseSessionHandOffPreviewParams(input.params); }
    catch {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.InvalidRequest,
        'Handoff input is invalid',
      );
    }
    let result: SessionHandOffPreviewResult;
    try {
      result = await this.options.handoff.preview(
        params.sessionId,
        serverCoreHandOffArgs(params),
      );
    } catch (error) {
      this.rethrowHandOffConflict(error);
    }
    return { result: result as unknown as JsonObject, revision: result.revision };
  }

  private async handOffCommit(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    if (!this.options.handoff) this.unavailable();
    let params;
    try { params = parseSessionHandOffCommitParams(input.params); }
    catch {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.InvalidRequest,
        'Handoff input is invalid',
      );
    }
    return this.mutate(input, 'session.handoff.accepted', params.sessionId, async () => {
      let result;
      try {
        result = await this.options.handoff!.handOff(
          params.sessionId,
          serverCoreHandOffArgs(params),
          params.expectedBindingDigest,
        );
      } catch (error) {
        this.rethrowHandOffConflict(error);
      }
      return (revision) => serverCoreHandOffCommitResult(
        result,
        revision,
      ) as unknown as JsonObject;
    });
  }

  private requireSession(sessionId: string) {
    const record = this.options.repository.get(sessionId);
    if (!record) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.NotFound, 'Session was not found');
    }
    return record;
  }

  private requireProviderSession(sessionId: string) {
    const record = this.requireSession(sessionId);
    const adapter = this.options.registry.get(record.agentId);
    if (!adapter) this.unavailable();
    return { adapter, record };
  }

  private unavailable(): never {
    throw new DaemonRequestError(
      AgentDeckClientErrorCode.CapabilityUnavailable,
      'Provider capability is unavailable',
    );
  }

  private rethrowHandOffConflict(error: unknown): never {
    if (error instanceof ServerCoreHandOffPreviewConflictError) {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.Conflict,
        'Handoff preview changed; prepare it again',
      );
    }
    throw error;
  }
}
