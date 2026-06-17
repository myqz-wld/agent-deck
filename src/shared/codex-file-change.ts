import { reconstructUnifiedDiffSnapshots } from './unified-diff';

export function isIncompleteCodexFileChangeStatus(status: unknown): boolean {
  return typeof status === 'string' && status.length > 0 && status !== 'completed';
}

export function isEffectiveCodexFileChange(
  changeKind: string | undefined,
  diff: string | undefined,
): boolean {
  const normalizedKind = (changeKind ?? '').toLowerCase();
  const trimmed = (diff ?? '').trim();
  if (!trimmed) return !isUpdateLikeCodexChange(normalizedKind);

  const reconstructed = reconstructUnifiedDiffSnapshots(trimmed);
  if (reconstructed) return reconstructed.before !== reconstructed.after;

  if (isUpdateLikeCodexChange(normalizedKind)) {
    return hasNonTextDiffSignal(trimmed);
  }
  return true;
}

function isUpdateLikeCodexChange(kind: string): boolean {
  return (
    kind === '' ||
    kind === 'update' ||
    kind === 'modify' ||
    kind === 'modified' ||
    kind === 'edit' ||
    kind === 'change'
  );
}

function hasNonTextDiffSignal(diff: string): boolean {
  return /^(Binary files |GIT binary patch|new file mode |deleted file mode |old mode |new mode |rename from |rename to |copy from |copy to |similarity index |dissimilarity index )/m.test(
    diff,
  );
}
