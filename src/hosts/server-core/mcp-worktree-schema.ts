import { z } from 'zod';

const relativePath = z.string().min(1).max(1_024);

export const SERVER_CORE_ENTER_WORKTREE_SCHEMA = {
  startPoint: z.string().min(1).max(1_024),
  worktreePath: relativePath.optional(),
  worktreeRoot: relativePath.optional(),
};

export const SERVER_CORE_EXIT_WORKTREE_SCHEMA = {
  worktreePath: relativePath.optional(),
  discardChanges: z.boolean().optional(),
};
