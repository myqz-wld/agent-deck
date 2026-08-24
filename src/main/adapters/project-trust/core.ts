import { createHash } from 'node:crypto';

import type {
  ProjectTrustDescriptor,
  ProjectTrustReasonCode,
  ProjectTrustRequest,
  ProjectTrustStatus,
  SessionAdapterId,
} from '@shared/types';

export interface ProjectTrustInput {
  readonly adapterId: SessionAdapterId;
  readonly cwd: string;
  readonly provider?: string;
}

export interface ProjectTrustObservation {
  readonly descriptor: ProjectTrustDescriptor;
  grant?(): Promise<void>;
}

export interface ProjectTrustProviderPort {
  observe(input: ProjectTrustInput): Promise<ProjectTrustObservation>;
}

export class ProjectTrustConflictError extends Error {
  constructor() {
    super('项目 trust 状态已变化，请刷新会话配置后重试。');
    this.name = 'ProjectTrustConflictError';
  }
}

export class ProjectTrustGrantError extends Error {
  constructor(message = '无法保存并验证项目 trust；会话尚未创建。') {
    super(message);
    this.name = 'ProjectTrustGrantError';
  }
}

export function projectTrustDescriptor(input: {
  readonly adapterId: SessionAdapterId;
  readonly canGrant: boolean;
  readonly identity: string;
  readonly nativeVersion: string;
  readonly reasonCode: ProjectTrustReasonCode | null;
  readonly status: ProjectTrustStatus;
}): ProjectTrustDescriptor {
  const digest = createHash('sha256').update([
    'agent-deck-project-trust-v1',
    input.adapterId,
    input.identity,
    input.nativeVersion,
    input.status,
    input.canGrant ? 'grantable' : 'read-only',
    input.reasonCode ?? '',
  ].join('\0')).digest('hex');
  return Object.freeze({
    status: input.status,
    canGrant: input.canGrant,
    reasonCode: input.reasonCode,
    revision: `sha256:${digest}`,
  });
}

function unavailableObservation(
  input: ProjectTrustInput,
  reasonCode: ProjectTrustReasonCode,
): ProjectTrustObservation {
  return Object.freeze({
    descriptor: projectTrustDescriptor({
      adapterId: input.adapterId,
      canGrant: false,
      identity: `${input.cwd}\0${input.provider ?? ''}`,
      nativeVersion: 'unavailable',
      reasonCode,
      status: 'unknown',
    }),
  });
}

/** Deterministic orchestration around provider-owned project trust stores. */
export class ProjectTrustService {
  constructor(
    private readonly providers: Readonly<Record<SessionAdapterId, ProjectTrustProviderPort>>,
  ) {}

  async describe(input: ProjectTrustInput): Promise<ProjectTrustDescriptor> {
    return (await this.observe(input)).descriptor;
  }

  async apply(
    input: ProjectTrustInput,
    request: ProjectTrustRequest | null,
  ): Promise<ProjectTrustDescriptor> {
    const current = await this.observe(input);
    if (request === null) return current.descriptor;

    if (!request.grant) {
      if (
        request.revision === current.descriptor.revision ||
        current.descriptor.status === 'trusted'
      ) return current.descriptor;
      throw new ProjectTrustConflictError();
    }

    if (current.descriptor.status === 'trusted') return current.descriptor;
    if (
      request.revision !== current.descriptor.revision ||
      !current.descriptor.canGrant ||
      current.grant === undefined
    ) throw new ProjectTrustConflictError();

    try {
      await current.grant();
    } catch (error) {
      throw new ProjectTrustGrantError(
        error instanceof ProjectTrustGrantError ? error.message : undefined,
      );
    }
    const verified = await this.observe(input);
    if (verified.descriptor.status !== 'trusted') throw new ProjectTrustGrantError();
    return verified.descriptor;
  }

  async isTrusted(input: ProjectTrustInput): Promise<boolean> {
    return (await this.observe(input)).descriptor.status === 'trusted';
  }

  private async observe(input: ProjectTrustInput): Promise<ProjectTrustObservation> {
    try {
      return await this.providers[input.adapterId].observe(input);
    } catch {
      return unavailableObservation(input, 'provider-unavailable');
    }
  }
}
