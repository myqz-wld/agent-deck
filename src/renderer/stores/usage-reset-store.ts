import { create } from 'zustand';

export interface UsageResetState {
  phase: 'idle' | 'confirming' | 'running';
  idempotencyKey: string | null;
  error: string | null;
  message: string | null;
}

export const EMPTY_USAGE_RESET: UsageResetState = {
  phase: 'idle', idempotencyKey: null, error: null, message: null,
};

/** Unresolved attempts survive tab/view changes so retry cannot redeem a second credit. */
export const useUsageResetStore = create<{ entries: Record<string, UsageResetState> }>(() => ({
  entries: {},
}));

export function updateUsageReset(key: string, patch: Partial<UsageResetState>): void {
  useUsageResetStore.setState((state) => ({
    entries: { ...state.entries, [key]: { ...(state.entries[key] ?? EMPTY_USAGE_RESET), ...patch } },
  }));
}
