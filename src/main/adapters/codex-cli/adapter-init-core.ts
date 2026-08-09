import type { CodexBridgeOptions } from './sdk-bridge/types';

export interface CodexInitializableBridge {
  setCodexCliPath(path: string | null): void;
}

export interface CodexAdapterInitHost<T extends CodexInitializableBridge> {
  recoveryContinuationHost: CodexBridgeOptions['recoveryContinuationHost'];
  runtimeHost: CodexBridgeOptions['runtimeHost'];
  createBridge(options: CodexBridgeOptions): T;
  readCodexCliPath(): string | null;
  readPermissionTimeoutMs(): number;
}

/** Construct and configure the Codex bridge without discovering desktop settings. */
export function createCodexAdapterBridgeWithHost<T extends CodexInitializableBridge>(
  host: CodexAdapterInitHost<T>,
  emit: CodexBridgeOptions['emit'],
  hookServer: CodexBridgeOptions['hookServer'],
): T {
  const bridge = host.createBridge({
    emit,
    hookServer,
    recoveryContinuationHost: host.recoveryContinuationHost,
    runtimeHost: host.runtimeHost,
    permissionTimeoutMs: host.readPermissionTimeoutMs(),
  });
  bridge.setCodexCliPath(host.readCodexCliPath());
  return bridge;
}
