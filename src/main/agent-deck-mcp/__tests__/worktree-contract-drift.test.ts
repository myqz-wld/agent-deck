import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { makeSdkLoaderMock } from '@main/__tests__/_shared/mocks/sdk-loader';

vi.mock('@main/adapters/claude-code/sdk-loader', () =>
  makeSdkLoaderMock(),
);

import { buildAgentDeckTools } from '../tools';
import { structuredOk } from '../tools/helpers';
import {
  EXIT_WORKTREE_SCHEMA,
  ENTER_WORKTREE_SCHEMA,
  ENTER_WORKTREE_OUTPUT_SCHEMA,
  EXIT_WORKTREE_OUTPUT_SCHEMA,
} from '../tools/schemas';

const ENTER_ACCEPTANCE_SENTENCE =
  'A success with `state: "waiting-tool-result"` is durable asynchronous acceptance, not proof that the current turn already runs in the worktree.';
const EXIT_ACCEPTANCE_SENTENCE =
  'For a structured lease or an existing legacy marker/path, success with `state: "waiting-tool-result"` accepts the reverse transition; it does not mean the worktree was already removed.';

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
    expect(enter?.description).toContain(
      'creates the directory with `git worktree add --detach`',
    );
    expect(enter?.description).toContain(
      'never creates, switches, renames, or deletes a branch or other ref',
    );
    expect(enter?.description).toContain('30-second');
    expect(enter?.description).toContain('10-minute timeout');
    expect(enter?.description).toContain(
      'may remain as an empty directory after a later failure',
    );
    expect(enter?.description).not.toContain('baseBranch');
    expect(enter?.description).not.toContain('workBranch');
    expect('baseBranch' in ENTER_WORKTREE_SCHEMA).toBe(false);
    expect('workBranch' in ENTER_WORKTREE_SCHEMA).toBe(false);
    expect(ENTER_WORKTREE_SCHEMA.startPoint.description).toContain(
      'resolves it once in the caller repository',
    );
    const enterInputSchema = z.object(ENTER_WORKTREE_SCHEMA).strict();
    expect(enterInputSchema.safeParse({ startPoint: 'HEAD' }).success).toBe(
      true,
    );
    expect(
      enterInputSchema.safeParse({
        baseBranch: 'main',
        workBranch: 'agent-deck/task',
      }).success,
    ).toBe(false);
    expect(enter?.description).not.toContain(
      'does not change the SDK session cwd',
    );
    expect(exit?.description).toContain(
      'restores and confirms runtime/database cwd',
    );
    expect(exit?.description).toContain(
      'second dirty check immediately before removal',
    );
    expect(exit?.description).toContain(
      'never creates, renames, switches, or deletes Git branches or other refs',
    );
    expect(exit?.description).toContain(
      'branch renames and branch switches do not block exit',
    );
    expect(exit?.description).toContain(
      'rejects an unreferenced HEAD commit',
    );
    expect(exit?.description).toContain(
      'adopted into the same structured restore-first flow',
    );
    expect(exit?.description).toContain(
      '`completed-legacy` is synchronous only when the target path is already absent',
    );
    expect(exit?.description).toContain('`completed-cleanup`');
    expect(exit?.description).not.toContain('deleteBranch');
    expect('deleteBranch' in EXIT_WORKTREE_SCHEMA).toBe(false);
    expect(EXIT_WORKTREE_SCHEMA.discardChanges.description).toContain(
      'does not bypass lease/path/repository/reference checks or the durable-HEAD check',
    );

    const enterPayload = {
      transitionId: 'session-a:2',
      direction: 'enter',
      state: 'waiting-tool-result',
      effectiveFrom: 'automatic-next-turn',
      worktreePath: '/repo/worktree',
      startCommit: 'a'.repeat(40),
      headMode: 'detached',
      markerSet: true,
    } as const;
    const exitPayload = {
      transitionId: 'session-a:2',
      direction: 'exit',
      state: 'completed-cleanup',
      effectiveFrom: 'already-effective',
      worktreePath: '/repo/worktree',
      worktreeRemoved: true,
      markerCleared: true,
    } as const;
    expect(ENTER_WORKTREE_OUTPUT_SCHEMA.safeParse(enterPayload).success).toBe(
      true,
    );
    expect(
      ENTER_WORKTREE_OUTPUT_SCHEMA.safeParse({
        ...enterPayload,
        workBranch: 'agent-deck/task',
        baseBranch: 'main',
        baseSource: 'base-branch',
      }).success,
    ).toBe(false);
    expect(EXIT_WORKTREE_OUTPUT_SCHEMA.safeParse(exitPayload).success).toBe(
      true,
    );
    expect(
      EXIT_WORKTREE_OUTPUT_SCHEMA.safeParse({
        ...exitPayload,
        workBranch: 'agent-deck/task',
        branchDeleted: false,
      }).success,
    ).toBe(false);
    expect(
      EXIT_WORKTREE_OUTPUT_SCHEMA.safeParse({
        transitionId: 'session-a:3',
        direction: 'exit',
        state: 'waiting-tool-result',
        effectiveFrom: 'automatic-next-turn',
        worktreePath: '/repo/detached-worktree',
      }).success,
    ).toBe(true);
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
    const grok = readFileSync(
      resolve(root, 'resources/grok-config/GROK_AGENTS.md'),
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
      expect(instructions).not.toContain('deleteBranch');
      expect(instructions).not.toContain('baseBranch');
      expect(instructions).not.toContain('workBranch');
      expect(instructions).toContain(
        'Agent Deck resolves it once to `startCommit` and creates the worktree with detached HEAD',
      );
      expect(instructions).toContain(
        'neither worktree MCP tool mutates refs',
      );
    }
    expect(grok).toContain(
      '`exit_worktree` adopts an existing legacy marker/path into the same restore-first flow',
    );
    expect(grok).toContain(
      '`completed-legacy` means the target was already absent',
    );
    expect(grok).not.toContain('deleteBranch');
    expect(grok).not.toContain('baseBranch');
    expect(grok).not.toContain('workBranch');
    expect(grok).toContain('creates only a detached worktree');
    expect(grok).not.toContain(
      'entering a worktree does not change the current process directory',
    );
  });
});
