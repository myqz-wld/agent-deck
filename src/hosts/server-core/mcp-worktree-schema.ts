import { z } from 'zod';

const relativePath = z.string().min(1).max(1_024);

export const SERVER_CORE_ENTER_WORKTREE_SCHEMA = {
  startPoint: z.string().min(1).max(1_024).describe('Required single Git commit-ish; resolved once and frozen before detached worktree creation. Null and invalid/multiple revisions reject before creation.'),
  worktreePath: relativePath.optional().describe('Optional Workspace-relative worktree path. Enter requires a new path; on exit it must match the caller lease. Omit to use the host default or active lease.'),
  worktreeRoot: relativePath.optional().describe('Optional Workspace-relative worktree root. Defaults under the main repository .agent-deck/worktrees. An explicit worktreePath must remain inside this root.'),
};

export const SERVER_CORE_EXIT_WORKTREE_SCHEMA = {
  worktreePath: relativePath.optional().describe('Optional Workspace-relative worktree path. Enter requires a new path; on exit it must match the caller lease. Omit to use the host default or active lease.'),
  discardChanges: z.boolean().optional().describe('Default false. True requires explicit user authorization to permanently delete dirty files; identity, references and durable HEAD checks still apply.'),
};
