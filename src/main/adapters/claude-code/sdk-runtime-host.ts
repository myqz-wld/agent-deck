import { createRequire } from 'node:module';

import type { ClaudeSdkRuntimeHost } from './sdk-runtime-core';

const requireFromHere = createRequire(__filename);

export const desktopClaudeSdkRuntimeHost: ClaudeSdkRuntimeHost = {
  environment: () => process.env,
  executablePath: () => process.execPath,
  platform: () => process.platform,
  architecture: () => process.arch,
  resolveModule: (specifier) => requireFromHere.resolve(specifier),
};
