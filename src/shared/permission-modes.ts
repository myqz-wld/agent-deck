import type { PermissionMode, SessionRecord } from './types/session';

/** The two permission presets offered consistently by Agent Deck's session controls. */
export const SESSION_PERMISSION_MODES = ['auto', 'bypassPermissions'] as const;
export type SessionPermissionMode = (typeof SESSION_PERMISSION_MODES)[number];

export function isSessionPermissionMode(value: unknown): value is SessionPermissionMode {
  return value === 'auto' || value === 'bypassPermissions';
}

export function requireSessionPermissionMode(value: PermissionMode): SessionPermissionMode {
  if (!isSessionPermissionMode(value)) {
    throw new Error('权限模式仅支持自动审批或不再询问。');
  }
  return value;
}

/** Native legacy settings are not silently represented as automatic review. */
export function storedSessionPermissionMode(
  session: Pick<SessionRecord, 'agentId' | 'permissionMode' | 'codexApprovalPolicy'>,
): SessionPermissionMode | null {
  if (session.agentId === 'codex-cli') {
    if (session.codexApprovalPolicy === 'never') return 'bypassPermissions';
    // Before shared presets this column belonged to Claude. A contradictory legacy value must
    // not replace Codex's persisted native policy. New Codex presets persist the matching pair.
    return session.permissionMode === 'auto' && session.codexApprovalPolicy === 'on-request'
      ? 'auto' : null;
  }
  if (isSessionPermissionMode(session.permissionMode)) return session.permissionMode;
  return null;
}

export function codexPermissionPreset(mode: SessionPermissionMode): {
  approvalPolicy: 'on-request' | 'never';
  approvalsReviewer: 'auto_review' | 'user';
} {
  return mode === 'auto'
    ? { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' }
    : { approvalPolicy: 'never', approvalsReviewer: 'user' };
}

export function grokPermissionPreset(mode: SessionPermissionMode): {
  autoMode: boolean;
  yoloMode: boolean;
} {
  return { autoMode: mode === 'auto', yoloMode: mode === 'bypassPermissions' };
}
