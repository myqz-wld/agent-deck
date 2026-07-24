import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';

const mocks = vi.hoisted(() => {
  const calls: string[] = [];
  const settings = {
    logLevel: 'info',
    hookServerPort: 47821,
    hookServerToken: '',
    mcpServerToken: '',
    enableAgentDeckMcp: false,
    mcpHttpEnabled: false,
    activeWindowMs: 1,
    closeAfterMs: 2,
    historyRetentionDays: 3,
    issueResolvedRetentionDays: 4,
    issueSoftDeletedRetentionDays: 5,
    messageRetentionDays: 6,
    startOnLogin: false,
    continuationCheckpointAutoRefreshEnabled: true,
    continuationCheckpointAutoRefreshIntervalMinutes: 30,
  } as AppSettings;
  const makeScheduler = (name: string) => class {
    start(): void { calls.push(`${name}.start`); }
  };
  return {
    calls,
    settings,
    initDb: vi.fn(() => calls.push('db.init')),
    getAll: vi.fn(() => {
      calls.push('settings.getAll');
      return settings;
    }),
    checkpointStart: vi.fn((received: AppSettings) => {
      expect(received).toBe(settings);
      calls.push('checkpoint.start');
    }),
    hookStart: vi.fn(async () => calls.push('hook.start')),
    makeScheduler,
  };
});

vi.mock('electron', () => ({
  app: { on: vi.fn(), exit: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('@electron-toolkit/utils', () => ({
  electronApp: { setAppUserModelId: vi.fn() },
  optimizer: { watchWindowShortcuts: vi.fn() },
  is: { dev: true },
}));
vi.mock('../../hook-server/server', () => ({
  HookServer: class {
    listeningPort = 47821;
    start = mocks.hookStart;
  },
}));
vi.mock('../../hook-server/route-registry', () => ({ RouteRegistry: class {} }));
vi.mock('../../store/db', () => ({
  initDb: mocks.initDb,
  closeDb: vi.fn(),
  isDbClosed: vi.fn(() => false),
}));
vi.mock('../../store/settings-store', () => ({
  settingsStore: { getAll: mocks.getAll },
}));
vi.mock('../../adapters/registry', () => ({
  adapterRegistry: {
    register: vi.fn(),
    initAll: vi.fn(async () => []),
    get: vi.fn(() => null),
  },
}));
vi.mock('../../adapters/claude-code', () => ({ claudeCodeAdapter: {} }));
vi.mock('../../adapters/claude-code/gateway-profiles', () => ({
  initializeBuiltInClaudeGatewayProfiles: vi.fn(),
}));
vi.mock('../../adapters/codex-cli', () => ({ codexCliAdapter: {} }));
vi.mock('../../adapters/claude-code/settings-env', () => ({ applyClaudeSettingsEnv: vi.fn() }));
vi.mock('../../session/manager', () => ({
  sessionManager: { ingest: vi.fn() },
  setSessionCloseFn: vi.fn(),
  setSessionRenameHookFn: vi.fn(),
}));
vi.mock('../../session/lifecycle-scheduler', () => ({
  LifecycleScheduler: mocks.makeScheduler('sessionScheduler'),
  setLifecycleScheduler: vi.fn(),
}));
vi.mock('../../teams/team-lifecycle-scheduler', () => ({
  TeamLifecycleScheduler: mocks.makeScheduler('teamScheduler'),
  setTeamLifecycleScheduler: vi.fn(),
}));
vi.mock('../../store/issue-lifecycle-scheduler', () => ({
  IssueLifecycleScheduler: mocks.makeScheduler('issueScheduler'),
  setIssueLifecycleScheduler: vi.fn(),
}));
vi.mock('../../store/message-lifecycle-scheduler', () => ({
  MessageLifecycleScheduler: mocks.makeScheduler('messageScheduler'),
  setMessageLifecycleScheduler: vi.fn(),
}));
vi.mock('../../store/token-usage-lifecycle-scheduler', () => ({
  TokenUsageLifecycleScheduler: mocks.makeScheduler('tokenScheduler'),
  setTokenUsageLifecycleScheduler: vi.fn(),
}));
vi.mock('../../store/storage-maintenance', () => ({
  StorageMaintenanceScheduler: mocks.makeScheduler('storageScheduler'),
}));
vi.mock('../../session/summarizer', () => ({
  summarizer: { start: vi.fn(() => mocks.calls.push('summarizer.start')) },
}));
vi.mock('../../session/continuation-context/checkpoint-refresh-service', () => ({
  startContinuationCheckpointRefreshService: mocks.checkpointStart,
}));
vi.mock('../../notify/event-router', () => ({ routeEventToNotification: vi.fn() }));
vi.mock('../../ipc', () => ({ bootstrapIpc: vi.fn() }));
vi.mock('../../ipc/provider-usage', () => ({ prefetchProviderUsageSnapshots: vi.fn() }));
vi.mock('../../bundled-assets', () => ({ loadBundledAssets: vi.fn() }));
vi.mock('../../store/image-uploads', () => ({ reapStaleUploads: vi.fn() }));
vi.mock('../../teams/universal-message-watcher', () => ({
  universalMessageWatcher: { start: vi.fn() },
}));
vi.mock('../../codex-config/agent-deck-mcp-injector', () => ({
  AGENT_DECK_MCP_TOKEN_ENV: 'AGENT_DECK_MCP_TOKEN',
}));
vi.mock('../../utils/user-shell-path', () => ({ unionUserShellPath: vi.fn((path) => path ?? '') }));
vi.mock('../../utils/main-event-loop-monitor', () => ({
  startMainEventLoopMonitor: vi.fn(() => vi.fn()),
}));
vi.mock('../../codex-config/agents-md-installer', () => ({ syncAgentDeckSection: vi.fn() }));
vi.mock('../../codex-config/skills-installer', () => ({ syncSkills: vi.fn() }));
vi.mock('../../login-item', () => ({ syncLoginItemSetting: vi.fn() }));
vi.mock('@main/utils/logger', () => ({
  default: { scope: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
  setFileLevel: vi.fn(),
}));

import { createInitialBootstrapState } from '../_deps';
import { initInfra } from '../bootstrap-infra';

describe('checkpoint refresh bootstrap entry', () => {
  beforeEach(() => {
    mocks.calls.length = 0;
    vi.clearAllMocks();
  });

  it('starts only after the database and settings snapshot are initialized', async () => {
    const result = await initInfra(createInitialBootstrapState());

    expect(result).toBe(mocks.settings);
    expect(mocks.calls.indexOf('db.init')).toBeGreaterThanOrEqual(0);
    expect(mocks.calls.indexOf('settings.getAll')).toBeGreaterThan(
      mocks.calls.indexOf('db.init'),
    );
    expect(mocks.calls.indexOf('checkpoint.start')).toBeGreaterThan(
      mocks.calls.indexOf('settings.getAll'),
    );
    expect(mocks.checkpointStart).toHaveBeenCalledOnce();
    expect(mocks.checkpointStart).toHaveBeenCalledWith(mocks.settings);
  });
});
