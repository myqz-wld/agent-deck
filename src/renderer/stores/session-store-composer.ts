import type { UploadedAttachmentEntry } from '@renderer/hooks/image-attachments/types';

export type ComposerRequestKind = 'send' | 'permission-mode' | 'session-mode';

export interface ComposerRequestState {
  generation: number;
  busy: boolean;
}

export interface ComposerSessionState {
  text: string;
  attachments: UploadedAttachmentEntry[];
  attachmentError: string | null;
  sendError: string | null;
  permissionModeError: string | null;
  sessionModeError: string | null;
  queueRefreshVersion: number;
  attachmentGeneration: number;
  ephemeral: boolean;
  requests: Record<ComposerRequestKind, ComposerRequestState>;
}

export const EMPTY_COMPOSER_REQUEST: ComposerRequestState = {
  generation: 0,
  busy: false,
};

export const EMPTY_COMPOSER_SESSION: ComposerSessionState = {
  text: '',
  attachments: [],
  attachmentError: null,
  sendError: null,
  permissionModeError: null,
  sessionModeError: null,
  queueRefreshVersion: 0,
  attachmentGeneration: 0,
  ephemeral: false,
  requests: {
    send: EMPTY_COMPOSER_REQUEST,
    'permission-mode': EMPTY_COMPOSER_REQUEST,
    'session-mode': EMPTY_COMPOSER_REQUEST,
  },
};

export function createComposerSession(ephemeral = false): ComposerSessionState {
  return {
    ...EMPTY_COMPOSER_SESSION,
    ephemeral,
    requests: {
      send: { ...EMPTY_COMPOSER_REQUEST },
      'permission-mode': { ...EMPTY_COMPOSER_REQUEST },
      'session-mode': { ...EMPTY_COMPOSER_REQUEST },
    },
  };
}

export function resolveComposerSessionId(
  aliases: Map<string, string>,
  sessionId: string,
): string {
  let current = sessionId;
  const visited = new Set<string>();
  while (aliases.has(current) && !visited.has(current)) {
    visited.add(current);
    current = aliases.get(current)!;
  }
  return current;
}

export function composerSessionFor(
  composerBySession: Map<string, ComposerSessionState>,
  aliases: Map<string, string>,
  sessionId: string,
): ComposerSessionState {
  return composerBySession.get(resolveComposerSessionId(aliases, sessionId))
    ?? EMPTY_COMPOSER_SESSION;
}

function mergeAttachments(
  target: readonly UploadedAttachmentEntry[],
  source: readonly UploadedAttachmentEntry[],
): UploadedAttachmentEntry[] {
  const seen = new Set(target.map((attachment) => attachment.id));
  return [...target, ...source.filter((attachment) => !seen.has(attachment.id))];
}

function newerRequest(
  target: ComposerRequestState,
  source: ComposerRequestState,
): ComposerRequestState {
  return source.generation > target.generation ? source : target;
}

export function mergeComposerSessions(
  source: ComposerSessionState,
  target: ComposerSessionState | undefined,
): ComposerSessionState {
  if (!target) return { ...source, ephemeral: false };
  return {
    text: target.text.length > 0 ? target.text : source.text,
    attachments: mergeAttachments(target.attachments, source.attachments),
    attachmentError: target.attachmentError ?? source.attachmentError,
    sendError: target.sendError ?? source.sendError,
    permissionModeError: target.permissionModeError ?? source.permissionModeError,
    sessionModeError: target.sessionModeError ?? source.sessionModeError,
    queueRefreshVersion: Math.max(target.queueRefreshVersion, source.queueRefreshVersion),
    attachmentGeneration: Math.max(
      target.attachmentGeneration,
      source.attachmentGeneration,
    ),
    ephemeral: false,
    requests: {
      send: newerRequest(target.requests.send, source.requests.send),
      'permission-mode': newerRequest(
        target.requests['permission-mode'],
        source.requests['permission-mode'],
      ),
      'session-mode': newerRequest(
        target.requests['session-mode'],
        source.requests['session-mode'],
      ),
    },
  };
}

export function moveComposerSession(
  composerBySession: Map<string, ComposerSessionState>,
  aliases: Map<string, string>,
  fromId: string,
  toId: string,
): {
  composerBySession: Map<string, ComposerSessionState>;
  composerAliases: Map<string, string>;
} {
  const fromKey = resolveComposerSessionId(aliases, fromId);
  const toKey = resolveComposerSessionId(aliases, toId);
  const next = new Map(composerBySession);
  if (fromKey !== toKey) {
    const source = next.get(fromKey);
    if (source) {
      next.set(toKey, mergeComposerSessions(source, next.get(toKey)));
      next.delete(fromKey);
    }
  }
  const nextAliases = new Map(aliases);
  nextAliases.set(fromId, toKey);
  for (const [alias, target] of nextAliases) {
    if (target === fromId || target === fromKey) nextAliases.set(alias, toKey);
  }
  return { composerBySession: next, composerAliases: nextAliases };
}

export function pruneComposerSessions(
  composerBySession: Map<string, ComposerSessionState>,
  aliases: Map<string, string>,
  validIds: Set<string>,
): {
  composerBySession: Map<string, ComposerSessionState>;
  composerAliases: Map<string, string>;
  releasedSessionIds: string[];
} {
  const next = new Map<string, ComposerSessionState>();
  const releasedSessionIds: string[] = [];
  for (const [sessionId, composer] of composerBySession) {
    if (composer.ephemeral || validIds.has(sessionId)) next.set(sessionId, composer);
    else releasedSessionIds.push(sessionId);
  }
  const nextAliases = new Map<string, string>();
  for (const [from, to] of aliases) {
    const resolved = resolveComposerSessionId(aliases, to);
    if (validIds.has(resolved) && next.has(resolved)) nextAliases.set(from, resolved);
  }
  return {
    composerBySession: next,
    composerAliases: nextAliases,
    releasedSessionIds,
  };
}

export function removeComposerSession(
  composerBySession: Map<string, ComposerSessionState>,
  aliases: Map<string, string>,
  sessionId: string,
): {
  composerBySession: Map<string, ComposerSessionState>;
  composerAliases: Map<string, string>;
  resolvedId: string;
} {
  const resolvedId = resolveComposerSessionId(aliases, sessionId);
  const next = new Map(composerBySession);
  next.delete(resolvedId);
  const nextAliases = new Map(aliases);
  for (const [from, to] of nextAliases) {
    if (
      from === sessionId
      || from === resolvedId
      || resolveComposerSessionId(aliases, to) === resolvedId
    ) {
      nextAliases.delete(from);
    }
  }
  return { composerBySession: next, composerAliases: nextAliases, resolvedId };
}

export function mergeRecoveredAttachments(
  recovered: readonly UploadedAttachmentEntry[],
  current: readonly UploadedAttachmentEntry[],
): UploadedAttachmentEntry[] {
  const seen = new Set(recovered.map((attachment) => attachment.id));
  return [...recovered, ...current.filter((attachment) => !seen.has(attachment.id))];
}
