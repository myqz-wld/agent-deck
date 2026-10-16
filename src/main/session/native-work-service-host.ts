import { adapterRegistry } from '@main/adapters/registry';
import { sessionRepo } from '@main/store/session-repo';
import { getDb } from '@main/store/db';
import { createNativeWorkRepo } from '@main/store/native-work-repo';
import { createNativeWorkService } from './native-work-service-core';
const service = createNativeWorkService({ session: id => sessionRepo.get(id), adapter: id => adapterRegistry.get(id),
  repository: { list: (id, options) => createNativeWorkRepo(getDb()).list(id, options),
    details: input => createNativeWorkRepo(getDb()).details(input) } });
export const getNativeWorkService = () => service;
