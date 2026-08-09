import { app } from 'electron';

import { installApplicationHostPaths } from '@main/runtime-host/application-paths';

// Electron derives default userData/log locations from the application name. Preserve the
// established dev/prod identity before reading any host-owned path.
app.setName('Agent Deck');

installApplicationHostPaths({
  isPackaged: app.isPackaged,
  appPath: app.getAppPath(),
  resourcesPath: process.resourcesPath,
  userDataPath: app.getPath('userData'),
});
