import type {
  AgentEvent,
  HandOffMetadata,
  UploadedAttachmentRef,
} from '@shared/types';
import {
  HAND_OFF_ADOPT_HEADER,
  HAND_OFF_SPAWN_HEADER,
} from '@shared/hand-off-headers';
import { parseWirePrefix } from '@shared/wire-prefix';
import type {
  ContentMetadata,
  MessageContentPayload,
} from '@renderer/components/expandable-content';
import { formatDisplayText } from '../format';
import type { RenderMode } from '../shared';

const HAND_OFF_HEADERS = [HAND_OFF_SPAWN_HEADER, HAND_OFF_ADOPT_HEADER] as const;
const HAND_OFF_SEPARATOR = '\n---\n\n';

type HandOffMarkerKind = 'spawn' | 'adopt';

export interface NormalizedAgentMessage {
  role: 'user' | 'assistant';
  text: string;
  isUser: boolean;
  isError: boolean;
  attachments: readonly UploadedAttachmentRef[];
  wireFrom?: string;
  wireAdapter?: string;
  wireMessageId?: string;
  wireSenderSessionId?: string;
  handOffLabel: string | null;
  handOffTooltip: string | null;
  handOffContext: string | null;
  handOffDisclosureSummary: string;
  handOffSourceSessionId?: string;
  handOffSourceEventId?: number | null;
}

export function productName(agentId: string): string {
  if (agentId === 'codex-cli') return 'Codex CLI';
  if (agentId === 'grok-build') return 'Grok Build';
  return 'Claude Code';
}

export function normalizeAgentMessage(event: AgentEvent): NormalizedAgentMessage {
  const payload = event.payload && typeof event.payload === 'object'
    ? event.payload as Record<string, unknown>
    : {};
  const role = payload.role === 'user' ? 'user' : 'assistant';
  const rawText = formatDisplayText(payload.text);
  const wire = role === 'user' ? parseWirePrefix(rawText) : null;
  const wireBody = (wire?.body ?? rawText).trim();
  const handOff = role === 'user'
    ? parseHandOffContext(wireBody)
    : { context: null, body: wireBody, kind: null };
  const metadata = role === 'user' ? handOffMetadata(payload.handOff) : undefined;
  const attachments = role === 'user' && Array.isArray(payload.attachments)
    ? payload.attachments.filter(isUploadedAttachment)
    : [];
  const handOffLabel = metadata
    ? '接力 · 会话'
    : handOff.context && handOff.kind
      ? handOff.kind === 'spawn' ? '上下文 · 派遣' : '接力 · 接管'
      : null;

  return {
    role,
    text: handOff.body,
    isUser: role === 'user',
    isError: payload.error === true,
    attachments,
    wireFrom: wire?.from,
    wireAdapter: wire ? productName(wire.adapter) : undefined,
    wireMessageId: wire?.msgId,
    wireSenderSessionId: wire?.senderSessionId,
    handOffLabel,
    handOffTooltip: metadata ? '会话接力 · 来源会话' : null,
    handOffContext: handOff.context,
    handOffDisclosureSummary: handOff.kind === 'adopt'
      ? '会话接力：接管的团队和协作者（点开查看详情）'
      : '上下文：负责人提供的说明（点开查看详情）',
    handOffSourceSessionId: metadata?.fromCallerSid,
    handOffSourceEventId: metadata?.sourceMaxEventId,
  };
}

export function createMessageContentPayload(
  message: NormalizedAgentMessage,
  mode: RenderMode,
  extraMetadata: ContentMetadata = {},
): MessageContentPayload {
  return {
    kind: 'message',
    text: message.text,
    attachments: message.attachments.map((attachment, index) => ({
      id: `attachment-${index + 1}`,
      name: `附件图片 ${index + 1}`,
      mediaType: attachment.mime,
      size: attachment.bytes,
    })),
    metadata: {
      ...extraMetadata,
      role: message.role,
      renderMode: mode,
      error: message.isError,
      ...(message.wireFrom ? { wireFrom: message.wireFrom } : {}),
      ...(message.wireAdapter ? { wireAdapter: message.wireAdapter } : {}),
      ...(message.wireMessageId ? { wireMessageId: message.wireMessageId } : {}),
      ...(message.wireSenderSessionId
        ? { wireSenderSessionId: message.wireSenderSessionId }
        : {}),
      ...(message.handOffLabel ? { handOff: message.handOffLabel } : {}),
      ...(message.handOffSourceSessionId
        ? { handOffSourceSessionId: message.handOffSourceSessionId }
        : {}),
      ...(message.handOffSourceEventId == null
        ? {}
        : { handOffSourceEventId: message.handOffSourceEventId }),
    },
  };
}

function parseHandOffContext(body: string): {
  context: string | null;
  body: string;
  kind: HandOffMarkerKind | null;
} {
  for (let index = 0; index < HAND_OFF_HEADERS.length; index += 1) {
    const header = HAND_OFF_HEADERS[index]!;
    if (!body.startsWith(header)) continue;
    const separatorIndex = body.indexOf(HAND_OFF_SEPARATOR);
    if (separatorIndex < 0) continue;
    return {
      context: body.slice(0, separatorIndex),
      body: body.slice(separatorIndex + HAND_OFF_SEPARATOR.length),
      kind: index === 0 ? 'spawn' : 'adopt',
    };
  }
  return { context: null, body, kind: null };
}

function handOffMetadata(value: unknown): HandOffMetadata | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const metadata = value as Partial<HandOffMetadata>;
  if (metadata.mode !== 'session' || typeof metadata.fromCallerSid !== 'string') {
    return undefined;
  }
  return {
    mode: 'session',
    fromCallerSid: metadata.fromCallerSid,
    ...(typeof metadata.sourceMaxEventId === 'number' || metadata.sourceMaxEventId === null
      ? { sourceMaxEventId: metadata.sourceMaxEventId }
      : {}),
  };
}

function isUploadedAttachment(value: unknown): value is UploadedAttachmentRef {
  if (!value || typeof value !== 'object') return false;
  const attachment = value as Partial<UploadedAttachmentRef>;
  return attachment.kind === 'uploaded'
    && typeof attachment.path === 'string'
    && typeof attachment.mime === 'string'
    && typeof attachment.bytes === 'number';
}
