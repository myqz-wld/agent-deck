import { parse } from '@iarna/toml';
import type { SessionPermissionMode } from './permission-modes';

/** Read only the permission default, leaving credentials and model configuration untouched. */
export function readGrokPermissionModeDefault(content: string | null): SessionPermissionMode {
  if (!content) return 'auto';
  try {
    const ui = parse(content).ui;
    if (!ui || typeof ui !== 'object' || Array.isArray(ui) || ui instanceof Date) return 'auto';
    const mode = ui.permission_mode ?? ui.approval_mode;
    return mode === 'always-approve' || mode === 'bypassPermissions' ||
      (mode === undefined && ui.yolo === true) ? 'bypassPermissions' : 'auto';
  } catch { return 'auto'; }
}

/** Read native Grok defaults without interpreting custom endpoints or credentials. */
export function readGrokModelDefaults(content: string | null): {
  model: string | null;
  thinking: string | null;
} {
  const result = { model: null, thinking: null };
  if (!content) return result;
  try {
    const models = parse(content).models;
    if (!models || typeof models !== 'object' || Array.isArray(models) || models instanceof Date) {
      return result;
    }
    const text = (value: unknown): string | null =>
      typeof value === 'string' && value.trim() ? value.trim() : null;
    return { model: text(models.default), thinking: text(models.default_reasoning_effort) };
  } catch {
    return result;
  }
}
