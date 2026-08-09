export * from './registry-core';

import { AdapterRegistryClass } from './registry-core';
import { DesktopAdapterRegistryDiagnostics } from './registry-diagnostics';

export function createDesktopAdapterRegistry(): AdapterRegistryClass {
  return new AdapterRegistryClass(new DesktopAdapterRegistryDiagnostics());
}

export const adapterRegistry = createDesktopAdapterRegistry();
