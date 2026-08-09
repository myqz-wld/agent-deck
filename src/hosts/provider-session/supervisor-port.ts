import type { Duplex } from 'node:stream';

import type {
  ProviderSessionAttachSpec,
  ProviderSessionLaunchResult,
  ProviderSessionLaunchSpec,
  ProviderSessionStopResult,
  ProviderSessionStopSpec,
  ProviderSessionSupervisorCapabilities,
} from '@contracts/index';

/** The complete Core-facing port. It deliberately exposes no engine, mount, image, or host path. */
export interface ProviderSessionSupervisorPort {
  capabilities(): Promise<ProviderSessionSupervisorCapabilities>;
  launch(spec: ProviderSessionLaunchSpec): Promise<ProviderSessionLaunchResult>;
  stop(spec: ProviderSessionStopSpec): Promise<ProviderSessionStopResult>;
  close(): Promise<void>;
}

export interface ProviderSessionControlExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** One host-attached container stdio stream. It exposes no OCI control or host topology. */
export interface ProviderSessionControlChannel {
  readonly exited: Promise<ProviderSessionControlExit>;
  readonly stream: Duplex;
  close(): Promise<void>;
}

/** Private Core-to-host extension used only after an exact public launch result is adopted. */
export interface ProviderSessionSupervisorControlPort extends ProviderSessionSupervisorPort {
  attach(spec: ProviderSessionAttachSpec): Promise<ProviderSessionControlChannel>;
}

export type ProviderSessionSupervisorErrorCode =
  | 'closed'
  | 'conflict'
  | 'identity-changed'
  | 'limit'
  | 'not-found'
  | 'teardown-failed'
  | 'unavailable';

export class ProviderSessionSupervisorError extends Error {
  constructor(
    readonly code: ProviderSessionSupervisorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderSessionSupervisorError';
  }
}
