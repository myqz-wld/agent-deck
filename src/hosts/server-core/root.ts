import {
  AgentDeckCompositionController,
  SessionConsoleDaemonRuntime,
  createServerCoreComposition,
  type LifecycleComponent,
} from '@composition/index';
import type { AuthoritativeSessionConsolePort } from '@core/session-console';
import {
  DaemonHost,
  DaemonSshBridgeListener,
  UnixSocketDaemonListener,
  resolveDaemonInstancePaths,
  type DaemonCoreRuntime,
  type DaemonCredentialLifecyclePort,
  type DaemonInstancePaths,
} from '@hosts/daemon';
import {
  loadTrustedRuntimeModule,
  requireModuleFactory,
} from '@hosts/linux-runtime/runtime-module';
import type { ServerCoreConfig } from './config';

export interface ServerCoreRuntimeFactoryInput {
  readonly instanceId: string;
  readonly appVersion: string;
  readonly paths: DaemonInstancePaths;
  readonly runtimeOptions: ServerCoreConfig['runtimeOptions'];
}

export interface ServerCoreRuntimeBootstrap {
  readonly processId: string;
  readonly runtime: DaemonCoreRuntime;
  readonly sessionConsoleAuthority: AuthoritativeSessionConsolePort;
  readonly credentialLifecycle: DaemonCredentialLifecyclePort;
  readonly components?: readonly LifecycleComponent[];
}

export interface ServerCoreRootOptions {
  readonly paths?: DaemonInstancePaths;
  readonly loadModule?: typeof loadTrustedRuntimeModule;
  readonly sqlitePreflight?: () => unknown | Promise<unknown>;
}

function assertBootstrap(value: unknown): ServerCoreRuntimeBootstrap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('server-core runtime bootstrap is invalid');
  }
  const result = value as Partial<ServerCoreRuntimeBootstrap>;
  if (
    !result.runtime ||
    typeof result.runtime.start !== 'function' ||
    typeof result.runtime.stop !== 'function' ||
    typeof result.runtime.execute !== 'function' ||
    typeof result.runtime.currentRevision !== 'function' ||
    !Array.isArray(result.runtime.supportedMethods) ||
    !result.sessionConsoleAuthority ||
    typeof result.processId !== 'string' ||
    !result.processId ||
    Buffer.byteLength(result.processId) > 128 ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(result.processId) ||
    !result.credentialLifecycle ||
    typeof result.credentialLifecycle.isActive !== 'function' ||
    typeof result.credentialLifecycle.subscribeRevocations !== 'function'
  ) {
    throw new Error('server-core runtime bootstrap is incomplete');
  }
  if (result.components && !Array.isArray(result.components)) {
    throw new Error('server-core components must be an array');
  }
  return result as ServerCoreRuntimeBootstrap;
}

export async function createServerCoreController(
  config: ServerCoreConfig,
  options: ServerCoreRootOptions = {},
): Promise<AgentDeckCompositionController> {
  const paths = options.paths ?? resolveDaemonInstancePaths(config.instanceId);
  if (paths.instanceId !== config.instanceId || paths.socketPath !== config.socketPath) {
    throw new Error('server-core config does not match its exact instance namespace');
  }
  const module = await (options.loadModule ?? loadTrustedRuntimeModule)(config.runtimeModule);
  const factory = requireModuleFactory<ServerCoreRuntimeFactoryInput>(
    module,
    'createServerCoreRuntime',
  );
  const bootstrap = assertBootstrap(await factory({
    instanceId: config.instanceId,
    appVersion: config.appVersion,
    paths,
    runtimeOptions: config.runtimeOptions,
  }));
  const runtime = new SessionConsoleDaemonRuntime(
    bootstrap.runtime,
    bootstrap.sessionConsoleAuthority,
  );
  const host = new DaemonHost({
    paths,
    appVersion: config.appVersion,
    runtime,
    credentialLifecycle: bootstrap.credentialLifecycle,
    authoritativeCoreId: bootstrap.processId,
    listener: null,
    sqlitePreflight: options.sqlitePreflight,
  });
  const sshBridge = new DaemonSshBridgeListener({
    instanceId: config.instanceId,
    host,
    listener: new UnixSocketDaemonListener(config.socketPath, paths.runtimeDirectory),
    authorize: async (admission) => {
      await host.assertCredentialActive(admission.credentialId, admission.surface);
      return true;
    },
  });
  return new AgentDeckCompositionController(
    createServerCoreComposition({
      host,
      sshBridge,
      beforeIngress: Object.freeze([...(bootstrap.components ?? [])]),
    }),
  );
}
