export class LinuxHostAdapterError extends Error {
  constructor(
    readonly code:
      | 'command_failed'
      | 'filesystem_failed'
      | 'identity_changed'
      | 'lock_failed'
      | 'output_invalid'
      | 'platform_unsupported'
      | 'trust_failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LinuxHostAdapterError';
  }
}
