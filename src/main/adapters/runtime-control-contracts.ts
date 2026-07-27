import type { SessionAdapterId } from '@shared/types';
import { getAdapterRuntimeProfile } from './runtime-profiles';

export const ADAPTER_TARGET_RUNTIME_FIELDS = [
  'provider',
  'model',
  'thinking',
  'permissionMode',
  'sessionMode',
  'codexSandbox',
  'claudeCodeSandbox',
  'extraAllowWrite',
] as const;

export type AdapterTargetRuntimeField =
  (typeof ADAPTER_TARGET_RUNTIME_FIELDS)[number];

export type AdapterTargetRuntimeInput = Partial<
  Record<AdapterTargetRuntimeField, unknown>
>;

/**
 * One adapter-owned contract for every user-facing session-creation surface.
 *
 * The generic options builder remains a defensive narrowing layer, but CLI, IPC, MCP, and
 * hand-off validation use this contract so an incompatible control is rejected rather than
 * silently filtered.
 */
export function targetRuntimeFieldsForAdapter(
  adapterId: SessionAdapterId,
): readonly AdapterTargetRuntimeField[] {
  const profile = getAdapterRuntimeProfile(adapterId);
  const fields: AdapterTargetRuntimeField[] = [];
  if (profile.runtimeControls.providerOverride !== 'none') fields.push('provider');
  if (profile.capabilities.canSetSessionModelOptions) fields.push('model', 'thinking');
  if (profile.capabilities.canSetPermissionMode) fields.push('permissionMode');
  if (profile.capabilities.canSetSessionMode) fields.push('sessionMode');
  if (profile.runtimeControls.sandbox === 'codex') fields.push('codexSandbox');
  if (profile.runtimeControls.sandbox === 'claude') fields.push('claudeCodeSandbox');
  if (profile.runtimeControls.extraAllowWrite) fields.push('extraAllowWrite');
  return fields;
}

export function targetRuntimeFieldAdapters(
  field: AdapterTargetRuntimeField,
): readonly SessionAdapterId[] {
  const adapters: SessionAdapterId[] = [
    'claude-code',
    'codex-cli',
    'grok-build',
  ];
  return adapters.filter((adapter) =>
    targetRuntimeFieldsForAdapter(adapter).includes(field),
  );
}

export function firstUnsupportedTargetRuntimeField(
  adapterId: SessionAdapterId,
  input: AdapterTargetRuntimeInput,
): AdapterTargetRuntimeField | null {
  const supported = new Set(targetRuntimeFieldsForAdapter(adapterId));
  for (const field of ADAPTER_TARGET_RUNTIME_FIELDS) {
    if (input[field] !== undefined && !supported.has(field)) return field;
  }
  return null;
}

export function unsupportedTargetRuntimeFieldMessage(
  adapterId: SessionAdapterId,
  field: AdapterTargetRuntimeField,
): string {
  const owners = targetRuntimeFieldAdapters(field);
  const ownerText = owners.length > 0 ? owners.join(' or ') : 'no adapter';
  return `${field} is incompatible with adapter "${adapterId}"; it is supported by ${ownerText}`;
}
