import { resolve } from 'node:path';

import type { ProjectTrustProviderPort } from './core';
import { projectTrustDescriptor } from './core';
import { canonicalProjectDirectory } from './project-paths';
import {
  ProjectTrustStateError,
  readSecureOptionalText,
  withDirectoryLock,
  writeAtomicPrivateText,
} from './secure-state-file';

type JsonRecord = Record<string, unknown>;

export interface ClaudeProjectTrustProviderOptions {
  stateFile(input: { readonly cwd: string; readonly provider?: string }): string;
}

function record(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseState(text: string): JsonRecord {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (record(parsed)) return parsed;
  } catch {}
  throw new ProjectTrustStateError('state-malformed');
}

function readState(path: string): {
  readonly root: JsonRecord;
  readonly version: string;
} {
  const current = readSecureOptionalText(path);
  return current
    ? { root: parseState(current.text), version: current.version }
    : { root: {}, version: 'missing' };
}

function readProject(root: JsonRecord, cwd: string): {
  readonly project: JsonRecord;
  readonly projects: JsonRecord;
} {
  const rawProjects = root.projects;
  if (rawProjects !== undefined && !record(rawProjects)) {
    throw new ProjectTrustStateError('state-malformed');
  }
  const projects = rawProjects ?? {};
  const rawProject = projects[cwd];
  if (rawProject !== undefined && !record(rawProject)) {
    throw new ProjectTrustStateError('state-malformed');
  }
  const project = rawProject ?? {};
  if (
    project.hasTrustDialogAccepted !== undefined &&
    typeof project.hasTrustDialogAccepted !== 'boolean'
  ) throw new ProjectTrustStateError('state-malformed');
  return { project, projects };
}

export function createClaudeProjectTrustProvider(
  options: ClaudeProjectTrustProviderOptions,
): ProjectTrustProviderPort {
  return Object.freeze({
    async observe(input) {
      let cwd: string;
      let statePath: string;
      try {
        cwd = canonicalProjectDirectory(input.cwd);
        statePath = resolve(options.stateFile({ cwd, provider: input.provider }));
      } catch {
        return {
          descriptor: projectTrustDescriptor({
            adapterId: 'claude-code',
            canGrant: false,
            identity: `${input.cwd}\0${input.provider ?? ''}`,
            nativeVersion: 'unavailable',
            reasonCode: 'state-unreadable',
            status: 'unknown',
          }),
        };
      }

      try {
        const current = readState(statePath);
        const { project } = readProject(current.root, cwd);
        const trusted = project.hasTrustDialogAccepted === true;
        return Object.freeze({
          descriptor: projectTrustDescriptor({
            adapterId: 'claude-code',
            canGrant: !trusted,
            identity: `${statePath}\0${cwd}`,
            nativeVersion: `${current.version}:${trusted ? 'trusted' : 'untrusted'}`,
            reasonCode: null,
            status: trusted ? 'trusted' : 'untrusted',
          }),
          ...(!trusted ? {
            grant: async () => withDirectoryLock(`${statePath}.lock`, async () => {
              const latest = readState(statePath).root;
              const { project: latestProject, projects: latestProjects } =
                readProject(latest, cwd);
              writeAtomicPrivateText(statePath, `${JSON.stringify({
                ...latest,
                projects: {
                  ...latestProjects,
                  [cwd]: { ...latestProject, hasTrustDialogAccepted: true },
                },
              }, null, 2)}\n`);
            }),
          } : {}),
        });
      } catch (error) {
        const reasonCode = error instanceof ProjectTrustStateError
          ? error.reasonCode
          : 'state-unreadable';
        return Object.freeze({
          descriptor: projectTrustDescriptor({
            adapterId: 'claude-code',
            canGrant: false,
            identity: `${statePath}\0${cwd}`,
            nativeVersion: 'error',
            reasonCode,
            status: 'unknown',
          }),
        });
      }
    },
  });
}
