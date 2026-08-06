export { CodexCliAdapter } from './adapter-core';
export type {
  CodexCliAdapterHost,
  CodexHookIntegration,
} from './adapter-core';

import { CodexCliAdapter } from './adapter-core';
import { desktopCodexCliAdapterHost } from './adapter-init-host';

export const codexCliAdapter: CodexCliAdapter = new CodexCliAdapter(
  desktopCodexCliAdapterHost,
);
