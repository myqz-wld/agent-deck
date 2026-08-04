import type { JsonObject } from '@contracts/index';
import { FeishuGatewayError } from './errors';

const RUNTIME_FIELDS = {
  'claude-code': new Set(['permissionMode', 'claudeCodeSandbox']),
  'codex-cli': new Set(['approvalPolicy', 'codexSandbox']),
  'grok-build': new Set(['sessionMode', 'grokSandbox']),
} as const;

const STRING_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  permissionMode: new Set(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']),
  claudeCodeSandbox: new Set(['off', 'workspace-write', 'strict']),
  approvalPolicy: new Set(['untrusted', 'on-request', 'never']),
  codexSandbox: new Set(['workspace-write', 'read-only', 'danger-full-access']),
  sessionMode: new Set(['default', 'plan', 'ask']),
};

function assertRuntimeValue(field: string, value: unknown): void {
  if (field === 'grokSandbox') {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value !== value.trim() ||
      new TextEncoder().encode(value).byteLength > 128 ||
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)
    ) {
      throw new FeishuGatewayError(
        'invalid_command',
        'grokSandbox must be a bounded control-free profile name',
      );
    }
    return;
  }
  if (typeof value !== 'string' || !STRING_VALUES[field]?.has(value)) {
    throw new FeishuGatewayError(
      'invalid_command',
      `${field} has an unsupported runtime value`,
    );
  }
}

export function assertAdapterOwnedRuntimePatch(adapterId: string, patch: JsonObject): void {
  const allowed = RUNTIME_FIELDS[adapterId as keyof typeof RUNTIME_FIELDS] as
    | ReadonlySet<string>
    | undefined;
  if (!allowed) {
    throw new FeishuGatewayError(
      'capability_unavailable',
      `adapter ${adapterId} 没有可通过 Feishu 修改的 runtime controls`,
    );
  }
  const fields = Object.keys(patch);
  if (fields.length === 0) {
    throw new FeishuGatewayError('invalid_command', 'runtime patch 不能为空');
  }
  for (const field of fields) {
    if (!allowed.has(field)) {
      throw new FeishuGatewayError(
        'capability_unavailable',
        `${field} 不是 ${adapterId} 拥有的 runtime control`,
      );
    }
    assertRuntimeValue(field, patch[field]);
  }
}

export function runtimeFieldsForAdapter(adapterId: string): readonly string[] {
  const fields = RUNTIME_FIELDS[adapterId as keyof typeof RUNTIME_FIELDS];
  return fields ? [...fields] : [];
}
