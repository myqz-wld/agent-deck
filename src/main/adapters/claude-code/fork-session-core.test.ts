import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createClaudeFamilyForkedSessionCore,
  encodeClaudeSdkProjectKey,
  type ClaudeFamilyForkHost,
} from './fork-session-core';

const SOURCE_APP_ID = 'source-application';
const SOURCE_NATIVE_ID = 'source-native';
const FORK_NATIVE_ID = 'fork-native';

describe('Claude native fork Core', () => {
  let root: string | null = null;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
  });

  it('uses only the injected host for SDK, config, child rows, and cleanup observation', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-deck-fork-core-'));
    const cwd = join(root, 'repo');
    const configRoot = join(root, 'claude');
    const transcriptPath = join(
      configRoot,
      'projects',
      encodeClaudeSdkProjectKey(cwd),
      `${SOURCE_NATIVE_ID}.jsonl`,
    );
    await mkdir(cwd, { recursive: true });
    await mkdir(dirname(transcriptPath), { recursive: true });
    await writeFile(transcriptPath, `${JSON.stringify({
      type: 'user',
      uuid: 'user-boundary',
      origin: { kind: 'human' },
      message: { role: 'user', content: [{ type: 'text', text: 'fork here' }] },
    })}\n`, 'utf8');

    const activeMessage: SessionMessage = {
      type: 'user',
      uuid: 'user-boundary',
      session_id: SOURCE_NATIVE_ID,
      message: { role: 'user', content: [] },
      parent_tool_use_id: null,
      parent_agent_id: null,
    };
    const sdk = {
      getSessionMessages: vi.fn(async () => [activeMessage]),
      forkSession: vi.fn(async () => ({ sessionId: FORK_NATIVE_ID })),
      deleteSession: vi.fn(async () => undefined),
    };
    const rows = new Map([[FORK_NATIVE_ID, { cliSessionId: FORK_NATIVE_ID }]]);
    const store = {
      get: vi.fn((id: string) => rows.get(id) ?? null),
      delete: vi.fn((id: string) => rows.delete(id)),
    };
    const observer = { recordIssue: vi.fn() };
    const host: ClaudeFamilyForkHost = {
      loadSdk: vi.fn(async () => sdk),
      readConfigRoot: vi.fn(() => configRoot),
      childSessionStore: store,
      cleanupObserver: observer,
    };
    const closeChild = vi.fn(async () => undefined);

    const handle = await createClaudeFamilyForkedSessionCore({
      source: {
        applicationSessionId: SOURCE_APP_ID,
        nativeSessionId: SOURCE_NATIVE_ID,
        cwd,
      },
      providerName: 'Claude',
      createChild: vi.fn(async () => FORK_NATIVE_ID),
      closeChild,
    }, host);

    expect(host.loadSdk).toHaveBeenCalledOnce();
    expect(host.readConfigRoot).toHaveBeenCalledOnce();
    expect(sdk.forkSession).toHaveBeenCalledWith(SOURCE_NATIVE_ID, {
      dir: cwd,
      upToMessageId: 'user-boundary',
      title: 'Agent Deck fork',
    });

    await handle.discard();

    expect(closeChild).toHaveBeenCalledWith(FORK_NATIVE_ID);
    expect(store.delete).toHaveBeenCalledWith(FORK_NATIVE_ID);
    expect(sdk.deleteSession).toHaveBeenCalledWith(FORK_NATIVE_ID, { dir: cwd });
    expect(observer.recordIssue).not.toHaveBeenCalled();
  });
});
