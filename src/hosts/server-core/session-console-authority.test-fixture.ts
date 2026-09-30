import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import {
  SESSION_CONSOLE_CREATE_OPTION_KEYS,
  issueRemoteOwnerGrantClaim,
  type AccessContext,
  type SessionConsoleCreateOptions,
  type SessionConsoleCreateParams,
} from '@contracts/index';
import type { SessionConsoleExecutionContext } from '@core/session-console';
import type { AgentAdapter } from '@main/adapters/types';
import { getAdapterRuntimeProfile } from '@main/adapters/runtime-profiles';
import type { SessionRecord } from '@shared/types';
import type { ServerCoreProject } from './project-catalog';
import { resolveServerCoreProviderSettings } from './provider-settings';
import { ServerCoreSessionCreateCapabilities } from './session-create-capabilities';
import { resolveServerCoreSessionCreateCatalog } from './session-create-catalog';
import {
  ServerCoreSessionConsoleAuthority,
  type ServerCoreSessionConsoleMetadataPort,
  type ServerCoreSessionConsoleRepositoryPort,
} from './session-console-authority';

export const roots: string[] = [];

export function record(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    agentId: 'claude-code',
    cwd: '/workspaces/private',
    title: `title ${id}`,
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 10,
    lastEventAt: 20,
    endedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

export function workspace(): { root: string; path: string } {
  const parent = mkdtempSync(join(tmpdir(), 'agent-deck-console-authority-'));
  roots.push(parent);
  const root = join(parent, 'workspaces');
  const path = join(root, 'alpha');
  mkdirSync(path, { recursive: true });
  return { root: realpathSync(root), path: realpathSync(path) };
}

export function context(
  access?: AccessContext,
  idempotencyKey = 'create-a',
): SessionConsoleExecutionContext {
  return {
    access: access ?? {
      kind: 'authenticated-client',
      topology: 'full',
      instanceId: 'instance-a',
      clientId: 'client-a',
      transport: 'ssh',
      connectionScope: 'credential-a',
      authority: 'owner-equivalent',
      surface: 'desktop',
      grant: issueRemoteOwnerGrantClaim('desktop'),
    },
    idempotencyKey,
    expectedRevision: null,
    deadlineAt: null,
    signal: new AbortController().signal,
  };
}

export function harness() {
  const paths = workspace();
  const live = [record('live-a'), record('live-b')];
  const history = [record('closed-a', { lifecycle: 'closed', endedAt: 20 })];
  const all = new Map([...live, ...history].map((value) => [value.id, value]));
  const repository: ServerCoreSessionConsoleRepositoryPort = {
    get: (id) => all.get(id) ?? null,
    listLive: (limit, offset) => live.slice(offset, offset + limit),
    listHistory: (limit, offset) => history.slice(offset, offset + limit),
    countLive: () => live.length,
    countHistory: () => history.length,
  };
  let revision = 3;
  let claim: ReturnType<ServerCoreSessionConsoleMetadataPort['claimMutation']> = {
    state: 'claimed',
  };
  const commitSessionCreate = vi.fn((_identity, sessionId: string) => ({
    sessionId,
    revision: ++revision,
  }));
  const releaseMutationClaim = vi.fn();
  const metadata: ServerCoreSessionConsoleMetadataPort = {
    currentRevision: () => revision,
    appendChange: vi.fn(() => ++revision),
    claimMutation: vi.fn(() => claim),
    completeMutation: vi.fn(),
    commitSessionCreate,
    releaseMutationClaim,
  };
  const createSession = vi.fn((_options?: unknown) => Promise.resolve('created-session'));
  const adapter = {
    id: 'claude-code',
    displayName: 'Claude',
    capabilities: getAdapterRuntimeProfile('claude-code').capabilities,
    init: vi.fn(() => Promise.resolve()),
    shutdown: vi.fn(() => Promise.resolve()),
    createSession,
  } as unknown as AgentAdapter;
  const project: ServerCoreProject = {
    projectId: 'project-alpha',
    projectRef: 'alpha',
    alias: 'alpha',
    title: 'Project Alpha',
    workspacePath: paths.path,
  };
  const registry = { get: (id: string) => id === 'claude-code' ? adapter : undefined };
  const settings = resolveServerCoreProviderSettings({});
  const providerHome = join(paths.root, '..', 'provider-home');
  mkdirSync(providerHome, { mode: 0o700 });
  const projectTrustApply = vi.fn(async () => ({
    status: 'trusted' as const,
    canGrant: false,
    reasonCode: null,
    revision: `sha256:${'c'.repeat(64)}` as const,
  }));
  const createCapabilities = new ServerCoreSessionCreateCapabilities({
    metadata,
    projects: [project],
    projectTrust: {
      describe: async () => ({
        status: 'trusted', canGrant: false, reasonCode: null,
        revision: `sha256:${'c'.repeat(64)}`,
      }),
      apply: projectTrustApply,
    },
    catalog: resolveServerCoreSessionCreateCatalog(realpathSync(providerHome), settings),
    registry,
    settings,
    workspaceRoot: paths.root,
  });
  const attachmentRef = {
    kind: 'uploaded' as const,
    path: join(paths.root, '..', 'private-attachments', 'image.png'),
    mime: 'image/png',
    bytes: 3,
  };
  const persistAttachments = vi.fn((inputs: readonly unknown[]) =>
    Promise.resolve(inputs.length > 0 ? [attachmentRef] : []));
  const removeAttachments = vi.fn(() => Promise.resolve());
  const rollbackCreatedSession = vi.fn(() => Promise.resolve());
  const authority = new ServerCoreSessionConsoleAuthority({
    projects: [project],
    workspaceRoot: paths.root,
    repository,
    registry,
    metadata,
    createCapabilities,
    attachmentStore: {
      persist: persistAttachments,
      remove: removeAttachments,
    },
    rollbackCreatedSession,
  });
  return {
    authority,
    commitSessionCreate,
    createSession,
    attachmentRef,
    persistAttachments,
    removeAttachments,
    releaseMutationClaim,
    rollbackCreatedSession,
    projectTrustApply,
    metadata,
    setClaim: (value: typeof claim) => { claim = value; },
    workspaceRoot: paths.root,
  };
}

export async function createParams(
  authority: ServerCoreSessionConsoleAuthority,
  workingDirectory = 'alpha',
  initialMessage = 'Inspect the repository',
): Promise<SessionConsoleCreateParams> {
  const capabilities = await authority.getCapabilities({
    adapterId: 'claude-code',
    provider: '',
    workingDirectory,
  }, context());
  const options = Object.fromEntries(SESSION_CONSOLE_CREATE_OPTION_KEYS.map((key) => [
    key,
    capabilities.create.options[key].defaultValue,
  ])) as unknown as SessionConsoleCreateOptions;
  return {
    adapterId: 'claude-code',
    attachments: [],
    capabilityRevision: capabilities.capabilityRevision,
    initialMessage,
    options,
    projectTrust: { revision: capabilities.projectTrust.revision, grant: false },
    workingDirectory,
  };
}
