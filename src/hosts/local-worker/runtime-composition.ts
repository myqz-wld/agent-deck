import { resolveDaemonInstancePaths } from '@hosts/daemon';
import { createServerCoreRuntimeWithOverrides } from '@hosts/server-core/runtime-composition';

import { createLocalWorkerDaemonFrameChannels } from './daemon-frame-channels';
import type {
  LocalWorkerRuntimeBootstrap,
  LocalWorkerRuntimeFactoryInput,
} from './headless-root';

function runtimeDirectory(): string {
  if (process.env.XDG_RUNTIME_DIR) return process.env.XDG_RUNTIME_DIR;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!Number.isSafeInteger(uid) || (uid as number) <= 0) {
    throw new Error('Local Worker requires a positive Linux runtime uid');
  }
  return `/run/user/${uid}`;
}

/** Concrete Electron-free Worker runtime backed by the same authoritative Core as Full mode. */
export function createLocalWorkerRuntime(
  input: LocalWorkerRuntimeFactoryInput,
): LocalWorkerRuntimeBootstrap {
  const sandbox = input.workspaceSandbox;
  const paths = resolveDaemonInstancePaths(input.instanceId, {
    HOME: sandbox?.environment.coreStateRoot ?? process.env.HOME,
    XDG_CONFIG_HOME: sandbox?.environment.coreConfigRoot ?? process.env.XDG_CONFIG_HOME,
    XDG_RUNTIME_DIR: sandbox?.environment.coreRuntimeRoot ?? runtimeDirectory(),
    XDG_STATE_HOME: sandbox?.environment.coreStateRoot ?? process.env.XDG_STATE_HOME,
  }, { controlSocket: 'unused' });
  const bootstrap = createServerCoreRuntimeWithOverrides({
    instanceId: input.instanceId,
    appVersion: input.appVersion,
    paths,
    runtimeOptions: input.runtimeOptions,
  }, {
    ...(sandbox ? { workspaceRoot: sandbox.workspaceRoot } : {}),
    ...(sandbox ? { workspaceSandbox: sandbox } : {}),
  });
  return Object.freeze({
    runtime: bootstrap.runtime,
    sessionConsoleAuthority: bootstrap.sessionConsoleAuthority,
    components: bootstrap.components,
    createFrameChannels: (channelInput) => {
      if (
        channelInput.instanceId !== input.instanceId ||
        channelInput.appVersion !== input.appVersion
      ) {
        throw new Error('Local Worker channel factory identity mismatch');
      }
      return createLocalWorkerDaemonFrameChannels({
        instanceId: input.instanceId,
        appVersion: input.appVersion,
        authoritativeCoreId: bootstrap.processId,
        runtime: channelInput.runtime,
        getWorkerGeneration: channelInput.getWorkerGeneration,
      });
    },
  });
}
