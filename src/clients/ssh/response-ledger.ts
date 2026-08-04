export type RememberedResponse = 'cancelled' | 'deadline' | 'settled';

/** A bounded insertion-ordered ledger for deterministic late/duplicate response handling. */
export class ResponseLedger {
  private readonly entries = new Map<string, RememberedResponse>();

  constructor(private readonly limit: number) {}

  get(requestId: string): RememberedResponse | undefined {
    return this.entries.get(requestId);
  }

  remember(requestId: string, response: RememberedResponse): void {
    this.entries.delete(requestId);
    this.entries.set(requestId, response);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}
