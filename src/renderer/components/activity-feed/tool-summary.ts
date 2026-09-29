/** Display-only unwrapping. Raw shell arguments remain available in the input disclosure. */
export function unwrapShellCommand(command: string): string {
  const normalized = command.trim();
  const match = /^(?:(?:\/usr)?\/bin\/)?(?:bash|zsh|sh)\s+(?:-[il]+\s+)*-[il]*c[il]*\s+(['"])([\s\S]*)\1$/.exec(normalized);
  return match ? match[2] : normalized;
}
