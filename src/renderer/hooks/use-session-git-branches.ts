import { useEffect, useRef, useState } from 'react';
import type { SessionRecord } from '@shared/types';

const GIT_BRANCH_REFRESH_MS = 10_000;

interface BranchTarget {
  id: string;
  cwd: string;
}

interface BranchLookupGroup {
  lookupSessionId: string;
  sessionIds: string[];
}

export function useSessionGitBranches(
  sessions: readonly SessionRecord[],
): ReadonlyMap<string, string | null> {
  const targets = sessions.map(({ id, cwd }) => ({ id, cwd: cwd.trim() }));
  const targetKey = targets
    .map(({ id, cwd }) => `${id}\u0000${cwd}`)
    .sort()
    .join('\u0001');
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const [branches, setBranches] = useState<Map<string, string | null>>(
    () => new Map(),
  );

  useEffect(() => {
    let disposed = false;
    let requestSeq = 0;
    const currentTargets = targetsRef.current;
    const groups = groupTargetsByCwd(currentTargets);

    setBranches((previous) => {
      const next = new Map<string, string | null>();
      for (const target of currentTargets) {
        next.set(target.id, previous.get(target.id) ?? null);
      }
      return next;
    });
    if (groups.size === 0) return;

    const refresh = (): void => {
      const seq = ++requestSeq;
      void Promise.all(
        [...groups.values()].map(async ({ lookupSessionId, sessionIds }) => {
          const branch = await window.api
            .getSessionGitBranch(lookupSessionId)
            .catch(() => null);
          return { branch, sessionIds };
        }),
      ).then((results) => {
        if (disposed || seq !== requestSeq) return;
        const next = new Map<string, string | null>(
          currentTargets.map(({ id }) => [id, null] as const),
        );
        for (const { branch, sessionIds } of results) {
          for (const sessionId of sessionIds) next.set(sessionId, branch);
        }
        setBranches(next);
      });
    };

    refresh();
    const timer = window.setInterval(refresh, GIT_BRANCH_REFRESH_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [targetKey]);

  return branches;
}

export function useSessionGitBranch(session: SessionRecord): string | null {
  return useSessionGitBranches([session]).get(session.id) ?? null;
}

function groupTargetsByCwd(
  targets: readonly BranchTarget[],
): Map<string, BranchLookupGroup> {
  const groups = new Map<string, BranchLookupGroup>();
  for (const { id, cwd } of targets) {
    if (!cwd) continue;
    const group = groups.get(cwd);
    if (group) {
      group.sessionIds.push(id);
    } else {
      groups.set(cwd, { lookupSessionId: id, sessionIds: [id] });
    }
  }
  return groups;
}
