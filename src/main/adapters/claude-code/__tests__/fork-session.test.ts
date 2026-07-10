import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createClaudeFamilyForkedSession,
  encodeClaudeSdkProjectKey,
  parseCompleteClaudeJsonl,
  selectClaudeForkBoundary,
  type ClaudeTranscriptEntry,
} from '../fork-session';

const SOURCE_APP_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_NATIVE_ID = '22222222-2222-4222-8222-222222222222';
const FORK_NATIVE_ID = '33333333-3333-4333-8333-333333333333';

function activeMessage(type: 'user' | 'assistant', uuid: string): SessionMessage {
  return {
    type,
    uuid,
    session_id: SOURCE_NATIVE_ID,
    message: { role: type, content: [] },
    parent_tool_use_id: null,
    parent_agent_id: null,
  };
}

function rawUser(
  uuid: string,
  overrides: Record<string, unknown> = {},
): ClaudeTranscriptEntry {
  return {
    type: 'user',
    uuid,
    origin: { kind: 'human' },
    message: { role: 'user', content: [{ type: 'text', text: `prompt-${uuid}` }] },
    ...overrides,
  };
}

describe('Claude native fork boundary selection', () => {
  it('selects the latest real user before an active assistant tool-use frame', () => {
    const active = [activeMessage('user', 'u1'), activeMessage('assistant', 'a1')];
    const raw = [
      rawUser('u1'),
      {
        type: 'assistant',
        uuid: 'a1',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1' }] },
      },
    ];

    expect(selectClaudeForkBoundary(active, raw)).toBe('u1');
  });

  it.each([
    { kind: 'peer', from: 'lead-session' },
    { kind: 'channel', server: 'agent-deck' },
    { kind: 'coordinator' },
  ])('keeps the current top-level $kind request as the fork boundary', (origin) => {
    const active = [
      activeMessage('user', 'older-human'),
      activeMessage('user', `current-${origin.kind}`),
      activeMessage('assistant', 'active-assistant'),
    ];
    const raw = [
      rawUser('older-human'),
      rawUser(`current-${origin.kind}`, { origin }),
      {
        type: 'assistant',
        uuid: 'active-assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'spawn' }] },
      },
    ];

    expect(selectClaudeForkBoundary(active, raw)).toBe(`current-${origin.kind}`);
  });

  it('skips tool results, synthetic text, and task notifications', () => {
    const active = [
      activeMessage('user', 'u1'),
      activeMessage('assistant', 'a1'),
      activeMessage('user', 'tool-result'),
      activeMessage('user', 'synthetic'),
      activeMessage('user', 'task-notification'),
    ];
    const raw = [
      rawUser('u1'),
      { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [] } },
      rawUser('tool-result', {
        toolUseResult: { ok: true },
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }],
        },
      }),
      rawUser('synthetic', { isSynthetic: true }),
      rawUser('task-notification', { origin: { kind: 'task-notification' } }),
    ];

    expect(selectClaudeForkBoundary(active, raw)).toBe('u1');
  });

  it('rejects a chain with no safe querying top-level user', () => {
    const active = [activeMessage('user', 'hook'), activeMessage('user', 'tool-result')];
    const raw = [
      rawUser('hook', { shouldQuery: false }),
      rawUser('tool-result', {
        tool_use_result: {},
        message: { role: 'user', content: [{ type: 'tool_result' }] },
      }),
    ];

    expect(selectClaudeForkBoundary(active, raw)).toBeNull();
  });

  it('ignores a parseable but non-terminated trailing JSONL record', () => {
    const complete = JSON.stringify(rawUser('safe'));
    const trailing = JSON.stringify({
      type: 'assistant',
      uuid: 'active-assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1' }] },
    });
    const parsed = parseCompleteClaudeJsonl(`${complete}\n${trailing}`);

    expect(parsed.map((entry) => entry.uuid)).toEqual(['safe']);
    expect(
      selectClaudeForkBoundary(
        [activeMessage('user', 'safe'), activeMessage('assistant', 'active-assistant')],
        parsed,
      ),
    ).toBe('safe');
  });

  it('fails closed when a newer active user lacks complete raw provenance', () => {
    expect(
      selectClaudeForkBoundary(
        [activeMessage('user', 'older'), activeMessage('user', 'current-partial')],
        [rawUser('older')],
      ),
    ).toBeNull();
  });
});

describe('Claude native fork lifecycle', () => {
  let root: string;
  let cwd: string;
  let configRoot: string;
  let transcriptPath: string;
  let sourceTranscript: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-deck-claude-fork-'));
    cwd = join(root, 'repo');
    configRoot = join(root, 'claude-config');
    transcriptPath = join(
      configRoot,
      'projects',
      encodeClaudeSdkProjectKey(cwd),
      `${SOURCE_NATIVE_ID}.jsonl`,
    );
    await mkdir(cwd, { recursive: true });
    await mkdir(dirname(transcriptPath), { recursive: true });
    sourceTranscript = [
      JSON.stringify(rawUser('u1')),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'active-tool' }] },
      }),
    ].join('\n') + '\n';
    await writeFile(transcriptPath, sourceTranscript, 'utf8');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function makeSdk() {
    return {
      getSessionMessages: vi.fn(async () => [
        activeMessage('user', 'u1'),
        activeMessage('assistant', 'a1'),
      ]),
      forkSession: vi.fn(async () => ({ sessionId: FORK_NATIVE_ID })),
      deleteSession: vi.fn(async () => undefined),
    };
  }

  it('forks inclusively at the safe user and returns an idempotent child discard handle', async () => {
    const sdk = makeSdk();
    const closeChild = vi.fn(async () => undefined);
    const rows = new Map<string, { cliSessionId?: string | null }>([
      [SOURCE_APP_ID, { cliSessionId: SOURCE_NATIVE_ID }],
    ]);
    const childSessionStore = {
      get: vi.fn((id: string) => rows.get(id) ?? null),
      delete: vi.fn((id: string) => {
        rows.delete(id);
      }),
    };
    const deleteChild = vi.fn(async (id: string) => {
      rows.delete(id);
    });
    const createChild = vi.fn(async (nativeId: string) => {
      rows.set(nativeId, { cliSessionId: nativeId });
      return nativeId;
    });

    const handle = await createClaudeFamilyForkedSession({
      source: {
        applicationSessionId: SOURCE_APP_ID,
        nativeSessionId: SOURCE_NATIVE_ID,
        cwd,
      },
      providerName: 'Claude',
      createChild,
      closeChild,
      deleteChild,
      sdk,
      configRoot,
      childSessionStore,
    });

    expect(sdk.getSessionMessages).toHaveBeenCalledWith(SOURCE_NATIVE_ID, { dir: cwd });
    expect(sdk.forkSession).toHaveBeenCalledWith(SOURCE_NATIVE_ID, {
      dir: cwd,
      upToMessageId: 'u1',
      title: 'Agent Deck fork',
    });
    expect(createChild).toHaveBeenCalledWith(FORK_NATIVE_ID);
    expect(handle.sessionId).toBe(FORK_NATIVE_ID);
    expect(await readFile(transcriptPath, 'utf8')).toBe(sourceTranscript);

    await handle.discard();
    await handle.discard();

    expect(closeChild).toHaveBeenCalledTimes(1);
    expect(closeChild).toHaveBeenCalledWith(FORK_NATIVE_ID);
    expect(deleteChild).toHaveBeenCalledTimes(1);
    expect(deleteChild).toHaveBeenCalledWith(FORK_NATIVE_ID);
    expect(childSessionStore.delete).not.toHaveBeenCalled();
    expect(sdk.deleteSession).toHaveBeenCalledTimes(1);
    expect(sdk.deleteSession).toHaveBeenCalledWith(FORK_NATIVE_ID, { dir: cwd });
    expect(rows.get(SOURCE_APP_ID)).toEqual({ cliSessionId: SOURCE_NATIVE_ID });
    expect(await readFile(transcriptPath, 'utf8')).toBe(sourceTranscript);
  });

  it('accepts a complete current user when the active assistant JSONL tail is partial', async () => {
    const partialAssistant = JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'active-tool' }] },
    });
    await writeFile(
      transcriptPath,
      `${JSON.stringify(rawUser('u1'))}\n${partialAssistant}`,
      'utf8',
    );
    const sdk = makeSdk();

    const handle = await createClaudeFamilyForkedSession({
      source: { applicationSessionId: SOURCE_APP_ID, nativeSessionId: SOURCE_NATIVE_ID, cwd },
      providerName: 'Claude',
      createChild: vi.fn(async () => FORK_NATIVE_ID),
      closeChild: vi.fn(async () => undefined),
      sdk,
      configRoot,
      childSessionStore: { get: vi.fn(() => null), delete: vi.fn() },
    });

    expect(handle.sessionId).toBe(FORK_NATIVE_ID);
    expect(sdk.forkSession).toHaveBeenCalledWith(
      SOURCE_NATIVE_ID,
      expect.objectContaining({ upToMessageId: 'u1' }),
    );
  });

  it('cleans only the materialized child when bridge resume fails', async () => {
    const sdk = makeSdk();
    const closeChild = vi.fn(async () => undefined);
    const rows = new Map<string, { cliSessionId?: string | null }>([
      [SOURCE_APP_ID, { cliSessionId: SOURCE_NATIVE_ID }],
    ]);
    const childSessionStore = {
      get: vi.fn((id: string) => rows.get(id) ?? null),
      delete: vi.fn((id: string) => {
        rows.delete(id);
      }),
    };
    const failure = new Error('resume failed after native fork');

    await expect(
      createClaudeFamilyForkedSession({
        source: {
          applicationSessionId: SOURCE_APP_ID,
          nativeSessionId: SOURCE_NATIVE_ID,
          cwd,
        },
        providerName: 'Claude',
        createChild: async (nativeId) => {
          // Defensive fault injection: even a corrupt child row must not make cleanup delete a
          // source-owned historical/native identity.
          rows.set(nativeId, { cliSessionId: SOURCE_APP_ID });
          throw failure;
        },
        closeChild,
        sdk,
        configRoot,
        childSessionStore,
      }),
    ).rejects.toBe(failure);

    expect(closeChild).toHaveBeenCalledWith(FORK_NATIVE_ID);
    expect(childSessionStore.delete).toHaveBeenCalledWith(FORK_NATIVE_ID);
    expect(sdk.deleteSession).toHaveBeenCalledWith(FORK_NATIVE_ID, { dir: cwd });
    expect(sdk.deleteSession).toHaveBeenCalledTimes(1);
    expect(rows.has(FORK_NATIVE_ID)).toBe(false);
    expect(rows.get(SOURCE_APP_ID)).toEqual({ cliSessionId: SOURCE_NATIVE_ID });
    expect(await readFile(transcriptPath, 'utf8')).toBe(sourceTranscript);
  });

  it('does not mask the create failure when cleanup row inspection also fails', async () => {
    const sdk = makeSdk();
    const failure = new Error('original child create failure');
    const childSessionStore = {
      get: vi.fn(() => {
        throw new Error('cleanup inspection failure');
      }),
      delete: vi.fn(),
    };

    await expect(
      createClaudeFamilyForkedSession({
        source: {
          applicationSessionId: SOURCE_APP_ID,
          nativeSessionId: SOURCE_NATIVE_ID,
          cwd,
        },
        providerName: 'Claude',
        createChild: async () => {
          throw failure;
        },
        closeChild: vi.fn(async () => undefined),
        sdk,
        configRoot,
        childSessionStore,
      }),
    ).rejects.toBe(failure);

    expect(childSessionStore.delete).toHaveBeenCalledWith(FORK_NATIVE_ID);
    expect(sdk.deleteSession).toHaveBeenCalledWith(FORK_NATIVE_ID, { dir: cwd });
  });

  it('refuses a provider identity collision without deleting or closing the source', async () => {
    const sdk = makeSdk();
    sdk.forkSession.mockResolvedValueOnce({ sessionId: SOURCE_NATIVE_ID });
    const closeChild = vi.fn(async () => undefined);
    const childSessionStore = {
      get: vi.fn(() => ({ cliSessionId: SOURCE_NATIVE_ID })),
      delete: vi.fn(),
    };

    await expect(
      createClaudeFamilyForkedSession({
        source: {
          applicationSessionId: SOURCE_APP_ID,
          nativeSessionId: SOURCE_NATIVE_ID,
          cwd,
        },
        providerName: 'Claude',
        createChild: vi.fn(),
        closeChild,
        sdk,
        configRoot,
        childSessionStore,
      }),
    ).rejects.toThrow(/returned an invalid or source identity/);

    expect(closeChild).not.toHaveBeenCalled();
    expect(childSessionStore.delete).not.toHaveBeenCalled();
    expect(sdk.deleteSession).not.toHaveBeenCalled();
    expect(await readFile(transcriptPath, 'utf8')).toBe(sourceTranscript);
  });

  it('rejects ambiguous complete transcript copies instead of guessing a project bucket', async () => {
    await rm(transcriptPath, { force: true });
    for (const bucket of ['copy-a', 'copy-b']) {
      const path = join(configRoot, 'projects', bucket, `${SOURCE_NATIVE_ID}.jsonl`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, sourceTranscript, 'utf8');
    }
    const sdk = makeSdk();

    await expect(createClaudeFamilyForkedSession({
      source: { applicationSessionId: SOURCE_APP_ID, nativeSessionId: SOURCE_NATIVE_ID, cwd },
      providerName: 'Claude',
      createChild: vi.fn(),
      closeChild: vi.fn(async () => undefined),
      sdk,
      configRoot,
      childSessionStore: { get: vi.fn(() => null), delete: vi.fn() },
    })).rejects.toThrow(/multiple raw transcripts.*ambiguous.*contextMode "fresh"/);

    expect(sdk.forkSession).not.toHaveBeenCalled();
  });

  it('rejects a partial fallback transcript match instead of losing the current frame', async () => {
    await rm(transcriptPath, { force: true });
    const partialPath = join(
      configRoot,
      'projects',
      'partial-copy',
      `${SOURCE_NATIVE_ID}.jsonl`,
    );
    await mkdir(dirname(partialPath), { recursive: true });
    await writeFile(partialPath, `${JSON.stringify(rawUser('u1'))}\n`, 'utf8');
    const sdk = makeSdk();
    sdk.getSessionMessages.mockResolvedValueOnce([
      activeMessage('user', 'u1'),
      activeMessage('user', 'current-peer'),
      activeMessage('assistant', 'a1'),
    ]);

    await expect(createClaudeFamilyForkedSession({
      source: { applicationSessionId: SOURCE_APP_ID, nativeSessionId: SOURCE_NATIVE_ID, cwd },
      providerName: 'Claude',
      createChild: vi.fn(),
      closeChild: vi.fn(async () => undefined),
      sdk,
      configRoot,
      childSessionStore: { get: vi.fn(() => null), delete: vi.fn() },
    })).rejects.toThrow(/only partial raw-transcript matches.*contextMode "fresh"/);

    expect(sdk.forkSession).not.toHaveBeenCalled();
  });
});
