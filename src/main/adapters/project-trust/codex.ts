import { isAbsolute } from 'node:path';

import type { ProjectTrustProviderPort } from './core';
import { projectTrustDescriptor } from './core';
import {
  canonicalProjectDirectory,
  findProjectRoot,
  resolveMainGitCheckout,
} from './project-paths';

type JsonRecord = Record<string, unknown>;

export interface CodexProjectTrustClient {
  request<T = unknown>(method: string, params: unknown, signal?: AbortSignal): Promise<T>;
}

export interface CodexProjectTrustProviderOptions {
  withClient<T>(
    provider: string | undefined,
    operation: (client: CodexProjectTrustClient) => Promise<T>,
  ): Promise<T>;
  timeoutMs?: number;
}

interface ConfigLayerLike {
  readonly name?: { readonly type?: unknown; readonly profile?: unknown };
  readonly version?: unknown;
}

interface ConfigReadLike {
  readonly config?: unknown;
  readonly layers?: unknown;
}

function record(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeMarkers(config: JsonRecord): readonly string[] {
  const value = config.project_root_markers;
  if (!Array.isArray(value)) return ['.git'];
  const markers = value.filter((entry): entry is string =>
    typeof entry === 'string' && entry.length > 0 && entry.length <= 128 &&
    !entry.includes('\0') && !isAbsolute(entry) &&
    !entry.split(/[\\/]+/u).includes('..'));
  return markers.length > 0 ? markers : ['.git'];
}

function normalizedStoredPath(value: string): string {
  if (process.platform === 'win32') return value.toLowerCase();
  return value;
}

function matchingProject(
  projects: JsonRecord,
  candidate: string,
): { readonly key: string; readonly value: JsonRecord } | null {
  const exact = projects[candidate];
  if (record(exact)) return { key: candidate, value: exact };
  const normalized = normalizedStoredPath(candidate);
  const matches = Object.keys(projects).filter((key) =>
    normalizedStoredPath(key) === normalized && record(projects[key])).sort();
  const key = matches[0];
  return key ? { key, value: projects[key] as JsonRecord } : null;
}

function userVersion(layers: unknown): string | null {
  if (!Array.isArray(layers)) return null;
  const base = (layers as ConfigLayerLike[]).find((layer) =>
    layer.name?.type === 'user' && (layer.name.profile === null || layer.name.profile === undefined));
  return typeof base?.version === 'string' && base.version.length > 0 ? base.version : null;
}

async function withTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Codex project trust request timed out'));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createCodexProjectTrustProvider(
  options: CodexProjectTrustProviderOptions,
): ProjectTrustProviderPort {
  const timeoutMs = options.timeoutMs ?? 1_500;
  return Object.freeze({
    async observe(input) {
      let cwd: string;
      try { cwd = canonicalProjectDirectory(input.cwd); } catch {
        return {
          descriptor: projectTrustDescriptor({
            adapterId: 'codex-cli', canGrant: false,
            identity: `${input.cwd}\0${input.provider ?? ''}`,
            nativeVersion: 'unavailable', reasonCode: 'state-unreadable', status: 'unknown',
          }),
        };
      }
      try {
        const response = await options.withClient(input.provider, (client) =>
          withTimeout(timeoutMs, (signal) => client.request<ConfigReadLike>(
            'config/read', { includeLayers: true, cwd }, signal,
          )));
        if (!record(response.config)) throw new Error('invalid config');
        const config = response.config;
        const projects = config.projects === undefined
          ? {}
          : record(config.projects) ? config.projects : (() => { throw new Error('invalid projects'); })();
        const projectRoot = findProjectRoot(cwd, safeMarkers(config));
        const repoRoot = resolveMainGitCheckout(cwd);
        const candidates = [...new Set([cwd, projectRoot, ...(repoRoot ? [repoRoot] : [])])];
        let decision: { readonly key: string; readonly value: JsonRecord } | null = null;
        for (const candidate of candidates) {
          decision = matchingProject(projects, candidate);
          if (decision) break;
        }
        const trustLevel = decision?.value.trust_level;
        if (trustLevel !== undefined && trustLevel !== 'trusted' && trustLevel !== 'untrusted') {
          throw new Error('invalid trust level');
        }
        const trusted = trustLevel === 'trusted';
        const version = userVersion(response.layers);
        if (!version && !trusted) {
          return Object.freeze({
            descriptor: projectTrustDescriptor({
              adapterId: 'codex-cli', canGrant: false,
              identity: `${cwd}\0${input.provider ?? ''}`,
              nativeVersion: 'missing-user-version',
              reasonCode: 'provider-unavailable', status: 'unknown',
            }),
          });
        }
        const grantKey = repoRoot ?? projectRoot;
        return Object.freeze({
          descriptor: projectTrustDescriptor({
            adapterId: 'codex-cli', canGrant: !trusted,
            identity: `${cwd}\0${input.provider ?? ''}\0${grantKey}`,
            nativeVersion: `${version ?? 'trusted'}:${decision?.key ?? grantKey}:${trustLevel ?? 'unset'}`,
            reasonCode: null, status: trusted ? 'trusted' : 'untrusted',
          }),
          ...(!trusted ? {
            grant: async () => options.withClient(input.provider, (client) =>
              withTimeout(timeoutMs, (signal) => client.request(
                'config/value/write',
                {
                  keyPath: `projects.${JSON.stringify(grantKey)}.trust_level`,
                  value: 'trusted',
                  mergeStrategy: 'upsert',
                  expectedVersion: version,
                },
                signal,
              )).then(() => undefined)),
          } : {}),
        });
      } catch {
        return Object.freeze({
          descriptor: projectTrustDescriptor({
            adapterId: 'codex-cli', canGrant: false,
            identity: `${cwd}\0${input.provider ?? ''}`,
            nativeVersion: 'error', reasonCode: 'provider-unavailable', status: 'unknown',
          }),
        });
      }
    },
  });
}
