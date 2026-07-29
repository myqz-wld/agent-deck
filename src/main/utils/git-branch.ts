import { execFileSync } from 'node:child_process';
import { normalizeIssueBranchName } from '@shared/types';

export function detectGitBranchName(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  try {
    const out = execFileSync('git', ['-C', cwd, 'branch', '--show-current'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    });
    const branch = out.trim();
    return normalizeIssueBranchName(branch);
  } catch {
    return null;
  }
}
