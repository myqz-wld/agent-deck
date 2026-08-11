/** A preview must be regenerated before the same handoff can be committed safely. */
export class ServerCoreHandOffPreviewConflictError extends Error {
  constructor(message = 'The handoff preview no longer matches the source session') {
    super(message);
    this.name = 'ServerCoreHandOffPreviewConflictError';
  }
}
