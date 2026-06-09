import { existsSync } from 'node:fs';

import type { SessionRecord } from '@shared/types';
import type { HandOffSessionDeps } from '../hand-off-session-impl';
import type { HandOffSessionHandlerDeps } from './_deps';
import { fetchCallerSessionRow } from '../_shared/caller-cwd-resolver';

export interface ResolvedForCwd {
  mode: 'session' | 'plan' | 'generic';
  mainRepo: string | null;
  worktreePath: string | null;
  worktreeExists: boolean;
}

export function resolveCallerCwdDeps(
  callerSessionId: string,
  prefetchedRow?: SessionRecord | null,
): { deps: HandOffSessionDeps; warnings: string[] } {
  const { row, warnings } =
    prefetchedRow !== undefined
      ? { row: prefetchedRow, warnings: [] as string[] }
      : fetchCallerSessionRow(callerSessionId, 'hand-off-session');
  return row?.cwd ? { deps: { cwd: () => row.cwd }, warnings } : { deps: {}, warnings };
}

export function mergeCallerCwd(
  callerImplDeps: HandOffSessionDeps | undefined,
  callerSessionId: string,
  prefetchedRow?: SessionRecord | null,
): { deps: HandOffSessionDeps | undefined; warnings: string[] } {
  if (callerImplDeps?.cwd) return { deps: callerImplDeps, warnings: [] };
  const { deps, warnings } = resolveCallerCwdDeps(callerSessionId, prefetchedRow);
  return deps.cwd ? { deps: { ...callerImplDeps, ...deps }, warnings } : { deps: callerImplDeps, warnings };
}

export function resolveCallerSessionCwd(
  callerSessionId: string,
  handlerDeps: HandOffSessionHandlerDeps | undefined,
  prefetchedRow?: SessionRecord | null,
): { callerSessionCwd: string | null; callerSessionRow: SessionRecord | null } {
  const row =
    prefetchedRow !== undefined
      ? prefetchedRow
      : fetchCallerSessionRow(callerSessionId, 'hand-off-session').row;
  const exists = handlerDeps?.cwdExists ?? existsSync;
  const cwd = row?.cwd && exists(row.cwd) ? row.cwd : null;
  return { callerSessionCwd: cwd, callerSessionRow: row };
}

export function resolvePlanModeDefaultCwd(resolved: ResolvedForCwd): string | undefined {
  return resolved.mainRepo ?? resolved.worktreePath ?? undefined;
}

export function validatePlanModeWorktreeExists(): null {
  return null;
}

export function computeExtraAllowWrite(args: {
  extraAllowWrite?: string[];
}): string[] | undefined {
  return args.extraAllowWrite;
}
