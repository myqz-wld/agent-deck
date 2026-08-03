import type { Database } from 'better-sqlite3';
import type {
  ContextRuntimeIdentityResolution,
  ResolvedContextCapacity,
} from '@shared/types';
import {
  createContextWindowObservationRepo,
  type ContextWindowObservationRepo,
  type ObserveContextWindowInput,
  type ObserveContextWindowResult,
} from '@main/store/context-window-observation-repo';
import { getDb } from '@main/store/db';
import { resolveContextCapacity } from './policy';

export interface ContextWindowCapacityService {
  observe(input: ObserveContextWindowInput): ObserveContextWindowResult;
  resolve(identity: ContextRuntimeIdentityResolution, at?: number): ResolvedContextCapacity;
}

export function createContextWindowCapacityService(
  db: Database,
  options: {
    now?: () => number;
    repo?: ContextWindowObservationRepo;
  } = {},
): ContextWindowCapacityService {
  const repo = options.repo ?? createContextWindowObservationRepo(db);
  const now = options.now ?? Date.now;
  return {
    observe: (input) => repo.observe(input),
    resolve(identity, at = now()) {
      const observation = identity.status === 'concrete' ? repo.get(identity.identity) : null;
      return resolveContextCapacity(identity, observation, at);
    },
  };
}

export function getContextWindowCapacityService(): ContextWindowCapacityService {
  return createContextWindowCapacityService(getDb());
}
