/** Provider-native project trust shown and submitted by new-session surfaces. */

export const PROJECT_TRUST_STATUSES = [
  'trusted',
  'untrusted',
  'unknown',
  'unsupported',
] as const;

export type ProjectTrustStatus = (typeof PROJECT_TRUST_STATUSES)[number];

export const PROJECT_TRUST_REASON_CODES = [
  'state-unreadable',
  'state-malformed',
  'state-unsafe',
  'provider-unavailable',
  'native-unsupported',
  'policy-disabled',
  'unsafe-project-root',
] as const;

export type ProjectTrustReasonCode = (typeof PROJECT_TRUST_REASON_CODES)[number];

export interface ProjectTrustDescriptor {
  status: ProjectTrustStatus;
  canGrant: boolean;
  /** Closed diagnostic code; paths and provider configuration never cross this boundary. */
  reasonCode: ProjectTrustReasonCode | null;
  /** Opaque state/identity fence, independent of ordinary session capability revisions. */
  revision: `sha256:${string}`;
}

export interface ProjectTrustRequest {
  revision: `sha256:${string}`;
  grant: boolean;
}

export type SessionCreationConfiguration = import('./session').SessionCreationDefaults & {
  projectTrust: ProjectTrustDescriptor;
};
