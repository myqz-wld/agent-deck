import {
  AgentDeckCompositionController,
  SessionConsoleDaemonRuntime,
  createLocalWorkerComposition,
  type LifecycleComponent,
} from '@composition/index';
import type { AuthoritativeSessionConsolePort } from '@core/session-console';
import type { DaemonCoreRuntime } from '@hosts/daemon';
import { preflightNodeNativeSqlite } from '@hosts/daemon';
import { AtomicPrivateStateFile } from '@hosts/linux-runtime/atomic-state-file';
import {
  loadTrustedRuntimeModule,
  requireModuleFactory,
} from '@hosts/linux-runtime/runtime-module';

import { WorkerAttachmentController } from './attachment';
import type { CoreFrameChannelFactory } from './attachment-types';
import type { LocalWorkerHeadlessConfig } from './headless-config';
import { LocalWorkerGenerationStore } from './generation-store';
import { OpenSshWorkerConnector } from './openssh-connector';

export interface LocalWorkerChannelFactoryInput {
  readonly instanceId: string;
  readonly appVersion: string;
  readonly runtime: DaemonCoreRuntime;
  readonly runtimeOptions: LocalWorkerHeadlessConfig['runtimeOptions'];
  readonly getWorkerGeneration: () => number;
}

export interface LocalWorkerRuntimeFactoryInput {
  readonly instanceId: string;
  readonly appVersion: string;
  readonly runtimeOptions: LocalWorkerHeadlessConfig['runtimeOptions'];
}

export interface LocalWorkerRuntimeBootstrap {
  readonly runtime: DaemonCoreRuntime;
  readonly sessionConsoleAuthority: AuthoritativeSessionConsolePort;
  readonly createFrameChannels: (
    input: LocalWorkerChannelFactoryInput,
  ) => CoreFrameChannelFactory;
  readonly components?: readonly LifecycleComponent[];
}

export interface LocalWorkerRootOptions {
  readonly loadModule?: typeof loadTrustedRuntimeModule;
  readonly connector?: OpenSshWorkerConnector;
  readonly sqlitePreflight?: () => unknown | Promise<unknown>;
}

function bootstrap(value: unknown): LocalWorkerRuntimeBootstrap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('local-worker runtime bootstrap is invalid');
  }
  const result = value as Partial<LocalWorkerRuntimeBootstrap>;
  if (
    !result.runtime ||
    typeof result.runtime.start !== 'function' ||
    typeof result.runtime.stop !== 'function' ||
    typeof result.runtime.execute !== 'function' ||
    typeof result.runtime.currentRevision !== 'function' ||
    !Array.isArray(result.runtime.supportedMethods) ||
    !result.sessionConsoleAuthority ||
    typeof result.createFrameChannels !== 'function' ||
    (result.components !== undefined && !Array.isArray(result.components))
  ) {
    throw new Error('local-worker runtime bootstrap is incomplete');
  }
  return result as LocalWorkerRuntimeBootstrap;
}

export async function createLocalWorkerController(
  config: LocalWorkerHeadlessConfig,
  options: LocalWorkerRootOptions = {},
): Promise<AgentDeckCompositionController> {
  const generationStore = new LocalWorkerGenerationStore(
    new AtomicPrivateStateFile(config.generationFile, 4_096),
    config.instanceId,
    config.ssh.workerId,
  );
  const initialGeneration = await generationStore.load();
  const module = await (options.loadModule ?? loadTrustedRuntimeModule)(config.runtimeModule);
  const factory = requireModuleFactory<LocalWorkerRuntimeFactoryInput>(
    module,
    'createLocalWorkerRuntime',
  );
  const created = bootstrap(await factory({
    instanceId: config.instanceId,
    appVersion: config.appVersion,
    runtimeOptions: config.runtimeOptions,
  }));
  const runtime = new SessionConsoleDaemonRuntime(
    created.runtime,
    created.sessionConsoleAuthority,
  );
  let generation = initialGeneration;
  const channels = created.createFrameChannels({
    instanceId: config.instanceId,
    appVersion: config.appVersion,
    runtime,
    runtimeOptions: config.runtimeOptions,
    getWorkerGeneration: () => {
      if (generation === null) throw new Error('Worker generation is not established');
      return generation;
    },
  });
  const core: LifecycleComponent = {
    name: 'local-worker-core',
    start: async () => {
      await (options.sqlitePreflight ?? preflightNodeNativeSqlite)();
      await runtime.start();
    },
    stop: (reason) => runtime.stop(reason),
  };
  const generationComponent: LifecycleComponent = {
    name: 'local-worker-generation-state',
    start: () => generationStore.start(),
    stop: () => generationStore.stop(),
  };
  const worker = new WorkerAttachmentController(
    config.ssh,
    options.connector ?? new OpenSshWorkerConnector(),
    channels,
    {
      initialGeneration,
      onGeneration: (nextGeneration) => {
        generation = nextGeneration;
        return generationStore.record(nextGeneration);
      },
    },
  );
  return new AgentDeckCompositionController(
    createLocalWorkerComposition({
      core,
      worker,
      afterCore: Object.freeze([
        generationComponent,
        ...(created.components ?? []),
      ]),
    }),
  );
}
