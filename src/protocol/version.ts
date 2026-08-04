import type { ProtocolVersion } from '@contracts/capabilities';

export const CURRENT_PROTOCOL_VERSION = Object.freeze({ major: 1, minor: 0 });
export const MINIMUM_COMPATIBLE_PROTOCOL_MINOR = 0;

export class ProtocolCompatibilityError extends Error {
  readonly code = 'incompatible_protocol' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ProtocolCompatibilityError';
  }
}

function assertVersion(version: ProtocolVersion, label: string): void {
  if (
    !Number.isSafeInteger(version.major) ||
    version.major < 0 ||
    !Number.isSafeInteger(version.minor) ||
    version.minor < 0
  ) {
    throw new ProtocolCompatibilityError(`${label} protocol version is invalid`);
  }
}

/** Selects the newest mutually understood additive-minor protocol version. */
export function negotiateProtocolVersion(
  client: ProtocolVersion,
  host: ProtocolVersion = CURRENT_PROTOCOL_VERSION,
  minimumHostMinor = MINIMUM_COMPATIBLE_PROTOCOL_MINOR,
): ProtocolVersion {
  assertVersion(client, 'Client');
  assertVersion(host, 'Host');
  if (client.major !== host.major) {
    throw new ProtocolCompatibilityError(
      `Protocol major mismatch: client=${client.major}, host=${host.major}`,
    );
  }

  const minor = Math.min(client.minor, host.minor);
  if (minor < minimumHostMinor) {
    throw new ProtocolCompatibilityError(
      `Protocol minor ${minor} is older than the host minimum ${minimumHostMinor}`,
    );
  }
  return { major: host.major, minor };
}
