export interface BrowserRuntimeLifecyclePort {
  renameSession(fromId: string, toId: string): number;
  revokeSession(sessionId: string): number;
}

let port: BrowserRuntimeLifecyclePort | null = null;

export function setBrowserRuntimeLifecyclePort(value: BrowserRuntimeLifecyclePort | null): void {
  port = value;
}

export function renameBrowserRuntimeOwner(fromId: string, toId: string): number {
  return port?.renameSession(fromId, toId) ?? 0;
}

export function revokeBrowserRuntimeOwner(sessionId: string): number {
  return port?.revokeSession(sessionId) ?? 0;
}
