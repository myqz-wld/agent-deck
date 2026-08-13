import type { JsonValue } from '@contracts/index';
import type { ElectronHostEvent, ElectronHostRegistry } from '@hosts/electron';
import type { RemoteHostSessionRenameDto } from '@shared/remote-host';

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export function parseRemoteSessionRename(
  payload: JsonValue,
): { fromId: string; toId: string } | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const valid = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 256 && !CONTROL.test(value);
  return valid(payload.fromId) && valid(payload.toId)
    ? { fromId: payload.fromId, toId: payload.toId }
    : null;
}

function sourceIdentity(profileId: string, coreId: string, generation: number | null): string {
  return `${profileId.length}:${profileId}|${coreId.length}:${coreId}|${generation ?? ''}`;
}

function resolve(aliases: ReadonlyMap<string, string> | undefined, sessionId: string): string {
  if (!aliases) return sessionId;
  let current = sessionId;
  const visited = new Set<string>();
  while (!visited.has(current) && visited.size < 32) {
    visited.add(current);
    const next = aliases.get(current);
    if (!next) break;
    current = next;
  }
  return current;
}

/** Handles both rename-before-create-response and create-response-before-rename ordering. */
export class RemoteHostSessionRenameTracker {
  private readonly aliasesBySource = new Map<string, Map<string, string>>();

  handle(
    registry: ElectronHostRegistry,
    event: ElectronHostEvent,
  ): RemoteHostSessionRenameDto | null {
    if (event.kind !== 'session.renamed') return null;
    const value = parseRemoteSessionRename(event.payload);
    const state = registry.state(event.profileId);
    if (!value || !state.authoritativeCoreId) return null;
    const key = sourceIdentity(
      event.profileId,
      state.authoritativeCoreId,
      state.workerGeneration,
    );
    const aliases = this.aliasesBySource.get(key) ?? new Map<string, string>();
    aliases.delete(value.fromId);
    aliases.set(value.fromId, resolve(aliases, value.toId));
    while (aliases.size > 256) aliases.delete(aliases.keys().next().value as string);
    this.aliasesBySource.delete(key);
    this.aliasesBySource.set(key, aliases);
    while (this.aliasesBySource.size > 32) {
      this.aliasesBySource.delete(this.aliasesBySource.keys().next().value as string);
    }
    const selectedSessionId = registry.navigation(event.profileId).selectedSessionId;
    if (selectedSessionId) this.select(registry, event.profileId, selectedSessionId);
    return {
      ...value,
      authoritativeCoreId: state.authoritativeCoreId,
      workerGeneration: state.workerGeneration,
    };
  }

  selectCreated<T extends { sessionId: string }>(
    registry: ElectronHostRegistry,
    profileId: string,
    result: T,
  ): T {
    const sessionId = this.select(registry, profileId, result.sessionId);
    return sessionId === result.sessionId ? result : { ...result, sessionId };
  }

  private select(
    registry: ElectronHostRegistry,
    profileId: string,
    sessionId: string,
  ): string {
    const state = registry.state(profileId);
    const key = state.authoritativeCoreId
      ? sourceIdentity(profileId, state.authoritativeCoreId, state.workerGeneration)
      : null;
    const resolved = resolve(key ? this.aliasesBySource.get(key) : undefined, sessionId);
    if (registry.navigation(profileId).selectedSessionId !== resolved) {
      registry.updateNavigation(profileId, { selectedSessionId: resolved });
    }
    return resolved;
  }
}
