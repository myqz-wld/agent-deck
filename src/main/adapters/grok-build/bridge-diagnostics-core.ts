export type GrokBridgeDiagnosticScope =
  | 'grok-provider-completion'
  | 'grok-runtime'
  | 'grok-transport-recovery'
  | 'grok-turn-watchdog';

export interface GrokBridgeDiagnosticLogger {
  debug(message: string, ...details: unknown[]): void;
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
}

export interface GrokBridgeDiagnostics {
  scope(name: GrokBridgeDiagnosticScope): GrokBridgeDiagnosticLogger;
}

const NOOP_LOGGER: GrokBridgeDiagnosticLogger = Object.freeze({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
});

export const NOOP_GROK_BRIDGE_DIAGNOSTICS: GrokBridgeDiagnostics = Object.freeze({
  scope: () => NOOP_LOGGER,
});
