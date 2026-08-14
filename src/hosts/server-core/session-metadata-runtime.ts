import {
  AgentDeckClientErrorCode,
  SESSION_MESSAGES_MAX_BODY_BYTES,
  isCoreMethodGranted,
  parseSessionMessagesListParams,
  parseSessionMessagesListResult,
  type CoreMethod,
  type JsonValue,
  type SessionMessageDto,
} from '@contracts/index';
import {
  DaemonRequestError,
  type DaemonCoreRuntime,
  type DaemonEventSubscriptionInput,
  type DaemonRequestInput,
  type DaemonRequestResult,
} from '@hosts/daemon';
import type { AgentDeckMessageRepo } from '@main/store/agent-deck-message-repo';
import type { SessionRecord } from '@shared/types';

import { redactRemoteSensitiveText } from './remote-sensitive-data';

export const SERVER_CORE_SESSION_METADATA_METHODS = Object.freeze([
  'session.messages.list',
] as const satisfies readonly CoreMethod[]);

type MetadataMethod = (typeof SERVER_CORE_SESSION_METADATA_METHODS)[number];
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;

export interface ServerCoreSessionMetadataRuntimeOptions {
  readonly sessions: { get(sessionId: string): SessionRecord | null };
  readonly messages: Pick<AgentDeckMessageRepo, 'listBySession'>;
  readonly currentRevision: () => number;
}

function isMetadataMethod(method: CoreMethod): method is MetadataMethod {
  return (SERVER_CORE_SESSION_METADATA_METHODS as readonly CoreMethod[]).includes(method);
}

function truncateUtf8(value: string, maximum: number): string {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength <= maximum) return value;
  const marker = '…';
  let cut = Math.max(0, maximum - Buffer.byteLength(marker));
  while (cut > 0 && (encoded[cut] & 0xc0) === 0x80) cut -= 1;
  return `${encoded.subarray(0, cut).toString('utf8')}${marker}`;
}

function publicText(value: string, maximum: number): string {
  const projected = redactRemoteSensitiveText(value, () => 'Workspace')
    .replace(CONTROL, ' ')
    .trim();
  return truncateUtf8(projected, maximum);
}

function requireSession(
  sessions: ServerCoreSessionMetadataRuntimeOptions['sessions'],
  sessionId: string,
): SessionRecord {
  const record = sessions.get(sessionId);
  if (!record) {
    throw new DaemonRequestError(AgentDeckClientErrorCode.NotFound, 'Session not found');
  }
  return record;
}

/** Path-free projection for the session detail Cross-session tab. */
export class ServerCoreSessionMetadataRuntime implements DaemonCoreRuntime {
  readonly supportedMethods: readonly CoreMethod[];
  readonly subscribe?: DaemonCoreRuntime['subscribe'];

  constructor(
    private readonly base: DaemonCoreRuntime,
    private readonly options: ServerCoreSessionMetadataRuntimeOptions,
  ) {
    this.supportedMethods = Object.freeze([
      ...new Set([...base.supportedMethods, ...SERVER_CORE_SESSION_METADATA_METHODS]),
    ]);
    if (base.subscribe) {
      const subscribe = base.subscribe.bind(base);
      this.subscribe = (input: DaemonEventSubscriptionInput) => subscribe(input);
    }
  }

  start(): Promise<void> { return this.base.start(); }
  stop(reason: string): Promise<void> { return this.base.stop(reason); }
  currentRevision(access: DaemonRequestInput['access']): Promise<number> | number {
    return this.base.currentRevision(access);
  }

  execute(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    if (!isMetadataMethod(input.method)) return this.base.execute(input);
    if (!isCoreMethodGranted(input.access, input.method)) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.AccessDenied, 'Request rejected');
    }
    if (input.signal.aborted) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.Cancelled, 'Request was cancelled');
    }
    return Promise.resolve(this.messages(input));
  }

  private messages(input: DaemonRequestInput): DaemonRequestResult {
    const params = parseSessionMessagesListParams(input.params);
    requireSession(this.options.sessions, params.sessionId);
    const rows = this.options.messages.listBySession(params.sessionId, {
      limit: params.limit + 1,
    });
    const messages: SessionMessageDto[] = rows.slice(0, params.limit).map((message) => ({
      id: message.id,
      teamId: message.teamId,
      fromSessionId: message.fromSessionId,
      fromTitle: publicText(
        this.options.sessions.get(message.fromSessionId)?.title ?? '另一会话',
        512,
      ) || '另一会话',
      toSessionId: message.toSessionId,
      toTitle: publicText(
        this.options.sessions.get(message.toSessionId)?.title ?? '另一会话',
        512,
      ) || '另一会话',
      body: publicText(message.body, SESSION_MESSAGES_MAX_BODY_BYTES),
      status: message.status,
      statusReason: message.statusReason ? publicText(message.statusReason, 512) : null,
      sentAt: message.sentAt,
      deliveredAt: message.deliveredAt,
      replyToMessageId: message.replyToMessageId,
    }));
    const revision = this.options.currentRevision();
    const result = parseSessionMessagesListResult({
      sessionId: params.sessionId,
      messages,
      truncated: rows.length > params.limit,
      revision,
    }, params.sessionId, params.limit);
    return { result: result as unknown as JsonValue, revision };
  }
}
