export { GrokBuildAdapter } from './adapter-core';
export type {
  GrokBuildAdapterHost,
  GrokHookIntegration,
} from './adapter-core';

import { GrokBuildAdapter } from './adapter-core';
import { desktopGrokBuildAdapterHost } from './adapter-host';

export const grokBuildAdapter = new GrokBuildAdapter(
  desktopGrokBuildAdapterHost,
);
