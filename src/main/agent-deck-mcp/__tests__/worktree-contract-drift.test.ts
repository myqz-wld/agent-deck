import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeSdkLoaderMock } from '@main/__tests__/_shared/mocks/sdk-loader';

vi.mock('@main/adapters/claude-code/sdk-loader', () =>
  makeSdkLoaderMock(),
);

import { buildAgentDeckTools } from '../tools';
import { structuredOk } from '../tools/helpers';
import {
  ENTER_WORKTREE_OUTPUT_SCHEMA,
  EXIT_WORKTREE_OUTPUT_SCHEMA,
} from '../tools/schemas';

const ENTER_ACCEPTANCE_SENTENCE =
  'A success with `state: "waiting-tool-result"` is durable asynchronous acceptance, not proof that the current turn already runs in the worktree.';
const EXIT_ACCEPTANCE_SENTENCE =
  'For a structured lease, success with `state: "waiting-tool-result"` accepts the reverse transition; it does not mean the worktree was already removed.';

describe('worktree MCP contract drift', () => {
  it('publishes automatic next-turn semantics and strict success schemas', async () => {
    const tools = await buildAgentDeckTools({
      callerSessionIdOverride: () => 'session-a',
      transport: 'in-process',
      adapterId: 'codex-cli',
    });
    const enter = tools.find((tool) => tool.name === 'enter_worktree');
    const exit = tools.find((tool) => tool.name === 'exit_worktree');
    expect(enter?.outputSchema).toBe(ENTER_WORKTREE_OUTPUT_SCHEMA);
    expect(exit?.outputSchema).toBe(EXIT_WORKTREE_OUTPUT_SCHEMA);
    expect(enter?.description).toContain(
      'Success state `waiting-tool-result` is asynchronous acceptance',
    );
    expect(enter?.description).toContain(
      'applies the worktree cwd to runtime and database',
    );
    expect(enter?.description).not.toContain(
      'does not change the SDK session cwd',
    );
    expect(exit?.description).toContain(
      'restores and confirms runtime/database cwd',
    );
    expect(exit?.description).toContain(
      'second dirty check immediately before removal',
    );
    expect(exit?.description).toContain('`completed-cleanup`');

    const enterPayload = {
      transitionId: 'session-a:2',
      direction: 'enter',
      state: 'waiting-tool-result',
      effectiveFrom: 'automatic-next-turn',
      worktreePath: '/repo/worktree',
      workBranch: 'agent-deck/task',
      baseBranch: 'main',
      baseCommit: 'a'.repeat(40),
      baseSource: 'base-branch',
      markerSet: true,
    } as const;
    const exitPayload = {
      transitionId: 'session-a:2',
      direction: 'exit',
      state: 'completed-cleanup',
      effectiveFrom: 'already-effective',
      worktreePath: '/repo/worktree',
      workBranch: 'agent-deck/task',
      branchDeleted: false,
      worktreeRemoved: true,
      markerCleared: true,
    } as const;
    expect(ENTER_WORKTREE_OUTPUT_SCHEMA.safeParse(enterPayload).success).toBe(
      true,
    );
    expect(EXIT_WORKTREE_OUTPUT_SCHEMA.safeParse(exitPayload).success).toBe(
      true,
    );
    const response = structuredOk(enterPayload);
    expect(response.structuredContent).toEqual(enterPayload);
    expect(JSON.parse(response.content[0]!.text)).toEqual(
      response.structuredContent,
    );
  });

  it('keeps Claude and Codex bundled instructions aligned without manual-cwd advice', () => {
    const root = process.cwd();
    const codex = readFileSync(
      resolve(root, 'resources/codex-config/CODEX_AGENTS.md'),
      'utf8',
    );
    const claude = readFileSync(
      resolve(root, 'resources/claude-config/CLAUDE.md'),
      'utf8',
    );
    for (const instructions of [codex, claude]) {
      expect(instructions).toContain(ENTER_ACCEPTANCE_SENTENCE);
      expect(instructions).toContain(EXIT_ACCEPTANCE_SENTENCE);
      expect(instructions).toContain(
        'one internal continuation before any user input buffered during the transition',
      );
      expect(instructions).toContain(
        'full worktree lease (including original cwd and marker)',
      );
      expect(instructions).not.toContain(
        'MCP does not change the Codex SDK cwd',
      );
      expect(instructions).not.toContain(
        'After entering the worktree, point read/write commands',
      );
    }
  });
});
