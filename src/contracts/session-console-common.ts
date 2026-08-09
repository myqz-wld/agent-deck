export const SESSION_CONSOLE_MAX_ALIAS_BYTES = 128;
export const SESSION_CONSOLE_MAX_WORKING_DIRECTORY_BYTES = 1_024;

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export class SessionConsoleContractError extends Error {
  constructor(readonly field: string) {
    super(`Invalid session-console contract field: ${field}`);
    this.name = 'SessionConsoleContractError';
  }
}

/** A host-private workspace reference: `.` or one normalized relative POSIX directory. */
export function parseWorkspaceDirectoryRef(
  value: unknown,
  field = 'workspaceDirectory',
): string {
  if (
    typeof value !== 'string' || value.length === 0 || value.trim() !== value ||
    new TextEncoder().encode(value).byteLength > SESSION_CONSOLE_MAX_WORKING_DIRECTORY_BYTES ||
    CONTROL.test(value) || value.includes('\\') || value.startsWith('/') ||
    (value !== '.' && value.split('/').some((segment) =>
      segment.length === 0 || segment === '.' || segment === '..'))
  ) {
    throw new SessionConsoleContractError(field);
  }
  return value;
}
