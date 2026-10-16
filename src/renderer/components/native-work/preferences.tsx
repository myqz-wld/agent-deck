import { createContext, useContext, useState, useSyncExternalStore, type ReactNode, type SetStateAction } from 'react';
import type { AgentEvent } from '@shared/types';

export interface Preferences { order: string[]; hidden: string[]; expanded: string[]; disclosure: Record<string, boolean> }
const empty = (): Preferences => ({ order: [], hidden: [], expanded: [], disclosure: {} });
const prefix = 'agent-deck:native-work-ui:v1:';
const cache = new Map<string, Preferences>();
const listeners = new Set<() => void>();
export const DisclosureScope = createContext('');
export const DisclosureScopeProvider = ({ scope, children }: { scope: string; children: ReactNode }) =>
  <DisclosureScope.Provider value={scope}>{children}</DisclosureScope.Provider>;
function read(scope: string): Preferences {
  const existing = cache.get(scope); if (existing) return existing;
  let result = empty();
  try {
    const raw = JSON.parse(localStorage.getItem(prefix + scope) ?? 'null');
    if (raw && typeof raw === 'object') {
      const ids = (value: unknown) => Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length <= 2048).slice(-2000) : [];
      result = { order: ids(raw.order), hidden: ids(raw.hidden), expanded: ids(raw.expanded),
        disclosure: Object.fromEntries(Object.entries(raw.disclosure ?? {}).filter(([key, value]) => key.length < 2048 && typeof value === 'boolean').slice(-2000)) as Record<string, boolean> };
    }
  } catch { /* Invalid/unavailable local preferences do not block the conversation. */ }
  cache.set(scope, result); return result;
}
export function updateNativeWorkPreferences(scope: string, update: (previous: Preferences) => Preferences): void {
  if (!scope) return;
  const result = update(read(scope));
  result.order = result.order.slice(-2000); result.hidden = result.hidden.slice(-2000); result.expanded = result.expanded.slice(-2000);
  result.disclosure = Object.fromEntries(Object.entries(result.disclosure).slice(-2000));
  cache.set(scope, result);
  try {
    const saved = JSON.parse(localStorage.getItem(prefix + 'scopes') ?? '[]');
    const scopes = [...(Array.isArray(saved) ? saved.filter(id => typeof id === 'string' && id !== scope) : []), scope];
    for (const old of scopes.slice(0, -128)) { localStorage.removeItem(prefix + old); cache.delete(old); }
    localStorage.setItem(prefix + 'scopes', JSON.stringify(scopes.slice(-128)));
    localStorage.setItem(prefix + scope, JSON.stringify(result));
  } catch { /* Memory remains usable if storage is full. */ }
  listeners.forEach(listener => listener());
}
export function clearNativeWorkPreferences(scope: string): void {
  cache.delete(scope); try { localStorage.removeItem(prefix + scope); } catch { /* Best effort. */ }
  listeners.forEach(listener => listener());
}
export function useNativeWorkPreferences(scope: string) {
  const preferences = useSyncExternalStore(callback => { listeners.add(callback); return () => listeners.delete(callback); }, () => read(scope));
  return [preferences, (update: (previous: Preferences) => Preferences) => updateNativeWorkPreferences(scope, update)] as const;
}
export function useRememberedDisclosure(key: string, fallback = false) {
  const scope = useContext(DisclosureScope);
  const [preferences, update] = useNativeWorkPreferences(scope);
  const [local, setLocal] = useState(fallback);
  const value = scope ? preferences.disclosure[key] ?? fallback : local;
  const setValue = (next: SetStateAction<boolean>) => {
    if (!scope) { setLocal(next); return; }
    update(previous => ({ ...previous, disclosure: { ...previous.disclosure,
      [key]: typeof next === 'function' ? next(previous.disclosure[key] ?? fallback) : next } }));
  };
  return [value, setValue] as const;
}
/** No content hashes: progressive text must not change a disclosure's identity. */
export function disclosureEventKey(event: AgentEvent, field: string): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const nativeId = payload.toolUseId ?? payload.messageId ?? payload.displayMessageId ?? payload.uuid ?? payload.planId;
  const storedId = (event as AgentEvent & { id?: number }).id;
  return JSON.stringify([event.sessionId, event.agentId, event.kind,
    typeof nativeId === 'string' ? nativeId : storedId ? `event:${storedId}` : event.ts, payload.role ?? '', field]);
}
export function useEventDisclosure(event: AgentEvent, field: string, fallback = false) {
  return useRememberedDisclosure(disclosureEventKey(event, field), fallback);
}
