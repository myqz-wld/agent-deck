import type { ProtocolVersion } from '@contracts/capabilities';

export const CURRENT_PROTOCOL_VERSION = Object.freeze({ major: 2, minor: 8 });

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

/** Requires one exact protocol contract; the unreleased project has no skew window. */
export function negotiateProtocolVersion(
  client: ProtocolVersion,
  host: ProtocolVersion = CURRENT_PROTOCOL_VERSION,
): ProtocolVersion {
  assertVersion(client, 'Client');
  assertVersion(host, 'Host');
  if (client.major !== host.major || client.minor !== host.minor) {
    throw new ProtocolCompatibilityError(
      `Protocol version mismatch: client=${client.major}.${client.minor}, ` +
      `host=${host.major}.${host.minor}`,
    );
  }
  return { major: host.major, minor: host.minor };
}
