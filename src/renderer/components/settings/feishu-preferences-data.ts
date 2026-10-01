import type { FeishuPreferencesResult, SessionConsoleCapabilitiesResult } from '@contracts/index';
import type { RemoteHostMutationAuthorityDto } from '@shared/remote-host';
import { RemoteReadCache } from '@shared/remote-read-cache';

export interface FeishuPreferencesSource {
  identity: string;
  profileId: string | null;
  usable: boolean;
  supportsFeishuPreferences?: boolean;
  expectedAuthority?: RemoteHostMutationAuthorityDto;
}

export interface FeishuPreferencesSnapshot {
  settings: FeishuPreferencesResult;
  capability: SessionConsoleCapabilitiesResult;
}

export const feishuPreferencesCache = new RemoteReadCache<FeishuPreferencesSnapshot>(8);
const saves = new Map<string, Promise<void>>();
export const feishuPreferencesKey = (source: FeishuPreferencesSource): string =>
  JSON.stringify([source.identity, source.profileId, source.expectedAuthority]);

export async function fetchFeishuPreferences(source: FeishuPreferencesSource): Promise<FeishuPreferencesSnapshot> {
  if (!source.usable || !source.profileId || !source.supportsFeishuPreferences || !source.expectedAuthority) {
    throw new Error('Feishu settings source is unavailable');
  }
  const profileId = source.profileId;
  const settings = await window.api.getRemoteHostFeishuPreferences({ profileId });
  const { adapterId, provider } = settings.conversation;
  const capability = await window.api.getRemoteHostSessionCapabilities({ profileId, adapterId, provider, workingDirectory: '.' });
  return { settings, capability };
}

export function readFeishuPreferences(source: FeishuPreferencesSource): Promise<FeishuPreferencesSnapshot> {
  const key = feishuPreferencesKey(source);
  return feishuPreferencesCache.read(key, async () => {
    await saves.get(key);
    return fetchFeishuPreferences(source);
  });
}

export function trackFeishuSave(key: string, task: Promise<void>): void {
  saves.set(key, task);
  const finished = (): void => { if (saves.get(key) === task) saves.delete(key); };
  void task.then(finished, finished);
}
