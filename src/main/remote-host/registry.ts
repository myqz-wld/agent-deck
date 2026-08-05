import { randomUUID } from 'node:crypto';

import { app } from 'electron';

import {
  createElectronHostClientFactory,
  ElectronHostRegistry,
} from '@hosts/electron';

import { RemoteHostCredentialSelections } from './credential-selections';
import { createElectronRemoteHostProfileBackend } from './electron-profile-backend';
import { RemoteHostPublicError } from './errors';
import { RemoteHostProfileStore } from './profile-store';
import { RemoteHostService } from './service';

let service: RemoteHostService | null = null;
let acceptingRequests = true;
let shutdownPromise: Promise<void> | null = null;

export function createProductionRemoteHostService(): RemoteHostService {
  const createId = (): string => randomUUID();
  const store = new RemoteHostProfileStore(
    createElectronRemoteHostProfileBackend(),
    { create: () => createId() },
  );
  const registry = new ElectronHostRegistry({
    appVersion: app.getVersion(),
    createClient: createElectronHostClientFactory({
      createStandalone: () => {
        throw new Error('Standalone continues to use the existing local desktop flows');
      },
    }),
  });
  return new RemoteHostService({
    registry,
    store,
    selections: new RemoteHostCredentialSelections({ createId }),
    createId,
  });
}

export function setRemoteHostService(next: RemoteHostService | null): void {
  service = next;
  acceptingRequests = true;
  shutdownPromise = null;
}

export function getRemoteHostService(): RemoteHostService {
  if (!acceptingRequests) {
    throw new RemoteHostPublicError('service_stopped', '远程主机服务已停止。');
  }
  if (!service) service = createProductionRemoteHostService();
  return service;
}

export function shutdownRemoteHostServiceIfCreated(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  acceptingRequests = false;
  const current = service;
  shutdownPromise = current
    ? Promise.resolve().then(() => current.shutdown())
    : Promise.resolve();
  return shutdownPromise;
}
