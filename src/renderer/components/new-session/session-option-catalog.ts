import type {
  SessionConsoleCapabilitiesResult,
  SessionConsoleCreateOptionKey,
} from '@contracts/index';

export interface LocalSessionOptionAvailability {
  canSetPermissionMode: boolean;
  canSetSessionMode: boolean;
  hasSessionModes: boolean;
}

interface SessionOptionPresentation {
  key: SessionConsoleCreateOptionKey;
  label: string;
}

export const SESSION_OPTION_CATALOG: readonly SessionOptionPresentation[] = Object.freeze([
  { key: 'permissionMode', label: '权限模式' },
  { key: 'sessionMode', label: '工作模式' },
  { key: 'approvalPolicy', label: '审批策略' },
  { key: 'claudeCodeSandbox', label: '系统沙盒' },
  { key: 'codexSandbox', label: '沙盒' },
  { key: 'grokSandbox', label: 'Grok Build 沙盒（请求档位）' },
]);

const SANDBOX_KEYS = new Set<SessionConsoleCreateOptionKey>([
  'claudeCodeSandbox',
  'codexSandbox',
  'grokSandbox',
]);

export function sessionOptionLabel(key: SessionConsoleCreateOptionKey): string {
  const entry = SESSION_OPTION_CATALOG.find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`Missing new-session option presentation for ${key}`);
  return entry.label;
}

export function localSessionOptionKeys(
  adapterId: string,
  availability: LocalSessionOptionAvailability,
): SessionConsoleCreateOptionKey[] {
  return SESSION_OPTION_CATALOG.flatMap(({ key }) => {
    if (key === 'permissionMode') return availability.canSetPermissionMode ? [key] : [];
    if (key === 'sessionMode') {
      return availability.canSetSessionMode && availability.hasSessionModes ? [key] : [];
    }
    if (key === 'approvalPolicy') return adapterId === 'codex-cli' ? [key] : [];
    if (key === 'claudeCodeSandbox') return adapterId === 'claude-code' ? [key] : [];
    if (key === 'codexSandbox') return adapterId === 'codex-cli' ? [key] : [];
    return adapterId === 'grok-build' ? [key] : [];
  });
}

export function remoteSessionOptionKeys(
  descriptor: SessionConsoleCapabilitiesResult | null,
): SessionConsoleCreateOptionKey[] {
  if (!descriptor) return [];
  const adapterId = descriptor.create.adapterId;
  return SESSION_OPTION_CATALOG.flatMap(({ key }) => {
    if (SANDBOX_KEYS.has(key)) {
      return descriptor.create.sandbox.optionKey === key ? [key] : [];
    }
    if (key === 'permissionMode') return adapterId === 'claude-code' ? [key] : [];
    if (key === 'approvalPolicy') return adapterId === 'codex-cli' ? [key] : [];
    if (key === 'sessionMode') return adapterId === 'grok-build' ? [key] : [];
    return [];
  });
}
