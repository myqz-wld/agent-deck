import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  ISSUE_REMOTE_MAX_APPENDICES,
  type IssueAppendixDto,
  type IssueDto,
  type IssueLogsRefDto,
} from '@contracts/index';
import type { IssueAppendix, IssueRecord, LogsRef } from '@shared/types';

export interface ServerCoreIssueProjectionOptions {
  readonly workspaceRoot: string;
  readonly privateRoots: readonly string[];
}

interface ProjectionState {
  readonly workspaceRoot: string;
  readonly privateRoots: readonly string[];
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function state(options: ServerCoreIssueProjectionOptions): ProjectionState {
  const workspaceRoot = resolve(options.workspaceRoot);
  return {
    workspaceRoot,
    privateRoots: options.privateRoots.map((root) => resolve(root))
      .filter((root) => root !== workspaceRoot)
      .sort((left, right) => right.length - left.length),
  };
}

function text(value: string, projection: ProjectionState): string {
  let output = value;
  for (const root of projection.privateRoots) output = output.split(root).join('[private]');
  return output.split(projection.workspaceRoot).join('Workspace');
}

function cwd(value: string | null, projection: ProjectionState): string | null {
  if (value === null) return null;
  const target = resolve(value);
  if (!inside(projection.workspaceRoot, target)) return null;
  const suffix = relative(projection.workspaceRoot, target).split(sep).join('/');
  return suffix || '.';
}

function logs(value: LogsRef | null, projection: ProjectionState): IssueLogsRefDto | null {
  if (!value) return null;
  return {
    date: value.date,
    ...(value.tsRange ? { tsRange: { ...value.tsRange } } : {}),
    ...(value.scopes ? { scopes: value.scopes.map((item) => text(item, projection)) } : {}),
    ...(value.note ? { note: text(value.note, projection) } : {}),
  };
}

function appendix(value: IssueAppendix, projection: ProjectionState): IssueAppendixDto {
  return {
    id: value.id,
    issueId: value.issueId,
    body: text(value.body, projection),
    logsRef: logs(value.logsRef, projection),
    appendedSessionId: value.appendedSessionId,
    appendedAt: value.appendedAt,
  };
}

/** Projects one Core-owned issue without publishing host-private absolute paths. */
export function projectServerCoreIssue(
  record: IssueRecord,
  appendices: readonly IssueAppendix[],
  options: ServerCoreIssueProjectionOptions,
): IssueDto {
  const projection = state(options);
  const projectedAppendices = appendices.slice(0, ISSUE_REMOTE_MAX_APPENDICES)
    .map((item) => appendix(item, projection));
  return {
    id: record.id,
    title: text(record.title, projection),
    description: text(record.description, projection),
    repro: record.repro === null ? null : text(record.repro, projection),
    kind: text(record.kind, projection),
    status: record.status,
    severity: record.severity,
    sourceSessionId: record.sourceSessionId,
    cwd: cwd(record.cwd, projection),
    branchName: record.branchName === null ? null : text(record.branchName, projection),
    logsRef: logs(record.logsRef, projection),
    resolutionSessionId: record.resolutionSessionId,
    labels: record.labels.map((item) => text(item, projection)),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    resolvedAt: record.resolvedAt,
    deletedAt: record.deletedAt,
    appendices: projectedAppendices,
    appendicesTruncated: appendices.length > projectedAppendices.length,
  };
}
