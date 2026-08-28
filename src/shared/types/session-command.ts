/** One slash command that the selected adapter can execute in the current session. */
export interface SessionCommandDescriptor {
  /** Canonical command name without the leading slash. */
  name: string;
  description: string;
  /** Provider-owned argument hint; empty means the command takes no advertised arguments. */
  argumentHint: string;
  /** Alternate names without the leading slash. */
  aliases: string[];
}
