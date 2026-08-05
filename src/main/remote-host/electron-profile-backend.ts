import Store from 'electron-store';

import type { RemoteHostProfileDocument } from './profile-document';
import type { RemoteHostProfileBackend } from './profile-store';

interface StoreShape {
  document?: RemoteHostProfileDocument;
}

export function createElectronRemoteHostProfileBackend(): RemoteHostProfileBackend {
  const store = new Store<StoreShape>({ name: 'remote-host-profiles' });
  return {
    read: () => store.get('document'),
    write: (document) => store.set('document', structuredClone(document)),
  };
}
