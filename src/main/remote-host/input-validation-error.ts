export class RemoteHostInputError extends Error {
  constructor(field: string, reason: string) {
    super(`invalid remote host input: ${field} (${reason})`);
    this.name = 'RemoteHostInputError';
  }
}
