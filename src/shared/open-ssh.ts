/**
 * Escapes one OpenSSH configuration value passed through `ssh -o key=value`.
 *
 * OpenSSH parses the value again after argv processing. Literal quotes in a single argv entry do
 * not protect spaces at that second boundary, so paths must carry OpenSSH backslash escapes.
 */
export function escapeOpenSshConfigValue(value: string): string {
  return value.replace(/[\\\s"']/g, (character) => `\\${character}`);
}
