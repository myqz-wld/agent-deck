import {
  NOOP_GROK_BRIDGE_RUNTIME_HOST,
  type GrokBridgeRuntimeHost,
  type GrokBridgeSessionRecordPort,
} from '../bridge-runtime-core';

interface TestGrokBridgeRuntimeHostOverrides {
  diagnostics?: GrokBridgeRuntimeHost['diagnostics'];
  liveRate?: GrokBridgeRuntimeHost['liveRate'];
  records?: Partial<GrokBridgeSessionRecordPort>;
  transaction?: GrokBridgeRuntimeHost['transaction'];
  publishSessionUpdated?: GrokBridgeRuntimeHost['publishSessionUpdated'];
  guardHandOffSourceIngress?: GrokBridgeRuntimeHost['guardHandOffSourceIngress'];
  hasPendingWorktreeTransition?: GrokBridgeRuntimeHost['hasPendingWorktreeTransition'];
}

export function createTestGrokBridgeRuntimeHost(
  overrides: TestGrokBridgeRuntimeHostOverrides = {},
): GrokBridgeRuntimeHost {
  return {
    diagnostics:
      overrides.diagnostics ?? NOOP_GROK_BRIDGE_RUNTIME_HOST.diagnostics,
    liveRate: overrides.liveRate ?? NOOP_GROK_BRIDGE_RUNTIME_HOST.liveRate,
    records: {
      ...NOOP_GROK_BRIDGE_RUNTIME_HOST.records,
      ...overrides.records,
    },
    transaction:
      overrides.transaction ?? NOOP_GROK_BRIDGE_RUNTIME_HOST.transaction,
    publishSessionUpdated:
      overrides.publishSessionUpdated ??
      NOOP_GROK_BRIDGE_RUNTIME_HOST.publishSessionUpdated,
    guardHandOffSourceIngress:
      overrides.guardHandOffSourceIngress ??
      NOOP_GROK_BRIDGE_RUNTIME_HOST.guardHandOffSourceIngress,
    hasPendingWorktreeTransition:
      overrides.hasPendingWorktreeTransition ??
      NOOP_GROK_BRIDGE_RUNTIME_HOST.hasPendingWorktreeTransition,
  };
}

export const testGrokBridgeRuntimeHost = createTestGrokBridgeRuntimeHost();
