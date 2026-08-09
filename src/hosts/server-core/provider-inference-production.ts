import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';

import { ServerCoreProviderInferenceBroker } from './provider-inference-broker';
import { ServerCoreGrokCredentialFile } from './provider-inference-credential';
import { ServerCoreProviderHttpUpstream } from './provider-inference-http-upstream';
import { ServerCoreProviderInferenceUnixHttp } from './provider-inference-unix-http';

export interface ProductionServerCoreProviderInferenceOptions {
  readonly brokerRoot: string;
  readonly credentialAllowedUids?: readonly number[];
  readonly credentialRoot: string;
  readonly currentUid?: () => number;
  readonly fetch?: typeof fetch;
  readonly nextEndpointId?: () => string;
  readonly workspaceRoot: string;
}

const GROK_CREDENTIAL_FILE = 'grok-auth.json';
const GROK_CHAT_UPSTREAM_ORIGIN = 'https://cli-chat-proxy.grok.com';
const GROK_CHAT_UPSTREAM_PATH = '/v1/chat/completions';
const GROK_RESPONSES_UPSTREAM_ORIGIN = 'https://api.x.ai';
const GROK_RESPONSES_UPSTREAM_PATH = '/v1/responses';
const GROK_UPSTREAM_ID = 'grok-xai';

function canonicalDirectory(path: string, field: string): string {
  if (!isAbsolute(path) || normalize(path) !== path || path === '/' || path.includes('\0') ||
      realpathSync(path) !== path) {
    throw new Error(`${field} is invalid`);
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) {
    throw new Error(`${field} is not trusted`);
  }
  return path;
}

function within(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === '' || (
    relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)
  );
}

function disjoint(left: string, right: string): void {
  if (within(left, right) || within(right, left)) {
    throw new Error('provider inference credential and model-visible roots must be disjoint');
  }
}

/** Concrete Core-owned Grok inference runtime with a fixed upstream and private credential root. */
export function createProductionServerCoreProviderInference(
  options: ProductionServerCoreProviderInferenceOptions,
): ServerCoreProviderInferenceUnixHttp {
  const workspaceRoot = canonicalDirectory(options.workspaceRoot, 'Provider Workspace');
  const brokerRoot = canonicalDirectory(options.brokerRoot, 'provider broker root');
  const credentialRoot = canonicalDirectory(
    options.credentialRoot,
    'provider credential root',
  );
  disjoint(workspaceRoot, brokerRoot);
  disjoint(workspaceRoot, credentialRoot);
  disjoint(brokerRoot, credentialRoot);
  const credentials = new ServerCoreGrokCredentialFile({
    allowedUids: options.credentialAllowedUids,
    path: join(credentialRoot, GROK_CREDENTIAL_FILE),
  });
  const upstream = new ServerCoreProviderHttpUpstream({
    credentials,
    fetch: options.fetch,
    routes: [
      {
        adapterId: 'grok-build',
        origin: GROK_CHAT_UPSTREAM_ORIGIN,
        paths: [GROK_CHAT_UPSTREAM_PATH],
        providerId: 'xai',
        upstreamId: GROK_UPSTREAM_ID,
      },
      {
        adapterId: 'grok-build',
        origin: GROK_RESPONSES_UPSTREAM_ORIGIN,
        paths: [GROK_RESPONSES_UPSTREAM_PATH],
        providerId: 'xai',
        upstreamId: GROK_UPSTREAM_ID,
      },
    ],
  });
  const broker = new ServerCoreProviderInferenceBroker({
    nextEndpointId: options.nextEndpointId,
    upstream,
  });
  return new ServerCoreProviderInferenceUnixHttp({
    broker,
    brokerRoot,
    currentUid: options.currentUid,
  });
}
