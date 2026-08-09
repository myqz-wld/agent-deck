import type { JsonObject, JsonValue } from '@contracts/json';

export interface ClockPort {
  now(): number;
}

export interface IdPort {
  createId(scope: string): string;
}

export interface CorePaths {
  stateDirectory: string;
  logDirectory: string;
  configurationDirectory: string;
  workspaceRoots: readonly string[];
}

export interface CorePathsPort {
  getPaths(): CorePaths;
}

export interface CoreSettingsPort<Settings extends JsonObject = JsonObject> {
  read(): Settings;
  update(patch: Partial<Settings>): Settings;
}

export interface CoreLifecyclePort {
  requestShutdown(reason: string): void;
  onShutdown(listener: (reason: string) => Promise<void> | void): () => void;
}

export interface CoreEventPort {
  publish(kind: string, entityId: string | null, payload: JsonValue): Promise<number>;
}

/** Host-owned facilities required by the application Core, with no UI or transport dependency. */
export interface CoreHostPorts<Settings extends JsonObject = JsonObject> {
  clock: ClockPort;
  ids: IdPort;
  paths: CorePathsPort;
  settings: CoreSettingsPort<Settings>;
  lifecycle: CoreLifecyclePort;
  events: CoreEventPort;
}
