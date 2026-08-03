/** Main-process-only acceptance contract for the first trusted continuation provider turn. */
export type TrustedContinuationRejectionReason =
  | 'context-window-exceeded'
  | 'provider-error';

export type TrustedContinuationAcceptance =
  | { status: 'accepted'; boundary: 'model-activity' }
  | { status: 'rejected'; reason: TrustedContinuationRejectionReason };

export interface TrustedContinuationSessionCandidate {
  /** Stable Agent Deck session id that cleanup and cutover can address. */
  sessionId: string;
  /** Never rejects; ignored fast-path candidates cannot create unhandled rejections. */
  acceptance: Promise<TrustedContinuationAcceptance>;
}

/** Adapter-owned one-shot controller retained only by the initial trusted provider turn. */
export class TrustedContinuationAcceptanceController {
  readonly acceptance: Promise<TrustedContinuationAcceptance>;
  private resolveAcceptance!: (result: TrustedContinuationAcceptance) => void;
  private settled = false;

  constructor() {
    this.acceptance = new Promise((resolve) => {
      this.resolveAcceptance = resolve;
    });
  }

  acceptModelActivity(): void {
    this.settle({ status: 'accepted', boundary: 'model-activity' });
  }

  reject(reason: TrustedContinuationRejectionReason): void {
    this.settle({ status: 'rejected', reason });
  }

  private settle(result: TrustedContinuationAcceptance): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveAcceptance(result);
  }
}

export function trustedContinuationCandidate(
  sessionId: string,
  controller: TrustedContinuationAcceptanceController,
): TrustedContinuationSessionCandidate {
  return { sessionId, acceptance: controller.acceptance };
}
