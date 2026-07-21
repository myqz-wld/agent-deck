export interface SpawnSessionHandlerOptions {
  handOffMode?: boolean;
  batonRole?: 'lead' | 'teammate';
  /** Keep the durable spawn edge but suppress normal reply-anchor / lead-context injection. */
  suppressLeadContext?: boolean;
  /** Trusted internal child: keep its runtime row available but omit it from History. */
  hideFromHistory?: boolean;
  /** Trusted same-adapter access fields that are not part of the public MCP schema. */
  codexRuntimeAccess?: {
    networkAccessEnabled?: boolean;
    additionalDirectories?: readonly string[];
  };
}
