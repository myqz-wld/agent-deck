import { IpcInvoke } from '@shared/ipc-channels';
import type {
  ProviderUsageProviderId,
  ProviderUsageSnapshot,
  ProviderUsageSnapshotResult,
} from '@shared/types';
import { adapterRegistry } from '@main/adapters/registry';
import { errorUsageSnapshot, unavailableUsageSnapshot } from '@main/adapters/provider-usage';
import { on } from './_helpers';

const PROVIDER_ORDER: ReadonlyArray<ProviderUsageProviderId> = [
  'claude-code',
  'codex-cli',
  'deepseek-claude-code',
];

const PROVIDER_LABELS: Record<ProviderUsageProviderId, string> = {
  'claude-code': 'Claude',
  'codex-cli': 'Codex',
  'deepseek-claude-code': 'Deepseek',
};

export async function providerUsageSnapshotHandler(): Promise<ProviderUsageSnapshotResult> {
  const snapshots = await Promise.all(PROVIDER_ORDER.map(readAdapterSnapshot));
  return { snapshots };
}

export function registerProviderUsageIpc(): void {
  on(IpcInvoke.ProviderUsageSnapshot, () => providerUsageSnapshotHandler());
}

async function readAdapterSnapshot(
  provider: ProviderUsageProviderId,
): Promise<ProviderUsageSnapshot> {
  const label = PROVIDER_LABELS[provider];
  const adapter = adapterRegistry.get(provider);
  if (!adapter) {
    return unavailableUsageSnapshot(provider, label, `${label} adapter 尚未注册`);
  }
  if (!adapter.getUsageSnapshot) {
    return unavailableUsageSnapshot(provider, label, `${label} 暂无用量读取入口`);
  }
  try {
    return await adapter.getUsageSnapshot();
  } catch (err) {
    return errorUsageSnapshot(provider, label, err);
  }
}
