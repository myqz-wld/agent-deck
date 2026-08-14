import { AgentDeckCompositionController } from '@composition/controller';
import type { LifecycleComponent } from '@composition/runtime';
import {
  createRelayServerComposition,
  relayControlSocketComponent,
} from '@composition/topologies';
import { UnixSocketDaemonListener } from '@hosts/daemon/unix-socket-listener';
import { readPrivateJsonFile } from '@hosts/linux-runtime/config-file';
import {
  loadTrustedRuntimeModule,
  requireModuleFactory,
} from '@hosts/linux-runtime/runtime-module';
import { requireAbsolutePath } from '@hosts/linux-runtime/validation';
import { basename, dirname, join } from 'node:path';

import { RelayControlHost } from './control-host';
import { RelayControlSocketService } from './control-socket-service';
import { RelayCredentialAuthorityService } from './credential-authority-service';
import { parseRelayCredentialAuthority } from './credential-authority';
import type { RelayHeadlessConfig } from './headless-config';
import { RelayMetadataFileService } from './metadata-file';
import { RelayStreamRouter } from './router';

export interface RelayServicePaths {
  readonly stateDirectory: string;
  readonly controlSocket: string;
}

export interface RelayPlumbingFactoryInput {
  readonly instanceId: string;
  readonly metadata: RelayMetadataFileService['metadata'];
  readonly router: RelayStreamRouter;
}

export interface RelayRootOptions {
  readonly loadModule?: typeof loadTrustedRuntimeModule;
  readonly plumbingComponents?: readonly LifecycleComponent[];
}

function ticker(host: RelayControlHost, delayMs: number): LifecycleComponent {
  let timer: NodeJS.Timeout | null = null;
  return {
    name: 'relay-worker-lease-ticker',
    async start() {
      if (timer) throw new Error('Relay ticker is already started');
      timer = setInterval(() => host.tick(), delayMs);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

async function plumbing(
  config: RelayHeadlessConfig,
  input: RelayPlumbingFactoryInput,
  options: RelayRootOptions,
): Promise<readonly LifecycleComponent[]> {
  if (options.plumbingComponents) return options.plumbingComponents;
  if (config.plumbingModule === null) return [];
  const module = await (options.loadModule ?? loadTrustedRuntimeModule)(config.plumbingModule);
  const factory = requireModuleFactory<RelayPlumbingFactoryInput>(module, 'createRelayPlumbing');
  const result = await factory(input);
  if (!Array.isArray(result)) throw new Error('Relay plumbing factory must return components');
  return result as readonly LifecycleComponent[];
}

export async function createRelayController(
  config: RelayHeadlessConfig,
  paths: RelayServicePaths,
  options: RelayRootOptions = {},
): Promise<AgentDeckCompositionController> {
  requireAbsolutePath(paths.stateDirectory, 'stateDirectory');
  requireAbsolutePath(paths.controlSocket, 'controlSocket');
  if (
    basename(paths.stateDirectory) !== config.instanceId ||
    basename(dirname(paths.controlSocket)) !== config.instanceId ||
    basename(paths.controlSocket) !== 'control.sock'
  ) {
    throw new Error('Relay paths do not match the exact instance namespace');
  }
  const authority = parseRelayCredentialAuthority(
    await readPrivateJsonFile(config.authorityFile),
    config.instanceId,
  );
  const metadata = await RelayMetadataFileService.open({
    stateFile: join(paths.stateDirectory, 'metadata.json'),
    instanceId: config.instanceId,
    credentials: authority.credentials,
  });
  const router = new RelayStreamRouter(config.instanceId, metadata.metadata);
  const credentials = new RelayCredentialAuthorityService({
    instanceId: config.instanceId,
    authorityFile: config.authorityFile,
    metadata: metadata.metadata,
  });
  const host = new RelayControlHost({ router });
  const control = new RelayControlSocketService(
    host,
    new UnixSocketDaemonListener(paths.controlSocket, dirname(paths.controlSocket)),
  );
  const extra = await plumbing(config, {
    instanceId: config.instanceId,
    metadata: metadata.metadata,
    router,
  }, options);
  return new AgentDeckCompositionController(
    createRelayServerComposition({
      components: Object.freeze([
        {
          name: 'relay-metadata-file',
          start: () => metadata.start(),
          stop: () => metadata.stop(),
        },
        {
          name: 'relay-credential-authority',
          start: () => credentials.start(),
          stop: () => credentials.stop(),
        },
        ...extra,
        ticker(host, config.tickIntervalMs),
        relayControlSocketComponent(control),
      ]),
    }),
  );
}
