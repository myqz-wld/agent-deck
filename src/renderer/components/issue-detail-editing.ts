/**
 * Pure IssueDetail edit-buffer logic.
 *
 * `editing` is the user-visible draft. `baseline` is the latest known server
 * snapshot used only to decide which fields remain local drafts during a
 * rebase. Submission compares `editing` with the current Issue record so an
 * intentional change back to an older value is still persisted.
 */

import type { IssueRecord, IssueSeverity, IssueStatus } from '@shared/types';

export type EditingState = {
  title: string;
  description: string;
  repro: string;
  kind: string;
  status: IssueStatus;
  severity: IssueSeverity;
  labels: string; // comma-joined
};

/** Complete field list shared by draft comparison and rebasing. */
export const FIELD_KEYS = [
  'title',
  'description',
  'repro',
  'kind',
  'status',
  'severity',
  'labels',
] as const satisfies readonly (keyof EditingState)[];

export type FieldKey = (typeof FIELD_KEYS)[number];

/** Converts a record to the canonical editor representation. */
export function toEditing(rec: IssueRecord): EditingState {
  return {
    title: rec.title,
    description: rec.description,
    repro: rec.repro ?? '',
    kind: rec.kind,
    status: rec.status,
    severity: rec.severity,
    labels: rec.labels.join(', '),
  };
}

/** Normalizes the comma-separated labels used by the editor. */
export function parseLabels(labels: string): string[] {
  return labels
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Compares one field after applying its editor normalization. */
export function fieldEquals(key: FieldKey, a: EditingState, b: EditingState): boolean {
  if (key === 'labels') {
    return JSON.stringify(parseLabels(a.labels)) === JSON.stringify(parseLabels(b.labels));
  }
  return a[key] === b[key];
}

/** Returns whether any normalized field differs from the latest baseline. */
export function hasDraft(editing: EditingState, baseline: EditingState): boolean {
  return FIELD_KEYS.some((k) => !fieldEquals(k, editing, baseline));
}

/**
 * Mirrors the IPC/repository input limits so invalid drafts remain editable
 * without starting a request.
 */
export function validateEditing(editing: EditingState): string | null {
  if (!editing.title.trim()) return '标题不能为空';
  if (!editing.description.trim()) return '描述不能为空';
  if (!editing.kind.trim()) return '类型不能为空';
  const labels = parseLabels(editing.labels);
  if (labels.length > 16) return '标签最多 16 个';
  if (labels.some((l) => l.length > 64)) return '单个标签最长 64 字符';
  return null;
}

/** Editable subset accepted by issuesUpdate. */
export interface IssueUpdatePatch {
  title?: string;
  description?: string;
  repro?: string | null;
  kind?: string;
  status?: IssueStatus;
  severity?: IssueSeverity;
  labels?: string[];
}

/**
 * Builds a minimal patch against the current server record. The expected id
 * is a final guard against submitting a stale record after selection changes.
 */
export function buildUpdatePatch(
  editing: EditingState,
  issue: IssueRecord,
  expectedIssueId: string,
): IssueUpdatePatch {
  if (issue.id !== expectedIssueId) return {};
  const canonical = toEditing(issue);
  const patch: IssueUpdatePatch = {};
  if (!fieldEquals('title', editing, canonical)) patch.title = editing.title;
  if (!fieldEquals('description', editing, canonical)) patch.description = editing.description;
  if (!fieldEquals('repro', editing, canonical)) patch.repro = editing.repro || null;
  if (!fieldEquals('kind', editing, canonical)) patch.kind = editing.kind;
  if (!fieldEquals('status', editing, canonical)) patch.status = editing.status;
  if (!fieldEquals('severity', editing, canonical)) patch.severity = editing.severity;
  if (!fieldEquals('labels', editing, canonical)) patch.labels = parseLabels(editing.labels);
  return patch;
}

/**
 * Advances the baseline to the latest record. Fields changed relative to the
 * previous baseline retain their draft; untouched fields adopt the new value.
 */
export function rebaseEditingState(
  prev: EditingState | null,
  prevBaseline: EditingState | null,
  latest: IssueRecord,
): { editing: EditingState; baseline: EditingState } {
  const canonical = toEditing(latest);
  if (!prev || !prevBaseline) return { editing: canonical, baseline: canonical };
  const baseline = canonical;
  const editing = { ...canonical };
  for (const k of FIELD_KEYS) {
    if (!fieldEquals(k, prev, prevBaseline)) {
      (editing[k] as EditingState[FieldKey]) = prev[k];
    }
  }
  return { editing, baseline };
}
