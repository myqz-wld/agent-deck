import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const calls: string[] = [];
  const logger = {
    error: vi.fn(() => calls.push('logger.error')),
  };
  return {
    calls,
    logger,
    primaryError: null as Error | null,
    loggerScope: vi.fn(() => logger),
    safeDiagnostic: vi.fn((value: unknown) => value),
    getProcessRunId: vi.fn(() => 'main-index-test-run'),
    requestSingleInstanceLock: vi.fn(() => true),
    whenReady: vi.fn(() => Promise.resolve()),
    quit: vi.fn(),
    exit: vi.fn((code: number) => calls.push(`exit:${code}`)),
    showErrorBox: vi.fn(() => calls.push('dialog')),
    closeDb: vi.fn(() => calls.push('closeDb')),
    createInitialBootstrapState: vi.fn(() => ({})),
    initInfra: vi.fn(),
    initWiring: vi.fn(),
    registerLifecycleHooks: vi.fn(),
  };
});

vi.mock('electron', () => ({
  app: {
    requestSingleInstanceLock: mocks.requestSingleInstanceLock,
    whenReady: mocks.whenReady,
    quit: mocks.quit,
    exit: mocks.exit,
  },
  dialog: {
    showErrorBox: mocks.showErrorBox,
  },
}));

vi.mock('@main/utils/logger', () => ({
  default: {
    scope: mocks.loggerScope,
  },
}));

vi.mock('@main/utils/safe-diagnostic', () => ({
  safeDiagnostic: mocks.safeDiagnostic,
}));

vi.mock('@main/utils/run-context', () => ({
  getProcessRunId: mocks.getProcessRunId,
}));

vi.mock('@main/store/db', () => ({
  closeDb: mocks.closeDb,
}));

vi.mock('@main/index/_deps', () => ({
  createInitialBootstrapState: mocks.createInitialBootstrapState,
}));

vi.mock('@main/index/bootstrap-infra', () => ({
  initInfra: mocks.initInfra,
}));

vi.mock('@main/index/bootstrap-wiring', () => ({
  initWiring: mocks.initWiring,
}));

vi.mock('@main/index/lifecycle-hooks', () => ({
  registerLifecycleHooks: mocks.registerLifecycleHooks,
}));

const bootstrapDiagnostic = {
  event: 'main-bootstrap',
  runId: 'main-index-test-run',
  phase: 'bootstrap',
  outcome: 'failed',
};

function dialogDiagnostic(phase: 'error-dialog' | 'database-close') {
  return {
    event: 'main-bootstrap',
    runId: 'main-index-test-run',
    phase,
    outcome: 'failed',
  };
}

function expectedDialogText(error: Error): string {
  return `应用初始化未完成,将退出。错误详情:\n\n${error.message}\n\n${error.stack ?? ''}`;
}

function terminalCalls(): string[] {
  return mocks.calls.filter((call) => (
    call === 'dialog' || call === 'closeDb' || call === 'exit:1'
  ));
}

async function runMainIndex(): Promise<void> {
  await import('@main/index');
  await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalledTimes(1));
}

type ProcessErrorListener = Parameters<typeof process.stdout.on>[1];

let stdoutErrorListeners: Set<ProcessErrorListener>;
let stderrErrorListeners: Set<ProcessErrorListener>;

describe('main index terminal bootstrap observability', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.calls.length = 0;

    const primaryError = new Error(
      'RAW_BOOTSTRAP_MARKER token=private-token /Users/private/repo https://private.test?q=1',
    );
    primaryError.name = 'RawBootstrapFailure';
    primaryError.stack = 'RAW_STACK_MARKER at /Users/private/repo/index.ts:9';
    mocks.primaryError = primaryError;

    mocks.loggerScope.mockReturnValue(mocks.logger);
    mocks.logger.error.mockImplementation(() => mocks.calls.push('logger.error'));
    mocks.safeDiagnostic.mockImplementation((value: unknown) => value);
    mocks.getProcessRunId.mockReturnValue('main-index-test-run');
    mocks.requestSingleInstanceLock.mockReturnValue(true);
    mocks.whenReady.mockResolvedValue(undefined);
    mocks.exit.mockImplementation((code: number) => mocks.calls.push(`exit:${code}`));
    mocks.showErrorBox.mockImplementation(() => mocks.calls.push('dialog'));
    mocks.closeDb.mockImplementation(() => mocks.calls.push('closeDb'));
    mocks.createInitialBootstrapState.mockReturnValue({});
    mocks.initInfra.mockRejectedValue(primaryError);

    stdoutErrorListeners = new Set(
      process.stdout.listeners('error') as ProcessErrorListener[],
    );
    stderrErrorListeners = new Set(
      process.stderr.listeners('error') as ProcessErrorListener[],
    );
  });

  afterEach(() => {
    for (const listener of process.stdout.listeners('error')) {
      const typedListener = listener as ProcessErrorListener;
      if (!stdoutErrorListeners.has(typedListener)) {
        process.stdout.off('error', typedListener);
      }
    }
    for (const listener of process.stderr.listeners('error')) {
      const typedListener = listener as ProcessErrorListener;
      if (!stderrErrorListeners.has(typedListener)) {
        process.stderr.off('error', typedListener);
      }
    }
  });

  it('emits a fixed bootstrap diagnostic while preserving dialog detail and terminal ordering', async () => {
    await runMainIndex();

    expect(mocks.logger.error).toHaveBeenCalledOnce();
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'main bootstrap failed',
      bootstrapDiagnostic,
    );
    expect(mocks.safeDiagnostic).toHaveBeenCalledWith(bootstrapDiagnostic);
    expect(JSON.stringify(mocks.logger.error.mock.calls)).not.toMatch(
      /RAW_|private-token|\/Users\/private|https:\/\//,
    );

    expect(mocks.showErrorBox).toHaveBeenCalledOnce();
    expect(mocks.showErrorBox).toHaveBeenCalledWith(
      'Agent Deck 启动失败',
      expectedDialogText(mocks.primaryError!),
    );
    expect(terminalCalls()).toEqual(['dialog', 'closeDb', 'exit:1']);
    expect(mocks.closeDb).toHaveBeenCalledOnce();
    expect(mocks.exit).toHaveBeenCalledOnce();
    expect(mocks.exit).toHaveBeenCalledWith(1);
  });

  it('contains logger scope failure and still completes the terminal sequence', async () => {
    mocks.loggerScope.mockImplementation(() => {
      throw new Error('RAW_LOGGER_SCOPE_MARKER');
    });

    await runMainIndex();

    expect(mocks.showErrorBox).toHaveBeenCalledWith(
      'Agent Deck 启动失败',
      expectedDialogText(mocks.primaryError!),
    );
    expect(terminalCalls()).toEqual(['dialog', 'closeDb', 'exit:1']);
  });

  it.each([
    ['logger sink', () => mocks.logger.error.mockImplementation(() => {
      throw new Error('RAW_LOGGER_SINK_MARKER');
    })],
    ['safe diagnostic', () => mocks.safeDiagnostic.mockImplementation(() => {
      throw new Error('RAW_SAFE_DIAGNOSTIC_MARKER');
    })],
    ['process run id', () => mocks.getProcessRunId.mockImplementation(() => {
      throw new Error('RAW_RUN_ID_MARKER');
    })],
  ])('contains %s failure without obscuring the primary error', async (_name, fail) => {
    fail();

    await runMainIndex();

    expect(mocks.showErrorBox).toHaveBeenCalledWith(
      'Agent Deck 启动失败',
      expectedDialogText(mocks.primaryError!),
    );
    expect(terminalCalls()).toEqual(['dialog', 'closeDb', 'exit:1']);
  });

  it('records a fixed dialog failure and continues through database close and exit', async () => {
    mocks.showErrorBox.mockImplementation(() => {
      mocks.calls.push('dialog');
      throw new Error('RAW_DIALOG_FAILURE_MARKER /Users/private/dialog');
    });

    await runMainIndex();

    expect(mocks.logger.error.mock.calls).toEqual([
      ['main bootstrap failed', bootstrapDiagnostic],
      ['main bootstrap failed', dialogDiagnostic('error-dialog')],
    ]);
    expect(JSON.stringify(mocks.logger.error.mock.calls)).not.toMatch(
      /RAW_|\/Users\/private/,
    );
    expect(terminalCalls()).toEqual(['dialog', 'closeDb', 'exit:1']);
  });

  it('records a fixed database-close failure and still exits with code one', async () => {
    mocks.closeDb.mockImplementation(() => {
      mocks.calls.push('closeDb');
      throw new Error('RAW_DATABASE_FAILURE_MARKER /Users/private/database');
    });

    await runMainIndex();

    expect(mocks.logger.error.mock.calls).toEqual([
      ['main bootstrap failed', bootstrapDiagnostic],
      ['main bootstrap failed', dialogDiagnostic('database-close')],
    ]);
    expect(JSON.stringify(mocks.logger.error.mock.calls)).not.toMatch(
      /RAW_|\/Users\/private/,
    );
    expect(terminalCalls()).toEqual(['dialog', 'closeDb', 'exit:1']);
    expect(mocks.exit).toHaveBeenCalledOnce();
    expect(mocks.exit).toHaveBeenCalledWith(1);
  });
});
